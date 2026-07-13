import { getDb } from "@src/services/DatabaseService";
import { localSearchIndexService } from "@src/services/local-search-index.service";
import type { FolderDocType } from "@src/schemas/folder_schema";
import type { ItemDocType } from "@src/schemas/item_schema";
import type { SpaceDocType } from "@src/schemas/space_schema";
import type { SpaceGroupDocType } from "@src/schemas/space_group_schema";
import { inferSource } from "@src/utils/infer-source";
import { cloudSyncService, type CloudSyncDocBatch } from "@src/services/cloud-sync";

export const BROWSER_BOOKMARKS_SPACE_GROUP_ID = "space_group_browser_bookmarks";
export const BROWSER_BOOKMARKS_SPACE_GROUP_NAME = "Browser Bookmarks";
export const MAX_BOOKMARKS_PER_SPACE = 500;

const IMPORT_BATCH_SIZE = 200;
const ROOT_BOOKMARKS_SOURCE_ID = "__root_bookmarks__";

export type BrowserBookmarkNode = {
  id?: string;
  title?: string;
  url?: string;
  dateAdded?: number;
  dateGroupModified?: number;
  index?: number;
  children?: BrowserBookmarkNode[];
};

type BookmarkFolder = {
  browserId: string;
  name: string;
  sortOrder: number;
  createdAt: number;
  updatedAt: number;
};

type BookmarkEntry = {
  browserId: string;
  title: string;
  url: string;
  folders: BookmarkFolder[];
  createdAt: number;
  sortOrder: number;
};

type BookmarkCollection = {
  id: string;
  name: string;
  entries: BookmarkEntry[];
};

export type BrowserBookmarkImportPlan = {
  spaceGroup: SpaceGroupDocType;
  spaces: SpaceDocType[];
  folders: FolderDocType[];
  bookmarks: ItemDocType[];
};

export type BrowserBookmarkImportResult = {
  spaceGroupId: string;
  spaceIds: string[];
  primarySpaceId: string | null;
  folderCount: number;
  bookmarkCount: number;
  updatedFolderCount: number;
  updatedBookmarkCount: number;
  removedBookmarkCount: number;
  metadataUrls: string[];
};

const yieldToEventLoop = () =>
  new Promise<void>((resolve) => {
    const timer = typeof window !== "undefined" ? window.setTimeout : setTimeout;
    timer(resolve, 0);
  });

const chunk = <T,>(values: T[], size: number): T[][] => {
  const groups: T[][] = [];
  for (let start = 0; start < values.length; start += size) {
    groups.push(values.slice(start, start + size));
  }
  return groups;
};

const clampTimestamp = (value: unknown, fallback: number): number => {
  if (!Number.isFinite(value)) return fallback;
  return Math.max(0, Math.min(Number.MAX_SAFE_INTEGER - 1, Math.floor(value as number)));
};

const cleanLabel = (value: unknown, fallback: string): string => {
  if (typeof value !== "string") return fallback;
  const normalized = value.replace(/\s+/g, " ").trim();
  return normalized.slice(0, 500) || fallback;
};

const bookmarkTitle = (value: unknown, url: string): string => {
  const title = cleanLabel(value, "");
  if (title) return title;
  try {
    return new URL(url).hostname || url;
  } catch {
    return url.slice(0, 500) || "Untitled bookmark";
  }
};

const stableHash = (value: string): string => {
  let first = 0x811c9dc5;
  let second = 0x9e3779b9;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    first = Math.imul(first ^ code, 0x01000193);
    second = Math.imul(second ^ code, 0x85ebca6b);
  }
  return `${(first >>> 0).toString(36)}${(second >>> 0).toString(36)}`;
};

const stableId = (kind: "space" | "folder" | "bookmark", sourceId: string): string =>
  `browser-${kind}-${stableHash(sourceId)}`;

const spaceSlug = (name: string, fallback: string): string => {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, "")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
  return slug || fallback;
};

const createFolder = (
  id: string,
  name: string,
  spaceId: string,
  parentId: string | null,
  sortOrder: number,
  createdAt: number,
  updatedAt: number
): FolderDocType => ({
  id,
  name,
  userId: "",
  spaceId,
  parentId,
  type: "folder",
  sortOrder,
  isLocked: false,
  isPinned: false,
  isCollapsed: false,
  deletedAt: 0,
  purgeAt: 0,
  isDirty: false,
  serverVersion: 0,
  createdAt,
  updatedAt,
});

const collectEntries = (
  node: BrowserBookmarkNode,
  now: number,
  initialFolders: BookmarkFolder[] = []
): BookmarkEntry[] => {
  const entries: BookmarkEntry[] = [];
  const stack: Array<{ node: BrowserBookmarkNode; folders: BookmarkFolder[]; sortOrder: number }> = [
    { node, folders: initialFolders, sortOrder: Math.max(0, Math.floor(node.index ?? 0)) },
  ];

  while (stack.length > 0) {
    const current = stack.pop();
    if (!current) continue;
    const url = typeof current.node.url === "string" ? current.node.url.trim() : "";
    const browserId = typeof current.node.id === "string" ? current.node.id : "";
    if (url && browserId) {
      entries.push({
        browserId,
        title: bookmarkTitle(current.node.title, url),
        url,
        folders: current.folders,
        createdAt: clampTimestamp(current.node.dateAdded, now),
        sortOrder: current.sortOrder,
      });
      continue;
    }

    if (!browserId) continue;
    const folder: BookmarkFolder = {
      browserId,
      name: cleanLabel(current.node.title, "Untitled folder"),
      sortOrder: Math.max(0, Math.floor(current.node.index ?? current.sortOrder)),
      createdAt: clampTimestamp(current.node.dateAdded, now),
      updatedAt: clampTimestamp(current.node.dateGroupModified, now),
    };
    const nextFolders = [...current.folders, folder];
    const children = Array.isArray(current.node.children) ? current.node.children : [];
    for (let index = children.length - 1; index >= 0; index -= 1) {
      const child = children[index];
      stack.push({
        node: child,
        folders: nextFolders,
        sortOrder: Math.max(0, Math.floor(child.index ?? index)),
      });
    }
  }

  return entries;
};

const collectBookmarkCollections = (tree: BrowserBookmarkNode[], now: number): BookmarkCollection[] => {
  const collections: BookmarkCollection[] = [];
  const rootEntries: BookmarkEntry[] = [];
  const rootNodes = tree.flatMap((node) => (node.id === "0" && Array.isArray(node.children) ? node.children : [node]));

  for (const node of rootNodes) {
    const nodeId = typeof node.id === "string" ? node.id : "";
    const url = typeof node.url === "string" ? node.url.trim() : "";
    if (url && nodeId) {
      rootEntries.push({
        browserId: nodeId,
        title: bookmarkTitle(node.title, url),
        url,
        folders: [
          {
            browserId: ROOT_BOOKMARKS_SOURCE_ID,
            name: "Unsorted bookmarks",
            sortOrder: Number.MAX_SAFE_INTEGER - 1,
            createdAt: now,
            updatedAt: now,
          },
        ],
        createdAt: clampTimestamp(node.dateAdded, now),
        sortOrder: Math.max(0, Math.floor(node.index ?? rootEntries.length)),
      });
      continue;
    }
    if (!nodeId) continue;

    const entries = collectEntries(node, now);
    if (entries.length > 0) {
      collections.push({
        id: nodeId,
        name: cleanLabel(node.title, "Untitled folder"),
        entries,
      });
    }
  }

  if (rootEntries.length > 0) {
    collections.push({
      id: ROOT_BOOKMARKS_SOURCE_ID,
      name: "Unsorted bookmarks",
      entries: rootEntries,
    });
  }
  return collections;
};

export const buildBrowserBookmarkImportPlan = (
  payload: { tree?: BrowserBookmarkNode[] },
  options?: { now?: number }
): BrowserBookmarkImportPlan => {
  const now = options?.now ?? Date.now();
  const tree = Array.isArray(payload.tree) ? payload.tree : [];
  const spaceGroup: SpaceGroupDocType = {
    id: BROWSER_BOOKMARKS_SPACE_GROUP_ID,
    name: BROWSER_BOOKMARKS_SPACE_GROUP_NAME,
    sortOrder: now,
    isCollapsed: false,
    createdAt: now,
    updatedAt: now,
  };
  const spaces: SpaceDocType[] = [];
  const folders: FolderDocType[] = [];
  const bookmarks: ItemDocType[] = [];

  for (const collection of collectBookmarkCollections(tree, now)) {
    const parts = chunk(collection.entries, MAX_BOOKMARKS_PER_SPACE);
    for (let partIndex = 0; partIndex < parts.length; partIndex += 1) {
      const part = parts[partIndex];
      const spaceId = stableId("space", `${collection.id}:${partIndex}`);
      const suffix = parts.length > 1 ? ` (${partIndex + 1})` : "";
      const spaceName = `${collection.name}${suffix}`.slice(0, 80);
      spaces.push({
        id: spaceId,
        name: spaceName,
        slug: spaceSlug(spaceName, `browser-bookmarks-${partIndex + 1}`),
        spaceGroupId: BROWSER_BOOKMARKS_SPACE_GROUP_ID,
        isPrivate: false,
        autoLockMs: 5 * 60 * 1000,
        sortOrder: spaces.length,
        isArchived: false,
        deletedAt: 0,
        purgeAt: 0,
        createdAt: now,
        updatedAt: now,
      });

      const folderIds = new Map<string, string>();
      const itemOrderByFolder = new Map<string, number>();
      for (const entry of part) {
        let parentId: string | null = null;
        for (const sourceFolder of entry.folders) {
          const folderKey = `${spaceId}:${sourceFolder.browserId}`;
          let folderId = folderIds.get(folderKey);
          if (!folderId) {
            folderId = stableId("folder", folderKey);
            folderIds.set(folderKey, folderId);
            folders.push(
              createFolder(
                folderId,
                sourceFolder.name,
                spaceId,
                parentId,
                sourceFolder.sortOrder,
                sourceFolder.createdAt,
                sourceFolder.updatedAt
              )
            );
          }
          parentId = folderId;
        }
        if (!parentId) continue;
        const nextOrder = itemOrderByFolder.get(parentId) || 0;
        itemOrderByFolder.set(parentId, nextOrder + 1);
        bookmarks.push({
          id: stableId("bookmark", entry.browserId),
          userId: "",
          title: entry.title,
          textContent: "",
          ocrText: "",
          ocrStatus: "skipped",
          ocrModelVersion: "",
          ocrUpdatedAt: 0,
          url: entry.url,
          source: inferSource(entry.url),
          folderId: parentId,
          spaceId,
          isFavorite: false,
          media: [],
          parentId: null,
          chunkOrder: nextOrder,
          vector_index: -1,
          vector_indexes: [],
          isEmbedded: false,
          isMetaFetched: false,
          isDirty: false,
          serverVersion: 0,
          createdAt: entry.createdAt,
          updatedAt: entry.createdAt,
          deletedAt: 0,
        });
      }
    }
  }

  const itemCountByFolder = new Map<string, number>();
  for (const bookmark of bookmarks) {
    itemCountByFolder.set(bookmark.folderId, (itemCountByFolder.get(bookmark.folderId) || 0) + 1);
  }
  for (const folder of folders) {
    // New large imports start collapsed. Existing folder state is preserved by
    // updateFolder, so opening a group remains a deliberate user choice.
    folder.isCollapsed = (itemCountByFolder.get(folder.id) || 0) > 300;
  }

  return { spaceGroup, spaces, folders, bookmarks };
};

const folderMatches = (existing: FolderDocType, candidate: FolderDocType): boolean =>
  existing.name === candidate.name &&
  existing.spaceId === candidate.spaceId &&
  existing.parentId === candidate.parentId &&
  existing.sortOrder === candidate.sortOrder &&
  existing.type === candidate.type;

const spaceMatches = (existing: SpaceDocType, candidate: SpaceDocType): boolean =>
  existing.name === candidate.name &&
  existing.slug === candidate.slug &&
  existing.spaceGroupId === candidate.spaceGroupId &&
  existing.isPrivate === false &&
  existing.isArchived === false &&
  existing.sortOrder === candidate.sortOrder;

const updateFolder = (existing: FolderDocType | undefined, candidate: FolderDocType, now: number) => {
  if (!existing) return candidate;
  if (folderMatches(existing, candidate)) return null;
  return {
    ...existing,
    name: candidate.name,
    spaceId: candidate.spaceId,
    parentId: candidate.parentId,
    type: candidate.type,
    sortOrder: candidate.sortOrder,
    isDirty: false,
    updatedAt: now,
  } satisfies FolderDocType;
};

const updateBookmark = (existing: ItemDocType | undefined, candidate: ItemDocType, now: number) => {
  if (!existing) return candidate;
  const urlChanged = existing.url !== candidate.url;
  const locationChanged =
    existing.title !== candidate.title ||
    existing.folderId !== candidate.folderId ||
    existing.spaceId !== candidate.spaceId ||
    existing.chunkOrder !== candidate.chunkOrder ||
    existing.source !== candidate.source ||
    existing.deletedAt !== 0;
  if (!urlChanged && !locationChanged) return null;
  return {
    ...existing,
    title: candidate.title,
    url: candidate.url,
    source: candidate.source,
    folderId: candidate.folderId,
    spaceId: candidate.spaceId,
    chunkOrder: candidate.chunkOrder,
    isMetaFetched: urlChanged ? false : existing.isMetaFetched,
    vector_index: -1,
    vector_indexes: [],
    isEmbedded: false,
    isDirty: false,
    deletedAt: 0,
    updatedAt: now,
  } satisfies ItemDocType;
};

const notifyDbChange = (scope: "spaces" | "space_groups" | "folders" | "items") => {
  try {
    chrome.runtime.sendMessage({ type: "DB_CHANGE", scope });
  } catch {}
};

type BrowserBookmarkImportDb = Awaited<ReturnType<typeof getDb>>;

type BrowserBookmarkCloudSync = Pick<typeof cloudSyncService, "enqueueDocs">;

export type BrowserBookmarkImportServiceOptions = {
  getDb?: () => Promise<BrowserBookmarkImportDb>;
  cloudSync?: BrowserBookmarkCloudSync;
  markSearchDirty?: () => void;
  now?: () => number;
  yieldToEventLoop?: () => Promise<void>;
  notifyDbChange?: (scope: "spaces" | "space_groups" | "folders" | "items") => void;
};

export class BrowserBookmarkImportService {
  constructor(private readonly options: BrowserBookmarkImportServiceOptions = {}) {}

  async hasImported(): Promise<boolean> {
    const db = await (this.options.getDb ?? getDb)();
    return Boolean(await db.space_groups.findOne(BROWSER_BOOKMARKS_SPACE_GROUP_ID).exec());
  }

  async importTree(payload: { tree?: BrowserBookmarkNode[] }): Promise<BrowserBookmarkImportResult> {
    const db = await (this.options.getDb ?? getDb)();
    const now = this.options.now?.() ?? Date.now();
    const sync = this.options.cloudSync ?? cloudSyncService;
    const yieldNow = this.options.yieldToEventLoop ?? yieldToEventLoop;
    const publishDbChange = this.options.notifyDbChange ?? notifyDbChange;
    const plan = buildBrowserBookmarkImportPlan(payload, { now });

    const existingGroup = await db.space_groups.findOne(BROWSER_BOOKMARKS_SPACE_GROUP_ID).exec();
    const currentGroup = existingGroup?.toMutableJSON() as SpaceGroupDocType | undefined;
    const groupUpdate = !currentGroup
      ? plan.spaceGroup
      : currentGroup.name === BROWSER_BOOKMARKS_SPACE_GROUP_NAME
        ? null
        : {
            ...currentGroup,
            name: BROWSER_BOOKMARKS_SPACE_GROUP_NAME,
            updatedAt: now,
          };
    if (groupUpdate) await db.space_groups.bulkUpsert([groupUpdate]);

    const existingSpaces = await db.spaces
      .find({ selector: { spaceGroupId: { $eq: BROWSER_BOOKMARKS_SPACE_GROUP_ID } } })
      .exec();
    const existingSpacesById = new Map(
      existingSpaces.map((doc) => [doc.get("id") as string, doc.toMutableJSON() as SpaceDocType])
    );
    const plannedSpaceIds = new Set(plan.spaces.map((space) => space.id));
    const spaceUpdates = plan.spaces
      .map((space) => {
        const existing = existingSpacesById.get(space.id);
        if (!existing) return space;
        if (spaceMatches(existing, space)) return null;
        return {
          ...existing,
          name: space.name,
          slug: space.slug,
          spaceGroupId: BROWSER_BOOKMARKS_SPACE_GROUP_ID,
          isPrivate: false,
          isArchived: false,
          sortOrder: space.sortOrder,
          updatedAt: now,
        } satisfies SpaceDocType;
      })
      .filter((space): space is SpaceDocType => space !== null);
    const archivedSpaces = Array.from(existingSpacesById.values())
      .filter((space) => !plannedSpaceIds.has(space.id) && !space.isArchived)
      .map((space) => ({ ...space, isArchived: true, updatedAt: now }));
    const changedSpaces = [...spaceUpdates, ...archivedSpaces];
    for (const batch of chunk(changedSpaces, IMPORT_BATCH_SIZE)) {
      await db.spaces.bulkUpsert(batch);
      await yieldNow();
    }

    const relevantSpaceIds = Array.from(
      new Set([...existingSpacesById.keys(), ...plan.spaces.map((space) => space.id)])
    );
    const [existingFolderDocs, existingItemDocs] = relevantSpaceIds.length
      ? await Promise.all([
          db.folders.find({ selector: { spaceId: { $in: relevantSpaceIds } } }).exec(),
          db.items.find({ selector: { spaceId: { $in: relevantSpaceIds } } }).exec(),
        ])
      : [[], []];
    const existingFolders = new Map(
      existingFolderDocs.map((doc) => [doc.get("id") as string, doc.toMutableJSON() as FolderDocType])
    );
    const existingItems = new Map(
      existingItemDocs.map((doc) => [doc.get("id") as string, doc.toMutableJSON() as ItemDocType])
    );

    const changedFolders: FolderDocType[] = [];
    for (const folderBatch of chunk(plan.folders, IMPORT_BATCH_SIZE)) {
      const updates = folderBatch
        .map((folder) => updateFolder(existingFolders.get(folder.id), folder, now))
        .filter((folder): folder is FolderDocType => folder !== null);
      if (updates.length > 0) {
        await db.folders.bulkUpsert(updates);
        changedFolders.push(...updates);
      }
      await yieldNow();
    }

    const metadataUrls = new Set<string>();
    const changedBookmarks: ItemDocType[] = [];
    for (const bookmarkBatch of chunk(plan.bookmarks, IMPORT_BATCH_SIZE)) {
      const updates = bookmarkBatch
        .map((bookmark) => {
          const existing = existingItems.get(bookmark.id);
          const update = updateBookmark(existing, bookmark, now);
          if (!existing || existing.url !== bookmark.url) {
            metadataUrls.add(bookmark.url);
          }
          return update;
        })
        .filter((bookmark): bookmark is ItemDocType => bookmark !== null);
      if (updates.length > 0) {
        await db.items.bulkUpsert(updates);
        changedBookmarks.push(...updates);
      }
      await yieldNow();
    }

    const plannedFolderIds = new Set(plan.folders.map((folder) => folder.id));
    const staleFolderIds = Array.from(existingFolders.values())
      .filter((folder) => !plannedFolderIds.has(folder.id))
      .map((folder) => folder.id);
    for (const batch of chunk(staleFolderIds, IMPORT_BATCH_SIZE)) {
      await db.folders.bulkRemove(batch);
      await yieldNow();
    }

    const plannedBookmarkIds = new Set(plan.bookmarks.map((bookmark) => bookmark.id));
    const staleBookmarkUpdates = Array.from(existingItems.values())
      .filter((item) => !plannedBookmarkIds.has(item.id) && item.deletedAt === 0)
      .map((item) => ({ ...item, deletedAt: now, updatedAt: now, isDirty: false }));
    if (staleBookmarkUpdates.length > 0) {
      for (const batch of chunk(staleBookmarkUpdates, IMPORT_BATCH_SIZE)) {
        await db.items.bulkUpsert(batch);
        await yieldNow();
      }
    }

    const cloudChanges: CloudSyncDocBatch = {
      spaceGroups: groupUpdate ? [groupUpdate] : [],
      spaces: changedSpaces,
      folders: changedFolders,
      items: [...changedBookmarks, ...staleBookmarkUpdates],
      deletes: staleFolderIds.map((id) => ({ collection: "folders", id, updatedAt: now, deletedAt: now })),
    };
    const changedCount =
      cloudChanges.spaceGroups!.length +
      cloudChanges.spaces!.length +
      cloudChanges.folders!.length +
      cloudChanges.items!.length +
      cloudChanges.deletes!.length;
    if (changedCount > 0) await sync.enqueueDocs(cloudChanges);

    if (changedBookmarks.length > 0 || staleBookmarkUpdates.length > 0) {
      (this.options.markSearchDirty ?? (() => localSearchIndexService.markDirty()))();
    }

    if (groupUpdate) publishDbChange("space_groups");
    if (changedSpaces.length > 0) publishDbChange("spaces");
    if (changedFolders.length > 0 || staleFolderIds.length > 0) publishDbChange("folders");
    if (changedBookmarks.length > 0 || staleBookmarkUpdates.length > 0) publishDbChange("items");

    return {
      spaceGroupId: BROWSER_BOOKMARKS_SPACE_GROUP_ID,
      spaceIds: plan.spaces.map((space) => space.id),
      primarySpaceId: plan.spaces[0]?.id || null,
      folderCount: plan.folders.length,
      bookmarkCount: plan.bookmarks.length,
      updatedFolderCount: changedFolders.length,
      updatedBookmarkCount: changedBookmarks.length,
      removedBookmarkCount: staleBookmarkUpdates.length,
      metadataUrls: Array.from(metadataUrls),
    };
  }
}

export const browserBookmarkImportService = new BrowserBookmarkImportService();
