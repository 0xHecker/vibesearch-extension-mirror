import * as React from "react";
import { cn } from "@src/lib/utils";
import { useDraggable, useDroppable, type DragEndEvent } from "@dnd-kit/core";
import { useOrganizeDnd, useSpringExpand } from "@src/components/dnd/OrganizeDndProvider";
import {
  Archive,
  ArchiveRestore,
  Bookmark,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  Download,
  FolderInput,
  GitFork,
  MoreHorizontal,
  Plus,
  Shield,
  Globe2,
  Lock,
  Trash2,
} from "lucide-react";
import { Button } from "@src/components/ui/button";
import { Input } from "@src/components/ui/input";
import { Tabs } from "@src/components/icons/tabs";
import SidePanel from "@src/components/ui/SidePanel";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@src/components/ui/dropdown-menu";
import { ConfirmDialog } from "@src/components/ui/confirm-dialog";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@src/components/ui/dialog";
import type { FolderDocType } from "@src/schemas/folder_schema";
import type { SpaceGroupDocType } from "@src/schemas/space_group_schema";
import type { BinEntry } from "@src/common/bin";
import { PUBLIC_SPACE_ID, PRIVATE_SPACE_ID } from "@src/common/spaces";
import {
  type SidebarSpace,
  buildFolderChildren,
  NESTED_FOLDER_INDENT_PX,
  sortSidebarFolders,
  sortSidebarSpaceGroups,
  sortSidebarSpaces,
} from "./sidebar-sort";
import { BinView } from "./BinView";

export type { SidebarSpace } from "./sidebar-sort";
import {
  SpaceContextMenu,
  SpaceGroupContextMenu,
  TabGroupContextMenu,
  type SpaceGroupMenuHandlers,
  type SpaceMenuHandlers,
  type TabGroupMenuHandlers,
} from "./SidebarContextMenu";

type SpaceMoveTarget = { id: string; name: string; isPrivate: boolean };

type PendingFolderDrop =
  | { kind: "reorder"; orderedIds: string[]; spaceId: string; parentId: string | null }
  | { kind: "nest"; folderId: string; parentId: string | null }
  | { kind: "moveToSpace"; folderId: string; targetSpaceId: string }
  | { kind: "moveToSpaceGroup"; folderId: string; spaceGroupId: string };

type PendingSpaceDrop =
  | { kind: "reorder"; orderedIds: string[]; spaceGroupId: string | null }
  | { kind: "moveToGroup"; spaceId: string; targetGroupId: string | null };

type PendingSpaceGroupDrop = { kind: "reorder"; orderedIds: string[] };

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
  reorderFolders: (orderedIds: string[], spaceId: string, parentId: string | null) => Promise<void>;
  moveFolderToParent: (folderId: string, parentId: string | null) => Promise<void>;
  moveFolderToSpace: (folderId: string, spaceId: string) => Promise<void>;
  moveFolderToSpaceGroup: (folderId: string, spaceGroupId: string) => Promise<void>;
  renameFolder: (id: string, name: string) => Promise<void>;
  createFolder: (name: string, spaceId: string, parentId: string | null) => Promise<void>;
  deleteFolder: (id: string, alsoDeleteItems: boolean) => Promise<void>;
  getFolderItemCount: (ids: string[]) => Promise<Record<string, number>>;
  renameSpace: (id: string, name: string) => Promise<void>;
  moveSpaceToGroup: (id: string, groupId: string | null) => Promise<void>;
  lockSpace: (space: SidebarSpace) => void;
  reorderSpaces: (orderedIds: string[], groupId: string | null) => Promise<void>;
  moveSpaceToBin: (id: string) => Promise<void>;
  restoreSpaceFromBin: (id: string) => Promise<void>;
  deleteSpaceForever: (id: string, expectedDeletedAt: number) => Promise<void>;
  restoreFolderFromBin: (id: string) => Promise<void>;
  deleteFolderForever: (id: string, expectedDeletedAt: number) => Promise<void>;
  restoreItemFromBin: (id: string) => Promise<void>;
  deleteItemForever: (id: string, expectedDeletedAt: number) => Promise<void>;
  reorderSpaceGroups: (orderedIds: string[]) => Promise<void>;
  renameSpaceGroup: (id: string, name: string) => Promise<void>;
  deleteSpaceGroup: (id: string, mode: "moveToUngrouped" | "deleteContents") => Promise<void>;
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

type DeleteFolderState = {
  folder: FolderDocType;
  itemCount: number | null;
  alsoDeleteItems: boolean;
};

type SidebarDndData = {
  surface: "sidebar";
  kind: "folder" | "space" | "spaceGroup" | "root" | "ungrouped";
  id?: string;
  name?: string;
  spaceId?: string;
  parentId?: string | null;
  spaceGroupId?: string | null;
  collapsed?: boolean;
  springId?: string;
};

// Derive the drop intent from where the dragged node's center sits over the
// target row: top/bottom edges = reorder before/after, middle = "onto"
// (nest / move-into / join).
const computeSidebarZone = (event: DragEndEvent): "before" | "after" | "onto" => {
  const overRect = event.over?.rect;
  if (!overRect || !overRect.height) return "onto";
  // Resolve the zone from the *pointer* position (consistent with the
  // pointerWithin collision strategy) rather than the dragged row's rect. The
  // dragged rect is offset by wherever the user grabbed the row, which pushed
  // the result into the before/after (reorder) bands and made the middle
  // "onto" (merge) band almost impossible to hit.
  const activator = event.activatorEvent as { clientY?: number } | null;
  const pointerY =
    activator && typeof activator.clientY === "number"
      ? activator.clientY + event.delta.y
      : (() => {
          const activeRect = event.active.rect.current.translated;
          return activeRect
            ? activeRect.top + activeRect.height / 2
            : overRect.top + overRect.height / 2;
        })();
  const rel = (pointerY - overRect.top) / overRect.height;
  if (rel < 0.25) return "before";
  if (rel > 0.75) return "after";
  return "onto";
};

type SidebarDndRender = {
  setNodeRef: (node: HTMLElement | null) => void;
  listeners: ReturnType<typeof useDraggable>["listeners"];
  attributes: ReturnType<typeof useDraggable>["attributes"];
  isOver: boolean;
  isDragging: boolean;
};

// A sidebar node that is both draggable and a drop target. Uses
// useDraggable + useDroppable (not useSortable) so only the hovered row
// re-renders, and exposes the wiring via a render prop so the existing row
// markup stays intact.
function SidebarDnd({
  id,
  data,
  disabled,
  children,
}: {
  id: string;
  data: SidebarDndData;
  disabled?: boolean;
  children: (props: SidebarDndRender) => React.ReactNode;
}) {
  const draggable = useDraggable({ id, data, disabled });
  const droppable = useDroppable({ id, data });
  const setNodeRef = (node: HTMLElement | null) => {
    draggable.setNodeRef(node);
    droppable.setNodeRef(node);
  };
  return (
    <>
      {children({
        setNodeRef,
        listeners: draggable.listeners,
        attributes: draggable.attributes,
        isOver: droppable.isOver,
        isDragging: draggable.isDragging,
      })}
    </>
  );
}

// Droppable-only region (the ungrouped-spaces area and the tab-groups root).
function SidebarDropZone({
  id,
  data,
  children,
}: {
  id: string;
  data: SidebarDndData;
  children: (props: { setNodeRef: (node: HTMLElement | null) => void; isOver: boolean }) => React.ReactNode;
}) {
  const { setNodeRef, isOver } = useDroppable({ id, data });
  return <>{children({ setNodeRef, isOver })}</>;
}

export const Sidebar = React.memo(function Sidebar({
  spaces,
  spaceGroups,
  folders,
  activeSpaceId,
  activeSpaceGroupId,
  selectedFolderId,
  binEntries,
  binTotal,
  binHasMore,
  binPage,
  binPageLoading,
  onNextBinPage,
  onPreviousBinPage,
  onOpenBin,
  now,
  handlers,
  openBinNonce,
}: SidebarProps) {
  const [rename, setRename] = React.useState<InlineRenameState | null>(null);
  const [collapseBusyId, setCollapseBusyId] = React.useState<string | null>(null);
  const [deleteFolderState, setDeleteFolderState] = React.useState<DeleteFolderState | null>(null);
  const [deleteSpaceState, setDeleteSpaceState] = React.useState<{ space: SidebarSpace } | null>(null);
  const [deleteSpaceGroupState, setDeleteSpaceGroupState] = React.useState<
    { group: SpaceGroupDocType; mode: "moveToUngrouped" | "deleteContents" } | null
  >(null);
  const [deleteBinEntryState, setDeleteBinEntryState] = React.useState<{ entry: BinEntry } | null>(null);
  const [binViewOpen, setBinViewOpen] = React.useState(false);

  // Allow the page (Settings → Open bin) to open the Bin view.
  React.useEffect(() => {
    if (!openBinNonce || openBinNonce <= 0) return;
    setBinViewOpen(true);
    onOpenBin();
  }, [onOpenBin, openBinNonce]);
  const [newTabGroupTarget, setNewTabGroupTarget] = React.useState<
    { spaceId: string; parentId: string | null; name: string } | null
  >(null);
  const [busy, setBusy] = React.useState(false);

  // Drop logic registers into the single page-level OrganizeDnd context.
  const { registerResolver, requestConfirmation } = useOrganizeDnd();
  const { isSpringOpen } = useSpringExpand();

  const sortedSpaces = React.useMemo(() => sortSidebarSpaces(spaces), [spaces]);
  const sortedSpaceGroups = React.useMemo(() => sortSidebarSpaceGroups(spaceGroups), [spaceGroups]);
  const ungroupedSpaces = React.useMemo(
    () => sortedSpaces.filter((s) => !s.spaceGroupId),
    [sortedSpaces]
  );
  const spacesByGroupId = React.useMemo(() => {
    const map = new Map<string, SidebarSpace[]>();
    for (const space of sortedSpaces) {
      if (!space.spaceGroupId) continue;
      const list = map.get(space.spaceGroupId) || [];
      list.push(space);
      map.set(space.spaceGroupId, list);
    }
    return map;
  }, [sortedSpaces]);

  // Folders within the active scope only. Anything outside the visible scope
  // never enters the tree render — keeps large libraries cheap.
  const scopedFolderIds = React.useMemo(() => {
    const allowedSpaceIds = activeSpaceGroupId
      ? new Set((spacesByGroupId.get(activeSpaceGroupId) || []).map((s) => s.id))
      : new Set([activeSpaceId]);
    return allowedSpaceIds;
  }, [activeSpaceGroupId, activeSpaceId, spacesByGroupId]);

  const scopedFolders = React.useMemo(
    () => sortSidebarFolders(folders.filter((f) => scopedFolderIds.has(f.spaceId))),
    [folders, scopedFolderIds]
  );

  const folderChildren = React.useMemo(
    () => buildFolderChildren(scopedFolders),
    [scopedFolders]
  );

  const spaceMoveTargets: SpaceMoveTarget[] = React.useMemo(
    () =>
      sortedSpaces
        .filter((s) => !s.isPrivate || s.access.isUnlocked)
        .map((s) => ({ id: s.id, name: s.name, isPrivate: s.isPrivate })),
    [sortedSpaces]
  );

  const groupTargets = React.useMemo(
    () => sortedSpaceGroups.map((g) => ({ id: g.id, name: g.name })),
    [sortedSpaceGroups]
  );

  /* ---------- Drag & drop (dnd-kit) ---------- */

  const moveItemsToFolder = (itemIds: string[], targetFolderId: string) => {
    void chrome.runtime
      .sendMessage({ service: "items", type: "moveToFolder", target: "offscreen", payload: { itemIds, targetFolderId } })
      .catch((e) => console.error("[Sidebar] move tabs to folder failed", e));
  };
  const mergeFolders = (sourceFolderId: string, targetFolderId: string) => {
    void chrome.runtime
      .sendMessage({ service: "folders", type: "mergeInto", target: "offscreen", payload: { sourceFolderId, targetFolderId } })
      .catch((e) => console.error("[Sidebar] merge tab groups failed", e));
  };
  const moveItemsToSpace = (itemIds: string[], targetSpaceId: string) => {
    void chrome.runtime
      .sendMessage({ service: "items", type: "moveToSpace", target: "offscreen", payload: { itemIds, targetSpaceId } })
      .catch((e) => console.error("[Sidebar] move tabs to space failed", e));
  };
  // Run immediately for low-impact drops; confirm first for high-impact ones
  // (more than 20 tabs, or a cross-space move).
  const confirmMaybe = (needsConfirm: boolean, title: string, description: string, run: () => void) => {
    if (!needsConfirm) {
      run();
      return;
    }
    requestConfirmation({ title, description, confirmLabel: "Move", variant: "warning", onConfirm: run });
  };

  // One resolver for the whole sidebar. Rows are draggable + droppable
  // (SidebarDnd); the drop position within a row is derived from the pointer
  // rect at drop time (before/after = reorder, onto = nest/move/join).
  const resolveSidebarDrop = (event: DragEndEvent): boolean => {
    const { active, over } = event;
    if (!over) return false;
    const a = active.data.current as SidebarDndData | undefined;
    const o = over.data.current as SidebarDndData | undefined;
    if (!a || !o || o.surface !== "sidebar") return false;

    // ---- Cross-surface: a main-area tab / tab-group dropped onto a sidebar target ----
    if (a.surface !== "sidebar") {
      const drag = active.data.current as any;
      if (drag?.type === "item") {
        const itemIds: string[] =
          Array.isArray(drag.selectedIds) && drag.selectedIds.length > 0
            ? drag.selectedIds
            : drag.item?.id
              ? [drag.item.id]
              : [];
        if (itemIds.length === 0) return true;
        const count = itemIds.length;
        const what = count === 1 ? "this tab" : `${count} tabs`;
        const sourceSpaceId: string | undefined = drag.item?.spaceId;
        if (o.kind === "folder" && o.id) {
          const targetFolderId = o.id;
          const crossSpace = !!o.spaceId && !!sourceSpaceId && o.spaceId !== sourceSpaceId;
          confirmMaybe(
            count > 20 || crossSpace,
            count === 1 ? "Move this tab?" : `Move ${count} tabs?`,
            `Move ${what} into this tab group${crossSpace ? " in another space" : ""}.`,
            () => moveItemsToFolder(itemIds, targetFolderId)
          );
          return true;
        }
        if (o.kind === "space" && o.id) {
          const targetSpaceId = o.id;
          const crossSpace = !!sourceSpaceId && targetSpaceId !== sourceSpaceId;
          confirmMaybe(
            count > 20 || crossSpace,
            count === 1 ? "Move this tab?" : `Move ${count} tabs?`,
            `Move ${what} to this space.`,
            () => moveItemsToSpace(itemIds, targetSpaceId)
          );
          return true;
        }
        // Dropping a tab on a space group / root / ungrouped zone is not supported.
        return true;
      }
      if (drag?.type === "folder") {
        const folder = drag.folder;
        const folderId: string | undefined = folder?.id;
        if (!folderId) return true;
        const folderName: string = folder?.name ?? "tab group";
        if (o.kind === "space" && o.id) {
          const targetSpaceId = o.id;
          const crossSpace = !!folder?.spaceId && targetSpaceId !== folder.spaceId;
          confirmMaybe(
            crossSpace,
            `Move "${folderName}"?`,
            `Move the tab group "${folderName}" to this space.`,
            () => void handlers.moveFolderToSpace(folderId, targetSpaceId)
          );
          return true;
        }
        if (o.kind === "spaceGroup" && o.id) {
          const targetGroupId = o.id;
          confirmMaybe(
            true,
            `Move "${folderName}"?`,
            `Move the tab group "${folderName}" into this space group.`,
            () => void handlers.moveFolderToSpaceGroup(folderId, targetGroupId)
          );
          return true;
        }
        if (o.kind === "folder" && o.id && o.id !== folderId) {
          const targetFolderId = o.id;
          confirmMaybe(
            true,
            `Merge "${folderName}" into "${o.name ?? "the target"}"?`,
            `All tabs from "${folderName}" move into "${o.name ?? "the target group"}". "${folderName}" is then removed.`,
            () => mergeFolders(folderId, targetFolderId)
          );
          return true;
        }
        return true;
      }
      return false;
    }

    const zone = computeSidebarZone(event);

    // ---- Folder (tab group) dragged ----
    if (a.kind === "folder" && a.id) {
      const folderId = a.id;
      const folderParentId = a.parentId ?? null;
      const folderSpaceId = a.spaceId;
      if (o.kind === "folder" && o.id) {
        const targetFolderId = o.id;
        if (targetFolderId === folderId) return true;
        if (zone === "onto") {
          // Drop a tab group ONTO another tab group = MERGE (see docs/drag-and-drop.md).
          confirmMaybe(
            true,
            `Merge "${a.name ?? "this tab group"}" into "${o.name ?? "the target"}"?`,
            `All tabs from "${a.name ?? "the dragged group"}" move into "${o.name ?? "the target group"}". The dragged group is then removed.`,
            () => mergeFolders(folderId, targetFolderId)
          );
          return true;
        }
        // Drop on the top/bottom edge = REORDER among siblings.
        const targetParentId = o.parentId ?? null;
        const siblings = folderChildren.get(targetParentId) || [];
        const baseIds = siblings.map((f) => f.id);
        const workingIds =
          folderParentId === targetParentId ? baseIds.filter((id) => id !== folderId) : baseIds.slice();
        const targetIndex = workingIds.indexOf(targetFolderId);
        if (targetIndex === -1) return true;
        const insertAt = zone === "before" ? targetIndex : targetIndex + 1;
        workingIds.splice(insertAt, 0, folderId);
        const targetSpaceId = o.spaceId ?? folderSpaceId;
        if (!targetSpaceId) return true;
        if (folderParentId !== targetParentId) {
          void (async () => {
            await handlers.moveFolderToParent(folderId, targetParentId);
            await handlers.reorderFolders(workingIds, targetSpaceId, targetParentId);
          })();
        } else {
          void handlers.reorderFolders(workingIds, targetSpaceId, targetParentId);
        }
        return true;
      }
      if (o.kind === "space" && o.id) {
        void handlers.moveFolderToSpace(folderId, o.id);
        return true;
      }
      if (o.kind === "spaceGroup" && o.id) {
        void handlers.moveFolderToSpaceGroup(folderId, o.id);
        return true;
      }
      if (o.kind === "root") {
        const activeSpace = activeSpaceGroupId
          ? (spacesByGroupId.get(activeSpaceGroupId) || [])[0]
          : sortedSpaces.find((s) => s.id === activeSpaceId);
        const targetSpaceId = activeSpace?.id;
        if (targetSpaceId) {
          void (async () => {
            if (folderSpaceId !== targetSpaceId) await handlers.moveFolderToSpace(folderId, targetSpaceId);
            if (folderParentId !== null) await handlers.moveFolderToParent(folderId, null);
          })();
        }
        return true;
      }
      return false;
    }

    // ---- Space dragged ----
    if (a.kind === "space" && a.id) {
      const spaceId = a.id;
      const spaceGroupId = a.spaceGroupId ?? null;
      if (o.kind === "space" && o.id) {
        if (o.id === spaceId) return true;
        const targetGroup = o.spaceGroupId ?? null;
        const siblings = (targetGroup ? spacesByGroupId.get(targetGroup) : ungroupedSpaces) || [];
        const orderedIds = siblings.filter((s) => s.id !== spaceId).map((s) => s.id);
        const targetIndex = orderedIds.indexOf(o.id);
        if (targetIndex === -1) return true;
        const insertAt = zone === "before" ? targetIndex : targetIndex + 1;
        orderedIds.splice(insertAt, 0, spaceId);
        void (async () => {
          if (spaceGroupId !== targetGroup) await handlers.moveSpaceToGroup(spaceId, targetGroup);
          await handlers.reorderSpaces(orderedIds, targetGroup);
        })();
        return true;
      }
      if (o.kind === "spaceGroup" && o.id) {
        if (spaceGroupId !== o.id) void handlers.moveSpaceToGroup(spaceId, o.id);
        return true;
      }
      if (o.kind === "ungrouped") {
        if (spaceGroupId !== null) void handlers.moveSpaceToGroup(spaceId, null);
        return true;
      }
      return false;
    }

    // ---- Space group dragged ----
    if (a.kind === "spaceGroup" && a.id) {
      const groupId = a.id;
      if (o.kind === "spaceGroup" && o.id) {
        if (o.id === groupId) return true;
        const orderedIds = sortedSpaceGroups.filter((g) => g.id !== groupId).map((g) => g.id);
        const targetIndex = orderedIds.indexOf(o.id);
        if (targetIndex === -1) return true;
        const insertAt = zone === "before" ? targetIndex : targetIndex + 1;
        orderedIds.splice(insertAt, 0, groupId);
        void handlers.reorderSpaceGroups(orderedIds);
        return true;
      }
      return false;
    }

    return false;
  };

  const resolveSidebarDropRef = React.useRef(resolveSidebarDrop);
  resolveSidebarDropRef.current = resolveSidebarDrop;
  React.useEffect(
    () => registerResolver((event) => resolveSidebarDropRef.current(event)),
    [registerResolver]
  );

  /* ---------- Inline rename ---------- */

  const beginRename = React.useCallback(
    (kind: InlineRenameState["kind"], id: string, currentValue: string) => {
      setRename({ kind, id, value: currentValue });
    },
    []
  );

  const commitRename = React.useCallback(async () => {
    if (!rename) return;
    const next = rename.value.trim().slice(0, 80);
    const currentRename = rename;
    setRename(null);
    if (!next) return;
    try {
      if (currentRename.kind === "folder") {
        await handlers.renameFolder(currentRename.id, next);
      } else if (currentRename.kind === "space") {
        await handlers.renameSpace(currentRename.id, next);
      } else if (currentRename.kind === "spaceGroup") {
        await handlers.renameSpaceGroup(currentRename.id, next);
      }
    } catch (renameError) {
      console.error("[Sidebar] rename failed", renameError);
    }
  }, [handlers, rename]);

  const cancelRename = React.useCallback(() => setRename(null), []);

  const handleRenameKeyDown = React.useCallback(
    (event: React.KeyboardEvent<HTMLInputElement>) => {
      if (event.key === "Enter") {
        event.preventDefault();
        void commitRename();
      } else if (event.key === "Escape") {
        event.preventDefault();
        cancelRename();
      }
    },
    [cancelRename, commitRename]
  );

  /* ---------- Action helpers ---------- */

  const handleSelectSpace = React.useCallback(
    (space: SidebarSpace) => {
      if (space.isPrivate && !space.access.isUnlocked) {
        handlers.unlockSpace(space);
        return;
      }
      handlers.selectSpace(space);
    },
    [handlers]
  );

  const ensureFolderCounts = React.useCallback(
    async (folders: FolderDocType[]): Promise<Record<string, number>> => {
      if (folders.length === 0) return {};
      try {
        return await handlers.getFolderItemCount(folders.map((f) => f.id));
      } catch {
        return {};
      }
    },
    [handlers]
  );

  const openDeleteFolder = React.useCallback(
    async (folder: FolderDocType) => {
      setDeleteFolderState({ folder, itemCount: null, alsoDeleteItems: true });
      const counts = await ensureFolderCounts([folder]);
      setDeleteFolderState((current) =>
        current && current.folder.id === folder.id
          ? { ...current, itemCount: counts[folder.id] ?? 0 }
          : current
      );
    },
    [ensureFolderCounts]
  );

  const confirmDeleteFolder = React.useCallback(async () => {
    if (!deleteFolderState) return;
    const { folder, alsoDeleteItems } = deleteFolderState;
    setDeleteFolderState(null);
    try {
      await handlers.deleteFolder(folder.id, alsoDeleteItems);
    } catch (deleteError) {
      console.error("[Sidebar] delete folder failed", deleteError);
    }
  }, [deleteFolderState, handlers]);

  const confirmDeleteSpace = React.useCallback(async () => {
    if (!deleteSpaceState) return;
    const { space } = deleteSpaceState;
    setDeleteSpaceState(null);
    try {
      await handlers.moveSpaceToBin(space.id);
    } catch (deleteError) {
      console.error("[Sidebar] move space to bin failed", deleteError);
    }
  }, [deleteSpaceState, handlers]);

  const confirmDeleteSpaceGroup = React.useCallback(async () => {
    if (!deleteSpaceGroupState) return;
    const { group, mode } = deleteSpaceGroupState;
    setDeleteSpaceGroupState(null);
    try {
      await handlers.deleteSpaceGroup(group.id, mode);
    } catch (deleteError) {
      console.error("[Sidebar] delete space group failed", deleteError);
    }
  }, [deleteSpaceGroupState, handlers]);

  const confirmDeleteBinEntry = React.useCallback(async () => {
    if (!deleteBinEntryState) return;
    const { entry } = deleteBinEntryState;
    setDeleteBinEntryState(null);
    try {
      if (entry.kind === "space") {
        await handlers.deleteSpaceForever(entry.id, entry.deletedAt);
      } else if (entry.kind === "folder") {
        await handlers.deleteFolderForever(entry.id, entry.deletedAt);
      } else {
        await handlers.deleteItemForever(entry.id, entry.deletedAt);
      }
    } catch (deleteError) {
      console.error("[Sidebar] purge bin entry failed", deleteError);
    }
  }, [deleteBinEntryState, handlers]);

  const restoreBinEntry = React.useCallback(
    async (entry: BinEntry) => {
      try {
        if (entry.kind === "space") {
          await handlers.restoreSpaceFromBin(entry.id);
        } else if (entry.kind === "folder") {
          await handlers.restoreFolderFromBin(entry.id);
        } else {
          await handlers.restoreItemFromBin(entry.id);
        }
      } catch (restoreError) {
        console.error("[Sidebar] restore bin entry failed", restoreError);
      }
    },
    [handlers]
  );

  const moveSpaceUp = React.useCallback(
    async (space: SidebarSpace) => {
      const siblings = (space.spaceGroupId ? spacesByGroupId.get(space.spaceGroupId) : ungroupedSpaces) || [];
      const index = siblings.findIndex((s) => s.id === space.id);
      if (index <= 0) return;
      const orderedIds = siblings.map((s) => s.id);
      [orderedIds[index - 1], orderedIds[index]] = [orderedIds[index], orderedIds[index - 1]];
      await handlers.reorderSpaces(orderedIds, space.spaceGroupId);
    },
    [handlers, spacesByGroupId, ungroupedSpaces]
  );

  const moveSpaceDown = React.useCallback(
    async (space: SidebarSpace) => {
      const siblings = (space.spaceGroupId ? spacesByGroupId.get(space.spaceGroupId) : ungroupedSpaces) || [];
      const index = siblings.findIndex((s) => s.id === space.id);
      if (index === -1 || index >= siblings.length - 1) return;
      const orderedIds = siblings.map((s) => s.id);
      [orderedIds[index], orderedIds[index + 1]] = [orderedIds[index + 1], orderedIds[index]];
      await handlers.reorderSpaces(orderedIds, space.spaceGroupId);
    },
    [handlers, spacesByGroupId, ungroupedSpaces]
  );

  const moveSpaceGroupUp = React.useCallback(
    async (group: SpaceGroupDocType) => {
      const index = sortedSpaceGroups.findIndex((g) => g.id === group.id);
      if (index <= 0) return;
      const orderedIds = sortedSpaceGroups.map((g) => g.id);
      [orderedIds[index - 1], orderedIds[index]] = [orderedIds[index], orderedIds[index - 1]];
      await handlers.reorderSpaceGroups(orderedIds);
    },
    [handlers, sortedSpaceGroups]
  );

  const moveSpaceGroupDown = React.useCallback(
    async (group: SpaceGroupDocType) => {
      const index = sortedSpaceGroups.findIndex((g) => g.id === group.id);
      if (index === -1 || index >= sortedSpaceGroups.length - 1) return;
      const orderedIds = sortedSpaceGroups.map((g) => g.id);
      [orderedIds[index], orderedIds[index + 1]] = [orderedIds[index + 1], orderedIds[index]];
      await handlers.reorderSpaceGroups(orderedIds);
    },
    [handlers, sortedSpaceGroups]
  );

  const moveFolderUp = React.useCallback(
    async (folder: FolderDocType) => {
      const siblings = folderChildren.get(folder.parentId ?? null) || [];
      const index = siblings.findIndex((f) => f.id === folder.id);
      if (index <= 0) return;
      const orderedIds = siblings.map((f) => f.id);
      [orderedIds[index - 1], orderedIds[index]] = [orderedIds[index], orderedIds[index - 1]];
      await handlers.reorderFolders(orderedIds, folder.spaceId, folder.parentId ?? null);
    },
    [folderChildren, handlers]
  );

  const moveFolderDown = React.useCallback(
    async (folder: FolderDocType) => {
      const siblings = folderChildren.get(folder.parentId ?? null) || [];
      const index = siblings.findIndex((f) => f.id === folder.id);
      if (index === -1 || index >= siblings.length - 1) return;
      const orderedIds = siblings.map((f) => f.id);
      [orderedIds[index], orderedIds[index + 1]] = [orderedIds[index + 1], orderedIds[index]];
      await handlers.reorderFolders(orderedIds, folder.spaceId, folder.parentId ?? null);
    },
    [folderChildren, handlers]
  );

  const toggleFolderPin = React.useCallback(
    async (folder: FolderDocType) => {
      try {
        await handlers.pinFolder(folder, !folder.isPinned);
      } catch (pinError) {
        console.error("[Sidebar] toggle folder pin failed", pinError);
      }
    },
    [handlers]
  );

  const submitNewTabGroup = React.useCallback(async () => {
    if (!newTabGroupTarget) return;
    const name = newTabGroupTarget.name.trim();
    if (!name) return;
    setNewTabGroupTarget(null);
    try {
      await handlers.createFolder(name, newTabGroupTarget.spaceId, newTabGroupTarget.parentId);
    } catch (createError) {
      console.error("[Sidebar] create folder failed", createError);
    }
  }, [handlers, newTabGroupTarget]);

  const runWithBusy = React.useCallback(async (fn: () => Promise<void>) => {
    setBusy(true);
    try {
      await fn();
    } finally {
      setBusy(false);
    }
  }, []);

  /* ---------- Renderers ---------- */

  const renderFolderRow = React.useCallback(
    (folder: FolderDocType, depth: number): React.ReactNode => {
      const isActive = selectedFolderId === folder.id;
      const isRenaming = rename?.kind === "folder" && rename?.id === folder.id;
      const children = folderChildren.get(folder.id) || [];
      const hasChildren = children.length > 0;

      const tabGroupHandlers: TabGroupMenuHandlers = {
        onOpen: () => handlers.selectFolder(folder.id),
        onRename: () => beginRename("folder", folder.id, folder.name),
        onNewSubFolder: () =>
          setNewTabGroupTarget({ spaceId: folder.spaceId, parentId: folder.id, name: "" }),
        onTogglePin: () => void toggleFolderPin(folder),
        onToggleCollapse: () => handlers.toggleFolderCollapse(folder),
        onMoveToSpace: (spaceId) => void runWithBusy(() => handlers.moveFolderToSpace(folder.id, spaceId)),
        onCopyToSpace: (spaceId) => void runWithBusy(() => handlers.moveFolderToSpace(folder.id, spaceId)),
        onMoveUp: () => void moveFolderUp(folder),
        onMoveDown: () => void moveFolderDown(folder),
        onShare: () => handlers.shareFolder(folder),
        onDelete: () => void openDeleteFolder(folder),
      };

      const siblingIndex = (folderChildren.get(folder.parentId ?? null) || []).findIndex(
        (f) => f.id === folder.id
      );
      const siblingCount = (folderChildren.get(folder.parentId ?? null) || []).length;

      const row = (
        <SidebarDnd
          id={`sb-folder-${folder.id}`}
          data={{
            surface: "sidebar",
            kind: "folder",
            id: folder.id,
            name: folder.name,
            spaceId: folder.spaceId,
            parentId: folder.parentId ?? null,
            collapsed: folder.isCollapsed && hasChildren,
            springId: folder.id,
          }}
        >
          {(dnd) => (
            <TabGroupContextMenu
              folder={folder}
              hasChildren={hasChildren}
              canMoveUp={siblingIndex > 0}
              canMoveDown={siblingIndex >= 0 && siblingIndex < siblingCount - 1}
              canNest={depth < 5}
              spaceMoveTargets={spaceMoveTargets}
              handlers={tabGroupHandlers}
            >
            <div
              ref={dnd.setNodeRef}
              {...dnd.attributes}
              {...dnd.listeners}
              onDoubleClick={() => beginRename("folder", folder.id, folder.name)}
              onClick={() => handlers.selectFolder(folder.id)}
              role="treeitem"
              aria-current={isActive ? "page" : undefined}
              aria-expanded={hasChildren ? !folder.isCollapsed : undefined}
              aria-level={depth + 1}
              className={cn(
                "group/folder-row relative flex min-h-9 w-full items-center gap-2 rounded-xl px-2 py-1.5 text-left text-sm transition-[background-color,color,box-shadow] duration-150 ease-out cursor-pointer select-none",
                isActive
                  ? "bg-background-neutral text-foreground-neutral shadow-[0_0_0_1px_rgba(0,0,0,0.05),0_3px_8px_-3px_rgba(0,0,0,0.12)]"
                  : "text-foreground-secondary hover:bg-background-neutral/60",
                dnd.isDragging && "opacity-40",
                dnd.isOver && "outline-dashed outline-2 outline-offset-[-2px] outline-accent/50 bg-accent-faded/30"
              )}
              style={{ paddingLeft: 8 + depth * NESTED_FOLDER_INDENT_PX }}
            >
              {hasChildren ? (
                <button
                  type="button"
                  aria-label={folder.isCollapsed ? `Expand ${folder.name}` : `Collapse ${folder.name}`}
                  onClick={(e) => {
                    e.stopPropagation();
                    handlers.toggleFolderCollapse(folder);
                  }}
                  className="grid size-5 shrink-0 place-items-center rounded text-foreground-icon hover:text-foreground-neutral"
                >
                  {folder.isCollapsed ? <ChevronRight size={13} /> : <ChevronDown size={13} />}
                </button>
              ) : (
                <span className="w-5 shrink-0" />
              )}

              <Tabs fillColor={folder.isPinned ? "#E56B6B" : "#6B95E5"} size={16} />

              {isRenaming ? (
                <Input
                  autoFocus
                  value={rename?.value ?? ""}
                  onChange={(e) => setRename((current) => current ? { ...current, value: e.target.value } : null)}
                  onKeyDown={handleRenameKeyDown}
                  onBlur={commitRename}
                  onClick={(e) => e.stopPropagation()}
                  className="h-7 flex-1 bg-background-page-secondary text-sm"
                />
              ) : (
                <span className="min-w-0 flex-1 truncate font-semibold">{folder.name}</span>
              )}
            </div>
            </TabGroupContextMenu>
          )}
        </SidebarDnd>
      );

      const menu = row;

      return (
        <div key={folder.id} className="space-y-0.5">
          {menu}
          {(!folder.isCollapsed || isSpringOpen(folder.id)) && hasChildren && depth < 6 && (
            <div className="space-y-0.5">
              {children.map((child) => renderFolderRow(child, depth + 1))}
            </div>
          )}
        </div>
      );
    },
    [
      beginRename,
      commitRename,
      folderChildren,
      handleRenameKeyDown,
      handlers,
      isSpringOpen,
      moveFolderDown,
      moveFolderUp,
      openDeleteFolder,
      rename,
      runWithBusy,
      selectedFolderId,
      spaceMoveTargets,
      toggleFolderPin,
    ]
  );

  const renderSpaceRow = React.useCallback(
    (space: SidebarSpace, depth: number) => {
      const isActive = activeSpaceGroupId === null && activeSpaceId === space.id;
      const isLocked = space.isPrivate && !space.access.isUnlocked;
      const isRenaming = rename?.kind === "space" && rename?.id === space.id;
      const canRename = space.id !== PUBLIC_SPACE_ID && space.id !== PRIVATE_SPACE_ID;
      const canDelete = canRename;
      const canPin = false; // Pin-to-top for spaces is reserved for a future pass
      const canChangePassword =
        space.isPrivate && space.access.isUnlocked && space.id === PRIVATE_SPACE_ID;

      const spaceHandlers: SpaceMenuHandlers = {
        onOpen: () => handleSelectSpace(space),
        onNewTabGroupHere: () =>
          setNewTabGroupTarget({ spaceId: space.id, parentId: null, name: "" }),
        onRename: canRename ? () => beginRename("space", space.id, space.name) : () => {},
        onMoveToGroup: (groupId) => void runWithBusy(() => handlers.moveSpaceToGroup(space.id, groupId)),
        onPin: () => {},
        onLock: () => handlers.lockSpace(space),
        onUnlock: () => handlers.unlockSpace(space),
        onChangePassword: canChangePassword ? () => handlers.openChangeSpacePassword(space) : () => {},
        onMoveUp: () => void moveSpaceUp(space),
        onMoveDown: () => void moveSpaceDown(space),
        onShare: () => handlers.shareSpace(space),
        onMoveToBin: canDelete ? () => setDeleteSpaceState({ space }) : () => {},
      };

      const siblings = space.spaceGroupId ? spacesByGroupId.get(space.spaceGroupId) : ungroupedSpaces;
      const idx = (siblings || []).findIndex((s) => s.id === space.id);
      const canMoveUp = idx > 0;
      const canMoveDown = idx >= 0 && idx < (siblings?.length || 0) - 1;

      const row = (
        <SidebarDnd
          key={space.id}
          id={`sb-space-${space.id}`}
          data={{ surface: "sidebar", kind: "space", id: space.id, spaceGroupId: space.spaceGroupId ?? null }}
          disabled={!canDelete}
        >
          {(dnd) => (
            <SpaceContextMenu
              space={space}
              canMoveUp={canMoveUp}
              canMoveDown={canMoveDown}
              canPin={canPin}
              canRename={canRename}
              canDelete={canDelete}
              canChangePassword={canChangePassword}
              groupTargets={groupTargets}
              handlers={spaceHandlers}
            >
            <div
              ref={dnd.setNodeRef}
              {...dnd.attributes}
              {...dnd.listeners}
              onClick={() => handleSelectSpace(space)}
              role="treeitem"
              aria-current={isActive ? "page" : undefined}
              aria-level={depth + 1}
              className={cn(
                "group/space-row relative flex min-h-9 w-full items-center gap-2 rounded-xl px-2 py-1.5 text-left text-sm transition-[background-color,color,box-shadow] duration-150 ease-out cursor-pointer",
                isActive
                  ? "bg-background-neutral text-foreground-neutral shadow-[0_0_0_1px_rgba(0,0,0,0.05),0_3px_8px_-3px_rgba(0,0,0,0.12)]"
                  : "text-foreground-secondary hover:bg-background-neutral/60",
                !canDelete && "cursor-default",
                dnd.isDragging && "opacity-40",
                dnd.isOver && "outline-dashed outline-2 outline-offset-[-2px] outline-accent/50 bg-accent-faded/30"
              )}
              style={depth > 0 ? { marginLeft: depth * 14 } : undefined}
            >
              {space.isPrivate ? (
                <Shield
                  size={14}
                  className={cn("shrink-0", isActive ? "text-accent" : "text-foreground-icon", isLocked && "opacity-60")}
                />
              ) : (
                <Globe2
                  size={14}
                  className={cn("shrink-0", isActive ? "text-accent" : "text-foreground-icon")}
                />
              )}

              {isRenaming ? (
                <Input
                  autoFocus
                  value={rename?.value ?? ""}
                  onChange={(e) => setRename((current) => current ? { ...current, value: e.target.value } : null)}
                  onKeyDown={handleRenameKeyDown}
                  onBlur={commitRename}
                  onClick={(e) => e.stopPropagation()}
                  className="h-7 flex-1 bg-background-page-secondary text-sm"
                />
              ) : (
                <span className="min-w-0 flex-1 truncate font-semibold">{space.name}</span>
              )}

              {space.isPrivate && (
                <span className="inline-flex shrink-0 items-center gap-1 rounded-full bg-background-neutral-faded px-1.5 py-0.5 text-[10px] font-medium text-foreground-tertiary">
                  <Lock size={10} />
                  {isLocked ? "Locked" : "Open"}
                </span>
              )}
            </div>
            </SpaceContextMenu>
          )}
        </SidebarDnd>
      );

      return row;
    },
    [
      activeSpaceGroupId,
      activeSpaceId,
      beginRename,
      commitRename,
      groupTargets,
      handleRenameKeyDown,
      handleSelectSpace,
      handlers,
      moveSpaceDown,
      moveSpaceUp,
      rename,
      runWithBusy,
      spacesByGroupId,
      ungroupedSpaces,
    ]
  );

  const renderSpaceGroupRow = React.useCallback(
    (group: SpaceGroupDocType) => {
      const isActive = activeSpaceGroupId === group.id;
      const isRenaming = rename?.kind === "spaceGroup" && rename?.id === group.id;
      const childSpaces = spacesByGroupId.get(group.id) || [];
      const index = sortedSpaceGroups.findIndex((g) => g.id === group.id);
      const canMoveUp = index > 0;
      const canMoveDown = index >= 0 && index < sortedSpaceGroups.length - 1;

      const groupHandlers: SpaceGroupMenuHandlers = {
        onNewSpaceHere: () => handlers.newSpace(group.id),
        onRename: () => beginRename("spaceGroup", group.id, group.name),
        onToggleCollapse: () => handlers.toggleSpaceGroupCollapse(group),
        onMoveUp: () => void moveSpaceGroupUp(group),
        onMoveDown: () => void moveSpaceGroupDown(group),
        onShare: () => handlers.shareSpaceGroup(group),
        onDelete: () =>
          setDeleteSpaceGroupState({ group, mode: "deleteContents" }),
      };

      const row = (
        <SidebarDnd id={`sb-group-${group.id}`} data={{ surface: "sidebar", kind: "spaceGroup", id: group.id, name: group.name, collapsed: group.isCollapsed, springId: group.id }}>
          {(dnd) => (
            <SpaceGroupContextMenu
              group={group}
              canMoveUp={canMoveUp}
              canMoveDown={canMoveDown}
              handlers={groupHandlers}
            >
            <div
              ref={dnd.setNodeRef}
              {...dnd.attributes}
              {...dnd.listeners}
              className={cn(
                "group/spacegroup-row flex min-h-10 w-full items-center gap-1 rounded-xl px-1 py-1 text-left transition-[background-color,color] duration-150 ease-out",
                isActive
                  ? "bg-background-neutral text-foreground-neutral"
                  : "text-foreground-secondary hover:bg-background-neutral/60",
                dnd.isDragging && "opacity-40",
                dnd.isOver && "outline-dashed outline-2 outline-offset-[-2px] outline-accent/50 bg-accent-faded/30"
              )}
            >
              <button
                type="button"
                aria-label={group.isCollapsed ? `Expand ${group.name}` : `Collapse ${group.name}`}
                onClick={(e) => {
                  e.stopPropagation();
                  handlers.toggleSpaceGroupCollapse(group);
                }}
                className="grid size-7 shrink-0 place-items-center rounded text-foreground-icon hover:text-foreground-neutral"
              >
                {group.isCollapsed ? <ChevronRight size={14} /> : <ChevronDown size={14} />}
              </button>
              <button
                type="button"
                onClick={() => handlers.selectSpaceGroup(group)}
                className="flex min-w-0 flex-1 items-center gap-2 py-1 text-left"
              >
                <Bookmark
                  size={14}
                  className={cn(isActive ? "text-accent" : "text-foreground-icon")}
                />
                {isRenaming ? (
                  <Input
                    autoFocus
                    value={rename?.value ?? ""}
                    onChange={(e) =>
                      setRename((current) => (current ? { ...current, value: e.target.value } : null))
                    }
                    onKeyDown={handleRenameKeyDown}
                    onBlur={commitRename}
                    onClick={(e) => e.stopPropagation()}
                    className="h-7 flex-1 bg-background-page-secondary text-sm"
                  />
                ) : (
                  <>
                    <span className="truncate text-sm font-semibold">{group.name}</span>
                    <span className="ml-auto pr-1 text-[10px] text-foreground-tertiary">
                      {childSpaces.length}
                    </span>
                  </>
                )}
              </button>
            </div>
            </SpaceGroupContextMenu>
          )}
        </SidebarDnd>
      );

      return row;
    },
    [
      activeSpaceGroupId,
      beginRename,
      commitRename,
      handleRenameKeyDown,
      handlers,
      moveSpaceGroupDown,
      moveSpaceGroupUp,
      rename,
      sortedSpaceGroups,
      spacesByGroupId,
    ]
  );

  /* ---------- + Add menu ---------- */

  const addMenu = (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="h-9 w-full justify-start gap-2.5 rounded-xl px-2.5 text-foreground-secondary"
        >
          <Plus size={14} />
          Add
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-56">
        <DropdownMenuLabel>Create</DropdownMenuLabel>
        <DropdownMenuItem onSelect={() => handlers.newSpace(activeSpaceGroupId)}>
          <Plus size={14} className="text-foreground-tertiary" />
          New space
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={() => handlers.newSpaceGroup()}>
          <Bookmark size={14} className="text-foreground-tertiary" />
          New space group
        </DropdownMenuItem>
        <DropdownMenuItem
          onSelect={() =>
            setNewTabGroupTarget({
              spaceId: activeSpaceId,
              parentId: null,
              name: "",
            })
          }
        >
          <FolderInput size={14} className="text-foreground-tertiary" />
          New tab group here
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuLabel>Import &amp; backup</DropdownMenuLabel>
        <DropdownMenuItem onSelect={() => handlers.importBrowserBookmarks()}>
          <Bookmark size={14} className="text-foreground-tertiary" />
          Browser bookmarks
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={() => handlers.importGitHubStars()}>
          <GitFork size={14} className="text-foreground-tertiary" />
          GitHub stars
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={() => handlers.importSharedLink()}>
          <Download size={14} className="text-foreground-tertiary" />
          Import shared link…
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );

  /* ---------- Layout ---------- */

  const rootFolders = folderChildren.get(null) || [];

  return (
    <SidePanel className="rounded-xl shadow-sm shadow-foreground-muted/60">
      <div className="flex h-full w-full flex-col gap-2 overflow-y-auto overflow-x-hidden p-2 scrollbar-subtle">
        <div className="flex items-center gap-2">{addMenu}</div>

        <div className="px-1 pt-1 text-[10px] font-semibold uppercase tracking-[0.08em] text-foreground-tertiary">
          Spaces
        </div>

        {/* Ungrouped drop zone — accepts spaces being dragged out of a group. */}
        <SidebarDropZone id="sb-ungrouped" data={{ surface: "sidebar", kind: "ungrouped" }}>
          {(zone) => (
            <div
              ref={zone.setNodeRef}
              className={cn("rounded-xl", zone.isOver && "outline-dashed outline-2 outline-accent/40")}
            >
              {ungroupedSpaces.map((space) => renderSpaceRow(space, 0))}
            </div>
          )}
        </SidebarDropZone>

        {sortedSpaceGroups.map((group) => (
          <div key={group.id} className="space-y-0.5">
            {renderSpaceGroupRow(group)}
            {(!group.isCollapsed || isSpringOpen(group.id)) &&
              (spacesByGroupId.get(group.id) || []).map((space) => renderSpaceRow(space, 1))}
          </div>
        ))}

        <div className="mt-1 border-t border-border-neutral-faded/70" />

        <div className="flex items-center justify-between px-1 pt-0.5">
          <div className="text-[10px] font-semibold uppercase tracking-[0.08em] text-foreground-tertiary">
            Tab groups
          </div>
          <button
            type="button"
            onClick={() =>
              setNewTabGroupTarget({ spaceId: activeSpaceId, parentId: null, name: "" })
            }
            className="rounded-md px-1.5 py-0.5 text-[10px] font-medium text-foreground-tertiary transition-colors hover:bg-background-neutral-faded hover:text-foreground-neutral"
          >
            + New
          </button>
        </div>

        <SidebarDropZone id="sb-root" data={{ surface: "sidebar", kind: "root" }}>
          {(zone) => (
            <div
              ref={zone.setNodeRef}
              className={cn("rounded-xl", zone.isOver && "outline-dashed outline-2 outline-accent/40")}
            >
              <button
                type="button"
                onClick={() => handlers.selectFolder("all")}
                className={cn(
                  "flex min-h-9 w-full items-center gap-2.5 rounded-xl px-2 py-1.5 text-left transition-[background-color,color,box-shadow] duration-150 ease-out cursor-pointer",
                  selectedFolderId === "all"
                    ? "bg-background-neutral text-foreground-neutral shadow-[0_0_0_1px_rgba(0,0,0,0.05),0_3px_8px_-3px_rgba(0,0,0,0.12)]"
                    : "text-foreground-secondary hover:bg-background-neutral/60"
                )}
              >
                <Tabs fillColor="#6B95E5" size={16} />
                <span className="text-sm font-semibold">All tab groups</span>
              </button>

              {rootFolders.length === 0 ? (
                <p className="px-2 py-2 text-[11px] text-foreground-tertiary">
                  No tab groups yet —{" "}
                  <button
                    type="button"
                    className="text-foreground-secondary underline-offset-2 hover:underline"
                    onClick={() =>
                      setNewTabGroupTarget({ spaceId: activeSpaceId, parentId: null, name: "" })
                    }
                  >
                    + New
                  </button>
                </p>
              ) : (
                <div className="space-y-0.5">
                  {rootFolders.map((folder) => renderFolderRow(folder, 0))}
                </div>
              )}
            </div>
          )}
        </SidebarDropZone>

        <div className="mt-1 border-t border-border-neutral-faded/70 pt-1">
          <button
            type="button"
            onClick={() => {
              setBinViewOpen(true);
              onOpenBin();
            }}
            aria-haspopup="dialog"
            className="group/bin flex min-h-9 w-full items-center gap-2 rounded-xl px-2 py-1.5 text-left text-sm text-foreground-secondary transition-colors hover:bg-background-neutral/60"
          >
            <Trash2 size={14} className="shrink-0 text-foreground-tertiary" />
            <span className="min-w-0 flex-1 truncate">Bin</span>
            {binTotal > 0 && (
              <span className="shrink-0 rounded-full bg-background-page-secondary px-1.5 py-0.5 text-[10px] font-medium text-foreground-tertiary">
                {binTotal}
              </span>
            )}
          </button>
        </div>
      </div>

      <BinView
        open={binViewOpen}
        onOpenChange={setBinViewOpen}
        entries={binEntries}
        total={binTotal}
        page={binPage}
        hasMore={binHasMore}
        loading={binPageLoading}
        now={now}
        onNextPage={onNextBinPage}
        onPreviousPage={onPreviousBinPage}
        onRestore={(entry) => void restoreBinEntry(entry)}
        onRequestDelete={(entry) => setDeleteBinEntryState({ entry })}
      />

      {/* Delete tab group confirm */}
      <ConfirmDialog
        open={!!deleteFolderState}
        onOpenChange={(open) => !open && setDeleteFolderState(null)}
        title={
          deleteFolderState ? `Move "${deleteFolderState.folder.name}" to Bin?` : ""
        }
        description={
          deleteFolderState?.itemCount === null
            ? "Counting items…"
            : `This moves the tab group and every nested tab group or folder inside it to Bin${
                deleteFolderState?.alsoDeleteItems
                  ? `. ${deleteFolderState.itemCount} saved tab${
                      deleteFolderState.itemCount === 1 ? "" : "s"
                    } inside will be removed from search and can be recovered from Bin.`
                  : ". Saved tabs inside stay searchable under \"All tab groups.\""
              }`
        }
        confirmLabel="Move to Bin"
        variant="danger"
        onConfirm={confirmDeleteFolder}
      />

      {/* Delete space → move to bin confirm */}
      <ConfirmDialog
        open={!!deleteSpaceState}
        onOpenChange={(open) => !open && setDeleteSpaceState(null)}
        title={deleteSpaceState ? `Move "${deleteSpaceState.space.name}" to bin?` : ""}
        description="This moves the space to Bin with every tab group, folder, and saved item inside. It is removed from search and the sidebar now, recoverable for 30 days, then permanently deleted."
        confirmLabel="Move to Bin"
        variant="danger"
        onConfirm={confirmDeleteSpace}
      />

      {/* Delete space group confirm */}
      <ConfirmDialog
        open={!!deleteSpaceGroupState}
        onOpenChange={(open) => {
          if (!open) setDeleteSpaceGroupState(null);
        }}
        title={deleteSpaceGroupState ? `Delete "${deleteSpaceGroupState.group.name}"?` : ""}
        description={
          deleteSpaceGroupState?.mode === "deleteContents"
            ? "This moves every space in the group to Bin, including all tab groups, folders, and saved items inside. Spaces are recoverable for 30 days, then permanently deleted."
            : "Spaces inside will move to Ungrouped. Their tab groups are kept."
        }
        confirmLabel={
          deleteSpaceGroupState?.mode === "deleteContents" ? "Move group to Bin" : "Delete group"
        }
        variant="danger"
        onConfirm={confirmDeleteSpaceGroup}
      />

      {/* Delete bin entry forever confirm */}
      <ConfirmDialog
        open={!!deleteBinEntryState}
        onOpenChange={(open) => !open && setDeleteBinEntryState(null)}
        title={
          deleteBinEntryState
            ? `Permanently delete "${deleteBinEntryState.entry.name}"?`
            : ""
        }
        description={
          deleteBinEntryState?.entry.kind === "space"
            ? "This cannot be undone. The space and all of its tab groups, folders, and saved items will be removed immediately."
            : deleteBinEntryState?.entry.kind === "folder"
              ? "This cannot be undone. The folder or tab group and every nested folder and saved item inside will be removed immediately."
              : "This cannot be undone. This saved tab will be removed immediately."
        }
        confirmLabel="Delete forever"
        variant="danger"
        onConfirm={confirmDeleteBinEntry}
      />

      {/* New tab group inline dialog */}
      <Dialog open={!!newTabGroupTarget} onOpenChange={(open) => !open && setNewTabGroupTarget(null)}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>New tab group</DialogTitle>
            <DialogDescription>
              {newTabGroupTarget?.parentId
                ? "Created inside the selected folder."
                : "Created in the active space at the root of the sidebar."}
            </DialogDescription>
          </DialogHeader>
          <Input
            autoFocus
            value={newTabGroupTarget?.name ?? ""}
            placeholder="e.g. Research – Local-first"
            onChange={(e) =>
              setNewTabGroupTarget((current) =>
                current ? { ...current, name: e.target.value } : null
              )
            }
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                void submitNewTabGroup();
              } else if (e.key === "Escape") {
                setNewTabGroupTarget(null);
              }
            }}
          />
          <DialogFooter>
            <Button variant="secondary" onClick={() => setNewTabGroupTarget(null)}>
              Cancel
            </Button>
            <Button onClick={() => void submitNewTabGroup()} disabled={busy || !(newTabGroupTarget?.name.trim())}>
              Create
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </SidePanel>
  );
});

export default Sidebar;
