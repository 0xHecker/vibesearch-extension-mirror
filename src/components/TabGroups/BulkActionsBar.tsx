import { useState } from "react";
import { formatTabsForClipboard, getClipboardFormat } from "@src/pages/search/components/settings/clipboard-format";
import {
  FolderPlus,
  FolderInput,
  Tag,
  Trash2,
  Copy,
  ExternalLink,
  MoreHorizontal,
  Share2,
  X,
  RefreshCw,
  TagsIcon,
  Check,
  Minus,
  ChevronDown,
} from "lucide-react";
import { cn } from "@src/lib/utils";
import { Button } from "@components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubTrigger,
  DropdownMenuSubContent,
} from "@components/ui/dropdown-menu";
import { ConfirmDialog } from "@components/ui/confirm-dialog";
import { TagEditorDialog } from "@components/TabGroups/TagEditorDialog";
import { ItemDocType } from "@src/schemas/item_schema";
import { FolderDocType } from "@src/schemas/folder_schema";
import { useSelection } from "./SelectionContext";
import { OpenInCurrent } from "@icons/open-in-current";
import { OpenInTabgroup } from "@icons/open-in-tabgroup";
import { OpenInWindow } from "@icons/open-in-window";
import type { SpaceMoveOption } from "./TabGroups";
import {
  openUrlsInCurrentWindow,
  openUrlsInNewTabGroup,
  openUrlsInNewWindow,
} from "@src/utils/chromeTabs";
import {
  resolveToastErrorMessage,
  showErrorToast,
  showSuccessToast,
  withToast,
} from "@src/utils/toast-feedback";
import { getVisibleSelectionState } from "@src/pages/search/selection-state";

interface BulkActionsBarProps {
  items?: ItemDocType[];
  folders: FolderDocType[];
  spaces: SpaceMoveOption[];
  activeSpaceId?: string;
  onShareSelectedItems?: (itemIds: string[]) => void;
}

export const BulkActionsBar = ({ items = [], folders, spaces, activeSpaceId, onShareSelectedItems }: BulkActionsBarProps) => {
  const {
    selectedIds,
    selectedCount,
    isSelectionMode,
    toggleSelectAll,
    exitSelectionMode,
    getSelectedItems,
  } = useSelection();

  const [isDeleteDialogOpen, setIsDeleteDialogOpen] = useState(false);
  const [isTagEditorOpen, setIsTagEditorOpen] = useState(false);
  const [isCopied, setIsCopied] = useState(false);
  const [isOpenMenuOpen, setIsOpenMenuOpen] = useState(false);
  const [isMoveMenuOpen, setIsMoveMenuOpen] = useState(false);
  const [isMoreMenuOpen, setIsMoreMenuOpen] = useState(false);

  if (!isSelectionMode) return null;

  const selectedItems = getSelectedItems();
  const selectedItemIds = Array.from(selectedIds);
  const selectedLabel = `${selectedCount} tab${selectedCount === 1 ? "" : "s"}`;
  const { allVisibleSelected, someVisibleSelected } = getVisibleSelectionState(items, selectedIds);

  const assertResponseSuccess = (response: any, fallbackMessage: string) => {
    if (response?.success === false || response?.payload?.success === false) {
      throw new Error(response?.error || response?.payload?.error || fallbackMessage);
    }
  };

  const handleCopy = async () => {
    const text = formatTabsForClipboard(
      selectedItems.map((item) => ({ title: item.title, url: item.url })),
      getClipboardFormat()
    );
    if (!text.trim()) {
      showErrorToast("No URLs available to copy.", { tempo: "quick" });
      return;
    }
    try {
      await navigator.clipboard.writeText(text);
      setIsCopied(true);
      setTimeout(() => setIsCopied(false), 2000);
      showSuccessToast(`Copied ${selectedLabel}.`, { tempo: "quick" });
    } catch (err) {
      console.error("Failed to copy URLs:", err);
      showErrorToast(resolveToastErrorMessage(err, "Failed to copy URLs."));
    }
  };

  const handleDelete = async () => {
    await withToast({
      loading: `Moving ${selectedLabel} to Bin...`,
      success: `Moved ${selectedLabel} to Bin.`,
      error: (err) => resolveToastErrorMessage(err, `Failed to delete ${selectedLabel}.`),
      action: async () => {
        for (const id of selectedItemIds) {
          const response = await chrome.runtime.sendMessage({
            service: "items",
            type: "delete",
            target: "offscreen",
            payload: { id },
          });
          assertResponseSuccess(response, "Failed to delete selected tab.");
        }
      },
    });
    exitSelectionMode();
  };

  const handleMoveToFolder = async (targetFolderId: string) => {
    if (selectedItemIds.length === 0) {
      showErrorToast("Select at least one tab to move.", { tempo: "quick" });
      return;
    }
    try {
      await withToast({
        loading: `Moving ${selectedLabel}...`,
        success: `Moved ${selectedLabel}.`,
        error: (err) => resolveToastErrorMessage(err, "Failed to move selected tabs."),
        action: async () => {
          const response = await chrome.runtime.sendMessage({
            service: "items",
            type: "moveToFolder",
            target: "offscreen",
            payload: {
              targetFolderId,
              itemIds: selectedItemIds,
            },
          });
          assertResponseSuccess(response, "Failed to move selected tabs.");
        },
      });
      exitSelectionMode();
      setIsMoveMenuOpen(false);
    } catch (error) {
      console.error("Failed to move selected tabs to folder", error);
    }
  };

  const handleMoveToSpace = async (targetSpaceId: string) => {
    if (selectedItemIds.length === 0) {
      showErrorToast("Select at least one tab to move.", { tempo: "quick" });
      return;
    }
    try {
      await withToast({
        loading: `Moving ${selectedLabel} to selected space...`,
        success: `Moved ${selectedLabel} to selected space.`,
        error: (err) => resolveToastErrorMessage(err, "Failed to move selected tabs to space."),
        action: async () => {
          const response = await chrome.runtime.sendMessage({
            service: "items",
            type: "moveToSpace",
            target: "offscreen",
            payload: {
              targetSpaceId,
              itemIds: selectedItemIds,
            },
          });
          assertResponseSuccess(response, "Failed to move selected tabs to space.");
        },
      });
      exitSelectionMode();
      setIsMoveMenuOpen(false);
    } catch (error) {
      console.error("Failed to move selected tabs to space", error);
    }
  };

  const handleCreateNewFolder = async () => {
    const folderName = `${selectedCount} tabs - ${new Date().toLocaleDateString()}`;
    if (selectedItemIds.length === 0) {
      showErrorToast("Select at least one tab to move.", { tempo: "quick" });
      return;
    }
    try {
      await withToast({
        loading: "Creating folder and moving tabs...",
        success: `Moved ${selectedLabel} to a new folder.`,
        error: (err) =>
          resolveToastErrorMessage(err, "Failed to create a folder and move selected tabs."),
        action: async () => {
          const createResponse = await chrome.runtime.sendMessage({
            service: "folders",
            type: "create",
            target: "offscreen",
            payload: { name: folderName, userId: "user1", spaceId: activeSpaceId },
          });
          assertResponseSuccess(createResponse, "Failed to create folder.");
          const newFolder = createResponse.payload as FolderDocType;
          const moveResponse = await chrome.runtime.sendMessage({
            service: "items",
            type: "moveToFolder",
            target: "offscreen",
            payload: {
              targetFolderId: newFolder.id,
              itemIds: selectedItemIds,
            },
          });
          assertResponseSuccess(moveResponse, "Failed to move selected tabs.");
        },
      });
      exitSelectionMode();
      setIsMoveMenuOpen(false);
    } catch (error) {
      console.error("Failed to create folder from selection", error);
    }
  };

  const handleOpenInCurrentWindow = async () => {
    const urls = selectedItems.map((i) => i.url);
    if (urls.length === 0) {
      showErrorToast("No tabs available to open.", { tempo: "quick" });
      return;
    }
    try {
      await withToast({
        loading: `Opening ${selectedLabel} in current window...`,
        success: `Opened ${selectedLabel} in current window.`,
        error: (err) => resolveToastErrorMessage(err, "Failed to open tabs."),
        action: async () => openUrlsInCurrentWindow(urls),
      });
      setIsOpenMenuOpen(false);
    } catch (error) {
      console.error("Failed to open tabs in current window", error);
    }
  };

  const handleOpenInNewWindow = async () => {
    const urls = selectedItems.map((i) => i.url);
    if (urls.length === 0) {
      showErrorToast("No tabs available to open.", { tempo: "quick" });
      return;
    }
    try {
      await withToast({
        loading: `Opening ${selectedLabel} in new window...`,
        success: `Opened ${selectedLabel} in new window.`,
        error: (err) => resolveToastErrorMessage(err, "Failed to open tabs."),
        action: async () => openUrlsInNewWindow(urls),
      });
      setIsOpenMenuOpen(false);
    } catch (error) {
      console.error("Failed to open tabs in new window", error);
    }
  };

  const handleOpenInNewTabGroup = async () => {
    const urls = selectedItems.map((i) => i.url);
    if (urls.length === 0) {
      showErrorToast("No tabs available to open.", { tempo: "quick" });
      return;
    }
    try {
      await withToast({
        loading: `Opening ${selectedLabel} in a new tab group...`,
        success: `Opened ${selectedLabel} in a new tab group.`,
        error: (err) => resolveToastErrorMessage(err, "Failed to open tabs."),
        action: async () => openUrlsInNewTabGroup(urls, `${selectedCount} tabs`),
      });
      setIsOpenMenuOpen(false);
    } catch (error) {
      console.error("Failed to open tabs in new tab group", error);
    }
  };

  const handleRefreshMetadata = async () => {
    const urls = selectedItems.map((item) => item.url);
    if (urls.length === 0) {
      showErrorToast("No tabs available to refresh.", { tempo: "quick" });
      return;
    }
    try {
      await withToast({
        loading: `Refreshing metadata for ${selectedLabel}...`,
        success: `Metadata refresh queued for ${selectedLabel}.`,
        error: (err) => resolveToastErrorMessage(err, "Failed to refresh metadata."),
        action: async () => {
          await chrome.runtime.sendMessage({
            target: "background",
            type: "FETCH_METADATA",
            payload: { urls, revalidate: true },
          });
        },
      });
      setIsMoreMenuOpen(false);
    } catch (error) {
      console.error("Failed to refresh metadata for selection", error);
    }
  };

  const handleDeleteTags = async () => {
    if (selectedItemIds.length === 0) {
      showErrorToast("Select at least one tab first.", { tempo: "quick" });
      return;
    }
    try {
      await withToast({
        loading: `Removing tags from ${selectedLabel}...`,
        success: `Removed tags from ${selectedLabel}.`,
        error: (err) => resolveToastErrorMessage(err, "Failed to remove tags."),
        action: async () => {
          for (const item of selectedItems) {
            const res = await chrome.runtime.sendMessage({
              service: "tags",
              type: "getTagsForItem",
              target: "offscreen",
              payload: { itemId: item.id },
            });
            assertResponseSuccess(res, "Failed to load tags for selected tab.");
            const tags = (res.payload as { id: string; name: string }[]) || [];
            for (const tag of tags) {
              const removeResponse = await chrome.runtime.sendMessage({
                service: "tags",
                type: "removeTagFromItem",
                target: "offscreen",
                payload: { itemId: item.id, tagId: tag.id },
              });
              assertResponseSuccess(removeResponse, "Failed to remove a tag from selected tab.");
            }
          }
        },
      });
      setIsMoreMenuOpen(false);
    } catch (error) {
      console.error("Failed to remove tags from selected tabs", error);
    }
  };

  const otherFolders = folders;
  const movableSpaces = spaces;

  return (
    <>
      <div
        className={cn(
          "fixed bottom-6 left-1/2 -translate-x-1/2 z-50",
          "flex items-center gap-1 px-2 py-2",
          "bg-foreground-neutral/95 backdrop-blur-md",
          "rounded-2xl shadow-2xl shadow-black/20",
          "border border-white/10",
          "animate-in slide-in-from-bottom-4 fade-in-0 duration-300"
        )}
      >
        {/* Selection indicator + select-all toggle (over the tabs in view) */}
        {items.length > 0 ? (
          <button
            type="button"
            onClick={() => toggleSelectAll(items)}
            title={allVisibleSelected ? "Deselect all in view" : "Select all in view"}
            className={cn(
              "flex shrink-0 items-center gap-2 px-3 py-1.5 rounded-xl",
              "text-white/90 hover:bg-white/10 transition-colors cursor-pointer"
            )}
          >
            <div
              className={cn(
                "w-5 h-5 rounded-md flex items-center justify-center border-2 transition-colors",
                allVisibleSelected
                  ? "bg-white border-white text-foreground-neutral"
                  : someVisibleSelected
                  ? "bg-white/50 border-white text-foreground-neutral"
                  : "border-white/40"
              )}
            >
              {allVisibleSelected && <Check size={12} strokeWidth={3} />}
              {someVisibleSelected && <Minus size={12} strokeWidth={3} />}
            </div>
            <span className="text-sm font-medium tabular-nums whitespace-nowrap">
              {selectedCount} selected
            </span>
          </button>
        ) : (
          <div className="flex shrink-0 items-center gap-2 px-3 py-1.5 text-white/90">
            <span className="text-sm font-medium tabular-nums whitespace-nowrap">
              {selectedCount} selected
            </span>
          </div>
        )}

        <div className="w-px h-6 bg-white/20 mx-1" />

        {/* Move actions */}
        <DropdownMenu open={isMoveMenuOpen} onOpenChange={setIsMoveMenuOpen}>
          <DropdownMenuTrigger asChild>
            <Button
              variant="ghost"
              size="sm"
              className="text-white/90 hover:text-white hover:bg-white/10 gap-1.5"
            >
              <FolderInput size={16} />
              <span className="hidden sm:inline">Move</span>
              <ChevronDown size={12} />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" className="min-w-[220px]">
            <DropdownMenuItem onClick={handleCreateNewFolder} className="gap-2">
              <FolderPlus size={16} />
              <span>Move to new folder</span>
            </DropdownMenuItem>
            {otherFolders.length > 0 && (
              <>
                <DropdownMenuSeparator />
                <div className="px-2 py-1.5 text-xs font-medium text-foreground-tertiary">
                  Move to existing folder
                </div>
                {otherFolders.map((folder) => (
                  <DropdownMenuItem
                    key={folder.id}
                    onClick={() => handleMoveToFolder(folder.id)}
                    className="gap-2"
                  >
                    <FolderInput size={16} className="text-foreground-tertiary" />
                    <span className="flex-1 truncate">{folder.name}</span>
                  </DropdownMenuItem>
                ))}
              </>
            )}
            {movableSpaces.length > 0 && (
              <>
                <DropdownMenuSeparator />
                <DropdownMenuSub>
                  <DropdownMenuSubTrigger className="gap-2">
                    <FolderInput size={16} />
                    <span>Move to space</span>
                  </DropdownMenuSubTrigger>
                  <DropdownMenuSubContent className="min-w-[220px]">
                    {movableSpaces.map((space) => {
                      return (
                        <DropdownMenuItem
                          key={space.id}
                          onSelect={() => {
                            void handleMoveToSpace(space.id);
                          }}
                          className="gap-2"
                        >
                          <FolderInput size={16} className="text-foreground-tertiary" />
                          <span className="flex-1 truncate">{space.name}</span>
                        </DropdownMenuItem>
                      );
                    })}
                  </DropdownMenuSubContent>
                </DropdownMenuSub>
              </>
            )}
          </DropdownMenuContent>
        </DropdownMenu>

        {/* Add tags */}
        <Button
          variant="ghost"
          size="sm"
          className="text-white/90 hover:text-white hover:bg-white/10 gap-1.5"
          onClick={() => setIsTagEditorOpen(true)}
        >
          <Tag size={16} />
          <span className="hidden sm:inline">Tags</span>
        </Button>

        {/* Delete */}
        <Button
          variant="ghost"
          size="sm"
          className="text-white/90 hover:text-red-400 hover:bg-red-500/10 gap-1.5"
          onClick={() => setIsDeleteDialogOpen(true)}
        >
          <Trash2 size={16} />
          <span className="hidden sm:inline">Delete</span>
        </Button>

        {/* Copy */}
        <Button
          variant="ghost"
          size="sm"
          className="text-white/90 hover:text-white hover:bg-white/10 gap-1.5"
          onClick={handleCopy}
        >
          {isCopied ? <Check size={16} /> : <Copy size={16} />}
          <span className="hidden sm:inline">{isCopied ? "Copied!" : "Copy"}</span>
        </Button>

        {/* Share */}
        {onShareSelectedItems && (
          <Button
            variant="ghost"
            size="sm"
            className="text-white/90 hover:text-white hover:bg-white/10 gap-1.5"
            onClick={() => onShareSelectedItems(selectedItemIds)}
            title="Share selected tabs as a permanent link"
          >
            <Share2 size={16} />
            <span className="hidden sm:inline">Share</span>
          </Button>
        )}

        {/* Open dropdown */}
        <DropdownMenu open={isOpenMenuOpen} onOpenChange={setIsOpenMenuOpen}>
          <DropdownMenuTrigger asChild>
            <Button
              variant="ghost"
              size="sm"
              className="text-white/90 hover:text-white hover:bg-white/10 gap-1.5"
            >
              <ExternalLink size={16} />
              <span className="hidden sm:inline">Open</span>
              <ChevronDown size={12} />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" className="min-w-[200px]">
            <DropdownMenuItem onClick={handleOpenInCurrentWindow} className="gap-2">
              <OpenInCurrent />
              <span>Open in current window</span>
            </DropdownMenuItem>
            <DropdownMenuItem onClick={handleOpenInNewTabGroup} className="gap-2">
              <OpenInTabgroup size={20} />
              <span>Open in new tab group</span>
            </DropdownMenuItem>
            <DropdownMenuItem onClick={handleOpenInNewWindow} className="gap-2">
              <OpenInWindow size={20} />
              <span>Open in new window</span>
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>

        <div className="w-px h-6 bg-white/20 mx-1" />

        {/* More options */}
        <DropdownMenu open={isMoreMenuOpen} onOpenChange={setIsMoreMenuOpen}>
          <DropdownMenuTrigger asChild>
            <Button
              variant="ghost"
              size="icon"
              className="text-white/90 hover:text-white hover:bg-white/10 h-8 w-8"
            >
              <MoreHorizontal size={16} />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="min-w-[180px]">
            <DropdownMenuItem onClick={handleRefreshMetadata} className="gap-2">
              <RefreshCw size={16} />
              <span>Refresh metadata</span>
            </DropdownMenuItem>
            <DropdownMenuItem onClick={handleDeleteTags} className="gap-2 text-foreground-danger">
              <TagsIcon size={16} />
              <span>Remove all tags</span>
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>

        {/* Cancel */}
        <Button
          variant="ghost"
          size="icon"
          className="text-white/60 hover:text-white hover:bg-white/10 h-8 w-8 ml-1"
          onClick={exitSelectionMode}
        >
          <X size={16} />
        </Button>
      </div>

      {/* Delete confirmation dialog */}
      <ConfirmDialog
        open={isDeleteDialogOpen}
        onOpenChange={setIsDeleteDialogOpen}
        title={`Move ${selectedCount} tab${selectedCount !== 1 ? "s" : ""} to Bin?`}
        description={`This moves ${selectedCount} tab${
          selectedCount !== 1 ? "s" : ""
        } to Bin. They are removed from search and can be recovered from Bin.`}
        confirmLabel="Move to Bin"
        variant="danger"
        onConfirm={handleDelete}
      />

      {/* Tag editor dialog */}
      <TagEditorDialog
        itemIds={Array.from(selectedIds)}
        open={isTagEditorOpen}
        onOpenChange={setIsTagEditorOpen}
      />
    </>
  );
};
