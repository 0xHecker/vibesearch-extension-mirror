import * as React from "react";
import { cn } from "@src/lib/utils";
import { useSpringExpand } from "@src/components/dnd/OrganizeDndProvider";
import type { BinEntry } from "@src/common/bin";
import {
  Bookmark,
  ChevronDown,
  ChevronRight,
  Shield,
  Globe2,
  Lock,
  Trash2,
} from "lucide-react";
import { Input } from "@src/components/ui/input";
import { Tabs } from "@src/components/icons/tabs";
import SidePanel from "@src/components/ui/SidePanel";
import type { FolderDocType } from "@src/schemas/folder_schema";
import type { SpaceGroupDocType } from "@src/schemas/space_group_schema";
import { PUBLIC_SPACE_ID, PRIVATE_SPACE_ID } from "@src/common/spaces";
import {
  type SidebarSpace,
  buildFolderChildren,
  NESTED_FOLDER_INDENT_PX,
  sortSidebarFolders,
  sortSidebarSpaceGroups,
  sortSidebarSpaces,
} from "./sidebar-sort";

export type { SidebarSpace } from "./sidebar-sort";
import {
  SpaceContextMenu,
  SpaceGroupContextMenu,
  TabGroupContextMenu,
  type SpaceGroupMenuHandlers,
  type SpaceMenuHandlers,
  type TabGroupMenuHandlers,
} from "./SidebarContextMenu";

import {
  SidebarDnd,
  SidebarDropZone,
  useSidebarDropResolver,
} from "./sidebar-dnd";
import { SidebarAddMenu } from "./sidebar-add-menu";
import { SidebarDialogs } from "./sidebar-dialogs";
import { useSidebarOrderActions } from "./use-sidebar-order-actions";
import type {
  DeleteBinEntryState,
  DeleteFolderState,
  DeleteSpaceGroupState,
  DeleteSpaceState,
  InlineRenameState,
  NewTabGroupTarget,
  SidebarProps,
  SpaceMoveTarget,
} from "./sidebar-types";
export type {
  InlineRenameState,
  SidebarHandlers,
  SidebarProps,
} from "./sidebar-types";

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
  const [deleteFolderState, setDeleteFolderState] =
    React.useState<DeleteFolderState | null>(null);
  const [deleteSpaceState, setDeleteSpaceState] =
    React.useState<DeleteSpaceState | null>(null);
  const [deleteSpaceGroupState, setDeleteSpaceGroupState] =
    React.useState<DeleteSpaceGroupState | null>(null);
  const [deleteBinEntryState, setDeleteBinEntryState] =
    React.useState<DeleteBinEntryState | null>(null);
  const [binViewOpen, setBinViewOpen] = React.useState(false);

  // Allow the page (Settings → Open bin) to open the Bin view.
  React.useEffect(() => {
    if (!openBinNonce || openBinNonce <= 0) return;
    setBinViewOpen(true);
    onOpenBin();
  }, [onOpenBin, openBinNonce]);
  const [newTabGroupTarget, setNewTabGroupTarget] =
    React.useState<NewTabGroupTarget | null>(null);
  const [busy, setBusy] = React.useState(false);

  const { isSpringOpen } = useSpringExpand();

  const sortedSpaces = React.useMemo(() => sortSidebarSpaces(spaces), [spaces]);
  const sortedSpaceGroups = React.useMemo(
    () => sortSidebarSpaceGroups(spaceGroups),
    [spaceGroups],
  );
  const ungroupedSpaces = React.useMemo(
    () => sortedSpaces.filter((s) => !s.spaceGroupId),
    [sortedSpaces],
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
      ? new Set(
          (spacesByGroupId.get(activeSpaceGroupId) || []).map((s) => s.id),
        )
      : new Set([activeSpaceId]);
    return allowedSpaceIds;
  }, [activeSpaceGroupId, activeSpaceId, spacesByGroupId]);

  const scopedFolders = React.useMemo(
    () =>
      sortSidebarFolders(folders.filter((f) => scopedFolderIds.has(f.spaceId))),
    [folders, scopedFolderIds],
  );

  const folderChildren = React.useMemo(
    () => buildFolderChildren(scopedFolders),
    [scopedFolders],
  );

  const spaceMoveTargets: SpaceMoveTarget[] = React.useMemo(
    () =>
      sortedSpaces
        .filter((s) => !s.isPrivate || s.access.isUnlocked)
        .map((s) => ({ id: s.id, name: s.name, isPrivate: s.isPrivate })),
    [sortedSpaces],
  );

  const groupTargets = React.useMemo(
    () => sortedSpaceGroups.map((g) => ({ id: g.id, name: g.name })),
    [sortedSpaceGroups],
  );

  useSidebarDropResolver({
    activeSpaceId,
    activeSpaceGroupId,
    sortedSpaces,
    sortedSpaceGroups,
    ungroupedSpaces,
    spacesByGroupId,
    folderChildren,
    handlers,
  });

  const beginRename = React.useCallback(
    (kind: InlineRenameState["kind"], id: string, currentValue: string) => {
      setRename({ kind, id, value: currentValue });
    },
    [],
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
    [cancelRename, commitRename],
  );

  const handleSelectSpace = React.useCallback(
    (space: SidebarSpace) => {
      if (space.isPrivate && !space.access.isUnlocked) {
        handlers.unlockSpace(space);
        return;
      }
      handlers.selectSpace(space);
    },
    [handlers],
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
    [handlers],
  );

  const openDeleteFolder = React.useCallback(
    async (folder: FolderDocType) => {
      setDeleteFolderState({ folder, itemCount: null, alsoDeleteItems: true });
      const counts = await ensureFolderCounts([folder]);
      setDeleteFolderState((current) =>
        current && current.folder.id === folder.id
          ? { ...current, itemCount: counts[folder.id] ?? 0 }
          : current,
      );
    },
    [ensureFolderCounts],
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
    [handlers],
  );

  const {
    moveSpaceUp,
    moveSpaceDown,
    moveSpaceGroupUp,
    moveSpaceGroupDown,
    moveFolderUp,
    moveFolderDown,
    toggleFolderPin,
  } = useSidebarOrderActions({
    sortedSpaceGroups,
    ungroupedSpaces,
    spacesByGroupId,
    folderChildren,
    handlers,
  });

  const submitNewTabGroup = React.useCallback(async () => {
    if (!newTabGroupTarget) return;
    const name = newTabGroupTarget.name.trim();
    if (!name) return;
    setNewTabGroupTarget(null);
    try {
      await handlers.createFolder(
        name,
        newTabGroupTarget.spaceId,
        newTabGroupTarget.parentId,
      );
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
          setNewTabGroupTarget({
            spaceId: folder.spaceId,
            parentId: folder.id,
            name: "",
          }),
        onTogglePin: () => void toggleFolderPin(folder),
        onToggleCollapse: () => handlers.toggleFolderCollapse(folder),
        onMoveToSpace: (spaceId) =>
          void runWithBusy(() =>
            handlers.moveFolderToSpace(folder.id, spaceId),
          ),
        onCopyToSpace: (spaceId) =>
          void runWithBusy(() =>
            handlers.moveFolderToSpace(folder.id, spaceId),
          ),
        onMoveUp: () => void moveFolderUp(folder),
        onMoveDown: () => void moveFolderDown(folder),
        onShare: () => handlers.shareFolder(folder),
        onDelete: () => void openDeleteFolder(folder),
      };

      const siblingIndex = (
        folderChildren.get(folder.parentId ?? null) || []
      ).findIndex((f) => f.id === folder.id);
      const siblingCount = (folderChildren.get(folder.parentId ?? null) || [])
        .length;

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
                onDoubleClick={() =>
                  beginRename("folder", folder.id, folder.name)
                }
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
                  dnd.isOver &&
                    "outline-dashed outline-2 outline-offset-[-2px] outline-accent/50 bg-accent-faded/30",
                )}
                style={{ paddingLeft: 8 + depth * NESTED_FOLDER_INDENT_PX }}
              >
                {hasChildren ? (
                  <button
                    type="button"
                    aria-label={
                      folder.isCollapsed
                        ? `Expand ${folder.name}`
                        : `Collapse ${folder.name}`
                    }
                    onClick={(e) => {
                      e.stopPropagation();
                      handlers.toggleFolderCollapse(folder);
                    }}
                    className="grid size-5 shrink-0 place-items-center rounded text-foreground-icon hover:text-foreground-neutral"
                  >
                    {folder.isCollapsed ? (
                      <ChevronRight size={13} />
                    ) : (
                      <ChevronDown size={13} />
                    )}
                  </button>
                ) : (
                  <span className="w-5 shrink-0" />
                )}

                <Tabs
                  fillColor={folder.isPinned ? "#E56B6B" : "#6B95E5"}
                  size={16}
                />

                {isRenaming ? (
                  <Input
                    autoFocus
                    value={rename?.value ?? ""}
                    onChange={(e) =>
                      setRename((current) =>
                        current ? { ...current, value: e.target.value } : null,
                      )
                    }
                    onKeyDown={handleRenameKeyDown}
                    onBlur={commitRename}
                    onClick={(e) => e.stopPropagation()}
                    className="h-7 flex-1 bg-background-page-secondary text-sm"
                  />
                ) : (
                  <span className="min-w-0 flex-1 truncate font-semibold">
                    {folder.name}
                  </span>
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
          {(!folder.isCollapsed || isSpringOpen(folder.id)) &&
            hasChildren &&
            depth < 6 && (
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
    ],
  );

  const renderSpaceRow = React.useCallback(
    (space: SidebarSpace, depth: number) => {
      const isActive =
        activeSpaceGroupId === null && activeSpaceId === space.id;
      const isLocked = space.isPrivate && !space.access.isUnlocked;
      const isRenaming = rename?.kind === "space" && rename?.id === space.id;
      const canRename =
        space.id !== PUBLIC_SPACE_ID && space.id !== PRIVATE_SPACE_ID;
      const canDelete = canRename;
      const canPin = false; // Pin-to-top for spaces is reserved for a future pass
      const canChangePassword =
        space.isPrivate &&
        space.access.isUnlocked &&
        space.id === PRIVATE_SPACE_ID;

      const spaceHandlers: SpaceMenuHandlers = {
        onOpen: () => handleSelectSpace(space),
        onNewTabGroupHere: () =>
          setNewTabGroupTarget({ spaceId: space.id, parentId: null, name: "" }),
        onRename: canRename
          ? () => beginRename("space", space.id, space.name)
          : () => {},
        onMoveToGroup: (groupId) =>
          void runWithBusy(() => handlers.moveSpaceToGroup(space.id, groupId)),
        onPin: () => {},
        onLock: () => handlers.lockSpace(space),
        onUnlock: () => handlers.unlockSpace(space),
        onChangePassword: canChangePassword
          ? () => handlers.openChangeSpacePassword(space)
          : () => {},
        onMoveUp: () => void moveSpaceUp(space),
        onMoveDown: () => void moveSpaceDown(space),
        onShare: () => handlers.shareSpace(space),
        onMoveToBin: canDelete
          ? () => setDeleteSpaceState({ space })
          : () => {},
      };

      const siblings = space.spaceGroupId
        ? spacesByGroupId.get(space.spaceGroupId)
        : ungroupedSpaces;
      const idx = (siblings || []).findIndex((s) => s.id === space.id);
      const canMoveUp = idx > 0;
      const canMoveDown = idx >= 0 && idx < (siblings?.length || 0) - 1;

      const row = (
        <SidebarDnd
          key={space.id}
          id={`sb-space-${space.id}`}
          data={{
            surface: "sidebar",
            kind: "space",
            id: space.id,
            spaceGroupId: space.spaceGroupId ?? null,
          }}
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
                  dnd.isOver &&
                    "outline-dashed outline-2 outline-offset-[-2px] outline-accent/50 bg-accent-faded/30",
                )}
                style={depth > 0 ? { marginLeft: depth * 14 } : undefined}
              >
                {space.isPrivate ? (
                  <Shield
                    size={14}
                    className={cn(
                      "shrink-0",
                      isActive ? "text-accent" : "text-foreground-icon",
                      isLocked && "opacity-60",
                    )}
                  />
                ) : (
                  <Globe2
                    size={14}
                    className={cn(
                      "shrink-0",
                      isActive ? "text-accent" : "text-foreground-icon",
                    )}
                  />
                )}

                {isRenaming ? (
                  <Input
                    autoFocus
                    value={rename?.value ?? ""}
                    onChange={(e) =>
                      setRename((current) =>
                        current ? { ...current, value: e.target.value } : null,
                      )
                    }
                    onKeyDown={handleRenameKeyDown}
                    onBlur={commitRename}
                    onClick={(e) => e.stopPropagation()}
                    className="h-7 flex-1 bg-background-page-secondary text-sm"
                  />
                ) : (
                  <span className="min-w-0 flex-1 truncate font-semibold">
                    {space.name}
                  </span>
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
    ],
  );

  const renderSpaceGroupRow = React.useCallback(
    (group: SpaceGroupDocType) => {
      const isActive = activeSpaceGroupId === group.id;
      const isRenaming =
        rename?.kind === "spaceGroup" && rename?.id === group.id;
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
        <SidebarDnd
          id={`sb-group-${group.id}`}
          data={{
            surface: "sidebar",
            kind: "spaceGroup",
            id: group.id,
            name: group.name,
            collapsed: group.isCollapsed,
            springId: group.id,
          }}
        >
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
                  dnd.isOver &&
                    "outline-dashed outline-2 outline-offset-[-2px] outline-accent/50 bg-accent-faded/30",
                )}
              >
                <button
                  type="button"
                  aria-label={
                    group.isCollapsed
                      ? `Expand ${group.name}`
                      : `Collapse ${group.name}`
                  }
                  onClick={(e) => {
                    e.stopPropagation();
                    handlers.toggleSpaceGroupCollapse(group);
                  }}
                  className="grid size-7 shrink-0 place-items-center rounded text-foreground-icon hover:text-foreground-neutral"
                >
                  {group.isCollapsed ? (
                    <ChevronRight size={14} />
                  ) : (
                    <ChevronDown size={14} />
                  )}
                </button>
                <button
                  type="button"
                  onClick={() => handlers.selectSpaceGroup(group)}
                  className="flex min-w-0 flex-1 items-center gap-2 py-1 text-left"
                >
                  <Bookmark
                    size={14}
                    className={cn(
                      isActive ? "text-accent" : "text-foreground-icon",
                    )}
                  />
                  {isRenaming ? (
                    <Input
                      autoFocus
                      value={rename?.value ?? ""}
                      onChange={(e) =>
                        setRename((current) =>
                          current
                            ? { ...current, value: e.target.value }
                            : null,
                        )
                      }
                      onKeyDown={handleRenameKeyDown}
                      onBlur={commitRename}
                      onClick={(e) => e.stopPropagation()}
                      className="h-7 flex-1 bg-background-page-secondary text-sm"
                    />
                  ) : (
                    <>
                      <span className="truncate text-sm font-semibold">
                        {group.name}
                      </span>
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
    ],
  );

  const rootFolders = folderChildren.get(null) || [];

  return (
    <SidePanel className="rounded-xl shadow-sm shadow-foreground-muted/60">
      <div className="flex h-full w-full flex-col gap-2 overflow-y-auto overflow-x-hidden p-2 scrollbar-subtle">
        <div className="flex items-center gap-2">
          <SidebarAddMenu
            activeSpaceId={activeSpaceId}
            activeSpaceGroupId={activeSpaceGroupId}
            handlers={handlers}
            setNewTabGroupTarget={setNewTabGroupTarget}
          />
        </div>

        <div className="px-1 pt-1 text-[10px] font-semibold uppercase tracking-[0.08em] text-foreground-tertiary">
          Spaces
        </div>

        {/* Ungrouped drop zone — accepts spaces being dragged out of a group. */}
        <SidebarDropZone
          id="sb-ungrouped"
          data={{ surface: "sidebar", kind: "ungrouped" }}
        >
          {(zone) => (
            <div
              ref={zone.setNodeRef}
              className={cn(
                "rounded-xl",
                zone.isOver && "outline-dashed outline-2 outline-accent/40",
              )}
            >
              {ungroupedSpaces.map((space) => renderSpaceRow(space, 0))}
            </div>
          )}
        </SidebarDropZone>

        {sortedSpaceGroups.map((group) => (
          <div key={group.id} className="space-y-0.5">
            {renderSpaceGroupRow(group)}
            {(!group.isCollapsed || isSpringOpen(group.id)) &&
              (spacesByGroupId.get(group.id) || []).map((space) =>
                renderSpaceRow(space, 1),
              )}
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
              setNewTabGroupTarget({
                spaceId: activeSpaceId,
                parentId: null,
                name: "",
              })
            }
            className="rounded-md px-1.5 py-0.5 text-[10px] font-medium text-foreground-tertiary transition-colors hover:bg-background-neutral-faded hover:text-foreground-neutral"
          >
            + New
          </button>
        </div>

        <SidebarDropZone
          id="sb-root"
          data={{ surface: "sidebar", kind: "root" }}
        >
          {(zone) => (
            <div
              ref={zone.setNodeRef}
              className={cn(
                "rounded-xl",
                zone.isOver && "outline-dashed outline-2 outline-accent/40",
              )}
            >
              <button
                type="button"
                onClick={() => handlers.selectFolder("all")}
                className={cn(
                  "flex min-h-9 w-full items-center gap-2.5 rounded-xl px-2 py-1.5 text-left transition-[background-color,color,box-shadow] duration-150 ease-out cursor-pointer",
                  selectedFolderId === "all"
                    ? "bg-background-neutral text-foreground-neutral shadow-[0_0_0_1px_rgba(0,0,0,0.05),0_3px_8px_-3px_rgba(0,0,0,0.12)]"
                    : "text-foreground-secondary hover:bg-background-neutral/60",
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
                      setNewTabGroupTarget({
                        spaceId: activeSpaceId,
                        parentId: null,
                        name: "",
                      })
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

      <SidebarDialogs
        binViewOpen={binViewOpen}
        setBinViewOpen={setBinViewOpen}
        binEntries={binEntries}
        binTotal={binTotal}
        binPage={binPage}
        binHasMore={binHasMore}
        binPageLoading={binPageLoading}
        now={now}
        onNextBinPage={onNextBinPage}
        onPreviousBinPage={onPreviousBinPage}
        restoreBinEntry={restoreBinEntry}
        setDeleteBinEntryState={setDeleteBinEntryState}
        deleteFolderState={deleteFolderState}
        setDeleteFolderState={setDeleteFolderState}
        confirmDeleteFolder={confirmDeleteFolder}
        deleteSpaceState={deleteSpaceState}
        setDeleteSpaceState={setDeleteSpaceState}
        confirmDeleteSpace={confirmDeleteSpace}
        deleteSpaceGroupState={deleteSpaceGroupState}
        setDeleteSpaceGroupState={setDeleteSpaceGroupState}
        confirmDeleteSpaceGroup={confirmDeleteSpaceGroup}
        deleteBinEntryState={deleteBinEntryState}
        confirmDeleteBinEntry={confirmDeleteBinEntry}
        newTabGroupTarget={newTabGroupTarget}
        setNewTabGroupTarget={setNewTabGroupTarget}
        busy={busy}
        submitNewTabGroup={submitNewTabGroup}
      />
    </SidePanel>
  );
});

export default Sidebar;
