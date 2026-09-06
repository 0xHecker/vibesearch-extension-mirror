import {
  composeEmbeddingTexts,
  EMBEDDING_TEXT_VERSION,
} from "@src/search-core/embedding-text";
import type { ItemDocType } from "@src/schemas/item_schema";
import { databaseManager } from "@src/services/db-manager";
import type { BulkItemUpdate } from "@src/services/database/item-writes";
import { vectorPipelineCoordinator } from "@src/services/vector-pipeline-coordinator";
import { vectorStoreService } from "@src/services/vector-store.service";
import { z } from "zod";
import { sendProcessStatus, sendStatusUpdate } from "./process-status";

const EMBEDDING_BATCH_SIZE = 20;
const MAX_SENTENCES_PER_WORKER_REQUEST = 16;
const EMBEDDING_TEXT_VERSION_KEY = "vibe.search.embeddingTextVersion";
const EMBEDDING_STATE_REPAIR_KEY = "vibe.search.embeddingStateRepairVersion";
const EMBEDDING_STATE_REPAIR_VERSION = "v2-vector-bounds";
const storedStringSchema = z.string();

type EmbeddingBatchItem = Pick<
  ItemDocType,
  | "id"
  | "title"
  | "textContent"
  | "ocrText"
  | "url"
  | "source"
  | "authorUsername"
  | "media"
  | "updatedAt"
> & { expectedRevision: string };

function embeddingCommit(
  item: EmbeddingBatchItem,
  vectorIndexes: number[],
): BulkItemUpdate {
  return {
    id: item.id,
    expectedRevision: item.expectedRevision,
    expectedUpdatedAt: item.updatedAt,
    vector_index: vectorIndexes[0] ?? -1,
    vector_indexes: vectorIndexes,
    isEmbedded: true,
    isDirty: false,
  };
}

/** Owns embedding schema repair, batching, and back-pressure state. */
export class EmbeddingQueue {
  private running = false;
  private rerunRequested = false;
  private backlogCheckTimer: number | null = null;
  private waitReported = false;

  constructor(private readonly scheduleOcr: () => void) {}

  isRunning(): boolean {
    return this.running;
  }

  async prepare(): Promise<void> {
    await this.ensureTextVersion();
    await this.ensureVectorReferences();
  }

  trigger(): void {
    if (this.running) {
      this.rerunRequested = true;
      return;
    }
    window.setTimeout(() => void this.process(), 200);
  }

  scheduleIfNeeded(): void {
    if (this.backlogCheckTimer !== null) return;

    this.backlogCheckTimer = window.setTimeout(() => {
      this.backlogCheckTimer = null;
      void this.triggerWhenBacklogExists();
    }, 250);
  }

  async process(): Promise<void> {
    if (this.running) {
      this.rerunRequested = true;
      return;
    }

    this.running = true;
    this.rerunRequested = false;
    sendProcessStatus({
      id: "embedding-queue",
      label: "Embedding queue",
      state: "processing",
      detail: "Embedding queued records...",
    });

    let processError: string | null = null;
    try {
      processError = await this.processNewItems();
      if (!processError) processError = await this.processDirtyItems();

      sendProcessStatus(
        processError
          ? {
              id: "embedding-queue",
              label: "Embedding queue",
              state: "error",
              detail: processError,
              retryAction: "TRIGGER_EMBEDDING",
            }
          : {
              id: "embedding-queue",
              label: "Embedding queue",
              state: "success",
              detail: "Embedding queue is idle.",
            },
      );
    } catch (error) {
      const detail =
        error instanceof Error ? error.message : "Embedding queue failed.";
      console.error("[Offscreen] Embedding queue failed:", error);
      sendProcessStatus({
        id: "embedding-queue",
        label: "Embedding queue",
        state: "error",
        detail,
        retryAction: "TRIGGER_EMBEDDING",
      });
    } finally {
      this.running = false;
      if (this.rerunRequested) {
        window.setTimeout(() => void this.process(), 100);
      }
      this.scheduleOcr();
    }
  }

  private async processNewItems(): Promise<string | null> {
    let itemCount = 0;
    let vectorCount = 0;

    while (true) {
      const batch = await databaseManager.getItemsToEmbed({
        limit: EMBEDDING_BATCH_SIZE,
      });
      if (batch.length === 0) break;

      console.log(`[Offscreen] Embedding ${batch.length} new items...`);
      try {
        vectorCount += await this.runBatch(batch);
        itemCount += batch.length;
        sendStatusUpdate(`Embedded ${itemCount} new items...`);
        sendProcessStatus({
          id: "embedding-queue",
          label: "Embedding queue",
          state: "processing",
          detail: `Embedded ${itemCount} records (${vectorCount} vectors)...`,
        });
      } catch (error) {
        console.error("[Offscreen] Error embedding new items batch:", error);
        return error instanceof Error
          ? error.message
          : "Embedding failed for a batch";
      }
    }

    if (itemCount > 0) {
      console.log(`[Offscreen] Finished embedding ${itemCount} new items`);
    }
    return null;
  }

  private async processDirtyItems(): Promise<string | null> {
    let itemCount = 0;
    while (true) {
      const batch = await databaseManager.getDirtyItems({
        limit: EMBEDDING_BATCH_SIZE,
      });
      if (batch.length === 0) return null;

      try {
        await this.runBatch(batch);
        itemCount += batch.length;
        sendProcessStatus({
          id: "embedding-queue",
          label: "Embedding queue",
          state: "processing",
          detail: `Re-embedded ${itemCount} records...`,
        });
      } catch (error) {
        console.error(
          "[Offscreen] Error re-embedding dirty items batch:",
          error,
        );
        return error instanceof Error
          ? error.message
          : "Re-embedding failed for a batch";
      }
    }
  }

  private async runBatch(batch: EmbeddingBatchItem[]): Promise<number> {
    this.reportCompactionWait();

    return vectorPipelineCoordinator.runExclusive("embedding", async () => {
      const entries = batch.flatMap((item) =>
        composeEmbeddingTexts(item).map((value) => ({
          itemId: item.id,
          value,
        })),
      );
      const indexesByItemId = new Map<string, number[]>();
      let appendedTotal = 0;

      for (
        let start = 0;
        start < entries.length;
        start += MAX_SENTENCES_PER_WORKER_REQUEST
      ) {
        const slice = entries.slice(
          start,
          start + MAX_SENTENCES_PER_WORKER_REQUEST,
        );
        const result = await vectorStoreService.generateAndStoreEmbeddings({
          sentences: slice.map((entry) => entry.value),
          priority: "background",
        });
        if (result.appendedCount !== slice.length) {
          throw new Error(
            `Embedding append mismatch: expected ${slice.length}, got ${result.appendedCount}`,
          );
        }

        slice.forEach((entry, index) => {
          const itemIndexes = indexesByItemId.get(entry.itemId) ?? [];
          itemIndexes.push(result.startIndex + index);
          indexesByItemId.set(entry.itemId, itemIndexes);
        });
        appendedTotal += result.appendedCount;
      }

      await databaseManager.bulkUpdateItems(
        batch.map((item) =>
          embeddingCommit(item, indexesByItemId.get(item.id) ?? []),
        ),
      );
      return appendedTotal;
    });
  }

  private reportCompactionWait(): void {
    if (vectorPipelineCoordinator.getActiveOperation() === "compaction") {
      if (!this.waitReported) {
        sendProcessStatus({
          id: "embedding-queue",
          label: "Embedding queue",
          state: "processing",
          detail: "Waiting for vector maintenance to finish...",
        });
        this.waitReported = true;
      }
      return;
    }
    this.waitReported = false;
  }

  private async triggerWhenBacklogExists(): Promise<void> {
    try {
      const [newItems, dirtyItems] = await Promise.all([
        databaseManager.getItemsToEmbed({ limit: 1 }),
        databaseManager.getDirtyItems({ limit: 1 }),
      ]);
      if (newItems.length > 0 || dirtyItems.length > 0) this.trigger();
    } catch (error) {
      console.error("[Offscreen] Failed to check embedding backlog:", error);
    }
  }

  private async ensureTextVersion(): Promise<void> {
    try {
      const currentVersion = await this.readStoredString(
        EMBEDDING_TEXT_VERSION_KEY,
      );
      if (currentVersion === EMBEDDING_TEXT_VERSION) return;

      sendProcessStatus({
        id: "embedding-schema",
        label: "Embedding schema",
        state: "processing",
        detail: `Updating embedding schema ${currentVersion || "none"} -> ${EMBEDDING_TEXT_VERSION}...`,
      });
      const updatedCount =
        await databaseManager.markAllActiveItemsForReembedding();
      await this.writeStoredString(
        EMBEDDING_TEXT_VERSION_KEY,
        EMBEDDING_TEXT_VERSION,
      );
      sendProcessStatus({
        id: "embedding-schema",
        label: "Embedding schema",
        state: "success",
        detail:
          updatedCount > 0
            ? `Re-embedding scheduled for ${updatedCount} items.`
            : "Embedding schema is up to date.",
      });
    } catch (error) {
      console.error("[Offscreen] Failed embedding schema update:", error);
      sendProcessStatus({
        id: "embedding-schema",
        label: "Embedding schema",
        state: "error",
        detail:
          error instanceof Error
            ? error.message
            : "Failed to update embedding schema.",
        retryAction: "TRIGGER_EMBEDDING",
      });
    }
  }

  private async ensureVectorReferences(): Promise<void> {
    try {
      const currentVersion = await this.readStoredString(
        EMBEDDING_STATE_REPAIR_KEY,
      );
      const vectorCount = await vectorStoreService.getVectorCount();
      const markerPrefix = `${EMBEDDING_STATE_REPAIR_VERSION}:`;
      const previousVectorCount = currentVersion.startsWith(markerPrefix)
        ? Number(currentVersion.slice(markerPrefix.length))
        : Number.NaN;
      if (
        vectorCount > 0 &&
        Number.isSafeInteger(previousVectorCount) &&
        vectorCount >= previousVectorCount
      ) {
        return;
      }

      sendProcessStatus({
        id: "embedding-state",
        label: "Embedding state",
        state: "processing",
        detail: "Repairing records that are missing vectors...",
      });
      const repairedCount =
        await databaseManager.repairItemsMissingVectors(vectorCount);
      await this.writeStoredString(
        EMBEDDING_STATE_REPAIR_KEY,
        `${markerPrefix}${vectorCount}`,
      );
      sendProcessStatus({
        id: "embedding-state",
        label: "Embedding state",
        state: "success",
        detail:
          repairedCount > 0
            ? `Queued ${repairedCount} records that were missing vectors.`
            : "Embedding state is valid.",
      });
    } catch (error) {
      console.error("[Offscreen] Failed embedding state repair:", error);
      sendProcessStatus({
        id: "embedding-state",
        label: "Embedding state",
        state: "error",
        detail:
          error instanceof Error
            ? error.message
            : "Failed to repair embedding state.",
        retryAction: "TRIGGER_EMBEDDING",
      });
    }
  }

  private async readStoredString(key: string): Promise<string> {
    const values = await chrome.storage.local.get(key);
    const value = storedStringSchema.safeParse(values[key]);
    return value.success ? value.data : "";
  }

  private async writeStoredString(key: string, value: string): Promise<void> {
    await chrome.storage.local.set({ [key]: value });
  }
}
