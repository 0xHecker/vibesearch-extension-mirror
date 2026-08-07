import { useState, useEffect, memo, type CSSProperties } from "react";
import { formatTabsForClipboard, getClipboardFormat } from "@src/pages/search/components/settings/clipboard-format";
import { CopyIcon } from "@icons/copy";
import { Checkmark } from "@icons/checkmark";
import { OpenArrowIcon } from "@icons/open-arrow";
import { DeleteIcon } from "@icons/delete";
import { Pencil, Star } from "lucide-react";
import { ItemDocType } from "@src/schemas/item_schema";
import { WebIcon } from "@icons/web";
import { EyeOpen } from "@components/icons/eye-open";
import { ConfirmDialog } from "@components/ui/confirm-dialog";
import {
  ContextMenu,
  ContextMenuTrigger,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuSub,
  ContextMenuSubTrigger,
  ContextMenuSubContent,
} from "@components/ui/context-menu";
import { TagEditorDialog } from "@components/TabGroups/TagEditorDialog";
import { TabEditorSheet } from "@components/TabGroups/TabEditorSheet";
import { cn } from "@src/lib/utils";
import { tagChipStyle, tagDotStyle } from "./tag-color";
import { useSelection } from "./SelectionContext";
import { Checkbox } from "@components/ui/checkbox";
import { WebsitePreview } from "./WebsitePreview";
import { useDraggable, useDroppable, type DraggableAttributes, type DraggableSyntheticListeners } from "@dnd-kit/core";
import type { SpaceMoveOption } from "./TabGroups";
import type { QueryRankDebugScore } from "@src/search-core/contracts";
import { appendOcrTextToTextContent } from "@src/services/ocr-text";
import {
  resolveToastErrorMessage,
  showErrorToast,
  showSuccessToast,
  withToast,
} from "@src/utils/toast-feedback";

// Remembers which image URLs have already loaded this session. When a
// virtualized row scrolls out of view it unmounts; on the way back the row
// remounts and would otherwise lazy-load (and visibly flash) its image again.
// For URLs we've seen, we render eagerly so the browser paints from cache
// immediately.
const loadedImageUrls = new Set<string>();
const rememberLoadedImage = (url?: string) => {
  if (url) loadedImageUrls.add(url);
};
const hasLoadedImage = (url?: string): boolean => !!url && loadedImageUrls.has(url);

// Drag props supplied by the optional SortableFlatItem wrapper. When absent,
// the row renders fully static (no dnd-kit hooks), which is the lightweight
// default; dnd-kit is only paid for when the user turns on drag mode.
export type FlatItemSortable = {
  setNodeRef?: (node: HTMLElement | null) => void;
  setActivatorNodeRef?: (node: HTMLElement | null) => void;
  attributes?: DraggableAttributes;
  listeners?: DraggableSyntheticListeners;
  style?: CSSProperties;
  isDragging?: boolean;
  isOver?: boolean;
};

export type FlatItemProps = {
  item: ItemDocType;
  spaces: SpaceMoveOption[];
  debugScore?: QueryRankDebugScore;
  showDebugScore?: boolean;
  onCopy: (item: ItemDocType) => void;
  sortable?: FlatItemSortable;
};

export const FlatItem = memo(({
  item,
  spaces,
  debugScore,
  showDebugScore = false,
  onCopy,
  sortable,
}: FlatItemProps) => {
  const [isCopied, setIsCopied] = useState(false);
  const [isDeleteDialogOpen, setIsDeleteDialogOpen] = useState(false);
  const [isTagEditorOpen, setIsTagEditorOpen] = useState(false);
  const [isPreviewOpen, setIsPreviewOpen] = useState(false);
  const [isEditorOpen, setIsEditorOpen] = useState(false);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [isFavorite, setIsFavorite] = useState(item.isFavorite);
  const [isUpdatingFavorite, setIsUpdatingFavorite] = useState(false);
  const [tags, setTags] = useState<{ id: string; name: string; color?: string | null }[]>([]);

  const { isSelectionMode, isSelected, toggleItem, selectItem } = useSelection();
  const itemIsSelected = isSelected(item.id);
  const isLoading = !item.isMetaFetched || isRefreshing;
  const primaryMediaType = item.media?.[0]?.type;
  const hasImagePreview = !!item.displayImageUrl;
  const mediaCount = (item.media || []).length > 0 ? (item.media || []).length : hasImagePreview ? 1 : 0;
  const hasOcrImage = (item.media || []).some((m) => m?.type === "image") || hasImagePreview;
  const extraMediaCount = Math.max(0, mediaCount - 1);
  const description = appendOcrTextToTextContent(item.textContent, item.ocrText);
  // Drag wiring is supplied only in drag mode (via SortableFlatItem). In the
  // default static mode these are all no-ops, so the row carries no dnd-kit
  // hooks at all.
  const setNodeRef = sortable?.setNodeRef;
  const setActivatorNodeRef = sortable?.setActivatorNodeRef;
  const attributes = sortable?.attributes;
  const listeners = sortable?.listeners;
  const style = sortable?.style;
  const isDragging = sortable?.isDragging ?? false;
  const isOver = sortable?.isOver ?? false;
  const isDraggable = !!sortable;

  // Fetch tags on mount
  useEffect(() => {
    if (!isUpdatingFavorite) {
      setIsFavorite(item.isFavorite);
    }
  }, [item.isFavorite, isUpdatingFavorite]);

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(
        formatTabsForClipboard([{ title: item.title, url: item.url }], getClipboardFormat())
      );
      setIsCopied(true);
      onCopy(item);
      setTimeout(() => setIsCopied(false), 5000);
      showSuccessToast("URL copied.", { tempo: "quick" });
    } catch (err) {
      console.error("Failed to copy URL:", err);
      showErrorToast(resolveToastErrorMessage(err, "Failed to copy URL."));
    }
  };

  const handleDelete = async () => {
    await withToast({
      loading: "Moving tab to Bin...",
      success: "Tab moved to Bin.",
      error: (err) => resolveToastErrorMessage(err, "Failed to delete tab."),
      action: async () => {
        const response = await chrome.runtime.sendMessage({
          service: "items",
          type: "delete",
          target: "offscreen",
          payload: { id: item.id },
        });

        if (response?.success === false || response?.payload?.success === false) {
          throw new Error(
            response?.error || response?.payload?.error || "Failed to delete tab. Please try again."
          );
        }
      },
    });
  };

  const handleMoveToSpace = async (targetSpaceId: string) => {
    try {
      await withToast({
        loading: "Moving tab to selected space...",
        success: "Tab moved to selected space.",
        error: (err) => resolveToastErrorMessage(err, "Failed to move tab to selected space."),
        action: async () => {
          const response = await chrome.runtime.sendMessage({
            service: "items",
            type: "moveToSpace",
            target: "offscreen",
            payload: {
              targetSpaceId,
              itemIds: [item.id],
            },
          });
          if (response?.success === false || response?.payload?.success === false) {
            throw new Error(
              response?.error || response?.payload?.error || "Failed to move tab to selected space."
            );
          }
        },
      });
    } catch (error) {
      console.error("Failed to move tab to selected space", error);
    }
  };

  const moveSpaceOptions = spaces.filter((space) => space.id !== item.spaceId);

  const handleOpen = () => {
    try {
      chrome.tabs.create({ url: item.url, active: true });
    } catch (error) {
      console.error("Failed to open tab", error);
    }
  };

  const handleRefreshMetadata = async () => {
    setIsRefreshing(true);
    try {
      await withToast({
        loading: "Refreshing metadata...",
        success: "Metadata refresh queued.",
        error: (err) => resolveToastErrorMessage(err, "Failed to refresh metadata."),
        action: async () => {
          await chrome.runtime.sendMessage({
            target: "background",
            type: "FETCH_METADATA",
            payload: { urls: [item.url], revalidate: true },
          });
        },
      });
      setTimeout(() => setIsRefreshing(false), 10000);
    } catch (error) {
      console.error("Failed to refresh metadata", error);
      setIsRefreshing(false);
    }
  };

  const handleRerunOcr = async () => {
    await withToast({
      loading: "Re-running OCR…",
      success: "OCR re-run started.",
      error: (err) => resolveToastErrorMessage(err, "Failed to re-run OCR."),
      action: async () => {
        const res = await chrome.runtime.sendMessage({
          target: "background",
          type: "TRIGGER_OCR",
          payload: { itemId: item.id, force: true },
        });
        if (res?.success === false) throw new Error(res?.error || "Failed to re-run OCR.");
      },
    });
  };

  const handleToggleFavorite = async () => {
    if (isUpdatingFavorite) return;
    const next = !isFavorite;
    setIsFavorite(next);
    setIsUpdatingFavorite(true);
    try {
      const res = await chrome.runtime.sendMessage({
        service: "items",
        type: "update",
        target: "offscreen",
        payload: { id: item.id, isFavorite: next },
      });
      if (res?.success === false || res?.payload?.success === false) {
        throw new Error(
          res?.error || res?.payload?.error || "Failed to update favorite."
        );
      }
    } catch (error) {
      console.error("Failed to toggle favorite", error);
      setIsFavorite(!next);
    } finally {
      setIsUpdatingFavorite(false);
    }
  };

  const handleSelect = () => {
    selectItem(item);
  };

  const handleToggleSelect = () => {
    toggleItem(item);
  };

  return (
    <>
      <ContextMenu>
        <ContextMenuTrigger asChild>
          <div
            ref={setNodeRef}
            style={style}
            className={cn(
              "group flex flex-row items-center gap-2 rounded-lg min-h-[32px]",
              isDraggable && "cursor-grab active:cursor-grabbing",
              isDragging && "opacity-40",
              isOver && !isDragging && "outline-dashed outline-2 outline-offset-2 outline-accent/40",
              itemIsSelected && "bg-accent-faded/50"
            )}
          >
            {/* Favorite toggle - always reserved slot, no layout shift */}
            {!isSelectionMode && (
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  handleToggleFavorite();
                }}
                disabled={isUpdatingFavorite}
                aria-label={isFavorite ? "Remove from favorites" : "Add to favorites"}
                aria-pressed={isFavorite}
                className={cn(
                  "flex-shrink-0 w-5 h-5 flex items-center justify-center",
                  "cursor-pointer transition-[color,opacity] duration-300",
                  isFavorite
                    ? "text-accent opacity-100"
                    : "text-foreground-tertiary hover:text-foreground-secondary opacity-0 group-hover:opacity-100"
                )}
              >
                <Star size={14} className={cn(isFavorite && "fill-current")} />
              </button>
            )}

            {/* Row content - drag handle */}
            <div
              ref={setActivatorNodeRef}
              className={cn(
                "flex flex-row gap-4 items-center rounded-lg flex-1 min-w-0",
                isLoading && "opacity-70",
                isDraggable && "cursor-grab active:cursor-grabbing"
              )}
              data-observe="item"
              data-url={item.url}
              data-item-id={item.id}
              {...attributes}
              {...listeners}
            >
            {/* Checkbox - only visible in selection mode */}
            {isSelectionMode && (
              <div
                className="flex-shrink-0"
                onClick={(e) => {
                  e.stopPropagation();
                  handleToggleSelect();
                }}
              >
                <Checkbox
                  checked={itemIsSelected}
                  className={cn(
                    "h-4 w-4 cursor-pointer",
                    itemIsSelected &&
                      "border-accent-secondary bg-accent-secondary text-background-neutral"
                  )}
                />
              </div>
            )}

            <div
              className="flex flex-row gap-2 cursor-pointer flex-1 min-w-0"
              onClick={isSelectionMode ? handleToggleSelect : handleOpen}
            >
              <div
                className={cn(
                  hasImagePreview ? "w-8 h-8 rounded-md" : "w-5 h-5 rounded-sm",
                  "flex-shrink-0 overflow-hidden",
                  isLoading && "animate-pulse"
                )}
              >
                {hasImagePreview ? (
                  <div className="relative w-full h-full">
                    <img
                      src={item.displayImageUrl}
                      alt={item.title}
                      loading={hasLoadedImage(item.displayImageUrl) ? "eager" : "lazy"}
                      decoding="async"
                      className="w-full h-full object-cover rounded-md border border-border-neutral-faded"
                      onLoad={() => rememberLoadedImage(item.displayImageUrl)}
                      onError={(e) => {
                        e.currentTarget.style.display = "none";
                      }}
                    />
                    {extraMediaCount > 0 && (
                      <span className="absolute -right-1 -bottom-1 rounded-full bg-background-neutral/95 border border-border-neutral-faded px-1 text-[9px] font-medium text-foreground-secondary">
                        +{extraMediaCount}
                      </span>
                    )}
                  </div>
                ) : item.iconUrl ? (
                  <img
                    src={item.iconUrl}
                    alt={item.title}
                    className="w-5 h-5 rounded-sm"
                    onError={(e) => {
                      e.currentTarget.style.display = "none";
                    }}
                  />
                ) : (
                  <WebIcon className="w-5 h-5 rounded-sm text-foreground-icon" />
                )}
              </div>
              <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                <div className="flex min-w-0 flex-row items-center gap-2">
                  <span
                    className={cn(
                      "min-w-0 text-foreground-secondary group-hover:text-foreground-neutral transition-colors duration-300 text-sm line-clamp-1",
                      isLoading && "animate-pulse"
                    )}
                  >
                    {item.title}
                  </span>
                  {showDebugScore && debugScore && (
                    <div className="flex items-center gap-1 flex-shrink-0 font-mono text-[10px]">
                      <span className="rounded border border-border-neutral-faded px-1 text-foreground-tertiary">
                        #{debugScore.rank}
                      </span>
                      <span className="rounded border border-border-neutral-faded px-1 text-foreground-tertiary">
                        L {debugScore.lexicalScore.toFixed(3)}
                      </span>
                      <span className="rounded border border-border-neutral-faded px-1 text-foreground-tertiary">
                        V {debugScore.vectorScore.toFixed(3)}
                      </span>
                      <span className="rounded border border-border-neutral-faded px-1 text-foreground-secondary">
                        F {debugScore.fusedScore.toFixed(3)}
                      </span>
                    </div>
                  )}
                  {!hasImagePreview && primaryMediaType && (
                    <span className="px-1.5 py-0.5 rounded text-[10px] uppercase tracking-[0.08em] bg-gray-10 text-foreground-tertiary flex-shrink-0">
                      {primaryMediaType}
                      {extraMediaCount > 0 ? ` +${extraMediaCount}` : ""}
                    </span>
                  )}
                  {tags.length > 0 && (
                    <div className="flex flex-row gap-1 flex-shrink-0">
                      {tags.slice(0, 3).map((t) => (
                        <span
                          key={t.id}
                          style={tagChipStyle(t.color)}
                          className={cn(
                            "inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] text-foreground-tertiary",
                            t.color ? "border" : "bg-gray-10"
                          )}
                        >
                          <span className="size-1 shrink-0 rounded-full" style={tagDotStyle(t.color)} />
                          {t.name}
                        </span>
                      ))}
                      {tags.length > 3 && (
                        <span className="text-[10px] text-foreground-tertiary">+{tags.length - 3}</span>
                      )}
                    </div>
                  )}
                  {isLoading && (
                    <span className="text-xs text-foreground-tertiary italic flex-shrink-0">
                      loading...
                    </span>
                  )}
                </div>
                {description && (
                  <p className="line-clamp-2 whitespace-pre-line text-xs leading-snug text-foreground-tertiary">
                    {description}
                  </p>
                )}
              </div>
            </div>

            {/* Action buttons - hidden in selection mode */}
            {!isSelectionMode && (
              <div className="flex flex-row gap-1 invisible group-hover:visible transition-opacity duration-300 opacity-0 group-hover:opacity-100 text-foreground-tertiary">
                <button
                  type="button"
                  onClick={handleCopy}
                  className="cursor-pointer hover:text-foreground-secondary"
                  aria-label="Copy tab URL"
                >
                  {isCopied ? (
                    <Checkmark
                      size={20}
                      className="text-foreground-secondary animate-in fade-in-0 zoom-in-95"
                    />
                  ) : (
                    <CopyIcon size={20} />
                  )}
                </button>
                <button
                  type="button"
                  className="cursor-pointer hover:text-foreground-secondary transition-colors duration-300"
                  aria-label="Preview"
                  onClick={() => setIsPreviewOpen(true)}
                >
                  <EyeOpen size={20} />
                </button>
                <button
                  type="button"
                  className="cursor-pointer hover:text-foreground-secondary transition-colors duration-300"
                  aria-label="Edit tab"
                  onClick={() => setIsEditorOpen(true)}
                >
                  <Pencil size={18} />
                </button>
                <button
                  type="button"
                  className="cursor-pointer hover:text-foreground-secondary transition-colors duration-300"
                  aria-label="Open tab"
                  onClick={handleOpen}
                >
                  <OpenArrowIcon size={20} />
                </button>
                <button
                  type="button"
                  className="cursor-pointer hover:text-foreground-danger transition-colors duration-300"
                  aria-label="Delete tab"
                  onClick={() => setIsDeleteDialogOpen(true)}
                >
                  <DeleteIcon size={20} />
                </button>
              </div>
            )}
          </div>
          </div>
        </ContextMenuTrigger>

        <ContextMenuContent className="min-w-[170px]">
          <ContextMenuItem onSelect={handleOpen}>Open in new tab</ContextMenuItem>
          <ContextMenuItem onSelect={handleCopy}>Copy URL</ContextMenuItem>
          <ContextMenuItem onSelect={() => setIsEditorOpen(true)}>Edit</ContextMenuItem>
          <ContextMenuItem onSelect={handleRefreshMetadata}>Refresh metadata</ContextMenuItem>
          {hasOcrImage && (
            <ContextMenuItem onSelect={handleRerunOcr}>Re-run OCR</ContextMenuItem>
          )}
          {moveSpaceOptions.length > 0 && <ContextMenuSeparator />}
          {moveSpaceOptions.length > 0 && (
            <ContextMenuSub>
              <ContextMenuSubTrigger>Move to space</ContextMenuSubTrigger>
              <ContextMenuSubContent>
                {moveSpaceOptions.map((space) => {
                  return (
                    <ContextMenuItem
                      key={space.id}
                      onSelect={() => {
                        void handleMoveToSpace(space.id);
                      }}
                    >
                      {space.name}
                    </ContextMenuItem>
                  );
                })}
              </ContextMenuSubContent>
            </ContextMenuSub>
          )}
          <ContextMenuSeparator />
          <ContextMenuItem onSelect={() => setIsDeleteDialogOpen(true)} variant="destructive">
            Delete from group
          </ContextMenuItem>
        </ContextMenuContent>
      </ContextMenu>

      {isTagEditorOpen && (
        <TagEditorDialog
          itemId={item.id}
          open={isTagEditorOpen}
          onOpenChange={setIsTagEditorOpen}
          onTagsUpdate={setTags}
        />
      )}

      {isEditorOpen && (
        <TabEditorSheet
          item={item}
          open={isEditorOpen}
          onOpenChange={setIsEditorOpen}
        />
      )}

      {isPreviewOpen && (
        <WebsitePreview
          url={item.url}
          title={item.title}
          open={isPreviewOpen}
          onOpenChange={setIsPreviewOpen}
          item={item}
        />
      )}

      {isDeleteDialogOpen && (
        <ConfirmDialog
          open={isDeleteDialogOpen}
          onOpenChange={setIsDeleteDialogOpen}
          title="Move this tab to Bin?"
          description={`This moves "${item.title}" from this tab group to Bin. It is removed from search and can be recovered from Bin.`}
          confirmLabel="Move to Bin"
          onConfirm={handleDelete}
          variant="danger"
        />
      )}
    </>
  );
});

// Wraps FlatItem with lightweight drag wiring (useDraggable + useDroppable, not
// useSortable). We don't shift rows on every move — that re-renders many heavy
// rows and felt painfully slow. The source row dims, the hovered row shows a
// dashed drop indicator, and the reorder/move is committed on drop.
export const SortableFlatItem = (props: FlatItemProps) => {
  const { isSelectionMode, selectedIds } = useSelection();
  const data = {
    type: "item" as const,
    item: props.item,
    folderId: props.item.folderId,
    selectedIds: isSelectionMode ? Array.from(selectedIds) : [props.item.id],
  };
  const { attributes, listeners, setNodeRef: setDragRef, isDragging } = useDraggable({
    id: props.item.id,
    data,
  });
  const { setNodeRef: setDropRef, isOver } = useDroppable({ id: props.item.id, data });
  const setNodeRef = (node: HTMLElement | null) => {
    setDragRef(node);
    setDropRef(node);
  };
  return (
    <FlatItem
      {...props}
      sortable={{
        setNodeRef,
        attributes,
        listeners,
        isDragging,
        isOver,
      }}
    />
  );
};
