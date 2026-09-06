import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  LightboxEntry,
  LightboxMetadata,
} from "@components/TabGroups/MediaLightboxModal";
import type { ItemDocType } from "@src/schemas/item_schema";
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
import { normalizeIframeEmbedUrl } from "@src/utils/media-embed";
import {
  parseOcrResponse,
  parseTagListResponse,
  requireCommandSuccess,
} from "./tab-editor/contracts";
import type { TabEditorUpdate, TagEntry } from "./tab-editor/model";
import { TabEditorView } from "./tab-editor/tab-editor-view";

interface TabEditorSheetProps {
  item: ItemDocType;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSaved?: (updated: Partial<ItemDocType>) => void;
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
  const [authorUsername, setAuthorUsername] = useState(
    item.authorUsername ?? "",
  );
  const [likes, setLikes] = useState<string>(
    item.likes === undefined ? "" : String(item.likes),
  );
  const [upvotes, setUpvotes] = useState<string>(
    item.upvotes === undefined ? "" : String(item.upvotes),
  );

  const [tags, setTags] = useState<TagEntry[]>([]);
  const [newTag, setNewTag] = useState("");
  const [isAddingTag, setIsAddingTag] = useState(false);
  const [mediaItems, setMediaItems] = useState<ItemDocType["media"]>(
    item.media || [],
  );
  const [isAddMediaOpen, setIsAddMediaOpen] = useState(false);
  const [mediaUrl, setMediaUrl] = useState("");
  const [isAddingMedia, setIsAddingMedia] = useState(false);
  const [replaceIndex, setReplaceIndex] = useState<number | null>(null);
  const [isRefetchConfirmOpen, setIsRefetchConfirmOpen] = useState(false);
  const [mediaErrorIndexes, setMediaErrorIndexes] = useState<Set<number>>(
    new Set(),
  );
  const fileInputRef = useRef<HTMLInputElement>(null);

  const [resolvedMedia, setResolvedMedia] = useState<LightboxEntry[]>([]);
  const [resolvedMeta, setResolvedMeta] = useState<
    { isPrimary: boolean; index: number }[]
  >([]);
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
      likes: item.likes === undefined ? "" : String(item.likes),
      upvotes: item.upvotes === undefined ? "" : String(item.upvotes),
    }),
    [item],
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
      setLikes(item.likes === undefined ? "" : String(item.likes));
      setUpvotes(item.upvotes === undefined ? "" : String(item.upvotes));
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

      const currentMediaItems = mediaItems ?? [];
      for (let i = 0; i < currentMediaItems.length; i++) {
        const m = currentMediaItems[i];
        if (!m) continue;
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
          const checkUrls = [item.url, m.originalUrl, m.pageUrl];
          for (const u of checkUrls) {
            if (!u) continue;
            const lower = u.toLowerCase();
            if (lower.includes("/shorts/")) return true;
            if (lower.includes("/reel/") || lower.includes("/reels/"))
              return true;
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

      if (item.displayImageUrl && !seenUrls.has(item.displayImageUrl)) {
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
    try {
      hostname = new URL(item.url).hostname;
    } catch {
      hostname = item.url;
    }
    return {
      title: item.title,
      hostname,
      url: item.url,
      iconUrl: item.iconUrl,
      source: item.source,
      date: new Intl.DateTimeFormat(undefined, {
        day: "numeric",
        month: "short",
        year: "numeric",
      }).format(new Date(item.createdAt)),
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
      setTags(parseTagListResponse(res));
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
          requireCommandSuccess(res, "Failed to add tag.");
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
          requireCommandSuccess(res, "Failed to remove tag.");
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
      const response = await chrome.runtime.sendMessage({
        service: "ocr",
        type: "extractImageText",
        target: "offscreen",
        payload: { url: imageUrl },
      });
      const payload = parseOcrResponse(response);
      if (!payload) return;
      const OCR_THRESHOLD = 0.3;
      const text = payload.text.trim();
      const confidence = payload.confidence;
      if (!text) return;
      if (confidence !== undefined && confidence < OCR_THRESHOLD) return;

      const currentText = (textContent || "").trim();
      if (currentText && currentText.includes(text)) return;
      const newText = currentText
        ? `${currentText}\n\n--- OCR ---\n${text}`
        : `--- OCR ---\n${text}`;
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
      const category: MediaCategory =
        type === "video" ? "video" : isGifUrl(trimmed) ? "gif" : "image";
      if (
        !canAddMedia(
          (mediaItems || []).map((m) => ({
            type: m.type,
            originalUrl: m.originalUrl,
          })),
          category,
        )
      ) {
        showErrorToast(
          `${category}s limit reached (max ${MEDIA_LIMITS[category]}).`,
          { tempo: "quick" },
        );
        return;
      }
    }

    setIsAddingMedia(true);
    try {
      if (isReplace && replaceIndex !== null) {
        await withToast({
          loading: "Replacing media...",
          success: "Media replaced.",
          error: (err) =>
            resolveToastErrorMessage(err, "Failed to replace media."),
          action: async () => {
            const res = await chrome.runtime.sendMessage({
              service: "items",
              type: "replaceMedia",
              target: "offscreen",
              payload: { id: item.id, index: replaceIndex, url: trimmed, type },
            });
            requireCommandSuccess(res, "Failed to replace media.");
          },
        });
        setMediaItems(
          (mediaItems || []).map((m, i) =>
            i === replaceIndex
              ? { type, originalUrl: trimmed, storageType: "hotlink" as const }
              : m,
          ),
        );
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
            requireCommandSuccess(res, "Failed to add media.");
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
    const isReplace = indexToReplace !== undefined;

    if (!isReplace) {
      for (const file of files) {
        const type = inferMediaType("", file);
        const category: MediaCategory =
          type === "video" ? "video" : isGifUrl(file.name) ? "gif" : "image";
        if (
          !canAddMedia(
            (mediaItems || []).map((m) => ({
              type: m.type,
              originalUrl: m.originalUrl,
            })),
            category,
          )
        ) {
          showErrorToast(
            `${category}s limit reached (max ${MEDIA_LIMITS[category]}).`,
            { tempo: "quick" },
          );
          return;
        }
      }
    }

    setIsAddingMedia(true);

    try {
      if (indexToReplace !== undefined) {
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
          i === indexToReplace ? newEntry : m,
        );
        await withToast({
          loading: "Replacing media...",
          success: "Media replaced.",
          error: (err) =>
            resolveToastErrorMessage(err, "Failed to replace media."),
          action: async () => {
            const res = await chrome.runtime.sendMessage({
              service: "items",
              type: "updateMedia",
              target: "offscreen",
              payload: { id: item.id, media: next, expectedMedia },
            });
            requireCommandSuccess(res, "Failed to replace media.");
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
          loading:
            files.length > 1
              ? `Uploading ${files.length} files...`
              : "Uploading media...",
          success:
            files.length > 1
              ? `${files.length} files uploaded.`
              : "Media uploaded.",
          error: (err) =>
            resolveToastErrorMessage(err, "Failed to upload media."),
          action: async () => {
            const res = await chrome.runtime.sendMessage({
              service: "items",
              type: "updateMedia",
              target: "offscreen",
              payload: { id: item.id, media: next, expectedMedia },
            });
            requireCommandSuccess(res, "Failed to upload media.");
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
        error: (err) =>
          resolveToastErrorMessage(err, "Failed to remove media."),
        successTempo: "quick",
        action: async () => {
          const res = await chrome.runtime.sendMessage({
            service: "items",
            type: "removeMedia",
            target: "offscreen",
            payload: { id: item.id, index },
          });
          requireCommandSuccess(res, "Failed to remove media.");
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
        error: (err) =>
          resolveToastErrorMessage(err, "Failed to set default media."),
        successTempo: "quick",
        action: async () => {
          const res = await chrome.runtime.sendMessage({
            service: "items",
            type: "updateMedia",
            target: "offscreen",
            payload: { id: item.id, media: arr, expectedMedia },
          });
          requireCommandSuccess(res, "Failed to set default media.");
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
        error: (err) =>
          resolveToastErrorMessage(err, "Failed to refetch metadata."),
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

    const payload: TabEditorUpdate = { id: item.id };

    if (title.trim() !== originalSnapshot.title) payload.title = title.trim();
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
          requireCommandSuccess(res, "Failed to save changes.");
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
        "You have unsaved changes. Discard them and close?",
      );
      if (!confirm) return;
    }
    onOpenChange(next);
  };

  const charCount = textContent.length;

  return (
    <TabEditorView
      item={item}
      open={open}
      handleOpenChange={handleOpenChange}
      title={title}
      setTitle={setTitle}
      titleRef={titleRef}
      url={url}
      setUrl={setUrl}
      urlError={urlError}
      setUrlError={setUrlError}
      source={source}
      setSource={setSource}
      isFavorite={isFavorite}
      setIsFavorite={setIsFavorite}
      authorUsername={authorUsername}
      setAuthorUsername={setAuthorUsername}
      likes={likes}
      setLikes={setLikes}
      upvotes={upvotes}
      setUpvotes={setUpvotes}
      textContent={textContent}
      setTextContent={setTextContent}
      charCount={charCount}
      tags={tags}
      newTag={newTag}
      setNewTag={setNewTag}
      isAddingTag={isAddingTag}
      handleAddTag={handleAddTag}
      handleRemoveTag={handleRemoveTag}
      mediaItems={mediaItems}
      resolvedMedia={resolvedMedia}
      resolvedMeta={resolvedMeta}
      activeMediaIndex={activeMediaIndex}
      setActiveMediaIndex={setActiveMediaIndex}
      mediaErrorIndexes={mediaErrorIndexes}
      setMediaErrorIndexes={setMediaErrorIndexes}
      isMediaMenuOpen={isMediaMenuOpen}
      setIsMediaMenuOpen={setIsMediaMenuOpen}
      isLightboxOpen={isLightboxOpen}
      setIsLightboxOpen={setIsLightboxOpen}
      isAddMediaOpen={isAddMediaOpen}
      setIsAddMediaOpen={setIsAddMediaOpen}
      mediaUrl={mediaUrl}
      setMediaUrl={setMediaUrl}
      isAddingMedia={isAddingMedia}
      replaceIndex={replaceIndex}
      setReplaceIndex={setReplaceIndex}
      fileInputRef={fileInputRef}
      handleAddMediaByUrl={handleAddMediaByUrl}
      handleUploadFiles={handleUploadFiles}
      handleRemoveMedia={handleRemoveMedia}
      handleSetPrimaryMedia={handleSetPrimaryMedia}
      isRefetchConfirmOpen={isRefetchConfirmOpen}
      setIsRefetchConfirmOpen={setIsRefetchConfirmOpen}
      handleRefetchMetadata={handleRefetchMetadata}
      lightboxMetadata={lightboxMetadata}
      isSaving={isSaving}
      hasDirtyChanges={hasDirtyChanges}
      handleReset={handleReset}
      handleSave={handleSave}
    />
  );
};

export default TabEditorSheet;
