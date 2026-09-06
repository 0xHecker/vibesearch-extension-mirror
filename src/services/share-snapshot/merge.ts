import { PUBLIC_SPACE_ID } from "@src/common/spaces";
import type { FolderDocType } from "@src/schemas/folder_schema";
import type { ItemDocType } from "@src/schemas/item_schema";
import type { ItemTagDocType } from "@src/schemas/item_tag_schema";
import {
  UNGROUPED_SPACE_GROUP_ID,
  type SpaceDocType,
} from "@src/schemas/space_schema";
import type { SpaceGroupDocType } from "@src/schemas/space_group_schema";
import type { TagDocType } from "@src/schemas/tag_schema";
import { getDb } from "@src/services/DatabaseService";
import {
  withBinMutationLock,
  withStableAffectedSpaceLocks,
} from "@src/services/entity-mutation-lock";
import { checkedRxBulkWrite } from "@src/services/rxdb-bulk-write";
import {
  normalizeEntityName,
  normalizeNumber,
  normalizeText,
  normalizeTitle,
  sendDbChange,
  toImportedItem,
  validateSnapshot,
} from "@src/services/share-snapshot/codec";
import type {
  MergeBackupSnapshotResult,
  ShareSnapshotDependencies,
  ShareSnapshotV1,
  SharedFolder,
  SharedItem,
  SharedSpace,
  SharedSpaceGroup,
  SharedTag,
} from "@src/services/share-snapshot/model";
import {
  currentBackupSpaceIds,
  incomingBackupSpaceIds,
} from "@src/services/share-snapshot/space-locks";

type BackupMetadataRecord =
  | SharedSpaceGroup
  | SharedSpace
  | SharedFolder
  | SharedItem
  | SharedTag;

const hasSourceField = (
  authoritative: boolean,
  row: BackupMetadataRecord,
  field: string,
): boolean => authoritative || Object.prototype.hasOwnProperty.call(row, field);

const snapshotWarnings = (snapshot: ShareSnapshotV1): string[] => {
  const warnings: string[] = [];
  for (const warning of snapshot.warnings || []) {
    if (warning.detail) warnings.push(warning.detail);
  }
  return warnings;
};

/**
 * Merge a private backup while retaining stable IDs, so repeated restores
 * update the same records instead of creating duplicate trees.
 */
export async function mergeBackupSnapshot(
  snapshotValue: any,
  dependencies: ShareSnapshotDependencies = {},
): Promise<MergeBackupSnapshotResult> {
  const snapshot = validateSnapshot(snapshotValue);
  const db = await (dependencies.getDb ?? getDb)();
  const lifecycleSpaceIds = incomingBackupSpaceIds(snapshot);

  return withBinMutationLock(db, () =>
    withStableAffectedSpaceLocks(
      db,
      lifecycleSpaceIds,
      () => currentBackupSpaceIds(snapshot, db),
      () => mergeBackupSnapshotLocked(snapshot, db),
    ),
  );
}

async function mergeBackupSnapshotLocked(
  snapshot: ShareSnapshotV1,
  db: Awaited<ReturnType<typeof getDb>>,
): Promise<MergeBackupSnapshotResult> {
  const now = Date.now();
  const warnings = snapshotWarnings(snapshot);
  const [
    existingSpaceGroupDocs,
    existingSpaceDocs,
    existingFolderDocs,
    existingItemDocs,
    existingTagDocs,
  ] = await Promise.all([
    db.space_groups.find().exec(),
    db.spaces.find().exec(),
    db.folders.find().exec(),
    db.items.find().exec(),
    db.tags.find().exec(),
  ]);

  const existingSpaceGroups = new Map(
    existingSpaceGroupDocs.map((document) => [
      document.get("id"),
      document.toMutableJSON(),
    ]),
  );
  const existingSpaces = new Map(
    existingSpaceDocs.map((document) => [
      document.get("id"),
      document.toMutableJSON(),
    ]),
  );
  const existingFolders = new Map(
    existingFolderDocs.map((document) => [
      document.get("id"),
      document.toMutableJSON(),
    ]),
  );
  const existingItems = new Map(
    existingItemDocs.map((document) => [
      document.get("id"),
      document.toMutableJSON(),
    ]),
  );
  const existingTags = new Map(
    existingTagDocs.map((document) => [
      document.get("id"),
      document.toMutableJSON(),
    ]),
  );
  const existingTagsByName = new Map(
    Array.from(existingTags.values()).map((tag) => [
      tag.name.trim().toLowerCase(),
      tag,
    ]),
  );

  const snapshotTimestamp = normalizeNumber(snapshot.createdAt) ?? now;
  const sourceTimestamp = (updatedAt: number | undefined): number =>
    normalizeNumber(updatedAt) ?? snapshotTimestamp;
  const authoritativeMetadata = snapshot.backupMetadataVersion === 1;

  const spaceGroups: SpaceGroupDocType[] = [];
  const requestedParentByGroupId = new Map<string, string | null>();
  const seenSpaceGroupIds = new Set<string>();
  for (const source of snapshot.spaceGroups || []) {
    if (seenSpaceGroupIds.has(source.id)) {
      warnings.push(
        `Skipped duplicate space group id "${source.id}" in the backup.`,
      );
      continue;
    }
    seenSpaceGroupIds.add(source.id);
    const existing = existingSpaceGroups.get(source.id);
    const incomingUpdatedAt = sourceTimestamp(source.updatedAt);
    if (existing && existing.updatedAt > incomingUpdatedAt) continue;
    requestedParentByGroupId.set(
      source.id,
      hasSourceField(authoritativeMetadata, source, "parentGroupId")
        ? source.parentGroupId || null
        : existing?.parentGroupId || null,
    );
    spaceGroups.push({
      id: source.id,
      name: normalizeEntityName(
        source.name,
        existing?.name || "Imported group",
        80,
      ),
      sortOrder:
        normalizeNumber(source.sortOrder) ?? existing?.sortOrder ?? now,
      isCollapsed: hasSourceField(
        authoritativeMetadata,
        source,
        "isCollapsed",
      )
        ? source.isCollapsed === true
        : existing?.isCollapsed === true,
      parentGroupId: null,
      createdAt:
        existing?.createdAt ||
        normalizeNumber(source.createdAt) ||
        incomingUpdatedAt,
      updatedAt: incomingUpdatedAt,
    });
  }

  const prospectiveSpaceGroups = new Map(existingSpaceGroups);
  for (const group of spaceGroups) {
    prospectiveSpaceGroups.set(group.id, group);
  }
  for (const group of spaceGroups) {
    const parentId = requestedParentByGroupId.get(group.id) || null;
    group.parentGroupId =
      parentId &&
      parentId !== group.id &&
      prospectiveSpaceGroups.has(parentId)
        ? parentId
        : null;
    if (parentId && !group.parentGroupId) {
      warnings.push(
        `Restored space group "${group.name}" at the root because its parent is unavailable.`,
      );
    }
  }
  for (const group of spaceGroups) {
    const seen = new Set([group.id]);
    let cursor = group.parentGroupId || null;
    while (cursor) {
      if (seen.has(cursor)) {
        group.parentGroupId = null;
        warnings.push(
          `Restored space group "${group.name}" at the root to break a parent cycle.`,
        );
        break;
      }
      seen.add(cursor);
      cursor = prospectiveSpaceGroups.get(cursor)?.parentGroupId || null;
    }
  }
  await checkedRxBulkWrite(
    "backup-restore.space-groups",
    spaceGroups,
    (rows) => db.space_groups.bulkUpsert(rows),
  );

  const spaces: SpaceDocType[] = [];
  for (const source of snapshot.spaces) {
    const existing = existingSpaces.get(source.id);
    const incomingUpdatedAt = sourceTimestamp(source.updatedAt);
    if (existing && existing.updatedAt > incomingUpdatedAt) continue;
    const requestedGroupId = hasSourceField(
      authoritativeMetadata,
      source,
      "spaceGroupId",
    )
      ? source.spaceGroupId || UNGROUPED_SPACE_GROUP_ID
      : existing?.spaceGroupId || UNGROUPED_SPACE_GROUP_ID;
    const spaceGroupId = prospectiveSpaceGroups.has(requestedGroupId)
      ? requestedGroupId
      : UNGROUPED_SPACE_GROUP_ID;
    if (
      requestedGroupId !== UNGROUPED_SPACE_GROUP_ID &&
      spaceGroupId === UNGROUPED_SPACE_GROUP_ID
    ) {
      warnings.push(
        `Restored space "${source.name}" without its missing group.`,
      );
    }

    if (existing) {
      spaces.push({
        ...existing,
        name: normalizeEntityName(source.name, existing.name, 80),
        slug: normalizeText(source.slug, 120) || existing.slug,
        spaceGroupId,
        sortOrder:
          normalizeNumber(source.sortOrder) ?? existing.sortOrder,
        isArchived: false,
        deletedAt: 0,
        purgeAt: 0,
        updatedAt: incomingUpdatedAt,
      });
      continue;
    }
    if (source.isPrivate) {
      warnings.push(
        `Private space "${source.name}" was restored as public because portable backups never include credentials.`,
      );
    }
    spaces.push({
      id: source.id,
      name: normalizeEntityName(source.name, "Imported space", 80),
      slug:
        normalizeText(source.slug, 120) ||
        `imported-${source.id.slice(0, 24)}`,
      spaceGroupId,
      isPrivate: false,
      autoLockMs: 15 * 60 * 1000,
      sortOrder: normalizeNumber(source.sortOrder) ?? now,
      isArchived: false,
      deletedAt: 0,
      purgeAt: 0,
      createdAt:
        normalizeNumber(source.createdAt) || incomingUpdatedAt,
      updatedAt: incomingUpdatedAt,
    });
  }
  await checkedRxBulkWrite(
    "backup-restore.spaces",
    spaces,
    (rows) => db.spaces.bulkUpsert(rows),
  );

  const prospectiveSpaces = new Map(existingSpaces);
  for (const space of spaces) prospectiveSpaces.set(space.id, space);
  const liveSpaceIds = new Set(
    Array.from(prospectiveSpaces.values())
      .filter(
        (space) =>
          (space.deletedAt || 0) === 0 && space.isArchived !== true,
      )
      .map((space) => space.id),
  );
  const fallbackSpaceId = liveSpaceIds.has(PUBLIC_SPACE_ID)
    ? PUBLIC_SPACE_ID
    : null;

  const requestedParentByFolderId = new Map<string, string | null>();
  const folders: FolderDocType[] = [];
  const restoredFolderIds = new Set<string>();
  for (const source of snapshot.folders) {
    if (restoredFolderIds.has(source.id)) {
      warnings.push(
        `Skipped duplicate folder id "${source.id}" in the backup.`,
      );
      continue;
    }
    const existing = existingFolders.get(source.id);
    const incomingUpdatedAt = sourceTimestamp(source.updatedAt);
    if (existing && existing.updatedAt > incomingUpdatedAt) continue;
    const requestedSpaceId =
      source.spaceId || existing?.spaceId || PUBLIC_SPACE_ID;
    const spaceId = liveSpaceIds.has(requestedSpaceId)
      ? requestedSpaceId
      : fallbackSpaceId;
    if (!spaceId) {
      warnings.push(
        `Skipped folder "${source.name}" because no live destination space is available.`,
      );
      continue;
    }
    if (spaceId !== requestedSpaceId) {
      warnings.push(
        `Restored folder "${source.name}" to the default space because its destination is unavailable.`,
      );
    }

    restoredFolderIds.add(source.id);
    requestedParentByFolderId.set(
      source.id,
      hasSourceField(authoritativeMetadata, source, "parentId")
        ? source.parentId || null
        : existing?.parentId || null,
    );
    if (existing) {
      folders.push({
        ...existing,
        name: normalizeTitle(source.name, existing.name),
        spaceId,
        parentId: null,
        type: hasSourceField(authoritativeMetadata, source, "type")
          ? source.type === "tab_group"
            ? "tab_group"
            : "folder"
          : existing.type,
        sortOrder:
          normalizeNumber(source.sortOrder) ?? existing.sortOrder,
        isPinned: hasSourceField(
          authoritativeMetadata,
          source,
          "isPinned",
        )
          ? source.isPinned === true
          : existing.isPinned,
        isCollapsed: hasSourceField(
          authoritativeMetadata,
          source,
          "isCollapsed",
        )
          ? source.isCollapsed === true
          : existing.isCollapsed,
        deletedAt: 0,
        purgeAt: 0,
        isDirty: true,
        updatedAt: incomingUpdatedAt,
      });
      continue;
    }
    folders.push({
      id: source.id,
      name: normalizeTitle(source.name, "Imported folder"),
      userId: "",
      spaceId,
      parentId: null,
      type: source.type === "tab_group" ? "tab_group" : "folder",
      sortOrder: normalizeNumber(source.sortOrder) ?? now,
      isLocked: false,
      isPinned: source.isPinned === true,
      isCollapsed: source.isCollapsed === true,
      deletedAt: 0,
      purgeAt: 0,
      isDirty: true,
      serverVersion: 0,
      createdAt:
        normalizeNumber(source.createdAt) || incomingUpdatedAt,
      updatedAt: incomingUpdatedAt,
    });
  }

  const prospectiveFolders = new Map(existingFolders);
  for (const folder of folders) prospectiveFolders.set(folder.id, folder);
  const parentByFolderId = new Map<string, string | null>();
  for (const folder of folders) {
    const parentId = requestedParentByFolderId.get(folder.id) || null;
    const parent = parentId
      ? prospectiveFolders.get(parentId)
      : undefined;
    if (
      parent &&
      parent.id !== folder.id &&
      parent.spaceId === folder.spaceId &&
      (parent.deletedAt || 0) === 0
    ) {
      parentByFolderId.set(folder.id, parent.id);
      continue;
    }
    if (parentId) {
      warnings.push(
        `Restored folder "${folder.name}" at the root because its parent is unavailable or belongs to another space.`,
      );
    }
    parentByFolderId.set(folder.id, null);
  }
  for (const folder of folders) {
    const seen = new Set<string>([folder.id]);
    let cursor = parentByFolderId.get(folder.id) || null;
    let cyclic = false;
    while (cursor) {
      if (seen.has(cursor)) {
        cyclic = true;
        break;
      }
      seen.add(cursor);
      cursor = parentByFolderId.has(cursor)
        ? parentByFolderId.get(cursor) || null
        : prospectiveFolders.get(cursor)?.parentId || null;
    }
    if (cyclic) {
      parentByFolderId.set(folder.id, null);
      warnings.push(
        `Restored folder "${folder.name}" at the root to break a parent cycle.`,
      );
    }
    folder.parentId = parentByFolderId.get(folder.id) || null;
  }
  await checkedRxBulkWrite(
    "backup-restore.folders",
    folders,
    (rows) => db.folders.bulkUpsert(rows),
  );

  for (const folder of folders) prospectiveFolders.set(folder.id, folder);
  const liveFolderCache = new Map<string, boolean>();
  const isLiveFolderDestination = (folderId: string): boolean => {
    const known = liveFolderCache.get(folderId);
    if (known !== undefined) return known;
    const path: string[] = [];
    const seen = new Set<string>();
    let cursor: string | null = folderId;
    let live = true;
    let expectedSpaceId = "";
    while (cursor) {
      const cached = liveFolderCache.get(cursor);
      if (cached !== undefined) {
        live = cached;
        break;
      }
      if (seen.has(cursor)) {
        live = false;
        break;
      }
      seen.add(cursor);
      const folder = prospectiveFolders.get(cursor);
      if (
        !folder ||
        (folder.deletedAt || 0) !== 0 ||
        !liveSpaceIds.has(folder.spaceId) ||
        (expectedSpaceId && folder.spaceId !== expectedSpaceId)
      ) {
        live = false;
        break;
      }
      expectedSpaceId = folder.spaceId;
      path.push(cursor);
      cursor = folder.parentId || null;
    }
    for (const id of path) liveFolderCache.set(id, live);
    if (path.length === 0) liveFolderCache.set(folderId, live);
    return live;
  };

  const items: ItemDocType[] = [];
  const restoredOrRetainedItemIds = new Set<string>();
  const isLiveItemDestination = (item: ItemDocType): boolean =>
    item.folderId
      ? isLiveFolderDestination(item.folderId)
      : liveSpaceIds.has(item.spaceId || PUBLIC_SPACE_ID);
  for (const source of snapshot.items) {
    const existing = existingItems.get(source.id);
    const requestedFolderId =
      source.folderId ?? existing?.folderId ?? "";
    const folderId =
      requestedFolderId &&
      isLiveFolderDestination(requestedFolderId)
        ? requestedFolderId
        : "";
    const destinationFolder = folderId
      ? prospectiveFolders.get(folderId)
      : undefined;
    const requestedSpaceId =
      destinationFolder?.spaceId ||
      source.spaceId ||
      existing?.spaceId ||
      PUBLIC_SPACE_ID;
    const spaceId = destinationFolder
      ? destinationFolder.spaceId
      : liveSpaceIds.has(requestedSpaceId)
        ? requestedSpaceId
        : fallbackSpaceId;
    if (!spaceId) {
      warnings.push(
        `Skipped item "${source.title}" because its destination space is not live.`,
      );
      continue;
    }
    if (requestedFolderId && !folderId) {
      warnings.push(
        `Restored item "${source.title}" at the space root because its folder is unavailable.`,
      );
    }

    const incoming = toImportedItem(
      source,
      source.id,
      folderId,
      spaceId,
      now,
    );
    const incomingUpdatedAt = sourceTimestamp(source.updatedAt);
    if (existing && existing.updatedAt > incomingUpdatedAt) {
      if (
        (existing.deletedAt || 0) === 0 &&
        isLiveItemDestination(existing)
      ) {
        restoredOrRetainedItemIds.add(existing.id);
      }
      continue;
    }
    const restored: ItemDocType = {
      ...incoming,
      userId: existing?.userId || incoming.userId,
      createdAt: existing?.createdAt || incoming.createdAt,
      updatedAt: incomingUpdatedAt,
      vector_index: -1,
      vector_indexes: [],
      isEmbedded: false,
      isDirty: false,
    };
    if (existing) {
      if (!hasSourceField(authoritativeMetadata, source, "isFavorite")) {
        restored.isFavorite = existing.isFavorite;
      }
      if (!hasSourceField(authoritativeMetadata, source, "type")) {
        restored.type = existing.type;
      }
      if (!hasSourceField(authoritativeMetadata, source, "fields")) {
        restored.fields = existing.fields;
      }
      if (!hasSourceField(authoritativeMetadata, source, "blocks")) {
        restored.blocks = existing.blocks;
      }
      if (!hasSourceField(authoritativeMetadata, source, "blobs")) {
        restored.blobs = existing.blobs;
      }
      if (!hasSourceField(authoritativeMetadata, source, "summary")) {
        restored.summary = existing.summary;
      }
      if (!hasSourceField(authoritativeMetadata, source, "ai")) {
        restored.ai = existing.ai;
      }
      if (!hasSourceField(authoritativeMetadata, source, "parentId")) {
        restored.parentId = existing.parentId;
      }
      if (!hasSourceField(authoritativeMetadata, source, "chunkOrder")) {
        restored.chunkOrder = existing.chunkOrder;
      }
    }
    items.push(restored);
    restoredOrRetainedItemIds.add(source.id);
  }
  await checkedRxBulkWrite(
    "backup-restore.items",
    items,
    (rows) => db.items.bulkUpsert(rows),
  );

  const tagIdMap = new Map<string, string>();
  const tagsByTargetId = new Map<string, TagDocType>();
  for (const source of snapshot.tags) {
    const name = normalizeEntityName(source.name, "", 100);
    if (!name) continue;
    const existing =
      existingTags.get(source.id) ||
      existingTagsByName.get(name.toLowerCase());
    const tagId = existing?.id || source.id;
    tagIdMap.set(source.id, tagId);
    const incomingUpdatedAt = sourceTimestamp(source.updatedAt);
    if (existing && existing.updatedAt > incomingUpdatedAt) continue;
    const restoredTag: TagDocType = {
      id: tagId,
      name,
      userId: existing?.userId || "user1",
      isDirty: true,
      serverVersion: existing?.serverVersion || 0,
      color: hasSourceField(authoritativeMetadata, source, "color")
        ? normalizeText(source.color, 32) || null
        : existing?.color || null,
      isFavorite: hasSourceField(
        authoritativeMetadata,
        source,
        "isFavorite",
      )
        ? source.isFavorite === true
        : existing?.isFavorite === true,
      createdAt:
        existing?.createdAt ||
        normalizeNumber(source.createdAt) ||
        incomingUpdatedAt,
      updatedAt: incomingUpdatedAt,
    };
    const previous = tagsByTargetId.get(tagId);
    if (!previous || restoredTag.updatedAt > previous.updatedAt) {
      tagsByTargetId.set(tagId, restoredTag);
    }
  }
  const tags = Array.from(tagsByTargetId.values());
  await checkedRxBulkWrite(
    "backup-restore.tags",
    tags,
    (rows) => db.tags.bulkUpsert(rows),
  );

  const itemTagsById = new Map<string, ItemTagDocType>();
  for (const source of snapshot.itemTags) {
    const tagId = tagIdMap.get(source.tagId);
    if (!restoredOrRetainedItemIds.has(source.itemId) || !tagId) {
      continue;
    }
    const row: ItemTagDocType = {
      id: `${source.itemId}|${tagId}`,
      itemId: source.itemId,
      tagId,
      userId: "user1",
      createdAt: now,
      updatedAt: now,
      deletedAt: 0,
    };
    itemTagsById.set(row.id, row);
  }
  const itemTags = Array.from(itemTagsById.values());
  await checkedRxBulkWrite(
    "backup-restore.item-tags",
    itemTags,
    (rows) => db.item_tags.bulkUpsert(rows),
  );

  sendDbChange("spaces");
  sendDbChange("folders");
  if (items.length > 0) sendDbChange("items");
  if (tags.length > 0 || itemTags.length > 0) sendDbChange("tags");

  return {
    spaceCount: spaces.length,
    folderCount: folders.length,
    itemCount: items.length,
    tagCount: tags.length,
    warnings,
  };
}
