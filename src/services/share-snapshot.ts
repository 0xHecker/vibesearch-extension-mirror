import { getDb } from "@src/services/DatabaseService";
import type { FolderDocType } from "@src/schemas/folder_schema";
import type { ItemDocType, MediaOcrMetadata } from "@src/schemas/item_schema";
import type { ItemTagDocType } from "@src/schemas/item_tag_schema";
import { UNGROUPED_SPACE_GROUP_ID, type SpaceDocType } from "@src/schemas/space_schema";
import type { SpaceGroupDocType } from "@src/schemas/space_group_schema";
import type { TagDocType } from "@src/schemas/tag_schema";
import { LIVE_SPACE_SELECTOR, PUBLIC_SPACE_ID } from "@src/common/spaces";
import {
  withBinMutationLock,
  withStableAffectedSpaceLocks,
} from "@src/services/entity-mutation-lock";
import {
  withLiveSpaceDestination,
} from "@src/services/live-destination";
import { checkedRxBulkWrite } from "@src/services/rxdb-bulk-write";
import { forEachIdKeysetPage } from "@src/services/rxdb-keyset-pagination";
import { GOOGLE_BACKUP_MAX_BYTES } from "@src/services/google-backup-limits";

export type ShareSourceKind = "folder" | "folders" | "items";

export type SharedMedia = {
  id?: string;
  type: "image" | "video" | "audio" | "file";
  originalUrl?: string;
  storageType: "hotlink" | "s3";
  s3Url?: string;
  s3ThumbnailUrl?: string;
  embedUrl?: string;
  embedType?: "iframe";
  thumbnailUrl?: string;
  mimeType?: string;
  fileName?: string;
  byteSize?: number;
  contentHash?: string;
  durationSec?: number;
  provider?: string;
  externalId?: string;
  altText?: string;
  titleText?: string;
  ariaLabel?: string;
  pageUrl?: string;
  pageTitle?: string;
  siteName?: string;
  faviconUrl?: string;
  width?: number;
  height?: number;
  capturedAt?: number;
  ocr?: Omit<MediaOcrMetadata, "sourceHash" | "modelVersion" | "error">;
};

export type SharedItem = {
  id: string;
  title: string;
  textContent?: string;
  ocrText?: string;
  url: string;
  source: ItemDocType["source"];
  folderId?: string;
  spaceId?: string;
  authorUsername?: string;
  likes?: number;
  upvotes?: number;
  media?: SharedMedia[];
  iconUrl?: string;
  displayImageUrl?: string;
  createdAt?: number;
  updatedAt?: number;
  /** Present only in the user's private portable backup, never public shares. */
  isFavorite?: boolean;
  type?: ItemDocType["type"];
  fields?: ItemDocType["fields"];
  blocks?: ItemDocType["blocks"];
  blobs?: ItemDocType["blobs"];
  summary?: ItemDocType["summary"];
  ai?: ItemDocType["ai"];
  parentId?: string | null;
  chunkOrder?: number;
};

export type SharedFolder = {
  id: string;
  name: string;
  spaceId?: string;
  parentId?: string | null;
  type?: "folder" | "tab_group";
  sortOrder?: number;
  isPinned?: boolean;
  isCollapsed?: boolean;
  createdAt?: number;
  updatedAt?: number;
};

export type SharedSpace = {
  id: string;
  name: string;
  slug?: string;
  spaceGroupId?: string | null;
  sortOrder?: number;
  isPrivate?: boolean;
  createdAt?: number;
  updatedAt?: number;
};

export type SharedSpaceGroup = Pick<
  SpaceGroupDocType,
  "id" | "name" | "sortOrder" | "isCollapsed" | "parentGroupId" | "createdAt" | "updatedAt"
>;

export type SharedTag = {
  id: string;
  name: string;
  color?: string | null;
  isFavorite?: boolean;
  createdAt?: number;
  updatedAt?: number;
};

export type SharedItemTag = {
  itemId: string;
  tagId: string;
};

export type ShareSnapshotWarning = {
  code: string;
  itemId?: string;
  detail?: string;
};

export type ShareSnapshotV1 = {
  schemaVersion: 1;
  /** Marks snapshots built by the private backup exporter with rich metadata semantics. */
  backupMetadataVersion?: 1;
  title: string;
  description?: string;
  createdAt: number;
  source: {
    kind: ShareSourceKind;
    ids: string[];
  };
  spaceGroups?: SharedSpaceGroup[];
  spaces: SharedSpace[];
  folders: SharedFolder[];
  items: SharedItem[];
  tags: SharedTag[];
  itemTags: SharedItemTag[];
  warnings?: ShareSnapshotWarning[];
};

export type BuildExportSnapshotPayload = {
  title?: string;
  description?: string;
  source?: {
    kind?: ShareSourceKind;
    ids?: string[];
  };
};

export type BuildLocalExportSnapshotOptions = {
  /** Test/diagnostic override; production never exceeds the Drive file limit. */
  maxEstimatedJsonBytes?: number;
  pageSize?: number;
};

export type ImportSharedSnapshotPayload = {
  snapshot: ShareSnapshotV1;
  targetSpaceId?: string;
  rootFolderName?: string;
};

export type ImportSharedSnapshotResult = {
  rootFolderId: string;
  folderCount: number;
  itemCount: number;
  tagCount: number;
};

export type MergeBackupSnapshotResult = {
  spaceCount: number;
  folderCount: number;
  itemCount: number;
  tagCount: number;
  warnings: string[];
};

const addSpaceId = (spaceIds: Set<string>, value: unknown): void => {
  if (typeof value !== "string") return;
  const id = value.trim();
  if (id) spaceIds.add(id);
};

const findDocsByIds = async (collection: any, ids: Iterable<string>): Promise<any[]> => {
  const uniqueIds = Array.from(new Set(ids)).filter(Boolean);
  const documents: any[] = [];
  const batchSize = 200;
  for (let offset = 0; offset < uniqueIds.length; offset += batchSize) {
    const batch = uniqueIds.slice(offset, offset + batchSize);
    const batchSet = new Set(batch);
    const rows = await collection
      .find({ selector: { id: { $in: batch } } })
      .exec();
    // Keep the post-filter because simple test adapters and older RxDB query
    // planners may return a broader result for a large `$in` expression.
    for (const row of rows) {
      const id = row.get("id") as string | undefined;
      if (id && batchSet.has(id)) documents.push(row);
    }
  }
  return documents;
};

const incomingBackupSpaceIds = (snapshot: ShareSnapshotV1): Set<string> => {
  const ids = new Set<string>([PUBLIC_SPACE_ID]);
  for (const space of snapshot.spaces) addSpaceId(ids, space.id);
  for (const folder of snapshot.folders) addSpaceId(ids, folder.spaceId);
  for (const item of snapshot.items) addSpaceId(ids, item.spaceId);
  return ids;
};

const currentBackupSpaceIds = async (
  snapshot: ShareSnapshotV1,
  db: Awaited<ReturnType<typeof getDb>>
): Promise<Set<string>> => {
  const ids = new Set<string>();
  const folderIds = new Set<string>();
  for (const folder of snapshot.folders) folderIds.add(folder.id);
  for (const item of snapshot.items) {
    if (item.folderId) folderIds.add(item.folderId);
  }

  const itemDocs = await findDocsByIds(
    db.items,
    snapshot.items.map((item) => item.id)
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

const SOURCE_VALUES = new Set<ItemDocType["source"]>([
  "web",
  "twitter",
  "reddit",
  "note",
  "youtube",
  "instagram",
  "tiktok",
  "substack",
  "linkedin",
  "github",
  "article",
]);

export type MixedShareSelection = {
  folderIds: Set<string>;
  itemIds: Set<string>;
  spaceIds: Set<string>;
  spaceGroupIds: Set<string>;
};

export type BuildShareFromMixedInput = {
  selection: MixedShareSelection;
  title?: string;
  description?: string;
};

/**
 * Builds a sanitized snapshot from any combination of selected folders,
 * items, spaces, and space groups. Spaces and space groups expand to the
 * folders inside them; selected items pull in their owning folders as
 * lightweight containers.
 */
export async function buildShareSnapshotFromMixed(
  input: BuildShareFromMixedInput
): Promise<ShareSnapshotV1> {
  const db = await getDb();
  const [spaceGroupDocs, spaceDocs, folderDocs, itemDocs, tagDocs, itemTagDocs] = await Promise.all([
    db.space_groups.find().exec(),
    db.spaces.find({ selector: { ...LIVE_SPACE_SELECTOR } }).exec(),
    db.folders.find().exec(),
    db.items.find({ selector: { deletedAt: { $eq: 0 } } }).exec(),
    db.tags.find().exec(),
    db.item_tags.find().exec(),
  ]);

  const allSpaceGroups = spaceGroupDocs.map((doc) => ({
    raw: doc.toMutableJSON() as SpaceGroupDocType,
    sanitized: sanitizeSpaceGroup(doc.toMutableJSON() as SpaceGroupDocType),
  }));
  const allSpaces = spaceDocs
    .map((doc) => ({
      raw: doc.toMutableJSON() as SpaceDocType,
      sanitized: sanitizeSpace(doc.toMutableJSON() as SpaceDocType),
    }))
    .filter((space) => (space.raw.deletedAt || 0) === 0 && space.raw.isArchived !== true);
  const liveSpaceIds = new Set(allSpaces.map((space) => space.raw.id));
  const allFolders = folderDocs
    .map((doc) => ({
      raw: doc.toMutableJSON() as FolderDocType,
      sanitized: sanitizeFolder(doc.toMutableJSON() as FolderDocType),
    }))
    .filter(
      (folder) =>
        (folder.raw.deletedAt || 0) === 0 && liveSpaceIds.has(folder.raw.spaceId)
    );
  const liveFolderSpaceById = new Map(
    allFolders.map((folder) => [folder.raw.id, folder.raw.spaceId])
  );
  const warnings: ShareSnapshotWarning[] = [];
  const allItems = itemDocs
    .map((doc) => ({
      raw: doc.toMutableJSON() as ItemDocType,
      sanitized: sanitizeItem(doc.toMutableJSON() as ItemDocType, warnings),
    }))
    .filter((item) => {
      const owningSpaceId =
        liveFolderSpaceById.get(item.raw.folderId) || item.raw.spaceId || PUBLIC_SPACE_ID;
      return liveSpaceIds.has(owningSpaceId);
    });

  // Resolve spaces and space groups to a set of target space ids.
  const targetSpaceIds = new Set<string>();
  for (const spaceId of input.selection.spaceIds) {
    targetSpaceIds.add(spaceId);
  }
  for (const space of allSpaces) {
    if (space.raw.spaceGroupId && input.selection.spaceGroupIds.has(space.raw.spaceGroupId)) {
      targetSpaceIds.add(space.raw.id);
    }
  }

  // Resolve folders whose contents are explicitly selected.
  const contentFolderIds = new Set<string>();
  for (const folderId of input.selection.folderIds) contentFolderIds.add(folderId);
  for (const folder of allFolders) {
    if (targetSpaceIds.has(folder.raw.spaceId)) contentFolderIds.add(folder.raw.id);
  }
  const childrenByParentId = new Map<string, string[]>();
  for (const folder of allFolders) {
    if (!folder.raw.parentId) continue;
    const children = childrenByParentId.get(folder.raw.parentId) || [];
    children.push(folder.raw.id);
    childrenByParentId.set(folder.raw.parentId, children);
  }
  const folderExpansionQueue = Array.from(contentFolderIds);
  for (let index = 0; index < folderExpansionQueue.length; index += 1) {
    for (const childId of childrenByParentId.get(folderExpansionQueue[index]) || []) {
      if (contentFolderIds.has(childId)) continue;
      contentFolderIds.add(childId);
      folderExpansionQueue.push(childId);
    }
  }

  // Resolve all folder ids included in the snapshot: content folders plus
  // lightweight containers for directly selected items.
  const targetFolderIds = new Set<string>();
  for (const folderId of contentFolderIds) targetFolderIds.add(folderId);

  // Resolve directly selected item ids.
  const targetItemIds = new Set<string>();
  for (const itemId of input.selection.itemIds) targetItemIds.add(itemId);

  // Include parent folders of directly-selected items so they don't render orphaned.
  for (const item of allItems) {
    if (targetItemIds.has(item.raw.id) && item.raw.folderId) {
      targetFolderIds.add(item.raw.folderId);
    }
  }

  // Filter folders: must be in target set AND in a non-archived space.
  const includedSpaceIds = new Set<string>();
  const includedFolders = allFolders.filter((folder) => {
    if (!targetFolderIds.has(folder.raw.id)) return false;
    if (!liveSpaceIds.has(folder.raw.spaceId)) return false;
    includedSpaceIds.add(folder.raw.spaceId);
    return true;
  });

  // Items: directly selected + items whose folder contents are included.
  const includedItems = allItems.filter((item) => {
    if (targetItemIds.has(item.raw.id)) {
      if (item.raw.folderId && targetFolderIds.has(item.raw.folderId)) return true;
      // Item selected but its folder wasn't resolved — keep it anyway with undefined folderId.
      return true;
    }
    const owningSpaceId =
      liveFolderSpaceById.get(item.raw.folderId) || item.raw.spaceId || PUBLIC_SPACE_ID;
    if (targetSpaceIds.has(owningSpaceId)) return true;
    return item.raw.folderId ? contentFolderIds.has(item.raw.folderId) : false;
  });

  for (const item of includedItems) {
    const owningSpaceId =
      liveFolderSpaceById.get(item.raw.folderId) || item.raw.spaceId || PUBLIC_SPACE_ID;
    if (liveSpaceIds.has(owningSpaceId)) includedSpaceIds.add(owningSpaceId);
  }

  // Spaces: any space that owns an included folder.
  const includedSpaces = allSpaces.filter((space) => includedSpaceIds.has(space.raw.id));

  // Space groups: any group referenced by an included space.
  const includedSpaceGroupIds = new Set<string>();
  for (const space of includedSpaces) {
    if (space.raw.spaceGroupId) includedSpaceGroupIds.add(space.raw.spaceGroupId);
  }
  const includedSpaceGroups = allSpaceGroups.filter((group) =>
    includedSpaceGroupIds.has(group.raw.id)
  );

  // Tags + itemTags: only for included items.
  const includedItemIds = new Set(includedItems.map((item) => item.raw.id));
  const liveItemTagRows = itemTagDocs.map((doc) => doc.toMutableJSON() as ItemTagDocType);
  const referencedTagIds = new Set(
    liveItemTagRows
      .filter((join) => includedItemIds.has(join.itemId))
      .map((join) => join.tagId),
  );
  const includedTagsRaw = tagDocs
    .map((doc) => doc.toMutableJSON() as TagDocType)
    .filter((tag) => referencedTagIds.has(tag.id));
  const includedTagIds = new Set(includedTagsRaw.map((tag) => tag.id));
  const includedItemTags = liveItemTagRows
    .filter((join) => includedItemIds.has(join.itemId) && includedTagIds.has(join.tagId));

  // Derive source kind + source ids for the share record.
  let sourceKind: ShareSourceKind = "items";
  let sourceIds: string[] = [];
  if (input.selection.folderIds.size > 0 || input.selection.spaceIds.size > 0 || input.selection.spaceGroupIds.size > 0) {
    if (input.selection.folderIds.size > 0 && input.selection.spaceIds.size === 0 && input.selection.spaceGroupIds.size === 0) {
      sourceKind = includedFolders.length > 1 ? "folders" : "folder";
      sourceIds = Array.from(input.selection.folderIds);
    } else {
      // Mixed scope or space/group-driven — label as folders with the resolved folder ids.
      sourceKind = "folders";
      sourceIds = includedFolders.map((folder) => folder.raw.id);
    }
  } else if (input.selection.itemIds.size > 0) {
    sourceKind = "items";
    sourceIds = Array.from(input.selection.itemIds);
  }

  return {
    schemaVersion: 1,
    title: normalizeTitle(input.title, "Shared snapshot"),
    description: normalizeText(input.description, 1000),
    createdAt: Date.now(),
    source: {
      kind: sourceKind,
      ids: sourceIds.length > 0 ? sourceIds : ["all"],
    },
    spaceGroups: includedSpaceGroups.map((group) => group.sanitized),
    spaces: includedSpaces.map((space) => space.sanitized),
    folders: includedFolders.map((folder) => folder.sanitized),
    items: includedItems.map((item) => item.sanitized),
    tags: includedTagsRaw.map((tag) => sanitizeTag(tag)),
    itemTags: includedItemTags.map((join) => sanitizeItemTag(join)),
    warnings,
  };
}

export async function buildLocalExportSnapshot(
  payload: BuildExportSnapshotPayload = {},
  options: BuildLocalExportSnapshotOptions = {},
): Promise<ShareSnapshotV1> {
  const db = await getDb();
  const maxEstimatedJsonBytes = Math.max(
    1_024,
    Math.min(
      GOOGLE_BACKUP_MAX_BYTES,
      Math.floor(options.maxEstimatedJsonBytes ?? GOOGLE_BACKUP_MAX_BYTES),
    ),
  );
  const pageSize = Math.max(1, Math.min(1_000, Math.floor(options.pageSize ?? 400)));
  const encoder = new TextEncoder();
  let estimatedJsonBytes = Math.min(64 * 1024, Math.floor(maxEstimatedJsonBytes / 4));
  const reserveRow = (row: unknown): void => {
    estimatedJsonBytes += encoder.encode(JSON.stringify(row)).byteLength + 1;
    if (estimatedJsonBytes > maxEstimatedJsonBytes) {
      throw new Error("GOOGLE_BACKUP_TOO_LARGE");
    }
  };
  const readPages = async (
    collection: any,
    selector: Record<string, unknown>,
    onRow: (row: any) => void,
  ): Promise<void> => {
    await forEachIdKeysetPage({
      collection,
      selector,
      pageSize,
      onPage: (documents) => {
        for (const document of documents) {
          onRow((document as { toMutableJSON(): unknown }).toMutableJSON());
        }
      },
    });
  };

  // Keep only one bounded RxDB page alive at a time. Each sanitized row is
  // charged against the final Drive JSON budget before it joins the retained
  // snapshot, preventing a post-materialization OOM on oversized libraries.
  const spaceGroups: SharedSpaceGroup[] = [];
  await readPages(db.space_groups, {}, (row: SpaceGroupDocType) => {
    const sanitized = sanitizeSpaceGroup(row);
    reserveRow(sanitized);
    spaceGroups.push(sanitized);
  });

  const spaces: SharedSpace[] = [];
  await readPages(db.spaces, { ...LIVE_SPACE_SELECTOR }, (row: SpaceDocType) => {
    if ((row.deletedAt || 0) !== 0 || row.isArchived === true) return;
    const sanitized = sanitizeSpace(row);
    reserveRow(sanitized);
    spaces.push(sanitized);
  });
  const spaceIds = new Set(spaces.map((space) => space.id));

  const folders: SharedFolder[] = [];
  await readPages(db.folders, {}, (row: FolderDocType) => {
    if ((row.deletedAt || 0) !== 0) return;
    const sanitized = sanitizeFolder(row);
    if (sanitized.spaceId && !spaceIds.has(sanitized.spaceId)) return;
    reserveRow(sanitized);
    folders.push(sanitized);
  });
  const folderIds = new Set(folders.map((folder) => folder.id));

  const warnings: ShareSnapshotWarning[] = [];
  const items: SharedItem[] = [];
  await readPages(db.items, { deletedAt: { $eq: 0 } }, (row: ItemDocType) => {
    if (row.folderId ? !folderIds.has(row.folderId) : !spaceIds.has(row.spaceId || PUBLIC_SPACE_ID)) {
      return;
    }
    const sanitized = sanitizeItem(row, warnings, { includeBackupMetadata: true });
    reserveRow(sanitized);
    items.push(sanitized);
  });
  const itemIds = new Set(items.map((item) => item.id));

  const tags: SharedTag[] = [];
  await readPages(db.tags, {}, (row: TagDocType) => {
    const sanitized = sanitizeTag(row);
    reserveRow(sanitized);
    tags.push(sanitized);
  });
  const tagIds = new Set(tags.map((tag) => tag.id));
  const itemTags: SharedItemTag[] = [];
  await readPages(db.item_tags, {}, (row: ItemTagDocType) => {
    const sanitized = sanitizeItemTag(row);
    if (!itemIds.has(sanitized.itemId) || !tagIds.has(sanitized.tagId)) return;
    reserveRow(sanitized);
    itemTags.push(sanitized);
  });

  const sourceIds = normalizeSourceIds(payload.source?.ids);
  const fallbackSourceIds = folders.length > 0 ? folders.map((folder) => folder.id) : items.map((item) => item.id);
  const resolvedSourceIds = sourceIds.length > 0 ? sourceIds : fallbackSourceIds.slice(0, 500);

  return {
    schemaVersion: 1,
    backupMetadataVersion: 1,
    title: normalizeTitle(payload.title, "VibeSearch export"),
    description: normalizeText(payload.description, 1000),
    createdAt: Date.now(),
    source: {
      kind: payload.source?.kind || (folders.length > 0 ? "folders" : "items"),
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

export async function importSharedSnapshot(
  payload: ImportSharedSnapshotPayload
): Promise<ImportSharedSnapshotResult> {
  const snapshot = validateSnapshot(payload.snapshot);
  const db = await getDb();
  const now = Date.now();
  const targetSpaceId = await resolveTargetSpaceId(db, payload.targetSpaceId);
  const folderIdMap = new Map<string, string>();
  const importedFolders: FolderDocType[] = [];
  const sourceFolders = [...snapshot.folders].sort((a, b) => (a.sortOrder || 0) - (b.sortOrder || 0));
  for (const folder of sourceFolders) {
    folderIdMap.set(folder.id, crypto.randomUUID());
  }
  let rootFolderId = "";
  for (const folder of sourceFolders) {
    const newId = folderIdMap.get(folder.id) || crypto.randomUUID();
    const parentId = folder.parentId ? folderIdMap.get(folder.parentId) || null : null;
    if (!rootFolderId && parentId === null) rootFolderId = newId;
    importedFolders.push({
      id: newId,
      name: normalizeTitle(folder.name, "Imported folder"),
      userId: "",
      spaceId: targetSpaceId,
      parentId,
      type: folder.type === "tab_group" ? "tab_group" : "folder",
      sortOrder: Number.isFinite(folder.sortOrder) ? Math.max(0, Math.floor(folder.sortOrder as number)) : now,
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
      name: normalizeTitle(payload.rootFolderName, snapshot.title || "Shared import"),
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
    const folderId = item.folderId ? folderIdMap.get(item.folderId) || rootFolderId : rootFolderId;
    return toImportedItem(item, newId, folderId, targetSpaceId, now + index);
  });

  const tagIdMap = new Map<string, string>();
  const importedTags: TagDocType[] = [];
  for (const tag of snapshot.tags) {
    const name = normalizeEntityName(tag.name, "", 100);
    if (!name) continue;
    const existing = await db.tags.findOne({ selector: { name: { $eq: name }, userId: { $eq: "user1" } } }).exec();
    const tagId = existing ? (existing.get("id") as string) : crypto.randomUUID();
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

  const importedItemTags = snapshot.itemTags
    .map((join) => {
      const itemId = itemIdMap.get(join.itemId);
      const tagId = tagIdMap.get(join.tagId);
      if (!itemId || !tagId) return null;
      return {
        id: `${itemId}|${tagId}`,
        itemId,
        tagId,
        userId: "user1",
        createdAt: now,
        updatedAt: now,
        deletedAt: 0,
      } as ItemTagDocType;
    })
    .filter((join): join is ItemTagDocType => join !== null);

  return withBinMutationLock(db, () =>
    withLiveSpaceDestination(db, targetSpaceId, async () => {
      // The target is resolved once for UX fallback, then re-read under the
      // same lifecycle/space lock used by Bin operations. A space that was
      // binned or archived while the snapshot was prepared must not receive
      // new live folders or items.
      await checkedRxBulkWrite(
        "shared-import.folders",
        importedFolders,
        (rows) => db.folders.bulkInsert(rows)
      );
      await checkedRxBulkWrite(
        "shared-import.items",
        importedItems,
        (rows) => db.items.bulkInsert(rows)
      );
      await checkedRxBulkWrite(
        "shared-import.tags",
        importedTags,
        (rows) => db.tags.bulkInsert(rows)
      );
      await checkedRxBulkWrite(
        "shared-import.item-tags",
        importedItemTags,
        (rows) => db.item_tags.bulkUpsert(rows)
      );

      sendDbChange("folders");
      sendDbChange("items");
      if (importedTags.length > 0 || importedItemTags.length > 0) sendDbChange("tags");

      return {
        rootFolderId,
        folderCount: importedFolders.length,
        itemCount: importedItems.length,
        tagCount: importedTags.length,
      };
    })
  );
}

/**
 * Merges a snapshot produced by the user's own backup into the current
 * extension origin. Unlike a shared-link import, IDs are retained so repeating
 * a restore updates the same records instead of creating duplicate folders.
 */
export async function mergeBackupSnapshot(
  snapshotValue: unknown
): Promise<MergeBackupSnapshotResult> {
  const snapshot = validateSnapshot(snapshotValue);
  const db = await getDb();
  const lifecycleSpaceIds = incomingBackupSpaceIds(snapshot);

  return withBinMutationLock(db, () =>
    withStableAffectedSpaceLocks(
      db,
      lifecycleSpaceIds,
      () => currentBackupSpaceIds(snapshot, db),
      () =>
      mergeBackupSnapshotLocked(snapshot, db)
    )
  );
}

async function mergeBackupSnapshotLocked(
  snapshot: ShareSnapshotV1,
  db: Awaited<ReturnType<typeof getDb>>
): Promise<MergeBackupSnapshotResult> {
  const now = Date.now();
  const warnings: string[] = (snapshot.warnings || [])
    .map((warning) => warning.detail)
    .filter((detail): detail is string => typeof detail === "string" && detail.length > 0);

  const [existingSpaceGroupDocs, existingSpaceDocs, existingFolderDocs, existingItemDocs, existingTagDocs] =
    await Promise.all([
      db.space_groups.find().exec(),
      db.spaces.find().exec(),
      db.folders.find().exec(),
      db.items.find().exec(),
      db.tags.find().exec(),
    ]);

  const existingSpaceGroups = new Map(
    existingSpaceGroupDocs.map((doc) => [
      doc.get("id") as string,
      doc.toMutableJSON() as SpaceGroupDocType,
    ])
  );
  const existingSpaces = new Map(
    existingSpaceDocs.map((doc) => [doc.get("id") as string, doc.toMutableJSON() as SpaceDocType])
  );
  const existingFolders = new Map(
    existingFolderDocs.map((doc) => [doc.get("id") as string, doc.toMutableJSON() as FolderDocType])
  );
  const existingItems = new Map(
    existingItemDocs.map((doc) => [doc.get("id") as string, doc.toMutableJSON() as ItemDocType])
  );
  const existingTags = new Map(
    existingTagDocs.map((doc) => [doc.get("id") as string, doc.toMutableJSON() as TagDocType])
  );
  const existingTagsByName = new Map(
    Array.from(existingTags.values()).map((tag) => [tag.name.trim().toLowerCase(), tag])
  );

  const snapshotTimestamp = normalizeNumber(snapshot.createdAt) ?? now;
  const sourceTimestamp = (updatedAt: unknown): number =>
    normalizeNumber(updatedAt) ?? snapshotTimestamp;
  const authoritativeBackupMetadata = snapshot.backupMetadataVersion === 1;
  const useSourceField = (row: object, field: string): boolean =>
    authoritativeBackupMetadata || Object.prototype.hasOwnProperty.call(row, field);

  const spaceGroups: SpaceGroupDocType[] = [];
  const requestedParentByGroupId = new Map<string, string | null>();
  const seenSpaceGroupIds = new Set<string>();
  for (const source of snapshot.spaceGroups || []) {
    if (seenSpaceGroupIds.has(source.id)) {
      warnings.push(`Skipped duplicate space group id "${source.id}" in the backup.`);
      continue;
    }
    seenSpaceGroupIds.add(source.id);
    const existing = existingSpaceGroups.get(source.id);
    const incomingUpdatedAt = sourceTimestamp(source.updatedAt);
    if (existing && existing.updatedAt > incomingUpdatedAt) continue;
    requestedParentByGroupId.set(
      source.id,
      useSourceField(source, "parentGroupId")
        ? source.parentGroupId || null
        : existing?.parentGroupId || null,
    );
    spaceGroups.push({
      id: source.id,
      name: normalizeEntityName(source.name, existing?.name || "Imported group", 80),
      sortOrder: normalizeNumber(source.sortOrder) ?? existing?.sortOrder ?? now,
      isCollapsed: useSourceField(source, "isCollapsed")
        ? source.isCollapsed === true
        : existing?.isCollapsed === true,
      parentGroupId: null,
      createdAt: existing?.createdAt || normalizeNumber(source.createdAt) || incomingUpdatedAt,
      updatedAt: incomingUpdatedAt,
    });
  }
  const prospectiveSpaceGroups = new Map(existingSpaceGroups);
  for (const group of spaceGroups) prospectiveSpaceGroups.set(group.id, group);
  for (const group of spaceGroups) {
    const parentId = requestedParentByGroupId.get(group.id) || null;
    group.parentGroupId = parentId && parentId !== group.id && prospectiveSpaceGroups.has(parentId)
      ? parentId
      : null;
    if (parentId && !group.parentGroupId) {
      warnings.push(`Restored space group "${group.name}" at the root because its parent is unavailable.`);
    }
  }
  for (const group of spaceGroups) {
    const seen = new Set([group.id]);
    let cursor = group.parentGroupId || null;
    while (cursor) {
      if (seen.has(cursor)) {
        group.parentGroupId = null;
        warnings.push(`Restored space group "${group.name}" at the root to break a parent cycle.`);
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
    const requestedGroupId = useSourceField(source, "spaceGroupId")
      ? source.spaceGroupId || UNGROUPED_SPACE_GROUP_ID
      : existing?.spaceGroupId || UNGROUPED_SPACE_GROUP_ID;
    const spaceGroupId = requestedGroupId && prospectiveSpaceGroups.has(requestedGroupId)
      ? requestedGroupId
      : UNGROUPED_SPACE_GROUP_ID;
    if (requestedGroupId && !spaceGroupId) {
      warnings.push(`Restored space "${source.name}" without its missing group.`);
    }
    if (existing) {
      spaces.push({
        ...existing,
        name: normalizeEntityName(source.name, existing.name, 80),
        slug: normalizeText(source.slug, 120) || existing.slug,
        spaceGroupId,
        sortOrder: normalizeNumber(source.sortOrder) ?? existing.sortOrder,
        isArchived: false,
        deletedAt: 0,
        purgeAt: 0,
        updatedAt: incomingUpdatedAt,
      });
      continue;
    }

    if (source.isPrivate) {
      warnings.push(
        `Private space "${source.name}" was restored as public because portable backups never include credentials.`
      );
    }
    spaces.push({
      id: source.id,
      name: normalizeEntityName(source.name, "Imported space", 80),
      slug: normalizeText(source.slug, 120) || `imported-${source.id.slice(0, 24)}`,
      spaceGroupId,
      isPrivate: false,
      autoLockMs: 15 * 60 * 1000,
      sortOrder: normalizeNumber(source.sortOrder) ?? now,
      isArchived: false,
      deletedAt: 0,
      purgeAt: 0,
      createdAt: normalizeNumber(source.createdAt) || incomingUpdatedAt,
      updatedAt: incomingUpdatedAt,
    });
  }
  await checkedRxBulkWrite(
    "backup-restore.spaces",
    spaces,
    (rows) => db.spaces.bulkUpsert(rows)
  );
  const prospectiveSpaces = new Map(existingSpaces);
  for (const space of spaces) prospectiveSpaces.set(space.id, space);
  const liveSpaceIds = new Set(
    Array.from(prospectiveSpaces.values())
      .filter((space) => (space.deletedAt || 0) === 0 && space.isArchived !== true)
      .map((space) => space.id)
  );
  const fallbackSpaceId = liveSpaceIds.has(PUBLIC_SPACE_ID) ? PUBLIC_SPACE_ID : null;

  const requestedParentByFolderId = new Map<string, string | null>();
  const folders: FolderDocType[] = [];
  const restoredFolderIds = new Set<string>();
  for (const source of snapshot.folders) {
    if (restoredFolderIds.has(source.id)) {
      warnings.push(`Skipped duplicate folder id "${source.id}" in the backup.`);
      continue;
    }
    const existing = existingFolders.get(source.id);
    const incomingUpdatedAt = sourceTimestamp(source.updatedAt);
    if (existing && existing.updatedAt > incomingUpdatedAt) continue;
    const requestedSpaceId = source.spaceId || existing?.spaceId || PUBLIC_SPACE_ID;
    const spaceId = liveSpaceIds.has(requestedSpaceId)
      ? requestedSpaceId
      : fallbackSpaceId;
    if (!spaceId) {
      warnings.push(
        `Skipped folder "${source.name}" because no live destination space is available.`
      );
      continue;
    }
    if (spaceId !== requestedSpaceId) {
      warnings.push(
        `Restored folder "${source.name}" to the default space because its destination is unavailable.`
      );
    }

    restoredFolderIds.add(source.id);
    requestedParentByFolderId.set(
      source.id,
      useSourceField(source, "parentId")
        ? source.parentId || null
        : existing?.parentId || null,
    );
    folders.push(
      existing
        ? {
            ...existing,
            name: normalizeTitle(source.name, existing.name),
            spaceId,
            parentId: null,
            type: useSourceField(source, "type")
              ? source.type === "tab_group" ? "tab_group" : "folder"
              : existing.type,
            sortOrder: normalizeNumber(source.sortOrder) ?? existing.sortOrder,
            isPinned: useSourceField(source, "isPinned") ? source.isPinned === true : existing.isPinned,
            isCollapsed: useSourceField(source, "isCollapsed") ? source.isCollapsed === true : existing.isCollapsed,
            deletedAt: 0,
            purgeAt: 0,
            isDirty: true,
            updatedAt: incomingUpdatedAt,
          }
        : {
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
            createdAt: normalizeNumber(source.createdAt) || incomingUpdatedAt,
            updatedAt: incomingUpdatedAt,
          }
    );
  }

  const prospectiveFolders = new Map(existingFolders);
  for (const folder of folders) prospectiveFolders.set(folder.id, folder);
  const parentByFolderId = new Map<string, string | null>();
  for (const folder of folders) {
    const parentId = requestedParentByFolderId.get(folder.id) || null;
    const parent = parentId ? prospectiveFolders.get(parentId) : undefined;
    if (
      parent &&
      parent.id !== folder.id &&
      parent.spaceId === folder.spaceId &&
      (parent.deletedAt || 0) === 0
    ) {
      parentByFolderId.set(folder.id, parent.id);
    } else {
      if (parentId) {
        warnings.push(
          `Restored folder "${folder.name}" at the root because its parent is unavailable or belongs to another space.`
        );
      }
      parentByFolderId.set(folder.id, null);
    }
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
      warnings.push(`Restored folder "${folder.name}" at the root to break a parent cycle.`);
    }
    folder.parentId = parentByFolderId.get(folder.id) || null;
  }

  await checkedRxBulkWrite(
    "backup-restore.folders",
    folders,
    (rows) => db.folders.bulkUpsert(rows)
  );

  for (const folder of folders) prospectiveFolders.set(folder.id, folder);
  const liveFolderCache = new Map<string, boolean>();
  const isLiveFolderDestination = (folderId: string): boolean => {
    if (liveFolderCache.has(folderId)) return liveFolderCache.get(folderId) === true;
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
    const requestedFolderId = source.folderId ?? existing?.folderId ?? "";
    const folderId =
      requestedFolderId && isLiveFolderDestination(requestedFolderId)
        ? requestedFolderId
        : "";
    const requestedSpaceId = folderId
      ? (prospectiveFolders.get(folderId) as FolderDocType).spaceId
      : source.spaceId || existing?.spaceId || PUBLIC_SPACE_ID;
    const spaceId = folderId
      ? requestedSpaceId
      : liveSpaceIds.has(requestedSpaceId)
        ? requestedSpaceId
        : fallbackSpaceId;
    if (!spaceId) {
      warnings.push(
        `Skipped item "${source.title}" because its destination space is not live.`
      );
      continue;
    }
    if (requestedFolderId && !folderId) {
      warnings.push(`Restored item "${source.title}" at the space root because its folder is unavailable.`);
    }
    const incoming = toImportedItem(source, source.id, folderId, spaceId, now);
    const sourceUpdatedAt = sourceTimestamp(source.updatedAt);
    if (existing && existing.updatedAt > sourceUpdatedAt) {
      if ((existing.deletedAt || 0) === 0 && isLiveItemDestination(existing)) {
        restoredOrRetainedItemIds.add(existing.id);
      }
      continue;
    }
    items.push({
      ...incoming,
      userId: existing?.userId || incoming.userId,
      ...(!existing || useSourceField(source, "isFavorite") ? {} : { isFavorite: existing.isFavorite }),
      ...(!existing || useSourceField(source, "type") ? {} : { type: existing.type }),
      ...(!existing || useSourceField(source, "fields") ? {} : { fields: existing.fields }),
      ...(!existing || useSourceField(source, "blocks") ? {} : { blocks: existing.blocks }),
      ...(!existing || useSourceField(source, "blobs") ? {} : { blobs: existing.blobs }),
      ...(!existing || useSourceField(source, "summary") ? {} : { summary: existing.summary }),
      ...(!existing || useSourceField(source, "ai") ? {} : { ai: existing.ai }),
      ...(!existing || useSourceField(source, "parentId") ? {} : { parentId: existing.parentId }),
      ...(!existing || useSourceField(source, "chunkOrder") ? {} : { chunkOrder: existing.chunkOrder }),
      createdAt: existing?.createdAt || incoming.createdAt,
      updatedAt: sourceUpdatedAt,
      vector_index: -1,
      vector_indexes: [],
      // Restored items enter the normal background embedding queue.
      isEmbedded: false,
      isDirty: false,
    });
    restoredOrRetainedItemIds.add(source.id);
  }
  await checkedRxBulkWrite(
    "backup-restore.items",
    items,
    (rows) => db.items.bulkUpsert(rows)
  );

  const tagIdMap = new Map<string, string>();
  const tagsByTargetId = new Map<string, TagDocType>();
  for (const source of snapshot.tags) {
    const name = normalizeEntityName(source.name, "", 100);
    if (!name) continue;
    const existing = existingTags.get(source.id) || existingTagsByName.get(name.toLowerCase());
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
      color: useSourceField(source, "color")
        ? normalizeText(source.color, 32) || null
        : existing?.color || null,
      isFavorite: useSourceField(source, "isFavorite")
        ? source.isFavorite === true
        : existing?.isFavorite === true,
      createdAt: existing?.createdAt || normalizeNumber(source.createdAt) || incomingUpdatedAt,
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
    (rows) => db.tags.bulkUpsert(rows)
  );

  const itemTagsById = new Map<string, ItemTagDocType>();
  for (const source of snapshot.itemTags) {
      const tagId = tagIdMap.get(source.tagId);
      if (!restoredOrRetainedItemIds.has(source.itemId) || !tagId) continue;
      const row = {
        id: `${source.itemId}|${tagId}`,
        itemId: source.itemId,
        tagId,
        userId: "user1",
        createdAt: now,
        updatedAt: now,
        deletedAt: 0,
      } as ItemTagDocType;
      itemTagsById.set(row.id, row);
  }
  const itemTags = Array.from(itemTagsById.values());
  await checkedRxBulkWrite(
    "backup-restore.item-tags",
    itemTags,
    (rows) => db.item_tags.bulkUpsert(rows)
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

function sanitizeSpace(space: SpaceDocType): SharedSpace {
  return {
    id: space.id,
    name: normalizeEntityName(space.name, "Space", 80),
    slug: normalizeText(space.slug, 120),
    spaceGroupId: space.spaceGroupId || null,
    sortOrder: normalizeNumber(space.sortOrder),
    isPrivate: space.isPrivate === true,
    createdAt: normalizeNumber(space.createdAt),
    updatedAt: normalizeNumber(space.updatedAt),
  };
}

function sanitizeSpaceGroup(group: SpaceGroupDocType): SharedSpaceGroup {
  return {
    id: group.id,
    name: normalizeEntityName(group.name, "Space group", 80),
    sortOrder: normalizeNumber(group.sortOrder) || 0,
    isCollapsed: group.isCollapsed === true,
    parentGroupId: group.parentGroupId || null,
    createdAt: normalizeNumber(group.createdAt) || 0,
    updatedAt: normalizeNumber(group.updatedAt) || 0,
  };
}

function sanitizeFolder(folder: FolderDocType): SharedFolder {
  return {
    id: folder.id,
    name: normalizeTitle(folder.name, "Folder"),
    spaceId: folder.spaceId || PUBLIC_SPACE_ID,
    parentId: folder.parentId || null,
    type: folder.type === "tab_group" ? "tab_group" : "folder",
    sortOrder: normalizeNumber(folder.sortOrder),
    isPinned: folder.isPinned === true,
    isCollapsed: folder.isCollapsed === true,
    createdAt: normalizeNumber(folder.createdAt),
    updatedAt: normalizeNumber(folder.updatedAt),
  };
}

function sanitizeItem(
  item: ItemDocType,
  warnings: ShareSnapshotWarning[],
  options: { includeBackupMetadata?: boolean } = {},
): SharedItem {
  const media = sanitizeMedia(item, warnings);
  return {
    id: item.id,
    title: normalizeTitle(item.title, item.url || "Untitled"),
    textContent: normalizeText(item.textContent, 20_000),
    ocrText: normalizeText(item.ocrText, 20_000),
    url: normalizeUrl(item.url) || `https://local.vibesearch.invalid/item/${encodeURIComponent(item.id)}`,
    source: normalizeSource(item.source),
    folderId: item.folderId,
    spaceId: item.spaceId || PUBLIC_SPACE_ID,
    authorUsername: normalizeText(item.authorUsername, 160),
    likes: normalizeNumber(item.likes),
    upvotes: normalizeNumber(item.upvotes),
    media,
    iconUrl: normalizeUrl(item.iconUrl) || undefined,
    displayImageUrl: normalizeUrl(item.displayImageUrl) || undefined,
    createdAt: normalizeNumber(item.createdAt),
    updatedAt: normalizeNumber(item.updatedAt),
    ...(options.includeBackupMetadata
      ? {
          isFavorite: item.isFavorite === true,
          type: normalizeText(item.type, 120) || undefined,
          fields: item.fields ? structuredClone(item.fields) : undefined,
          blocks: item.blocks ? structuredClone(item.blocks) : undefined,
          blobs: item.blobs ? structuredClone(item.blobs) : undefined,
          summary: normalizeText(item.summary, 20_000),
          ai: item.ai ? structuredClone(item.ai) : undefined,
          parentId: item.parentId || null,
          chunkOrder: normalizeNumber(item.chunkOrder),
        }
      : {}),
  };
}

function sanitizeMedia(item: ItemDocType, warnings: ShareSnapshotWarning[]): SharedMedia[] {
  const output: SharedMedia[] = [];
  for (const entry of item.media || []) {
    const originalUrl = normalizeUrl(entry.originalUrl) || normalizeUrl(entry.s3Url) || normalizeUrl(entry.thumbnailUrl);
    const s3Url = normalizeUrl(entry.s3Url);
    if (entry.storageType === "opfs" && !s3Url && !originalUrl) {
      warnings.push({
        code: "MEDIA_OPFS_SKIPPED",
        itemId: item.id,
        detail: "Local OPFS media must be promoted before export.",
      });
      continue;
    }
    output.push({
      id: normalizeText(entry.id, 512),
      type: entry.type,
      originalUrl,
      storageType: s3Url ? "s3" : "hotlink",
      s3Url,
      s3ThumbnailUrl: normalizeUrl(entry.s3ThumbnailUrl) || undefined,
      embedUrl: normalizeUrl(entry.embedUrl) || undefined,
      embedType: entry.embedType === "iframe" ? "iframe" : undefined,
      thumbnailUrl: normalizeUrl(entry.thumbnailUrl) || undefined,
      mimeType: normalizeText(entry.mimeType, 255),
      fileName: normalizeText(entry.fileName, 1_024),
      byteSize: normalizeNumber(entry.byteSize),
      contentHash: normalizeText(entry.contentHash, 512),
      durationSec:
        typeof entry.durationSec === "number" && Number.isFinite(entry.durationSec)
          ? Math.max(0, entry.durationSec)
          : undefined,
      provider: normalizeText(entry.provider, 256),
      externalId: normalizeText(entry.externalId, 512),
      altText: normalizeText(entry.altText, 500),
      titleText: normalizeText(entry.titleText, 500),
      ariaLabel: normalizeText(entry.ariaLabel, 500),
      pageUrl: normalizeUrl(entry.pageUrl) || undefined,
      pageTitle: normalizeText(entry.pageTitle, 500),
      siteName: normalizeText(entry.siteName, 200),
      faviconUrl: normalizeUrl(entry.faviconUrl) || undefined,
      width: normalizeNumber(entry.width),
      height: normalizeNumber(entry.height),
      capturedAt: normalizeNumber(entry.capturedAt),
      ocr: sanitizeOcr(entry.ocr),
    });
  }
  return output;
}

function sanitizeOcr(value: MediaOcrMetadata | undefined): SharedMedia["ocr"] | undefined {
  if (!value) return undefined;
  return {
    status: value.status,
    text: normalizeText(value.text, 20_000),
    confidence: typeof value.confidence === "number" ? value.confidence : null,
    lineCount: normalizeNumber(value.lineCount),
    extractedAt: normalizeNumber(value.extractedAt),
    language: normalizeText(value.language, 40),
    engine: normalizeText(value.engine, 80),
  };
}

function sanitizeTag(tag: TagDocType): SharedTag {
  return {
    id: tag.id,
    name: normalizeEntityName(tag.name, "tag", 100),
    color: tag.color ?? null,
    isFavorite: tag.isFavorite === true,
    createdAt: normalizeNumber(tag.createdAt),
    updatedAt: normalizeNumber(tag.updatedAt),
  };
}

function sanitizeItemTag(join: ItemTagDocType): SharedItemTag {
  return {
    itemId: join.itemId,
    tagId: join.tagId,
  };
}

function validateSnapshot(value: unknown): ShareSnapshotV1 {
  if (!value || typeof value !== "object") throw new Error("SHARE_SNAPSHOT_INVALID");
  const snapshot = value as ShareSnapshotV1;
  if (snapshot.schemaVersion !== 1) throw new Error("SHARE_SNAPSHOT_VERSION_UNSUPPORTED");
  if (snapshot.backupMetadataVersion !== undefined && snapshot.backupMetadataVersion !== 1) {
    throw new Error("SHARE_SNAPSHOT_BACKUP_METADATA_VERSION_INVALID");
  }
  if (typeof snapshot.title !== "string" || !Number.isSafeInteger(snapshot.createdAt) || snapshot.createdAt < 0) {
    throw new Error("SHARE_SNAPSHOT_INVALID");
  }
  if (
    !snapshot.source ||
    !["folder", "folders", "items"].includes(String(snapshot.source.kind)) ||
    !Array.isArray(snapshot.source.ids) ||
    snapshot.source.ids.length > SNAPSHOT_MAX_RECORDS_PER_COLLECTION
  ) {
    throw new Error("SHARE_SNAPSHOT_SOURCE_INVALID");
  }
  for (const id of snapshot.source.ids) assertSnapshotId(id, "SHARE_SNAPSHOT_SOURCE_INVALID");
  const spaceGroups = snapshot.spaceGroups ?? [];
  assertSnapshotRecordArray(spaceGroups, "SHARE_SNAPSHOT_SPACE_GROUPS_INVALID", (row) => {
    assertSnapshotId(row.id, "SHARE_SNAPSHOT_SPACE_GROUP_INVALID");
    if (typeof row.name !== "string") throw new Error("SHARE_SNAPSHOT_SPACE_GROUP_INVALID");
    assertOptionalSnapshotReference(row.parentGroupId, 100, "SHARE_SNAPSHOT_SPACE_GROUP_INVALID");
    assertOptionalSnapshotBoolean(row.isCollapsed, "SHARE_SNAPSHOT_SPACE_GROUP_INVALID");
    assertOptionalSnapshotInteger(row.sortOrder, "SHARE_SNAPSHOT_SPACE_GROUP_INVALID");
    assertOptionalSnapshotInteger(row.createdAt, "SHARE_SNAPSHOT_SPACE_GROUP_INVALID");
    assertOptionalSnapshotInteger(row.updatedAt, "SHARE_SNAPSHOT_SPACE_GROUP_INVALID");
  });
  assertUniqueSnapshotKeys(
    spaceGroups,
    (row) => row.id,
    "SHARE_SNAPSHOT_DUPLICATE_SPACE_GROUP_ID",
  );
  assertSnapshotRecordArray(snapshot.spaces, "SHARE_SNAPSHOT_SPACES_INVALID", (row) => {
    assertSnapshotId(row.id, "SHARE_SNAPSHOT_SPACE_INVALID");
    if (typeof row.name !== "string") throw new Error("SHARE_SNAPSHOT_SPACE_INVALID");
    assertOptionalSnapshotString(row.slug, 120, "SHARE_SNAPSHOT_SPACE_INVALID");
    assertOptionalSnapshotReference(row.spaceGroupId, 100, "SHARE_SNAPSHOT_SPACE_INVALID");
    assertOptionalSnapshotBoolean(row.isPrivate, "SHARE_SNAPSHOT_SPACE_INVALID");
    assertOptionalSnapshotInteger(row.sortOrder, "SHARE_SNAPSHOT_SPACE_INVALID");
    assertOptionalSnapshotInteger(row.createdAt, "SHARE_SNAPSHOT_SPACE_INVALID");
    assertOptionalSnapshotInteger(row.updatedAt, "SHARE_SNAPSHOT_SPACE_INVALID");
  });
  assertUniqueSnapshotKeys(
    snapshot.spaces,
    (row) => row.id,
    "SHARE_SNAPSHOT_DUPLICATE_SPACE_ID",
  );
  assertSnapshotRecordArray(snapshot.folders, "SHARE_SNAPSHOT_FOLDERS_INVALID", (row) => {
    assertSnapshotId(row.id, "SHARE_SNAPSHOT_FOLDER_INVALID");
    if (typeof row.name !== "string") throw new Error("SHARE_SNAPSHOT_FOLDER_INVALID");
    assertOptionalSnapshotReference(row.spaceId, 1_000, "SHARE_SNAPSHOT_FOLDER_INVALID");
    assertOptionalSnapshotReference(row.parentId, 1_000, "SHARE_SNAPSHOT_FOLDER_INVALID");
    if (row.type !== undefined && !["folder", "tab_group"].includes(String(row.type))) {
      throw new Error("SHARE_SNAPSHOT_FOLDER_INVALID");
    }
    assertOptionalSnapshotBoolean(row.isPinned, "SHARE_SNAPSHOT_FOLDER_INVALID");
    assertOptionalSnapshotBoolean(row.isCollapsed, "SHARE_SNAPSHOT_FOLDER_INVALID");
    assertOptionalSnapshotInteger(row.sortOrder, "SHARE_SNAPSHOT_FOLDER_INVALID");
    assertOptionalSnapshotInteger(row.createdAt, "SHARE_SNAPSHOT_FOLDER_INVALID");
    assertOptionalSnapshotInteger(row.updatedAt, "SHARE_SNAPSHOT_FOLDER_INVALID");
  });
  assertUniqueSnapshotKeys(
    snapshot.folders,
    (row) => row.id,
    "SHARE_SNAPSHOT_DUPLICATE_FOLDER_ID",
  );
  assertSnapshotRecordArray(snapshot.items, "SHARE_SNAPSHOT_ITEMS_INVALID", (row) => {
    assertSnapshotId(row.id, "SHARE_SNAPSHOT_ITEM_INVALID");
    if (typeof row.title !== "string" || typeof row.url !== "string") {
      throw new Error("SHARE_SNAPSHOT_ITEM_INVALID");
    }
    assertOptionalSnapshotReference(row.folderId, 1_000, "SHARE_SNAPSHOT_ITEM_INVALID");
    assertOptionalSnapshotReference(row.spaceId, 1_000, "SHARE_SNAPSHOT_ITEM_INVALID");
    assertOptionalSnapshotReference(row.parentId, 100, "SHARE_SNAPSHOT_ITEM_INVALID");
    assertOptionalSnapshotBoolean(row.isFavorite, "SHARE_SNAPSHOT_ITEM_INVALID");
    assertOptionalSnapshotString(row.type, 200, "SHARE_SNAPSHOT_ITEM_INVALID");
    assertOptionalSnapshotNumber(row.chunkOrder, "SHARE_SNAPSHOT_ITEM_INVALID");
    assertOptionalSnapshotInteger(row.createdAt, "SHARE_SNAPSHOT_ITEM_INVALID");
    assertOptionalSnapshotInteger(row.updatedAt, "SHARE_SNAPSHOT_ITEM_INVALID");
    assertOptionalSnapshotRecord(row.fields, "SHARE_SNAPSHOT_ITEM_FIELDS_INVALID");
    assertOptionalSnapshotRecord(row.ai, "SHARE_SNAPSHOT_ITEM_AI_INVALID");
    if (row.media !== undefined) {
      assertSnapshotRecordArray(row.media, "SHARE_SNAPSHOT_ITEM_MEDIA_INVALID", (media) => {
        if (
          !["image", "video", "audio", "file"].includes(String(media.type)) ||
          !["hotlink", "s3"].includes(String(media.storageType))
        ) {
          throw new Error("SHARE_SNAPSHOT_ITEM_MEDIA_INVALID");
        }
        assertOptionalSnapshotString(media.id, 512, "SHARE_SNAPSHOT_ITEM_MEDIA_INVALID");
        assertOptionalSnapshotString(media.mimeType, 255, "SHARE_SNAPSHOT_ITEM_MEDIA_INVALID");
        assertOptionalSnapshotString(media.fileName, 1_024, "SHARE_SNAPSHOT_ITEM_MEDIA_INVALID");
        assertOptionalSnapshotInteger(media.byteSize, "SHARE_SNAPSHOT_ITEM_MEDIA_INVALID");
        assertOptionalSnapshotString(media.contentHash, 512, "SHARE_SNAPSHOT_ITEM_MEDIA_INVALID");
        assertOptionalSnapshotNumber(media.durationSec, "SHARE_SNAPSHOT_ITEM_MEDIA_INVALID");
        if (typeof media.durationSec === "number" && media.durationSec < 0) {
          throw new Error("SHARE_SNAPSHOT_ITEM_MEDIA_INVALID");
        }
        assertOptionalSnapshotString(media.provider, 256, "SHARE_SNAPSHOT_ITEM_MEDIA_INVALID");
        assertOptionalSnapshotString(media.externalId, 512, "SHARE_SNAPSHOT_ITEM_MEDIA_INVALID");
        assertOptionalSnapshotNumber(media.width, "SHARE_SNAPSHOT_ITEM_MEDIA_INVALID");
        assertOptionalSnapshotNumber(media.height, "SHARE_SNAPSHOT_ITEM_MEDIA_INVALID");
        assertOptionalSnapshotInteger(media.capturedAt, "SHARE_SNAPSHOT_ITEM_MEDIA_INVALID");
        assertOptionalSnapshotRecord(media.ocr, "SHARE_SNAPSHOT_ITEM_MEDIA_INVALID");
        if (media.ocr && typeof media.ocr === "object" && !Array.isArray(media.ocr)) {
          const ocr = media.ocr as Record<string, unknown>;
          if (
            ocr.status !== undefined &&
            !["pending", "processing", "done", "error", "skipped"].includes(String(ocr.status))
          ) {
            throw new Error("SHARE_SNAPSHOT_ITEM_MEDIA_INVALID");
          }
          if (
            ocr.confidence !== undefined &&
            ocr.confidence !== null &&
            (typeof ocr.confidence !== "number" || !Number.isFinite(ocr.confidence) || ocr.confidence < 0 || ocr.confidence > 1)
          ) {
            throw new Error("SHARE_SNAPSHOT_ITEM_MEDIA_INVALID");
          }
          assertOptionalSnapshotInteger(ocr.lineCount, "SHARE_SNAPSHOT_ITEM_MEDIA_INVALID");
          assertOptionalSnapshotInteger(ocr.extractedAt, "SHARE_SNAPSHOT_ITEM_MEDIA_INVALID");
          assertOptionalSnapshotString(ocr.text, undefined, "SHARE_SNAPSHOT_ITEM_MEDIA_INVALID");
          assertOptionalSnapshotString(ocr.language, undefined, "SHARE_SNAPSHOT_ITEM_MEDIA_INVALID");
          assertOptionalSnapshotString(ocr.engine, undefined, "SHARE_SNAPSHOT_ITEM_MEDIA_INVALID");
        }
      });
    }
    if (row.blocks !== undefined) {
      assertSnapshotRecordArray(row.blocks, "SHARE_SNAPSHOT_ITEM_BLOCKS_INVALID", (block) => {
        assertNoUnexpectedSnapshotKeys(
          block,
          SHARED_BLOCK_KEYS,
          "SHARE_SNAPSHOT_ITEM_BLOCKS_INVALID",
        );
        if (
          typeof block.id !== "string" ||
          !block.id ||
          block.id.length > 200 ||
          !["text", "markdown", "html", "code", "quote", "richtext"].includes(String(block.kind))
        ) {
          throw new Error("SHARE_SNAPSHOT_ITEM_BLOCKS_INVALID");
        }
        assertOptionalSnapshotString(block.label, undefined, "SHARE_SNAPSHOT_ITEM_BLOCKS_INVALID");
        assertOptionalSnapshotString(block.text, undefined, "SHARE_SNAPSHOT_ITEM_BLOCKS_INVALID");
        assertOptionalSnapshotString(block.r2Key, undefined, "SHARE_SNAPSHOT_ITEM_BLOCKS_INVALID");
        assertOptionalSnapshotString(block.language, 200, "SHARE_SNAPSHOT_ITEM_BLOCKS_INVALID");
        assertOptionalSnapshotBoolean(block.searchable, "SHARE_SNAPSHOT_ITEM_BLOCKS_INVALID");
        assertOptionalSnapshotInteger(block.createdAt, "SHARE_SNAPSHOT_ITEM_BLOCKS_INVALID");
      });
    }
    if (row.blobs !== undefined) {
      assertSnapshotRecordArray(row.blobs, "SHARE_SNAPSHOT_ITEM_BLOBS_INVALID", (blob) => {
        assertNoUnexpectedSnapshotKeys(
          blob,
          SHARED_BLOB_KEYS,
          "SHARE_SNAPSHOT_ITEM_BLOBS_INVALID",
        );
        if (
          typeof blob.key !== "string" ||
          !blob.key ||
          !["html", "pdf", "json", "text", "archive", "other"].includes(String(blob.kind))
        ) {
          throw new Error("SHARE_SNAPSHOT_ITEM_BLOBS_INVALID");
        }
        assertOptionalSnapshotString(blob.contentType, 500, "SHARE_SNAPSHOT_ITEM_BLOBS_INVALID");
        assertOptionalSnapshotInteger(blob.byteSize, "SHARE_SNAPSHOT_ITEM_BLOBS_INVALID");
        assertOptionalSnapshotString(blob.label, undefined, "SHARE_SNAPSHOT_ITEM_BLOBS_INVALID");
        assertOptionalSnapshotString(blob.hash, 256, "SHARE_SNAPSHOT_ITEM_BLOBS_INVALID");
        assertOptionalSnapshotInteger(blob.capturedAt, "SHARE_SNAPSHOT_ITEM_BLOBS_INVALID");
      });
    }
  });
  assertUniqueSnapshotKeys(
    snapshot.items,
    (row) => row.id,
    "SHARE_SNAPSHOT_DUPLICATE_ITEM_ID",
  );
  assertSnapshotRecordArray(snapshot.tags, "SHARE_SNAPSHOT_TAGS_INVALID", (row) => {
    assertSnapshotId(row.id, "SHARE_SNAPSHOT_TAG_INVALID");
    if (typeof row.name !== "string") throw new Error("SHARE_SNAPSHOT_TAG_INVALID");
    assertOptionalSnapshotString(row.color, 32, "SHARE_SNAPSHOT_TAG_INVALID", true);
    assertOptionalSnapshotBoolean(row.isFavorite, "SHARE_SNAPSHOT_TAG_INVALID");
    assertOptionalSnapshotInteger(row.createdAt, "SHARE_SNAPSHOT_TAG_INVALID");
    assertOptionalSnapshotInteger(row.updatedAt, "SHARE_SNAPSHOT_TAG_INVALID");
  });
  assertUniqueSnapshotKeys(
    snapshot.tags,
    (row) => row.id,
    "SHARE_SNAPSHOT_DUPLICATE_TAG_ID",
  );
  assertSnapshotRecordArray(snapshot.itemTags, "SHARE_SNAPSHOT_ITEM_TAGS_INVALID", (row) => {
    assertSnapshotId(row.itemId, "SHARE_SNAPSHOT_ITEM_TAG_INVALID");
    assertSnapshotId(row.tagId, "SHARE_SNAPSHOT_ITEM_TAG_INVALID");
  });
  assertUniqueSnapshotKeys(
    snapshot.itemTags,
    (row) => `${row.itemId}\u0000${row.tagId}`,
    "SHARE_SNAPSHOT_DUPLICATE_ITEM_TAG",
  );
  if (snapshot.warnings !== undefined) {
    assertSnapshotRecordArray(snapshot.warnings, "SHARE_SNAPSHOT_WARNINGS_INVALID", () => {});
  }
  return { ...snapshot, spaceGroups };
}

const SNAPSHOT_MAX_RECORDS_PER_COLLECTION = 500_000;
const SHARED_BLOCK_KEYS = new Set([
  "id", "kind", "label", "text", "json", "r2Key", "language", "searchable", "createdAt",
]);
const SHARED_BLOB_KEYS = new Set([
  "key", "kind", "contentType", "byteSize", "label", "hash", "capturedAt",
]);

function assertSnapshotRecordArray(
  value: unknown,
  code: string,
  validate: (row: Record<string, unknown>) => void,
): asserts value is Record<string, unknown>[] {
  if (!Array.isArray(value) || value.length > SNAPSHOT_MAX_RECORDS_PER_COLLECTION) {
    throw new Error(code);
  }
  for (const row of value) {
    if (!row || typeof row !== "object" || Array.isArray(row)) throw new Error(code);
    validate(row as Record<string, unknown>);
  }
}

function assertUniqueSnapshotKeys<T>(
  rows: readonly T[],
  getKey: (row: T) => string,
  code: string,
): void {
  const seen = new Set<string>();
  for (const row of rows) {
    const key = getKey(row);
    if (seen.has(key)) throw new Error(code);
    seen.add(key);
  }
}

function assertSnapshotId(value: unknown, code: string): asserts value is string {
  if (typeof value !== "string" || !value.trim() || value.length > 100) throw new Error(code);
}

function assertOptionalSnapshotReference(value: unknown, maxLength: number, code: string): void {
  if (value === undefined || value === null || value === "") return;
  if (typeof value !== "string" || value.length > maxLength) throw new Error(code);
}

function assertOptionalSnapshotString(
  value: unknown,
  maxLength: number | undefined,
  code: string,
  nullable = false,
): void {
  if (value === undefined || (nullable && value === null)) return;
  if (typeof value !== "string" || (maxLength !== undefined && value.length > maxLength)) {
    throw new Error(code);
  }
}

function assertOptionalSnapshotBoolean(value: unknown, code: string): void {
  if (value !== undefined && typeof value !== "boolean") throw new Error(code);
}

function assertOptionalSnapshotNumber(value: unknown, code: string): void {
  if (value !== undefined && (typeof value !== "number" || !Number.isFinite(value))) {
    throw new Error(code);
  }
}

function assertOptionalSnapshotInteger(value: unknown, code: string): void {
  if (
    value !== undefined &&
    (!Number.isSafeInteger(value) || Number(value) < 0 || Number(value) >= Number.MAX_SAFE_INTEGER)
  ) {
    throw new Error(code);
  }
}

function assertOptionalSnapshotRecord(value: unknown, code: string): void {
  if (value === undefined) return;
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(code);
}

function assertNoUnexpectedSnapshotKeys(
  value: Record<string, unknown>,
  allowed: ReadonlySet<string>,
  code: string,
): void {
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) throw new Error(code);
  }
}

async function resolveTargetSpaceId(db: Awaited<ReturnType<typeof getDb>>, value?: string): Promise<string> {
  const candidate = (value || PUBLIC_SPACE_ID).trim() || PUBLIC_SPACE_ID;
  const doc = await db.spaces.findOne(candidate).exec();
  return doc ? candidate : PUBLIC_SPACE_ID;
}

function toImportedItem(
  item: SharedItem,
  id: string,
  folderId: string,
  spaceId: string,
  now: number
): ItemDocType {
  return {
    id,
    userId: "",
    title: normalizeTitle(item.title, item.url || "Imported item"),
    textContent: normalizeText(item.textContent, 20_000) || "",
    ocrText: normalizeText(item.ocrText, 20_000),
    ocrStatus: item.ocrText ? "done" : "pending",
    ocrModelVersion: "",
    ocrUpdatedAt: item.ocrText ? now : 0,
    url: normalizeUrl(item.url) || `https://local.vibesearch.invalid/import/${id}`,
    source: normalizeSource(item.source),
    folderId,
    spaceId,
    isFavorite: item.isFavorite === true,
    authorUsername: normalizeText(item.authorUsername, 160),
    likes: normalizeNumber(item.likes),
    upvotes: normalizeNumber(item.upvotes),
    media: (item.media || []).map(toImportedMedia).filter((entry): entry is NonNullable<ItemDocType["media"]>[number] => !!entry),
    type: normalizeText(item.type, 120) || undefined,
    fields: item.fields ? structuredClone(item.fields) : undefined,
    blocks: item.blocks ? structuredClone(item.blocks) : undefined,
    blobs: item.blobs ? structuredClone(item.blobs) : undefined,
    iconUrl: normalizeUrl(item.iconUrl) || undefined,
    displayImageUrl: normalizeUrl(item.displayImageUrl) || undefined,
    summary: normalizeText(item.summary, 20_000),
    ai: item.ai ? structuredClone(item.ai) : undefined,
    parentId: typeof item.parentId === "string" ? item.parentId : null,
    chunkOrder: normalizeNumber(item.chunkOrder),
    vector_index: -1,
    vector_indexes: [],
    isEmbedded: false,
    isMetaFetched: true,
    isDirty: true,
    serverVersion: 0,
    createdAt: normalizeNumber(item.createdAt) || now,
    updatedAt: now,
    deletedAt: 0,
  };
}

function toImportedMedia(entry: SharedMedia): NonNullable<ItemDocType["media"]>[number] | null {
  const originalUrl = normalizeUrl(entry.originalUrl) || normalizeUrl(entry.s3Url) || normalizeUrl(entry.thumbnailUrl);
  if (!originalUrl) return null;
  return {
    id: normalizeText(entry.id, 512),
    type: entry.type,
    originalUrl,
    storageType: entry.s3Url ? "s3" : "hotlink",
    s3Url: normalizeUrl(entry.s3Url) || undefined,
    s3ThumbnailUrl: normalizeUrl(entry.s3ThumbnailUrl) || undefined,
    embedUrl: normalizeUrl(entry.embedUrl) || undefined,
    embedType: entry.embedType === "iframe" ? "iframe" : undefined,
    thumbnailUrl: normalizeUrl(entry.thumbnailUrl) || undefined,
    mimeType: normalizeText(entry.mimeType, 255),
    fileName: normalizeText(entry.fileName, 1_024),
    byteSize: normalizeNumber(entry.byteSize),
    contentHash: normalizeText(entry.contentHash, 512),
    durationSec:
      typeof entry.durationSec === "number" && Number.isFinite(entry.durationSec)
        ? Math.max(0, entry.durationSec)
        : undefined,
    provider: normalizeText(entry.provider, 256),
    externalId: normalizeText(entry.externalId, 512),
    altText: normalizeText(entry.altText, 500),
    titleText: normalizeText(entry.titleText, 500),
    ariaLabel: normalizeText(entry.ariaLabel, 500),
    pageUrl: normalizeUrl(entry.pageUrl) || undefined,
    pageTitle: normalizeText(entry.pageTitle, 500),
    siteName: normalizeText(entry.siteName, 200),
    faviconUrl: normalizeUrl(entry.faviconUrl) || undefined,
    width: normalizeNumber(entry.width),
    height: normalizeNumber(entry.height),
    capturedAt: normalizeNumber(entry.capturedAt),
    ocr: entry.ocr
      ? {
          status: entry.ocr.status,
          text: normalizeText(entry.ocr.text, 20_000),
          confidence: typeof entry.ocr.confidence === "number" ? entry.ocr.confidence : null,
          lineCount: normalizeNumber(entry.ocr.lineCount),
          extractedAt: normalizeNumber(entry.ocr.extractedAt),
          language: normalizeText(entry.ocr.language, 40),
          engine: normalizeText(entry.ocr.engine, 80),
        }
      : undefined,
  };
}

function normalizeTitle(value: unknown, fallback: string): string {
  const text = normalizeText(value, 160);
  return text || fallback.slice(0, 160);
}

function normalizeEntityName(value: unknown, fallback: string, maxLength: number): string {
  const text = normalizeText(value, maxLength);
  return text || fallback.slice(0, maxLength);
}

function normalizeText(value: unknown, max: number): string | undefined {
  if (typeof value !== "string") return undefined;
  const text = value.replace(/\r\n/g, "\n").trim();
  return text ? text.slice(0, max) : undefined;
}

function normalizeUrl(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  if (trimmed.startsWith("data:image/")) return trimmed;
  try {
    const parsed = new URL(trimmed);
    if (parsed.protocol === "http:" || parsed.protocol === "https:") return parsed.toString();
  } catch {}
  return undefined;
}

function normalizeNumber(value: unknown): number | undefined {
  return Number.isFinite(value)
    ? Math.min(Number.MAX_SAFE_INTEGER - 1, Math.max(0, Math.floor(value as number)))
    : undefined;
}

function normalizeSource(value: unknown): ItemDocType["source"] {
  return typeof value === "string" && SOURCE_VALUES.has(value as ItemDocType["source"])
    ? (value as ItemDocType["source"])
    : "web";
}

function normalizeSourceIds(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((entry): entry is string => typeof entry === "string" && entry.trim().length > 0);
}

function sendDbChange(scope: "items" | "folders" | "tags" | "spaces") {
  try {
    chrome.runtime.sendMessage({ type: "DB_CHANGE", scope });
  } catch {}
}
