import { getDb } from "@src/services/DatabaseService";
import type { ItemDocType } from "@src/schemas/item_schema";
import { UNGROUPED_SPACE_GROUP_ID } from "@src/schemas/space_schema";
import { PUBLIC_SPACE_ID } from "@src/common/spaces";
import {
  readOpfsFile,
  saveMediaToOpfs,
  withOpfsMutationLock,
} from "@src/services/media-storage";
import { isMetadataFetchableUrl } from "@src/utils/metadata-url";
import {
  withBinMutationLock,
  withStableAffectedSpaceLocks,
} from "@src/services/entity-mutation-lock";
import { getArchiveCache, type ArchiveCache } from "@src/services/archive-cache";
import {
  createChromeArchiveOutboxStorage,
  createOpfsArchiveOutboxFiles,
  normalizeArchiveOutbox,
  type ArchiveOutboxJob,
} from "@src/services/archive-outbox";
import { forEachIdKeysetPage } from "@src/services/rxdb-keyset-pagination";

const MIGRATION_FORMAT = "vibesearch-local-extension-migration";
const MIGRATION_VERSION = 2;
const SUPPORTED_MIGRATION_VERSIONS = new Set([1, MIGRATION_VERSION]);
const RESTORE_BATCH_SIZE = 400;
// Import currently has to materialize JSON once for validation. Keep the hard
// ceiling well below browser renderer/OOM territory until the format has a
// streaming parser; oversized libraries fail explicitly instead of exhausting
// every tab's RAM.
export const LOCAL_MIGRATION_MAX_JSON_BYTES = 96 * 1024 * 1024;
export const LOCAL_MIGRATION_MAX_DECODED_BYTES = 56 * 1024 * 1024;
export const LOCAL_MIGRATION_MAX_MEDIA_FILE_BYTES = 32 * 1024 * 1024;
export const LOCAL_MIGRATION_MAX_ARCHIVE_FILE_BYTES = 28 * 1024 * 1024;
export const LOCAL_MIGRATION_MAX_ARCHIVE_TOTAL_BYTES = 56 * 1024 * 1024;
const LOCAL_MIGRATION_MAX_BINARY_FILES = 50_000;
const MIGRATION_EXPORT_PAGE_SIZE = 400;
const MIGRATION_JSON_STRUCTURAL_RESERVE_BYTES = 64 * 1024;
const utf8Encoder = new TextEncoder();

const COLLECTION_NAMES = [
  // space_groups first: spaces reference a spaceGroupId, and exporting the groups
  // keeps named collections like "Browser Bookmarks" and "GitHub Stars" intact
  // across an export → restore round-trip (previously they were dropped).
  "space_groups",
  "spaces",
  "folders",
  "items",
  "tags",
  "item_tags",
  "search_history",
  "flashcards",
  "deleted_items",
] as const;

type MigrationCollectionName = (typeof COLLECTION_NAMES)[number];
type MigrationCollections = Record<MigrationCollectionName, Record<string, unknown>[]>;

type MigratedOpfsFile = {
  opfsPath: string;
  mimeType: string;
  base64: string;
};

type MigratedArchiveFile = {
  itemId: string;
  mimeType: string;
  updatedAt: number;
  base64: string;
};

type MigrationArchiveCache = Pick<ArchiveCache, "listFiles" | "put"> & {
  list?: ArchiveCache["list"];
  putWithinMutationLock?: ArchiveCache["putWithinMutationLock"];
};

type MigrationArchiveOutbox = {
  list(): Promise<ArchiveOutboxJob[]>;
  read(fileName: string): Promise<File | Blob | null>;
};

type MigrationOptions = {
  archiveCache?: MigrationArchiveCache;
  archiveOutbox?: MigrationArchiveOutbox;
  /** Test/diagnostic override; production is always capped by the public limit. */
  maxEstimatedJsonBytes?: number;
  pageSize?: number;
};

export type LocalExtensionMigrationBundle = {
  format: typeof MIGRATION_FORMAT;
  version: 1 | typeof MIGRATION_VERSION;
  createdAt: number;
  collections: MigrationCollections;
  opfsFiles: MigratedOpfsFile[];
  archiveFiles: MigratedArchiveFile[];
  warnings: string[];
};

export type LocalExtensionMigrationSummary = {
  collections: Record<MigrationCollectionName, number>;
  opfsFileCount: number;
  archiveFileCount: number;
  warningCount: number;
};

export type RestoreLocalExtensionMigrationResult = LocalExtensionMigrationSummary & {
  restoredOpfsFileCount: number;
  restoredArchiveFileCount: number;
  scheduledReembeddingItemCount: number;
  metadataPendingUrlCount: number;
};

const toBase64 = (buffer: ArrayBuffer): string => {
  const bytes = new Uint8Array(buffer);
  // 0x6000 is divisible by three, so independently encoded chunks can be
  // concatenated without introducing padding in the middle of the payload.
  const chunkSize = 0x6000;
  const encoded: string[] = [];
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    const binary = String.fromCharCode(...bytes.subarray(offset, offset + chunkSize));
    encoded.push(btoa(binary));
  }
  return encoded.join("");
};

const serializedUtf8ByteLength = (value: unknown): number =>
  utf8Encoder.encode(JSON.stringify(value)).byteLength;

const encodedBase64Length = (decodedByteLength: number): number =>
  4 * Math.ceil(decodedByteLength / 3);

const decodedBase64ByteLength = (value: string): number => {
  if (!value || !/^[A-Za-z0-9+/]*={0,2}$/.test(value)) return -1;
  const firstPadding = value.indexOf("=");
  if (firstPadding >= 0 && firstPadding < value.length - (value.endsWith("==") ? 2 : 1)) return -1;
  const remainder = value.length % 4;
  if (remainder === 1) return -1;
  const padding = value.endsWith("==") ? 2 : value.endsWith("=") ? 1 : 0;
  if (padding > 0 && remainder !== 0) return -1;
  const dataRemainder = (value.length - padding) % 4;
  if ((padding === 1 && dataRemainder !== 3) || (padding === 2 && dataRemainder !== 2)) {
    return -1;
  }
  return Math.floor((value.length * 3) / 4) - padding;
};

const fromBase64Parts = (value: string): Uint8Array[] => {
  const parts: Uint8Array[] = [];
  const chunkSize = 0x8000;
  for (let offset = 0; offset < value.length; offset += chunkSize) {
    const binary = atob(value.slice(offset, offset + chunkSize));
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) {
      bytes[index] = binary.charCodeAt(index);
    }
    parts.push(bytes);
  }
  return parts;
};

const createEmptyCollections = (): MigrationCollections => ({
  space_groups: [],
  spaces: [],
  folders: [],
  items: [],
  tags: [],
  item_tags: [],
  search_history: [],
  flashcards: [],
  deleted_items: [],
});

const MIGRATION_PRIVATE_SPACE_CREDENTIAL_FIELDS = [
  "passwordSalt",
  "passwordHash",
  "passwordIterations",
  "passwordVersion",
  "recoveryQuestion1",
  "recoveryQuestion2",
  "recoverySalt1",
  "recoveryHash1",
  "recoveryIterations1",
  "recoverySalt2",
  "recoveryHash2",
  "recoveryIterations2",
] as const;

const redactMigrationCredentials = (
  collections: MigrationCollections,
  warnings: string[],
): MigrationCollections => {
  let redactedSpaceCredentials = false;
  let redactedFolderKeys = false;
  const spaces = collections.spaces.map((source) => {
    const row = { ...source };
    for (const field of MIGRATION_PRIVATE_SPACE_CREDENTIAL_FIELDS) {
      if (field in row) redactedSpaceCredentials = true;
      delete row[field];
    }
    if (row.isPrivate === true) {
      redactedSpaceCredentials = true;
      row.isPrivate = false;
    }
    return row;
  });
  const folders = collections.folders.map((source) => {
    const row = { ...source };
    if ("encryptionKey" in row || row.isLocked === true) redactedFolderKeys = true;
    delete row.encryptionKey;
    row.isLocked = false;
    return row;
  });
  if (redactedSpaceCredentials) {
    warnings.push("Private-space credentials were excluded; restored private spaces open as normal spaces.");
  }
  if (redactedFolderKeys) {
    warnings.push("Folder encryption keys were excluded from this unencrypted JSON backup.");
  }
  if (collections.deleted_items.length > 0) {
    warnings.push("Origin-local vector tombstones were excluded and will be rebuilt on this device.");
  }
  return { ...collections, spaces, folders, deleted_items: [] };
};

const addSpaceId = (spaceIds: Set<string>, value: unknown): void => {
  if (typeof value !== "string") return;
  const id = value.trim();
  if (id) spaceIds.add(id);
};

const incomingMigrationSpaceIds = (collections: MigrationCollections): Set<string> => {
  const ids = new Set<string>([PUBLIC_SPACE_ID]);
  for (const space of collections.spaces) addSpaceId(ids, space.id);
  for (const folder of collections.folders) addSpaceId(ids, folder.spaceId);
  for (const item of collections.items) addSpaceId(ids, item.spaceId);
  return ids;
};

const findDocsByIds = async (collection: any, ids: Iterable<string>): Promise<any[]> => {
  const uniqueIds = Array.from(new Set(ids)).filter(Boolean);
  const documents: any[] = [];
  for (let offset = 0; offset < uniqueIds.length; offset += RESTORE_BATCH_SIZE) {
    const batch = uniqueIds.slice(offset, offset + RESTORE_BATCH_SIZE);
    const batchSet = new Set(batch);
    const rows = await collection
      .find({ selector: { id: { $in: batch } } })
      .exec();
    for (const row of rows) {
      const id = row.get("id") as string | undefined;
      if (id && batchSet.has(id)) documents.push(row);
    }
  }
  return documents;
};

const currentMigrationSpaceIds = async (
  collections: MigrationCollections,
  db: Awaited<ReturnType<typeof getDb>>
): Promise<Set<string>> => {
  const ids = new Set<string>();
  const folderIds = new Set<string>();
  for (const folder of collections.folders) {
    if (typeof folder.id === "string" && folder.id) folderIds.add(folder.id);
  }
  for (const item of collections.items) {
    if (typeof item.folderId === "string" && item.folderId) folderIds.add(item.folderId);
  }

  const itemDocs = await findDocsByIds(
    db.items,
    collections.items
      .map((item) => (typeof item.id === "string" ? item.id : ""))
      .filter(Boolean)
  );
  for (const itemDoc of itemDocs) {
    addSpaceId(ids, itemDoc.get("spaceId"));
    const folderId = itemDoc.get("folderId");
    if (typeof folderId === "string" && folderId) folderIds.add(folderId);
  }

  const folderDocs = await findDocsByIds(db.folders, folderIds);
  for (const folderDoc of folderDocs) addSpaceId(ids, folderDoc.get("spaceId"));
  return ids;
};

const summarize = (
  collections: MigrationCollections,
  opfsFileCount: number,
  archiveFileCount: number,
  warningCount: number
): LocalExtensionMigrationSummary => ({
  collections: Object.fromEntries(
    COLLECTION_NAMES.map((name) => [name, collections[name].length])
  ) as LocalExtensionMigrationSummary["collections"],
  opfsFileCount,
  archiveFileCount,
  warningCount,
});

const yieldToEventLoop = () => new Promise<void>((resolve) => window.setTimeout(resolve, 0));

const bulkUpsertInBatches = async (
  collectionName: MigrationCollectionName,
  collection: {
    bulkUpsert: (
      rows: Record<string, unknown>[]
    ) => Promise<{ error?: unknown[] } | unknown>;
  },
  rows: Record<string, unknown>[]
) => {
  for (let start = 0; start < rows.length; start += RESTORE_BATCH_SIZE) {
    const batch = rows.slice(start, start + RESTORE_BATCH_SIZE);
    const result = await collection.bulkUpsert(batch);
    const writeErrors =
      result &&
      typeof result === "object" &&
      Array.isArray((result as { error?: unknown[] }).error)
        ? (result as { error: unknown[] }).error
        : [];
    if (writeErrors.length > 0) {
      throw new AggregateError(
        writeErrors,
        `MIGRATION_RESTORE_WRITE_FAILED:${collectionName}:${writeErrors.length}`
      );
    }
    const committedCount =
      result &&
      typeof result === "object" &&
      Array.isArray((result as { success?: unknown[] }).success)
        ? (result as { success: unknown[] }).success.length
        : 0;
    if (committedCount !== batch.length) {
      throw new Error(
        `MIGRATION_RESTORE_WRITE_INCOMPLETE:${collectionName}:${committedCount}/${batch.length}`
      );
    }
    await yieldToEventLoop();
  }
};

export const summarizeLocalExtensionMigrationBundle = (
  bundle: LocalExtensionMigrationBundle
): LocalExtensionMigrationSummary => summarize(
  bundle.collections,
  bundle.opfsFiles.length,
  bundle.archiveFiles.length,
  bundle.warnings.length,
);

const normalizeMigrationReferences = (
  source: MigrationCollections,
  existingSpaceIds: ReadonlySet<string>
): { collections: MigrationCollections; warningCount: number } => {
  let warningCount = 0;
  const groupIds = new Set(
    source.space_groups
      .map((group) => (typeof group.id === "string" ? group.id : ""))
      .filter(Boolean)
  );
  const spaces: Record<string, unknown>[] = source.spaces.map((space) => {
    const groupId = typeof space.spaceGroupId === "string" ? space.spaceGroupId : "";
    if (groupId && !groupIds.has(groupId)) warningCount += 1;
    return {
      ...space,
      spaceGroupId: groupId && groupIds.has(groupId) ? groupId : UNGROUPED_SPACE_GROUP_ID,
    };
  });
  const knownSpaceIds = new Set(existingSpaceIds);
  for (const space of spaces) {
    if (typeof space.id === "string" && space.id) knownSpaceIds.add(space.id);
  }

  const folders = source.folders.map((folder) => ({ ...folder }));
  const folderById = new Map<string, Record<string, unknown>>();
  for (const folder of folders) {
    if (typeof folder.id === "string" && folder.id) folderById.set(folder.id, folder);
  }
  for (const folder of folders) {
    const spaceId = typeof folder.spaceId === "string" ? folder.spaceId : "";
    if (!knownSpaceIds.has(spaceId) && knownSpaceIds.has(PUBLIC_SPACE_ID)) {
      folder.spaceId = PUBLIC_SPACE_ID;
      warningCount += 1;
    }
    const parentId = typeof folder.parentId === "string" ? folder.parentId : "";
    if (!parentId) {
      folder.parentId = null;
      continue;
    }
    const parent = folderById.get(parentId);
    if (
      !parent ||
      parent === folder ||
      parent.spaceId !== folder.spaceId
    ) {
      folder.parentId = null;
      warningCount += 1;
    }
  }
  for (const folder of folders) {
    const id = typeof folder.id === "string" ? folder.id : "";
    if (!id) continue;
    const seen = new Set<string>([id]);
    let parentId = typeof folder.parentId === "string" ? folder.parentId : "";
    let cyclic = false;
    while (parentId) {
      if (seen.has(parentId)) {
        cyclic = true;
        break;
      }
      seen.add(parentId);
      const parent = folderById.get(parentId);
      parentId = typeof parent?.parentId === "string" ? parent.parentId : "";
    }
    if (cyclic) {
      folder.parentId = null;
      warningCount += 1;
    }
  }

  const items = source.items.map((item) => {
    const next = { ...item };
    const folderId = typeof next.folderId === "string" ? next.folderId : "";
    const folder = folderId ? folderById.get(folderId) : undefined;
    if (folder && typeof folder.spaceId === "string") {
      if (next.spaceId !== folder.spaceId) warningCount += 1;
      next.spaceId = folder.spaceId;
    } else if (folderId) {
      // Preserve an unresolved legacy row for recovery instead of rejecting
      // the entire origin restore, but surface it in the summary.
      warningCount += 1;
    }
    return next;
  });

  return {
    collections: {
      ...source,
      spaces,
      folders,
      items,
    },
    warningCount,
  };
};

const getReferencedOpfsPaths = (items: Record<string, unknown>[]): string[] => {
  const paths = new Set<string>();
  for (const item of items) {
    const media = (item as ItemDocType).media;
    for (const entry of media || []) {
      if (entry.storageType === "opfs" && typeof entry.opfsPath === "string" && entry.opfsPath) {
        paths.add(entry.opfsPath);
      }
    }
  }
  return Array.from(paths);
};

const parseOpfsPath = (opfsPath: string): { itemId: string; fileName: string } | null => {
  const parts = opfsPath.split("/").filter(Boolean);
  if (parts.length !== 3 || parts[0] !== "media") return null;
  const [, itemId, fileName] = parts;
  if (!itemId || !fileName || itemId.includes("/") || fileName.includes("/")) return null;
  return { itemId, fileName };
};

// Imported items that were never enriched (or whose export predates metadata)
// arrive with `isMetaFetched !== true`. Collect their URLs so the import ->
// metadata -> embedding chain runs automatically, mirroring bookmark imports.
export const collectMetadataPendingUrls = (items: Record<string, unknown>[]): string[] => {
  const urls = new Set<string>();
  for (const item of items) {
    const record = item as Partial<ItemDocType>;
    if (record.isMetaFetched === true) continue;
    const url = typeof record.url === "string" ? record.url.trim() : "";
    if (!isMetadataFetchableUrl(url)) continue;
    urls.add(url);
  }
  return Array.from(urls);
};

// Hand pending URLs to the background metadata pipeline, which paces, batches,
// dedupes, and retries them. Fire-and-forget: restore must not block on it.
const queueMetadataForRestoredItems = (urls: string[]) => {
  if (urls.length === 0) return;
  try {
    const runtime = (globalThis as typeof globalThis & { chrome?: typeof chrome }).chrome?.runtime;
    void runtime
      ?.sendMessage?.({
        target: "background",
        type: "FETCH_METADATA",
        payload: { urls, revalidate: false },
      })
      ?.catch?.(() => {});
  } catch {}
};

export const validateLocalExtensionMigrationBundle = (
  value: unknown
): LocalExtensionMigrationBundle => {
  if (!value || typeof value !== "object") throw new Error("MIGRATION_FILE_INVALID");
  const bundle = value as Partial<LocalExtensionMigrationBundle>;
  if (
    bundle.format !== MIGRATION_FORMAT ||
    !SUPPORTED_MIGRATION_VERSIONS.has(Number(bundle.version))
  ) {
    throw new Error("MIGRATION_FILE_VERSION_UNSUPPORTED");
  }
  if (!bundle.collections || typeof bundle.collections !== "object") {
    throw new Error("MIGRATION_FILE_COLLECTIONS_INVALID");
  }
  for (const name of COLLECTION_NAMES) {
    if (!Array.isArray(bundle.collections[name])) {
      throw new Error(`MIGRATION_FILE_${name.toUpperCase()}_INVALID`);
    }
  }
  if (!Array.isArray(bundle.opfsFiles) || !Array.isArray(bundle.warnings)) {
    throw new Error("MIGRATION_FILE_MEDIA_INVALID");
  }
  if (
    bundle.warnings.length > 10_000 ||
    bundle.warnings.some((warning) => typeof warning !== "string" || warning.length > 2_000)
  ) {
    throw new Error("MIGRATION_FILE_WARNINGS_INVALID");
  }
  if (bundle.opfsFiles.length > LOCAL_MIGRATION_MAX_BINARY_FILES) {
    throw new Error("MIGRATION_FILE_TOO_MANY_BINARY_FILES");
  }
  const referencedOpfsPaths = new Set(
    getReferencedOpfsPaths(bundle.collections.items as Record<string, unknown>[]),
  );
  const includedOpfsPaths = new Set<string>();
  let decodedBytes = 0;
  for (const file of bundle.opfsFiles) {
    if (
      !file ||
      typeof file.opfsPath !== "string" ||
      typeof file.mimeType !== "string" ||
      typeof file.base64 !== "string" ||
      !parseOpfsPath(file.opfsPath)
    ) {
      throw new Error("MIGRATION_FILE_MEDIA_ENTRY_INVALID");
    }
    if (includedOpfsPaths.has(file.opfsPath)) {
      throw new Error("MIGRATION_FILE_DUPLICATE_MEDIA_PATH");
    }
    includedOpfsPaths.add(file.opfsPath);
    if (Number(bundle.version) >= 2 && !referencedOpfsPaths.has(file.opfsPath)) {
      throw new Error("MIGRATION_FILE_UNREFERENCED_MEDIA_PATH");
    }
    const byteSize = decodedBase64ByteLength(file.base64);
    if (byteSize < 0 || byteSize > LOCAL_MIGRATION_MAX_MEDIA_FILE_BYTES) {
      throw new Error("MIGRATION_FILE_MEDIA_SIZE_INVALID");
    }
    decodedBytes += byteSize;
  }
  if (Number(bundle.version) >= 2) {
    for (const opfsPath of referencedOpfsPaths) {
      if (!includedOpfsPaths.has(opfsPath)) {
        throw new Error("MIGRATION_FILE_REFERENCED_MEDIA_MISSING");
      }
    }
  }
  if (Number(bundle.version) >= 2 && !Array.isArray(bundle.archiveFiles)) {
    throw new Error("MIGRATION_FILE_ARCHIVES_INVALID");
  }
  const archiveFiles = bundle.archiveFiles ?? [];
  if (!Array.isArray(archiveFiles)) {
    throw new Error("MIGRATION_FILE_ARCHIVES_INVALID");
  }
  if (bundle.opfsFiles.length + archiveFiles.length > LOCAL_MIGRATION_MAX_BINARY_FILES) {
    throw new Error("MIGRATION_FILE_TOO_MANY_BINARY_FILES");
  }
  const migrationItemIds = new Set(
    (bundle.collections.items as Record<string, unknown>[])
      .map((item) => (typeof item.id === "string" ? item.id : ""))
      .filter(Boolean),
  );
  const archivedItemIds = new Set<string>();
  let archiveBytes = 0;
  for (const file of archiveFiles) {
    if (
      !file ||
      typeof file.itemId !== "string" ||
      !file.itemId.trim() ||
      file.itemId.length > 160 ||
      typeof file.mimeType !== "string" ||
      typeof file.base64 !== "string" ||
      !Number.isSafeInteger(file.updatedAt) ||
      file.updatedAt < 0
    ) {
      throw new Error("MIGRATION_FILE_ARCHIVE_ENTRY_INVALID");
    }
    if (!migrationItemIds.has(file.itemId)) {
      throw new Error("MIGRATION_FILE_UNREFERENCED_ARCHIVE");
    }
    if (archivedItemIds.has(file.itemId)) {
      throw new Error("MIGRATION_FILE_DUPLICATE_ARCHIVE");
    }
    archivedItemIds.add(file.itemId);
    const byteSize = decodedBase64ByteLength(file.base64);
    if (byteSize <= 0 || byteSize > LOCAL_MIGRATION_MAX_ARCHIVE_FILE_BYTES) {
      throw new Error("MIGRATION_FILE_ARCHIVE_SIZE_INVALID");
    }
    archiveBytes += byteSize;
    decodedBytes += byteSize;
    if (archiveBytes > LOCAL_MIGRATION_MAX_ARCHIVE_TOTAL_BYTES) {
      throw new Error("MIGRATION_FILE_ARCHIVES_TOO_LARGE");
    }
  }
  if (decodedBytes > LOCAL_MIGRATION_MAX_DECODED_BYTES) {
    throw new Error("MIGRATION_FILE_BINARY_DATA_TOO_LARGE");
  }
  const warnings = [...bundle.warnings];
  const collections = redactMigrationCredentials(
    bundle.collections as MigrationCollections,
    warnings,
  );
  return {
    ...(bundle as LocalExtensionMigrationBundle),
    version: Number(bundle.version) as LocalExtensionMigrationBundle["version"],
    collections,
    archiveFiles,
    warnings,
  };
};

export const buildLocalExtensionMigrationBundle = async (
  options: MigrationOptions = {},
): Promise<LocalExtensionMigrationBundle> => {
  const db = await getDb();
  let collections = createEmptyCollections();
  const warnings: string[] = [];
  const maxEstimatedJsonBytes = Math.max(
    1_024,
    Math.min(
      LOCAL_MIGRATION_MAX_JSON_BYTES,
      Math.floor(options.maxEstimatedJsonBytes ?? LOCAL_MIGRATION_MAX_JSON_BYTES),
    ),
  );
  const pageSize = Math.max(
    1,
    Math.min(1_000, Math.floor(options.pageSize ?? MIGRATION_EXPORT_PAGE_SIZE)),
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

  // Read bounded keyset pages and account for every row before retaining it.
  // Oversized libraries fail while only one page is live instead of first
  // materializing every RxDocument and then discovering the final Blob is too
  // large for a safe renderer heap.
  for (const name of COLLECTION_NAMES) {
    await forEachIdKeysetPage({
      collection: db[name] as any,
      selector: {},
      pageSize,
      onPage: (docs) => {
        for (const doc of docs) {
          const row = (doc as { toMutableJSON(): Record<string, unknown> }).toMutableJSON();
          reserveJsonBytes(serializedUtf8ByteLength(row) + 1);
          collections[name].push(row);
        }
      },
    });
  }

  collections = redactMigrationCredentials(collections, warnings);
  const redactedCollections = collections;
  const opfsFiles: MigratedOpfsFile[] = [];
  let decodedBinaryBytes = 0;
  const referencedOpfsPaths = getReferencedOpfsPaths(redactedCollections.items);
  if (referencedOpfsPaths.length > LOCAL_MIGRATION_MAX_BINARY_FILES) {
    throw new Error("MIGRATION_BACKUP_TOO_MANY_BINARY_FILES");
  }
  for (const opfsPath of referencedOpfsPaths) {
    const file = await readOpfsFile(opfsPath);
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

  const archiveFiles: MigratedArchiveFile[] = [];
  const itemIds = new Set(
    redactedCollections.items
      .map((item) => (typeof item.id === "string" ? item.id : ""))
      .filter(Boolean),
  );
  const archiveCache = options.archiveCache ?? getArchiveCache();
  const archiveCandidates = new Map<string, {
    itemId: string;
    mimeType: string;
    updatedAt: number;
    file: Blob;
  }>();
  const canReadDefaultOutbox = typeof globalThis.chrome !== "undefined" && !!globalThis.chrome.storage?.local;
  const defaultOutboxFiles = canReadDefaultOutbox ? createOpfsArchiveOutboxFiles() : null;
  const archiveOutbox = options.archiveOutbox ?? (canReadDefaultOutbox && defaultOutboxFiles
    ? {
        list: async () => normalizeArchiveOutbox(await createChromeArchiveOutboxStorage().read()),
        read: (fileName: string) => defaultOutboxFiles.read(fileName),
      }
    : {
        list: async () => [],
        read: async () => null,
      });
  // Cache retention and outbox acknowledgement move a file between stores
  // under this same lock. Snapshot both stores together so a full export can
  // never observe the transient "in neither place" side of that move.
  await withOpfsMutationLock(async () => {
    let cachedArchives: Awaited<ReturnType<MigrationArchiveCache["listFiles"]>> = [];
    try {
      cachedArchives = await archiveCache.listFiles();
      if (archiveCache.list) {
        const indexed = await archiveCache.list();
        const verifiedNames = new Set(cachedArchives.map(({ entry }) => entry.fileName));
        for (const entry of indexed) {
          if (itemIds.has(entry.itemId) && !verifiedNames.has(entry.fileName)) {
            warnings.push(`Offline archive cache file is missing or corrupt for item ${entry.itemId}.`);
          }
        }
      }
    } catch (error) {
      throw new Error(
        `MIGRATION_BACKUP_ARCHIVE_CACHE_READ_FAILED:${
          error instanceof Error ? error.message : "unknown error"
        }`,
        { cause: error },
      );
    }
    for (const { entry, file } of cachedArchives) {
      if (!itemIds.has(entry.itemId)) continue;
      archiveCandidates.set(entry.itemId, {
        itemId: entry.itemId,
        mimeType: file.type || entry.mimeType || "text/html",
        updatedAt: entry.updatedAt,
        file,
      });
    }

    try {
      for (const job of await archiveOutbox.list()) {
        if (job.mode !== "upload" || !job.fileName || !itemIds.has(job.itemId)) continue;
        const existing = archiveCandidates.get(job.itemId);
        if (existing && existing.updatedAt > job.updatedAt) continue;
        const file = await archiveOutbox.read(job.fileName);
        if (!file || file.size !== job.byteSize || file.size <= 0) {
          warnings.push(`Pending offline archive file is missing or corrupt for item ${job.itemId}.`);
          continue;
        }
        archiveCandidates.set(job.itemId, {
          itemId: job.itemId,
          mimeType: file.type || "text/html",
          updatedAt: job.updatedAt,
          file,
        });
      }
    } catch (error) {
      throw new Error(
        `MIGRATION_BACKUP_ARCHIVE_OUTBOX_READ_FAILED:${
          error instanceof Error ? error.message : "unknown error"
        }`,
        { cause: error },
      );
    }
  });

  let archiveBytes = 0;
  if (opfsFiles.length + archiveCandidates.size > LOCAL_MIGRATION_MAX_BINARY_FILES) {
    throw new Error("MIGRATION_BACKUP_TOO_MANY_BINARY_FILES");
  }
  for (const candidate of archiveCandidates.values()) {
    const { itemId, mimeType, updatedAt, file } = candidate;
    if (file.size <= 0 || file.size > LOCAL_MIGRATION_MAX_ARCHIVE_FILE_BYTES) {
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
    format: MIGRATION_FORMAT,
    version: MIGRATION_VERSION,
    createdAt: Date.now(),
    collections: redactedCollections,
    opfsFiles,
    archiveFiles,
    warnings,
  };
};

export const restoreLocalExtensionMigrationBundle = async (
  value: unknown,
  options: MigrationOptions = {},
): Promise<RestoreLocalExtensionMigrationResult> => {
  const bundle = validateLocalExtensionMigrationBundle(value);
  const db = await getDb();
  const incomingSpaceIds = incomingMigrationSpaceIds(bundle.collections);
  return withBinMutationLock(db, () =>
    withStableAffectedSpaceLocks(
      db,
      incomingSpaceIds,
      () => currentMigrationSpaceIds(bundle.collections, db),
      () => withOpfsMutationLock(() => restoreLocalExtensionMigrationBundleLocked(
        bundle,
        db,
        options.archiveCache ?? getArchiveCache(),
      ))
    )
  );
};

const restoreLocalExtensionMigrationBundleLocked = async (
  bundle: LocalExtensionMigrationBundle,
  db: Awaited<ReturnType<typeof getDb>>,
  archiveCache: MigrationArchiveCache,
): Promise<RestoreLocalExtensionMigrationResult> => {
  const existingSpaceDocs = await db.spaces.find().exec();
  const existingSpaces = new Map(
    existingSpaceDocs.map((doc: any) => [
      doc.get("id") as string,
      doc.toMutableJSON() as Record<string, unknown>,
    ]),
  );
  const existingSpaceIds = new Set(existingSpaces.keys());
  const existingFolderDocs = await db.folders.find().exec();
  const existingFolders = new Map(
    existingFolderDocs.map((doc: any) => [
      doc.get("id") as string,
      doc.toMutableJSON() as Record<string, unknown>,
    ]),
  );
  const normalized = normalizeMigrationReferences(bundle.collections, existingSpaceIds);

  // The portable JSON intentionally contains no secrets. When it is merged
  // back into the same profile, never let those redacted rows downgrade an
  // existing private space or locked folder to public/unlocked state.
  const migrationSpaces = normalized.collections.spaces.map((source) => {
    const existing = typeof source.id === "string" ? existingSpaces.get(source.id) : undefined;
    if (existing?.isPrivate !== true) return source;
    const next: Record<string, unknown> = { ...source, isPrivate: true };
    for (const field of MIGRATION_PRIVATE_SPACE_CREDENTIAL_FIELDS) {
      if (field in existing) next[field] = existing[field];
    }
    return next;
  });
  const migrationFolders = normalized.collections.folders.map((source) => {
    const existing = typeof source.id === "string" ? existingFolders.get(source.id) : undefined;
    if (existing?.isLocked !== true && typeof existing?.encryptionKey !== "string") return source;
    const next: Record<string, unknown> = { ...source, isLocked: existing.isLocked === true };
    if (typeof existing.encryptionKey === "string") next.encryptionKey = existing.encryptionKey;
    return next;
  });

  // A vector index belongs to one OPFS origin. The source vector file is not
  // copied, so every migrated item enters the destination embedding queue.
  const migratedItems: Record<string, unknown>[] = normalized.collections.items.map((item) => {
    const url = typeof item.url === "string" ? item.url : "";
    return {
      ...item,
      vector_index: -1,
      vector_indexes: [],
      isEmbedded: false,
      isDirty: false,
      isMetaFetched: isMetadataFetchableUrl(url) ? item.isMetaFetched === true : true,
    };
  });
  const collections: MigrationCollections = {
    ...normalized.collections,
    spaces: migrationSpaces,
    folders: migrationFolders,
    items: migratedItems,
    deleted_items: [],
  };

  for (const name of COLLECTION_NAMES) {
    const rows = collections[name];
    if (rows.length > 0) {
      await bulkUpsertInBatches(name, db[name] as any, rows);
    }
  }

  let restoredOpfsFileCount = 0;
  for (const file of bundle.opfsFiles) {
    const parsed = parseOpfsPath(file.opfsPath);
    if (!parsed) continue;
    const bytes = fromBase64Parts(file.base64);
    await saveMediaToOpfs(
      parsed.itemId,
      new File(bytes, parsed.fileName, { type: file.mimeType }),
      parsed.fileName
    );
    restoredOpfsFileCount += 1;
    if (restoredOpfsFileCount % 10 === 0) await yieldToEventLoop();
  }

  let restoredArchiveFileCount = 0;
  const restoredItemIds = new Set(
    migratedItems
      .map((item) => (typeof item["id"] === "string" ? item["id"] : ""))
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
    ...summarize(
      collections,
      bundle.opfsFiles.length,
      bundle.archiveFiles.length,
      bundle.warnings.length + normalized.warningCount
    ),
    restoredOpfsFileCount,
    restoredArchiveFileCount,
    scheduledReembeddingItemCount: migratedItems.length,
    metadataPendingUrlCount: metadataPendingUrls.length,
  };
};
