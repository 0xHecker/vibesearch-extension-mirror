import { ItemDocType } from "@src/schemas/item_schema";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, memo, type CSSProperties } from "react";
import { ImportIcon } from "@icons/import";
import { DotsVertical } from "@icons/dots-vertical";
import { Button } from "../ui/button";
import { Checkbox } from "../ui/checkbox";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubTrigger,
  DropdownMenuSubContent,
  DropdownMenuTrigger,
} from "../ui/dropdown-menu";
import { Tooltip, TooltipTrigger, TooltipContent } from "../ui/tooltip";
import {
  itemCloudSyncLabel,
  useItemCloudSyncState,
} from "./use-item-cloud-sync-state";
import { ConfirmDialog } from "@components/ui/confirm-dialog";
import { EyeOpen } from "@components/icons/eye-open";
import { DeleteIcon } from "../icons/delete";
import { cn } from "@src/lib/utils";
import { tagChipStyle, tagDotStyle } from "./tag-color";
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
import { MediaLightboxModal, type LightboxEntry, type LightboxMetadata } from "@components/TabGroups/MediaLightboxModal";
import {
  MorphingDialog,
  MorphingDialogTrigger,
} from "@components/ui/morphing-dialog";
import {
  Star,
  Maximize2,
  CloudCheck as CloudCheckIcon,
  CloudUpload as CloudUploadIcon,
  CloudOff as CloudOffIcon,
} from "lucide-react";
import { useSelection } from "./SelectionContext";
import { WebsitePreview } from "./WebsitePreview";
import { ItemMediaPreview } from "./ItemMediaPreview";
import { ObjectUrlOwner, resolveOpfsMedia } from "@src/services/media-storage";
import { useDraggable, useDroppable, type DraggableAttributes, type DraggableSyntheticListeners } from "@dnd-kit/core";
import type { SpaceMoveOption } from "./TabGroups";
import type { QueryRankDebugScore } from "@src/search-core/contracts";
import { resolveToastErrorMessage, withToast, showSuccessToast, showErrorToast } from "@src/utils/toast-feedback";
import { formatTabsForClipboard, getClipboardFormat } from "@src/pages/search/components/settings/clipboard-format";
import { getYouTubeVideoIdFromUrl, normalizeIframeEmbedUrl } from "@src/utils/media-embed";
import { appendOcrTextToTextContent } from "@src/services/ocr-text";

// Drag wiring supplied by the optional SortableGridItem wrapper. When absent,
// the card renders fully static (no dnd-kit hooks) — the lightweight default.
// dnd-kit is only paid for in Organize (drag) mode.
export type GridItemSortable = {
  setNodeRef?: (node: HTMLElement | null) => void;
  setActivatorNodeRef?: (node: HTMLElement | null) => void;
  attributes?: DraggableAttributes;
  listeners?: DraggableSyntheticListeners;
  style?: CSSProperties;
  isDragging?: boolean;
  isOver?: boolean;
};

export type GridItemProps = {
  item: ItemDocType;
  spaces: SpaceMoveOption[];
  debugScore?: QueryRankDebugScore;
  showDebugScore?: boolean;
  onCopy: (item: ItemDocType) => void;
  sortable?: GridItemSortable;
};

export const GridItem = memo(({
  item,
  spaces,
  debugScore,
  showDebugScore = false,
  onCopy,
  sortable,
}: GridItemProps) => {
  const textRef = useRef<HTMLParagraphElement>(null);
  const [isExpanded, setIsExpanded] = useState(false);
  const [isOverflowing, setIsOverflowing] = useState(false);
  const [heights, setHeights] = useState({ collapsed: 0, expanded: 0 });
  const [isDeleteDialogOpen, setIsDeleteDialogOpen] = useState(false);
  const [deleteScope, setDeleteScope] = useState<"current" | "all">("current");
  const [isMenuOpen, setIsMenuOpen] = useState(false);
  const [isTagEditorOpen, setIsTagEditorOpen] = useState(false);
  const [isEditorOpen, setIsEditorOpen] = useState(false);
  const [isPreviewOpen, setIsPreviewOpen] = useState(false);
  const [lightboxEntries, setLightboxEntries] = useState<LightboxEntry[]>([]);
  const lightboxUrlOwnerRef = useRef<ObjectUrlOwner | null>(null);
  const [isFavorite, setIsFavorite] = useState(item.isFavorite);
  const [isUpdatingFavorite, setIsUpdatingFavorite] = useState(false);
  const [tags, setTags] = useState<{ id: string; name: string; color?: string | null }[]>([]);
  const [isRefreshing, setIsRefreshing] = useState(false);

  const { isSelectionMode, isSelected, toggleItem, selectItem } = useSelection();
  const itemIsSelected = isSelected(item.id);
  // Only asked for once the card is hovered, so a long grid costs nothing.
  const [syncStateWanted, setSyncStateWanted] = useState(false);
  const cloudSyncState = useItemCloudSyncState(item.id, syncStateWanted);
  const isLoading = !item.isMetaFetched || isRefreshing;
  const description = useMemo(
    () => appendOcrTextToTextContent(item.textContent, item.ocrText),
    [item.textContent, item.ocrText]
  );
  const hasOcrImage = (item.media || []).some((m) => m?.type === "image") || !!item.displayImageUrl;
  // Drag wiring is present only in Organize mode (via SortableGridItem). In the
  // default static mode these are all undefined/no-ops, so the card carries no
  // dnd-kit hooks at all and clicks/links/buttons behave normally.
  const setNodeRef = sortable?.setNodeRef;
  const attributes = sortable?.attributes;
  const listeners = sortable?.listeners;
  const style = sortable?.style;
  const isDragging = sortable?.isDragging ?? false;
  const isOver = sortable?.isOver ?? false;
  const isDraggable = !!sortable;

  const handleMenuOpenChange = (open: boolean) => {
    setIsMenuOpen(open);
  };

  const handleSelect = () => {
    selectItem(item);
  };

  const handleToggleSelect = () => {
    toggleItem(item);
  };

  const handleCopyUrl = async () => {
    try {
      await navigator.clipboard.writeText(
        formatTabsForClipboard([{ title: item.title, url: item.url }], getClipboardFormat())
      );
      onCopy(item);
      showSuccessToast("URL copied.", { tempo: "quick" });
    } catch (err) {
      console.error("Failed to copy URL:", err);
      showErrorToast(resolveToastErrorMessage(err, "Failed to copy URL."));
    }
  };

  const renderMenu = () => (
    <DropdownMenu open={isMenuOpen} onOpenChange={handleMenuOpenChange}>
      <DropdownMenuTrigger asChild>
        <Button
          size="icon"
          variant="ghost"
          className="w-6 h-6"
          aria-label="Item actions"
          onClick={() => setIsMenuOpen(true)}
        >
          <DotsVertical size={14} />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent sideOffset={4} align="start" className="min-w-[180px]">
        <DropdownMenuItem
          onSelect={() => {
            try {
              chrome.tabs.create({ url: item.url, active: true });
            } catch (error) {
              console.error("Failed to open tab", error);
            }
          }}
        >
          Open in new tab
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={handleCopyUrl}>Copy URL</DropdownMenuItem>
        <DropdownMenuItem onSelect={() => setIsEditorOpen(true)}>Edit</DropdownMenuItem>
        <DropdownMenuItem onSelect={handleRefreshMetadata}>Refresh metadata</DropdownMenuItem>
        {hasOcrImage && (
          <DropdownMenuItem onSelect={handleRerunOcr}>Re-run OCR</DropdownMenuItem>
        )}
        {moveSpaceOptions.length > 0 && <DropdownMenuSeparator />}
        {moveSpaceOptions.length > 0 && (
          <DropdownMenuSub>
            <DropdownMenuSubTrigger>Move to space</DropdownMenuSubTrigger>
            <DropdownMenuSubContent>
              {moveSpaceOptions.map((space) => (
                <DropdownMenuItem
                  key={space.id}
                  onSelect={() => {
                    void handleMoveToSpace(space.id);
                  }}
                >
                  {space.name}
                </DropdownMenuItem>
              ))}
            </DropdownMenuSubContent>
          </DropdownMenuSub>
        )}
        {moveSpaceOptions.length > 0 && (
          <DropdownMenuSub>
            <DropdownMenuSubTrigger>Copy to space</DropdownMenuSubTrigger>
            <DropdownMenuSubContent>
              {moveSpaceOptions.map((space) => (
                <DropdownMenuItem
                  key={space.id}
                  onSelect={() => {
                    void handleCopyToSpace(space.id);
                  }}
                >
                  {space.name}
                </DropdownMenuItem>
              ))}
            </DropdownMenuSubContent>
          </DropdownMenuSub>
        )}
        <DropdownMenuSeparator />
        <DropdownMenuItem
          variant="destructive"
          onSelect={() => {
            setDeleteScope("current");
            setIsDeleteDialogOpen(true);
          }}
        >
          Delete from group
        </DropdownMenuItem>
        <DropdownMenuItem
          variant="destructive"
          onSelect={() => {
            setDeleteScope("all");
            setIsDeleteDialogOpen(true);
          }}
        >
          Delete everywhere
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );

  const recomputeHeights = useCallback(() => {
    const el = textRef.current;
    if (!el) return;
    const computedStyles = window.getComputedStyle(el);
    const lineHeight = parseFloat(computedStyles.lineHeight || "0") || 0;
    const collapsed = lineHeight > 0 ? lineHeight * 5 : el.clientHeight;
    const expanded = el.scrollHeight;
    setHeights({ collapsed, expanded });
    setIsOverflowing(expanded - collapsed > 6);
  }, []);

  useLayoutEffect(() => {
    recomputeHeights();
  }, [description, recomputeHeights]);

  useEffect(() => {
    if (!isUpdatingFavorite) {
      setIsFavorite(item.isFavorite);
    }
  }, [item.isFavorite, isUpdatingFavorite]);

  useEffect(() => {
    const el = textRef.current;
    if (!el) return;
    const observer = new ResizeObserver(() => {
      window.requestAnimationFrame(recomputeHeights);
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, [recomputeHeights]);

  useEffect(() => {
    setIsExpanded(false);
    return () => {
      lightboxUrlOwnerRef.current?.dispose();
      lightboxUrlOwnerRef.current = null;
    };
  }, [item.id]);

  const handleOpenLightbox = useCallback(async (): Promise<boolean> => {
    lightboxUrlOwnerRef.current?.dispose();
    const urlOwner = new ObjectUrlOwner();
    lightboxUrlOwnerRef.current = urlOwner;
    const entries: LightboxEntry[] = [];
    const seen = new Set<string>();
    const isYouTube =
      item.source === "youtube" ||
      !!getYouTubeVideoIdFromUrl(item.url) ||
      (item.media || []).some((m) =>
        [m.embedUrl, m.originalUrl, m.pageUrl, m.s3ThumbnailUrl, m.thumbnailUrl]
          .filter(Boolean)
          .some((url) => !!url && !!getYouTubeVideoIdFromUrl(url))
      );
    const add = (e: LightboxEntry) => {
      if (seen.has(e.src)) return;
      seen.add(e.src);
      entries.push(e);
    };
    for (const m of item.media || []) {
      // File attachments are synced and preserved, but this lightbox only
      // renders visual/audio media. Keep its existing presentation contract.
      if (m.type === "file") continue;
      let src: string | null = null;
      let embedType: LightboxEntry["embedType"];
      if (m.type === "video" && m.embedUrl) {
        src = normalizeIframeEmbedUrl(m.embedUrl);
        if (src) embedType = m.embedType || "iframe";
      }
      if (m.opfsPath) {
        src = urlOwner.own(await resolveOpfsMedia(m.opfsPath));
        if (!urlOwner.isActive || lightboxUrlOwnerRef.current !== urlOwner) return false;
      }
      if (!src) src = m.s3Url || m.originalUrl;
      if (!src) continue;
      const isVertical = (() => {
        if (m.width && m.height && m.height > m.width) return true;
        if (item.source === "tiktok") return true;
        const checkUrls = [item.url, m.originalUrl, m.pageUrl].filter(Boolean) as string[];
        for (const u of checkUrls) {
          const lower = u.toLowerCase();
          if (lower.includes("/shorts/")) return true;
          if (lower.includes("/reel/") || lower.includes("/reels/")) return true;
          if (lower.includes("tiktok.com")) return true;
        }
        return false;
      })();
      add({
        type: m.type,
        src,
        embedType,
        thumbnailSrc: m.s3ThumbnailUrl || m.thumbnailUrl,
        width: m.width,
        height: m.height,
        altText: m.altText,
        isGif: src.toLowerCase().endsWith(".gif"),
        isVertical,
        ocr: m.ocr,
      });
    }
    if (
      item.displayImageUrl &&
      !seen.has(item.displayImageUrl)
    ) {
      entries.push({
        type: "image",
        src: item.displayImageUrl,
        altText: "Legacy display image",
        isGif: item.displayImageUrl.toLowerCase().endsWith(".gif"),
      });
    }
    if (isYouTube) {
      entries.sort((a, b) => {
        const aEmbedVideo = a.type === "video" && a.embedType === "iframe";
        const bEmbedVideo = b.type === "video" && b.embedType === "iframe";
        if (aEmbedVideo === bEmbedVideo) return 0;
        return aEmbedVideo ? -1 : 1;
      });
    }
    if (!urlOwner.isActive || lightboxUrlOwnerRef.current !== urlOwner) return false;
    if (entries.length > 0) {
      setLightboxEntries(entries);
      return true;
    }
    urlOwner.dispose();
    if (lightboxUrlOwnerRef.current === urlOwner) lightboxUrlOwnerRef.current = null;
    return false;
  }, [item.displayImageUrl, item.media, item.source, item.url]);

  const lightboxMetadata: LightboxMetadata | undefined = useMemo(() => {
    if (!item) return undefined;
    let hostname: string | undefined;
    try { hostname = new URL(item.url).hostname; } catch { hostname = item.url; }
    return {
      title: item.title,
      hostname,
      url: item.url,
      iconUrl: item.iconUrl,
      source: item.source,
      date: new Intl.DateTimeFormat(undefined, { day: "numeric", month: "short", year: "numeric" }).format(new Date(item.createdAt)),
    };
  }, [item]);

  const displayHeight = useMemo(() => {
    if (!heights.expanded) return undefined;
    const target = isExpanded ? heights.expanded : heights.collapsed;
    return `${Math.ceil(target + 8)}px`;
  }, [heights, isExpanded]);

  const toggleExpansion = () => {
    if (!isOverflowing) return;
    setIsExpanded((prev) => !prev);
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

  const handleCopyToSpace = async (targetSpaceId: string) => {
    try {
      await withToast({
        loading: "Copying tab to selected space...",
        success: "Tab copied to selected space.",
        error: (err) => resolveToastErrorMessage(err, "Failed to copy tab to selected space."),
        action: async () => {
          const response = await chrome.runtime.sendMessage({
            service: "items",
            type: "copyToSpace",
            target: "offscreen",
            payload: {
              targetSpaceId,
              itemIds: [item.id],
            },
          });
          if (response?.success === false || response?.payload?.success === false) {
            throw new Error(
              response?.error || response?.payload?.error || "Failed to copy tab to selected space."
            );
          }
        },
      });
    } catch (error) {
      console.error("Failed to copy tab to selected space", error);
    }
  };

  const moveSpaceOptions = spaces.filter((space) => space.id !== item.spaceId);

  return (
    <MorphingDialog>
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <div
          ref={setNodeRef}
          style={style}
          className={cn(
            "group/card max-w-[350px] rounded-semi shadow-card relative transition-all duration-200",
            isLoading && "opacity-80",
            itemIsSelected ? "bg-violet-500/10 ring-2 ring-violet-500/40" : "bg-platinum",
            isDraggable && "cursor-grab active:cursor-grabbing",
            isDragging && "opacity-40",
            isOver &&
              !isDragging &&
              "outline-dashed outline-2 outline-offset-2 outline-accent/40"
          )}
          data-observe="item"
          data-url={item.url}
          data-item-id={item.id}
          {...attributes}
          {...listeners}
        >
          {/* Selection checkbox - visible on hover or in selection mode */}
          <div
            className={cn(
              "absolute left-4 top-4 z-20 transition-opacity duration-200",
              isSelectionMode || itemIsSelected
                ? "opacity-100"
                : "opacity-0 group-hover/card:opacity-100"
            )}
          >
            <div className="relative">
              <Checkbox
                className={cn(
                  "size-4 rounded-[6px] bg-background-neutral text-foreground-neutral shadow-sm transition-all duration-200",
                  "border border-border-neutral-faded cursor-pointer shadow-sm",
                  "data-[state=checked]:border-accent-secondary data-[state=checked]:bg-accent-secondary data-[state=checked]:text-background-neutral",
                  "focus-visible:ring-2 focus-visible:ring-border-neutral/80 focus-visible:ring-offset-1"
                )}
                checked={itemIsSelected}
                onCheckedChange={() => handleToggleSelect()}
                aria-label="Select tab card"
              />
              {/* Invisible expanded click area for better UX */}
              <div
                className="absolute -left-1 -top-1 -right-4 -bottom-4 cursor-pointer"
                onClick={(e) => {
                  e.stopPropagation();
                  handleToggleSelect();
                }}
                aria-label="Select tab card"
                aria-hidden="true"
              />
            </div>
          </div>

          {/* Action buttons */}
          <div
            className={cn(
              "absolute right-3 top-3 z-20 flex items-center gap-2 text-foreground-tertiary transition-all duration-200",
              "opacity-0 group-hover/card:opacity-100"
            )}
            onMouseEnter={() => setSyncStateWanted(true)}
            onFocus={() => setSyncStateWanted(true)}
          >
            {cloudSyncState !== "unknown" && (
              <Tooltip>
                <TooltipTrigger asChild>
                  <span
                    aria-label={itemCloudSyncLabel(cloudSyncState)}
                    className={cn(
                      "flex size-5 items-center justify-center",
                      cloudSyncState === "synced" && "text-foreground-positive",
                      cloudSyncState === "pending" && "text-foreground-warning",
                      cloudSyncState === "not-connected" && "text-foreground-tertiary",
                    )}
                  >
                    {cloudSyncState === "synced" ? (
                      <CloudCheckIcon size={16} />
                    ) : cloudSyncState === "pending" ? (
                      <CloudUploadIcon size={16} />
                    ) : (
                      <CloudOffIcon size={16} />
                    )}
                  </span>
                </TooltipTrigger>
                <TooltipContent>{itemCloudSyncLabel(cloudSyncState)}</TooltipContent>
              </Tooltip>
            )}
            <Button
              variant={"ghost"}
              className="size-5 p-1 text-foreground-tertiary transition-colors duration-300 hover:bg-transparent hover:text-accent"
              aria-label={isFavorite ? "Remove from favorites" : "Add to favorites"}
              aria-pressed={isFavorite}
              onClick={handleToggleFavorite}
              disabled={isUpdatingFavorite}
            >
              <Star size={20} className={cn(isFavorite && "fill-current")} />
            </Button>
            <Button
              variant={"ghost"}
              className="size-5 p-1"
              aria-label="View archived copy"
              title="View archived copy"
              onClick={() => setIsPreviewOpen(true)}
            >
              <EyeOpen size={20} />
            </Button>
            <Button
              variant={"ghost"}
              className="size-5 p-1 text-foreground-tertiary transition-colors duration-300 hover:bg-transparent hover:text-foreground-danger"
              aria-label="Delete tab"
              onClick={() => {
                setDeleteScope("current");
                setIsDeleteDialogOpen(true);
              }}
            >
              <DeleteIcon size={20} />
            </Button>
          </div>

          <div className="flex flex-col gap-1 p-3 rounded-semi overflow-hidden bg-background-neutral">
            <MorphingDialogTrigger
              onOpen={handleOpenLightbox}
              className="relative group/media-preview rounded-sm-semi"
            >
              <ItemMediaPreview item={item} />
              {/* Subtle expand button — visual affordance; click bubbles to the
                  trigger which runs onOpen (prep) then opens the morph dialog. */}
              {(item.media?.length || 0) > 0 || item.displayImageUrl ? (
                <button
                  type="button"
                  aria-label="Expand media"
                  title="Expand"
                  className={cn(
                    "absolute top-2 right-2 z-10 w-7 h-7 rounded-full",
                    "flex items-center justify-center",
                    "bg-background-neutral/85 backdrop-blur-sm",
                    "border border-border-neutral-faded/60",
                    "text-foreground-secondary hover:text-foreground-primary hover:bg-background-neutral",
                    "opacity-0 group-hover/media-preview:opacity-100",
                    "transition-all duration-200 active:scale-[0.92] cursor-pointer"
                  )}
                >
                  <Maximize2 size={13} />
                </button>
              ) : null}
              {/* Media count pill — only when multiple media, hover-revealed */}
              {(item.media?.length || 0) > 1 && (
                <span className={cn(
                  "absolute bottom-2 right-2 z-10 px-2 py-0.5 rounded-full",
                  "bg-background-neutral/90 backdrop-blur-sm",
                  "text-[10px] font-medium text-foreground-secondary tabular-nums",
                  "opacity-0 group-hover/media-preview:opacity-100 transition-opacity duration-200 pointer-events-none"
                )}>
                  {item.media?.length} media
                </span>
              )}
            </MorphingDialogTrigger>
            <div className="flex flex-col gap-2">
              <div className="flex flex-col gap-1">
                <h3
                  title={item.title}
                  className="text-foreground-neutral text-2xl leading-7 font-medium font-serif italic break-all line-clamp-2"
                >
                  {item.title}
                </h3>
                {showDebugScore && debugScore && (
                  <div className="flex flex-wrap items-center gap-1 font-mono text-[10px]">
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
                <div className="relative">
                  <p
                    ref={textRef}
                    className="font-sans text-xs text-foreground-secondary leading-relaxed transition-[max-height] duration-500 ease-out overflow-hidden"
                    style={{ maxHeight: displayHeight }}
                  >
                    {description}
                  </p>
                  {!isExpanded && isOverflowing && (
                    <div className="pointer-events-none absolute inset-x-0 bottom-0 h-10 bg-gradient-to-b from-transparent via-background-neutral/60 to-background-neutral" />
                  )}
                </div>
                {isOverflowing && (
                  <button
                    type="button"
                    onClick={toggleExpansion}
                    className="self-start flex items-center gap-2 text-xs font-medium uppercase tracking-[0.16em] cursor-pointer text-foreground-neutral hover:text-foreground focus:outline-none focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:ring-foreground/40 transition-colors"
                  >
                    {isExpanded ? "Show less" : "Show more"}
                    <span
                      className={`inline-block h-[1px] w-6 transition-transform duration-500 ease-out ${
                        isExpanded ? "scale-x-50" : "scale-x-100"
                      } bg-current`}
                    />
                  </button>
                )}
                <span className="text-xs text-foreground-secondary">
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <button
                        type="button"
                        className="flex flex-row items-center justify-between gap-1 text-left cursor-pointer hover:text-foreground hover:underline-offset-2 leading-none"
                        onClick={() => {
                          try {
                            chrome.tabs.create({ url: item.url, active: true });
                          } catch (error) {
                            console.error("Failed to open url", error);
                          }
                        }}
                      >
                        {item.iconUrl && (
                          <img
                            src={item.iconUrl}
                            alt=""
                            className="h-3 w-3 rounded-sm object-contain flex-shrink-0"
                            onError={(e) => {
                              e.currentTarget.style.display = "none";
                            }}
                          />
                        )}
                        <div>
                          {(() => {
                            try {
                              return new URL(item.url).hostname;
                            } catch {
                              return item.url;
                            }
                          })()}
                        </div>
                      </button>
                    </TooltipTrigger>
                    <TooltipContent className="max-w-xs break-words">{item.url}</TooltipContent>
                  </Tooltip>
                </span>
              </div>

              <div className="flex flex-row items-center justify-between gap-2">
                <div className="flex flex-row items-center gap-2">
                  <div
                    className={cn(
                      "flex flex-row gap-1 w-fit px-2 py-0.5 rounded-md font-sans text-xs items-center",
                      isLoading ? "bg-amber-100 animate-pulse" : "bg-tea-green"
                    )}
                  >
                    <div>
                      <ImportIcon size={16} />
                    </div>
                    <span className="text-foreground-secondary">
                      {isLoading ? "loading..." : "imported"}
                    </span>
                  </div>

                  <span className="text-foreground-secondary font-sans font-medium text-xs whitespace-nowrap">
                    {new Intl.DateTimeFormat(undefined, {
                      day: "numeric",
                      month: "short",
                    }).format(new Date(item.createdAt))}
                    {", "}
                    {new Intl.DateTimeFormat(undefined, {
                      hour: "numeric",
                      minute: "numeric",
                    }).format(new Date(item.createdAt))}
                  </span>
                </div>
                {renderMenu()}
              </div>
            </div>
          </div>
          {(isFavorite || tags.length > 0) && (
            <div className="flex flex-row flex-wrap gap-1 rounded-semi px-2 py-1">
              {isFavorite && (
                <div
                  className={cn(
                    "inline-flex items-center gap-1 rounded-md w-fit px-2 py-0.5",
                    "bg-accent-faded text-accent text-xs font-medium"
                  )}
                  title="Favorite"
                >
                  <Star size={11} className="fill-current" />
                </div>
              )}
              {tags.map((t) => (
                <div
                  key={t.id}
                  style={tagChipStyle(t.color)}
                  className={cn(
                    "flex w-fit items-center gap-1 rounded-md border px-2 text-xs text-foreground-secondary transition-all",
                    t.color ? "" : "border-transparent bg-gray-10 hover:bg-gray-40"
                  )}
                >
                  <span className="size-1.5 shrink-0 rounded-full" style={tagDotStyle(t.color)} />
                  {t.name}
                </div>
              ))}
            </div>
          )}
        </div>
      </ContextMenuTrigger>

      <ContextMenuContent className="min-w-[170px]">
        <ContextMenuItem
          onSelect={() => {
            try {
              chrome.tabs.create({ url: item.url, active: true });
            } catch (error) {
              console.error("Failed to open tab", error);
            }
          }}
        >
          Open in new tab
        </ContextMenuItem>
        <ContextMenuItem onSelect={handleCopyUrl}>Copy URL</ContextMenuItem>
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
        <ContextMenuItem
          onSelect={() => {
            setDeleteScope("current");
            setIsDeleteDialogOpen(true);
          }}
          variant="destructive"
        >
          Delete from group
        </ContextMenuItem>
        <ContextMenuItem
          onSelect={() => {
            setDeleteScope("all");
            setIsDeleteDialogOpen(true);
          }}
          variant="destructive"
        >
          Delete everywhere
        </ContextMenuItem>
      </ContextMenuContent>
      {isDeleteDialogOpen && (
        <ConfirmDialog
          open={isDeleteDialogOpen}
          onOpenChange={setIsDeleteDialogOpen}
          title={
            deleteScope === "all" ? "Move this tab to Bin everywhere?" : "Move this tab to Bin?"
          }
          description={
            deleteScope === "all"
              ? `This moves "${item.title}" to Bin from every tab group. It is removed from search and can be recovered from Bin.`
              : `This moves "${item.title}" from this tab group to Bin. It is removed from search and can be recovered from Bin.`
          }
          confirmLabel="Move to Bin"
          variant="danger"
          onConfirm={async () => {
            await withToast({
              loading: "Moving tab to Bin...",
              success:
                deleteScope === "all" ? "Tab moved to Bin from all groups." : "Tab moved to Bin.",
              error: (err) => resolveToastErrorMessage(err, "Failed to delete tab."),
              action: async () => {
                const response = await chrome.runtime.sendMessage({
                  service: "items",
                  type: "delete",
                  target: "offscreen",
                  payload: { id: item.id, scope: deleteScope },
                });

                if (response?.success === false || response?.payload?.success === false) {
                  throw new Error(
                    response?.error ||
                      response?.payload?.error ||
                      "Failed to delete tab. Please try again."
                  );
                }
              },
            });
          }}
        />
      )}
      {isTagEditorOpen && (
        <TagEditorDialog
          itemId={item.id}
          open={isTagEditorOpen}
          onOpenChange={setIsTagEditorOpen}
          onTagsUpdate={setTags}
        />
      )}
      <TabEditorSheet
        item={item}
        open={isEditorOpen}
        onOpenChange={setIsEditorOpen}
      />
      {isPreviewOpen && (
        <WebsitePreview
          url={item.url}
          title={item.title}
          open={isPreviewOpen}
          onOpenChange={setIsPreviewOpen}
          item={item}
        />
      )}
      <MediaLightboxModal
        entries={lightboxEntries}
        metadata={lightboxMetadata}
        onClose={() => {
          lightboxUrlOwnerRef.current?.dispose();
          lightboxUrlOwnerRef.current = null;
          setLightboxEntries([]);
        }}
      />
    </ContextMenu>
    </MorphingDialog>
  );
});

// Wraps GridItem with lightweight drag wiring. We use useDraggable + useDroppable
// (not useSortable) and deliberately do NOT translate cards on every move — with
// react-plock's masonry layout and heavy cards that was slow and made columns
// jump. The source card just dims, the hovered card shows a dashed drop
// indicator, and the move/reorder is committed on drop.
export const SortableGridItem = (props: GridItemProps) => {
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
    <GridItem
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
