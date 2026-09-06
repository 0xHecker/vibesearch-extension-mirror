import type { SpaceGroupDocType } from "@src/schemas/space_group_schema";
import type { SpaceListItem } from "@src/services/spaces/types";
import {
  showErrorToast,
  showLoadingToast,
  showSuccessToast,
} from "@src/utils/toast-feedback";
import {
  useCallback,
  useRef,
  useState,
  type Dispatch,
  type SetStateAction,
} from "react";
import { parseSpace, parseSpaceGroup } from "../library/contracts";

type SpaceCreationOptions = {
  activeSpaceGroupId: string | null;
  loadSpaces: () => Promise<SpaceListItem[]>;
  loadSpaceGroups: () => Promise<SpaceGroupDocType[]>;
  setActiveSpaceId: Dispatch<SetStateAction<string>>;
  setActiveSpaceGroupId: Dispatch<SetStateAction<string | null>>;
  setSelectedFolderId: Dispatch<SetStateAction<string>>;
  refresh: () => void;
};

/** Owns creation forms and the group destination selected by the sidebar. */
export function useSpaceCreationDialogs({
  activeSpaceGroupId,
  loadSpaces,
  loadSpaceGroups,
  setActiveSpaceId,
  setActiveSpaceGroupId,
  setSelectedFolderId,
  refresh,
}: SpaceCreationOptions) {
  const [createSpaceDialogOpen, setCreateSpaceDialogOpen] = useState(false);
  const [createSpaceName, setCreateSpaceName] = useState("");
  const [createSpaceError, setCreateSpaceError] = useState<string | null>(null);
  const [createSpaceLoading, setCreateSpaceLoading] = useState(false);
  const [createSpaceGroupDialogOpen, setCreateSpaceGroupDialogOpen] =
    useState(false);
  const [createSpaceGroupName, setCreateSpaceGroupName] = useState("");
  const [createSpaceGroupError, setCreateSpaceGroupError] = useState<
    string | null
  >(null);
  const [createSpaceGroupLoading, setCreateSpaceGroupLoading] = useState(false);
  const targetGroupId = useRef<string | null | undefined>(undefined);

  const resetCreateSpace = useCallback((): void => {
    setCreateSpaceError(null);
    setCreateSpaceName("");
    targetGroupId.current = undefined;
  }, []);

  const resetCreateSpaceGroup = useCallback((): void => {
    setCreateSpaceGroupError(null);
    setCreateSpaceGroupName("");
  }, []);

  const openCreateSpace = useCallback(
    (spaceGroupId?: string | null): void => {
      resetCreateSpace();
      targetGroupId.current = spaceGroupId ?? null;
      setCreateSpaceDialogOpen(true);
    },
    [resetCreateSpace],
  );

  const openCreateSpaceGroup = useCallback((): void => {
    resetCreateSpaceGroup();
    setCreateSpaceGroupDialogOpen(true);
  }, [resetCreateSpaceGroup]);

  const submitCreateSpace = useCallback(async (): Promise<void> => {
    const name = createSpaceName.trim();
    if (!name) {
      setCreateSpaceError("Space name is required.");
      return;
    }

    setCreateSpaceError(null);
    setCreateSpaceLoading(true);
    const toastId = showLoadingToast("Creating space...");
    try {
      const destinationGroupId =
        targetGroupId.current === undefined
          ? activeSpaceGroupId
          : targetGroupId.current;
      targetGroupId.current = undefined;
      const response = await chrome.runtime.sendMessage({
        service: "spaces",
        type: "createSpace",
        target: "offscreen",
        payload: { name, spaceGroupId: destinationGroupId || undefined },
      });
      if (!response?.success) {
        throw new Error(response?.error || "Failed to create space.");
      }
      const created = parseSpace(response.payload);
      await loadSpaces();
      setActiveSpaceId(created.id);
      setActiveSpaceGroupId(null);
      setSelectedFolderId("all");
      setCreateSpaceName("");
      setCreateSpaceDialogOpen(false);
      showSuccessToast(`Space "${created.name}" created.`, { id: toastId });
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Failed to create space.";
      setCreateSpaceError(message);
      showErrorToast(message, { id: toastId });
    } finally {
      setCreateSpaceLoading(false);
    }
  }, [
    activeSpaceGroupId,
    createSpaceName,
    loadSpaces,
    setActiveSpaceGroupId,
    setActiveSpaceId,
    setSelectedFolderId,
  ]);

  const submitCreateSpaceGroup = useCallback(async (): Promise<void> => {
    const name = createSpaceGroupName.trim();
    if (!name) {
      setCreateSpaceGroupError("Space group name is required.");
      return;
    }
    setCreateSpaceGroupError(null);
    setCreateSpaceGroupLoading(true);
    const toastId = showLoadingToast("Creating space group...");
    try {
      const response = await chrome.runtime.sendMessage({
        service: "spaceGroups",
        type: "createSpaceGroup",
        target: "offscreen",
        payload: { name },
      });
      if (!response?.success) {
        throw new Error(response?.error || "Failed to create space group.");
      }
      const created = parseSpaceGroup(response.payload);
      await loadSpaceGroups();
      setActiveSpaceGroupId(created.id);
      refresh();
      setCreateSpaceGroupName("");
      setCreateSpaceGroupDialogOpen(false);
      showSuccessToast(`Space group "${created.name}" created.`, {
        id: toastId,
      });
    } catch (error) {
      const message =
        error instanceof Error
          ? error.message
          : "Failed to create space group.";
      setCreateSpaceGroupError(message);
      showErrorToast(message, { id: toastId });
    } finally {
      setCreateSpaceGroupLoading(false);
    }
  }, [createSpaceGroupName, loadSpaceGroups, refresh, setActiveSpaceGroupId]);

  return {
    createSpaceDialogOpen,
    setCreateSpaceDialogOpen,
    createSpaceName,
    setCreateSpaceName,
    createSpaceError,
    createSpaceLoading,
    resetCreateSpace,
    openCreateSpace,
    submitCreateSpace,
    createSpaceGroupDialogOpen,
    setCreateSpaceGroupDialogOpen,
    createSpaceGroupName,
    setCreateSpaceGroupName,
    createSpaceGroupError,
    createSpaceGroupLoading,
    resetCreateSpaceGroup,
    openCreateSpaceGroup,
    submitCreateSpaceGroup,
  };
}
