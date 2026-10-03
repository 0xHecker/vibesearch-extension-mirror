import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  formatTabsForClipboard,
  getClipboardFormat,
} from "@src/pages/search/components/settings/clipboard-format";
import { CopyIcon } from "@icons/copy";
import { Checkmark } from "@icons/checkmark";
import { OpenArrowIcon } from "@icons/open-arrow";
import { DeleteIcon } from "@icons/delete";
import { Button } from "@components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubTrigger,
  DropdownMenuSubContent,
  DropdownMenuTrigger,
} from "@components/ui/dropdown-menu";
import { SearchThickIcon } from "@icons/search-thick";
import { Input } from "@components/ui/input";
import { cn } from "@src/lib/utils";
import { ChevronRight } from "@icons/chevron-right";
import { DotIcon } from "@icons/dot";
import { LockShadowIcon } from "@icons/lock";
import { PinShadowIcon } from "@icons/pin";
import { FolderDocType } from "@src/schemas/folder_schema";
import { ItemDocType } from "@src/schemas/item_schema";
import { ExpandingButton } from "@components/TabGroups/ExpandingButton";
import { AddTabButton } from "@components/TabGroups/AddTabButton";
import { FlatItem, SortableFlatItem } from "@components/TabGroups/FlatItem";
import { GridItem, SortableGridItem } from "./GridItem";
import { Masonry } from "react-plock";
import {
  openUrlsInCurrentWindow,
  openUrlsInNewTabGroup,
  openUrlsInNewWindow,
} from "@src/utils/chromeTabs";
import { ConfirmDialog } from "@components/ui/confirm-dialog";
import { OpenInCurrent } from "@icons/open-in-current";
import { OpenInTabgroup } from "@icons/open-in-tabgroup";
import { OpenInWindow } from "@icons/open-in-window";
import { RefreshCw, FolderInput, FolderPlus, Share2, Check, Minus } from "lucide-react";
import { useSelection } from "./SelectionContext";
import { useDroppable } from "@dnd-kit/core";
import { useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import type { SpaceMoveOption } from "./TabGroups";
import type { QueryRankDebugScore } from "@src/search-core/contracts";
import {
  resolveToastErrorMessage,
  showErrorToast,
  showSuccessToast,
  withToast,
} from "@src/utils/toast-feedback";

const TAB_PAGE_SIZE = 100;

interface TabGroupProps {
  folder: FolderDocType;
  items: ItemDocType[];
  allFolders: FolderDocType[];
  treeItemCount?: number;
  spaces: SpaceMoveOption[];
  viewMode: "list" | "grid";
  debugScoresByItemId?: Record<string, QueryRankDebugScore>;
  showDebugScores?: boolean;
  onShareSelectedItems?: (itemIds: string[]) => void;
  onShareFolder?: (folderId: string) => void;
  dragMode?: boolean;
  revealItemId?: string;
}

const TabGroupContent = ({
  folder,
  items,
  allFolders,
  treeItemCount,
  spaces,
  viewMode,
  debugScoresByItemId,
  showDebugScores = false,
  onShareFolder,
  dragMode = false,
  revealItemId,
}: TabGroupProps) => {
  const [isCollapsed, setIsCollapsed] = useState(folder.isCollapsed ?? false);
  const [isContentRendered, setIsContentRendered] = useState(!isCollapsed);
  const [isEditingTitle, setIsEditingTitle] = useState(false);
  const [title, setTitle] = useState(folder.name);
  const [copiedItemId, setCopiedItemId] = useState<string | null>(null);
  const [copiedFolderId, setCopiedFolderId] = useState<string | null>(null);
  const [isUpdatingPinned, setIsUpdatingPinned] = useState(false);
  const [isUpdatingLocked, setIsUpdatingLocked] = useState(false);
  const [isPinned, setIsPinned] = useState(folder.isPinned ?? false);
  const [isLocked, setIsLocked] = useState(folder.isLocked ?? false);
  const [isOpenMenu, setIsOpenMenu] = useState(false);
  const [isDeleteDialogOpen, setIsDeleteDialogOpen] = useState(false);
  // Large tab groups paginate (TAB_PAGE_SIZE per page) so we never mount
  // hundreds of heavy item cards at once — keeps rendering snappy.
  const [page, setPage] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!revealItemId || !items.some((item) => item.id === revealItemId)) return;
    // Reveals are explicitly prioritized by TabGroups, so page zero contains
    // the target even when the folder has more than 100 rows.
    setPage(0);
    setIsCollapsed(false);
    setIsContentRendered(true);
  }, [items, revealItemId]);
  const moveSpaceOptions = useMemo(
    () => spaces.filter((space) => space.id !== folder.spaceId),
    [folder.spaceId, spaces],
  );

  const { isSelectionMode, selectedIds, toggleSelectAll } = useSelection();
  const groupAllSelected = items.length > 0 && items.every((i) => selectedIds.has(i.id));
  const groupSomeSelected = !groupAllSelected && items.some((i) => selectedIds.has(i.id));
  const nestedFolderCount = useMemo(() => {
    const folderIds = new Set<string>([folder.id]);
    let changed = true;
    while (changed) {
      changed = false;
      for (const candidate of allFolders) {
        if (
          candidate.parentId &&
          folderIds.has(candidate.parentId) &&
          !folderIds.has(candidate.id)
        ) {
          folderIds.add(candidate.id);
          changed = true;
        }
      }
    }
    return Math.max(0, folderIds.size - 1);
  }, [allFolders, folder.id]);
  const deleteItemCount = treeItemCount ?? items.length;
  const {
    attributes,
    listeners,
    setActivatorNodeRef,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({
    id: folder.id,
    data: { type: "folder", folder },
  });
  const { setNodeRef: setDropRef, isOver } = useDroppable({
    id: `folder-drop-${folder.id}`,
    data: { type: "folder-drop", folderId: folder.id },
  });

  const combinedRef = (node: HTMLElement | null) => {
    setNodeRef(node);
    setDropRef(node);
  };

  const sortableStyle = useMemo(
    () => ({
      transform: CSS.Transform.toString(transform),
      transition,
    }),
    [transform, transition],
  );

  useEffect(() => {
    if (isEditingTitle) {
      inputRef.current?.focus();
      inputRef.current?.select();
    }
  }, [isEditingTitle]);

  const handleCopyFolderUrls = async () => {
    const text = formatTabsForClipboard(
      items.map((item) => ({ title: item.title, url: item.url })),
      getClipboardFormat(),
    );
    if (!text.trim()) {
      showErrorToast("No URLs available to copy.", { tempo: "quick" });
      return;
    }
    try {
      await navigator.clipboard.writeText(text);
      setCopiedFolderId(folder.id);
      setTimeout(() => setCopiedFolderId(null), 5000);
      showSuccessToast("Tab group URLs copied.", { tempo: "quick" });
    } catch (err) {
      console.error("Failed to copy URLs:", err);
      showErrorToast(resolveToastErrorMessage(err, "Failed to copy tab group URLs."));
    }
  };

  const handleRefreshAllMetadata = async () => {
    const urls = items.map((item) => item.url);
    if (urls.length === 0) return;
    try {
      await withToast({
        loading: "Refreshing metadata for tab group...",
        success: "Metadata refresh queued for tab group.",
        error: (err) => resolveToastErrorMessage(err, "Failed to refresh metadata."),
        action: async () => {
          await chrome.runtime.sendMessage({
            target: "background",
            type: "FETCH_METADATA",
            payload: { urls, revalidate: true },
          });
        },
      });
      setIsOpenMenu(false);
    } catch (error) {
      console.error("Failed to refresh metadata for folder", error);
    }
  };

  const togglePinned = async () => {
    if (isUpdatingPinned) return;
    const next = !isPinned;
    setIsPinned(next);
    setIsUpdatingPinned(true);
    try {
      const response = await chrome.runtime.sendMessage({
        service: "folders",
        type: "setPinned",
        target: "offscreen",
        payload: { id: folder.id, value: next },
      });
      if (response?.success === false || response?.payload?.success === false) {
        throw new Error(
          response?.error || response?.payload?.error || "Failed to update pin state",
        );
      }
    } catch (error) {
      console.error("Failed to toggle pin", error);
      setIsPinned(!next);
    } finally {
      setIsUpdatingPinned(false);
    }
  };

  const toggleLocked = async () => {
    if (isUpdatingLocked) return;
    const next = !isLocked;
    setIsLocked(next);
    setIsUpdatingLocked(true);
    try {
      const response = await chrome.runtime.sendMessage({
        service: "folders",
        type: "setLocked",
        target: "offscreen",
        payload: { id: folder.id, value: next },
      });
      if (response?.success === false || response?.payload?.success === false) {
        throw new Error(
          response?.error || response?.payload?.error || "Failed to update lock state",
        );
      }
    } catch (error) {
      console.error("Failed to toggle lock", error);
      setIsLocked(!next);
    } finally {
      setIsUpdatingLocked(false);
    }
  };

  const commitTitle = async () => {
    const trimmed = title.trim().slice(0, 80);
    setTitle(trimmed);
    const response = await chrome.runtime.sendMessage({
      service: "folders",
      type: "rename",
      target: "offscreen",
      payload: { id: folder.id, name: trimmed },
    });
    if (response?.success === false || response?.payload?.success === false) {
      console.error("Failed to rename folder", response?.error);
    }
  };

  useEffect(() => {
    setTitle(folder.name);
    setIsCollapsed(folder.isCollapsed ?? false);
  }, [folder.name, folder.isCollapsed]);

  // Keep subtree mounted long enough for the collapse transition to finish,
  // then unmount to release hundreds of child components/observers when collapsed.
  useEffect(() => {
    if (!isCollapsed) {
      setIsContentRendered(true);
      return;
    }
    const timer = window.setTimeout(() => setIsContentRendered(false), 320);
    return () => window.clearTimeout(timer);
  }, [isCollapsed]);

  useEffect(() => {
    if (!isUpdatingPinned) {
      setIsPinned(folder.isPinned ?? false);
    }
  }, [folder.isPinned, isUpdatingPinned]);

  useEffect(() => {
    if (!isUpdatingLocked) {
      setIsLocked(folder.isLocked ?? false);
    }
  }, [folder.isLocked, isUpdatingLocked]);

  const handleToggleCollapse = async () => {
    const next = !isCollapsed;
    setIsCollapsed(next);
    try {
      const response = await chrome.runtime.sendMessage({
        service: "folders",
        type: "setCollapsed",
        target: "offscreen",
        payload: { id: folder.id, value: next },
      });
      if (response?.success === false || response?.payload?.success === false) {
        throw new Error(
          response?.error || response?.payload?.error || "Failed to update collapsed state",
        );
      }
    } catch (error) {
      console.error("Failed to toggle collapse", error);
      setIsCollapsed(!next);
    }
  };

  const handleItemCopy = useCallback((itemToCopy: ItemDocType) => {
    setCopiedItemId(itemToCopy.id);
    window.setTimeout(() => setCopiedItemId(null), 5000);
  }, []);

  const maybeDeleteFolderAfterOpen = async () => {
    if (isLocked) return;
    try {
      const response = await chrome.runtime.sendMessage({
        service: "folders",
        type: "delete",
        target: "offscreen",
        payload: { id: folder.id, alsoDeleteItems: true },
      });
      if (response?.success === false || response?.payload?.success === false) {
        console.error(
          "Failed to delete folder after open",
          response?.error || response?.payload?.error,
        );
      }
    } catch (e) {
      console.error("Error deleting folder after open", e);
    }
  };

  const handleDeleteGroup = async () => {
    await withToast({
      loading: "Moving tab group to Bin...",
      success: "Tab group moved to Bin.",
      error: (err) => resolveToastErrorMessage(err, "Failed to delete tab group."),
      action: async () => {
        const response = await chrome.runtime.sendMessage({
          service: "folders",
          type: "delete",
          target: "offscreen",
          payload: { id: folder.id, alsoDeleteItems: true },
        });

        if (response?.success === false || response?.payload?.success === false) {
          throw new Error(
            response?.error ||
              response?.payload?.error ||
              "Failed to delete tab group. Please try again.",
          );
        }
      },
    });
  };

  const handleOpenInNewWindow = async () => {
    const urls = items.map((i) => i.url);
    if (urls.length === 0) {
      showErrorToast("No tabs available to open.", { tempo: "quick" });
      return;
    }
    try {
      await withToast({
        loading: "Opening tab group in new window...",
        success: "Tab group opened in new window.",
        error: (err) => resolveToastErrorMessage(err, "Failed to open tab group."),
        action: async () => {
          await openUrlsInNewWindow(urls);
          await maybeDeleteFolderAfterOpen();
        },
      });
    } catch (error) {
      console.error("Failed to open tab group in new window", error);
    } finally {
      setIsOpenMenu(false);
    }
  };

  const handleOpenInCurrentWindow = async () => {
    const urls = items.map((i) => i.url);
    if (urls.length === 0) {
      showErrorToast("No tabs available to open.", { tempo: "quick" });
      return;
    }
    try {
      await withToast({
        loading: "Opening tab group in current window...",
        success: "Tab group opened in current window.",
        error: (err) => resolveToastErrorMessage(err, "Failed to open tab group."),
        action: async () => {
          await openUrlsInCurrentWindow(urls);
          await maybeDeleteFolderAfterOpen();
        },
      });
    } catch (error) {
      console.error("Failed to open tab group in current window", error);
    } finally {
      setIsOpenMenu(false);
    }
  };

  const handleOpenInNewTabGroup = async () => {
    const urls = items.map((i) => i.url);
    if (urls.length === 0) {
      showErrorToast("No tabs available to open.", { tempo: "quick" });
      return;
    }
    try {
      await withToast({
        loading: "Opening tab group in a new tab group...",
        success: "Tab group opened in a new tab group.",
        error: (err) => resolveToastErrorMessage(err, "Failed to open tab group."),
        action: async () => {
          await openUrlsInNewTabGroup(urls, title || folder.name);
          await maybeDeleteFolderAfterOpen();
        },
      });
    } catch (error) {
      console.error("Failed to open tab group in new tab group", error);
    } finally {
      setIsOpenMenu(false);
    }
  };

  const handleMoveFolderToSpace = async (targetSpaceId: string) => {
    try {
      await withToast({
        loading: "Moving tab group to selected space...",
        success: "Tab group moved to selected space.",
        error: (err) => resolveToastErrorMessage(err, "Failed to move tab group."),
        action: async () => {
          const response = await chrome.runtime.sendMessage({
            service: "folders",
            type: "moveToSpace",
            target: "offscreen",
            payload: {
              folderId: folder.id,
              targetSpaceId,
            },
          });
          if (response?.success === false || response?.payload?.success === false) {
            throw new Error(
              response?.error ||
                response?.payload?.error ||
                "Failed to move folder to selected space.",
            );
          }
        },
      });
    } catch (error) {
      console.error("Failed to move folder to selected space", error);
    } finally {
      setIsOpenMenu(false);
    }
  };

  const handleCopyFolderToSpace = async (targetSpaceId: string) => {
    try {
      await withToast({
        loading: "Copying tab group to selected space...",
        success: "Tab group copied to selected space.",
        error: (err) => resolveToastErrorMessage(err, "Failed to copy tab group."),
        action: async () => {
          const response = await chrome.runtime.sendMessage({
            service: "folders",
            type: "copyToSpace",
            target: "offscreen",
            payload: {
              folderId: folder.id,
              targetSpaceId,
            },
          });
          if (response?.success === false || response?.payload?.success === false) {
            throw new Error(
              response?.error ||
                response?.payload?.error ||
                "Failed to copy folder to selected space.",
            );
          }
        },
      });
    } catch (error) {
      console.error("Failed to copy folder to selected space", error);
    } finally {
      setIsOpenMenu(false);
    }
  };

  const pageCount = Math.max(1, Math.ceil(items.length / TAB_PAGE_SIZE));
  useEffect(() => {
    setPage((p) => (p > pageCount - 1 ? pageCount - 1 : p));
  }, [pageCount]);
  const safePage = Math.min(page, pageCount - 1);
  const isPaginated = items.length > TAB_PAGE_SIZE;
  const pagedItems = isPaginated
    ? items.slice(safePage * TAB_PAGE_SIZE, safePage * TAB_PAGE_SIZE + TAB_PAGE_SIZE)
    : items;

  const renderPaginationBar = () => (
    <div className="flex items-center justify-center gap-3">
      <Button
        type="button"
        variant="outline"
        size="sm"
        disabled={safePage === 0}
        onClick={() => setPage(Math.max(0, safePage - 1))}
      >
        Previous
      </Button>
      <span className="text-xs text-foreground-secondary tabular-nums">
        {safePage * TAB_PAGE_SIZE + 1}&ndash;
        {Math.min(items.length, (safePage + 1) * TAB_PAGE_SIZE)} of {items.length}
      </span>
      <Button
        type="button"
        variant="outline"
        size="sm"
        disabled={safePage >= pageCount - 1}
        onClick={() => setPage(Math.min(pageCount - 1, safePage + 1))}
      >
        Next
      </Button>
    </div>
  );

  return (
    <>
      <div
        ref={combinedRef}
        style={sortableStyle}
        className={cn(
          "group/tabgroup flex relative flex-col rounded-xl transition-[box-shadow,opacity] duration-200",
          isDragging ? "opacity-50" : "",
          isOver ? "outline-dashed outline-2 outline-accent/40 outline-offset-4" : "",
        )}
      >
        {/* Pin/Lock controls */}
        <div
          className={cn(
            "absolute right-4 transition-all duration-300 flex flex-row gap-1",
            isCollapsed ? "top-2" : "top-5.5",
            isPinned || isLocked ? "opacity-100" : "opacity-0 group-hover/tabgroup:opacity-100",
          )}
        >
          <div
            onClick={toggleLocked}
            className={cn(
              "cursor-pointer transition-all duration-300",
              isLocked
                ? "text-foreground-icon"
                : "text-foreground-tertiary/60 hover:text-foreground-tertiary",
              isUpdatingLocked && "opacity-60 pointer-events-none",
            )}
          >
            <LockShadowIcon size={28} className="transition-all duration-300" />
          </div>
          <div
            onClick={togglePinned}
            className={cn(
              "cursor-pointer transition-all duration-300",
              isPinned
                ? "text-foreground-icon"
                : "text-foreground-tertiary/60 hover:text-foreground-tertiary",
              isUpdatingPinned && "opacity-60 pointer-events-none",
            )}
          >
            <PinShadowIcon size={28} className="transition-all duration-300" />
          </div>
        </div>

        {/* Header */}
        <div
          className={cn(
            "flex flex-row items-center px-4 py-2 transition-colors duration-300 border border-transparent rounded-semi",
            isCollapsed ? "bg-background-page-secondary border-border-neutral-faded shadow-sm" : "",
          )}
        >
          <div
            ref={setActivatorNodeRef}
            {...listeners}
            {...attributes}
            className={cn(
              "mr-2 flex h-8 w-5 items-center justify-center text-foreground-tertiary",
              "hover:text-foreground-secondary cursor-grab active:cursor-grabbing rounded-sm",
              "transition-colors duration-150",
            )}
            aria-label="Drag tab group"
          >
            <DotIcon size={18} />
          </div>
          <Button
            size="icon"
            variant="outline"
            className={cn("h-6 w-6 rounded-semi")}
            onClick={handleToggleCollapse}
          >
            <ChevronRight
              size={16}
              className={cn(
                "transition-all duration-300 text-foreground-tertiary hover:text-foreground-icon",
                !isCollapsed && "rotate-90",
              )}
            />
          </Button>

          {/* Select all tabs in this group */}
          {items.length > 0 && (
            <button
              type="button"
              onClick={() => toggleSelectAll(items)}
              aria-label={
                groupAllSelected ? "Deselect all tabs in group" : "Select all tabs in group"
              }
              title={groupAllSelected ? "Deselect all in group" : "Select all in group"}
              className={cn(
                "ml-2 grid size-5 shrink-0 place-items-center rounded-md border transition-all duration-150 cursor-pointer",
                groupAllSelected
                  ? "border-accent bg-accent text-background-neutral"
                  : groupSomeSelected
                    ? "border-accent bg-accent/40 text-background-neutral"
                    : "border-border-neutral-faded text-foreground-tertiary hover:border-foreground-tertiary",
                isSelectionMode ? "opacity-100" : "opacity-0 group-hover/tabgroup:opacity-100",
              )}
            >
              {groupAllSelected ? (
                <Check size={12} strokeWidth={3} />
              ) : groupSomeSelected ? (
                <Minus size={12} strokeWidth={3} />
              ) : null}
            </button>
          )}

          {isEditingTitle ? (
            <Input
              ref={inputRef}
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              onBlur={() => {
                setIsEditingTitle(false);
                commitTitle();
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  setIsEditingTitle(false);
                  commitTitle();
                }
              }}
              className="text-foreground-neutral font-semibold text-xl w-fit max-w-[50%] ml-4 h-auto px-2 py-0 transition-transform shadow-none focus-visible:border-2 focus-visible:border-border-neutral bg-transparent"
            />
          ) : (
            <span
              className="text-foreground-neutral font-semibold text-xl max-w-[50%] truncate ml-4 cursor-text"
              onClick={() => setIsEditingTitle(true)}
            >
              {title.length > 40 ? `${title.slice(0, 40)}…` : title}
            </span>
          )}

          <div className="text-foreground-tertiary">
            <DotIcon size={20} />
          </div>

          <span className="text-foreground-secondary text-xs">{items.length} tabs</span>

          <div className="text-foreground-tertiary">
            <DotIcon size={20} />
          </div>

          <span className="text-foreground-secondary text-xs">
            {new Intl.DateTimeFormat(undefined, {
              day: "numeric",
              month: "short",
              year: "numeric",
            }).format(new Date(folder.createdAt))}{" "}
            at{" "}
            {new Intl.DateTimeFormat(undefined, {
              hour: "numeric",
              minute: "numeric",
            }).format(new Date(folder.createdAt))}
          </span>

          <div className="flex flex-row gap-2 text-foreground-tertiary ml-4">
            <div
              onClick={handleCopyFolderUrls}
              className="cursor-pointer hover:text-foreground-secondary transition-all duration-300"
            >
              {copiedFolderId === folder.id ? (
                <Checkmark
                  size={24}
                  className="text-foreground-secondary animate-in fade-in-0 zoom-in-95"
                />
              ) : (
                <CopyIcon />
              )}
            </div>
            <DropdownMenu open={isOpenMenu} onOpenChange={setIsOpenMenu}>
              <DropdownMenuTrigger asChild>
                <div
                  className="cursor-pointer hover:text-foreground-secondary transition-colors duration-300"
                  onContextMenu={(e) => {
                    e.preventDefault();
                    setIsOpenMenu(true);
                  }}
                >
                  <OpenArrowIcon />
                </div>
              </DropdownMenuTrigger>
              <DropdownMenuContent sideOffset={8} className="min-w-[210px]">
                <DropdownMenuItem onClick={handleOpenInCurrentWindow}>
                  <OpenInCurrent />
                  <span>Open in current window</span>
                </DropdownMenuItem>
                <DropdownMenuItem onClick={handleOpenInNewTabGroup}>
                  <OpenInTabgroup />
                  <span>Open in new tab group</span>
                </DropdownMenuItem>
                <DropdownMenuItem onClick={handleOpenInNewWindow}>
                  <OpenInWindow />
                  <span>Open in new window</span>
                </DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuItem onClick={handleRefreshAllMetadata}>
                  <RefreshCw />
                  <span>Refresh all metadata</span>
                </DropdownMenuItem>
                {onShareFolder && (
                  <>
                    <DropdownMenuSeparator />
                    <DropdownMenuItem onClick={() => onShareFolder(folder.id)}>
                      <Share2 />
                      <span>Share tab group…</span>
                    </DropdownMenuItem>
                  </>
                )}
                {moveSpaceOptions.length > 0 && <DropdownMenuSeparator />}
                {moveSpaceOptions.length > 0 && (
                  <DropdownMenuSub>
                    <DropdownMenuSubTrigger>
                      <FolderInput />
                      <span>Move to space</span>
                    </DropdownMenuSubTrigger>
                    <DropdownMenuSubContent className="min-w-[220px]">
                      {moveSpaceOptions.map((space) => {
                        return (
                          <DropdownMenuItem
                            key={`move-${space.id}`}
                            onClick={() => {
                              void handleMoveFolderToSpace(space.id);
                            }}
                          >
                            {space.name}
                          </DropdownMenuItem>
                        );
                      })}
                    </DropdownMenuSubContent>
                  </DropdownMenuSub>
                )}
                {moveSpaceOptions.length > 0 && (
                  <DropdownMenuSub>
                    <DropdownMenuSubTrigger>
                      <FolderPlus />
                      <span>Copy to space</span>
                    </DropdownMenuSubTrigger>
                    <DropdownMenuSubContent className="min-w-[220px]">
                      {moveSpaceOptions.map((space) => {
                        return (
                          <DropdownMenuItem
                            key={`copy-${space.id}`}
                            onClick={() => {
                              void handleCopyFolderToSpace(space.id);
                            }}
                          >
                            {space.name}
                          </DropdownMenuItem>
                        );
                      })}
                    </DropdownMenuSubContent>
                  </DropdownMenuSub>
                )}
              </DropdownMenuContent>
            </DropdownMenu>
            <button
              type="button"
              className={cn(
                "cursor-pointer transition-colors duration-300",
                isLocked
                  ? "text-foreground-tertiary/70 cursor-not-allowed"
                  : "text-foreground-tertiary hover:text-foreground-danger",
              )}
              aria-label={isLocked ? "Unlock to delete" : "Delete tab group"}
              disabled={isLocked}
              onClick={() => {
                if (isLocked) return;
                setIsDeleteDialogOpen(true);
              }}
            >
              <DeleteIcon />
            </button>
          </div>
        </div>

        {/* Content — grid 0fr/1fr trick for smooth animated collapse.
            Inner subtree unmounts after the transition so collapsed groups
            don't keep hundreds of item components/observers alive. */}
        <div
          className={cn(
            "grid transition-[grid-template-rows,opacity] ease-in-out duration-300",
            isCollapsed ? "grid-rows-[0fr] opacity-0" : "grid-rows-[1fr] opacity-100",
          )}
        >
          <div className="overflow-hidden min-h-0">
            {isContentRendered && (
              <div className="flex flex-col gap-2 bg-background-page-secondary w-full mx-auto rounded-semi shadow-sm shadow-foreground-muted/60 pt-2 px-4 pb-4">
                {/* Toolbar */}
                <div className="flex flex-row gap-2">
                  <ExpandingButton
                    icon={<SearchThickIcon size={16} />}
                    placeholder="Search in this tab group"
                  />
                  <AddTabButton folderId={folder.id} />
                </div>

                {isPaginated && (
                  <div className="border-b border-border-neutral-faded/60 pb-3">
                    {renderPaginationBar()}
                  </div>
                )}

                {/* Items */}
                <div className="flex flex-col gap-2">
                  {viewMode === "list" ? (
                    pagedItems.map((item) => {
                      const Row = dragMode ? SortableFlatItem : FlatItem;
                      return (
                        <Row
                          key={item.id}
                          item={item}
                          spaces={spaces}
                          debugScore={showDebugScores ? debugScoresByItemId?.[item.id] : undefined}
                          showDebugScore={showDebugScores}
                          onCopy={handleItemCopy}
                        />
                      );
                    })
                  ) : (
                    <Masonry
                      items={pagedItems}
                      config={{
                        columns: [2, 3, 4],
                        gap: [16, 16, 16],
                        media: [640, 768, 1024],
                      }}
                      render={(item) => {
                        const Card = dragMode ? SortableGridItem : GridItem;
                        return (
                          <Card
                            key={item.id}
                            item={item}
                            spaces={spaces}
                            debugScore={
                              showDebugScores ? debugScoresByItemId?.[item.id] : undefined
                            }
                            showDebugScore={showDebugScores}
                            onCopy={handleItemCopy}
                          />
                        );
                      }}
                    />
                  )}
                </div>
                {items.length === 0 && (
                  <div className="mt-2 rounded-lg border border-dashed border-border-neutral/70 bg-background-neutral p-4 text-center text-sm text-foreground-secondary">
                    Drag tabs here to start this group.
                  </div>
                )}

                {isPaginated && (
                  <div className="mt-3 border-t border-border-neutral-faded/60 pt-3">
                    {renderPaginationBar()}
                  </div>
                )}
              </div>
            )}
          </div>
        </div>

        <ConfirmDialog
          open={isDeleteDialogOpen}
          onOpenChange={setIsDeleteDialogOpen}
          title={isLocked ? "Tab group is locked" : "Move this tab group to Bin?"}
          description={
            isLocked
              ? "Unlock this group before deleting it."
              : `This moves "${title}"${
                  nestedFolderCount > 0
                    ? `, ${nestedFolderCount} nested tab group${nestedFolderCount === 1 ? "" : "s"} or folder${nestedFolderCount === 1 ? "" : "s"},`
                    : ""
                } and ${deleteItemCount} saved tab${deleteItemCount === 1 ? "" : "s"} inside to Bin. They are removed from search and can be recovered from Bin.`
          }
          confirmLabel={isLocked ? "Close" : "Move to Bin"}
          cancelLabel={isLocked ? undefined : "Cancel"}
          variant={isLocked ? "warning" : "danger"}
          isConfirmDisabled={isLocked}
          onConfirm={handleDeleteGroup}
        />
      </div>
    </>
  );
};

export const TabGroup = memo(
  ({
    folder,
    items,
    allFolders,
    treeItemCount,
    spaces,
    viewMode,
    debugScoresByItemId,
    showDebugScores = false,
    onShareSelectedItems,
    onShareFolder,
    dragMode = false,
  }: TabGroupProps) => {
    return (
      <TabGroupContent
        folder={folder}
        items={items}
        allFolders={allFolders}
        treeItemCount={treeItemCount}
        spaces={spaces}
        viewMode={viewMode}
        debugScoresByItemId={debugScoresByItemId}
        showDebugScores={showDebugScores}
        onShareSelectedItems={onShareSelectedItems}
        onShareFolder={onShareFolder}
        dragMode={dragMode}
      />
    );
  },
);
