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

const MIGRATION_FORMAT = "vibesearch-local-extension-migration";
const MIGRATION_VERSION = 1;
const RESTORE_BATCH_SIZE = 400;

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

export type LocalExtensionMigrationBundle = {
  format: typeof MIGRATION_FORMAT;
  version: typeof MIGRATION_VERSION;
  createdAt: number;
  collections: MigrationCollections;
  opfsFiles: MigratedOpfsFile[];
  warnings: string[];
};

export type LocalExtensionMigrationSummary = {
  collections: Record<MigrationCollectionName, number>;
  opfsFileCount: number;
  warningCount: number;
};

export type RestoreLocalExtensionMigrationResult = LocalExtensionMigrationSummary & {
  restoredOpfsFileCount: number;
  scheduledReembeddingItemCount: number;
  metadataPendingUrlCount: number;
};

const toBase64 = (buffer: ArrayBuffer): string => {
  const bytes = new Uint8Array(buffer);
  const chunkSize = 0x8000;
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize));
  }
  return btoa(binary);
};

const fromBase64 = (value: string): Uint8Array => {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
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
  warningCount: number
): LocalExtensionMigrationSummary => ({
  collections: Object.fromEntries(
    COLLECTION_NAMES.map((name) => [name, collections[name].length])
  ) as LocalExtensionMigrationSummary["collections"],
  opfsFileCount,
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
): LocalExtensionMigrationSummary => summarize(bundle.collections, bundle.opfsFiles.length, bundle.warnings.length);

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
  if (bundle.format !== MIGRATION_FORMAT || bundle.version !== MIGRATION_VERSION) {
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
  }
  return bundle as LocalExtensionMigrationBundle;
};

export const buildLocalExtensionMigrationBundle = async (): Promise<LocalExtensionMigrationBundle> => {
  const db = await getDb();
  const collections = createEmptyCollections();

  await Promise.all(
    COLLECTION_NAMES.map(async (name) => {
      const docs = await db[name].find().exec();
      collections[name] = docs.map((doc) => doc.toMutableJSON() as Record<string, unknown>);
    })
  );

  const warnings: string[] = [];
  const opfsFiles: MigratedOpfsFile[] = [];
  for (const opfsPath of getReferencedOpfsPaths(collections.items)) {
    const file = await readOpfsFile(opfsPath);
    if (!file) {
      warnings.push(`Local media file could not be read: ${opfsPath}`);
      continue;
    }
    opfsFiles.push({
      opfsPath,
      mimeType: file.type || "application/octet-stream",
      base64: toBase64(await file.arrayBuffer()),
    });
  }

  return {
    format: MIGRATION_FORMAT,
    version: MIGRATION_VERSION,
    createdAt: Date.now(),
    collections,
    opfsFiles,
    warnings,
  };
};

export const restoreLocalExtensionMigrationBundle = async (
  value: unknown
): Promise<RestoreLocalExtensionMigrationResult> => {
  const bundle = validateLocalExtensionMigrationBundle(value);
  const db = await getDb();
  const incomingSpaceIds = incomingMigrationSpaceIds(bundle.collections);
  return withBinMutationLock(db, () =>
    withStableAffectedSpaceLocks(
      db,
      incomingSpaceIds,
      () => currentMigrationSpaceIds(bundle.collections, db),
      () => withOpfsMutationLock(() => restoreLocalExtensionMigrationBundleLocked(bundle, db))
    )
  );
};

const restoreLocalExtensionMigrationBundleLocked = async (
  bundle: LocalExtensionMigrationBundle,
  db: Awaited<ReturnType<typeof getDb>>
): Promise<RestoreLocalExtensionMigrationResult> => {
  const existingSpaceDocs = await db.spaces.find().exec();
  const existingSpaceIds = new Set(
    existingSpaceDocs
      .map((doc: any) => doc.get("id") as string)
      .filter(Boolean)
  );
  const normalized = normalizeMigrationReferences(bundle.collections, existingSpaceIds);

  // A vector index belongs to one OPFS origin. The source vector file is not
  // copied, so every migrated item enters the destination embedding queue.
  const migratedItems = normalized.collections.items.map((item) => {
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
    items: migratedItems,
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
    const bytes = fromBase64(file.base64);
    await saveMediaToOpfs(
      parsed.itemId,
      new File([bytes], parsed.fileName, { type: file.mimeType }),
      parsed.fileName
    );
    restoredOpfsFileCount += 1;
    if (restoredOpfsFileCount % 10 === 0) await yieldToEventLoop();
  }

  const metadataPendingUrls = collectMetadataPendingUrls(migratedItems);
  queueMetadataForRestoredItems(metadataPendingUrls);

  return {
    ...summarize(
      collections,
      bundle.opfsFiles.length,
      bundle.warnings.length + normalized.warningCount
    ),
    restoredOpfsFileCount,
    scheduledReembeddingItemCount: migratedItems.length,
    metadataPendingUrlCount: metadataPendingUrls.length,
  };
};
