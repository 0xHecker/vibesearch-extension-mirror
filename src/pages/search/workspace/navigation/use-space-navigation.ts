import { PRIVATE_SPACE_ID, PUBLIC_SPACE_ID } from "@src/common/spaces";
import type { PrivateAccessMode } from "../dialogs/private-space-access-dialog";
import type { FolderDocType } from "@src/schemas/folder_schema";
import type { SpaceGroupDocType } from "@src/schemas/space_group_schema";
import type { SpaceListItem } from "@src/services/spaces/types";
import { showErrorToast } from "@src/utils/toast-feedback";
import {
  useCallback,
  useEffect,
  type Dispatch,
  type MutableRefObject,
  type SetStateAction,
} from "react";
import { z } from "zod";

const commandResponseSchema = z.object({
  success: z.boolean(),
  error: z.string().optional(),
});

type SpaceNavigationOptions = {
  activeSpaceId: string;
  activeSpaceGroupId: string | null;
  activeSpaceGroupSpaceIds: string[];
  selectedFolderId: string;
  folders: FolderDocType[];
  spaces: SpaceListItem[];
  privateSpace: SpaceListItem | null;
  hasLoadedCurrentFolders: boolean;
  pendingUrlFolderId: MutableRefObject<string | null>;
  setActiveSpaceId: Dispatch<SetStateAction<string>>;
  setActiveSpaceGroupId: Dispatch<SetStateAction<string | null>>;
  setSelectedFolderId: Dispatch<SetStateAction<string>>;
  setSpaceGroups: Dispatch<SetStateAction<SpaceGroupDocType[]>>;
  openPrivateAccess: (mode: PrivateAccessMode) => void;
  refreshResults: () => void;
};

/** Owns sidebar space selection and reconciles folder URLs with loaded data. */
export function useSpaceNavigation({
  activeSpaceId,
  activeSpaceGroupId,
  activeSpaceGroupSpaceIds,
  selectedFolderId,
  folders,
  spaces,
  privateSpace,
  hasLoadedCurrentFolders,
  pendingUrlFolderId,
  setActiveSpaceId,
  setActiveSpaceGroupId,
  setSelectedFolderId,
  setSpaceGroups,
  openPrivateAccess,
  refreshResults,
}: SpaceNavigationOptions) {
  useEffect(() => {
    if (selectedFolderId === "all") return;
    const selectedFolder = folders.find(
      (folder) => folder.id === selectedFolderId,
    );
    if (selectedFolder) {
      pendingUrlFolderId.current = null;
      const selectedSpaceId = selectedFolder.spaceId || PUBLIC_SPACE_ID;
      const isInActiveContext = activeSpaceGroupId
        ? activeSpaceGroupSpaceIds.includes(selectedSpaceId)
        : activeSpaceId === selectedSpaceId;
      if (
        !isInActiveContext &&
        spaces.some((space) => space.id === selectedSpaceId)
      ) {
        setActiveSpaceId(selectedSpaceId);
        setActiveSpaceGroupId(null);
      }
      return;
    }
    if (!hasLoadedCurrentFolders) return;
    const lockedPrivateSpace =
      activeSpaceId === PRIVATE_SPACE_ID &&
      (!privateSpace || !privateSpace.access.isUnlocked);
    if (lockedPrivateSpace) return;
    pendingUrlFolderId.current = null;
    setSelectedFolderId("all");
  }, [
    activeSpaceGroupId,
    activeSpaceGroupSpaceIds,
    activeSpaceId,
    folders,
    hasLoadedCurrentFolders,
    pendingUrlFolderId,
    privateSpace,
    selectedFolderId,
    setActiveSpaceGroupId,
    setActiveSpaceId,
    setSelectedFolderId,
    spaces,
  ]);

  const selectSpace = useCallback(
    (space: SpaceListItem): void => {
      if (space.isPrivate && !space.access.isUnlocked) {
        setActiveSpaceGroupId(null);
        setSelectedFolderId("all");
        openPrivateAccess(space.access.requiresPassword ? "setup" : "unlock");
        return;
      }
      setActiveSpaceId(space.id);
      setActiveSpaceGroupId(null);
      setSelectedFolderId("all");
      refreshResults();
    },
    [
      openPrivateAccess,
      refreshResults,
      setActiveSpaceGroupId,
      setActiveSpaceId,
      setSelectedFolderId,
    ],
  );

  const selectSpaceGroup = useCallback(
    (group: SpaceGroupDocType): void => {
      setActiveSpaceGroupId(group.id);
      setSelectedFolderId("all");
      refreshResults();
    },
    [refreshResults, setActiveSpaceGroupId, setSelectedFolderId],
  );

  const toggleSpaceGroup = useCallback(
    async (group: SpaceGroupDocType): Promise<void> => {
      const nextCollapsed = !group.isCollapsed;
      updateCollapsedState(setSpaceGroups, group.id, nextCollapsed);
      try {
        const response = commandResponseSchema.parse(
          await chrome.runtime.sendMessage({
            service: "spaceGroups",
            type: "setCollapsed",
            target: "offscreen",
            payload: { id: group.id, value: nextCollapsed },
          }),
        );
        if (!response.success) {
          throw new Error(response.error ?? "Could not update space group.");
        }
      } catch (error) {
        updateCollapsedState(setSpaceGroups, group.id, group.isCollapsed);
        showErrorToast(
          error instanceof Error
            ? error.message
            : "Could not update space group.",
        );
      }
    },
    [setSpaceGroups],
  );

  return { selectSpace, selectSpaceGroup, toggleSpaceGroup };
}

function updateCollapsedState(
  setSpaceGroups: Dispatch<SetStateAction<SpaceGroupDocType[]>>,
  groupId: string,
  isCollapsed: boolean,
): void {
  setSpaceGroups((groups) =>
    groups.map((group) =>
      group.id === groupId ? { ...group, isCollapsed } : group,
    ),
  );
}
