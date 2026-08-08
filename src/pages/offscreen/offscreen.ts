import { OffscreenRouter } from "@src/services/router";
import { vectorStoreService } from "@src/services/vector-store.service";
import { databaseManager } from "@src/services/db-manager";
import { getDb } from "@src/services/DatabaseService";
import { syncService } from "@src/services/sync.service";
import { itemsController } from "@src/services/controllers/items.controller";
import { foldersController } from "@src/services/controllers/folders.controller";
import { tagsController } from "@src/services/controllers/tags.controller";
import { spacesController } from "@src/services/controllers/spaces.controller";
import { spaceGroupsController } from "@src/services/controllers/space-groups.controller";
import { binController } from "@src/services/controllers/bin.controller";
import { vectorPipelineCoordinator } from "@src/services/vector-pipeline-coordinator";
import { queryRankerService } from "@src/services/query-ranker.service";
import { browserBookmarkImportService } from "@src/services/browser-bookmark-import";
import { githubStarsImportService } from "@src/services/github-stars-import";
import { cloudSyncService } from "@src/services/cloud-sync";
import { cloudAuthService } from "@src/services/cloud-auth";
import {
  ocrService,
  OCR_MODEL_VERSION,
  OCR_SUPPORTED,
} from "@src/services/ocr.service";
import {
  isEmbeddingStateOnlyItemChange,
  isFolderCollapseOnlyChange,
  isMetadataEnrichmentItemChange,
  isSpaceGroupCollapseOnlyChange,
} from "@src/services/item-change-classification";
import type { ItemDocType } from "@src/schemas/item_schema";
import { composeEmbeddingTexts, EMBEDDING_TEXT_VERSION } from "@src/search-core/embedding-text";

const sendStatusUpdate = (message: string) => {
  try {
    chrome.runtime.sendMessage({ type: "STATUS_UPDATE", payload: message });
  } catch {}
};

const sendProcessStatus = (payload: {
  id: string;
  label: string;
  state: "processing" | "success" | "error";
  detail: string;
  retryAction?: "RETRY_QUERY" | "TRIGGER_EMBEDDING" | "TRIGGER_OCR" | "REBUILD_INDEX" | "REBUILD_VECTORS";
}) => {
  try {
    chrome.runtime.sendMessage({
      type: "PROCESS_STATUS",
      payload: {
        ...payload,
        updatedAt: Date.now(),
      },
    });
  } catch {}
};

type DbChangeScope = "items" | "folders" | "tags" | "spaces" | "space_groups";
type ItemChangeKind = "content" | "metadata";

const DB_CHANGE_FLUSH_MS = 160;
let dbChangeFlushTimer: number | null = null;
const pendingDbScopes = new Set<DbChangeScope>();
const pendingItemIds = new Set<string>();
let pendingItemChangeKind: ItemChangeKind | null = null;
let dbChangeSuppressionDepth = 0;
const deferredDbScopes = new Set<DbChangeScope>();

const flushDbChanges = () => {
  dbChangeFlushTimer = null;
  const scopes = Array.from(pendingDbScopes);
  pendingDbScopes.clear();

  const changedItemIds = Array.from(pendingItemIds).slice(0, 4000);
  pendingItemIds.clear();
  const itemChangeKind = pendingItemChangeKind || "content";
  pendingItemChangeKind = null;

  for (const scope of scopes) {
    try {
      chrome.runtime.sendMessage({
        type: "DB_CHANGE",
        scope,
        changedItemIds: scope === "items" ? changedItemIds : undefined,
        itemChangeKind: scope === "items" ? itemChangeKind : undefined,
        isCoalesced: true,
      });
    } catch {}
  }
};

const isTrustedForwarderSender = (sender: chrome.runtime.MessageSender): boolean => {
  if (!sender || sender.id !== chrome.runtime.id) {
    return false;
  }
  if (sender.tab) {
    return false;
  }
  const senderUrl = typeof sender.url === "string" ? sender.url : "";
  if (!senderUrl) return true;

  try {
    const path = new URL(senderUrl).pathname || "";
    if (path.includes("/src/pages/")) return false;
    if (path.endsWith(".html") && !path.endsWith("/_generated_background_page.html")) {
      return false;
    }
    return true;
  } catch {
    return false;
  }
};

const scheduleDbChange = (
  scope: DbChangeScope,
  changedItemIds?: string[],
  itemChangeKind: ItemChangeKind = "content"
) => {
  // Bulk import writes can emit a collection event for every database batch.
  // Defer those while the import runs and publish one final refresh instead.
  if (dbChangeSuppressionDepth > 0) {
    deferredDbScopes.add(scope);
    return;
  }

  pendingDbScopes.add(scope);
  if (scope === "items") {
    if (changedItemIds && changedItemIds.length > 0) {
      for (const itemId of changedItemIds) {
        if (itemId) pendingItemIds.add(itemId);
      }
    }
    pendingItemChangeKind =
      pendingItemChangeKind === "content" || itemChangeKind === "content"
        ? "content"
        : "metadata";
  }

  if (dbChangeFlushTimer !== null) return;
  dbChangeFlushTimer = window.setTimeout(flushDbChanges, DB_CHANGE_FLUSH_MS);
};

const collectItemIdsFromCollectionChange = (changeEvent: any): string[] => {
  const ids = new Set<string>();

  const pushMaybeId = (value: unknown) => {
    if (typeof value === "string" && value) {
      ids.add(value);
    }
  };

  const visitEvent = (event: any) => {
    pushMaybeId(event?.documentId);
    pushMaybeId(event?.documentData?.id);
    pushMaybeId(event?.previousDocumentData?.id);
  };

  if (Array.isArray(changeEvent?.events)) {
    for (const event of changeEvent.events) {
      visitEvent(event);
    }
  } else {
    visitEvent(changeEvent);
  }

  return Array.from(ids);
};

const collectItemIdsFromItemTagsChange = (changeEvent: any): string[] => {
  const ids = new Set<string>();

  const pushMaybeId = (value: unknown) => {
    if (typeof value === "string" && value) {
      ids.add(value);
    }
  };

  const visitEvent = (event: any) => {
    pushMaybeId(event?.documentData?.itemId);
    pushMaybeId(event?.previousDocumentData?.itemId);
  };

  if (Array.isArray(changeEvent?.events)) {
    for (const event of changeEvent.events) {
      visitEvent(event);
    }
  } else {
    visitEvent(changeEvent);
  }

  return Array.from(ids);
};

const didTagNameChange = (changeEvent: any): boolean => {
  const isNameChanged = (event: any): boolean => {
    const operation = event?.operation;
    if (operation === "DELETE") return true;
    if (operation === "UPDATE") {
      return (event?.documentData?.name || "") !== (event?.previousDocumentData?.name || "");
    }
    return false;
  };

  if (Array.isArray(changeEvent?.events)) {
    for (const event of changeEvent.events) {
      if (isNameChanged(event)) {
        return true;
      }
    }
    return false;
  }

  return isNameChanged(changeEvent);
};

console.log("[Offscreen] Document script loaded.");

const router = new OffscreenRouter();
const ocrController = {
  async extractImageText(payload: { url?: string }) {
    if (!OCR_SUPPORTED) {
      throw new Error(
        "Local image OCR is unavailable in this browser build."
      );
    }
    const url = typeof payload?.url === "string" ? payload.url : "";
    try {
      return await ocrService.processImageUrl(url);
    } finally {
      // This ad-hoc path bypasses the OCR queue, so it must arrange the same
      // idle teardown or the model iframe stays resident for the session.
      ocrService.scheduleIdleRelease();
    }
  },
};

const browserBookmarkImportController = {
  async hasImported() {
    return browserBookmarkImportService.hasImported();
  },
  async importTree(payload: Parameters<typeof browserBookmarkImportService.importTree>[0]) {
    dbChangeSuppressionDepth += 1;
    try {
      return await browserBookmarkImportService.importTree(payload);
    } finally {
      dbChangeSuppressionDepth = Math.max(0, dbChangeSuppressionDepth - 1);
      if (dbChangeSuppressionDepth === 0) {
        const scopes = Array.from(deferredDbScopes);
        deferredDbScopes.clear();
        for (const scope of scopes) scheduleDbChange(scope);
      }
    }
  },
};

const githubStarsImportController = {
  async importStars(payload: Parameters<typeof githubStarsImportService.importStars>[0]) {
    dbChangeSuppressionDepth += 1;
    try {
      return await githubStarsImportService.importStars(payload);
    } finally {
      dbChangeSuppressionDepth = Math.max(0, dbChangeSuppressionDepth - 1);
      if (dbChangeSuppressionDepth === 0) {
        const scopes = Array.from(deferredDbScopes);
        deferredDbScopes.clear();
        for (const scope of scopes) scheduleDbChange(scope);
      }
    }
  },
};

const cloudSyncController = {
  async status() {
    return cloudSyncService.status();
  },
  async drain(payload: Parameters<typeof cloudSyncService.drain>[0]) {
    return cloudSyncService.drain(payload);
  },
  async pushItem(payload: { itemId?: string }) {
    return cloudSyncService.pushItem(typeof payload?.itemId === "string" ? payload.itemId : "");
  },
  async cancelAndClear() {
    return cloudSyncService.cancelAndClear();
  },
};

const cloudAuthController = {
  async status(payload?: { refresh?: boolean }) {
    return cloudAuthService.status(payload);
  },
  async connect() {
    return cloudAuthService.connect();
  },
  async disconnect() {
    return cloudAuthService.disconnect();
  },
};

// Register all the services that the offscreen document will manage.
router.registerService("dbManager", databaseManager, {
  methods: [
    "getAllFolders",
    "getImportTargets",
    "buildExportSnapshot",
    "buildExportSnapshotFile",
    "getNotionExportBatch",
    "importSharedSnapshot",
    "buildLocalExtensionMigrationBundle",
    "buildLocalExtensionMigrationDownload",
    "stageLocalExtensionMigrationBundle",
    "stageLocalExtensionMigrationFile",
    "restoreStagedLocalExtensionMigrationBundle",
    "restoreLocalExtensionMigrationBundle",
    "mergeBackupSnapshot",
    "mergeBackupSnapshotFile",
    "filterExistingItemIds",
    "deleteAllData",
  ],
});
router.registerService("browserBookmarks", browserBookmarkImportController, {
  methods: ["hasImported", "importTree"],
});
router.registerService("githubStars", githubStarsImportController, {
  methods: ["importStars"],
});
router.registerService("cloudSync", cloudSyncController, {
  methods: ["status", "drain", "pushItem", "cancelAndClear"],
});
router.registerService("cloudAuth", cloudAuthController, {
  methods: ["status", "connect", "disconnect"],
});
router.registerService("sync", syncService, {
  methods: ["rebuildAndCompact"],
});
router.registerService("items", itemsController, {
  methods: [
    "saveFetchedMetadata",
    "getByIds",
    "markSearchIndexDirty",
    "queryLocal",
    "addToFolder",
    "addMany",
    "getPendingMetadataUrls",
    "refetchMetadata",
    "moveToSpace",
    "copyToSpace",
    "moveToFolder",
    "reorder",
    "delete",
    "restoreFromBin",
    "deleteForever",
    "update",
    "updateMedia",
    "removeMedia",
    "addMedia",
    "replaceMedia",
    "listItemsWithOpfsMedia",
    "applyOpfsMediaPromotions",
    "deleteUnreferencedOpfsMedia",
    "reconcileOrphanedOpfsItemDirectories",
  ],
});
router.registerService("folders", foldersController, {
  methods: [
    "create",
    "getById",
    "setPinned",
    "setLocked",
    "setCollapsed",
    "rename",
    "delete",
    "restoreFromBin",
    "deleteForever",
    "countItemsInTree",
    "reorder",
    "moveToSpace",
    "copyToSpace",
    "moveToParent",
    "mergeInto",
  ],
});
router.registerService("bin", binController, {
  methods: ["listContents"],
});
router.registerService("tags", tagsController, {
  methods: [
    "getTagsForItem",
    "searchTags",
    "addTagToItem",
    "removeTagFromItem",
    "listAllTags",
    "createTag",
    "renameTag",
    "deleteTag",
    "setTagColor",
    "setTagFavorite",
  ],
});
router.registerService("spaces", spacesController, {
  methods: [
    "listSpaces",
    "createSpace",
    "renameSpace",
    "setPrivatePassword",
    "unlockSpace",
    "changePrivatePassword",
    "recoverPrivatePassword",
    "lockSpace",
    "touchSpaceActivity",
    "getSpaceAccessState",
    "moveToSpaceGroup",
    "moveToBin",
    "restoreFromBin",
    "listBinSpaces",
    "purgeExpired",
    "deleteSpaceForever",
    "reorderSpaces",
  ],
});
router.registerService("spaceGroups", spaceGroupsController, {
  methods: [
    "listSpaceGroups",
    "createSpaceGroup",
    "renameSpaceGroup",
    "setCollapsed",
    "resolveDropSpace",
    "deleteSpaceGroup",
    "reorderSpaceGroups",
  ],
});
router.registerService("ocr", ocrController, {
  methods: ["extractImageText"],
});

// Start listening for messages.
router.listen();

// --- Robust Embedding Queue ---
const EMBEDDING_BATCH_SIZE = 20; // Process 20 items at a time for embeddings
// A single worker request carries at most this many sentences (chunks). It caps
// how long the embedding worker is busy per request so an interactive search
// query (sent at higher priority) waits at most one short request, and keeps
// each OPFS vector append small. The worker further micro-batches internally to
// bound inference memory.
const MAX_SENTENCES_PER_EMBED_REQUEST = 16;
const EMBEDDING_SCHEMA_VERSION_STORAGE_KEY = "vibe.search.embeddingTextVersion";
const EMBEDDING_STATE_REPAIR_VERSION_STORAGE_KEY = "vibe.search.embeddingStateRepairVersion";
const EMBEDDING_STATE_REPAIR_VERSION = "v2-vector-bounds";
let isEmbeddingRunning = false;
let embeddingScheduled = false;
let embeddingCheckTimer: number | null = null;
let embeddingWaitNotified = false;
const OCR_BATCH_SIZE = 1;
const OCR_RETRY_AFTER_MS = 6 * 60 * 60 * 1000;
let isOcrRunning = false;
let ocrScheduled = false;
let ocrCheckTimer: number | null = null;
let ocrWaitNotified = false;
const queuedOcrItemIds = new Map<string, boolean>();

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

const getExtensionStorageLocal = (): chrome.storage.LocalStorageArea | null => {
  const runtimeChrome = (globalThis as typeof globalThis & { chrome?: typeof chrome }).chrome;
  return runtimeChrome?.storage?.local ?? null;
};

const getStoredEmbeddingTextVersion = async (): Promise<string> => {
  const storage = getExtensionStorageLocal();
  if (storage) {
    const values = await storage.get(EMBEDDING_SCHEMA_VERSION_STORAGE_KEY);
    const value = values[EMBEDDING_SCHEMA_VERSION_STORAGE_KEY];
    return typeof value === "string" ? value : "";
  }

  try {
    return globalThis.localStorage?.getItem(EMBEDDING_SCHEMA_VERSION_STORAGE_KEY) || "";
  } catch {
    return "";
  }
};

const setStoredEmbeddingTextVersion = async (version: string): Promise<void> => {
  const storage = getExtensionStorageLocal();
  if (storage) {
    await storage.set({ [EMBEDDING_SCHEMA_VERSION_STORAGE_KEY]: version });
    return;
  }

  try {
    globalThis.localStorage?.setItem(EMBEDDING_SCHEMA_VERSION_STORAGE_KEY, version);
  } catch {}
};

const getStoredEmbeddingStateRepairVersion = async (): Promise<string> => {
  const storage = getExtensionStorageLocal();
  if (storage) {
    const values = await storage.get(EMBEDDING_STATE_REPAIR_VERSION_STORAGE_KEY);
    const value = values[EMBEDDING_STATE_REPAIR_VERSION_STORAGE_KEY];
    return typeof value === "string" ? value : "";
  }

  try {
    return globalThis.localStorage?.getItem(EMBEDDING_STATE_REPAIR_VERSION_STORAGE_KEY) || "";
  } catch {
    return "";
  }
};

const setStoredEmbeddingStateRepairVersion = async (version: string): Promise<void> => {
  const storage = getExtensionStorageLocal();
  if (storage) {
    await storage.set({ [EMBEDDING_STATE_REPAIR_VERSION_STORAGE_KEY]: version });
    return;
  }

  try {
    globalThis.localStorage?.setItem(EMBEDDING_STATE_REPAIR_VERSION_STORAGE_KEY, version);
  } catch {}
};

const ensureEmbeddingSchemaVersion = async () => {
  try {
    const currentVersion = await getStoredEmbeddingTextVersion();

    if (currentVersion === EMBEDDING_TEXT_VERSION) {
      return;
    }

    sendProcessStatus({
      id: "embedding-schema",
      label: "Embedding schema",
      state: "processing",
      detail: `Updating embedding schema ${currentVersion || "none"} -> ${EMBEDDING_TEXT_VERSION}...`,
    });

    const updatedCount = await databaseManager.markAllActiveItemsForReembedding();
    await setStoredEmbeddingTextVersion(EMBEDDING_TEXT_VERSION);

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
      detail: error instanceof Error ? error.message : "Failed to update embedding schema.",
      retryAction: "TRIGGER_EMBEDDING",
    });
  }
};

const ensureEmbeddingStateRepair = async () => {
  try {
    const currentVersion = await getStoredEmbeddingStateRepairVersion();
    const vectorCount = await vectorStoreService.getVectorCount();
    const markerPrefix = `${EMBEDDING_STATE_REPAIR_VERSION}:`;
    const previousVectorCount = currentVersion.startsWith(markerPrefix)
      ? Number(currentVersion.slice(markerPrefix.length))
      : Number.NaN;
    // Growth cannot invalidate an older in-range reference. A missing file or
    // compaction shrink must rerun the bounded-reference audit.
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
    const repairedCount = await databaseManager.repairItemsMissingVectors(vectorCount);
    await setStoredEmbeddingStateRepairVersion(`${markerPrefix}${vectorCount}`);
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
      detail: error instanceof Error ? error.message : "Failed to repair embedding state.",
      retryAction: "TRIGGER_EMBEDDING",
    });
  }
};

const maybeReportEmbeddingWait = () => {
  if (vectorPipelineCoordinator.getActiveOperation() === "compaction") {
    if (!embeddingWaitNotified) {
      sendProcessStatus({
        id: "embedding-queue",
        label: "Embedding queue",
        state: "processing",
        detail: "Waiting for vector maintenance to finish...",
      });
      embeddingWaitNotified = true;
    }
    return;
  }

  embeddingWaitNotified = false;
};

const runEmbeddingBatch = async (
  batch: EmbeddingBatchItem[],
  updateForItem: (item: EmbeddingBatchItem, vectorIndexes: number[]) => Record<string, unknown>
): Promise<number> => {
  maybeReportEmbeddingWait();

  return vectorPipelineCoordinator.runExclusive("embedding", async () => {
    const entries = batch.flatMap((item) =>
      composeEmbeddingTexts(item).map((text) => ({ itemId: item.id, text }))
    );

    // Embed in bounded sub-requests so a large OCR-heavy batch cannot lock the
    // worker (or block an interactive query) for seconds, and so each OPFS
    // vector append stays small. Vector indexes are contiguous because the
    // coordinator holds the embedding lock across the whole batch.
    const vectorIndexesByItemId = new Map<string, number[]>();
    let appendedTotal = 0;

    for (let start = 0; start < entries.length; start += MAX_SENTENCES_PER_EMBED_REQUEST) {
      const slice = entries.slice(start, start + MAX_SENTENCES_PER_EMBED_REQUEST);
      const appendResult = await vectorStoreService.generateAndStoreEmbeddings({
        sentences: slice.map((entry) => entry.text),
        priority: "background",
      });
      if (appendResult.appendedCount !== slice.length) {
        throw new Error(
          `Embedding append mismatch: expected ${slice.length}, got ${appendResult.appendedCount}`
        );
      }
      slice.forEach((entry, idx) => {
        const indexes = vectorIndexesByItemId.get(entry.itemId) || [];
        indexes.push(appendResult.startIndex + idx);
        vectorIndexesByItemId.set(entry.itemId, indexes);
      });
      appendedTotal += appendResult.appendedCount;
    }

    const updates = batch.map((item) => updateForItem(item, vectorIndexesByItemId.get(item.id) || []));
    await databaseManager.bulkUpdateItems(updates);
    return appendedTotal;
  });
};

/**
 * Process all pending embeddings in batches.
 * This function is designed to be called frequently and will
 * handle both new items and dirty items efficiently.
 */
const processEmbeddingQueue = async () => {
  if (isEmbeddingRunning) {
    // Already running, schedule another run when done
    embeddingScheduled = true;
    return;
  }

  isEmbeddingRunning = true;
  embeddingScheduled = false;
  sendProcessStatus({
    id: "embedding-queue",
    label: "Embedding queue",
    state: "processing",
    detail: "Embedding queued records...",
  });

  let processError: string | null = null;
  try {
    // Process new items (not yet embedded)
    let totalNewItems = 0;
    let totalNewVectors = 0;
    while (true) {
      const batch = await databaseManager.getItemsToEmbed({ limit: EMBEDDING_BATCH_SIZE });

      if (batch.length === 0) break;

      console.log(`[Offscreen] Embedding ${batch.length} new items...`);

      try {
        const appendedCount = await runEmbeddingBatch(batch, (item, vectorIndexes) => ({
          id: item.id,
          expectedRevision: item.expectedRevision,
          expectedUpdatedAt: item.updatedAt,
          vector_index: vectorIndexes[0] ?? -1,
          vector_indexes: vectorIndexes,
          isEmbedded: true,
          isDirty: false,
        }));
        totalNewItems += batch.length;
        totalNewVectors += appendedCount;

        // Notify UI of progress
        sendStatusUpdate(`Embedded ${totalNewItems} new items...`);
        sendProcessStatus({
          id: "embedding-queue",
          label: "Embedding queue",
          state: "processing",
          detail: `Embedded ${totalNewItems} records (${totalNewVectors} vectors)...`,
        });
      } catch (error) {
        console.error("[Offscreen] Error embedding new items batch:", error);
        processError = error instanceof Error ? error.message : "Embedding failed for a batch";
        break;
      }
    }

    if (totalNewItems > 0) {
      console.log(`[Offscreen] Finished embedding ${totalNewItems} new items`);
    }

    // Process dirty items (need re-embedding)
    let totalDirtyItems = 0;
    while (!processError) {
      const batch = await databaseManager.getDirtyItems({ limit: EMBEDDING_BATCH_SIZE });
      if (batch.length === 0) break;

      try {
        await runEmbeddingBatch(batch, (item, vectorIndexes) => ({
          id: item.id,
          expectedRevision: item.expectedRevision,
          expectedUpdatedAt: item.updatedAt,
          vector_index: vectorIndexes[0] ?? -1,
          vector_indexes: vectorIndexes,
          isEmbedded: true,
          isDirty: false,
        }));
        totalDirtyItems += batch.length;
        sendProcessStatus({
          id: "embedding-queue",
          label: "Embedding queue",
          state: "processing",
          detail: `Re-embedded ${totalDirtyItems} records...`,
        });
      } catch (error) {
        console.error("[Offscreen] Error re-embedding dirty items batch:", error);
        processError = error instanceof Error ? error.message : "Re-embedding failed for a batch";
      }
    }

    if (processError) {
      sendProcessStatus({
        id: "embedding-queue",
        label: "Embedding queue",
        state: "error",
        detail: processError,
        retryAction: "TRIGGER_EMBEDDING",
      });
    } else {
      sendProcessStatus({
        id: "embedding-queue",
        label: "Embedding queue",
        state: "success",
        detail: "Embedding queue is idle.",
      });
    }
  } finally {
    isEmbeddingRunning = false;

    // If another embedding was requested while we were running, run again
    if (embeddingScheduled) {
      setTimeout(processEmbeddingQueue, 100);
    }

    // Embedding blocks OCR (maybeReportOcrWait). Now that we're idle, re-check
    // the OCR backlog so a just-saved screenshot gets read promptly instead of
    // waiting on the 5s self-retry. OCR completion then re-triggers embedding,
    // closing the screenshot → OCR → re-embed loop.
    scheduleOcrIfNeeded();
  }
};

/**
 * Trigger embedding processing. Safe to call frequently -
 * will debounce and batch automatically.
 */
export const triggerEmbedding = () => {
  if (isEmbeddingRunning) {
    embeddingScheduled = true;
  } else {
    // Small delay to allow batch accumulation
    setTimeout(processEmbeddingQueue, 200);
  }
};

const scheduleEmbeddingIfNeeded = () => {
  if (embeddingCheckTimer !== null) {
    return;
  }

  embeddingCheckTimer = window.setTimeout(async () => {
    embeddingCheckTimer = null;
    try {
      const [newItems, dirtyItems] = await Promise.all([
        databaseManager.getItemsToEmbed({ limit: 1 }),
        databaseManager.getDirtyItems({ limit: 1 }),
      ]);
      if (newItems.length > 0 || dirtyItems.length > 0) {
        triggerEmbedding();
      }
    } catch (error) {
      console.error("[Offscreen] Failed to check embedding backlog:", error);
    }
  }, 250);
};

const maybeReportOcrWait = (): boolean => {
  if (isEmbeddingRunning || vectorPipelineCoordinator.getActiveOperation() !== null) {
    if (!ocrWaitNotified) {
      sendProcessStatus({
        id: "ocr-queue",
        label: "Image OCR",
        state: "processing",
        detail: "Waiting for embedding/vector work to finish...",
      });
      ocrWaitNotified = true;
    }
    return true;
  }
  ocrWaitNotified = false;
  return false;
};

const activeOcrItemIds = new Set<string>();

const processOcrItem = async (
  item: ItemDocType,
  force = false
): Promise<ItemDocType["ocrStatus"]> => {
  if (activeOcrItemIds.has(item.id)) return "processing";

  const sourceHash = ocrService.getSourceHash(item);
  if (
    !force &&
    item.ocrStatus === "done" &&
    item.ocrModelVersion === OCR_MODEL_VERSION &&
    item.ocrSourceHash === sourceHash
  ) {
    return "done";
  }

  activeOcrItemIds.add(item.id);
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
    const message = error instanceof Error ? error.message : "OCR failed for an item";
    await databaseManager.saveItemOcrResult({
      id: item.id,
      status: "error",
      modelVersion: OCR_MODEL_VERSION,
      sourceHash,
      text: item.ocrText || "",
      confidence: item.ocrConfidence,
      lineCount: item.ocrLineCount || 0,
      error: message,
    });
    throw error;
  } finally {
    activeOcrItemIds.delete(item.id);
  }
};

const processOcrItemById = async (
  itemId: string,
  force = false
): Promise<ItemDocType["ocrStatus"]> => {
  const db = await getDb();
  const doc = await db.items.findOne(itemId).exec();
  if (!doc) throw new Error("OCR_ITEM_NOT_FOUND");
  return processOcrItem(doc.toMutableJSON() as ItemDocType, force);
};

const enqueueOcrItem = (itemId: string, force = false): void => {
  if (!itemId) return;
  queuedOcrItemIds.set(itemId, force || queuedOcrItemIds.get(itemId) === true);
};

const takeQueuedOcrItems = (limit: number): Array<{ itemId: string; force: boolean }> => {
  const items: Array<{ itemId: string; force: boolean }> = [];
  for (const [itemId, force] of queuedOcrItemIds) {
    queuedOcrItemIds.delete(itemId);
    items.push({ itemId, force });
    if (items.length >= limit) break;
  }
  return items;
};

const processOcrQueue = async () => {
  if (isOcrRunning) {
    ocrScheduled = true;
    return;
  }

  if (maybeReportOcrWait()) {
    ocrScheduled = true;
    window.setTimeout(processOcrQueue, 5000);
    return;
  }

  isOcrRunning = true;
  ocrScheduled = false;
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
      const directItems = takeQueuedOcrItems(OCR_BATCH_SIZE);
      if (directItems.length > 0) {
        for (const item of directItems) {
          try {
            const status = await processOcrItemById(item.itemId, item.force);
            if (status === "done") processed += 1;
            else if (status === "skipped" || status === "processing") skipped += 1;
            else errored += 1;
          } catch (error) {
            const message = error instanceof Error ? error.message : "OCR failed for an item";
            if (message === "OCR_ITEM_NOT_FOUND") {
              skipped += 1;
              continue;
            }
            errored += 1;
            processError = message;
          }
        }
      } else {
        const items = await databaseManager.getItemsToOcr({
          limit: OCR_BATCH_SIZE,
          modelVersion: OCR_MODEL_VERSION,
          retryErroredBefore: Date.now() - OCR_RETRY_AFTER_MS,
        });
        if (items.length === 0) break;

        for (const item of items) {
          try {
            const status = await processOcrItem(item);
            if (status === "done") processed += 1;
            else if (status === "skipped" || status === "processing") skipped += 1;
            else errored += 1;
          } catch (error) {
            errored += 1;
            const message = error instanceof Error ? error.message : "OCR failed for an item";
            processError = message;
          }
        }
      }

      sendProcessStatus({
        id: "ocr-queue",
        label: "Image OCR",
        state: "processing",
        detail: `OCR processed ${processed} images${skipped ? `, skipped ${skipped}` : ""}${errored ? `, ${errored} errors` : ""}.`,
      });
    }
    if (queuedOcrItemIds.size > 0) {
      ocrScheduled = true;
    }

    if (processError && processed === 0) {
      sendProcessStatus({
        id: "ocr-queue",
        label: "Image OCR",
        state: "error",
        detail: processError,
        retryAction: "TRIGGER_OCR",
      });
    } else {
      sendProcessStatus({
        id: "ocr-queue",
        label: "Image OCR",
        state: "success",
        detail:
          processed > 0
            ? `OCR complete for ${processed} image records.`
            : "Image OCR is idle.",
      });
    }
  } finally {
    isOcrRunning = false;
    if (ocrScheduled) {
      window.setTimeout(processOcrQueue, 500);
    } else if (queuedOcrItemIds.size === 0 && activeOcrItemIds.size === 0) {
      // PaddleOCR keeps a sizeable WASM model in the sandbox iframe. The
      // offscreen document lives for the browser session, so release that
      // iframe once the queue is quiet instead of retaining the model forever.
      ocrService.scheduleIdleRelease();
    }
    scheduleEmbeddingIfNeeded();
  }
};

export const triggerOcr = () => {
  if (!OCR_SUPPORTED) return;
  if (isOcrRunning) {
    ocrScheduled = true;
  } else {
    window.setTimeout(processOcrQueue, 500);
  }
};

const scheduleOcrIfNeeded = () => {
  if (!OCR_SUPPORTED) return;
  if (ocrCheckTimer !== null) return;
  ocrCheckTimer = window.setTimeout(async () => {
    ocrCheckTimer = null;
    try {
      const items = await databaseManager.getItemsToOcr({
        limit: 1,
        modelVersion: OCR_MODEL_VERSION,
        retryErroredBefore: Date.now() - OCR_RETRY_AFTER_MS,
      });
      if (items.length > 0) triggerOcr();
    } catch (error) {
      console.error("[Offscreen] Failed to check OCR backlog:", error);
    }
  }, 1000);
};

// Listen for direct embedding trigger messages
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === "TRIGGER_EMBEDDING" && message.isForwarded) {
    if (!isTrustedForwarderSender(sender)) {
      sendResponse({ success: false, error: "UNAUTHORIZED_FORWARDER" });
      return true;
    }
    console.log("[Offscreen] Received TRIGGER_EMBEDDING message");
    triggerEmbedding();
    sendResponse({ success: true });
    return true;
  }

  if (message.type === "TRIGGER_OCR" && message.isForwarded) {
    if (!isTrustedForwarderSender(sender)) {
      sendResponse({ success: false, error: "UNAUTHORIZED_FORWARDER" });
      return true;
    }

    if (!OCR_SUPPORTED) {
      sendResponse({
        success: false,
        error: "Local image OCR is unavailable in this browser build.",
      });
      return true;
    }

    const itemId = typeof message?.payload?.itemId === "string" ? message.payload.itemId : "";
    const force = message?.payload?.force === true;
    if (itemId) {
      enqueueOcrItem(itemId, force);
      triggerOcr();
      sendResponse({ success: true, payload: { status: "queued" } });
      return true;
    }

    triggerOcr();
    sendResponse({ success: true });
    return true;
  }
});

const initializeApp = async () => {
  try {
    queryRankerService.prewarm();
    sendStatusUpdate("Initializing database...");
    sendProcessStatus({
      id: "offscreen-runtime",
      label: "Worker runtime",
      state: "processing",
      detail: "Initializing offscreen services...",
    });
    const db = await getDb();
    await spacesController.ensureDefaults();
    await spacesController.maybeRepairFolderAndItemSpaceAssignments();
    try {
      const purge = await spacesController.purgeExpired();
      if (purge.purgedSpaceIds.length > 0) {
        console.log(
          `[Offscreen] Purged ${purge.purgedSpaceIds.length} expired bin space(s).`
        );
      }
    } catch (purgeError) {
      console.error("[Offscreen] Bin purge failed:", purgeError);
    }
    sendStatusUpdate("Database initialized.");

    console.log("[Offscreen] Database ready.");

    // Recover interrupted vector maintenance before new embedding work begins.
    await syncService.recoverInterruptedMaintenance();
    await ensureEmbeddingSchemaVersion();
    await ensureEmbeddingStateRepair();

    // Initial embedding process
    await processEmbeddingQueue();
    scheduleOcrIfNeeded();

    // Subscribe to item changes and trigger embedding
    db.items.$.subscribe((changeEvent: any) => {
      const changedIds = collectItemIdsFromCollectionChange(changeEvent);
      if (!isEmbeddingStateOnlyItemChange(changeEvent)) {
        itemsController.scheduleSearchIndexSync(changedIds);
        scheduleDbChange(
          "items",
          changedIds,
          isMetadataEnrichmentItemChange(changeEvent) ? "metadata" : "content"
        );
      }
      // Trigger embedding only when there is actual pending work.
      scheduleEmbeddingIfNeeded();
      scheduleOcrIfNeeded();
    });

    db.folders.$.subscribe((changeEvent: any) => {
      if (isFolderCollapseOnlyChange(changeEvent)) return;
      scheduleDbChange("folders");
    });

    db.spaces.$.subscribe(() => {
      scheduleDbChange("spaces");
    });

    db.space_groups.$.subscribe((changeEvent: any) => {
      if (isSpaceGroupCollapseOnlyChange(changeEvent)) return;
      scheduleDbChange("space_groups");
    });

    db.tags.$.subscribe((changeEvent: any) => {
      if (didTagNameChange(changeEvent)) {
        itemsController.markSearchIndexDirty();
        scheduleDbChange("items");
      } else {
        scheduleDbChange("tags");
      }
    });

    db.item_tags.$.subscribe((changeEvent: any) => {
      const changedItemIds = collectItemIdsFromItemTagsChange(changeEvent);
      if (changedItemIds.length > 0) {
        itemsController.scheduleSearchIndexSync(changedItemIds);
      } else {
        itemsController.markSearchIndexDirty();
      }
      scheduleDbChange("items", changedItemIds);
    });

    console.log("[Offscreen] Initialization complete with auto-embedding enabled.");
    sendProcessStatus({
      id: "offscreen-runtime",
      label: "Worker runtime",
      state: "success",
      detail: "Offscreen services are ready.",
    });

    // Bounded janitor for the 30-day space bin. Runs on init then every 6h.
    // The interval lives for the offscreen document lifetime; no teardown hook
    // since the document is destroyed wholesale when the browser unloads it.
    const runBinPurge = async () => {
      try {
        await spacesController.purgeExpired();
      } catch (runError) {
        console.error("[Offscreen] Bin purge tick failed:", runError);
      }
    };
    window.setInterval(() => void runBinPurge(), 6 * 60 * 60 * 1000);
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : "An unknown error occurred";
    console.error("[Offscreen] Error during initialization:", error);
    sendStatusUpdate(`Error: ${errorMessage}`);
    sendProcessStatus({
      id: "offscreen-runtime",
      label: "Worker runtime",
      state: "error",
      detail: errorMessage,
      retryAction: "RETRY_QUERY",
    });
  }
};

initializeApp();
