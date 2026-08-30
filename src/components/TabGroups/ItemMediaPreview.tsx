import { useEffect, useRef, useState } from "react";
import { cn } from "@src/lib/utils";
import { ItemDocType } from "@src/schemas/item_schema";
import { resolveOpfsMedia, revokeObjectUrl } from "@src/services/media-storage";
import { normalizeIframeEmbedUrl } from "@src/utils/media-embed";

type ResolvedMedia = {
  type: "image" | "video" | "audio";
  src: string;
  embedType?: "iframe";
  thumbnailSrc?: string;
  width?: number;
  height?: number;
  isVertical?: boolean;
  totalCount: number;
};

const isVerticalVideoSource = (item: ItemDocType, media?: { originalUrl?: string; pageUrl?: string; width?: number; height?: number }): boolean => {
  if (media?.width && media?.height && media.height > media.width) return true;
  const source = item.source;
  if (source === "tiktok") return true;
  const checkUrls = [
    item.url,
    media?.originalUrl,
    media?.pageUrl,
  ].filter(Boolean) as string[];
  for (const u of checkUrls) {
    const lower = u.toLowerCase();
    if (lower.includes("/shorts/")) return true;
    if (lower.includes("/reel/") || lower.includes("/reels/")) return true;
    if (lower.includes("tiktok.com")) return true;
  }
  return false;
};

const resolveMedia = async (item: ItemDocType): Promise<ResolvedMedia | null> => {
  const mediaEntries = (item.media || []).filter(
    (entry) =>
      typeof entry?.embedUrl === "string" ||
      typeof entry?.s3Url === "string" ||
      typeof entry?.originalUrl === "string" ||
      typeof entry?.opfsPath === "string"
  );
  const totalCount = mediaEntries.length > 0 ? mediaEntries.length : item.displayImageUrl ? 1 : 0;

  // Grid cards should prefer real image media, including WebP, over an embed or
  // metadata fallback. The image keeps its natural height via `h-auto` below.
  const imageEntries = mediaEntries.filter((entry) => entry.type === "image");
  const candidate = imageEntries.find(
    (entry) => entry.storageType === "opfs" || entry.storageType === "s3"
  ) || imageEntries[0] || mediaEntries.find(
    (entry) => entry.storageType === "opfs" || entry.storageType === "s3"
  ) || mediaEntries[0];
  if (candidate) {
    const isVertical = isVerticalVideoSource(item, candidate);
    const embedUrl = candidate.type === "video" ? normalizeIframeEmbedUrl(candidate.embedUrl) : null;
    if (embedUrl) {
      return {
        type: "video",
        src: embedUrl,
        embedType: "iframe",
        thumbnailSrc: candidate.s3ThumbnailUrl || candidate.thumbnailUrl || item.displayImageUrl,
        width: candidate.width,
        height: candidate.height,
        isVertical,
        totalCount,
      };
    }
    if (candidate.opfsPath) {
      const blobUrl = await resolveOpfsMedia(candidate.opfsPath);
      if (blobUrl) {
        if (candidate.type === "video") {
          return {
            type: "video",
            src: blobUrl,
            width: candidate.width,
            height: candidate.height,
            isVertical,
            totalCount,
          };
        }
        if (candidate.type === "audio") return { type: "audio", src: blobUrl, totalCount };
        return {
          type: "image",
          src: blobUrl,
          width: candidate.width,
          height: candidate.height,
          totalCount,
        };
      }
    }
    const src = candidate.s3Url || candidate.originalUrl;
    if (src) {
      if (candidate.type === "video") {
        return {
          type: "video",
          src,
          width: candidate.width,
          height: candidate.height,
          isVertical,
          totalCount,
        };
      }
      if (candidate.type === "audio") return { type: "audio", src, totalCount };
      return {
        type: "image",
        src,
        width: candidate.width,
        height: candidate.height,
        totalCount,
      };
    }
  }

  if (item.displayImageUrl) {
    return { type: "image", src: item.displayImageUrl, totalCount: Math.max(1, totalCount) };
  }

  return null;
};

export const ItemMediaPreview = ({
  item,
  className,
}: {
  item: ItemDocType;
  className?: string;
}) => {
  const [media, setMedia] = useState<ResolvedMedia | null>(null);
  const hostRef = useRef<HTMLDivElement | null>(null);
  const [isVisible, setIsVisible] = useState(false);
  const [isMediaActive, setIsMediaActive] = useState(false);
  const [isErrored, setIsErrored] = useState(false);
  const hasMedia = Boolean(
    item.displayImageUrl ||
      item.media?.some(
        (entry) => entry.embedUrl || entry.s3Url || entry.originalUrl || entry.opfsPath
      )
  );

  useEffect(() => {
    setIsVisible(false);
    setMedia(null);
    setIsMediaActive(false);
    setIsErrored(false);
  }, [item.id]);

  useEffect(() => {
    if (!isVisible) {
      setIsMediaActive(false);
      return;
    }
    let cancelled = false;
    let objectUrl: string | null = null;
    setIsMediaActive(false);
    (async () => {
      const resolved = await resolveMedia(item);
      if (resolved?.src.startsWith("blob:")) objectUrl = resolved.src;
      if (cancelled) {
        revokeObjectUrl(objectUrl);
        return;
      }
      setMedia(resolved);
      setIsMediaActive(true);
    })();
    return () => {
      cancelled = true;
      revokeObjectUrl(objectUrl);
    };
  }, [isVisible, item]);

  useEffect(() => {
    if (!hasMedia) return;
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          setIsVisible(entry.isIntersecting);
        }
      },
      { root: null, rootMargin: "480px 0px", threshold: 0.01 }
    );
    if (hostRef.current) observer.observe(hostRef.current);
    return () => observer.disconnect();
  }, [hasMedia]);

  if (!hasMedia) return null;
  const extraCount = Math.max(0, (media?.totalCount ?? 1) - 1);

  const fallback = (
    <div
      className="grid min-h-12 place-items-center rounded-sm-semi border border-border-neutral-faded bg-background-page-secondary px-2 py-1 text-[11px] uppercase tracking-[0.08em] text-foreground-tertiary"
      style={
        media?.width && media?.height
          ? { aspectRatio: `${media.width} / ${media.height}` }
          : undefined
      }
    >
      {media?.type ?? "media"}
    </div>
  );

  return (
    <div ref={hostRef} className={cn("w-full", className)}>
      {!media || !isVisible || !isMediaActive || isErrored ? (
        fallback
      ) : media.type === "image" ? (
        <div className="relative">
          <img
            src={media.src}
            alt={item.title || "Imported media"}
            loading="lazy"
            decoding="async"
            className="w-full h-auto rounded-sm-semi object-contain"
            style={media.width && media.height ? { aspectRatio: `${media.width} / ${media.height}` } : undefined}
            onError={() => {
              setIsErrored(true);
            }}
          />
          {extraCount > 0 && (
            <span className="absolute right-2 bottom-2 rounded-full bg-background-neutral/90 px-2 py-0.5 text-[10px] font-medium text-foreground-secondary">
              +{extraCount}
            </span>
          )}
        </div>
      ) : media.type === "video" ? (
        <div className="relative">
          {media.embedType === "iframe" ? (
            <div
              className={cn(
                "relative grid w-full place-items-center overflow-hidden rounded-sm-semi border border-border-neutral-faded bg-background-page-secondary",
                media.isVertical && "mx-auto max-w-[420px]"
              )}
              style={{
                aspectRatio:
                  media.width && media.height
                    ? `${media.width} / ${media.height}`
                    : media.isVertical
                      ? "9 / 16"
                      : "16 / 9",
              }}
            >
              {media.thumbnailSrc ? (
                <img
                  src={media.thumbnailSrc}
                  alt={item.title || "Video thumbnail"}
                  loading="lazy"
                  decoding="async"
                  className="h-full w-full object-cover"
                  onError={() => setIsErrored(true)}
                />
              ) : (
                <span className="text-xs font-medium text-foreground-tertiary">Video preview</span>
              )}
              <span className="pointer-events-none absolute grid size-11 place-items-center rounded-full bg-background-neutral/85 text-foreground-neutral shadow-sm backdrop-blur-sm">
                <span className="ml-0.5 block h-0 w-0 border-y-[7px] border-l-[11px] border-y-transparent border-l-current" />
              </span>
            </div>
          ) : (
            <video
              controls
              preload="none"
              playsInline
              className={cn(
                "w-full rounded-sm-semi border border-border-neutral-faded bg-background-page-secondary",
                media.isVertical && "mx-auto max-w-[420px]"
              )}
              style={{
                aspectRatio:
                  media.width && media.height
                    ? `${media.width} / ${media.height}`
                    : media.isVertical
                      ? "9 / 16"
                      : "16 / 9",
              }}
              onError={() => {
                setIsErrored(true);
              }}
              // Prevent clicks on video controls from opening the lightbox.
              onClick={(e) => e.stopPropagation()}
            >
              <source src={media.src} />
            </video>
          )}
          {extraCount > 0 && (
            <span className="absolute right-2 bottom-2 rounded-full bg-background-neutral/90 px-2 py-0.5 text-[10px] font-medium text-foreground-secondary">
              +{extraCount}
            </span>
          )}
        </div>
      ) : (
        <div className="rounded-sm-semi border border-border-neutral-faded bg-background-page-secondary px-2 py-2">
          <audio
            controls
            preload="none"
            className="w-full"
            onError={() => {
              setIsErrored(true);
            }}
            onClick={(e) => e.stopPropagation()}
          >
            <source src={media.src} />
          </audio>
          {extraCount > 0 && (
            <div className="mt-1 text-[10px] font-medium text-foreground-secondary">+{extraCount} more media</div>
          )}
        </div>
      )}
    </div>
  );
};
