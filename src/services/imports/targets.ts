import { LIVE_SPACE_SELECTOR, PUBLIC_SPACE_ID } from "@src/common/spaces";
import type { MyDatabase } from "@src/services/DatabaseService";
import { spaceSessionService } from "@src/services/space-session.service";

export type ImportTargetItemPreview = {
  id: string;
  title: string;
  updatedAt: number;
};

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

export type ImportTargetOptions = {
  maxSpaces?: number;
  maxFoldersPerSpace?: number;
  maxItemsPerFolder?: number;
};

/** Read import destinations from an explicit database so the query is independently testable. */
export async function readImportTargets(
  db: MyDatabase,
  payload?: ImportTargetOptions,
): Promise<ImportTargetSpace[]> {
  const includeAllSpaces = payload?.maxSpaces === 0;
  const includeAllFolders = payload?.maxFoldersPerSpace === 0;
  const skipRecentItems = payload?.maxItemsPerFolder === 0;
  const maxSpaces = Math.max(1, Math.min(20, payload?.maxSpaces ?? 8));
  const maxFoldersPerSpace = Math.max(1, Math.min(40, payload?.maxFoldersPerSpace ?? 14));
  const maxItemsPerFolder = Math.max(1, Math.min(6, payload?.maxItemsPerFolder ?? 3));

  const spaceDocs = await db.spaces.find({ selector: { ...LIVE_SPACE_SELECTOR } }).exec();
  const sortedSpaces = spaceDocs
    .map((document) => document.toMutableJSON())
    .sort((left, right) => {
      if (left.isPrivate !== right.isPrivate) return left.isPrivate ? 1 : -1;
      const leftOrder = left.sortOrder ?? Number.MAX_SAFE_INTEGER;
      const rightOrder = right.sortOrder ?? Number.MAX_SAFE_INTEGER;
      if (leftOrder !== rightOrder) return leftOrder - rightOrder;
      return (left.createdAt || 0) - (right.createdAt || 0);
    });
  const spaces = includeAllSpaces ? sortedSpaces : sortedSpaces.slice(0, maxSpaces);

  const results: ImportTargetSpace[] = [];
  for (const space of spaces) {
    const spaceId = space.id || PUBLIC_SPACE_ID;
    const isPrivate = space.isPrivate === true;
    const isUnlocked = !isPrivate || spaceSessionService.isUnlocked(spaceId);
    const spaceEntry: ImportTargetSpace = {
      id: spaceId,
      name: space.name || "Untitled",
      slug: space.slug || "",
      isPrivate,
      isUnlocked,
      sortOrder: space.sortOrder ?? 0,
      folders: [],
    };

    if (!isUnlocked) {
      results.push(spaceEntry);
      continue;
    }

    const folderDocs = await db.folders.find({
      selector: {
        spaceId: { $eq: spaceId },
        deletedAt: { $eq: 0 },
      },
    }).exec();
    const sortedFolders = folderDocs
      .map((document) => document.toMutableJSON())
      .sort((left, right) => {
        if (left.isPinned !== right.isPinned) return left.isPinned ? -1 : 1;
        const leftOrder = left.sortOrder ?? Number.MAX_SAFE_INTEGER;
        const rightOrder = right.sortOrder ?? Number.MAX_SAFE_INTEGER;
        if (leftOrder !== rightOrder) return leftOrder - rightOrder;
        return left.createdAt - right.createdAt;
      });
    const folders = includeAllFolders
      ? sortedFolders
      : sortedFolders.slice(0, maxFoldersPerSpace);

    for (const folder of folders) {
      const itemDocs = skipRecentItems
        ? []
        : await db.items.find({
            selector: {
              folderId: { $eq: folder.id },
              deletedAt: { $eq: 0 },
            },
            sort: [{ updatedAt: "desc" }],
            limit: maxItemsPerFolder,
          }).exec();
      const recentItems = itemDocs.map((document) => {
        const item = document.toMutableJSON();
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
        isPinned: folder.isPinned === true,
        updatedAt: folder.updatedAt || folder.createdAt || 0,
        recentItems,
      });
    }
    results.push(spaceEntry);
  }
  return results;
}
