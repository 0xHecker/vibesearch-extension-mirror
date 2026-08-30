import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Star,
  Link as LinkIcon,
  StickyNote,
  Tag as TagIcon,
  Plus,
  X,
  Loader2,
  Calendar,
  Clock,
  Folder as FolderIcon,
  Hash,
  AlertCircle,
  Save,
  RotateCcw,
  ImageIcon,
  Video,
  Trash2,
  RefreshCw,
  Upload,
  Link as LinkIcon2,
  MoreHorizontal,
  Maximize2,
} from "lucide-react";
import {
  Sheet,
  SheetContent,
  SheetClose,
  SheetTitle,
} from "@components/ui/sheet";
import { Button } from "@components/ui/button";
import { Input } from "@components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@components/ui/select";
import { ScrollArea } from "@components/ui/scroll-area";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  DropdownMenuSeparator,
} from "@components/ui/dropdown-menu";
import { ConfirmDialog } from "@components/ui/confirm-dialog";
import { WebIcon } from "@icons/web";
import { ChevronRight } from "@icons/chevron-right";
import { ChevronLeft } from "@icons/chevron-left";
import { MediaLightboxModal, type LightboxEntry, type LightboxMetadata } from "@components/TabGroups/MediaLightboxModal";
import { OcrExtractedText } from "@components/TabGroups/OcrExtractedText";
import {
  MorphingDialog,
  MorphingDialogTrigger,
} from "@components/ui/morphing-dialog";
import { cn } from "@src/lib/utils";
import { tagChipStyle, tagDotStyle } from "./tag-color";
import { ItemDocType } from "@src/schemas/item_schema";
import {
  saveMediaToOpfs,
  inferMediaType,
  isGifUrl,
  canAddMedia,
  MEDIA_LIMITS,
  type MediaCategory,
  resolveOpfsMedia,
  revokeObjectUrl,
} from "@src/services/media-storage";
import {
  resolveToastErrorMessage,
  showSuccessToast,
  showErrorToast,
  withToast,
} from "@src/utils/toast-feedback";
import { getExternalEmbedSandbox, normalizeIframeEmbedUrl } from "@src/utils/media-embed";

const SOURCE_OPTIONS: { value: ItemDocType["source"]; label: string }[] = [
  { value: "web", label: "Web" },
  { value: "twitter", label: "Twitter / X" },
  { value: "reddit", label: "Reddit" },
  { value: "note", label: "Note" },
  { value: "youtube", label: "YouTube" },
  { value: "instagram", label: "Instagram" },
  { value: "tiktok", label: "TikTok" },
  { value: "substack", label: "Substack" },
  { value: "linkedin", label: "LinkedIn" },
  { value: "github", label: "GitHub" },
  { value: "article", label: "Article" },
];

const SOURCE_LABEL: Record<ItemDocType["source"], string> = SOURCE_OPTIONS.reduce(
  (acc, opt) => {
    acc[opt.value] = opt.label;
    return acc;
  },
  {} as Record<ItemDocType["source"], string>
);

const formatDateTime = (ts: number) =>
  new Intl.DateTimeFormat(undefined, {
    day: "numeric",
    month: "short",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(ts));

interface TabEditorSheetProps {
  item: ItemDocType;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSaved?: (updated: Partial<ItemDocType>) => void;
}

interface TagEntry {
  id: string;
  name: string;
  color?: string | null;
}

export const TabEditorSheet = ({
  item,
  open,
  onOpenChange,
  onSaved,
}: TabEditorSheetProps) => {
  const [title, setTitle] = useState(item.title);
  const [url, setUrl] = useState(item.url);
  const [textContent, setTextContent] = useState(item.textContent ?? "");
  const [source, setSource] = useState<ItemDocType["source"]>(item.source);
  const [isFavorite, setIsFavorite] = useState(item.isFavorite);
  const [authorUsername, setAuthorUsername] = useState(item.authorUsername ?? "");
  const [likes, setLikes] = useState<string>(
    typeof item.likes === "number" ? String(item.likes) : ""
  );
  const [upvotes, setUpvotes] = useState<string>(
    typeof item.upvotes === "number" ? String(item.upvotes) : ""
  );

  const [tags, setTags] = useState<TagEntry[]>([]);
  const [newTag, setNewTag] = useState("");
  const [isAddingTag, setIsAddingTag] = useState(false);
  const [mediaItems, setMediaItems] = useState<ItemDocType["media"]>(item.media || []);
  const [isAddMediaOpen, setIsAddMediaOpen] = useState(false);
  const [mediaUrl, setMediaUrl] = useState("");
  const [isAddingMedia, setIsAddingMedia] = useState(false);
  const [replaceIndex, setReplaceIndex] = useState<number | null>(null);
  const [isRefetchConfirmOpen, setIsRefetchConfirmOpen] = useState(false);
  const [mediaErrorIndexes, setMediaErrorIndexes] = useState<Set<number>>(new Set());
  const fileInputRef = useRef<HTMLInputElement>(null);

  const [resolvedMedia, setResolvedMedia] = useState<LightboxEntry[]>([]);
  const [resolvedMeta, setResolvedMeta] = useState<{ isPrimary: boolean; index: number }[]>([]);
  const [activeMediaIndex, setActiveMediaIndex] = useState(0);
  const [isMediaMenuOpen, setIsMediaMenuOpen] = useState(false);
  // True while the media lightbox (a native <dialog> opened on top of the
  // Radix Sheet) is open. Radix's outside-click/escape/focus tracking can't
  // see the native dialog as a nested layer, so without guarding the Sheet it
  // would close whenever the user interacts with the lightbox.
  const [isLightboxOpen, setIsLightboxOpen] = useState(false);

  const [isSaving, setIsSaving] = useState(false);
  const [urlError, setUrlError] = useState<string | null>(null);
  const [hasDirtyChanges, setHasDirtyChanges] = useState(false);

  const titleRef = useRef<HTMLInputElement>(null);

  const originalSnapshot = useMemo(
    () => ({
      title: item.title,
      url: item.url,
      textContent: item.textContent ?? "",
      source: item.source,
      isFavorite: item.isFavorite,
      authorUsername: item.authorUsername ?? "",
      likes: typeof item.likes === "number" ? String(item.likes) : "",
      upvotes: typeof item.upvotes === "number" ? String(item.upvotes) : "",
    }),
    [item]
  );

  const currentValues = {
    title,
    url,
    textContent,
    source,
    isFavorite,
    authorUsername,
    likes,
    upvotes,
  };

  useEffect(() => {
    if (open) {
      setTitle(item.title);
      setUrl(item.url);
      setTextContent(item.textContent ?? "");
      setSource(item.source);
      setIsFavorite(item.isFavorite);
      setAuthorUsername(item.authorUsername ?? "");
      setLikes(typeof item.likes === "number" ? String(item.likes) : "");
      setUpvotes(typeof item.upvotes === "number" ? String(item.upvotes) : "");
      setMediaItems(item.media || []);
      setMediaErrorIndexes(new Set());
      setIsAddMediaOpen(false);
      setMediaUrl("");
      setReplaceIndex(null);
      setUrlError(null);
      setHasDirtyChanges(false);
      const t = window.setTimeout(() => titleRef.current?.focus(), 320);
      return () => window.clearTimeout(t);
    } else {
      setNewTag("");
      setMediaUrl("");
      setIsAddMediaOpen(false);
      setReplaceIndex(null);
      setUrlError(null);
    }
  }, [open, item]);

  useEffect(() => {
    if (!open) return;
    const nextDirty =
      JSON.stringify(currentValues) !== JSON.stringify(originalSnapshot);
    setHasDirtyChanges(nextDirty);
  }, [currentValues, originalSnapshot, open]);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    const objectUrls = new Set<string>();
    (async () => {
      const entries: LightboxEntry[] = [];
      const meta: { isPrimary: boolean; index: number }[] = [];
      const seenUrls = new Set<string>();

      for (let i = 0; i < (mediaItems || []).length; i++) {
        const m = (mediaItems as NonNullable<ItemDocType["media"]>)[i];
        // File attachments are data, not lightbox slides. They remain on the
        // item and in sync/export payloads without changing this UI.
        if (m.type === "file") continue;
        let src: string | null = null;
        let embedType: LightboxEntry["embedType"];
        if (m.type === "video" && m.embedUrl) {
          src = normalizeIframeEmbedUrl(m.embedUrl);
          if (src) embedType = m.embedType || "iframe";
        }
        if (m.opfsPath) {
          src = await resolveOpfsMedia(m.opfsPath);
          if (src?.startsWith("blob:")) objectUrls.add(src);
        }
        if (!src) src = m.s3Url || m.originalUrl;
        if (!src) continue;
        seenUrls.add(src);
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
        entries.push({
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
        meta.push({ isPrimary: i === 0, index: i });
      }

      if (
        item.displayImageUrl &&
        !seenUrls.has(item.displayImageUrl)
      ) {
        entries.push({
          type: "image",
          src: item.displayImageUrl,
          altText: "Legacy display image",
          isGif: item.displayImageUrl.toLowerCase().endsWith(".gif"),
        });
        meta.push({ isPrimary: false, index: -1 });
      }

      if (cancelled) {
        objectUrls.forEach(revokeObjectUrl);
        return;
      }
      setResolvedMedia(entries);
      setResolvedMeta(meta);
    })();
    return () => {
      cancelled = true;
      objectUrls.forEach(revokeObjectUrl);
    };
  }, [open, mediaItems, item.displayImageUrl]);

  useEffect(() => {
    if (activeMediaIndex > resolvedMedia.length - 1) {
      setActiveMediaIndex(Math.max(0, resolvedMedia.length - 1));
    }
  }, [resolvedMedia.length, activeMediaIndex]);

  useEffect(() => {
    setMediaErrorIndexes(new Set());
  }, [resolvedMedia]);

  const lightboxMetadata: LightboxMetadata | undefined = useMemo(() => {
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

  const loadTags = useCallback(async () => {
    try {
      const res = await chrome.runtime.sendMessage({
        service: "tags",
        type: "getTagsForItem",
        target: "offscreen",
        payload: { itemId: item.id },
      });
      if (res?.success) setTags((res.payload as TagEntry[]) || []);
    } catch (e) {
      console.error("Failed to load tags in editor", e);
    }
  }, [item.id]);

  useEffect(() => {
    if (open) loadTags();
  }, [open, loadTags]);

  const handleAddTag = async () => {
    const name = newTag.trim();
    if (!name || isAddingTag) return;
    if (tags.some((t) => t.name.toLowerCase() === name.toLowerCase())) {
      setNewTag("");
      return;
    }
    setIsAddingTag(true);
    try {
      await withToast({
        loading: "Adding tag...",
        success: `Tag "${name}" added.`,
        error: (err) => resolveToastErrorMessage(err, "Failed to add tag."),
        successTempo: "quick",
        action: async () => {
          const res = await chrome.runtime.sendMessage({
            service: "tags",
            type: "addTagToItem",
            target: "offscreen",
            payload: { itemId: item.id, tagName: name },
          });
          if (res?.success === false || res?.payload?.success === false) {
            throw new Error(
              res?.error || res?.payload?.error || "Failed to add tag."
            );
          }
        },
      });
      setNewTag("");
      await loadTags();
    } catch (e) {
      console.error(e);
    } finally {
      setIsAddingTag(false);
    }
  };

  const handleRemoveTag = async (tagId: string, tagName: string) => {
    try {
      await withToast({
        loading: "Removing tag...",
        success: `Tag "${tagName}" removed.`,
        error: (err) => resolveToastErrorMessage(err, "Failed to remove tag."),
        successTempo: "quick",
        action: async () => {
          const res = await chrome.runtime.sendMessage({
            service: "tags",
            type: "removeTagFromItem",
            target: "offscreen",
            payload: { itemId: item.id, tagId },
          });
          if (res?.success === false || res?.payload?.success === false) {
            throw new Error(
              res?.error || res?.payload?.error || "Failed to remove tag."
            );
          }
        },
      });
      await loadTags();
    } catch (e) {
      console.error(e);
    }
  };

  const tryOcrOnImage = async (imageUrl: string): Promise<void> => {
    try {
      if (!imageUrl.startsWith("http")) return;
      const result = await chrome.runtime.sendMessage({
        service: "ocr",
        type: "extractImageText",
        target: "offscreen",
        payload: { url: imageUrl },
      });
      if (result?.success === false) return;
      const payload = result?.payload || result;
      const OCR_THRESHOLD = 0.3;
      const text: string = (payload?.text || "").trim();
      const confidence: number | undefined = typeof payload?.confidence === "number" ? payload.confidence : undefined;
      if (!text) return;
      if (typeof confidence === "number" && confidence < OCR_THRESHOLD) return;

      const currentText = (textContent || "").trim();
      if (currentText && currentText.includes(text)) return;
      const newText = currentText ? `${currentText}\n\n--- OCR ---\n${text}` : `--- OCR ---\n${text}`;
      setTextContent(newText);
      setHasDirtyChanges(true);
      showSuccessToast("Text extracted from image.", { tempo: "quick" });
    } catch {
      // OCR is best-effort — don't block media add on failure
    }
  };

  const handleAddMediaByUrl = async () => {
    const trimmed = mediaUrl.trim();
    if (!trimmed || isAddingMedia) return;
    const type = inferMediaType(trimmed);
    const isReplace = replaceIndex !== null;

    if (!isReplace) {
      const category: MediaCategory = type === "video" ? "video" : isGifUrl(trimmed) ? "gif" : "image";
      if (!canAddMedia(
        (mediaItems || []).map((m) => ({ type: m.type, originalUrl: m.originalUrl })),
        category
      )) {
        showErrorToast(`${category}s limit reached (max ${MEDIA_LIMITS[category]}).`, { tempo: "quick" });
        return;
      }
    }

    setIsAddingMedia(true);
    try {
      if (isReplace && replaceIndex !== null) {
        await withToast({
          loading: "Replacing media...",
          success: "Media replaced.",
          error: (err) => resolveToastErrorMessage(err, "Failed to replace media."),
          action: async () => {
            const res = await chrome.runtime.sendMessage({
              service: "items",
              type: "replaceMedia",
              target: "offscreen",
              payload: { id: item.id, index: replaceIndex, url: trimmed, type },
            });
            if (res?.success === false || res?.payload?.success === false) {
              throw new Error(res?.error || res?.payload?.error || "Failed to replace media.");
            }
          },
        });
        setMediaItems((mediaItems || []).map((m, i) =>
          i === replaceIndex ? { type, originalUrl: trimmed, storageType: "hotlink" as const } : m
        ));
      } else {
        await withToast({
          loading: "Adding media...",
          success: "Media added.",
          error: (err) => resolveToastErrorMessage(err, "Failed to add media."),
          action: async () => {
            const res = await chrome.runtime.sendMessage({
              service: "items",
              type: "addMedia",
              target: "offscreen",
              payload: { id: item.id, url: trimmed, type },
            });
            if (res?.success === false || res?.payload?.success === false) {
              throw new Error(res?.error || res?.payload?.error || "Failed to add media.");
            }
          },
        });
        setMediaItems([
          ...(mediaItems || []),
          { type, originalUrl: trimmed, storageType: "hotlink" as const },
        ]);
      }
      setMediaUrl("");
      setIsAddMediaOpen(false);
      setReplaceIndex(null);
      if (type === "image") {
        void tryOcrOnImage(trimmed);
      }
    } catch (e) {
      console.error(e);
    } finally {
      setIsAddingMedia(false);
    }
  };

  const handleUploadFiles = async (files: File[], indexToReplace?: number) => {
    if (!files.length) return;
    const isReplace = typeof indexToReplace === "number";

    if (!isReplace) {
      for (const file of files) {
        const type = inferMediaType("", file);
        const category: MediaCategory = type === "video" ? "video" : isGifUrl(file.name) ? "gif" : "image";
        if (!canAddMedia(
          (mediaItems || []).map((m) => ({ type: m.type, originalUrl: m.originalUrl })),
          category
        )) {
          showErrorToast(`${category}s limit reached (max ${MEDIA_LIMITS[category]}).`, { tempo: "quick" });
          return;
        }
      }
    }

    setIsAddingMedia(true);

    try {
      if (isReplace && typeof indexToReplace === "number") {
        const file = files[0];
        const { opfsPath } = await saveMediaToOpfs(item.id, file);
        const type = inferMediaType("", file);
        const newEntry = {
          type,
          originalUrl: file.name,
          storageType: "opfs" as const,
          opfsPath,
          altText: file.name,
        };
        const expectedMedia = mediaItems || [];
        const next = expectedMedia.map((m, i) =>
          i === indexToReplace ? newEntry : m
        );
        await withToast({
          loading: "Replacing media...",
          success: "Media replaced.",
          error: (err) => resolveToastErrorMessage(err, "Failed to replace media."),
          action: async () => {
            const res = await chrome.runtime.sendMessage({
              service: "items",
              type: "updateMedia",
              target: "offscreen",
              payload: { id: item.id, media: next, expectedMedia },
            });
            if (res?.success === false || res?.payload?.success === false) {
              throw new Error(res?.error || res?.payload?.error || "Failed to replace media.");
            }
          },
        });
        setMediaItems(next);
        setReplaceIndex(null);
      } else {
        const newEntries: NonNullable<ItemDocType["media"]> = [];
        for (const file of files) {
          const { opfsPath } = await saveMediaToOpfs(item.id, file);
          const type = inferMediaType("", file);
          newEntries.push({
            type,
            originalUrl: file.name,
            storageType: "opfs" as const,
            opfsPath,
            altText: file.name,
          });
        }
        const expectedMedia = mediaItems || [];
        const next = [...expectedMedia, ...newEntries];
        await withToast({
          loading: files.length > 1 ? `Uploading ${files.length} files...` : "Uploading media...",
          success: files.length > 1 ? `${files.length} files uploaded.` : "Media uploaded.",
          error: (err) => resolveToastErrorMessage(err, "Failed to upload media."),
          action: async () => {
            const res = await chrome.runtime.sendMessage({
              service: "items",
              type: "updateMedia",
              target: "offscreen",
              payload: { id: item.id, media: next, expectedMedia },
            });
            if (res?.success === false || res?.payload?.success === false) {
              throw new Error(res?.error || res?.payload?.error || "Failed to upload media.");
            }
          },
        });
        setMediaItems(next);
      }
    } catch (e) {
      console.error(e);
    } finally {
      setIsAddingMedia(false);
      if (fileInputRef.current) fileInputRef.current.value = "";
    }
  };

  const handleRemoveMedia = async (index: number) => {
    try {
      await withToast({
        loading: "Removing media...",
        success: "Media removed.",
        error: (err) => resolveToastErrorMessage(err, "Failed to remove media."),
        successTempo: "quick",
        action: async () => {
          const res = await chrome.runtime.sendMessage({
            service: "items",
            type: "removeMedia",
            target: "offscreen",
            payload: { id: item.id, index },
          });
          if (res?.success === false || res?.payload?.success === false) {
            throw new Error(res?.error || res?.payload?.error || "Failed to remove media.");
          }
        },
      });
      setMediaItems((mediaItems || []).filter((_, i) => i !== index));
      setMediaErrorIndexes((prev) => {
        const next = new Set(prev);
        next.delete(index);
        return next;
      });
      setActiveMediaIndex((prev) => Math.max(0, prev - 1));
    } catch (e) {
      console.error(e);
    }
  };

  const handleSetPrimaryMedia = async (index: number) => {
    if (index === 0) return;
    const expectedMedia = mediaItems || [];
    const arr = expectedMedia.slice();
    if (index < 0 || index >= arr.length) return;
    const [moved] = arr.splice(index, 1);
    arr.unshift(moved);
    setMediaItems(arr);
    setActiveMediaIndex(0);
    try {
      await withToast({
        loading: "Setting default media...",
        success: "Default media updated.",
        error: (err) => resolveToastErrorMessage(err, "Failed to set default media."),
        successTempo: "quick",
        action: async () => {
          const res = await chrome.runtime.sendMessage({
            service: "items",
            type: "updateMedia",
            target: "offscreen",
            payload: { id: item.id, media: arr, expectedMedia },
          });
          if (res?.success === false || res?.payload?.success === false) {
            throw new Error(res?.error || res?.payload?.error || "Failed to set default media.");
          }
        },
      });
    } catch (e) {
      console.error(e);
    }
  };

  const handleRefetchMetadata = async () => {
    try {
      await withToast({
        loading: "Refetching metadata...",
        success: "Metadata refresh queued. All media will be replaced.",
        error: (err) => resolveToastErrorMessage(err, "Failed to refetch metadata."),
        action: async () => {
          await chrome.runtime.sendMessage({
            target: "background",
            type: "FETCH_METADATA",
            payload: { urls: [item.url], revalidate: true },
          });
        },
      });
      setIsRefetchConfirmOpen(false);
    } catch (e) {
      console.error(e);
    }
  };

  const handleSave = async () => {
    if (isSaving) return;

    const trimmedUrl = url.trim();
    if (trimmedUrl.length === 0) {
      setUrlError("URL is required.");
      return;
    }
    try {
      new URL(trimmedUrl);
    } catch {
      setUrlError("Enter a valid URL (including https://).");
      return;
    }
    setUrlError(null);

    const payload: {
      id: string;
      title?: string;
      url?: string;
      textContent?: string;
      source?: ItemDocType["source"];
      isFavorite?: boolean;
      authorUsername?: string;
      likes?: number;
      upvotes?: number;
    } = { id: item.id };

    if (title.trim() !== originalSnapshot.title)
      payload.title = title.trim();
    if (trimmedUrl !== originalSnapshot.url) payload.url = trimmedUrl;
    if (textContent !== originalSnapshot.textContent)
      payload.textContent = textContent;
    if (source !== originalSnapshot.source) payload.source = source;
    if (isFavorite !== originalSnapshot.isFavorite)
      payload.isFavorite = isFavorite;
    if (authorUsername.trim() !== originalSnapshot.authorUsername)
      payload.authorUsername = authorUsername.trim();
    const likesNum = likes.trim() === "" ? undefined : Number(likes);
    if (likesNum !== undefined && !Number.isNaN(likesNum))
      payload.likes = likesNum;
    const upvotesNum = upvotes.trim() === "" ? undefined : Number(upvotes);
    if (upvotesNum !== undefined && !Number.isNaN(upvotesNum))
      payload.upvotes = upvotesNum;

    if (Object.keys(payload).length <= 1) {
      showSuccessToast("Nothing to save.", { tempo: "quick" });
      onOpenChange(false);
      return;
    }

    setIsSaving(true);
    try {
      await withToast({
        loading: "Saving changes...",
        success: "Tab updated.",
        error: (err) => {
          const msg = resolveToastErrorMessage(err, "Failed to save changes.");
          if (msg.includes("INVALID_URL")) {
            setUrlError("Enter a valid URL (including https://).");
            return "Enter a valid URL (including https://).";
          }
          return msg;
        },
        action: async () => {
          const res = await chrome.runtime.sendMessage({
            service: "items",
            type: "update",
            target: "offscreen",
            payload,
          });
          if (res?.success === false || res?.payload?.success === false) {
            throw new Error(
              res?.error || res?.payload?.error || "Failed to save changes."
            );
          }
        },
      });
      onSaved?.(payload);
      onOpenChange(false);
    } catch (e) {
      console.error(e);
    } finally {
      setIsSaving(false);
    }
  };

  const handleReset = () => {
    setTitle(originalSnapshot.title);
    setUrl(originalSnapshot.url);
    setTextContent(originalSnapshot.textContent);
    setSource(originalSnapshot.source);
    setIsFavorite(originalSnapshot.isFavorite);
    setAuthorUsername(originalSnapshot.authorUsername);
    setLikes(originalSnapshot.likes);
    setUpvotes(originalSnapshot.upvotes);
    setUrlError(null);
  };

  const handleOpenChange = (next: boolean) => {
    if (!next && hasDirtyChanges && !isSaving) {
      const confirm = window.confirm(
        "You have unsaved changes. Discard them and close?"
      );
      if (!confirm) return;
    }
    onOpenChange(next);
  };

  const charCount = textContent.length;

  return (
    <MorphingDialog>
    <Sheet open={open} onOpenChange={handleOpenChange}>
      <SheetContent
        side="right"
        showCloseButton={false}
        aria-describedby={undefined}
        onInteractOutside={(e) => {
          if (isLightboxOpen) e.preventDefault();
        }}
        onEscapeKeyDown={(e) => {
          if (isLightboxOpen) e.preventDefault();
        }}
        className="w-full sm:max-w-lg md:max-w-xl p-0 flex flex-col gap-0 border-l border-border-neutral-faded bg-background-neutral"
      >
        <SheetTitle className="sr-only">{item?.title || "Edit tab"}</SheetTitle>
        {/* Header */}
        <div className="relative px-6 pt-6 pb-5 bg-gradient-to-b from-background-page to-background-neutral border-b border-border-neutral-faded">
          <div className="flex items-start gap-4">
            <div className="flex-shrink-0 w-14 h-14 rounded-xl overflow-hidden bg-background-neutral-faded ring-1 ring-black/10 shadow-sm flex items-center justify-center">
              {item.displayImageUrl ? (
                <img
                  src={item.displayImageUrl}
                  alt={item.title}
                  className="w-full h-full object-cover"
                  onError={(e) => {
                    e.currentTarget.style.display = "none";
                  }}
                />
              ) : item.iconUrl ? (
                <img
                  src={item.iconUrl}
                  alt={item.title}
                  className="w-7 h-7 rounded-md"
                  onError={(e) => {
                    e.currentTarget.style.display = "none";
                  }}
                />
              ) : (
                <WebIcon className="w-6 h-6 text-foreground-icon" />
              )}
            </div>

            <div className="flex-1 min-w-0">
              <input
                ref={titleRef}
                type="text"
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") e.currentTarget.blur();
                }}
                placeholder="Tab title"
                className={cn(
                  "w-full bg-transparent border-0 outline-none px-0 py-0",
                  "text-foreground-neutral font-semibold text-xl leading-tight",
                  "placeholder:text-foreground-tertiary",
                  "focus-visible:outline-none focus-visible:ring-0",
                  "[text-wrap:balance]"
                )}
                style={{ textWrap: "balance" }}
              />
              <a
                href={item.url}
                target="_blank"
                rel="noreferrer"
                onClick={(e) => {
                  e.preventDefault();
                  try {
                    chrome.tabs.create({ url: item.url, active: true });
                  } catch (openErr) {
                    console.error("Failed to open tab from editor", openErr);
                  }
                }}
                className="mt-1 flex items-center gap-1.5 text-xs text-foreground-secondary hover:text-foreground-neutral transition-colors duration-200 group/link max-w-full"
                title={item.url}
              >
                <LinkIcon size={12} className="flex-shrink-0 text-foreground-tertiary group-hover/link:text-accent transition-colors" />
                <span className="truncate">{item.url}</span>
              </a>
              <div className="mt-3 flex items-center gap-2 flex-wrap">
                <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md bg-background-neutral-faded text-[11px] font-medium text-foreground-secondary border border-border-neutral-faded">
                  <span className="w-1.5 h-1.5 rounded-full bg-accent" />
                  {SOURCE_LABEL[source]}
                </span>
                <button
                  type="button"
                  onClick={() => setIsFavorite((v) => !v)}
                  aria-pressed={isFavorite}
                  className={cn(
                    "inline-flex items-center gap-1 px-2 py-0.5 rounded-md text-[11px] font-medium",
                    "border transition-all duration-200 active:scale-[0.96]",
                    isFavorite
                      ? "bg-accent-faded border-accent/30 text-accent"
                      : "bg-background-neutral-faded border-border-neutral-faded text-foreground-secondary hover:text-foreground-neutral"
                  )}
                >
                  <Star
                    size={11}
                    className={cn(
                      isFavorite && "fill-current"
                    )}
                  />
                  {isFavorite ? "Favorite" : "Mark favorite"}
                </button>
                {tags.length > 0 && (
                  <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md bg-background-neutral-faded text-[11px] font-medium text-foreground-secondary border border-border-neutral-faded tabular-nums">
                    <TagIcon size={11} className="text-foreground-tertiary" />
                    {tags.length} {tags.length === 1 ? "tag" : "tags"}
                  </span>
                )}
              </div>
            </div>

            <SheetClose asChild>
              <button
                type="button"
                aria-label="Close editor"
                className={cn(
                  "flex-shrink-0 w-10 h-10 -m-2 rounded-lg",
                  "flex items-center justify-center",
                  "text-foreground-secondary hover:text-foreground-neutral",
                  "hover:bg-background-highlight-faded transition-all duration-200",
                  "active:scale-[0.96] outline-none focus-visible:ring-2 focus-visible:ring-border-neutral/60"
                )}
              >
                <X size={18} />
              </button>
            </SheetClose>
          </div>
        </div>

        {/* Body */}
        <ScrollArea className="flex-1 min-h-0">
          <div className="px-6 py-6 space-y-7">
            {/* Details section */}
            <section className="space-y-3">
              <SectionHeading icon={<LinkIcon size={14} />} label="Details" />

              <div className="rounded-xl bg-background-neutral-faded/50 p-4 space-y-4 shadow-[0_1px_2px_rgba(0,0,0,0.04)]">
                <Field label="URL" error={urlError}>
                  <Input
                    type="url"
                    value={url}
                    onChange={(e) => {
                      setUrl(e.target.value);
                      if (urlError) setUrlError(null);
                    }}
                    aria-invalid={!!urlError}
                    placeholder="https://example.com"
                    className="bg-background-neutral"
                  />
                </Field>

                <Field label="Source">
                  <Select
                    value={source}
                    onValueChange={(v) => setSource(v as ItemDocType["source"])}
                  >
                    <SelectTrigger className="w-full bg-background-neutral h-10">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {SOURCE_OPTIONS.map((opt) => (
                        <SelectItem key={opt.value} value={opt.value}>
                          {opt.label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </Field>

                <Field label="Author">
                  <Input
                    type="text"
                    value={authorUsername}
                    onChange={(e) => setAuthorUsername(e.target.value)}
                    placeholder="@username (optional)"
                    className="bg-background-neutral"
                  />
                </Field>

                <div className="grid grid-cols-2 gap-3">
                  <Field label="Likes">
                    <Input
                      type="number"
                      min={0}
                      value={likes}
                      onChange={(e) => setLikes(e.target.value)}
                      placeholder="0"
                      className="bg-background-neutral tabular-nums"
                    />
                  </Field>
                  <Field label="Upvotes">
                    <Input
                      type="number"
                      min={0}
                      value={upvotes}
                      onChange={(e) => setUpvotes(e.target.value)}
                      placeholder="0"
                      className="bg-background-neutral tabular-nums"
                    />
                  </Field>
                </div>
              </div>
            </section>

            {/* Notes section */}
            <section className="space-y-3">
              <SectionHeading
                icon={<StickyNote size={14} />}
                label="Notes"
                trailing={
                  <span className="text-[11px] text-foreground-tertiary tabular-nums">
                    {charCount} {charCount === 1 ? "char" : "chars"}
                  </span>
                }
              />
              <div className="rounded-xl bg-background-neutral-faded/50 p-4 shadow-[0_1px_2px_rgba(0,0,0,0.04)]">
                <textarea
                  value={textContent}
                  onChange={(e) => setTextContent(e.target.value)}
                  placeholder="Add notes, context, or thoughts about this tab..."
                  className={cn(
                    "w-full min-h-[120px] resize-y",
                    "rounded-lg bg-background-neutral",
                    "border border-border-neutral-faded/60 px-3.5 py-2.5",
                    "text-sm leading-relaxed text-foreground-neutral",
                    "placeholder:text-foreground-secondary",
                    "outline-none transition-[border-color,box-shadow]",
                    "focus-visible:border-accent/45 focus-visible:ring-[3px] focus-visible:ring-accent/15"
                  )}
                />
              </div>
            </section>

            {/* Media section */}
            <section className="space-y-3">
              <SectionHeading
                icon={<ImageIcon size={14} />}
                label="Media"
                trailing={
                  <div className="flex items-center gap-1.5 text-[11px] text-foreground-tertiary tabular-nums">
                    <span>
                      {resolvedMedia.length > 0
                        ? `${resolvedMedia.length} item${resolvedMedia.length > 1 ? "s" : ""}`
                        : "No media"}
                    </span>
                  </div>
                }
              />

              {/* Big preview stage */}
              {resolvedMedia.length > 0 ? (() => {
                const currentMedia = resolvedMedia[activeMediaIndex];
                const isInteractive = currentMedia?.type === "video";
                const isVertical = currentMedia?.isVertical || (currentMedia?.width && currentMedia?.height ? currentMedia.height > currentMedia.width : false);
                const hasKnownDims = !!(currentMedia?.width && currentMedia?.height);
                const stageAspect = hasKnownDims
                  ? `${currentMedia.width} / ${currentMedia.height}`
                  : isVertical
                    ? "9 / 16"
                    : currentMedia?.type === "video"
                      ? "16 / 9"
                      : null;
                return (
                <MorphingDialogTrigger
                  onOpen={() => setIsLightboxOpen(true)}
                  className={cn(
                    "group/media relative flex items-center justify-center rounded-xl overflow-hidden",
                    "border border-border-neutral-faded bg-background-page",
                    "transition-all duration-200",
                    // Cap the stage height so tall media doesn't push the
                    // editor body off-screen. Applies to both known-aspect
                    // (height derived from width) and unknown-aspect cases.
                    "max-h-[55vh]",
                    !isInteractive && "cursor-zoom-in hover:border-border-neutral hover:shadow-md hover:shadow-foreground-muted/20",
                    isInteractive && "cursor-default",
                    isVertical && "mx-auto max-w-[420px]"
                  )}
                  style={stageAspect ? { aspectRatio: stageAspect } : undefined}
                >
                  {mediaErrorIndexes.has(activeMediaIndex) ? (
                    <div className="w-full h-full flex flex-col items-center justify-center gap-1.5 text-foreground-tertiary">
                      <AlertCircle size={24} />
                      <span className="text-xs">Failed to load</span>
                    </div>
                  ) : currentMedia?.type === "video" ? (
                    currentMedia?.embedType === "iframe" ? (
                      <iframe
                        src={currentMedia.src}
                        title={currentMedia?.altText || `Embedded media ${activeMediaIndex + 1}`}
                        loading="lazy"
                        allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share"
                        allowFullScreen
                        referrerPolicy="strict-origin-when-cross-origin"
                        sandbox={getExternalEmbedSandbox(currentMedia.src, {
                          allowPresentation: true,
                          allowPopups: true,
                        })}
                        className="w-full h-full bg-foreground-darkest/5"
                        onError={() =>
                          setMediaErrorIndexes((prev) => new Set(prev).add(activeMediaIndex))
                        }
                        onClick={(e) => e.stopPropagation()}
                        onPointerDown={(e) => e.stopPropagation()}
                      />
                    ) : (
                      <div className="relative w-full h-full flex items-center justify-center">
                        <video
                          controls
                          preload="metadata"
                          playsInline
                          className="max-h-full max-w-full object-contain bg-foreground-darkest/5"
                          onError={() =>
                            setMediaErrorIndexes((prev) => new Set(prev).add(activeMediaIndex))
                          }
                          onClick={(e) => e.stopPropagation()}
                        >
                          <source src={currentMedia.src} />
                        </video>
                      </div>
                    )
                  ) : (
                    <img
                      src={currentMedia?.src}
                      alt={currentMedia?.altText || `Media ${activeMediaIndex + 1}`}
                      loading="lazy"
                      className={cn(
                        "object-contain bg-foreground-darkest/5",
                        stageAspect ? "w-full h-full" : "w-full h-auto max-h-[55vh]"
                      )}
                      onError={() =>
                        setMediaErrorIndexes((prev) => new Set(prev).add(activeMediaIndex))
                      }
                    />
                  )}

                  {/* Dedicated expand affordance — opens lightbox.
                      Always visible for interactive media (stage isn't a click target);
                      hover-revealed for static images (whole stage already opens lightbox). */}
                  {!mediaErrorIndexes.has(activeMediaIndex) && (
                    <button
                      type="button"
                      aria-label="Expand media"
                      title="Expand"
                      className={cn(
                        "absolute bottom-2 right-2 z-20 flex items-center gap-1.5",
                        "px-2.5 h-8 rounded-full",
                        "bg-background-neutral/90 backdrop-blur-md",
                        "border border-border-neutral-faded/70 shadow-sm",
                        "text-foreground-secondary hover:text-foreground-primary hover:bg-background-neutral",
                        "transition-all duration-200 active:scale-[0.94] cursor-pointer",
                        isInteractive
                          ? "opacity-100"
                          : "opacity-0 group-hover/media:opacity-100 focus-visible:opacity-100"
                      )}
                    >
                      <Maximize2 size={14} />
                      <span className="text-[11px] font-medium">Expand</span>
                    </button>
                  )}

                  {/* Top-right action cluster */}
                  <div
                    onClick={(e) => e.stopPropagation()}
                    className="absolute top-2 right-2 z-10 flex items-center gap-1.5 opacity-0 group-hover/media:opacity-100 transition-opacity duration-200"
                  >
                    {/* Primary badge — shown for default media (index 0) */}
                    {resolvedMeta[activeMediaIndex]?.isPrimary && (
                      <div className={cn(
                        "px-2 py-1 rounded-full",
                        "bg-background-neutral/85 backdrop-blur-sm",
                        "border border-border-neutral-faded/60",
                        "text-[10px] font-medium text-foreground-secondary",
                        "flex items-center gap-1"
                      )}>
                        <Star size={10} className="fill-current text-accent" />
                        <span>Default</span>
                      </div>
                    )}
                    {/* Replace — only for non-primary, real media entries */}
                    {resolvedMeta[activeMediaIndex] && !resolvedMeta[activeMediaIndex].isPrimary && resolvedMeta[activeMediaIndex].index >= 0 && (
                      <button
                        type="button"
                        onClick={(e) => {
                          e.stopPropagation();
                          setReplaceIndex(resolvedMeta[activeMediaIndex].index);
                          fileInputRef.current?.click();
                        }}
                        aria-label="Replace media"
                        className={cn(
                          "w-7 h-7 rounded-full flex items-center justify-center",
                          "bg-background-neutral/85 backdrop-blur-sm",
                          "border border-border-neutral-faded/60",
                          "text-foreground-secondary hover:text-foreground-primary hover:bg-background-neutral",
                          "transition-all duration-200 active:scale-[0.92] cursor-pointer"
                        )}
                      >
                        <RefreshCw size={13} />
                      </button>
                    )}
                    {/* More menu — only for non-primary, real media entries */}
                    {resolvedMeta[activeMediaIndex] && !resolvedMeta[activeMediaIndex].isPrimary && resolvedMeta[activeMediaIndex].index >= 0 && (
                      <DropdownMenu open={isMediaMenuOpen} onOpenChange={setIsMediaMenuOpen}>
                        <DropdownMenuTrigger asChild>
                          <button
                            type="button"
                            onClick={(e) => e.stopPropagation()}
                            aria-label="More actions"
                            className={cn(
                              "w-7 h-7 rounded-full flex items-center justify-center",
                              "bg-background-neutral/85 backdrop-blur-sm",
                              "border border-border-neutral-faded/60",
                              "text-foreground-secondary hover:text-foreground-primary hover:bg-background-neutral",
                              "transition-all duration-200 active:scale-[0.92] cursor-pointer"
                            )}
                          >
                            <MoreHorizontal size={14} />
                          </button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="end" className="min-w-[180px] z-[200]">
                          <DropdownMenuItem
                            onSelect={() => handleSetPrimaryMedia(resolvedMeta[activeMediaIndex].index)}
                          >
                            <Star size={14} />
                            <span>Set as default display</span>
                          </DropdownMenuItem>
                          <DropdownMenuSeparator />
                          <DropdownMenuItem
                            onSelect={() => {
                              const idx = resolvedMeta[activeMediaIndex].index;
                              setReplaceIndex(idx);
                              fileInputRef.current?.click();
                            }}
                          >
                            <Upload size={14} />
                            <span>Replace with file</span>
                          </DropdownMenuItem>
                          <DropdownMenuItem
                            onSelect={() => {
                              setReplaceIndex(resolvedMeta[activeMediaIndex].index);
                              setIsAddMediaOpen(true);
                              setMediaUrl("");
                            }}
                          >
                            <LinkIcon2 size={14} />
                            <span>Replace with URL</span>
                          </DropdownMenuItem>
                          <DropdownMenuSeparator />
                          <DropdownMenuItem
                            onSelect={() => handleRemoveMedia(resolvedMeta[activeMediaIndex].index)}
                            className="text-foreground-danger"
                          >
                            <Trash2 size={14} />
                            <span>Delete</span>
                          </DropdownMenuItem>
                        </DropdownMenuContent>
                      </DropdownMenu>
                    )}
                    {/* Quick delete — only for non-primary, real media entries */}
                    {resolvedMeta[activeMediaIndex] && !resolvedMeta[activeMediaIndex].isPrimary && resolvedMeta[activeMediaIndex].index >= 0 && (
                      <button
                        type="button"
                        onClick={(e) => {
                          e.stopPropagation();
                          handleRemoveMedia(resolvedMeta[activeMediaIndex].index);
                        }}
                        aria-label="Delete media"
                        className={cn(
                          "w-7 h-7 rounded-full flex items-center justify-center",
                          "bg-background-neutral/85 backdrop-blur-sm",
                          "border border-border-neutral-faded/60",
                          "text-foreground-secondary hover:text-foreground-danger hover:bg-background-danger-faded",
                          "transition-all duration-200 active:scale-[0.92] cursor-pointer"
                        )}
                      >
                        <X size={14} />
                      </button>
                    )}
                  </div>

                  {/* Type indicator — bottom-left */}
                  {resolvedMedia[activeMediaIndex]?.type === "video" && (
                    <div
                      onClick={(e) => e.stopPropagation()}
                      className="absolute bottom-2 left-2 z-10 w-7 h-7 rounded-full bg-background-neutral/85 backdrop-blur-sm flex items-center justify-center"
                    >
                      <Video size={13} className="text-foreground-secondary" />
                    </div>
                  )}

                  {/* Counter pill — top-left (kept away from bottom-right Expand button) */}
                  {resolvedMedia.length > 1 && (
                    <div
                      onClick={(e) => e.stopPropagation()}
                      className="absolute top-2 left-2 z-10 px-2 py-1 rounded-full bg-background-neutral/85 backdrop-blur-sm border border-border-neutral-faded/60 text-[11px] text-foreground-secondary tabular-nums"
                    >
                      {activeMediaIndex + 1} / {resolvedMedia.length}
                    </div>
                  )}

                  {/* Prev / Next chevrons */}
                  {resolvedMedia.length > 1 && (
                    <>
                      <button
                        type="button"
                        onClick={(e) => {
                          e.stopPropagation();
                          setActiveMediaIndex((i) =>
                            i === 0 ? resolvedMedia.length - 1 : i - 1
                          );
                        }}
                        aria-label="Previous media"
                        className={cn(
                          "absolute left-2 top-1/2 -translate-y-1/2 z-10 w-9 h-9 rounded-full",
                          "flex items-center justify-center",
                          "bg-background-neutral/85 backdrop-blur-sm",
                          "border border-border-neutral-faded/60",
                          "text-foreground-secondary hover:text-foreground-primary hover:bg-background-neutral",
                          "shadow-sm transition-all duration-200",
                          "opacity-0 group-hover/media:opacity-100",
                          "active:scale-[0.92] cursor-pointer"
                        )}
                      >
                        <ChevronLeft size={18} />
                      </button>
                      <button
                        type="button"
                        onClick={(e) => {
                          e.stopPropagation();
                          setActiveMediaIndex((i) =>
                            i === resolvedMedia.length - 1 ? 0 : i + 1
                          );
                        }}
                        aria-label="Next media"
                        className={cn(
                          "absolute right-2 top-1/2 -translate-y-1/2 z-10 w-9 h-9 rounded-full",
                          "flex items-center justify-center",
                          "bg-background-neutral/85 backdrop-blur-sm",
                          "border border-border-neutral-faded/60",
                          "text-foreground-secondary hover:text-foreground-primary hover:bg-background-neutral",
                          "shadow-sm transition-all duration-200",
                          "opacity-0 group-hover/media:opacity-100",
                          "active:scale-[0.92] cursor-pointer"
                        )}
                      >
                        <ChevronRight size={18} />
                      </button>
                    </>
                  )}
                </MorphingDialogTrigger>
                );
              })() : (
                <div className="aspect-[4/3] rounded-xl border border-dashed border-border-neutral-faded bg-background-neutral-faded/30 flex flex-col items-center justify-center gap-2 text-foreground-tertiary">
                  <ImageIcon size={28} className="opacity-50" />
                  <span className="text-xs">No media yet — add some below</span>
                </div>
              )}

              {/* Thumbnails strip */}
              {resolvedMedia.length > 1 && (
                <div className="flex items-center gap-2 overflow-x-auto pb-1 -mx-1 px-1">
                  {resolvedMedia.map((entry, i) => {
                    const isActive = i === activeMediaIndex;
                    const isPrimary = resolvedMeta[i]?.isPrimary;
                    return (
                      <button
                        type="button"
                        key={`${i}-${entry.src}`}
                        onClick={() => setActiveMediaIndex(i)}
                        className={cn(
                          "group/thumb relative flex-shrink-0 w-16 h-12 rounded-md overflow-hidden",
                          "border transition-all duration-200 cursor-pointer",
                          isActive
                            ? "border-accent ring-1 ring-accent/30"
                            : "border-border-neutral-faded hover:border-border-neutral"
                        )}
                      >
                        {entry.type === "video" ? (
                          entry.embedType === "iframe" && entry.thumbnailSrc ? (
                            <img
                              src={entry.thumbnailSrc}
                              alt={entry.altText || `Media ${i + 1}`}
                              loading="lazy"
                              className="w-full h-full object-cover"
                            />
                          ) : (
                            <video
                              preload="metadata"
                              muted
                              className="w-full h-full object-cover"
                            >
                              <source src={entry.src} />
                            </video>
                          )
                        ) : (
                          <img
                            src={entry.src}
                            alt={entry.altText || `Media ${i + 1}`}
                            loading="lazy"
                            className="w-full h-full object-cover"
                          />
                        )}
                        {isPrimary && (
                          <span className="absolute top-0.5 left-0.5 px-1 py-0.5 rounded-sm bg-accent/90 backdrop-blur-sm text-[8px] uppercase tracking-wide text-background-neutral font-medium flex items-center gap-0.5">
                            <Star size={7} className="fill-current" />
                            Default
                          </span>
                        )}
                      </button>
                    );
                  })}
                </div>
              )}

              {/* Extracted OCR text for the active media */}
              {(() => {
                const meta = resolvedMeta[activeMediaIndex];
                const original =
                  meta && meta.index >= 0 ? (mediaItems || [])[meta.index] : undefined;
                const isImage = resolvedMedia[activeMediaIndex]?.type === "image";
                if (!isImage) return null;
                return <OcrExtractedText ocr={original?.ocr} />;
              })()}

              {/* Action row — Add media + Paste URL */}
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
                  <LinkIcon2 size={14} />
                  <span>Paste URL</span>
                </Button>
              </div>

              {/* Inline URL input */}
              {isAddMediaOpen && (
                <div className="flex items-center gap-2 animate-in fade-in-0 slide-in-from-top-1 duration-200">
                  <Input
                    type="url"
                    value={mediaUrl}
                    onChange={(e) => setMediaUrl(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") handleAddMediaByUrl();
                      if (e.key === "Escape") { setIsAddMediaOpen(false); setMediaUrl(""); }
                    }}
                    placeholder={
                      replaceIndex !== null
                        ? "Paste replacement URL..."
                        : "Paste image or video URL..."
                    }
                    autoFocus
                    className="bg-background-neutral h-9"
                  />
                  <Button
                    type="button"
                    variant="default"
                    size="sm"
                    onClick={handleAddMediaByUrl}
                    disabled={isAddingMedia || mediaUrl.trim().length === 0}
                    className="h-9 px-3 active:scale-[0.96] transition-transform"
                  >
                    {isAddingMedia ? (
                      <Loader2 size={14} className="animate-spin" />
                    ) : (
                      <Plus size={14} />
                    )}
                    <span>{replaceIndex !== null ? "Replace" : "Add"}</span>
                  </Button>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    onClick={() => { setIsAddMediaOpen(false); setMediaUrl(""); setReplaceIndex(null); }}
                    className="h-9 px-2"
                  >
                    Cancel
                  </Button>
                </div>
              )}

              <input
                ref={fileInputRef}
                type="file"
                accept="image/*,video/*"
                multiple
                className="hidden"
                onChange={(e) => {
                  const files = Array.from(e.target.files || []);
                  if (!files.length) return;
                  if (replaceIndex !== null) {
                    handleUploadFiles(files.slice(0, 1), replaceIndex);
                  } else {
                    handleUploadFiles(files);
                  }
                }}
              />

              {/* Refetch metadata — subtle link */}
              <button
                type="button"
                onClick={() => setIsRefetchConfirmOpen(true)}
                className={cn(
                  "flex items-center gap-1.5 text-[11px] font-medium",
                  "text-foreground-tertiary hover:text-foreground-warning",
                  "transition-colors duration-200 cursor-pointer"
                )}
              >
                <RefreshCw size={11} />
                Refetch from source — overrides all metadata
              </button>
            </section>

            {/* Tags section */}
            <section className="space-y-3">
              <SectionHeading
                icon={<TagIcon size={14} />}
                label="Tags"
                trailing={
                  tags.length > 0 ? (
                    <span className="text-[11px] text-foreground-tertiary tabular-nums">
                      {tags.length}
                    </span>
                  ) : null
                }
              />

              <div className="rounded-xl bg-background-neutral-faded/50 p-4 space-y-3 shadow-[0_1px_2px_rgba(0,0,0,0.04)]">
                <div className="flex items-center gap-2">
                  <Input
                    type="text"
                    value={newTag}
                    onChange={(e) => setNewTag(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") {
                        e.preventDefault();
                        handleAddTag();
                      }
                    }}
                    placeholder="Add a tag..."
                    className="bg-background-neutral h-9"
                  />
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={handleAddTag}
                    disabled={isAddingTag || newTag.trim().length === 0}
                    className="h-9 px-3 active:scale-[0.96] transition-transform"
                  >
                    {isAddingTag ? (
                      <Loader2 size={14} className="animate-spin" />
                    ) : (
                      <Plus size={14} />
                    )}
                    <span className="hidden sm:inline">Add</span>
                  </Button>
                </div>

                {tags.length === 0 ? (
                  <p className="text-xs text-foreground-tertiary py-1">
                    No tags yet. Tags help you find this tab faster.
                  </p>
                ) : (
                  <div className="flex flex-wrap gap-1.5">
                    {tags.map((tag) => (
                      <span
                        key={tag.id}
                        style={tagChipStyle(tag.color)}
                        className={cn(
                          "group/tag inline-flex items-center gap-1.5 pl-2 pr-1 py-1 rounded-full border",
                          "text-xs font-medium text-foreground-neutral transition-all duration-200",
                          tag.color ? "" : "bg-background-neutral border-border-neutral-faded hover:border-border-neutral"
                        )}
                      >
                        <span className="size-2 shrink-0 rounded-full" style={tagDotStyle(tag.color)} />
                        <span className="truncate max-w-[180px]">{tag.name}</span>
                        <button
                          type="button"
                          onClick={() => handleRemoveTag(tag.id, tag.name)}
                          aria-label={`Remove tag ${tag.name}`}
                          className={cn(
                            "flex-shrink-0 w-5 h-5 rounded-full",
                            "flex items-center justify-center",
                            "text-foreground-tertiary hover:text-foreground-danger hover:bg-background-danger-faded",
                            "transition-all duration-150 active:scale-[0.96]"
                          )}
                        >
                          <X size={11} />
                        </button>
                      </span>
                    ))}
                  </div>
                )}
              </div>
            </section>

            {/* Metadata section — read only */}
            <section className="space-y-3">
              <SectionHeading
                icon={<Hash size={14} />}
                label="Metadata"
                trailing={
                  <span className="text-[11px] text-foreground-tertiary font-normal normal-tracking">
                    read-only
                  </span>
                }
              />
              <div className="rounded-xl bg-background-neutral-faded/50 p-4 shadow-[0_1px_2px_rgba(0,0,0,0.04)]">
                <dl className="grid grid-cols-1 sm:grid-cols-2 gap-x-6 gap-y-3">
                  <MetaItem
                    icon={<Calendar size={13} />}
                    label="Created"
                    value={formatDateTime(item.createdAt)}
                  />
                  <MetaItem
                    icon={<Clock size={13} />}
                    label="Updated"
                    value={formatDateTime(item.updatedAt)}
                  />
                  <MetaItem
                    icon={<FolderIcon size={13} />}
                    label="Folder ID"
                    value={item.folderId}
                    mono
                  />
                  <MetaItem
                    icon={<Hash size={13} />}
                    label="Item ID"
                    value={item.id}
                    mono
                  />
                </dl>
              </div>
            </section>
          </div>
        </ScrollArea>

        {/* Footer */}
        <div className="px-6 py-4 border-t border-border-neutral-faded bg-background-neutral flex items-center justify-between gap-3">
          <div className="flex items-center gap-2 min-w-0">
            {hasDirtyChanges ? (
              <span className="inline-flex items-center gap-1.5 text-xs text-foreground-secondary">
                <span className="w-1.5 h-1.5 rounded-full bg-accent animate-pulse" />
                Unsaved changes
              </span>
            ) : (
              <span className="text-xs text-foreground-tertiary">
                {isSaving ? "Saving..." : "All changes saved"}
              </span>
            )}
          </div>
          <div className="flex items-center gap-2 flex-shrink-0">
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={handleReset}
              disabled={isSaving || !hasDirtyChanges}
              className="h-9 gap-1.5 active:scale-[0.96] transition-transform"
            >
              <RotateCcw size={14} />
              <span className="hidden sm:inline">Reset</span>
            </Button>
            <Button
              type="button"
              variant="default"
              size="sm"
              onClick={handleSave}
              disabled={isSaving || !hasDirtyChanges}
              className="h-9 gap-1.5 active:scale-[0.96] transition-transform min-w-[96px]"
            >
              {isSaving ? (
                <Loader2 size={14} className="animate-spin" />
              ) : (
                <Save size={14} />
              )}
              <span>{isSaving ? "Saving..." : "Save changes"}</span>
            </Button>
          </div>
         </div>
      </SheetContent>

       <ConfirmDialog
        open={isRefetchConfirmOpen}
        onOpenChange={setIsRefetchConfirmOpen}
        title="Refetch metadata from source?"
        description="This will override ALL data for this tab — title, media, description, and other metadata will be replaced with fresh data from the source URL. This cannot be undone."
        confirmLabel="Refetch & override"
        cancelLabel="Cancel"
        variant="warning"
        onConfirm={handleRefetchMetadata}
      />

      <MediaLightboxModal
        entries={resolvedMedia}
        initialIndex={activeMediaIndex}
        metadata={lightboxMetadata}
        onClose={() => setIsLightboxOpen(false)}
      />
    </Sheet>
    </MorphingDialog>
  );
};

const SectionHeading = ({
  icon,
  label,
  trailing,
}: {
  icon: React.ReactNode;
  label: string;
  trailing?: React.ReactNode;
}) => (
  <div className="flex items-center justify-between gap-2">
    <h3
      className={cn(
        "flex items-center gap-2 text-sm font-semibold text-foreground-neutral",
        "tracking-[-0.005em]"
      )}
      style={{ textWrap: "balance" }}
    >
      <span className="text-foreground-tertiary">{icon}</span>
      {label}
    </h3>
    {trailing}
  </div>
);

const Field = ({
  label,
  children,
  error,
}: {
  label: string;
  children: React.ReactNode;
  error?: string | null;
}) => (
  <div className="space-y-1.5">
    <label className="text-xs font-medium text-foreground-secondary">{label}</label>
    {children}
    {error && (
      <p className="flex items-center gap-1.5 text-xs text-foreground-danger">
        <AlertCircle size={12} className="flex-shrink-0" />
        {error}
      </p>
    )}
  </div>
);

const MetaItem = ({
  icon,
  label,
  value,
  mono,
}: {
  icon: React.ReactNode;
  label: string;
  value: string;
  mono?: boolean;
}) => (
  <div className="min-w-0">
    <dt className="flex items-center gap-1.5 text-[11px] font-medium text-foreground-tertiary uppercase tracking-wider">
      <span className="text-foreground-tertiary/70">{icon}</span>
      {label}
    </dt>
    <dd
      className={cn(
        "mt-0.5 text-sm text-foreground-secondary truncate tabular-nums",
        mono && "font-mono text-xs"
      )}
      title={value}
    >
      {value}
    </dd>
  </div>
);

export default TabEditorSheet;
