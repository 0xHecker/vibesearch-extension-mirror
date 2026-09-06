import {
  copyJsonObject,
  jsonBoolean,
  jsonString,
  type JsonObject,
  type JsonValue,
} from "@src/common/json-value";
import { PUBLIC_SPACE_ID } from "@src/common/spaces";
import { UNGROUPED_SPACE_GROUP_ID } from "@src/schemas/space_schema";
import type { MyDatabase } from "@src/services/DatabaseService";
import type {
  MigrationCollections,
} from "@src/services/local-extension-migration/model";
import { isMetadataFetchableUrl } from "@src/utils/metadata-url";
import { z } from "zod";

const RESTORE_BATCH_SIZE = 400;

const PRIVATE_SPACE_CREDENTIAL_FIELDS = [
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

const mediaEntriesSchema = z.array(
  z
    .object({
      storageType: z.string().optional(),
      opfsPath: z.string().optional(),
    })
    .loose(),
);

export const redactMigrationCredentials = (
  collections: MigrationCollections,
  warnings: string[],
): MigrationCollections => {
  let redactedSpaceCredentials = false;
  let redactedFolderKeys = false;
  const spaces = collections.spaces.map((source) => {
    const row = { ...source };
    for (const field of PRIVATE_SPACE_CREDENTIAL_FIELDS) {
      if (field in row) redactedSpaceCredentials = true;
      delete row[field];
    }
    if (jsonBoolean(row.isPrivate) === true) {
      redactedSpaceCredentials = true;
      row.isPrivate = false;
    }
    return row;
  });
  const folders = collections.folders.map((source) => {
    const row = { ...source };
    if ("encryptionKey" in row || jsonBoolean(row.isLocked) === true) {
      redactedFolderKeys = true;
    }
    delete row.encryptionKey;
    row.isLocked = false;
    return row;
  });

  if (redactedSpaceCredentials) {
    warnings.push(
      "Private-space credentials were excluded; restored private spaces open as normal spaces.",
    );
  }
  if (redactedFolderKeys) {
    warnings.push(
      "Folder encryption keys were excluded from this unencrypted JSON backup.",
    );
  }
  if (collections.deleted_items.length > 0) {
    warnings.push(
      "Origin-local vector tombstones were excluded and will be rebuilt on this device.",
    );
  }
  return { ...collections, spaces, folders, deleted_items: [] };
};

const addSpaceId = (
  spaceIds: Set<string>,
  value: JsonValue | undefined,
): void => {
  const id = jsonString(value)?.trim();
  if (id) spaceIds.add(id);
};

export const incomingMigrationSpaceIds = (
  collections: MigrationCollections,
): Set<string> => {
  const ids = new Set<string>([PUBLIC_SPACE_ID]);
  for (const space of collections.spaces) addSpaceId(ids, space.id);
  for (const folder of collections.folders) addSpaceId(ids, folder.spaceId);
  for (const item of collections.items) addSpaceId(ids, item.spaceId);
  return ids;
};

type IdentifiedDocument = {
  primary: string;
};

type IdQueryCollection<Document extends IdentifiedDocument> = {
  find(query: {
    selector: { id: { $in: string[] } };
  }): { exec(): Promise<Document[]> };
};

async function findDocsByIds<Document extends IdentifiedDocument>(
  collection: IdQueryCollection<Document>,
  ids: Iterable<string>,
): Promise<Document[]> {
  const uniqueIds = Array.from(new Set(ids)).filter(Boolean);
  const documents: Document[] = [];
  for (let offset = 0; offset < uniqueIds.length; offset += RESTORE_BATCH_SIZE) {
    const batch = uniqueIds.slice(offset, offset + RESTORE_BATCH_SIZE);
    const batchSet = new Set(batch);
    const rows = await collection
      .find({ selector: { id: { $in: batch } } })
      .exec();
    for (const row of rows) {
      if (batchSet.has(row.primary)) documents.push(row);
    }
  }
  return documents;
}

export const currentMigrationSpaceIds = async (
  collections: MigrationCollections,
  db: MyDatabase,
): Promise<Set<string>> => {
  const ids = new Set<string>();
  const folderIds = new Set<string>();
  for (const folder of collections.folders) {
    const folderId = jsonString(folder.id);
    if (folderId) folderIds.add(folderId);
  }
  for (const item of collections.items) {
    const folderId = jsonString(item.folderId);
    if (folderId) folderIds.add(folderId);
  }

  const itemIds = collections.items
    .map((item) => jsonString(item.id) ?? "")
    .filter(Boolean);
  const itemDocs = await findDocsByIds(db.items, itemIds);
  for (const itemDoc of itemDocs) {
    addSpaceId(ids, itemDoc.get("spaceId"));
    const folderId = itemDoc.get("folderId");
    if (folderId) folderIds.add(folderId);
  }

  const folderDocs = await findDocsByIds(db.folders, folderIds);
  for (const folderDoc of folderDocs) addSpaceId(ids, folderDoc.get("spaceId"));
  return ids;
};

export type NormalizedMigrationCollections = {
  collections: MigrationCollections;
  warningCount: number;
};

export const normalizeMigrationReferences = (
  source: MigrationCollections,
  existingSpaceIds: ReadonlySet<string>,
): NormalizedMigrationCollections => {
  let warningCount = 0;
  const groupIds = new Set(
    source.space_groups
      .map((group) => jsonString(group.id) ?? "")
      .filter(Boolean),
  );
  const spaces = source.spaces.map((space) => {
    const groupId = jsonString(space.spaceGroupId) ?? "";
    if (groupId && !groupIds.has(groupId)) warningCount += 1;
    const next = copyJsonObject(space);
    next.spaceGroupId =
      groupId && groupIds.has(groupId)
        ? groupId
        : UNGROUPED_SPACE_GROUP_ID;
    return next;
  });
  const knownSpaceIds = new Set(existingSpaceIds);
  for (const space of spaces) {
    const spaceId = jsonString(space.id);
    if (spaceId) knownSpaceIds.add(spaceId);
  }

  const folders = source.folders.map(copyJsonObject);
  const folderById = new Map<string, JsonObject>();
  for (const folder of folders) {
    const folderId = jsonString(folder.id);
    if (folderId) folderById.set(folderId, folder);
  }
  for (const folder of folders) {
    const spaceId = jsonString(folder.spaceId) ?? "";
    if (!knownSpaceIds.has(spaceId) && knownSpaceIds.has(PUBLIC_SPACE_ID)) {
      folder.spaceId = PUBLIC_SPACE_ID;
      warningCount += 1;
    }
    const parentId = jsonString(folder.parentId) ?? "";
    if (!parentId) {
      folder.parentId = null;
      continue;
    }
    const parent = folderById.get(parentId);
    if (!parent || parent === folder || parent.spaceId !== folder.spaceId) {
      folder.parentId = null;
      warningCount += 1;
    }
  }
  for (const folder of folders) {
    const id = jsonString(folder.id);
    if (!id) continue;
    const seen = new Set<string>([id]);
    let parentId = jsonString(folder.parentId) ?? "";
    let cyclic = false;
    while (parentId) {
      if (seen.has(parentId)) {
        cyclic = true;
        break;
      }
      seen.add(parentId);
      const parent = folderById.get(parentId);
      parentId = jsonString(parent?.parentId) ?? "";
    }
    if (cyclic) {
      folder.parentId = null;
      warningCount += 1;
    }
  }

  const items = source.items.map((item) => {
    const next = copyJsonObject(item);
    const folderId = jsonString(next.folderId) ?? "";
    const folder = folderId ? folderById.get(folderId) : undefined;
    const folderSpaceId = jsonString(folder?.spaceId);
    if (folderSpaceId) {
      if (next.spaceId !== folderSpaceId) warningCount += 1;
      next.spaceId = folderSpaceId;
    } else if (folderId) {
      // Preserve unresolved legacy rows for recovery, but surface them.
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

export const getReferencedOpfsPaths = (
  items: readonly JsonObject[],
): string[] => {
  const paths = new Set<string>();
  for (const item of items) {
    const parsedMedia = mediaEntriesSchema.safeParse(item.media);
    if (!parsedMedia.success) continue;
    for (const entry of parsedMedia.data) {
      if (entry.storageType === "opfs" && entry.opfsPath) {
        paths.add(entry.opfsPath);
      }
    }
  }
  return Array.from(paths);
};

export const collectMetadataPendingUrls = (
  items: readonly JsonObject[],
): string[] => {
  const urls = new Set<string>();
  for (const item of items) {
    if (jsonBoolean(item.isMetaFetched) === true) continue;
    const url = jsonString(item.url)?.trim() ?? "";
    if (isMetadataFetchableUrl(url)) urls.add(url);
  }
  return Array.from(urls);
};

/** Queue restored URLs without making a successful restore wait for metadata. */
export const queueMetadataForRestoredItems = (urls: readonly string[]): void => {
  if (urls.length === 0) return;
  try {
    void globalThis.chrome?.runtime
      ?.sendMessage({
        target: "background",
        type: "FETCH_METADATA",
        payload: { urls, revalidate: false },
      })
      ?.catch(() => {});
  } catch {}
};

export const privateSpaceCredentialFields =
  PRIVATE_SPACE_CREDENTIAL_FIELDS;
