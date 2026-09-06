import { PRIVATE_SPACE_ID, PUBLIC_SPACE_ID } from "@src/common/spaces";
import type { JsonValue } from "@src/common/json-value";
import type {
  SidebarHandlers,
  SidebarSpace,
} from "@src/pages/search/components/Sidebar/Sidebar";
import { resolveFolderSelectionContext } from "@src/pages/search/selection-state";
import type { FolderDocType } from "@src/schemas/folder_schema";
import type { SpaceGroupDocType } from "@src/schemas/space_group_schema";
import type { QueryScope } from "@src/search-core/contracts";
import type { MixedShareSelection } from "@src/services/share-snapshot";
import { showErrorToast, showSuccessToast } from "@src/utils/toast-feedback";
import {
  useCallback,
  useMemo,
  type Dispatch,
  type MutableRefObject,
  type SetStateAction,
} from "react";
import { z } from "zod";
import type { PrivateAccessMode } from "../dialogs/private-space-access-dialog";
import { sendRuntimeMessage } from "../runtime/message";
import { QUERY_REQUEST_TIMEOUT_MS } from "../query/model";
import type { FolderLoadContext } from "../library/use-library-data";

const commandResponseSchema = z.object({
  success: z.boolean(),
  error: z.string().optional(),
  payload: z.json().optional(),
});

const restoreResultSchema = z.object({
  message: z.string().optional(),
  relocated: z.boolean().optional(),
});

const resolvedSpaceSchema = z.object({ id: z.string().min(1) });
const folderCountsResponseSchema = z.object({
  payload: z.record(z.string(), z.number()).optional(),
});

type CommandResponse = z.infer<typeof commandResponseSchema>;

type SidebarHandlerOptions = {
  activeSpaceId: string;
  activeSpaceGroupId: string | null;
  activeSpaceGroupSpaceIds: string[];
  requestedScope: QueryScope;
  folders: FolderDocType[];
  spaces: SidebarSpace[];
  pendingUrlFolderId: MutableRefObject<string | null>;
  setActiveSpaceId: Dispatch<SetStateAction<string>>;
  setActiveSpaceGroupId: Dispatch<SetStateAction<string | null>>;
  setSelectedFolderId: Dispatch<SetStateAction<string>>;
  setFolders: Dispatch<SetStateAction<FolderDocType[]>>;
  selectSpace: (space: SidebarSpace) => void;
  selectSpaceGroup: (group: SpaceGroupDocType) => void;
  toggleSpaceGroup: (group: SpaceGroupDocType) => void;
  loadFolders: (context?: FolderLoadContext) => Promise<void>;
  loadSpaces: () => Promise<SidebarSpace[]>;
  loadSpaceGroups: () => Promise<SpaceGroupDocType[]>;
  loadBinContents: () => Promise<void>;
  lockPrivateSpace: (detail: string) => Promise<void>;
  scheduleQueryRefresh: (priority: "low" | "high") => void;
  refresh: () => void;
  openCreateSpace: (groupId?: string | null) => void;
  openCreateSpaceGroup: () => void;
  openBrowserBookmarksImport: () => void;
  openGitHubStarsImport: () => Promise<void>;
  openSharedImport: () => void;
  openPasswordChange: () => void;
  openPrivateAccess: (mode: PrivateAccessMode) => void;
  openShare: (selection: MixedShareSelection) => void;
};

async function requestCommand(
  service: string,
  type: string,
  payload: JsonValue,
): Promise<CommandResponse> {
  return commandResponseSchema.parse(
    await chrome.runtime.sendMessage({
      service,
      type,
      target: "offscreen",
      payload,
    }),
  );
}

async function performCommand(options: {
  service: string;
  type: string;
  payload: JsonValue;
  failureMessage: string;
  successMessage?: string;
}): Promise<CommandResponse | undefined> {
  try {
    const response = await requestCommand(
      options.service,
      options.type,
      options.payload,
    );
    if (!response.success) {
      throw new Error(response.error ?? options.failureMessage);
    }
    if (options.successMessage) showSuccessToast(options.successMessage);
    return response;
  } catch (error) {
    showErrorToast(
      error instanceof Error ? error.message : options.failureMessage,
    );
    return undefined;
  }
}

function shareSelection(
  kind: "folder" | "space" | "spaceGroup",
  id: string,
): MixedShareSelection {
  return {
    folderIds: new Set(kind === "folder" ? [id] : []),
    itemIds: new Set(),
    spaceIds: new Set(kind === "space" ? [id] : []),
    spaceGroupIds: new Set(kind === "spaceGroup" ? [id] : []),
  };
}

/** Build the sidebar's persistence commands away from the page renderer. */
export function useSidebarHandlers({
  activeSpaceId,
  activeSpaceGroupId,
  activeSpaceGroupSpaceIds,
  requestedScope,
  folders,
  spaces,
  pendingUrlFolderId,
  setActiveSpaceId,
  setActiveSpaceGroupId,
  setSelectedFolderId,
  setFolders,
  selectSpace,
  selectSpaceGroup,
  toggleSpaceGroup,
  loadFolders,
  loadSpaces,
  loadSpaceGroups,
  loadBinContents,
  lockPrivateSpace,
  scheduleQueryRefresh,
  refresh,
  openCreateSpace,
  openCreateSpaceGroup,
  openBrowserBookmarksImport,
  openGitHubStarsImport,
  openSharedImport,
  openPasswordChange,
  openPrivateAccess,
  openShare,
}: SidebarHandlerOptions) {
  const refreshFolders = useCallback((): void => {
    void loadFolders({
      activeSpaceId,
      searchScope: activeSpaceGroupId ? "global" : requestedScope,
      spaceIds: activeSpaceGroupId ? activeSpaceGroupSpaceIds : undefined,
    });
  }, [
    activeSpaceGroupId,
    activeSpaceGroupSpaceIds,
    activeSpaceId,
    loadFolders,
    requestedScope,
  ]);

  const handlers = useMemo<SidebarHandlers>(
    () => ({
      selectSpace,
      selectSpaceGroup,
      selectFolder: (folderId) => {
        pendingUrlFolderId.current = null;
        if (folderId !== "all") {
          const context = resolveFolderSelectionContext(
            folderId,
            folders,
            spaces,
          );
          if (context) {
            setActiveSpaceId(context.activeSpaceId);
            setActiveSpaceGroupId(null);
          }
        }
        setSelectedFolderId(folderId);
        refresh();
      },
      toggleSpaceGroupCollapse: toggleSpaceGroup,
      toggleFolderCollapse: async (folder) => {
        const response = await performCommand({
          service: "folders",
          type: "setCollapsed",
          payload: { id: folder.id, value: !folder.isCollapsed },
          failureMessage: "Could not update tab group.",
        });
        if (!response) return;
        setFolders((current) =>
          current.map((entry) =>
            entry.id === folder.id
              ? { ...entry, isCollapsed: !folder.isCollapsed }
              : entry,
          ),
        );
      },
      pinFolder: async (folder, value) => {
        const response = await performCommand({
          service: "folders",
          type: "setPinned",
          payload: { id: folder.id, value },
          failureMessage: "Could not update tab group pin.",
        });
        if (!response) return;
        setFolders((current) =>
          current.map((entry) =>
            entry.id === folder.id
              ? { ...entry, isPinned: value, updatedAt: Date.now() }
              : entry,
          ),
        );
      },
      reorderFolders: async (orderedIds, spaceId, parentId) => {
        await performCommand({
          service: "folders",
          type: "reorder",
          payload: { orderedIds, spaceId, parentId },
          failureMessage: "Could not reorder tab groups.",
        });
        refreshFolders();
      },
      moveFolderToParent: async (folderId, parentId) => {
        await performCommand({
          service: "folders",
          type: "moveToParent",
          payload: { folderId, parentId },
          failureMessage: "Could not move tab group.",
          successMessage: "Tab group moved.",
        });
        refreshFolders();
      },
      moveFolderToSpace: async (folderId, spaceId) => {
        await performCommand({
          service: "folders",
          type: "moveToSpace",
          payload: { folderId, targetSpaceId: spaceId },
          failureMessage: "Could not move tab group.",
          successMessage: "Tab group moved.",
        });
        refreshFolders();
      },
      moveFolderToSpaceGroup: async (folderId, spaceGroupId) => {
        const target = await performCommand({
          service: "spaceGroups",
          type: "resolveDropSpace",
          payload: { spaceGroupId },
          failureMessage: "Could not resolve space group.",
        });
        if (!target) return;
        const resolved = resolvedSpaceSchema.safeParse(target.payload);
        if (!resolved.success) {
          showErrorToast("Could not resolve space group.");
          return;
        }
        await performCommand({
          service: "folders",
          type: "moveToSpace",
          payload: { folderId, targetSpaceId: resolved.data.id },
          failureMessage: "Could not move tab group.",
          successMessage: "Tab group moved.",
        });
        refreshFolders();
      },
      renameFolder: async (id, name) => {
        const response = await performCommand({
          service: "folders",
          type: "rename",
          payload: { id, name },
          failureMessage: "Rename failed.",
        });
        if (!response) return;
        setFolders((current) =>
          current.map((entry) =>
            entry.id === id ? { ...entry, name, updatedAt: Date.now() } : entry,
          ),
        );
      },
      createFolder: async (name, spaceId, parentId) => {
        await performCommand({
          service: "folders",
          type: "create",
          payload: { name, spaceId, parentId },
          failureMessage: "Could not create tab group.",
          successMessage: "Tab group created.",
        });
        refreshFolders();
      },
      deleteFolder: async (id, alsoDeleteItems) => {
        await performCommand({
          service: "folders",
          type: "delete",
          payload: { id, alsoDeleteItems },
          failureMessage: "Could not delete tab group.",
          successMessage: "Tab group moved to Bin.",
        });
        refreshFolders();
      },
      getFolderItemCount: async (ids) => {
        try {
          const response = folderCountsResponseSchema.parse(
            await sendRuntimeMessage(
              {
                service: "folders",
                type: "countItemsInTree",
                target: "offscreen",
                payload: { ids },
              },
              QUERY_REQUEST_TIMEOUT_MS,
            ),
          );
          return response.payload ?? {};
        } catch {
          return {};
        }
      },
      renameSpace: async (id, name) => {
        await performCommand({
          service: "spaces",
          type: "renameSpace",
          payload: { id, name },
          failureMessage: "Could not rename space.",
          successMessage: "Space renamed.",
        });
        void loadSpaces();
      },
      moveSpaceToGroup: async (id, groupId) => {
        await performCommand({
          service: "spaces",
          type: "moveToSpaceGroup",
          payload: { spaceId: id, spaceGroupId: groupId },
          failureMessage: "Could not move space.",
          successMessage: "Space moved.",
        });
        void loadSpaces();
      },
      lockSpace: (space) => {
        if (space.id === PRIVATE_SPACE_ID) {
          void lockPrivateSpace("Private space locked.");
        }
      },
      reorderSpaces: async (orderedIds, groupId) => {
        await performCommand({
          service: "spaces",
          type: "reorderSpaces",
          payload: { orderedIds, spaceGroupId: groupId },
          failureMessage: "Could not reorder spaces.",
        });
        void loadSpaces();
      },
      moveSpaceToBin: async (id) => {
        const response = await performCommand({
          service: "spaces",
          type: "moveToBin",
          payload: { id },
          failureMessage: "Could not move space to bin.",
          successMessage:
            "Space moved to bin. Restore from Bin within 30 days.",
        });
        if (response && activeSpaceId === id) {
          setActiveSpaceId(PUBLIC_SPACE_ID);
          setActiveSpaceGroupId(null);
        }
        void loadSpaces();
        void loadBinContents();
      },
      restoreSpaceFromBin: async (id) => {
        const response = await performCommand({
          service: "spaces",
          type: "restoreFromBin",
          payload: { id },
          failureMessage: "Could not restore space.",
        });
        if (response) showRestoreToast(response.payload, "Space restored.");
        void loadSpaces();
        void loadBinContents();
      },
      deleteSpaceForever: async (id, expectedDeletedAt) => {
        await performCommand({
          service: "spaces",
          type: "deleteSpaceForever",
          payload: { id, expectedDeletedAt },
          failureMessage: "Could not delete space.",
          successMessage: "Space permanently deleted.",
        });
        void loadSpaces();
        void loadBinContents();
      },
      restoreFolderFromBin: async (id) => {
        const response = await performCommand({
          service: "folders",
          type: "restoreFromBin",
          payload: { id },
          failureMessage: "Could not restore folder.",
        });
        if (response) showRestoreToast(response.payload, "Folder restored.");
        refreshFolders();
        void loadBinContents();
        scheduleQueryRefresh("high");
      },
      deleteFolderForever: async (id, expectedDeletedAt) => {
        await performCommand({
          service: "folders",
          type: "deleteForever",
          payload: { id, expectedDeletedAt },
          failureMessage: "Could not delete folder.",
          successMessage: "Folder permanently deleted.",
        });
        refreshFolders();
        void loadBinContents();
        scheduleQueryRefresh("high");
      },
      restoreItemFromBin: async (id) => {
        const response = await performCommand({
          service: "items",
          type: "restoreFromBin",
          payload: { id },
          failureMessage: "Could not restore saved tab.",
        });
        if (response) {
          showRestoreToast(response.payload, "Saved tab restored.");
        }
        void loadBinContents();
        scheduleQueryRefresh("high");
      },
      deleteItemForever: async (id, expectedDeletedAt) => {
        await performCommand({
          service: "items",
          type: "deleteForever",
          payload: { id, expectedDeletedAt },
          failureMessage: "Could not delete saved tab.",
          successMessage: "Saved tab permanently deleted.",
        });
        void loadBinContents();
        scheduleQueryRefresh("high");
      },
      reorderSpaceGroups: async (orderedIds) => {
        await performCommand({
          service: "spaceGroups",
          type: "reorderSpaceGroups",
          payload: { orderedIds },
          failureMessage: "Could not reorder space groups.",
        });
        void loadSpaceGroups();
      },
      renameSpaceGroup: async (id, name) => {
        await performCommand({
          service: "spaceGroups",
          type: "renameSpaceGroup",
          payload: { id, name },
          failureMessage: "Could not rename space group.",
          successMessage: "Space group renamed.",
        });
        void loadSpaceGroups();
      },
      deleteSpaceGroup: async (id, mode) => {
        await performCommand({
          service: "spaceGroups",
          type: "deleteSpaceGroup",
          payload: { id, mode },
          failureMessage: "Could not delete space group.",
          successMessage:
            mode === "deleteContents"
              ? "Space group moved to bin. Restore spaces from Bin within 30 days."
              : "Space group deleted. Spaces moved to Ungrouped.",
        });
        void loadSpaceGroups();
        void loadSpaces();
        void loadBinContents();
      },
      newSpace: openCreateSpace,
      newSpaceGroup: openCreateSpaceGroup,
      importBrowserBookmarks: openBrowserBookmarksImport,
      importGitHubStars: () => void openGitHubStarsImport(),
      importSharedLink: openSharedImport,
      openChangeSpacePassword: (space) => {
        if (space.id === PRIVATE_SPACE_ID) openPasswordChange();
      },
      unlockSpace: (space) => {
        if (space.isPrivate && !space.access.isUnlocked) {
          openPrivateAccess(space.access.requiresPassword ? "setup" : "unlock");
        }
      },
      shareFolder: (folder) => openShare(shareSelection("folder", folder.id)),
      shareSpace: (space) => openShare(shareSelection("space", space.id)),
      shareSpaceGroup: (group) =>
        openShare(shareSelection("spaceGroup", group.id)),
    }),
    [
      activeSpaceId,
      folders,
      loadBinContents,
      loadSpaceGroups,
      loadSpaces,
      lockPrivateSpace,
      openBrowserBookmarksImport,
      openCreateSpace,
      openCreateSpaceGroup,
      openGitHubStarsImport,
      openPasswordChange,
      openPrivateAccess,
      openShare,
      openSharedImport,
      pendingUrlFolderId,
      refresh,
      refreshFolders,
      scheduleQueryRefresh,
      selectSpace,
      selectSpaceGroup,
      setActiveSpaceGroupId,
      setActiveSpaceId,
      setFolders,
      setSelectedFolderId,
      spaces,
      toggleSpaceGroup,
    ],
  );

  return { handlers, refreshFolders };
}

function showRestoreToast(
  payload: JsonValue | undefined,
  fallback: string,
): void {
  const parsed = restoreResultSchema.safeParse(payload);
  const result = parsed.success ? parsed.data : {};
  showSuccessToast(result.message ?? fallback, {
    tempo: result.relocated ? "long" : "default",
  });
}
