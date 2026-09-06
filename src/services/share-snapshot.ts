import { LIVE_SPACE_SELECTOR, PUBLIC_SPACE_ID } from "@src/common/spaces";
import type { FolderDocType } from "@src/schemas/folder_schema";
import type { ItemDocType } from "@src/schemas/item_schema";
import type { ItemTagDocType } from "@src/schemas/item_tag_schema";
import type { SpaceDocType } from "@src/schemas/space_schema";
import type { SpaceGroupDocType } from "@src/schemas/space_group_schema";
import type { TagDocType } from "@src/schemas/tag_schema";
import { getDb } from "@src/services/DatabaseService";
import { withBinMutationLock } from "@src/services/entity-mutation-lock";
import { GOOGLE_BACKUP_MAX_BYTES } from "@src/services/google-backup-limits";
import { withLiveSpaceDestination } from "@src/services/live-destination";
import { checkedRxBulkWrite } from "@src/services/rxdb-bulk-write";
import { forEachIdKeysetPage } from "@src/services/rxdb-keyset-pagination";
import {
  normalizeEntityName,
  normalizeNumber,
  normalizeSourceIds,
  normalizeText,
  normalizeTitle,
  sanitizeFolder,
  sanitizeItem,
  sanitizeItemTag,
  sanitizeSpace,
  sanitizeSpaceGroup,
  sanitizeTag,
  sendDbChange,
  toImportedItem,
  validateSnapshot,
} from "@src/services/share-snapshot/codec";
import { mergeBackupSnapshot } from "@src/services/share-snapshot/merge";
import type {
  BuildExportSnapshotPayload,
  BuildLocalExportSnapshotOptions,
  BuildShareFromMixedInput,
  ImportSharedSnapshotPayload,
  ImportSharedSnapshotResult,
  ShareSnapshotDependencies,
  ShareSnapshotV1,
  ShareSnapshotWarning,
  SharedFolder,
  SharedItem,
  SharedItemTag,
  SharedSpace,
  SharedSpaceGroup,
  SharedTag,
} from "@src/services/share-snapshot/model";
import type { RxCollection } from "rxdb";

export { mergeBackupSnapshot };
export type {
  BuildExportSnapshotPayload,
  BuildLocalExportSnapshotOptions,
  BuildShareFromMixedInput,
  ImportSharedSnapshotPayload,
  ImportSharedSnapshotResult,
  MergeBackupSnapshotResult,
  MixedShareSelection,
  ShareSnapshotDependencies,
  ShareSnapshotV1,
  ShareSnapshotWarning,
  ShareSourceKind,
  SharedFolder,
  SharedItem,
  SharedItemTag,
  SharedMedia,
  SharedSpace,
  SharedSpaceGroup,
  SharedTag,
} from "@src/services/share-snapshot/model";

/**
 * Build a sanitized snapshot from any combination of folders, items, spaces,
 * and space groups. Container selections expand to their live descendants.
 */
export async function buildShareSnapshotFromMixed(
  input: BuildShareFromMixedInput,
  dependencies: ShareSnapshotDependencies = {},
): Promise<ShareSnapshotV1> {
  const db = await (dependencies.getDb ?? getDb)();
  const [
    spaceGroupDocs,
    spaceDocs,
    folderDocs,
    itemDocs,
    tagDocs,
    itemTagDocs,
  ] = await Promise.all([
    db.space_groups.find().exec(),
    db.spaces.find({ selector: { ...LIVE_SPACE_SELECTOR } }).exec(),
    db.folders.find().exec(),
    db.items.find({ selector: { deletedAt: { $eq: 0 } } }).exec(),
    db.tags.find().exec(),
    db.item_tags.find().exec(),
  ]);

  const allSpaceGroups = spaceGroupDocs.map((document) => {
    const raw = document.toMutableJSON();
    return { raw, sanitized: sanitizeSpaceGroup(raw) };
  });
  const allSpaces = spaceDocs
    .map((document) => {
      const raw = document.toMutableJSON();
      return { raw, sanitized: sanitizeSpace(raw) };
    })
    .filter(
      ({ raw }) =>
        (raw.deletedAt || 0) === 0 && raw.isArchived !== true,
    );
  const liveSpaceIds = new Set(allSpaces.map(({ raw }) => raw.id));
  const allFolders = folderDocs
    .map((document) => {
      const raw = document.toMutableJSON();
      return { raw, sanitized: sanitizeFolder(raw) };
    })
    .filter(
      ({ raw }) =>
        (raw.deletedAt || 0) === 0 && liveSpaceIds.has(raw.spaceId),
    );
  const liveFolderSpaceById = new Map(
    allFolders.map(({ raw }) => [raw.id, raw.spaceId]),
  );
  const warnings: ShareSnapshotWarning[] = [];
  const allItems = itemDocs
    .map((document) => {
      const raw = document.toMutableJSON();
      return { raw, sanitized: sanitizeItem(raw, warnings) };
    })
    .filter(({ raw }) => {
      const owningSpaceId =
        liveFolderSpaceById.get(raw.folderId) ||
        raw.spaceId ||
        PUBLIC_SPACE_ID;
      return liveSpaceIds.has(owningSpaceId);
    });

  const targetSpaceIds = new Set(input.selection.spaceIds);
  for (const { raw } of allSpaces) {
    if (
      raw.spaceGroupId &&
      input.selection.spaceGroupIds.has(raw.spaceGroupId)
    ) {
      targetSpaceIds.add(raw.id);
    }
  }

  const contentFolderIds = new Set(input.selection.folderIds);
  for (const { raw } of allFolders) {
    if (targetSpaceIds.has(raw.spaceId)) contentFolderIds.add(raw.id);
  }
  const childrenByParentId = new Map<string, string[]>();
  for (const { raw } of allFolders) {
    if (!raw.parentId) continue;
    const children = childrenByParentId.get(raw.parentId) || [];
    children.push(raw.id);
    childrenByParentId.set(raw.parentId, children);
  }
  const folderExpansionQueue = Array.from(contentFolderIds);
  for (
    let index = 0;
    index < folderExpansionQueue.length;
    index += 1
  ) {
    const parentId = folderExpansionQueue[index];
    for (const childId of childrenByParentId.get(parentId) || []) {
      if (contentFolderIds.has(childId)) continue;
      contentFolderIds.add(childId);
      folderExpansionQueue.push(childId);
    }
  }

  const targetFolderIds = new Set(contentFolderIds);
  const targetItemIds = new Set(input.selection.itemIds);
  for (const { raw } of allItems) {
    if (targetItemIds.has(raw.id) && raw.folderId) {
      targetFolderIds.add(raw.folderId);
    }
  }

  const includedSpaceIds = new Set<string>();
  const includedFolders = allFolders.filter(({ raw }) => {
    if (
      !targetFolderIds.has(raw.id) ||
      !liveSpaceIds.has(raw.spaceId)
    ) {
      return false;
    }
    includedSpaceIds.add(raw.spaceId);
    return true;
  });
  const includedItems = allItems.filter(({ raw }) => {
    if (targetItemIds.has(raw.id)) return true;
    const owningSpaceId =
      liveFolderSpaceById.get(raw.folderId) ||
      raw.spaceId ||
      PUBLIC_SPACE_ID;
    if (targetSpaceIds.has(owningSpaceId)) return true;
    return raw.folderId
      ? contentFolderIds.has(raw.folderId)
      : false;
  });
  for (const { raw } of includedItems) {
    const owningSpaceId =
      liveFolderSpaceById.get(raw.folderId) ||
      raw.spaceId ||
      PUBLIC_SPACE_ID;
    if (liveSpaceIds.has(owningSpaceId)) {
      includedSpaceIds.add(owningSpaceId);
    }
  }

  const includedSpaces = allSpaces.filter(({ raw }) =>
    includedSpaceIds.has(raw.id),
  );
  const includedSpaceGroupIds = new Set(
    includedSpaces
      .map(({ raw }) => raw.spaceGroupId)
      .filter((groupId): groupId is string => Boolean(groupId)),
  );
  const includedSpaceGroups = allSpaceGroups.filter(({ raw }) =>
    includedSpaceGroupIds.has(raw.id),
  );

  const includedItemIds = new Set(
    includedItems.map(({ raw }) => raw.id),
  );
  const liveItemTagRows = itemTagDocs.map((document) =>
    document.toMutableJSON(),
  );
  const referencedTagIds = new Set(
    liveItemTagRows
      .filter((join) => includedItemIds.has(join.itemId))
      .map((join) => join.tagId),
  );
  const includedTags = tagDocs
    .map((document) => document.toMutableJSON())
    .filter((tag) => referencedTagIds.has(tag.id));
  const includedTagIds = new Set(includedTags.map((tag) => tag.id));
  const includedItemTags = liveItemTagRows.filter(
    (join) =>
      includedItemIds.has(join.itemId) && includedTagIds.has(join.tagId),
  );

  let sourceKind: ShareSnapshotV1["source"]["kind"] = "items";
  let sourceIds: string[] = [];
  const hasContainerSelection =
    input.selection.folderIds.size > 0 ||
    input.selection.spaceIds.size > 0 ||
    input.selection.spaceGroupIds.size > 0;
  if (hasContainerSelection) {
    const foldersOnly =
      input.selection.folderIds.size > 0 &&
      input.selection.spaceIds.size === 0 &&
      input.selection.spaceGroupIds.size === 0;
    if (foldersOnly) {
      sourceKind =
        includedFolders.length > 1 ? "folders" : "folder";
      sourceIds = Array.from(input.selection.folderIds);
    } else {
      sourceKind = "folders";
      sourceIds = includedFolders.map(({ raw }) => raw.id);
    }
  } else if (input.selection.itemIds.size > 0) {
    sourceIds = Array.from(input.selection.itemIds);
  }

  return {
    schemaVersion: 1,
    title: normalizeTitle(input.title, "Shared snapshot"),
    description: normalizeText(input.description, 1_000),
    createdAt: Date.now(),
    source: {
      kind: sourceKind,
      ids: sourceIds.length > 0 ? sourceIds : ["all"],
    },
    spaceGroups: includedSpaceGroups.map(({ sanitized }) => sanitized),
    spaces: includedSpaces.map(({ sanitized }) => sanitized),
    folders: includedFolders.map(({ sanitized }) => sanitized),
    items: includedItems.map(({ sanitized }) => sanitized),
    tags: includedTags.map(sanitizeTag),
    itemTags: includedItemTags.map(sanitizeItemTag),
    warnings,
  };
}

type SnapshotRowConsumer = (row: any) => void;

async function readSnapshotPages(
  collection: RxCollection<any>,
  selector: any,
  pageSize: number,
  onRow: SnapshotRowConsumer,
): Promise<void> {
  await forEachIdKeysetPage({
    collection,
    selector,
    pageSize,
    onPage: (documents) => {
      for (const document of documents) {
        onRow(document.toMutableJSON());
      }
    },
  });
}

export async function buildLocalExportSnapshot(
  payload: BuildExportSnapshotPayload = {},
  options: BuildLocalExportSnapshotOptions = {},
  dependencies: ShareSnapshotDependencies = {},
): Promise<ShareSnapshotV1> {
  const db = await (dependencies.getDb ?? getDb)();
  const maxEstimatedJsonBytes = Math.max(
    1_024,
    Math.min(
      GOOGLE_BACKUP_MAX_BYTES,
      Math.floor(
        options.maxEstimatedJsonBytes ?? GOOGLE_BACKUP_MAX_BYTES,
      ),
    ),
  );
  const pageSize = Math.max(
    1,
    Math.min(1_000, Math.floor(options.pageSize ?? 400)),
  );
  const encoder = new TextEncoder();
  let estimatedJsonBytes = Math.min(
    64 * 1024,
    Math.floor(maxEstimatedJsonBytes / 4),
  );
  const reserveRow = (row: any): void => {
    estimatedJsonBytes +=
      encoder.encode(JSON.stringify(row)).byteLength + 1;
    if (estimatedJsonBytes > maxEstimatedJsonBytes) {
      throw new Error("GOOGLE_BACKUP_TOO_LARGE");
    }
  };

  const spaceGroups: SharedSpaceGroup[] = [];
  await readSnapshotPages(
    db.space_groups,
    {},
    pageSize,
    (row: SpaceGroupDocType) => {
      const sanitized = sanitizeSpaceGroup(row);
      reserveRow(sanitized);
      spaceGroups.push(sanitized);
    },
  );

  const spaces: SharedSpace[] = [];
  await readSnapshotPages(
    db.spaces,
    { ...LIVE_SPACE_SELECTOR },
    pageSize,
    (row: SpaceDocType) => {
      if ((row.deletedAt || 0) !== 0 || row.isArchived === true) {
        return;
      }
      const sanitized = sanitizeSpace(row);
      reserveRow(sanitized);
      spaces.push(sanitized);
    },
  );
  const spaceIds = new Set(spaces.map((space) => space.id));

  const folders: SharedFolder[] = [];
  await readSnapshotPages(
    db.folders,
    {},
    pageSize,
    (row: FolderDocType) => {
      if ((row.deletedAt || 0) !== 0) return;
      const sanitized = sanitizeFolder(row);
      if (sanitized.spaceId && !spaceIds.has(sanitized.spaceId)) {
        return;
      }
      reserveRow(sanitized);
      folders.push(sanitized);
    },
  );
  const folderIds = new Set(folders.map((folder) => folder.id));

  const warnings: ShareSnapshotWarning[] = [];
  const items: SharedItem[] = [];
  await readSnapshotPages(
    db.items,
    { deletedAt: { $eq: 0 } },
    pageSize,
    (row: ItemDocType) => {
      const unavailableDestination = row.folderId
        ? !folderIds.has(row.folderId)
        : !spaceIds.has(row.spaceId || PUBLIC_SPACE_ID);
      if (unavailableDestination) return;
      const sanitized = sanitizeItem(row, warnings, {
        includeBackupMetadata: true,
      });
      reserveRow(sanitized);
      items.push(sanitized);
    },
  );
  const itemIds = new Set(items.map((item) => item.id));

  const tags: SharedTag[] = [];
  await readSnapshotPages(
    db.tags,
    {},
    pageSize,
    (row: TagDocType) => {
      const sanitized = sanitizeTag(row);
      reserveRow(sanitized);
      tags.push(sanitized);
    },
  );
  const tagIds = new Set(tags.map((tag) => tag.id));

  const itemTags: SharedItemTag[] = [];
  await readSnapshotPages(
    db.item_tags,
    {},
    pageSize,
    (row: ItemTagDocType) => {
      const sanitized = sanitizeItemTag(row);
      if (
        !itemIds.has(sanitized.itemId) ||
        !tagIds.has(sanitized.tagId)
      ) {
        return;
      }
      reserveRow(sanitized);
      itemTags.push(sanitized);
    },
  );

  const sourceIds = normalizeSourceIds(payload.source?.ids);
  const fallbackSourceIds =
    folders.length > 0
      ? folders.map((folder) => folder.id)
      : items.map((item) => item.id);
  const resolvedSourceIds =
    sourceIds.length > 0 ? sourceIds : fallbackSourceIds.slice(0, 500);

  return {
    schemaVersion: 1,
    backupMetadataVersion: 1,
    title: normalizeTitle(payload.title, "VibeSearch export"),
    description: normalizeText(payload.description, 1_000),
    createdAt: Date.now(),
    source: {
      kind:
        payload.source?.kind ||
        (folders.length > 0 ? "folders" : "items"),
      ids: resolvedSourceIds.length > 0 ? resolvedSourceIds : ["all"],
    },
    spaceGroups,
    spaces,
    folders,
    items,
    tags,
    itemTags,
    warnings,
  };
}

async function resolveTargetSpaceId(
  db: Awaited<ReturnType<typeof getDb>>,
  value?: string,
): Promise<string> {
  const candidate = (value || PUBLIC_SPACE_ID).trim() || PUBLIC_SPACE_ID;
  return (await db.spaces.findOne(candidate).exec())
    ? candidate
    : PUBLIC_SPACE_ID;
}

export async function importSharedSnapshot(
  payload: ImportSharedSnapshotPayload,
  dependencies: ShareSnapshotDependencies = {},
): Promise<ImportSharedSnapshotResult> {
  const snapshot = validateSnapshot(payload.snapshot);
  const db = await (dependencies.getDb ?? getDb)();
  const now = Date.now();
  const targetSpaceId = await resolveTargetSpaceId(
    db,
    payload.targetSpaceId,
  );
  const folderIdMap = new Map<string, string>();
  const importedFolders: FolderDocType[] = [];
  const sourceFolders = [...snapshot.folders].sort(
    (left, right) =>
      (left.sortOrder || 0) - (right.sortOrder || 0),
  );
  for (const folder of sourceFolders) {
    folderIdMap.set(folder.id, crypto.randomUUID());
  }
  let rootFolderId = "";
  for (const folder of sourceFolders) {
    const newId = folderIdMap.get(folder.id) || crypto.randomUUID();
    const parentId = folder.parentId
      ? folderIdMap.get(folder.parentId) || null
      : null;
    if (!rootFolderId && parentId === null) rootFolderId = newId;
    importedFolders.push({
      id: newId,
      name: normalizeTitle(folder.name, "Imported folder"),
      userId: "",
      spaceId: targetSpaceId,
      parentId,
      type: folder.type === "tab_group" ? "tab_group" : "folder",
      sortOrder: normalizeNumber(folder.sortOrder) ?? now,
      isLocked: false,
      isPinned: false,
      isCollapsed: false,
      deletedAt: 0,
      purgeAt: 0,
      isDirty: true,
      serverVersion: 0,
      createdAt: now,
      updatedAt: now,
    });
  }
  if (!rootFolderId) {
    const fallbackRoot: FolderDocType = {
      id: crypto.randomUUID(),
      name: normalizeTitle(
        payload.rootFolderName,
        snapshot.title || "Shared import",
      ),
      userId: "",
      spaceId: targetSpaceId,
      parentId: null,
      type: "tab_group",
      sortOrder: now,
      isLocked: false,
      isPinned: false,
      isCollapsed: false,
      deletedAt: 0,
      purgeAt: 0,
      isDirty: true,
      serverVersion: 0,
      createdAt: now,
      updatedAt: now,
    };
    importedFolders.push(fallbackRoot);
    rootFolderId = fallbackRoot.id;
  }

  const itemIdMap = new Map<string, string>();
  const importedItems = snapshot.items.map((item, index) => {
    const newId = crypto.randomUUID();
    itemIdMap.set(item.id, newId);
    const folderId = item.folderId
      ? folderIdMap.get(item.folderId) || rootFolderId
      : rootFolderId;
    return toImportedItem(
      item,
      newId,
      folderId,
      targetSpaceId,
      now + index,
    );
  });

  const tagIdMap = new Map<string, string>();
  const importedTags: TagDocType[] = [];
  for (const tag of snapshot.tags) {
    const name = normalizeEntityName(tag.name, "", 100);
    if (!name) continue;
    const existing = await db.tags
      .findOne({
        selector: {
          name: { $eq: name },
          userId: { $eq: "user1" },
        },
      })
      .exec();
    const tagId = existing?.primary || crypto.randomUUID();
    tagIdMap.set(tag.id, tagId);
    if (!existing) {
      importedTags.push({
        id: tagId,
        name,
        color: tag.color ?? null,
        userId: "user1",
        isDirty: true,
        serverVersion: 0,
        createdAt: now,
        updatedAt: now,
      });
    }
  }

  const importedItemTags: ItemTagDocType[] = [];
  for (const join of snapshot.itemTags) {
    const itemId = itemIdMap.get(join.itemId);
    const tagId = tagIdMap.get(join.tagId);
    if (!itemId || !tagId) continue;
    importedItemTags.push({
      id: `${itemId}|${tagId}`,
      itemId,
      tagId,
      userId: "user1",
      createdAt: now,
      updatedAt: now,
      deletedAt: 0,
    });
  }

  return withBinMutationLock(db, () =>
    withLiveSpaceDestination(db, targetSpaceId, async () => {
      // Re-read the destination under the same lifecycle/space lock used by
      // Bin operations before committing any live records.
      await checkedRxBulkWrite(
        "shared-import.folders",
        importedFolders,
        (rows) => db.folders.bulkInsert(rows),
      );
      await checkedRxBulkWrite(
        "shared-import.items",
        importedItems,
        (rows) => db.items.bulkInsert(rows),
      );
      await checkedRxBulkWrite(
        "shared-import.tags",
        importedTags,
        (rows) => db.tags.bulkInsert(rows),
      );
      await checkedRxBulkWrite(
        "shared-import.item-tags",
        importedItemTags,
        (rows) => db.item_tags.bulkUpsert(rows),
      );

      sendDbChange("folders");
      sendDbChange("items");
      if (importedTags.length > 0 || importedItemTags.length > 0) {
        sendDbChange("tags");
      }
      return {
        rootFolderId,
        folderCount: importedFolders.length,
        itemCount: importedItems.length,
        tagCount: importedTags.length,
      };
    }),
  );
}
