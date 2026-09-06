import { Bookmark, Download, FolderInput, GitFork, Plus } from "lucide-react";
import type { Dispatch, SetStateAction } from "react";

import { Button } from "@src/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@src/components/ui/dropdown-menu";

import type { NewTabGroupTarget, SidebarHandlers } from "./sidebar-types";

type SidebarAddMenuProps = {
  activeSpaceId: string;
  activeSpaceGroupId: string | null;
  handlers: SidebarHandlers;
  setNewTabGroupTarget: Dispatch<SetStateAction<NewTabGroupTarget | null>>;
};

export function SidebarAddMenu({
  activeSpaceId,
  activeSpaceGroupId,
  handlers,
  setNewTabGroupTarget,
}: SidebarAddMenuProps) {
  return (
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
        <DropdownMenuItem
          onSelect={() => handlers.newSpace(activeSpaceGroupId)}
        >
          <Plus size={14} className="text-foreground-tertiary" />
          New space
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={handlers.newSpaceGroup}>
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
        <DropdownMenuItem onSelect={handlers.importBrowserBookmarks}>
          <Bookmark size={14} className="text-foreground-tertiary" />
          Browser bookmarks
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={handlers.importGitHubStars}>
          <GitFork size={14} className="text-foreground-tertiary" />
          GitHub stars
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={handlers.importSharedLink}>
          <Download size={14} className="text-foreground-tertiary" />
          Import shared link…
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
