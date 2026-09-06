import {
  copyJsonObject,
  jsonBoolean,
  jsonString,
  parseJsonObject,
  type JsonObject,
  type JsonValue,
} from "@src/common/json-value";
import type { ArchiveCache } from "@src/services/archive-cache";
import { getArchiveCache } from "@src/services/archive-cache";
import {
  createChromeArchiveOutboxStorage,
  createOpfsArchiveOutboxFiles,
  normalizeArchiveOutbox,
  type ArchiveOutboxJob,
} from "@src/services/archive-outbox";
import { getDb } from "@src/services/DatabaseService";
import {
  withBinMutationLock,
  withStableAffectedSpaceLocks,
} from "@src/services/entity-mutation-lock";
import {
  collectMetadataPendingUrls,
  currentMigrationSpaceIds,
  getReferencedOpfsPaths,
  incomingMigrationSpaceIds,
  normalizeMigrationReferences,
  privateSpaceCredentialFields,
  queueMetadataForRestoredItems,
  redactMigrationCredentials,
} from "@src/services/local-extension-migration/collections";
import {
  encodedBase64Length,
  fromBase64Parts,
  LOCAL_MIGRATION_MAX_ARCHIVE_FILE_BYTES,
  LOCAL_MIGRATION_MAX_ARCHIVE_TOTAL_BYTES,
  LOCAL_MIGRATION_MAX_BINARY_FILES,
  LOCAL_MIGRATION_MAX_DECODED_BYTES,
  LOCAL_MIGRATION_MAX_JSON_BYTES,
  LOCAL_MIGRATION_MAX_MEDIA_FILE_BYTES,
  parseOpfsPath,
  serializedUtf8ByteLength,
  toBase64,
} from "@src/services/local-extension-migration/binary";
import {
  createEmptyMigrationCollections,
  LOCAL_MIGRATION_FORMAT,
  LOCAL_MIGRATION_VERSION,
  summarizeMigration,
  type LocalExtensionMigrationBundle,
  type LocalExtensionMigrationSummary,
  type MigratedArchiveFile,
  type MigratedOpfsFile,
  type MigrationCollectionName,
  type MigrationCollections,
  type RestoreLocalExtensionMigrationResult,
} from "@src/services/local-extension-migration/model";
import { validateLocalExtensionMigrationBundle } from "@src/services/local-extension-migration/validation";
import {
  readOpfsFile,
  saveMediaToOpfs,
  withOpfsMutationLock,
} from "@src/services/media-storage";
import { forEachIdKeysetPage } from "@src/services/rxdb-keyset-pagination";
import { isMetadataFetchableUrl } from "@src/utils/metadata-url";
import type { RxCollection } from "rxdb";

export {
  collectMetadataPendingUrls,
  LOCAL_MIGRATION_MAX_ARCHIVE_FILE_BYTES,
  LOCAL_MIGRATION_MAX_ARCHIVE_TOTAL_BYTES,
  LOCAL_MIGRATION_MAX_DECODED_BYTES,
  LOCAL_MIGRATION_MAX_JSON_BYTES,
  LOCAL_MIGRATION_MAX_MEDIA_FILE_BYTES,
  validateLocalExtensionMigrationBundle,
};
export type {
  LocalExtensionMigrationBundle,
  LocalExtensionMigrationSummary,
  RestoreLocalExtensionMigrationResult,
} from "@src/services/local-extension-migration/model";

const RESTORE_BATCH_SIZE = 400;
const MIGRATION_EXPORT_PAGE_SIZE = 400;
const MIGRATION_JSON_STRUCTURAL_RESERVE_BYTES = 64 * 1024;

type MigrationArchiveCache = Pick<ArchiveCache, "listFiles" | "put"> & {
  list?: ArchiveCache["list"];
  putWithinMutationLock?: ArchiveCache["putWithinMutationLock"];
};

type MigrationArchiveOutboxJob = Pick<
  ArchiveOutboxJob,
  "itemId" | "mode" | "fileName" | "byteSize" | "updatedAt"
>;

type MigrationArchiveOutbox = {
  list(): Promise<MigrationArchiveOutboxJob[]>;
  read(fileName: string): Promise<File | Blob | null>;
};

export type MigrationOptions = {
  getDb?: typeof getDb;
  readOpfsFile?: typeof readOpfsFile;
  saveMediaToOpfs?: typeof saveMediaToOpfs;
  withOpfsMutationLock?: typeof withOpfsMutationLock;
  archiveCache?: MigrationArchiveCache;
  archiveOutbox?: MigrationArchiveOutbox;
  /** Test/diagnostic override; production is capped by the public limit. */
  maxEstimatedJsonBytes?: number;
  pageSize?: number;
};

type ReserveJsonBytes = (byteSize: number) => void;

const yieldToEventLoop = (): Promise<void> =>
  new Promise((resolve) => window.setTimeout(resolve, 0));

async function appendCollectionRows(
  collectionName: MigrationCollectionName,
  collection: RxCollection<any>,
  destination: JsonObject[],
  pageSize: number,
  reserveJsonBytes: ReserveJsonBytes,
): Promise<void> {
  await forEachIdKeysetPage({
    collection,
    selector: {},
    pageSize,
    onPage: (documents) => {
      for (const document of documents) {
        const row = parseJsonObject(document.toMutableJSON());
        reserveJsonBytes(serializedUtf8ByteLength(row) + 1);
        destination.push(row);
      }
    },
  });
}

async function readMigrationCollections(
  db: Awaited<ReturnType<typeof getDb>>,
  pageSize: number,
  reserveJsonBytes: ReserveJsonBytes,
): Promise<MigrationCollections> {
  const collections = createEmptyMigrationCollections();
  await appendCollectionRows(
    "space_groups",
    db.space_groups,
    collections.space_groups,
    pageSize,
    reserveJsonBytes,
  );
  await appendCollectionRows(
    "spaces",
    db.spaces,
    collections.spaces,
    pageSize,
    reserveJsonBytes,
  );
  await appendCollectionRows(
    "folders",
    db.folders,
    collections.folders,
    pageSize,
    reserveJsonBytes,
  );
  await appendCollectionRows(
    "items",
    db.items,
    collections.items,
    pageSize,
    reserveJsonBytes,
  );
  await appendCollectionRows(
    "tags",
    db.tags,
    collections.tags,
    pageSize,
    reserveJsonBytes,
  );
  await appendCollectionRows(
    "item_tags",
    db.item_tags,
    collections.item_tags,
    pageSize,
    reserveJsonBytes,
  );
  await appendCollectionRows(
    "search_history",
    db.search_history,
    collections.search_history,
    pageSize,
    reserveJsonBytes,
  );
  await appendCollectionRows(
    "flashcards",
    db.flashcards,
    collections.flashcards,
    pageSize,
    reserveJsonBytes,
  );
  await appendCollectionRows(
    "deleted_items",
    db.deleted_items,
    collections.deleted_items,
    pageSize,
    reserveJsonBytes,
  );
  return collections;
}

type MigrationCollectionWriter = RxCollection<any>;

async function bulkUpsertInBatches(
  collectionName: MigrationCollectionName,
  collection: MigrationCollectionWriter,
  rows: JsonObject[],
): Promise<void> {
  for (let start = 0; start < rows.length; start += RESTORE_BATCH_SIZE) {
    const batch = rows.slice(start, start + RESTORE_BATCH_SIZE);
    const result = await collection.bulkUpsert(batch);
    if (result.error.length > 0) {
      throw new AggregateError(
        result.error,
        `MIGRATION_RESTORE_WRITE_FAILED:${collectionName}:${result.error.length}`,
      );
    }
    if (result.success.length !== batch.length) {
      throw new Error(
        `MIGRATION_RESTORE_WRITE_INCOMPLETE:${collectionName}:${result.success.length}/${batch.length}`,
      );
    }
    await yieldToEventLoop();
  }
}

async function restoreCollections(
  db: Awaited<ReturnType<typeof getDb>>,
  collections: MigrationCollections,
): Promise<void> {
  await bulkUpsertInBatches("space_groups", db.space_groups, collections.space_groups);
  await bulkUpsertInBatches("spaces", db.spaces, collections.spaces);
  await bulkUpsertInBatches("folders", db.folders, collections.folders);
  await bulkUpsertInBatches("items", db.items, collections.items);
  await bulkUpsertInBatches("tags", db.tags, collections.tags);
  await bulkUpsertInBatches("item_tags", db.item_tags, collections.item_tags);
  await bulkUpsertInBatches(
    "search_history",
    db.search_history,
    collections.search_history,
  );
  await bulkUpsertInBatches("flashcards", db.flashcards, collections.flashcards);
  await bulkUpsertInBatches(
    "deleted_items",
    db.deleted_items,
    collections.deleted_items,
  );
}

export const summarizeLocalExtensionMigrationBundle = (
  bundle: LocalExtensionMigrationBundle,
): LocalExtensionMigrationSummary =>
  summarizeMigration(
    bundle.collections,
    bundle.opfsFiles.length,
    bundle.archiveFiles.length,
    bundle.warnings.length,
  );

type ArchiveCandidate = {
  itemId: string;
  mimeType: string;
  updatedAt: number;
  file: Blob;
};

function defaultArchiveOutbox(): MigrationArchiveOutbox {
  const canReadOutbox = Boolean(globalThis.chrome?.storage?.local);
  const files = canReadOutbox ? createOpfsArchiveOutboxFiles() : null;
  if (!files) {
    return {
      list: async () => [],
      read: async () => null,
    };
  }
  return {
    list: async () =>
      normalizeArchiveOutbox(await createChromeArchiveOutboxStorage().read()),
    read: (fileName) => files.read(fileName),
  };
}

async function collectArchiveCandidates(
  itemIds: ReadonlySet<string>,
  archiveCache: MigrationArchiveCache,
  archiveOutbox: MigrationArchiveOutbox,
  withMediaLock: typeof withOpfsMutationLock,
  warnings: string[],
): Promise<Map<string, ArchiveCandidate>> {
  const candidates = new Map<string, ArchiveCandidate>();
  // Retention can move a file between cache and outbox under this lock.
  await withMediaLock(async () => {
    let cachedArchives: Awaited<
      ReturnType<MigrationArchiveCache["listFiles"]>
    > = [];
    try {
      cachedArchives = await archiveCache.listFiles();
      if (archiveCache.list) {
        const indexed = await archiveCache.list();
        const verifiedNames = new Set(
          cachedArchives.map(({ entry }) => entry.fileName),
        );
        for (const entry of indexed) {
          if (
            itemIds.has(entry.itemId) &&
            !verifiedNames.has(entry.fileName)
          ) {
            warnings.push(
              `Offline archive cache file is missing or corrupt for item ${entry.itemId}.`,
            );
          }
        }
      }
    } catch (cause) {
      const message =
        cause instanceof Error ? cause.message : "unknown error";
      throw new Error(
        `MIGRATION_BACKUP_ARCHIVE_CACHE_READ_FAILED:${message}`,
        { cause },
      );
    }
    for (const { entry, file } of cachedArchives) {
      if (!itemIds.has(entry.itemId)) continue;
      candidates.set(entry.itemId, {
        itemId: entry.itemId,
        mimeType: file.type || entry.mimeType || "text/html",
        updatedAt: entry.updatedAt,
        file,
      });
    }

    try {
      for (const job of await archiveOutbox.list()) {
        if (
          job.mode !== "upload" ||
          !job.fileName ||
          !itemIds.has(job.itemId)
        ) {
          continue;
        }
        const existing = candidates.get(job.itemId);
        if (existing && existing.updatedAt > job.updatedAt) continue;
        const file = await archiveOutbox.read(job.fileName);
        if (!file || file.size !== job.byteSize || file.size <= 0) {
          warnings.push(
            `Pending offline archive file is missing or corrupt for item ${job.itemId}.`,
          );
          continue;
        }
        candidates.set(job.itemId, {
          itemId: job.itemId,
          mimeType: file.type || "text/html",
          updatedAt: job.updatedAt,
          file,
        });
      }
    } catch (cause) {
      const message =
        cause instanceof Error ? cause.message : "unknown error";
      throw new Error(
        `MIGRATION_BACKUP_ARCHIVE_OUTBOX_READ_FAILED:${message}`,
        { cause },
      );
    }
  });
  return candidates;
}

export const buildLocalExtensionMigrationBundle = async (
  options: MigrationOptions = {},
): Promise<LocalExtensionMigrationBundle> => {
  const db = await (options.getDb ?? getDb)();
  const readMediaFile = options.readOpfsFile ?? readOpfsFile;
  const withMediaLock =
    options.withOpfsMutationLock ?? withOpfsMutationLock;
  const warnings: string[] = [];
  const maxEstimatedJsonBytes = Math.max(
    1_024,
    Math.min(
      LOCAL_MIGRATION_MAX_JSON_BYTES,
      Math.floor(
        options.maxEstimatedJsonBytes ?? LOCAL_MIGRATION_MAX_JSON_BYTES,
      ),
    ),
  );
  const pageSize = Math.max(
    1,
    Math.min(
      1_000,
      Math.floor(options.pageSize ?? MIGRATION_EXPORT_PAGE_SIZE),
    ),
  );
  let estimatedJsonBytes = Math.min(
    MIGRATION_JSON_STRUCTURAL_RESERVE_BYTES,
    Math.floor(maxEstimatedJsonBytes / 4),
  );
  const reserveJsonBytes = (byteSize: number): void => {
    if (!Number.isSafeInteger(byteSize) || byteSize < 0) {
      throw new Error("MIGRATION_FILE_JSON_TOO_LARGE");
    }
    estimatedJsonBytes += byteSize;
    if (estimatedJsonBytes > maxEstimatedJsonBytes) {
      throw new Error("MIGRATION_FILE_JSON_TOO_LARGE");
    }
  };

  const rawCollections = await readMigrationCollections(
    db,
    pageSize,
    reserveJsonBytes,
  );
  const collections = redactMigrationCredentials(rawCollections, warnings);
  const opfsFiles: MigratedOpfsFile[] = [];
  let decodedBinaryBytes = 0;
  const referencedOpfsPaths = getReferencedOpfsPaths(collections.items);
  if (referencedOpfsPaths.length > LOCAL_MIGRATION_MAX_BINARY_FILES) {
    throw new Error("MIGRATION_BACKUP_TOO_MANY_BINARY_FILES");
  }
  for (const opfsPath of referencedOpfsPaths) {
    const file = await readMediaFile(opfsPath);
    if (!file) {
      throw new Error(`MIGRATION_BACKUP_REFERENCED_MEDIA_MISSING:${opfsPath}`);
    }
    if (file.size > LOCAL_MIGRATION_MAX_MEDIA_FILE_BYTES) {
      throw new Error(`MIGRATION_BACKUP_MEDIA_TOO_LARGE:${opfsPath}`);
    }
    decodedBinaryBytes += file.size;
    if (decodedBinaryBytes > LOCAL_MIGRATION_MAX_DECODED_BYTES) {
      throw new Error("MIGRATION_BACKUP_BINARY_DATA_TOO_LARGE");
    }
    reserveJsonBytes(
      encodedBase64Length(file.size) +
        serializedUtf8ByteLength(opfsPath) +
        serializedUtf8ByteLength(file.type || "application/octet-stream") +
        96,
    );
    opfsFiles.push({
      opfsPath,
      mimeType: file.type || "application/octet-stream",
      base64: toBase64(await file.arrayBuffer()),
    });
  }

  const itemIds = new Set(
    collections.items
      .map((item) => jsonString(item.id) ?? "")
      .filter(Boolean),
  );
  const archiveCache = options.archiveCache ?? getArchiveCache();
  const archiveCandidates = await collectArchiveCandidates(
    itemIds,
    archiveCache,
    options.archiveOutbox ?? defaultArchiveOutbox(),
    withMediaLock,
    warnings,
  );
  if (
    opfsFiles.length + archiveCandidates.size >
    LOCAL_MIGRATION_MAX_BINARY_FILES
  ) {
    throw new Error("MIGRATION_BACKUP_TOO_MANY_BINARY_FILES");
  }

  const archiveFiles: MigratedArchiveFile[] = [];
  let archiveBytes = 0;
  for (const candidate of archiveCandidates.values()) {
    const { itemId, mimeType, updatedAt, file } = candidate;
    if (
      file.size <= 0 ||
      file.size > LOCAL_MIGRATION_MAX_ARCHIVE_FILE_BYTES
    ) {
      throw new Error(`MIGRATION_BACKUP_ARCHIVE_SIZE_INVALID:${itemId}`);
    }
    archiveBytes += file.size;
    if (archiveBytes > LOCAL_MIGRATION_MAX_ARCHIVE_TOTAL_BYTES) {
      throw new Error("MIGRATION_BACKUP_ARCHIVES_TOO_LARGE");
    }
    decodedBinaryBytes += file.size;
    if (decodedBinaryBytes > LOCAL_MIGRATION_MAX_DECODED_BYTES) {
      throw new Error("MIGRATION_BACKUP_BINARY_DATA_TOO_LARGE");
    }
    reserveJsonBytes(
      encodedBase64Length(file.size) +
        serializedUtf8ByteLength(itemId) +
        serializedUtf8ByteLength(mimeType) +
        112,
    );
    archiveFiles.push({
      itemId,
      mimeType,
      updatedAt,
      base64: toBase64(await file.arrayBuffer()),
    });
    if (archiveFiles.length % 10 === 0) await yieldToEventLoop();
  }

  return {
    format: LOCAL_MIGRATION_FORMAT,
    version: LOCAL_MIGRATION_VERSION,
    createdAt: Date.now(),
    collections,
    opfsFiles,
    archiveFiles,
    warnings,
  };
};

export const restoreLocalExtensionMigrationBundle = async (
  value: JsonValue,
  options: MigrationOptions = {},
): Promise<RestoreLocalExtensionMigrationResult> => {
  const bundle = validateLocalExtensionMigrationBundle(value);
  const db = await (options.getDb ?? getDb)();
  const withMediaLock =
    options.withOpfsMutationLock ?? withOpfsMutationLock;
  const incomingSpaceIds = incomingMigrationSpaceIds(bundle.collections);
  return withBinMutationLock(db, () =>
    withStableAffectedSpaceLocks(
      db,
      incomingSpaceIds,
      () => currentMigrationSpaceIds(bundle.collections, db),
      () =>
        withMediaLock(() =>
          restoreLocalExtensionMigrationBundleLocked(
            bundle,
            db,
            options.archiveCache ?? getArchiveCache(),
            options,
          ),
        ),
    ),
  );
};

async function restoreLocalExtensionMigrationBundleLocked(
  bundle: LocalExtensionMigrationBundle,
  db: Awaited<ReturnType<typeof getDb>>,
  archiveCache: MigrationArchiveCache,
  options: MigrationOptions,
): Promise<RestoreLocalExtensionMigrationResult> {
  const saveMediaFile = options.saveMediaToOpfs ?? saveMediaToOpfs;
  const existingSpaceDocs = await db.spaces.find().exec();
  const existingSpaces = new Map(
    existingSpaceDocs.map((document) => [
      document.primary,
      parseJsonObject(document.toMutableJSON()),
    ]),
  );
  const existingFolderDocs = await db.folders.find().exec();
  const existingFolders = new Map(
    existingFolderDocs.map((document) => [
      document.primary,
      parseJsonObject(document.toMutableJSON()),
    ]),
  );
  const normalized = normalizeMigrationReferences(
    bundle.collections,
    new Set(existingSpaces.keys()),
  );

  // Portable JSON contains no secrets. A same-profile merge must not let those
  // redacted rows downgrade existing private or locked records.
  const migrationSpaces = normalized.collections.spaces.map((source) => {
    const sourceId = jsonString(source.id);
    const existing = sourceId ? existingSpaces.get(sourceId) : undefined;
    if (jsonBoolean(existing?.isPrivate) !== true) return source;
    const next = copyJsonObject(source);
    next.isPrivate = true;
    for (const field of privateSpaceCredentialFields) {
      const credential = existing?.[field];
      if (credential !== undefined) next[field] = credential;
    }
    return next;
  });
  const migrationFolders = normalized.collections.folders.map((source) => {
    const sourceId = jsonString(source.id);
    const existing = sourceId ? existingFolders.get(sourceId) : undefined;
    const encryptionKey = jsonString(existing?.encryptionKey);
    if (jsonBoolean(existing?.isLocked) !== true && !encryptionKey) {
      return source;
    }
    const next = copyJsonObject(source);
    next.isLocked = jsonBoolean(existing?.isLocked) === true;
    if (encryptionKey) next.encryptionKey = encryptionKey;
    return next;
  });

  // Vector offsets belong to one OPFS origin, so restored items re-enter the
  // destination embedding queue.
  const migratedItems = normalized.collections.items.map((item) => {
    const url = jsonString(item.url) ?? "";
    const next = copyJsonObject(item);
    next.vector_index = -1;
    next.vector_indexes = [];
    next.isEmbedded = false;
    next.isDirty = false;
    next.isMetaFetched = isMetadataFetchableUrl(url)
      ? jsonBoolean(item.isMetaFetched) === true
      : true;
    return next;
  });
  const collections: MigrationCollections = {
    ...normalized.collections,
    spaces: migrationSpaces,
    folders: migrationFolders,
    items: migratedItems,
    deleted_items: [],
  };
  await restoreCollections(db, collections);

  let restoredOpfsFileCount = 0;
  for (const file of bundle.opfsFiles) {
    const parsed = parseOpfsPath(file.opfsPath);
    if (!parsed) continue;
    const bytes = fromBase64Parts(file.base64);
    await saveMediaFile(
      parsed.itemId,
      new File(bytes, parsed.fileName, { type: file.mimeType }),
      parsed.fileName,
    );
    restoredOpfsFileCount += 1;
    if (restoredOpfsFileCount % 10 === 0) await yieldToEventLoop();
  }

  let restoredArchiveFileCount = 0;
  const restoredItemIds = new Set(
    migratedItems
      .map((item) => jsonString(item.id) ?? "")
      .filter(Boolean),
  );
  const putArchive = archiveCache.putWithinMutationLock
    ? archiveCache.putWithinMutationLock.bind(archiveCache)
    : archiveCache.put.bind(archiveCache);
  for (const file of bundle.archiveFiles) {
    if (!restoredItemIds.has(file.itemId)) continue;
    const bytes = fromBase64Parts(file.base64);
    await putArchive(
      file.itemId,
      new Blob(bytes, { type: file.mimeType || "text/html" }),
      file.updatedAt,
    );
    restoredArchiveFileCount += 1;
    if (restoredArchiveFileCount % 10 === 0) await yieldToEventLoop();
  }

  const metadataPendingUrls = collectMetadataPendingUrls(migratedItems);
  queueMetadataForRestoredItems(metadataPendingUrls);

  return {
    ...summarizeMigration(
      collections,
      bundle.opfsFiles.length,
      bundle.archiveFiles.length,
      bundle.warnings.length + normalized.warningCount,
    ),
    restoredOpfsFileCount,
    restoredArchiveFileCount,
    scheduledReembeddingItemCount: migratedItems.length,
    metadataPendingUrlCount: metadataPendingUrls.length,
  };
}
