import { PUBLIC_SPACE_ID } from "@src/common/spaces";
import type { FolderDocType } from "@src/schemas/folder_schema";

type SpaceLike = {
  id: string;
  spaceGroupId?: string | null;
};

type SelectableItemLike = {
  id: string;
};

type LocatedItemLike = {
  id: string;
  folderId: string;
  spaceId: string;
};

export type FolderSelectionContext = {
  activeSpaceId: string;
  activeSpaceGroupId: string | null;
  selectedFolderId: string;
};

export type VisibleSelectionState = {
  allVisibleSelected: boolean;
  someVisibleSelected: boolean;
};

export const buildFolderLoadKey = (input: {
  activeSpaceId: string;
  searchScope: string;
  spaceIds?: string[];
}): string => {
  const spaceIds = [...(input.spaceIds || [])].filter(Boolean).sort().join(",");
  return `${input.activeSpaceId || PUBLIC_SPACE_ID}|${input.searchScope || "current"}|${spaceIds}`;
};

export const resolveFolderSelectionContext = (
  folderId: string,
  folders: Pick<FolderDocType, "id" | "spaceId">[],
  spaces: SpaceLike[]
): FolderSelectionContext | null => {
  if (!folderId || folderId === "all") {
    return {
      activeSpaceId: PUBLIC_SPACE_ID,
      activeSpaceGroupId: null,
      selectedFolderId: "all",
    };
  }

  const folder = folders.find((entry) => entry.id === folderId);
  if (!folder) return null;

  const activeSpaceId = folder.spaceId || PUBLIC_SPACE_ID;
  const space = spaces.find((entry) => entry.id === activeSpaceId) || null;
  return {
    activeSpaceId,
    activeSpaceGroupId: space?.spaceGroupId || null,
    selectedFolderId: folderId,
  };
};

/** Derive the browse context used when leaving search results to reveal an item. */
export const resolveSearchResultSelectionContext = (
  item: LocatedItemLike
): FolderSelectionContext => {
  const activeSpaceId = item.spaceId || PUBLIC_SPACE_ID;

  return {
    activeSpaceId,
    // A folder reveal is an exact location, not a collection-wide browse.
    activeSpaceGroupId: null,
    selectedFolderId: item.folderId || "all",
  };
};

/** Keep the pending reveal item available while the bounded folder page renders. */
export const includePendingRevealItem = <Item extends LocatedItemLike>(
  pageItems: readonly Item[],
  pendingItem: Item | null,
  selection: FolderSelectionContext
): Item[] => {
  if (!pendingItem || pageItems.some((item) => item.id === pendingItem.id)) {
    return pageItems as Item[];
  }
  if (
    pendingItem.spaceId !== selection.activeSpaceId ||
    (selection.selectedFolderId !== "all" &&
      pendingItem.folderId !== selection.selectedFolderId)
  ) {
    return pageItems as Item[];
  }

  // Folder browsing is intentionally paginated. Keep just the requested item
  // beside that bounded page so Reveal works for older entries without
  // mounting the folder's entire media-heavy item tree.
  // Keep it at the front because the folder renderer independently caps its
  // mounted page. A trailing 101st item would still never reach the DOM.
  return [pendingItem, ...pageItems];
};

export const buildSearchSelectionSearch = (input: {
  currentSearch: string;
  activeSpaceId: string;
  activeSpaceGroupId: string | null;
  selectedFolderId: string;
}): string => {
  const params = new URLSearchParams(input.currentSearch);
  if (input.activeSpaceId && input.activeSpaceId !== PUBLIC_SPACE_ID) {
    params.set("space", input.activeSpaceId);
  } else {
    params.delete("space");
  }
  if (input.activeSpaceGroupId) params.set("group", input.activeSpaceGroupId);
  else params.delete("group");
  if (input.selectedFolderId && input.selectedFolderId !== "all") {
    params.set("folder", input.selectedFolderId);
  } else {
    params.delete("folder");
  }
  return params.toString();
};

export const getVisibleSelectionState = (
  items: readonly SelectableItemLike[],
  selectedIds: ReadonlySet<string>
): VisibleSelectionState => {
  const allVisibleSelected = items.length > 0 && items.every((item) => selectedIds.has(item.id));
  const someVisibleSelected =
    !allVisibleSelected && items.some((item) => selectedIds.has(item.id));

  return { allVisibleSelected, someVisibleSelected };
};
