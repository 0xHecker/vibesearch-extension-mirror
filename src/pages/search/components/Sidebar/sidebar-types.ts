import type { BinEntry } from "@src/common/bin";
import type { FolderDocType } from "@src/schemas/folder_schema";
import type { SpaceGroupDocType } from "@src/schemas/space_group_schema";

import type { SidebarSpace } from "./sidebar-sort";

export type SpaceMoveTarget = {
  id: string;
  name: string;
  isPrivate: boolean;
};

export type InlineRenameState = {
  kind: "folder" | "space" | "spaceGroup";
  id: string;
  value: string;
};

export type SidebarHandlers = {
  selectSpace: (space: SidebarSpace) => void;
  selectSpaceGroup: (group: SpaceGroupDocType) => void;
  selectFolder: (folderId: string | "all") => void;
  toggleSpaceGroupCollapse: (group: SpaceGroupDocType) => void;
  toggleFolderCollapse: (folder: FolderDocType) => void;
  pinFolder: (folder: FolderDocType, value: boolean) => void;
  reorderFolders: (
    orderedIds: string[],
    spaceId: string,
    parentId: string | null,
  ) => Promise<void>;
  moveFolderToParent: (
    folderId: string,
    parentId: string | null,
  ) => Promise<void>;
  moveFolderToSpace: (folderId: string, spaceId: string) => Promise<void>;
  moveFolderToSpaceGroup: (
    folderId: string,
    spaceGroupId: string,
  ) => Promise<void>;
  renameFolder: (id: string, name: string) => Promise<void>;
  createFolder: (
    name: string,
    spaceId: string,
    parentId: string | null,
  ) => Promise<void>;
  deleteFolder: (id: string, alsoDeleteItems: boolean) => Promise<void>;
  getFolderItemCount: (ids: string[]) => Promise<Record<string, number>>;
  renameSpace: (id: string, name: string) => Promise<void>;
  moveSpaceToGroup: (id: string, groupId: string | null) => Promise<void>;
  lockSpace: (space: SidebarSpace) => void;
  reorderSpaces: (
    orderedIds: string[],
    groupId: string | null,
  ) => Promise<void>;
  moveSpaceToBin: (id: string) => Promise<void>;
  restoreSpaceFromBin: (id: string) => Promise<void>;
  deleteSpaceForever: (id: string, expectedDeletedAt: number) => Promise<void>;
  restoreFolderFromBin: (id: string) => Promise<void>;
  deleteFolderForever: (id: string, expectedDeletedAt: number) => Promise<void>;
  restoreItemFromBin: (id: string) => Promise<void>;
  deleteItemForever: (id: string, expectedDeletedAt: number) => Promise<void>;
  reorderSpaceGroups: (orderedIds: string[]) => Promise<void>;
  renameSpaceGroup: (id: string, name: string) => Promise<void>;
  deleteSpaceGroup: (
    id: string,
    mode: "moveToUngrouped" | "deleteContents",
  ) => Promise<void>;
  newSpace: (groupId?: string | null) => void;
  newSpaceGroup: () => void;
  importBrowserBookmarks: () => void;
  importGitHubStars: () => void;
  importSharedLink: () => void;
  openChangeSpacePassword: (space: SidebarSpace) => void;
  unlockSpace: (space: SidebarSpace) => void;
  shareFolder: (folder: FolderDocType) => void;
  shareSpace: (space: SidebarSpace) => void;
  shareSpaceGroup: (group: SpaceGroupDocType) => void;
};

export type SidebarProps = {
  spaces: SidebarSpace[];
  spaceGroups: SpaceGroupDocType[];
  folders: FolderDocType[];
  activeSpaceId: string;
  activeSpaceGroupId: string | null;
  selectedFolderId: string | "all";
  binEntries: BinEntry[];
  binTotal: number;
  binHasMore: boolean;
  binPage: number;
  binPageLoading: boolean;
  onNextBinPage: () => void;
  onPreviousBinPage: () => void;
  onOpenBin: () => void;
  now: number;
  handlers: SidebarHandlers;
  /** Incremented by the page (e.g. Settings → Open bin) to open the Bin view. */
  openBinNonce?: number;
};

export type DeleteFolderState = {
  folder: FolderDocType;
  itemCount: number | null;
  alsoDeleteItems: boolean;
};

export type DeleteSpaceState = { space: SidebarSpace };

export type DeleteSpaceGroupState = {
  group: SpaceGroupDocType;
  mode: "moveToUngrouped" | "deleteContents";
};

export type DeleteBinEntryState = { entry: BinEntry };

export type NewTabGroupTarget = {
  spaceId: string;
  parentId: string | null;
  name: string;
};
