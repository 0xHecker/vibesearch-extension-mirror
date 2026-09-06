import { useCallback } from "react";

import type { FolderDocType } from "@src/schemas/folder_schema";
import type { SpaceGroupDocType } from "@src/schemas/space_group_schema";

import type { SidebarSpace } from "./sidebar-sort";
import type { SidebarHandlers } from "./sidebar-types";

type SidebarOrderOptions = {
  sortedSpaceGroups: SpaceGroupDocType[];
  ungroupedSpaces: SidebarSpace[];
  spacesByGroupId: Map<string, SidebarSpace[]>;
  folderChildren: Map<string | null, FolderDocType[]>;
  handlers: SidebarHandlers;
};

type SidebarOrderActions = {
  moveSpaceUp: (space: SidebarSpace) => Promise<void>;
  moveSpaceDown: (space: SidebarSpace) => Promise<void>;
  moveSpaceGroupUp: (group: SpaceGroupDocType) => Promise<void>;
  moveSpaceGroupDown: (group: SpaceGroupDocType) => Promise<void>;
  moveFolderUp: (folder: FolderDocType) => Promise<void>;
  moveFolderDown: (folder: FolderDocType) => Promise<void>;
  toggleFolderPin: (folder: FolderDocType) => Promise<void>;
};

export function useSidebarOrderActions({
  sortedSpaceGroups,
  ungroupedSpaces,
  spacesByGroupId,
  folderChildren,
  handlers,
}: SidebarOrderOptions): SidebarOrderActions {
  const moveSpace = useCallback(
    async (space: SidebarSpace, offset: -1 | 1) => {
      const siblings = space.spaceGroupId
        ? (spacesByGroupId.get(space.spaceGroupId) ?? [])
        : ungroupedSpaces;
      const orderedIds = moveId(siblings, space.id, offset);
      if (orderedIds) {
        await handlers.reorderSpaces(orderedIds, space.spaceGroupId);
      }
    },
    [handlers, spacesByGroupId, ungroupedSpaces],
  );

  const moveSpaceGroup = useCallback(
    async (group: SpaceGroupDocType, offset: -1 | 1) => {
      const orderedIds = moveId(sortedSpaceGroups, group.id, offset);
      if (orderedIds) await handlers.reorderSpaceGroups(orderedIds);
    },
    [handlers, sortedSpaceGroups],
  );

  const moveFolder = useCallback(
    async (folder: FolderDocType, offset: -1 | 1) => {
      const siblings = folderChildren.get(folder.parentId ?? null) ?? [];
      const orderedIds = moveId(siblings, folder.id, offset);
      if (!orderedIds) return;
      await handlers.reorderFolders(
        orderedIds,
        folder.spaceId,
        folder.parentId ?? null,
      );
    },
    [folderChildren, handlers],
  );

  const toggleFolderPin = useCallback(
    async (folder: FolderDocType) => {
      try {
        await handlers.pinFolder(folder, !folder.isPinned);
      } catch (error) {
        console.error("[Sidebar] toggle folder pin failed", error);
      }
    },
    [handlers],
  );

  return {
    moveSpaceUp: (space) => moveSpace(space, -1),
    moveSpaceDown: (space) => moveSpace(space, 1),
    moveSpaceGroupUp: (group) => moveSpaceGroup(group, -1),
    moveSpaceGroupDown: (group) => moveSpaceGroup(group, 1),
    moveFolderUp: (folder) => moveFolder(folder, -1),
    moveFolderDown: (folder) => moveFolder(folder, 1),
    toggleFolderPin,
  };
}

function moveId(
  siblings: ReadonlyArray<{ id: string }>,
  id: string,
  offset: -1 | 1,
): string[] | null {
  const currentIndex = siblings.findIndex((sibling) => sibling.id === id);
  const destinationIndex = currentIndex + offset;
  if (
    currentIndex === -1 ||
    destinationIndex < 0 ||
    destinationIndex >= siblings.length
  ) {
    return null;
  }

  const orderedIds = siblings.map((sibling) => sibling.id);
  const destinationId = orderedIds[destinationIndex];
  orderedIds[destinationIndex] = id;
  orderedIds[currentIndex] = destinationId;
  return orderedIds;
}
