import { getDb } from "@src/services/DatabaseService";
import { ItemDocType, MediaOcrMetadata } from "@src/schemas/item_schema";
import { FolderDocType } from "@src/schemas/folder_schema";
import {
  LIVE_SPACE_SELECTOR,
  PRIVATE_SPACE_ID,
  PUBLIC_SPACE_ID,
} from "@src/common/spaces";
import { nextBinMutationTimestamp } from "@src/common/bin";
import { spaceSessionService } from "@src/services/space-session.service";
import {
  getVectorIndexes,
  hasEmbeddableText,
  isMetadataReadyForEmbedding,
} from "@src/search-core/embedding-state";
import {
  appendOcrTextToTextContent,
  normalizeOcrText,
} from "@src/services/ocr-text";
import { isMetadataFetchableUrl } from "@src/utils/metadata-url";
import {
  buildLocalExportSnapshot,
  importSharedSnapshot,
  type BuildExportSnapshotPayload,
  type ImportSharedSnapshotPayload,
  type ImportSharedSnapshotResult,
  type ShareSnapshotV1,
} from "@src/services/share-snapshot";
import {
  buildLocalExtensionMigrationBundle,
  LOCAL_MIGRATION_MAX_JSON_BYTES,
  restoreLocalExtensionMigrationBundle as restoreLocalExtensionMigration,
  summarizeLocalExtensionMigrationBundle,
  validateLocalExtensionMigrationBundle,
  type LocalExtensionMigrationBundle,
  type LocalExtensionMigrationSummary,
  type RestoreLocalExtensionMigrationResult,
} from "@src/services/local-extension-migration";
import {
  mergeBackupSnapshot,
  type MergeBackupSnapshotResult,
} from "@src/services/share-snapshot";
import {
  withEntityMutationLock,
  withSpaceMutationLocks,
} from "@src/services/entity-mutation-lock";
import { ARCHIVE_OUTBOX_DIRECTORY } from "@src/services/archive-outbox";
import {
  clearOffscreenArchiveOutboxMetadata,
  getOffscreenArchiveCache,
  getOffscreenArchiveOutboxReader,
} from "@src/services/archive-migration-storage-bridge";
import { createLocalMigrationJsonBlob } from "@src/services/local-extension-migration-json";
import {
  clearStagedPayloads,
  deleteStagedPayloadFile,
  readStagedPayloadFile,
  stagePayloadFile,
} from "@src/services/large-payload-staging";
import { GOOGLE_BACKUP_MAX_BYTES } from "@src/services/google-backup-limits";
import { vectorStoreService } from "@src/services/vector-store.service";
import { vectorPipelineCoordinator } from "@src/services/vector-pipeline-coordinator";
import { vectorMaintenanceJournalService } from "@src/services/vector-maintenance-journal.service";
import { loadNotionExportBatch } from "@src/services/notion-export-source";
import {
  requireLiveFolderDestination,
  withLiveFolderDestination,
  withLiveSpaceDestination,
} from "@src/services/live-destination";

type SearchScope = "current" | "global" | "private" | "public";
type AccessContext = {
  activeSpaceId?: string;
  searchScope?: SearchScope;
};
type BulkItemUpdate = Partial<ItemDocType> & {
  expectedRevision?: string;
  expectedUpdatedAt?: number;
};
type MediaEntry = NonNullable<ItemDocType["media"]>[number];
type SavedMediaOcrResult = {
  url: string;
  source?: "display" | "s3" | "original" | "opfs";
  status?: MediaOcrMetadata["status"];
  text?: string;
  confidence?: number | null;
  lineCount?: number;
  sourceHash?: string;
  error?: string;
};
const BULK_ITEM_UPDATE_BATCH_SIZE = 400;
const STAGED_RESTORE_TTL_MS = 15 * 60 * 1000;
const yieldToEventLoop = () => new Promise<void>((resolve) => window.setTimeout(resolve, 0));

const isWriteConflict = (error: unknown): boolean => {
  const candidate = error as {
    status?: unknown;
    rxdb?: { status?: unknown };
    parameters?: { writeError?: { status?: unknown } };
  };
  return (
    candidate?.status === 409 ||
    candidate?.rxdb?.status === 409 ||
    candidate?.parameters?.writeError?.status === 409
  );
};

export type ImportTargetItemPreview = {
  id: string;
  title: string;
  updatedAt: number;
};

export type ActiveVectorInventoryItem = Pick<
  ItemDocType,
  | "id"
  | "vector_index"
  | "vector_indexes"
  | "isEmbedded"
  | "isMetaFetched"
  | "isDirty"
> & { revision: string };

export type ActiveVectorEmbeddingSnapshot = {
  item: ItemDocType;
  revision: string;
};

export type CompactedVectorIndexCommit = {
  id: string;
  vector_index: number;
  vector_indexes: number[];
  expectedRevision: string;
  isEmbeddedOnMatch: boolean;
  isDirtyOnMatch: boolean;
};

/**
 * A compaction result is current only when it was built from this exact RxDB
 * revision. The vector index must still be remapped after the file swap, but a
 * concurrently edited item stays dirty so its stale vector is never searched.
 */
export const applyCompactedVectorIndexCommit = <T extends ItemDocType>(
  current: T,
  currentRevision: string,
  update: CompactedVectorIndexCommit
): T =>
  ({
    ...current,
    vector_index: update.vector_index,
    vector_indexes: [...update.vector_indexes],
    isEmbedded:
      currentRevision === update.expectedRevision ? update.isEmbeddedOnMatch : false,
    isDirty: currentRevision === update.expectedRevision ? update.isDirtyOnMatch : true,
  }) as T;

/** Change only vector state on the latest RxDB revision during recovery. */
export const applyVectorInvalidation = <T extends ItemDocType>(
  current: T,
  options?: { touchUpdatedAt?: boolean; now?: number }
): T =>
  ({
    ...current,
    vector_index: -1,
    vector_indexes: [],
    isEmbedded: false,
    isDirty: true,
    updatedAt: options?.touchUpdatedAt ? options.now ?? Date.now() : current.updatedAt,
  }) as T;

export const isEmbeddingStateCommitCurrent = (
  current: Pick<ItemDocType, "deletedAt" | "updatedAt">,
  currentRevision: string,
  expected: { expectedRevision?: string; expectedUpdatedAt?: number }
): boolean =>
  (current.deletedAt || 0) === 0 &&
  (expected.expectedRevision === undefined || currentRevision === expected.expectedRevision) &&
  (expected.expectedUpdatedAt === undefined || current.updatedAt === expected.expectedUpdatedAt);

export type ImportTargetFolder = {
  id: string;
  name: string;
  sortOrder: number;
  isPinned: boolean;
  updatedAt: number;
  recentItems: ImportTargetItemPreview[];
};

export type ImportTargetSpace = {
  id: string;
  name: string;
  slug: string;
  isPrivate: boolean;
  isUnlocked: boolean;
  sortOrder: number;
  folders: ImportTargetFolder[];
};

class DatabaseManager {
  [key: string]: any;
  private stagedLocalRestoreBundles = new Map<string, LocalExtensionMigrationBundle>();

  private normalizeUserId(userId: string | null | undefined): string {
    return typeof userId === "string" ? userId : "";
  }

  private itemHasOcrImage(item: ItemDocType): boolean {
    if (typeof item.displayImageUrl === "string" && item.displayImageUrl.trim().length > 0) {
      return true;
    }
    return (item.media || []).some(
      (entry) =>
        entry?.type === "image" &&
        (typeof entry.s3Url === "string" ||
          typeof entry.originalUrl === "string" ||
          typeof entry.opfsPath === "string")
    );
  }

  private normalizeOcrConfidence(value: unknown): number | null {
    if (!Number.isFinite(value)) return null;
    return Math.max(0, Math.min(1, value as number));
  }

  private normalizeOcrLineCount(value: unknown): number {
    if (!Number.isFinite(value)) return 0;
    return Math.max(0, Math.floor(value as number));
  }

  private normalizeComparableUrl(value: unknown): string {
    if (typeof value !== "string") return "";
    const trimmed = value.trim();
    if (!trimmed) return "";
    try {
      return new URL(trimmed).toString();
    } catch {
      return trimmed;
    }
  }

  private mediaOcrResultMatchesEntry(entry: MediaEntry, result: SavedMediaOcrResult): boolean {
    const target = this.normalizeComparableUrl(result.url);
    if (!target) return false;

    if (result.source === "s3") {
      return this.normalizeComparableUrl(entry.s3Url) === target;
    }
    if (result.source === "original") {
      return this.normalizeComparableUrl(entry.originalUrl) === target;
    }
    if (result.source === "opfs") {
      return this.normalizeComparableUrl(entry.opfsPath) === target;
    }

    return [entry.s3Url, entry.originalUrl, entry.opfsPath]
      .map((url) => this.normalizeComparableUrl(url))
      .some((url) => url && url === target);
  }

  private buildMediaOcrMetadata(
    result: SavedMediaOcrResult,
    payload: {
      status: ItemDocType["ocrStatus"];
      modelVersion: string;
      sourceHash: string;
      text?: string;
      confidence?: number | null;
      lineCount?: number;
      error?: string;
    },
    now: number
  ): MediaOcrMetadata {
    const status = result.status || payload.status;
    const text = normalizeOcrText(result.text ?? payload.text);
    const confidence = this.normalizeOcrConfidence(result.confidence ?? payload.confidence);
    const lineCount = this.normalizeOcrLineCount(result.lineCount ?? payload.lineCount);
    const error = (result.error || payload.error || "").slice(0, 500);
    const ocr: MediaOcrMetadata = {
      status,
      confidence,
      lineCount,
      modelVersion: payload.modelVersion,
      sourceHash: result.sourceHash || payload.sourceHash,
      extractedAt: now,
      engine: "paddleocr",
    };
    if (text) ocr.text = text;
    if (error) ocr.error = error;
    return ocr;
  }

  private applyMediaOcrResults(
    media: ItemDocType["media"],
    payload: {
      status: ItemDocType["ocrStatus"];
      modelVersion: string;
      sourceHash: string;
      text?: string;
      confidence?: number | null;
      lineCount?: number;
      error?: string;
      media?: SavedMediaOcrResult[];
    },
    now: number
  ): ItemDocType["media"] {
    if (!media || media.length === 0) return media;

    const imageCount = media.filter((entry) => entry?.type === "image").length;
    if (imageCount === 0) return media;

    const results = (payload.media || []).filter((result) => result && typeof result.url === "string");
    const fallbackResult: SavedMediaOcrResult | null =
      results.length === 0 && imageCount === 1
        ? {
            url: "",
            source: "display",
            status: payload.status,
            text: payload.text,
            confidence: payload.confidence,
            lineCount: payload.lineCount,
            sourceHash: payload.sourceHash,
            error: payload.error,
          }
        : null;
    const usedResults = new Set<number>();

    return media.map((entry) => {
      if (entry?.type !== "image") return entry;

      let resultIndex = results.findIndex(
        (result, index) => !usedResults.has(index) && this.mediaOcrResultMatchesEntry(entry, result)
      );
      if (resultIndex < 0 && imageCount === 1 && results.length === 1) {
        resultIndex = 0;
      }

      const result = resultIndex >= 0 ? results[resultIndex] : fallbackResult;
      if (!result) return entry;
      if (resultIndex >= 0) usedResults.add(resultIndex);

      return {
        ...entry,
        ocr: this.buildMediaOcrMetadata(result, payload, now),
      };
    });
  }

  private markMediaOcrProcessing(
    media: ItemDocType["media"],
    payload: { modelVersion: string; sourceHash: string },
    now: number
  ): ItemDocType["media"] {
    if (!media || media.length === 0) return media;
    return media.map((entry) => {
      if (entry?.type !== "image") return entry;
      return {
        ...entry,
        ocr: {
          ...entry.ocr,
          status: "processing",
          modelVersion: payload.modelVersion,
          sourceHash: payload.sourceHash,
          extractedAt: now,
          engine: entry.ocr?.engine || "paddleocr",
          error: "",
        },
      };
    });
  }

  private async resolveAllowedSpaceIds(
    db: any,
    accessContext?: AccessContext
  ): Promise<string[]> {
    const activeSpaceId = accessContext?.activeSpaceId || PUBLIC_SPACE_ID;
    const requestedScope = accessContext?.searchScope || "current";
    const privateUnlocked = spaceSessionService.isUnlocked(PRIVATE_SPACE_ID);

    const spaceDocs = await db.spaces
      .find({ selector: { isArchived: { $eq: false }, deletedAt: { $eq: 0 } } })
      .exec();
    const spaces = spaceDocs.map((doc: any) => doc.toMutableJSON() as any);
    const allSpaceIds = spaces.map((space: any) => space.id as string);
    const nonPrivateSpaceIds = spaces
      .filter((space: any) => !space.isPrivate)
      .map((space: any) => space.id as string);
    const hasActiveSpace = spaces.some((space: any) => space.id === activeSpaceId);
    const safeActiveSpaceId = hasActiveSpace ? activeSpaceId : PUBLIC_SPACE_ID;
    const fallbackPublic = nonPrivateSpaceIds.length > 0 ? nonPrivateSpaceIds : [PUBLIC_SPACE_ID];
    const fallbackAll = allSpaceIds.length > 0 ? allSpaceIds : fallbackPublic;

    if (requestedScope === "global") {
      return privateUnlocked ? fallbackAll : fallbackPublic;
    }
    if (requestedScope === "public") {
      return fallbackPublic;
    }
    if (requestedScope === "private") {
      return privateUnlocked ? [PRIVATE_SPACE_ID] : [];
    }
    if (safeActiveSpaceId === PRIVATE_SPACE_ID) {
      return privateUnlocked ? [PRIVATE_SPACE_ID] : [];
    }
    return [safeActiveSpaceId];
  }

  async getAllItems(payload?: { accessContext?: AccessContext }): Promise<ItemDocType[]> {
    const db = await getDb();
    const allowedSpaceIds = await this.resolveAllowedSpaceIds(db, payload?.accessContext);
    if (allowedSpaceIds.length === 0) return [];
    const allItems = await db.items
      .find({ selector: { deletedAt: { $eq: 0 }, spaceId: { $in: allowedSpaceIds } } })
      .exec();
    return allItems.map((item) => item.toMutableJSON());
  }

  async getAllFolders(payload?: { accessContext?: AccessContext; spaceIds?: string[] }): Promise<FolderDocType[]> {
    const db = await getDb();
    const baseAllowedSpaceIds = await this.resolveAllowedSpaceIds(db, payload?.accessContext);
    const requestedSpaceIds = Array.from(new Set((payload?.spaceIds || []).filter(Boolean)));
    const allowedSpaceIds = requestedSpaceIds.length > 0
      ? baseAllowedSpaceIds.filter((spaceId) => requestedSpaceIds.includes(spaceId))
      : baseAllowedSpaceIds;
    if (allowedSpaceIds.length === 0) return [];
    const allFolders = await db.folders
      .find({ selector: { spaceId: { $in: allowedSpaceIds }, deletedAt: { $eq: 0 } } })
      .exec();
    return allFolders.map((folder) => folder.toMutableJSON());
  }

  async getImportTargets(payload?: {
    maxSpaces?: number;
    maxFoldersPerSpace?: number;
    maxItemsPerFolder?: number;
  }): Promise<ImportTargetSpace[]> {
    const db = await getDb();
    const includeAllSpaces = payload?.maxSpaces === 0;
    const includeAllFolders = payload?.maxFoldersPerSpace === 0;
    const skipRecentItems = payload?.maxItemsPerFolder === 0;
    const maxSpaces = Math.max(1, Math.min(20, payload?.maxSpaces ?? 8));
    const maxFoldersPerSpace = Math.max(1, Math.min(40, payload?.maxFoldersPerSpace ?? 14));
    const maxItemsPerFolder = Math.max(1, Math.min(6, payload?.maxItemsPerFolder ?? 3));

    const spaceDocs = await db.spaces.find({ selector: { ...LIVE_SPACE_SELECTOR } }).exec();
    const sortedSpaces = spaceDocs
      .map((doc) => doc.toMutableJSON() as any)
      .sort((a, b) => {
        if (!!a.isPrivate !== !!b.isPrivate) return a.isPrivate ? 1 : -1;
        const ao = typeof a.sortOrder === "number" ? a.sortOrder : Number.MAX_SAFE_INTEGER;
        const bo = typeof b.sortOrder === "number" ? b.sortOrder : Number.MAX_SAFE_INTEGER;
        if (ao !== bo) return ao - bo;
        return (a.createdAt || 0) - (b.createdAt || 0);
      });
    const spaces = includeAllSpaces ? sortedSpaces : sortedSpaces.slice(0, maxSpaces);

    const results: ImportTargetSpace[] = [];
    for (const space of spaces) {
      const spaceId = (space.id as string) || PUBLIC_SPACE_ID;
      const isPrivate = !!space.isPrivate;
      const isUnlocked = !isPrivate || spaceSessionService.isUnlocked(spaceId);

      const spaceEntry: ImportTargetSpace = {
        id: spaceId,
        name: (space.name as string) || "Untitled",
        slug: (space.slug as string) || "",
        isPrivate,
        isUnlocked,
        sortOrder: typeof space.sortOrder === "number" ? space.sortOrder : 0,
        folders: [],
      };

      if (!isUnlocked) {
        results.push(spaceEntry);
        continue;
      }

      const folderDocs = await db.folders
        .find({
          selector: {
            spaceId: { $eq: spaceId },
            deletedAt: { $eq: 0 },
          },
        })
        .exec();
      const sortedFolders = folderDocs
        .map((doc) => doc.toMutableJSON() as FolderDocType)
        .sort((a, b) => {
          if (!!a.isPinned !== !!b.isPinned) return a.isPinned ? -1 : 1;
          const ao = a.sortOrder ?? Number.MAX_SAFE_INTEGER;
          const bo = b.sortOrder ?? Number.MAX_SAFE_INTEGER;
          if (ao !== bo) return ao - bo;
          return a.createdAt - b.createdAt;
        });
      const folders = includeAllFolders ? sortedFolders : sortedFolders.slice(0, maxFoldersPerSpace);

      for (const folder of folders) {
        const itemDocs = skipRecentItems
          ? []
          : await db.items
              .find({
                selector: {
                  folderId: { $eq: folder.id },
                  deletedAt: { $eq: 0 },
                },
                sort: [{ updatedAt: "desc" }],
                limit: maxItemsPerFolder,
              })
              .exec();
        const recentItems = itemDocs.map((doc) => {
          const item = doc.toMutableJSON() as ItemDocType;
          return {
            id: item.id,
            title: item.title || item.url || "Untitled",
            updatedAt: item.updatedAt || item.createdAt || 0,
          };
        });

        spaceEntry.folders.push({
          id: folder.id,
          name: folder.name || "Untitled",
          sortOrder: folder.sortOrder ?? 0,
          isPinned: !!folder.isPinned,
          updatedAt: folder.updatedAt || folder.createdAt || 0,
          recentItems,
        });
      }

      results.push(spaceEntry);
    }

    return results;
  }

  async buildExportSnapshot(payload?: BuildExportSnapshotPayload): Promise<ShareSnapshotV1> {
    return buildLocalExportSnapshot(payload);
  }

  async buildExportSnapshotFile(payload?: BuildExportSnapshotPayload): Promise<{
    fileName: string;
    itemCount: number;
    folderCount: number;
  }> {
    const snapshot = await buildLocalExportSnapshot(payload);
    const blob = new Blob([JSON.stringify(snapshot)], { type: "application/json" });
    if (blob.size > GOOGLE_BACKUP_MAX_BYTES) throw new Error("GOOGLE_BACKUP_TOO_LARGE");
    return {
      fileName: await stagePayloadFile(blob, "drive-export"),
      itemCount: snapshot.items.length,
      folderCount: snapshot.folders.length,
    };
  }

  async getNotionExportBatch(payload?: { afterId?: string; limit?: number }) {
    return loadNotionExportBatch(payload);
  }

  async importSharedSnapshot(payload: ImportSharedSnapshotPayload): Promise<ImportSharedSnapshotResult> {
    return importSharedSnapshot(payload);
  }

  async restoreLocalExtensionMigrationBundle(payload: {
    bundle: LocalExtensionMigrationBundle;
  }): Promise<RestoreLocalExtensionMigrationResult> {
    return restoreLocalExtensionMigration(payload.bundle, {
      archiveCache: getOffscreenArchiveCache(),
    });
  }

  async buildLocalExtensionMigrationBundle(): Promise<LocalExtensionMigrationBundle> {
    return buildLocalExtensionMigrationBundle({
      archiveCache: getOffscreenArchiveCache(),
      archiveOutbox: getOffscreenArchiveOutboxReader(),
    });
  }

  async buildLocalExtensionMigrationDownload(): Promise<{
    fileName: string;
    createdAt: number;
    summary: LocalExtensionMigrationSummary;
    warnings: string[];
  }> {
    const bundle = await this.buildLocalExtensionMigrationBundle();
    const blob = createLocalMigrationJsonBlob(bundle);
    if (blob.size > LOCAL_MIGRATION_MAX_JSON_BYTES) {
      throw new Error("MIGRATION_FILE_JSON_TOO_LARGE");
    }
    const fileName = await stagePayloadFile(blob, "local-export");
    return {
      fileName,
      createdAt: bundle.createdAt,
      summary: summarizeLocalExtensionMigrationBundle(bundle),
      warnings: bundle.warnings.slice(0, 100),
    };
  }

  async stageLocalExtensionMigrationBundle(payload: {
    json: string;
  }): Promise<{ stageId: string; summary: LocalExtensionMigrationSummary }> {
    if (payload.json.length > LOCAL_MIGRATION_MAX_JSON_BYTES) {
      throw new Error("MIGRATION_FILE_JSON_TOO_LARGE");
    }
    // Only one restore file needs to be retained in the offscreen document.
    // Clearing stale staged files prevents large JSON blobs from accumulating.
    this.stagedLocalRestoreBundles.clear();
    const bundle = validateLocalExtensionMigrationBundle(JSON.parse(payload.json));
    const stageId = crypto.randomUUID();
    this.stagedLocalRestoreBundles.set(stageId, bundle);
    window.setTimeout(() => {
      this.stagedLocalRestoreBundles.delete(stageId);
    }, STAGED_RESTORE_TTL_MS);
    return { stageId, summary: summarizeLocalExtensionMigrationBundle(bundle) };
  }

  async stageLocalExtensionMigrationFile(payload: {
    fileName: string;
  }): Promise<{ stageId: string; summary: LocalExtensionMigrationSummary }> {
    try {
      const file = await readStagedPayloadFile(payload.fileName);
      if (file.size <= 0 || file.size > LOCAL_MIGRATION_MAX_JSON_BYTES) {
        throw new Error("MIGRATION_FILE_JSON_TOO_LARGE");
      }
      return await this.stageLocalExtensionMigrationBundle({ json: await file.text() });
    } finally {
      await deleteStagedPayloadFile(payload.fileName).catch(() => {});
    }
  }

  async restoreStagedLocalExtensionMigrationBundle(payload: {
    stageId: string;
  }): Promise<RestoreLocalExtensionMigrationResult> {
    const bundle = this.stagedLocalRestoreBundles.get(payload.stageId);
    if (!bundle) throw new Error("MIGRATION_FILE_NOT_STAGED");
    const result = await restoreLocalExtensionMigration(bundle, {
      archiveCache: getOffscreenArchiveCache(),
    });
    this.stagedLocalRestoreBundles.delete(payload.stageId);
    return result;
  }

  async mergeBackupSnapshot(payload: { snapshot: unknown }): Promise<MergeBackupSnapshotResult> {
    return mergeBackupSnapshot(payload.snapshot);
  }

  async mergeBackupSnapshotFile(payload: { fileName: string }): Promise<MergeBackupSnapshotResult> {
    try {
      const file = await readStagedPayloadFile(payload.fileName);
      if (file.size <= 0 || file.size > GOOGLE_BACKUP_MAX_BYTES) {
        throw new Error("GOOGLE_BACKUP_TOO_LARGE");
      }
      return await mergeBackupSnapshot(JSON.parse(await file.text()));
    } finally {
      await deleteStagedPayloadFile(payload.fileName).catch(() => {});
    }
  }

  async filterExistingItemIds(payload: { itemIds?: string[] }): Promise<string[]> {
    const itemIds = Array.from(
      new Set((payload.itemIds || []).filter((itemId) => typeof itemId === "string" && itemId)),
    ).slice(0, 2_000);
    if (itemIds.length === 0) return [];
    const db = await getDb();
    const docs = await db.items.findByIds(itemIds).exec();
    return itemIds.filter((itemId) => docs.has(itemId));
  }

  /**
   * Permanently wipe every local collection and all OPFS payloads. Destructive
   * and irreversible — the caller (Settings → Data → Delete all data) confirms
   * first. Clears document data rather than removing the database so the live
   * RxDB instance stays valid for the running page.
   */
  async deleteAllData(): Promise<{ deletedCollections: number }> {
    return vectorPipelineCoordinator.runResetExclusive(() => this.deleteAllDataLocked());
  }

  private async deleteAllDataLocked(): Promise<{ deletedCollections: number }> {
    this.stagedLocalRestoreBundles.clear();
    spaceSessionService.lockAll();
    const db = await getDb();
    const collections = [
      db.items,
      db.folders,
      db.spaces,
      db.space_groups,
      db.tags,
      db.item_tags,
      db.search_history,
      db.flashcards,
      db.deleted_items,
    ];
    let deletedCollections = 0;
    const failures: unknown[] = [];
    for (const collection of collections) {
      try {
        await collection.find().remove();
        deletedCollections += 1;
      } catch (error) {
        console.error("[db-manager] failed to clear collection", collection?.name, error);
        failures.push(error);
      }
    }
    // Never erase payloads that may still be referenced by rows whose
    // collection deletion failed. Report the partial failure instead of
    // presenting a false-success toast.
    if (failures.length > 0) {
      throw new AggregateError(
        failures,
        `DELETE_ALL_COLLECTIONS_FAILED:${deletedCollections}/${collections.length}`,
      );
    }

    const ignoreMissingDirectory = (error: unknown): boolean =>
      error instanceof DOMException && error.name === "NotFoundError";

    try {
      const root = await navigator.storage.getDirectory();
      await root.removeEntry("media", { recursive: true });
    } catch (error) {
      if (!ignoreMissingDirectory(error)) failures.push(error);
    }
    try {
      await getOffscreenArchiveCache().clear();
    } catch (error) {
      failures.push(error);
    }
    try {
      const root = await navigator.storage.getDirectory();
      await root.removeEntry(ARCHIVE_OUTBOX_DIRECTORY, { recursive: true });
    } catch (error) {
      if (!ignoreMissingDirectory(error)) failures.push(error);
    }
    try {
      await clearOffscreenArchiveOutboxMetadata();
    } catch (error) {
      failures.push(error);
    }
    try {
      await clearStagedPayloads();
    } catch (error) {
      failures.push(error);
    }
    try {
      await vectorStoreService.deleteAllStorageFiles();
    } catch (error) {
      failures.push(error);
    }
    try {
      await vectorMaintenanceJournalService.remove();
    } catch (error) {
      failures.push(error);
    }
    if (failures.length > 0) {
      throw new AggregateError(failures, "DELETE_ALL_PAYLOAD_CLEANUP_FAILED");
    }
    for (const scope of ["items", "folders", "spaces"] as const) {
      try {
        chrome.runtime.sendMessage({ type: "DB_CHANGE", scope });
      } catch {}
    }
    return { deletedCollections };
  }

  /**
   * Retrieves all items that have not yet been embedded.
   * This is used to process new items that need to be added to the vector store.
   */
  async getItemsToEmbed(
    payload?: { limit?: number }
  ): Promise<(ItemDocType & { expectedRevision: string })[]> {
    const db = await getDb();
    const limit = Math.max(1, Math.min(100, Math.floor(payload?.limit || 100)));
    const itemsToEmbed = await db.items
      .find({ selector: { isEmbedded: false, isMetaFetched: true, deletedAt: { $eq: 0 } }, limit })
      .exec();
    return itemsToEmbed
      .map((item) => ({
        ...(item.toMutableJSON() as ItemDocType),
        expectedRevision: item.revision,
      }))
      .filter(isMetadataReadyForEmbedding);
  }

  /**
   * Repairs records written by older importers that claimed to be embedded
   * despite having no usable vector reference. It is safe to run once because
   * blank records stay skipped instead of entering an endless queue.
   */
  async repairItemsMissingVectors(vectorCount = Number.MAX_SAFE_INTEGER): Promise<number> {
    const db = await getDb();
    let afterId = "";
    let repairedCount = 0;

    while (true) {
      const selector: Record<string, unknown> = {
        deletedAt: { $eq: 0 },
        isEmbedded: { $eq: true },
      };
      if (afterId) selector.id = { $gt: afterId };
      const docs = await db.items
        .find({ selector, sort: [{ id: "asc" }], limit: BULK_ITEM_UPDATE_BATCH_SIZE } as any)
        .exec();
      if (docs.length === 0) break;

      const updates = docs
        .map((doc) => doc.toMutableJSON() as ItemDocType)
        .filter((item) => {
          if (!hasEmbeddableText(item)) return false;
          const indexes = getVectorIndexes(item);
          return indexes.length === 0 || indexes.some((index) => index >= vectorCount);
        })
        .map((item) => ({
          ...item,
          vector_index: -1,
          vector_indexes: [],
          isEmbedded: false,
          isDirty: true,
        }));
      if (updates.length > 0) {
        await db.items.bulkUpsert(updates);
        repairedCount += updates.length;
      }

      afterId = docs[docs.length - 1].primary;
      await yieldToEventLoop();
    }

    return repairedCount;
  }

  /** Build the compaction plan without retaining every item's text/media body. */
  async getActiveVectorInventory(): Promise<ActiveVectorInventoryItem[]> {
    const db = await getDb();
    const inventory: ActiveVectorInventoryItem[] = [];
    let afterId = "";

    while (true) {
      const selector: Record<string, unknown> = { deletedAt: { $eq: 0 } };
      if (afterId) selector.id = { $gt: afterId };
      const docs = await db.items
        .find({ selector, sort: [{ id: "asc" }], limit: BULK_ITEM_UPDATE_BATCH_SIZE } as any)
        .exec();
      if (docs.length === 0) break;

      for (const doc of docs) {
        const vectorIndexes = doc.get("vector_indexes") as number[] | undefined;
        inventory.push({
          id: doc.primary,
          vector_index: doc.get("vector_index") as number | undefined,
          vector_indexes: Array.isArray(vectorIndexes) ? [...vectorIndexes] : [],
          isEmbedded: doc.get("isEmbedded") === true,
          isMetaFetched: doc.get("isMetaFetched") === true,
          isDirty: doc.get("isDirty") === true,
          revision: doc.revision,
        });
      }

      afterId = docs[docs.length - 1].primary;
      await yieldToEventLoop();
    }

    return inventory;
  }

  /** Load only the small dirty batch currently being re-embedded. */
  async getActiveItemsByIds(itemIds: string[]): Promise<ActiveVectorEmbeddingSnapshot[]> {
    const db = await getDb();
    const ids = Array.from(new Set(itemIds.filter(Boolean)));
    const items: ActiveVectorEmbeddingSnapshot[] = [];

    for (let start = 0; start < ids.length; start += BULK_ITEM_UPDATE_BATCH_SIZE) {
      const batchIds = ids.slice(start, start + BULK_ITEM_UPDATE_BATCH_SIZE);
      const docsById = await db.items.findByIds(batchIds).exec();
      for (const itemId of batchIds) {
        const doc = docsById.get(itemId);
        if (!doc || ((doc.get("deletedAt") as number | undefined) || 0) !== 0) continue;
        items.push({
          item: doc.toMutableJSON() as ItemDocType,
          revision: doc.revision,
        });
      }
      if (start + batchIds.length < ids.length) await yieldToEventLoop();
    }

    return items;
  }

  /**
   * Atomically re-check the source revision while committing compacted vector
   * indexes. RxDB retries the modifier with the latest stored document after a
   * conflict, so an edit that lands during this commit is also detected.
   */
  async commitCompactedVectorIndexes(updates: CompactedVectorIndexCommit[]): Promise<void> {
    const db = await getDb();
    const updateMap = new Map<string, CompactedVectorIndexCommit>();
    for (const update of updates) {
      if (!update.id) continue;
      updateMap.set(update.id, update);
    }
    const ids = Array.from(updateMap.keys());

    for (let start = 0; start < ids.length; start += BULK_ITEM_UPDATE_BATCH_SIZE) {
      const batchIds = ids.slice(start, start + BULK_ITEM_UPDATE_BATCH_SIZE);
      const docsMap = await db.items.findByIds(batchIds).exec();
      await Promise.all(
        batchIds.map(async (itemId) => {
          const doc = docsMap.get(itemId);
          const update = updateMap.get(itemId);
          if (!doc || !update) return;
          await db.items.incrementalWriteQueue.addWrite(doc._data, (current) =>
            applyCompactedVectorIndexCommit(current, current._rev, update)
          );
        })
      );
      if (start + batchIds.length < ids.length) await yieldToEventLoop();
    }
  }

  /**
   * Retrieves all active items that have been marked as dirty (i.e., their content has changed).
   * These items need to be re-embedded.
   */
  async getDirtyItems(
    payload?: { limit?: number }
  ): Promise<(ItemDocType & { expectedRevision: string })[]> {
    const db = await getDb();
    const limit = Math.max(1, Math.min(100, Math.floor(payload?.limit || 100)));
    const dirtyItems = await db.items
      .find({ selector: { isDirty: true, isMetaFetched: true, deletedAt: { $eq: 0 } }, limit })
      .exec();
    return dirtyItems
      .map((item) => ({
        ...(item.toMutableJSON() as ItemDocType),
        expectedRevision: item.revision,
      }))
      .filter(isMetadataReadyForEmbedding);
  }

  async getItemsToOcr(payload: {
    limit: number;
    modelVersion: string;
    retryErroredBefore: number;
  }): Promise<ItemDocType[]> {
    const db = await getDb();
    const limit = Math.max(1, Math.min(100, Math.floor(payload.limit || 10)));

    // Select items that still need OCR by status, so a freshly-saved image is
    // found even in a large library. The previous query fetched a fixed slice of
    // items ordered by random UUID and then filtered, which could skip pending
    // items entirely (they simply weren't in the fetched slice).
    const pendingDocs = await db.items
      .find({
        selector: {
          deletedAt: { $eq: 0 },
          ocrStatus: { $in: ["pending", "processing", "error"] },
        },
        limit: limit * 12,
      } as any)
      .exec();
    const result = pendingDocs
      .map((item) => item.toMutableJSON() as ItemDocType)
      .filter((item) => {
        if (item.ocrStatus === "pending" || item.ocrStatus === "processing") return true;
        return item.ocrStatus === "error" && (item.ocrUpdatedAt || 0) < payload.retryErroredBefore;
      })
      .filter((item) => this.itemHasOcrImage(item));

    // Best-effort re-OCR of items captured by an older model version (a rare
    // model upgrade). Bounded scan, deduped against the status-selected set.
    if (result.length < limit) {
      const ids = new Set(result.map((item) => item.id));
      const staleDocs = await db.items
        .find({ selector: { deletedAt: { $eq: 0 } }, limit: limit * 12 } as any)
        .exec();
      for (const doc of staleDocs) {
        if (result.length >= limit) break;
        const item = doc.toMutableJSON() as ItemDocType;
        if (ids.has(item.id) || item.ocrStatus !== "done") continue;
        if (item.ocrModelVersion !== payload.modelVersion && this.itemHasOcrImage(item)) {
          ids.add(item.id);
          result.push(item);
        }
      }
    }

    return result.slice(0, limit);
  }

  async markItemOcrProcessing(payload: {
    id: string;
    modelVersion: string;
    sourceHash: string;
  }): Promise<void> {
    const db = await getDb();
    let lastError: unknown;

    for (let attempt = 0; attempt < 5; attempt += 1) {
      const doc = await db.items.findOne(payload.id).exec();
      if (!doc) return;
      const current = doc.toMutableJSON() as ItemDocType;
      const now = Date.now();
      const nextMedia = this.markMediaOcrProcessing(current.media, payload, now);
      const patchData: Partial<ItemDocType> = {
        ocrStatus: "processing",
        ocrError: "",
        ocrModelVersion: payload.modelVersion,
        ocrSourceHash: payload.sourceHash,
        ocrUpdatedAt: now,
      };
      if (nextMedia) patchData.media = nextMedia;

      try {
        await doc.patch(patchData);
        return;
      } catch (error) {
        if (!isWriteConflict(error)) throw error;
        lastError = error;
      }
    }

    throw lastError;
  }

  async saveItemOcrResult(payload: {
    id: string;
    status: ItemDocType["ocrStatus"];
    modelVersion: string;
    sourceHash: string;
    text?: string;
    confidence?: number | null;
    lineCount?: number;
    error?: string;
    media?: SavedMediaOcrResult[];
  }): Promise<void> {
    const db = await getDb();
    let lastError: unknown;

    for (let attempt = 0; attempt < 5; attempt += 1) {
      const doc = await db.items.findOne(payload.id).exec();
      if (!doc) return;

      const current = doc.toMutableJSON() as ItemDocType;
      const now = Date.now();
      const nextText = normalizeOcrText(payload.text);
      const currentText = normalizeOcrText(current.ocrText);
      const textChanged = payload.status === "done" && nextText !== currentText;
      const nextTextContent =
        payload.status === "done"
          ? appendOcrTextToTextContent(current.textContent, nextText)
          : current.textContent;
      const textContentChanged = nextTextContent !== (current.textContent || "").trim();
      const confidence = this.normalizeOcrConfidence(payload.confidence);
      const lineCount = this.normalizeOcrLineCount(payload.lineCount);
      const nextMedia = this.applyMediaOcrResults(current.media, payload, now);

      const patchData: Partial<ItemDocType> = {
        ocrStatus: payload.status,
        ocrError: payload.error ? payload.error.slice(0, 500) : "",
        ocrModelVersion: payload.modelVersion,
        ocrSourceHash: payload.sourceHash,
        ocrUpdatedAt: now,
        ocrConfidence: confidence,
        ocrLineCount: lineCount,
      };
      if (nextMedia) patchData.media = nextMedia;

      if (payload.status === "done") {
        patchData.ocrText = nextText;
        patchData.textContent = nextTextContent;
      }

      if (textChanged || textContentChanged) {
        patchData.isDirty = true;
        patchData.isEmbedded = false;
        patchData.updatedAt = now;
      }

      try {
        await doc.patch(patchData);
        return;
      } catch (error) {
        if (!isWriteConflict(error)) throw error;
        lastError = error;
      }
    }

    throw lastError;
  }

  async markAllActiveItemsForReembedding(options?: { touchUpdatedAt?: boolean }): Promise<number> {
    const db = await getDb();
    const now = Date.now();
    const touchUpdatedAt = options?.touchUpdatedAt === true;
    let afterId = "";
    let updatedCount = 0;

    while (true) {
      const selector: Record<string, any> = { deletedAt: { $eq: 0 } };
      if (afterId) selector.id = { $gt: afterId };
      const batch = await db.items
        .find({ selector, sort: [{ id: "asc" }], limit: BULK_ITEM_UPDATE_BATCH_SIZE } as any)
        .exec();
      if (batch.length === 0) break;

      await Promise.all(
        batch.map((doc) =>
          db.items.incrementalWriteQueue.addWrite(doc._data, (current) =>
            applyVectorInvalidation(current, { touchUpdatedAt, now })
          )
        )
      );
      updatedCount += batch.length;
      afterId = batch[batch.length - 1].primary;
      await yieldToEventLoop();
    }

    return updatedCount;
  }

  /**
   * Soft-deletes an item by setting its `deletedAt` timestamp.
   * It also creates a "tombstone" record in the `deleted_items` collection,
   * which signals to the sync service that the corresponding vector needs to be removed.
   */
  async deleteItem(payload: { id: string }): Promise<void> {
    const db = await getDb();
    await withEntityMutationLock(db, "item", payload.id, async () => {
      const item = await db.items.findOne(payload.id).exec();
      if (!item) return;
      const now = nextBinMutationTimestamp(
        Date.now(),
        item.get("updatedAt") as number | undefined,
        item.get("deletedAt") as number | undefined
      );
      await item.patch({ deletedAt: now, updatedAt: now });
      if (item.vector_index !== undefined && item.vector_index > -1) {
        await db.deleted_items.upsert({
          id: item.primary,
          vector_index: item.vector_index,
          deletedAt: now,
        });
      }
    });
  }

  /**
   * Purges the tombstone collection after a successful sync.
   */
  async clearDeletedItems(): Promise<void> {
    const db = await getDb();
    const allDeleted = await db.deleted_items.find().exec();
    const ids = allDeleted.map((doc) => doc.primary);
    await db.deleted_items.bulkRemove(ids);
  }

  /**
   * Performs a bulk update/insert operation on the items collection.
   * This is used to efficiently update multiple items at once, for example,
   * when updating vector indexes after an embedding or sync operation.
   */
  async bulkUpdateItems(updates: BulkItemUpdate[]): Promise<void> {
    const db = await getDb();
    const updateMap = new Map<string, BulkItemUpdate>();
    for (const update of updates) {
      if (!update.id) continue;
      updateMap.set(update.id, update);
    }
    const ids = Array.from(updateMap.keys());
    for (let start = 0; start < ids.length; start += BULK_ITEM_UPDATE_BATCH_SIZE) {
      const batchIds = ids.slice(start, start + BULK_ITEM_UPDATE_BATCH_SIZE);
      for (const id of batchIds) {
        const update = updateMap.get(id);
        if (!update) continue;
        await withEntityMutationLock(db, "item", id, async () => {
          const doc = await db.items.findOne(id).exec();
          if (!doc) return;
          if (!isEmbeddingStateCommitCurrent(
            {
              deletedAt: (doc.get("deletedAt") as number | undefined) || 0,
              updatedAt: (doc.get("updatedAt") as number | undefined) || 0,
            },
            doc.revision,
            update
          )) return;

          const {
            id: _id,
            deletedAt: _deletedAt,
            expectedRevision: _expectedRevision,
            expectedUpdatedAt: _expectedUpdatedAt,
            ...patch
          } = update;
          if (patch.userId !== undefined) {
            patch.userId = this.normalizeUserId(patch.userId);
          }
          if (Object.keys(patch).length === 0) return;
          await doc.incrementalPatch(patch);
        });
      }
      if (start + batchIds.length < ids.length) await yieldToEventLoop();
    }
  }

  /**
   * Marks an item as dirty, signaling that its content has changed and
   * it needs to be re-embedded during the next sync cycle.
   */
  async markItemAsDirty(payload: { id: string }): Promise<void> {
    const db = await getDb();
    const item = await db.items.findOne(payload.id).exec();
    if (item) {
      await item.patch({ isDirty: true });
    }
  }

  /**
   * Inserts a batch of new items into the database.
   */
  async addItems(payload: { items: ItemDocType[] }): Promise<void> {
    const db = await getDb();
    if (payload.items.length > 0) {
      const folderIds = Array.from(new Set(payload.items.map((item) => item.folderId).filter(Boolean)));
      const folderDocs =
        folderIds.length > 0
          ? await db.folders.find({ selector: { id: { $in: folderIds } } }).exec()
          : [];
      const folderSpaceById = new Map<string, string>();
      for (const folder of folderDocs) {
        folderSpaceById.set(folder.get("id") as string, (folder.get("spaceId") as string) || PUBLIC_SPACE_ID);
      }
      if (folderSpaceById.size !== folderIds.length) {
        throw new Error("DESTINATION_FOLDER_NOT_FOUND");
      }

      await withSpaceMutationLocks(db, folderSpaceById.values(), async () => {
        for (const [folderId, spaceId] of folderSpaceById) {
          await requireLiveFolderDestination(db, folderId, spaceId);
        }
        const normalized = payload.items.map((item) => {
          const spaceId = folderSpaceById.get(item.folderId);
          if (!spaceId) throw new Error("DESTINATION_FOLDER_NOT_FOUND");
          return {
            ...item,
            userId: this.normalizeUserId(item.userId),
            spaceId,
          };
        });
        const result = await db.items.bulkInsert(normalized);
        if (result.error.length > 0) {
          console.error("DB: Failed to insert items:", result.error);
          throw new Error(`Failed to insert ${result.error.length} items.`);
        }
        try {
          chrome.runtime.sendMessage({ type: "DB_CHANGE", scope: "items" });
        } catch {}
      });
    }
  }

  async addItemToFolder(payload: {
    item: Omit<
      ItemDocType,
      "id" | "createdAt" | "updatedAt" | "vector_index" | "deletedAt" | "spaceId"
    > & {
      id?: string;
      spaceId?: string;
    };
  }): Promise<ItemDocType> {
    const db = await getDb();
    return withLiveFolderDestination(db, payload.item.folderId, async ({ spaceId }) => {
      const now = Date.now();
      const isMetaFetched = isMetadataFetchableUrl(payload.item.url)
        ? payload.item.isMetaFetched ?? false
        : true;
      const item: ItemDocType = {
        id: payload.item.id ?? crypto.randomUUID?.() ?? `${now}`,
        userId: this.normalizeUserId(payload.item.userId),
        title: payload.item.title ?? "Untitled",
        textContent: payload.item.textContent ?? "",
        url: payload.item.url,
        source: payload.item.source,
        folderId: payload.item.folderId,
        spaceId,
        isFavorite: payload.item.isFavorite ?? false,
        authorUsername: payload.item.authorUsername,
        likes: payload.item.likes,
        upvotes: payload.item.upvotes,
        media: payload.item.media,
        iconUrl: (payload.item as any).iconUrl,
        displayImageUrl: (payload.item as any).displayImageUrl,
        ocrText: payload.item.ocrText,
        ocrError: payload.item.ocrError,
        parentId: payload.item.parentId ?? null,
        chunkOrder: payload.item.chunkOrder,
        vector_index: -1,
        vector_indexes: [],
        ocrStatus: payload.item.ocrStatus ?? "pending",
        ocrModelVersion: payload.item.ocrModelVersion ?? "",
        ocrSourceHash: payload.item.ocrSourceHash,
        ocrUpdatedAt: payload.item.ocrUpdatedAt ?? 0,
        ocrConfidence: payload.item.ocrConfidence,
        ocrLineCount: payload.item.ocrLineCount,
        isEmbedded: false,
        isMetaFetched,
        isDirty: payload.item.isDirty ?? true,
        serverVersion: 0,
        createdAt: now,
        updatedAt: now,
        deletedAt: 0,
      };
      await db.items.insert(item);
      try {
        chrome.runtime.sendMessage({ type: "DB_CHANGE", scope: "items" });
      } catch {}
      return item;
    });
  }

  /**
   * Creates a new folder and returns it.
   */
  async createFolder(payload: {
    id: string;
    name: string;
    userId?: string | null;
    parentId?: string | null;
    type?: FolderDocType["type"];
    isLocked?: boolean;
    isPinned?: boolean;
    spaceId?: string;
  }): Promise<FolderDocType> {
    const db = await getDb();
    const requestedSpaceId = (payload.spaceId || PUBLIC_SPACE_ID).trim() || PUBLIC_SPACE_ID;
    return withLiveSpaceDestination(db, requestedSpaceId, async (_spaceDoc, spaceId) => {
      if (payload.parentId) {
        await requireLiveFolderDestination(db, payload.parentId, spaceId);
      }
      const now = Date.now();
      const folder: FolderDocType = {
        id: payload.id,
        name: payload.name,
        userId: this.normalizeUserId(payload.userId),
        spaceId,
        parentId: payload.parentId ?? null,
        type: payload.type ?? "folder",
        sortOrder: now,
        isLocked: payload.isLocked ?? false,
        isPinned: payload.isPinned ?? false,
        isCollapsed: false,
        deletedAt: 0,
        purgeAt: 0,
        isDirty: false,
        serverVersion: 0,
        createdAt: now,
        updatedAt: now,
      };

      await db.folders.insert(folder);
      try {
        chrome.runtime.sendMessage({ type: "DB_CHANGE", scope: "folders" });
      } catch {}
      return folder;
    });
  }

  async toggleFolderPinned(payload: { id: string; value?: boolean }): Promise<void> {
    const db = await getDb();
    const doc = await db.folders.findOne(payload.id).exec();
    if (!doc) return;
    const current = doc.toMutableJSON();
    const nextPinned = payload.value ?? !current.isPinned;
    await doc.patch({ isPinned: nextPinned, updatedAt: Date.now() });
    try {
      chrome.runtime.sendMessage({ type: "DB_CHANGE", scope: "folders" });
    } catch {}
  }

  async toggleFolderLocked(payload: { id: string; value?: boolean }): Promise<void> {
    const db = await getDb();
    const doc = await db.folders.findOne(payload.id).exec();
    if (!doc) return;
    const current = doc.toMutableJSON();
    const nextLocked = payload.value ?? !current.isLocked;
    await doc.patch({ isLocked: nextLocked, updatedAt: Date.now() });
    try {
      chrome.runtime.sendMessage({ type: "DB_CHANGE", scope: "folders" });
    } catch {}
  }

  async updateFolderName(payload: { id: string; name: string }): Promise<void> {
    const db = await getDb();
    const doc = await db.folders.findOne(payload.id).exec();
    if (!doc) return;
    const safeName = (payload.name || "").slice(0, 80);
    await doc.patch({ name: safeName, updatedAt: Date.now() });
    try {
      chrome.runtime.sendMessage({ type: "DB_CHANGE", scope: "folders" });
    } catch {}
  }

  async repairItemSpaceIdsFromFolders(): Promise<number> {
    const db = await getDb();
    const [folders, items] = await Promise.all([db.folders.find().exec(), db.items.find().exec()]);
    if (items.length === 0) return 0;

    const folderSpaceById = new Map<string, string>();
    for (const folder of folders) {
      const json = folder.toMutableJSON() as FolderDocType;
      folderSpaceById.set(json.id, json.spaceId || PUBLIC_SPACE_ID);
    }

    const updates: ItemDocType[] = [];
    for (const itemDoc of items) {
      const item = itemDoc.toMutableJSON() as ItemDocType;
      const nextSpaceId = folderSpaceById.get(item.folderId) || item.spaceId || PUBLIC_SPACE_ID;
      if (item.spaceId !== nextSpaceId) {
        updates.push({
          ...item,
          userId: this.normalizeUserId(item.userId),
          spaceId: nextSpaceId,
          updatedAt: Date.now(),
        });
      }
    }

    if (updates.length > 0) {
      await db.items.bulkUpsert(updates);
      try {
        chrome.runtime.sendMessage({ type: "DB_CHANGE", scope: "items" });
      } catch {}
    }

    return updates.length;
  }
}

export const databaseManager = new DatabaseManager();
