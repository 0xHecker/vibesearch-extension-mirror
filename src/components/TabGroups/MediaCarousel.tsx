import { useCallback, useEffect, useRef, useState } from "react";
import { ChevronRight } from "@icons/chevron-right";
import { ChevronLeft } from "@icons/chevron-left";
import { cn } from "@src/lib/utils";
import { ItemDocType } from "@src/schemas/item_schema";
import { resolveOpfsMedia, revokeObjectUrl } from "@src/services/media-storage";
import {
  getExternalEmbedSandbox,
  getYouTubeVideoIdFromUrl,
  normalizeIframeEmbedUrl,
} from "@src/utils/media-embed";

type MediaEntry = NonNullable<ItemDocType["media"]>[number];

interface ResolvedEntry {
  type: "image" | "video" | "audio";
  src: string;
  embedType?: "iframe";
  width?: number;
  height?: number;
  altText?: string;
  isGif: boolean;
}

const resolveEntry = async (entry: MediaEntry): Promise<ResolvedEntry | null> => {
  // The carousel intentionally supports only renderable media. Synced file
  // attachments stay on the item for consumers with a dedicated file UI.
  if (entry.type === "file") return null;
  if (entry.type === "video" && entry.embedUrl) {
    const embedUrl = normalizeIframeEmbedUrl(entry.embedUrl);
    if (embedUrl) {
      return {
        type: "video",
        src: embedUrl,
        embedType: entry.embedType || "iframe",
        width: entry.width,
        height: entry.height,
        altText: entry.altText,
        isGif: false,
      };
    }
  }
  if (entry.opfsPath) {
    const blobUrl = await resolveOpfsMedia(entry.opfsPath);
    if (blobUrl) {
      return {
        type: entry.type,
        src: blobUrl,
        altText: entry.altText,
        isGif: entry.originalUrl?.toLowerCase().endsWith(".gif") || false,
      };
    }
  }
  const src = entry.s3Url || entry.originalUrl;
  if (!src) return null;
  return {
    type: entry.type,
    src,
    altText: entry.altText,
    isGif: src.toLowerCase().endsWith(".gif"),
  };
};

export const MediaCarousel = ({
  media,
  displayImageUrl,
  pageUrl,
  className,
}: {
  media: ItemDocType["media"];
  displayImageUrl?: string;
  pageUrl?: string;
  className?: string;
}) => {
  const [entries, setEntries] = useState<ResolvedEntry[]>([]);
  const [activeIndex, setActiveIndex] = useState(0);
  const [isLoading, setIsLoading] = useState(true);
  const [erroredIndexes, setErroredIndexes] = useState<Set<number>>(new Set());
  const trackRef = useRef<HTMLDivElement>(null);
  const dragStartX = useRef<number | null>(null);
  const dragDelta = useRef(0);

  useEffect(() => {
    let cancelled = false;
    const objectUrls = new Set<string>();
    (async () => {
      const isYouTube =
        !!getYouTubeVideoIdFromUrl(pageUrl || "") ||
        (media || []).some((entry) =>
          [entry.embedUrl, entry.originalUrl, entry.pageUrl, entry.s3ThumbnailUrl, entry.thumbnailUrl]
            .filter(Boolean)
            .some((url) => !!url && !!getYouTubeVideoIdFromUrl(url))
        );
      const allEntries: (MediaEntry | { type: "image"; originalUrl: string; s3Url?: string })[] = [
        ...(media || []),
      ];
      if (
        displayImageUrl &&
        !allEntries.some(
          (e) => e.s3Url === displayImageUrl || e.originalUrl === displayImageUrl
        )
      ) {
        const displayEntry = { type: "image" as const, originalUrl: displayImageUrl };
        if (isYouTube) allEntries.push(displayEntry);
        else allEntries.unshift(displayEntry);
      }

      const resolved = await Promise.all(
        allEntries
          .filter((e) => (e as MediaEntry).embedUrl || e.s3Url || e.originalUrl || (e as MediaEntry).opfsPath)
          .map((e) => resolveEntry(e as MediaEntry))
      );

      const valid = resolved.filter((r): r is ResolvedEntry => r !== null);
      valid.forEach((entry) => {
        if (entry.src.startsWith("blob:")) objectUrls.add(entry.src);
      });
      if (cancelled) {
        objectUrls.forEach(revokeObjectUrl);
        return;
      }
      if (isYouTube) {
        valid.sort((a, b) => {
          const aEmbedVideo = a.type === "video" && a.embedType === "iframe";
          const bEmbedVideo = b.type === "video" && b.embedType === "iframe";
          if (aEmbedVideo === bEmbedVideo) return 0;
          return aEmbedVideo ? -1 : 1;
        });
      }
      setEntries(valid);
      setActiveIndex(0);
      setIsLoading(false);
    })();
    return () => {
      cancelled = true;
      objectUrls.forEach(revokeObjectUrl);
    };
  }, [media, displayImageUrl, pageUrl]);

  const goTo = useCallback(
    (index: number) => {
      if (entries.length === 0) return;
      const clamped = ((index % entries.length) + entries.length) % entries.length;
      setActiveIndex(clamped);
    },
    [entries.length]
  );

  const next = useCallback(() => goTo(activeIndex + 1), [activeIndex, goTo]);
  const prev = useCallback(() => goTo(activeIndex - 1), [activeIndex, goTo]);

  useEffect(() => {
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === "ArrowLeft") {
        e.preventDefault();
        prev();
      } else if (e.key === "ArrowRight") {
        e.preventDefault();
        next();
      }
    };
    const track = trackRef.current;
    if (!track) return;
    track.addEventListener("keydown", handleKey);
    return () => track.removeEventListener("keydown", handleKey);
  }, [prev, next]);

  const handleDragStart = (e: React.PointerEvent) => {
    if (entries.length <= 1) return;
    dragStartX.current = e.clientX;
    dragDelta.current = 0;
  };

  const handleDragMove = (e: React.PointerEvent) => {
    if (dragStartX.current === null) return;
    dragDelta.current = e.clientX - dragStartX.current;
  };

  const handleDragEnd = () => {
    if (dragStartX.current === null) return;
    const threshold = 50;
    if (dragDelta.current < -threshold) next();
    else if (dragDelta.current > threshold) prev();
    dragStartX.current = null;
    dragDelta.current = 0;
  };

  if (isLoading) {
    return (
      <div className={cn("flex items-center justify-center h-full bg-background-page", className)}>
        <div className="w-8 h-8 border-2 border-accent/30 border-t-accent rounded-full animate-spin" />
      </div>
    );
  }

  if (entries.length === 0) {
    return (
      <div className={cn("flex items-center justify-center h-full bg-background-page text-foreground-tertiary", className)}>
        <p className="text-sm">No media available</p>
      </div>
    );
  }

  const hasMultiple = entries.length > 1;

  return (
    <div
      ref={trackRef}
      tabIndex={0}
      className={cn(
        "relative h-full w-full overflow-hidden bg-background-page outline-none group/carousel",
        className
      )}
      onPointerDown={handleDragStart}
      onPointerMove={handleDragMove}
      onPointerUp={handleDragEnd}
      onPointerCancel={handleDragEnd}
    >
      {/* Slides track */}
      <div
        className="flex h-full transition-transform duration-500 ease-[cubic-bezier(0.22,1,0.36,1)]"
        style={{ transform: `translateX(-${activeIndex * 100}%)` }}
      >
        {entries.map((entry, i) => (
          <div
            key={i}
            className="flex-shrink-0 w-full h-full flex items-center justify-center relative"
          >
            {erroredIndexes.has(i) ? (
              <div className="flex flex-col items-center gap-2 text-foreground-tertiary">
                <div className="w-12 h-12 rounded-full bg-background-highlight flex items-center justify-center">
                  <span className="text-xl">!</span>
                </div>
                <p className="text-xs">Failed to load</p>
              </div>
            ) : entry.type === "video" ? (
              entry.embedType === "iframe" ? (
                <iframe
                  src={entry.src}
                  title={entry.altText || `Embedded media ${i + 1}`}
                  loading="lazy"
                  allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share"
                  allowFullScreen
                  referrerPolicy="strict-origin-when-cross-origin"
                  sandbox={getExternalEmbedSandbox(entry.src, {
                    allowPresentation: true,
                    allowPopups: true,
                  })}
                  className="max-h-full max-w-full bg-background-page-secondary"
                  style={{
                    aspectRatio:
                      entry.width && entry.height
                        ? `${entry.width} / ${entry.height}`
                        : "16 / 9",
                    width: "100%",
                  }}
                  onError={() =>
                    setErroredIndexes((prev) => new Set(prev).add(i))
                  }
                />
              ) : (
                <video
                  controls
                  preload="metadata"
                  playsInline
                  className="max-h-full max-w-full object-contain"
                  onError={() =>
                    setErroredIndexes((prev) => new Set(prev).add(i))
                  }
                >
                  <source src={entry.src} />
                </video>
              )
            ) : (
              <img
                src={entry.src}
                alt={entry.altText || `Media ${i + 1}`}
                className="max-h-full max-w-full object-contain"
                style={{
                  outline: "1px solid rgba(0,0,0,0.08)",
                  outlineOffset: "-1px",
                }}
                onError={() =>
                  setErroredIndexes((prev) => new Set(prev).add(i))
                }
              />
            )}
          </div>
        ))}
      </div>

      {/* Nav buttons */}
      {hasMultiple && (
        <>
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              prev();
            }}
            aria-label="Previous media"
            className={cn(
              "absolute left-3 top-1/2 -translate-y-1/2 z-10",
              "flex items-center justify-center w-11 h-11 rounded-full",
              "bg-background-neutral/80 backdrop-blur-md",
              "border border-border-neutral-faded/60",
              "text-foreground-secondary hover:text-accent",
              "shadow-md hover:shadow-lg transition-all duration-300",
              "opacity-0 group-hover/carousel:opacity-100",
              "active:scale-[0.92] cursor-pointer outline-none",
              "focus-visible:ring-2 focus-visible:ring-accent/40"
            )}
          >
            <ChevronLeft size={22} />
          </button>
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              next();
            }}
            aria-label="Next media"
            className={cn(
              "absolute right-3 top-1/2 -translate-y-1/2 z-10",
              "flex items-center justify-center w-11 h-11 rounded-full",
              "bg-background-neutral/80 backdrop-blur-md",
              "border border-border-neutral-faded/60",
              "text-foreground-secondary hover:text-accent",
              "shadow-md hover:shadow-lg transition-all duration-300",
              "opacity-0 group-hover/carousel:opacity-100",
              "active:scale-[0.92] cursor-pointer outline-none",
              "focus-visible:ring-2 focus-visible:ring-accent/40"
            )}
          >
            <ChevronRight size={22} />
          </button>
        </>
      )}

      {/* Counter + dots */}
      {hasMultiple && (
        <div className="absolute bottom-4 left-1/2 -translate-x-1/2 z-10 flex items-center gap-3">
          <div className="flex items-center gap-1.5 px-3 py-1.5 rounded-full bg-background-neutral/80 backdrop-blur-md border border-border-neutral-faded/60 shadow-sm">
            {entries.map((_, i) => (
              <button
                key={i}
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  goTo(i);
                }}
                aria-label={`Go to media ${i + 1}`}
                className={cn(
                  "rounded-full transition-all duration-300 cursor-pointer outline-none",
                  "active:scale-[0.85]",
                  i === activeIndex
                    ? "w-5 h-1.5 bg-accent"
                    : "w-1.5 h-1.5 bg-foreground-tertiary/50 hover:bg-foreground-secondary"
                )}
              />
            ))}
          </div>
          <span className="text-xs text-foreground-secondary tabular-nums px-2 py-1 rounded-full bg-background-neutral/80 backdrop-blur-md border border-border-neutral-faded/60">
            {activeIndex + 1} / {entries.length}
          </span>
        </div>
      )}
    </div>
  );
};

export default MediaCarousel;
