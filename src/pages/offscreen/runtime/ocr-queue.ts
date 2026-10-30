import { legacyBrowserEnabled } from "@src/services/extension-policy";
import type { ItemDocType } from "@src/schemas/item_schema";
import { getDb } from "@src/services/DatabaseService";
import { databaseManager } from "@src/services/db-manager";
import {
  OCR_MODEL_VERSION,
  OCR_SUPPORTED,
  ocrService,
} from "@src/services/ocr.service";
import { vectorPipelineCoordinator } from "@src/services/vector-pipeline-coordinator";
import { sendProcessStatus } from "./process-status";

const OCR_BATCH_SIZE = 1;
const OCR_RETRY_DELAY_MS = 6 * 60 * 60 * 1_000;

type QueuedOcrItem = { itemId: string; force: boolean };

type OcrQueueDependencies = {
  isEmbeddingRunning: () => boolean;
  scheduleEmbedding: () => void;
};

/** Serializes heavyweight image OCR and yields to vector maintenance. */
export class OcrQueue {
  private running = false;
  private rerunRequested = false;
  private backlogCheckTimer: number | null = null;
  private waitReported = false;
  private readonly queuedItems = new Map<string, boolean>();
  private readonly activeItemIds = new Set<string>();

  constructor(private readonly dependencies: OcrQueueDependencies) {}

  enqueue(itemId: string, force = false): void {
    if (!itemId) return;
    this.queuedItems.set(
      itemId,
      force || this.queuedItems.get(itemId) === true,
    );
  }

  trigger(): void {
    if (!OCR_SUPPORTED) return;
    void legacyBrowserEnabled().then(enabled => {
      if (!enabled) return;
      if (this.running) {
        this.rerunRequested = true;
        return;
      }
      window.setTimeout(() => void this.process(), 500);
    });
  }

  scheduleIfNeeded(): void {
    if (!OCR_SUPPORTED) return;
    void legacyBrowserEnabled().then(enabled => {
      if (!enabled || this.backlogCheckTimer !== null) return;
      this.backlogCheckTimer = window.setTimeout(() => {
        this.backlogCheckTimer = null;
        void this.triggerWhenBacklogExists();
      }, 1_000);
    });
  }

  private async process(): Promise<void> {
    if (!await legacyBrowserEnabled()) return;
    if (this.running) {
      this.rerunRequested = true;
      return;
    }
    if (this.mustWaitForVectors()) {
      this.rerunRequested = true;
      window.setTimeout(() => void this.process(), 5_000);
      return;
    }

    this.running = true;
    this.rerunRequested = false;
    sendProcessStatus({
      id: "ocr-queue",
      label: "Image OCR",
      state: "processing",
      detail: "Reading text from images...",
    });

    let processed = 0;
    let errored = 0;
    let skipped = 0;
    let processError: string | null = null;

    try {
      while (true) {
        const queued = this.takeQueuedItems(OCR_BATCH_SIZE);
        const items =
          queued.length > 0
            ? queued
            : await this.findBacklogItems(OCR_BATCH_SIZE);
        if (items.length === 0) break;

        for (const item of items) {
          try {
            const status = await this.processQueuedItem(item);
            if (status === "done") processed += 1;
            else if (status === "skipped" || status === "processing") {
              skipped += 1;
            } else {
              errored += 1;
            }
          } catch (error) {
            const message =
              error instanceof Error ? error.message : "OCR failed for an item";
            if (message === "OCR_ITEM_NOT_FOUND") {
              skipped += 1;
              continue;
            }
            errored += 1;
            processError = message;
          }
        }

        sendProcessStatus({
          id: "ocr-queue",
          label: "Image OCR",
          state: "processing",
          detail: `OCR processed ${processed} images${skipped ? `, skipped ${skipped}` : ""}${errored ? `, ${errored} errors` : ""}.`,
        });
      }

      if (this.queuedItems.size > 0) this.rerunRequested = true;
      this.reportCompletion({ processed, processError });
    } catch (error) {
      const detail =
        error instanceof Error ? error.message : "OCR queue failed.";
      console.error("[Offscreen] OCR queue failed:", error);
      sendProcessStatus({
        id: "ocr-queue",
        label: "Image OCR",
        state: "error",
        detail,
        retryAction: "TRIGGER_OCR",
      });
    } finally {
      this.running = false;
      if (this.rerunRequested) {
        window.setTimeout(() => void this.process(), 500);
      } else if (this.queuedItems.size === 0 && this.activeItemIds.size === 0) {
        ocrService.scheduleIdleRelease();
      }
      this.dependencies.scheduleEmbedding();
    }
  }

  private async processQueuedItem(
    queued: QueuedOcrItem | ItemDocType,
  ): Promise<ItemDocType["ocrStatus"]> {
    if ("itemId" in queued) {
      return this.processItemById(queued.itemId, queued.force);
    }
    return this.processItem(queued);
  }

  private async processItemById(
    itemId: string,
    force: boolean,
  ): Promise<ItemDocType["ocrStatus"]> {
    const db = await getDb();
    const document = await db.items.findOne(itemId).exec();
    if (!document) throw new Error("OCR_ITEM_NOT_FOUND");
    return this.processItem(document.toMutableJSON(), force);
  }

  private async processItem(
    item: ItemDocType,
    force = false,
  ): Promise<ItemDocType["ocrStatus"]> {
    if (this.activeItemIds.has(item.id)) return "processing";

    const sourceHash = ocrService.getSourceHash(item);
    if (
      !force &&
      item.ocrStatus === "done" &&
      item.ocrModelVersion === OCR_MODEL_VERSION &&
      item.ocrSourceHash === sourceHash
    ) {
      return "done";
    }

    this.activeItemIds.add(item.id);
    try {
      await databaseManager.markItemOcrProcessing({
        id: item.id,
        modelVersion: OCR_MODEL_VERSION,
        sourceHash,
      });
      const result = await ocrService.processItem(item);
      await databaseManager.saveItemOcrResult({
        id: item.id,
        status: result.status,
        modelVersion: OCR_MODEL_VERSION,
        sourceHash: result.sourceHash,
        text: result.text,
        confidence: result.confidence,
        lineCount: result.lineCount,
        error: result.error,
        media: result.media,
      });
      return result.status;
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "OCR failed for an item";
      await databaseManager.saveItemOcrResult({
        id: item.id,
        status: "error",
        modelVersion: OCR_MODEL_VERSION,
        sourceHash,
        text: item.ocrText ?? "",
        confidence: item.ocrConfidence,
        lineCount: item.ocrLineCount ?? 0,
        error: message,
      });
      throw error;
    } finally {
      this.activeItemIds.delete(item.id);
    }
  }

  private takeQueuedItems(limit: number): QueuedOcrItem[] {
    const items: QueuedOcrItem[] = [];
    for (const [itemId, force] of this.queuedItems) {
      this.queuedItems.delete(itemId);
      items.push({ itemId, force });
      if (items.length >= limit) break;
    }
    return items;
  }

  private async findBacklogItems(limit: number): Promise<ItemDocType[]> {
    return databaseManager.getItemsToOcr({
      limit,
      modelVersion: OCR_MODEL_VERSION,
      retryErroredBefore: Date.now() - OCR_RETRY_DELAY_MS,
    });
  }

  private mustWaitForVectors(): boolean {
    if (
      this.dependencies.isEmbeddingRunning() ||
      vectorPipelineCoordinator.getActiveOperation() !== null
    ) {
      if (!this.waitReported) {
        sendProcessStatus({
          id: "ocr-queue",
          label: "Image OCR",
          state: "processing",
          detail: "Waiting for embedding/vector work to finish...",
        });
        this.waitReported = true;
      }
      return true;
    }
    this.waitReported = false;
    return false;
  }

  private reportCompletion(result: {
    processed: number;
    processError: string | null;
  }): void {
    if (result.processError && result.processed === 0) {
      sendProcessStatus({
        id: "ocr-queue",
        label: "Image OCR",
        state: "error",
        detail: result.processError,
        retryAction: "TRIGGER_OCR",
      });
      return;
    }
    sendProcessStatus({
      id: "ocr-queue",
      label: "Image OCR",
      state: "success",
      detail:
        result.processed > 0
          ? `OCR complete for ${result.processed} image records.`
          : "Image OCR is idle.",
    });
  }

  private async triggerWhenBacklogExists(): Promise<void> {
    if (!await legacyBrowserEnabled()) return;
    try {
      const items = await this.findBacklogItems(1);
      if (items.length > 0) this.trigger();
    } catch (error) {
      console.error("[Offscreen] Failed to check OCR backlog:", error);
    }
  }
}
