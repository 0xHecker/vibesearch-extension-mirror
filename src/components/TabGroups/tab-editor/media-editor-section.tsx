import {
  AlertCircle,
  ImageIcon,
  Link as LinkIcon,
  Loader2,
  Maximize2,
  MoreHorizontal,
  Plus,
  RefreshCw,
  Star,
  Trash2,
  Upload,
  Video,
  X,
} from "lucide-react";
import type { Dispatch, RefObject, SetStateAction } from "react";

import { ChevronLeft } from "@icons/chevron-left";
import { ChevronRight } from "@icons/chevron-right";
import { OcrExtractedText } from "@components/TabGroups/OcrExtractedText";
import type { LightboxEntry } from "@components/TabGroups/MediaLightboxModal";
import { Button } from "@components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@components/ui/dropdown-menu";
import { Input } from "@components/ui/input";
import { MorphingDialogTrigger } from "@components/ui/morphing-dialog";
import { cn } from "@src/lib/utils";
import type { ItemDocType } from "@src/schemas/item_schema";
import { getExternalEmbedSandbox } from "@src/utils/media-embed";

import { SectionHeading } from "./editor-fields";

export type ResolvedMediaMeta = {
  isPrimary: boolean;
  index: number;
};

type MediaEditorSectionProps = {
  mediaItems: ItemDocType["media"];
  resolvedMedia: LightboxEntry[];
  resolvedMeta: ResolvedMediaMeta[];
  activeMediaIndex: number;
  setActiveMediaIndex: Dispatch<SetStateAction<number>>;
  mediaErrorIndexes: Set<number>;
  setMediaErrorIndexes: Dispatch<SetStateAction<Set<number>>>;
  isMediaMenuOpen: boolean;
  setIsMediaMenuOpen: Dispatch<SetStateAction<boolean>>;
  setIsLightboxOpen: Dispatch<SetStateAction<boolean>>;
  isAddMediaOpen: boolean;
  setIsAddMediaOpen: Dispatch<SetStateAction<boolean>>;
  mediaUrl: string;
  setMediaUrl: Dispatch<SetStateAction<string>>;
  isAddingMedia: boolean;
  replaceIndex: number | null;
  setReplaceIndex: Dispatch<SetStateAction<number | null>>;
  fileInputRef: RefObject<HTMLInputElement | null>;
  handleAddMediaByUrl: () => Promise<void>;
  handleUploadFiles: (files: File[], indexToReplace?: number) => Promise<void>;
  handleRemoveMedia: (index: number) => Promise<void>;
  handleSetPrimaryMedia: (index: number) => Promise<void>;
  setIsRefetchConfirmOpen: Dispatch<SetStateAction<boolean>>;
};

export function MediaEditorSection({
  mediaItems,
  resolvedMedia,
  resolvedMeta,
  activeMediaIndex,
  setActiveMediaIndex,
  mediaErrorIndexes,
  setMediaErrorIndexes,
  isMediaMenuOpen,
  setIsMediaMenuOpen,
  setIsLightboxOpen,
  isAddMediaOpen,
  setIsAddMediaOpen,
  mediaUrl,
  setMediaUrl,
  isAddingMedia,
  replaceIndex,
  setReplaceIndex,
  fileInputRef,
  handleAddMediaByUrl,
  handleUploadFiles,
  handleRemoveMedia,
  handleSetPrimaryMedia,
  setIsRefetchConfirmOpen,
}: MediaEditorSectionProps) {
  const effectiveIndex = resolvedMedia[activeMediaIndex] ? activeMediaIndex : 0;
  const activeEntry = resolvedMedia[effectiveIndex];
  const activeMeta = resolvedMeta[effectiveIndex];

  return (
    <section className="space-y-3">
      <SectionHeading
        icon={<ImageIcon size={14} />}
        label="Media"
        trailing={<MediaCount count={resolvedMedia.length} />}
      />

      {activeEntry ? (
        <MediaPreviewStage
          entry={activeEntry}
          entryMeta={activeMeta}
          activeIndex={effectiveIndex}
          entryCount={resolvedMedia.length}
          hasError={mediaErrorIndexes.has(effectiveIndex)}
          setActiveIndex={setActiveMediaIndex}
          reportError={() =>
            setMediaErrorIndexes((previous) =>
              new Set(previous).add(effectiveIndex),
            )
          }
          onOpenLightbox={() => setIsLightboxOpen(true)}
          isMediaMenuOpen={isMediaMenuOpen}
          setIsMediaMenuOpen={setIsMediaMenuOpen}
          fileInputRef={fileInputRef}
          setReplaceIndex={setReplaceIndex}
          setIsAddMediaOpen={setIsAddMediaOpen}
          setMediaUrl={setMediaUrl}
          handleRemoveMedia={handleRemoveMedia}
          handleSetPrimaryMedia={handleSetPrimaryMedia}
        />
      ) : (
        <EmptyMediaStage />
      )}

      <MediaThumbnailStrip
        entries={resolvedMedia}
        metadata={resolvedMeta}
        activeIndex={effectiveIndex}
        setActiveIndex={setActiveMediaIndex}
      />

      <ActiveMediaOcr
        mediaItems={mediaItems}
        entry={activeEntry}
        entryMeta={activeMeta}
      />

      <MediaAddControls
        fileInputRef={fileInputRef}
        isAddingMedia={isAddingMedia}
        isAddMediaOpen={isAddMediaOpen}
        setIsAddMediaOpen={setIsAddMediaOpen}
        mediaUrl={mediaUrl}
        setMediaUrl={setMediaUrl}
        replaceIndex={replaceIndex}
        setReplaceIndex={setReplaceIndex}
        handleAddMediaByUrl={handleAddMediaByUrl}
        handleUploadFiles={handleUploadFiles}
      />

      <button
        type="button"
        onClick={() => setIsRefetchConfirmOpen(true)}
        className={cn(
          "flex items-center gap-1.5 text-[11px] font-medium",
          "text-foreground-tertiary hover:text-foreground-warning",
          "transition-colors duration-200 cursor-pointer",
        )}
      >
        <RefreshCw size={11} />
        Refetch from source — overrides all metadata
      </button>
    </section>
  );
}

function MediaCount({ count }: { count: number }) {
  let label = "No media";
  if (count === 1) label = "1 item";
  if (count > 1) label = `${count} items`;

  return (
    <span className="text-[11px] text-foreground-tertiary tabular-nums">
      {label}
    </span>
  );
}

type MediaPreviewStageProps = {
  entry: LightboxEntry;
  entryMeta?: ResolvedMediaMeta;
  activeIndex: number;
  entryCount: number;
  hasError: boolean;
  setActiveIndex: Dispatch<SetStateAction<number>>;
  reportError: () => void;
  onOpenLightbox: () => void;
  isMediaMenuOpen: boolean;
  setIsMediaMenuOpen: Dispatch<SetStateAction<boolean>>;
  fileInputRef: RefObject<HTMLInputElement | null>;
  setReplaceIndex: Dispatch<SetStateAction<number | null>>;
  setIsAddMediaOpen: Dispatch<SetStateAction<boolean>>;
  setMediaUrl: Dispatch<SetStateAction<string>>;
  handleRemoveMedia: (index: number) => Promise<void>;
  handleSetPrimaryMedia: (index: number) => Promise<void>;
};

function MediaPreviewStage({
  entry,
  entryMeta,
  activeIndex,
  entryCount,
  hasError,
  setActiveIndex,
  reportError,
  onOpenLightbox,
  isMediaMenuOpen,
  setIsMediaMenuOpen,
  fileInputRef,
  setReplaceIndex,
  setIsAddMediaOpen,
  setMediaUrl,
  handleRemoveMedia,
  handleSetPrimaryMedia,
}: MediaPreviewStageProps) {
  const isInteractive = entry.type === "video";
  const isVertical = isVerticalMedia(entry);
  const aspectRatio = getMediaAspectRatio(entry, isVertical);

  return (
    <MorphingDialogTrigger
      onOpen={onOpenLightbox}
      className={cn(
        "group/media relative flex items-center justify-center rounded-xl overflow-hidden",
        "border border-border-neutral-faded bg-background-page",
        "transition-all duration-200 max-h-[55vh]",
        !isInteractive &&
          "cursor-zoom-in hover:border-border-neutral hover:shadow-md hover:shadow-foreground-muted/20",
        isInteractive && "cursor-default",
        isVertical && "mx-auto max-w-[420px]",
      )}
      style={aspectRatio ? { aspectRatio } : undefined}
    >
      <MediaPreview
        entry={entry}
        index={activeIndex}
        hasError={hasError}
        hasFixedAspectRatio={Boolean(aspectRatio)}
        reportError={reportError}
      />

      {!hasError ? <ExpandMediaButton alwaysVisible={isInteractive} /> : null}

      <MediaItemActions
        entryMeta={entryMeta}
        isPrimary={entryMeta?.isPrimary === true}
        isMenuOpen={isMediaMenuOpen}
        setIsMenuOpen={setIsMediaMenuOpen}
        fileInputRef={fileInputRef}
        setReplaceIndex={setReplaceIndex}
        setIsAddMediaOpen={setIsAddMediaOpen}
        setMediaUrl={setMediaUrl}
        handleRemoveMedia={handleRemoveMedia}
        handleSetPrimaryMedia={handleSetPrimaryMedia}
      />

      {entry.type === "video" ? <VideoTypeBadge /> : null}
      {entryCount > 1 ? (
        <MediaCounter currentIndex={activeIndex} count={entryCount} />
      ) : null}
      {entryCount > 1 ? (
        <MediaNavigation
          activeIndex={activeIndex}
          entryCount={entryCount}
          setActiveIndex={setActiveIndex}
        />
      ) : null}
    </MorphingDialogTrigger>
  );
}

function isVerticalMedia(entry: LightboxEntry): boolean {
  if (entry.isVertical) return true;
  if (!entry.width || !entry.height) return false;
  return entry.height > entry.width;
}

function getMediaAspectRatio(
  entry: LightboxEntry,
  isVertical: boolean,
): string | undefined {
  if (entry.width && entry.height) return `${entry.width} / ${entry.height}`;
  if (isVertical) return "9 / 16";
  if (entry.type === "video") return "16 / 9";
  return undefined;
}

type MediaPreviewProps = {
  entry: LightboxEntry;
  index: number;
  hasError: boolean;
  hasFixedAspectRatio: boolean;
  reportError: () => void;
};

function MediaPreview({
  entry,
  index,
  hasError,
  hasFixedAspectRatio,
  reportError,
}: MediaPreviewProps) {
  if (hasError) {
    return (
      <div className="w-full h-full flex flex-col items-center justify-center gap-1.5 text-foreground-tertiary">
        <AlertCircle size={24} />
        <span className="text-xs">Failed to load</span>
      </div>
    );
  }

  if (entry.type === "video" && entry.embedType === "iframe") {
    return (
      <iframe
        src={entry.src}
        title={entry.altText || `Embedded media ${index + 1}`}
        loading="lazy"
        allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share"
        allowFullScreen
        referrerPolicy="strict-origin-when-cross-origin"
        sandbox={getExternalEmbedSandbox(entry.src, {
          allowPresentation: true,
          allowPopups: true,
        })}
        className="w-full h-full bg-foreground-darkest/5"
        onError={reportError}
        onClick={(event) => event.stopPropagation()}
        onPointerDown={(event) => event.stopPropagation()}
      />
    );
  }

  if (entry.type === "video") {
    return (
      <div className="relative w-full h-full flex items-center justify-center">
        <video
          controls
          preload="metadata"
          playsInline
          className="max-h-full max-w-full object-contain bg-foreground-darkest/5"
          onError={reportError}
          onClick={(event) => event.stopPropagation()}
        >
          <source src={entry.src} />
        </video>
      </div>
    );
  }

  return (
    <img
      src={entry.src}
      alt={entry.altText || `Media ${index + 1}`}
      loading="lazy"
      className={cn(
        "object-contain bg-foreground-darkest/5",
        hasFixedAspectRatio ? "w-full h-full" : "w-full h-auto max-h-[55vh]",
      )}
      onError={reportError}
    />
  );
}

function ExpandMediaButton({ alwaysVisible }: { alwaysVisible: boolean }) {
  return (
    <button
      type="button"
      aria-label="Expand media"
      title="Expand"
      className={cn(
        "absolute bottom-2 right-2 z-20 flex items-center gap-1.5",
        "px-2.5 h-8 rounded-full bg-background-neutral/90 backdrop-blur-md",
        "border border-border-neutral-faded/70 shadow-sm",
        "text-foreground-secondary hover:text-foreground-primary hover:bg-background-neutral",
        "transition-all duration-200 active:scale-[0.94] cursor-pointer",
        alwaysVisible
          ? "opacity-100"
          : "opacity-0 group-hover/media:opacity-100 focus-visible:opacity-100",
      )}
    >
      <Maximize2 size={14} />
      <span className="text-[11px] font-medium">Expand</span>
    </button>
  );
}

type MediaItemActionsProps = {
  entryMeta?: ResolvedMediaMeta;
  isPrimary: boolean;
  isMenuOpen: boolean;
  setIsMenuOpen: Dispatch<SetStateAction<boolean>>;
  fileInputRef: RefObject<HTMLInputElement | null>;
  setReplaceIndex: Dispatch<SetStateAction<number | null>>;
  setIsAddMediaOpen: Dispatch<SetStateAction<boolean>>;
  setMediaUrl: Dispatch<SetStateAction<string>>;
  handleRemoveMedia: (index: number) => Promise<void>;
  handleSetPrimaryMedia: (index: number) => Promise<void>;
};

function MediaItemActions({
  entryMeta,
  isPrimary,
  isMenuOpen,
  setIsMenuOpen,
  fileInputRef,
  setReplaceIndex,
  setIsAddMediaOpen,
  setMediaUrl,
  handleRemoveMedia,
  handleSetPrimaryMedia,
}: MediaItemActionsProps) {
  const editableIndex =
    entryMeta && !entryMeta.isPrimary && entryMeta.index >= 0
      ? entryMeta.index
      : null;

  const replaceWithFile = () => {
    if (editableIndex === null) return;
    setReplaceIndex(editableIndex);
    fileInputRef.current?.click();
  };

  const replaceWithUrl = () => {
    if (editableIndex === null) return;
    setReplaceIndex(editableIndex);
    setIsAddMediaOpen(true);
    setMediaUrl("");
  };

  return (
    <div
      onClick={(event) => event.stopPropagation()}
      className="absolute top-2 right-2 z-10 flex items-center gap-1.5 opacity-0 group-hover/media:opacity-100 transition-opacity duration-200"
    >
      {isPrimary ? <PrimaryMediaBadge /> : null}
      {editableIndex === null ? null : (
        <>
          <button
            type="button"
            onClick={(event) => {
              event.stopPropagation();
              replaceWithFile();
            }}
            aria-label="Replace media"
            className={mediaActionButtonClass}
          >
            <RefreshCw size={13} />
          </button>

          <DropdownMenu open={isMenuOpen} onOpenChange={setIsMenuOpen}>
            <DropdownMenuTrigger asChild>
              <button
                type="button"
                onClick={(event) => event.stopPropagation()}
                aria-label="More actions"
                className={mediaActionButtonClass}
              >
                <MoreHorizontal size={14} />
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="min-w-[180px] z-[200]">
              <DropdownMenuItem
                onSelect={() => handleSetPrimaryMedia(editableIndex)}
              >
                <Star size={14} />
                <span>Set as default display</span>
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem onSelect={replaceWithFile}>
                <Upload size={14} />
                <span>Replace with file</span>
              </DropdownMenuItem>
              <DropdownMenuItem onSelect={replaceWithUrl}>
                <LinkIcon size={14} />
                <span>Replace with URL</span>
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem
                onSelect={() => handleRemoveMedia(editableIndex)}
                className="text-foreground-danger"
              >
                <Trash2 size={14} />
                <span>Delete</span>
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>

          <button
            type="button"
            onClick={(event) => {
              event.stopPropagation();
              void handleRemoveMedia(editableIndex);
            }}
            aria-label="Delete media"
            className={cn(
              mediaActionButtonClass,
              "hover:text-foreground-danger hover:bg-background-danger-faded",
            )}
          >
            <X size={14} />
          </button>
        </>
      )}
    </div>
  );
}

const mediaActionButtonClass = cn(
  "w-7 h-7 rounded-full flex items-center justify-center",
  "bg-background-neutral/85 backdrop-blur-sm",
  "border border-border-neutral-faded/60",
  "text-foreground-secondary hover:text-foreground-primary hover:bg-background-neutral",
  "transition-all duration-200 active:scale-[0.92] cursor-pointer",
);

function PrimaryMediaBadge() {
  return (
    <div className="px-2 py-1 rounded-full bg-background-neutral/85 backdrop-blur-sm border border-border-neutral-faded/60 text-[10px] font-medium text-foreground-secondary flex items-center gap-1">
      <Star size={10} className="fill-current text-accent" />
      <span>Default</span>
    </div>
  );
}

function VideoTypeBadge() {
  return (
    <div
      onClick={(event) => event.stopPropagation()}
      className="absolute bottom-2 left-2 z-10 w-7 h-7 rounded-full bg-background-neutral/85 backdrop-blur-sm flex items-center justify-center"
    >
      <Video size={13} className="text-foreground-secondary" />
    </div>
  );
}

function MediaCounter({
  currentIndex,
  count,
}: {
  currentIndex: number;
  count: number;
}) {
  return (
    <div
      onClick={(event) => event.stopPropagation()}
      className="absolute top-2 left-2 z-10 px-2 py-1 rounded-full bg-background-neutral/85 backdrop-blur-sm border border-border-neutral-faded/60 text-[11px] text-foreground-secondary tabular-nums"
    >
      {currentIndex + 1} / {count}
    </div>
  );
}

type MediaNavigationProps = {
  activeIndex: number;
  entryCount: number;
  setActiveIndex: Dispatch<SetStateAction<number>>;
};

function MediaNavigation({
  activeIndex,
  entryCount,
  setActiveIndex,
}: MediaNavigationProps) {
  const showPrevious = () =>
    setActiveIndex(activeIndex === 0 ? entryCount - 1 : activeIndex - 1);
  const showNext = () =>
    setActiveIndex(activeIndex === entryCount - 1 ? 0 : activeIndex + 1);

  return (
    <>
      <button
        type="button"
        onClick={(event) => {
          event.stopPropagation();
          showPrevious();
        }}
        aria-label="Previous media"
        className={cn(mediaNavigationButtonClass, "left-2")}
      >
        <ChevronLeft size={18} />
      </button>
      <button
        type="button"
        onClick={(event) => {
          event.stopPropagation();
          showNext();
        }}
        aria-label="Next media"
        className={cn(mediaNavigationButtonClass, "right-2")}
      >
        <ChevronRight size={18} />
      </button>
    </>
  );
}

const mediaNavigationButtonClass = cn(
  "absolute top-1/2 -translate-y-1/2 z-10 w-9 h-9 rounded-full",
  "flex items-center justify-center bg-background-neutral/85 backdrop-blur-sm",
  "border border-border-neutral-faded/60 shadow-sm",
  "text-foreground-secondary hover:text-foreground-primary hover:bg-background-neutral",
  "transition-all duration-200 opacity-0 group-hover/media:opacity-100",
  "active:scale-[0.92] cursor-pointer",
);

function EmptyMediaStage() {
  return (
    <div className="aspect-[4/3] rounded-xl border border-dashed border-border-neutral-faded bg-background-neutral-faded/30 flex flex-col items-center justify-center gap-2 text-foreground-tertiary">
      <ImageIcon size={28} className="opacity-50" />
      <span className="text-xs">No media yet — add some below</span>
    </div>
  );
}

type MediaThumbnailStripProps = {
  entries: LightboxEntry[];
  metadata: ResolvedMediaMeta[];
  activeIndex: number;
  setActiveIndex: Dispatch<SetStateAction<number>>;
};

function MediaThumbnailStrip({
  entries,
  metadata,
  activeIndex,
  setActiveIndex,
}: MediaThumbnailStripProps) {
  if (entries.length < 2) return null;

  return (
    <div className="flex items-center gap-2 overflow-x-auto pb-1 -mx-1 px-1">
      {entries.map((entry, index) => (
        <button
          type="button"
          key={`${index}-${entry.src}`}
          onClick={() => setActiveIndex(index)}
          className={cn(
            "group/thumb relative flex-shrink-0 w-16 h-12 rounded-md overflow-hidden",
            "border transition-all duration-200 cursor-pointer",
            index === activeIndex
              ? "border-accent ring-1 ring-accent/30"
              : "border-border-neutral-faded hover:border-border-neutral",
          )}
        >
          <MediaThumbnail entry={entry} index={index} />
          {metadata[index]?.isPrimary ? <PrimaryThumbnailBadge /> : null}
        </button>
      ))}
    </div>
  );
}

function MediaThumbnail({
  entry,
  index,
}: {
  entry: LightboxEntry;
  index: number;
}) {
  if (
    entry.type === "video" &&
    entry.embedType === "iframe" &&
    entry.thumbnailSrc
  ) {
    return (
      <img
        src={entry.thumbnailSrc}
        alt={entry.altText || `Media ${index + 1}`}
        loading="lazy"
        className="w-full h-full object-cover"
      />
    );
  }

  if (entry.type === "video") {
    return (
      <video preload="metadata" muted className="w-full h-full object-cover">
        <source src={entry.src} />
      </video>
    );
  }

  return (
    <img
      src={entry.src}
      alt={entry.altText || `Media ${index + 1}`}
      loading="lazy"
      className="w-full h-full object-cover"
    />
  );
}

function PrimaryThumbnailBadge() {
  return (
    <span className="absolute top-0.5 left-0.5 px-1 py-0.5 rounded-sm bg-accent/90 backdrop-blur-sm text-[8px] uppercase tracking-wide text-background-neutral font-medium flex items-center gap-0.5">
      <Star size={7} className="fill-current" />
      Default
    </span>
  );
}

function ActiveMediaOcr({
  mediaItems,
  entry,
  entryMeta,
}: {
  mediaItems: ItemDocType["media"];
  entry?: LightboxEntry;
  entryMeta?: ResolvedMediaMeta;
}) {
  if (entry?.type !== "image" || !entryMeta || entryMeta.index < 0) return null;
  const original = mediaItems?.[entryMeta.index];
  return <OcrExtractedText ocr={original?.ocr} />;
}

type MediaAddControlsProps = {
  fileInputRef: RefObject<HTMLInputElement | null>;
  isAddingMedia: boolean;
  isAddMediaOpen: boolean;
  setIsAddMediaOpen: Dispatch<SetStateAction<boolean>>;
  mediaUrl: string;
  setMediaUrl: Dispatch<SetStateAction<string>>;
  replaceIndex: number | null;
  setReplaceIndex: Dispatch<SetStateAction<number | null>>;
  handleAddMediaByUrl: () => Promise<void>;
  handleUploadFiles: (files: File[], indexToReplace?: number) => Promise<void>;
};

function MediaAddControls({
  fileInputRef,
  isAddingMedia,
  isAddMediaOpen,
  setIsAddMediaOpen,
  mediaUrl,
  setMediaUrl,
  replaceIndex,
  setReplaceIndex,
  handleAddMediaByUrl,
  handleUploadFiles,
}: MediaAddControlsProps) {
  const closeUrlInput = () => {
    setIsAddMediaOpen(false);
    setMediaUrl("");
    setReplaceIndex(null);
  };

  return (
    <>
      <div className="flex items-center gap-2">
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() => {
            setReplaceIndex(null);
            fileInputRef.current?.click();
          }}
          disabled={isAddingMedia}
          className="h-9 active:scale-[0.96] transition-transform"
        >
          {isAddingMedia ? (
            <Loader2 size={14} className="animate-spin" />
          ) : (
            <Upload size={14} />
          )}
          <span>Add media</span>
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={() => {
            setReplaceIndex(null);
            setIsAddMediaOpen(true);
            setMediaUrl("");
          }}
          disabled={isAddingMedia}
          className="h-9 px-2 text-foreground-secondary"
        >
          <LinkIcon size={14} />
          <span>Paste URL</span>
        </Button>
      </div>

      {isAddMediaOpen ? (
        <div className="flex items-center gap-2 animate-in fade-in-0 slide-in-from-top-1 duration-200">
          <Input
            type="url"
            value={mediaUrl}
            onChange={(event) => setMediaUrl(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") void handleAddMediaByUrl();
              if (event.key === "Escape") closeUrlInput();
            }}
            placeholder={
              replaceIndex === null
                ? "Paste image or video URL..."
                : "Paste replacement URL..."
            }
            autoFocus
            className="bg-background-neutral h-9"
          />
          <Button
            type="button"
            variant="default"
            size="sm"
            onClick={() => void handleAddMediaByUrl()}
            disabled={isAddingMedia || mediaUrl.trim().length === 0}
            className="h-9 px-3 active:scale-[0.96] transition-transform"
          >
            {isAddingMedia ? (
              <Loader2 size={14} className="animate-spin" />
            ) : (
              <Plus size={14} />
            )}
            <span>{replaceIndex === null ? "Add" : "Replace"}</span>
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={closeUrlInput}
            className="h-9 px-2"
          >
            Cancel
          </Button>
        </div>
      ) : null}

      <input
        ref={fileInputRef}
        type="file"
        accept="image/*,video/*"
        multiple
        className="hidden"
        onChange={(event) => {
          const files = Array.from(event.currentTarget.files ?? []);
          if (files.length === 0) return;
          if (replaceIndex === null) {
            void handleUploadFiles(files);
            return;
          }
          void handleUploadFiles(files.slice(0, 1), replaceIndex);
        }}
      />
    </>
  );
}
