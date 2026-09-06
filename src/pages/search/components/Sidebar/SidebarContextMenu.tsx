import * as React from "react";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuSub,
  ContextMenuSubContent,
  ContextMenuSubTrigger,
  ContextMenuTrigger,
  ContextMenuLabel,
} from "@src/components/ui/context-menu";
import { cn } from "@src/lib/utils";
import type { FolderDocType } from "@src/schemas/folder_schema";
import type { SpaceGroupDocType } from "@src/schemas/space_group_schema";
import {
  Archive,
  ChevronDown,
  ChevronRight,
  Copy,
  FolderInput,
  FolderPlus,
  Lock,
  Pencil,
  Pin,
  PinOff,
  RotateCcw,
  Share2,
  Trash2,
  Unlock,
} from "lucide-react";
import type { SidebarSpace } from "./sidebar-sort";

type SpaceMoveTarget = { id: string; name: string };

type CommonMenuProps = {
  children: React.ReactNode;
};

const MenuIcon = ({ Icon, className }: { Icon: React.ComponentType<{ className?: string }>; className?: string }) => (
  <Icon className={cn("size-4 text-foreground-tertiary", className)} />
);

/* ----- Space group ----- */

export type SpaceGroupMenuHandlers = {
  onNewSpaceHere: () => void;
  onRename: () => void;
  onToggleCollapse: () => void;
  onMoveUp: () => void;
  onMoveDown: () => void;
  onShare: () => void;
  onDelete: () => void;
};

export const SpaceGroupContextMenu = ({
  group,
  canMoveUp,
  canMoveDown,
  handlers,
  children,
}: CommonMenuProps & {
  group: SpaceGroupDocType;
  canMoveUp: boolean;
  canMoveDown: boolean;
  handlers: SpaceGroupMenuHandlers;
}) => {
  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>{children}</ContextMenuTrigger>
      <ContextMenuContent className="w-56">
        <ContextMenuLabel>{group.name}</ContextMenuLabel>
        <ContextMenuItem onSelect={handlers.onNewSpaceHere}>
          <MenuIcon Icon={FolderPlus} />
          New space here
        </ContextMenuItem>
        <ContextMenuItem onSelect={handlers.onRename}>
          <MenuIcon Icon={Pencil} />
          Rename
        </ContextMenuItem>
        <ContextMenuItem onSelect={handlers.onToggleCollapse}>
          <MenuIcon Icon={group.isCollapsed ? ChevronRight : ChevronDown} />
          {group.isCollapsed ? "Expand" : "Collapse"}
        </ContextMenuItem>
        <ContextMenuSeparator />
        <ContextMenuItem onSelect={handlers.onMoveUp} disabled={!canMoveUp}>
          <MenuIcon Icon={ChevronRight} className="rotate-[-90deg]" />
          Move up
        </ContextMenuItem>
        <ContextMenuItem onSelect={handlers.onMoveDown} disabled={!canMoveDown}>
          <MenuIcon Icon={ChevronRight} className="rotate-90" />
          Move down
        </ContextMenuItem>
        <ContextMenuSeparator />
        <ContextMenuItem onSelect={handlers.onShare}>
          <MenuIcon Icon={Share2} className="text-accent" />
          Share group…
        </ContextMenuItem>
        <ContextMenuSeparator />
        <ContextMenuItem variant="destructive" onSelect={handlers.onDelete}>
          <MenuIcon Icon={Trash2} className="text-foreground-danger" />
          Delete group…
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  );
};

/* ----- Space ----- */

export type SpaceMenuHandlers = {
  onOpen: () => void;
  onNewTabGroupHere: () => void;
  onRename: () => void;
  onMoveToGroup: (groupId: string | null) => void;
  onPin: () => void;
  onLock: () => void;
  onUnlock: () => void;
  onChangePassword: () => void;
  onMoveUp: () => void;
  onMoveDown: () => void;
  onShare: () => void;
  onMoveToBin: () => void;
};

export const SpaceContextMenu = ({
  space,
  canMoveUp,
  canMoveDown,
  canPin,
  canRename,
  canDelete,
  canChangePassword,
  groupTargets,
  handlers,
  children,
}: CommonMenuProps & {
  space: SidebarSpace;
  canMoveUp: boolean;
  canMoveDown: boolean;
  canPin: boolean;
  canRename: boolean;
  canDelete: boolean;
  canChangePassword: boolean;
  groupTargets: SpaceMoveTarget[];
  handlers: SpaceMenuHandlers;
}) => {
  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>{children}</ContextMenuTrigger>
      <ContextMenuContent className="w-60">
        <ContextMenuLabel>{space.name}</ContextMenuLabel>
        <ContextMenuItem onSelect={handlers.onOpen}>
          <MenuIcon Icon={ChevronRight} className="rotate-[-90deg]" />
          Open
        </ContextMenuItem>
        <ContextMenuItem onSelect={handlers.onNewTabGroupHere}>
          <MenuIcon Icon={FolderPlus} />
          New tab group here
        </ContextMenuItem>
        <ContextMenuSeparator />
        {canRename && (
          <ContextMenuItem onSelect={handlers.onRename}>
            <MenuIcon Icon={Pencil} />
            Rename
          </ContextMenuItem>
        )}
        {canPin && (
          <ContextMenuItem onSelect={handlers.onPin}>
            <MenuIcon Icon={Pin} />
            Pin to top
          </ContextMenuItem>
        )}
        {space.isPrivate && !space.access.isUnlocked && (
          <ContextMenuItem onSelect={handlers.onUnlock}>
            <MenuIcon Icon={Lock} />
            Unlock
          </ContextMenuItem>
        )}
        {space.isPrivate && space.access.isUnlocked && (
          <>
            <ContextMenuItem onSelect={handlers.onLock}>
              <MenuIcon Icon={Unlock} />
              Lock now
            </ContextMenuItem>
            {canChangePassword && (
              <ContextMenuItem onSelect={handlers.onChangePassword}>
                <MenuIcon Icon={Pencil} />
                Change password…
              </ContextMenuItem>
            )}
          </>
        )}
        {groupTargets.length > 0 && (
          <ContextMenuSub>
            <ContextMenuSubTrigger>
              <MenuIcon Icon={FolderInput} />
              Move to group
            </ContextMenuSubTrigger>
            <ContextMenuSubContent className="w-48">
              <ContextMenuItem onSelect={() => handlers.onMoveToGroup(null)}>
                Ungrouped
              </ContextMenuItem>
              <ContextMenuSeparator />
              {groupTargets.map((g) => (
                <ContextMenuItem
                  key={g.id}
                  disabled={g.id === space.spaceGroupId}
                  onSelect={() => handlers.onMoveToGroup(g.id)}
                >
                  {g.name}
                </ContextMenuItem>
              ))}
            </ContextMenuSubContent>
          </ContextMenuSub>
        )}
        <ContextMenuSeparator />
        <ContextMenuItem onSelect={handlers.onMoveUp} disabled={!canMoveUp}>
          <MenuIcon Icon={ChevronRight} className="rotate-[-90deg]" />
          Move up
        </ContextMenuItem>
        <ContextMenuItem onSelect={handlers.onMoveDown} disabled={!canMoveDown}>
          <MenuIcon Icon={ChevronRight} className="rotate-90" />
          Move down
        </ContextMenuItem>
        {canDelete && (
          <>
            <ContextMenuSeparator />
            <ContextMenuItem onSelect={handlers.onShare}>
              <MenuIcon Icon={Share2} className="text-accent" />
              Share space…
            </ContextMenuItem>
            <ContextMenuSeparator />
            <ContextMenuItem variant="destructive" onSelect={handlers.onMoveToBin}>
              <MenuIcon Icon={Archive} className="text-foreground-danger" />
              Move to bin…
            </ContextMenuItem>
          </>
        )}
        {!canDelete && (
          <ContextMenuSeparator />
        )}
        {!canDelete && (
          <ContextMenuItem onSelect={handlers.onShare}>
            <MenuIcon Icon={Share2} className="text-accent" />
            Share space…
          </ContextMenuItem>
        )}
      </ContextMenuContent>
    </ContextMenu>
  );
};

/* ----- Tab group ----- */

export type TabGroupMenuHandlers = {
  onOpen: () => void;
  onRename: () => void;
  onNewSubFolder: () => void;
  onTogglePin: () => void;
  onToggleCollapse: () => void;
  onMoveToSpace: (spaceId: string) => void;
  onCopyToSpace: (spaceId: string) => void;
  onMoveUp: () => void;
  onMoveDown: () => void;
  onShare: () => void;
  onDelete: () => void;
};

export const TabGroupContextMenu = ({
  folder,
  hasChildren,
  canMoveUp,
  canMoveDown,
  canNest,
  spaceMoveTargets,
  handlers,
  children,
}: CommonMenuProps & {
  folder: FolderDocType;
  hasChildren: boolean;
  canMoveUp: boolean;
  canMoveDown: boolean;
  canNest: boolean;
  spaceMoveTargets: SpaceMoveTarget[];
  handlers: TabGroupMenuHandlers;
}) => {
  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>{children}</ContextMenuTrigger>
      <ContextMenuContent className="w-60">
        <ContextMenuLabel>{folder.name}</ContextMenuLabel>
        <ContextMenuItem onSelect={handlers.onOpen}>
          <MenuIcon Icon={ChevronRight} className="rotate-[-90deg]" />
          Open
        </ContextMenuItem>
        <ContextMenuItem onSelect={handlers.onRename}>
          <MenuIcon Icon={Pencil} />
          Rename
        </ContextMenuItem>
        {canNest && (
          <ContextMenuItem onSelect={handlers.onNewSubFolder}>
            <MenuIcon Icon={FolderPlus} />
            New sub-folder here
          </ContextMenuItem>
        )}
        <ContextMenuItem onSelect={handlers.onTogglePin}>
          <MenuIcon Icon={folder.isPinned ? PinOff : Pin} />
          {folder.isPinned ? "Unpin" : "Pin to top"}
        </ContextMenuItem>
        {hasChildren && (
          <ContextMenuItem onSelect={handlers.onToggleCollapse}>
            <MenuIcon Icon={folder.isCollapsed ? ChevronRight : ChevronDown} />
            {folder.isCollapsed ? "Expand" : "Collapse"}
          </ContextMenuItem>
        )}
        {spaceMoveTargets.length > 0 && (
          <ContextMenuSub>
            <ContextMenuSubTrigger>
              <MenuIcon Icon={FolderInput} />
              Move to space
            </ContextMenuSubTrigger>
            <ContextMenuSubContent className="w-48">
              {spaceMoveTargets.map((s) => (
                <ContextMenuItem
                  key={s.id}
                  disabled={s.id === folder.spaceId}
                  onSelect={() => handlers.onMoveToSpace(s.id)}
                >
                  {s.name}
                </ContextMenuItem>
              ))}
            </ContextMenuSubContent>
          </ContextMenuSub>
        )}
        {spaceMoveTargets.length > 0 && (
          <ContextMenuSub>
            <ContextMenuSubTrigger>
              <MenuIcon Icon={Copy} />
              Copy to space
            </ContextMenuSubTrigger>
            <ContextMenuSubContent className="w-48">
              {spaceMoveTargets.map((s) => (
                <ContextMenuItem
                  key={s.id}
                  disabled={s.id === folder.spaceId}
                  onSelect={() => handlers.onCopyToSpace(s.id)}
                >
                  {s.name}
                </ContextMenuItem>
              ))}
            </ContextMenuSubContent>
          </ContextMenuSub>
        )}
        <ContextMenuSeparator />
        <ContextMenuItem onSelect={handlers.onMoveUp} disabled={!canMoveUp}>
          <MenuIcon Icon={ChevronRight} className="rotate-[-90deg]" />
          Move up
        </ContextMenuItem>
        <ContextMenuItem onSelect={handlers.onMoveDown} disabled={!canMoveDown}>
          <MenuIcon Icon={ChevronRight} className="rotate-90" />
          Move down
        </ContextMenuItem>
        <ContextMenuSeparator />
        <ContextMenuItem onSelect={handlers.onShare}>
          <MenuIcon Icon={Share2} className="text-accent" />
          Share tab group…
        </ContextMenuItem>
        <ContextMenuSeparator />
        <ContextMenuItem variant="destructive" onSelect={handlers.onDelete}>
          <MenuIcon Icon={Trash2} className="text-foreground-danger" />
          Delete…
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  );
};

/* ----- Bin space ----- */

export type BinSpaceMenuHandlers = {
  onRestore: () => void;
  onDeleteForever: () => void;
};

export const BinSpaceContextMenu = ({
  space,
  handlers,
  children,
}: CommonMenuProps & {
  space: SidebarSpace;
  handlers: BinSpaceMenuHandlers;
}) => {
  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>{children}</ContextMenuTrigger>
      <ContextMenuContent className="w-56">
        <ContextMenuLabel>{space.name}</ContextMenuLabel>
        <ContextMenuItem onSelect={handlers.onRestore}>
          <MenuIcon Icon={RotateCcw} />
          Restore
        </ContextMenuItem>
        <ContextMenuSeparator />
        <ContextMenuItem variant="destructive" onSelect={handlers.onDeleteForever}>
          <MenuIcon Icon={Trash2} className="text-foreground-danger" />
          Delete forever…
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  );
};
