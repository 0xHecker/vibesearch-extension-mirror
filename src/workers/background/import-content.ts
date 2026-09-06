import type { ItemDocType } from "@src/schemas/item_schema";
import { saveMediaToOpfs } from "@src/services/media-storage";
import { OCR_MODEL_VERSION } from "@src/services/ocr-model-config";
import { isMetadataFetchableUrl } from "@src/utils/metadata-url";
import { inferSource } from "@src/utils/infer-source";
import { executeScriptInTab } from "@src/workers/background/browser-tab-runtime";
import {
  captureScreenshotBlob,
  contextText,
  createTitle,
  extractContentFromPage,
  screenshotText,
  suggestedTags,
  uploadRemoteMediaIfPresent,
} from "@src/workers/background/import-context";
import type {
  ExtractImageTextResponse,
  ImageDomMetadata,
  ImportClickContext,
  ImportMode,
  ImportTarget,
  PreparedImportContent,
  SaveContentKind,
  ScreenshotRegionSelection,
} from "@src/workers/background/import-types";
import {
  LOCAL_IMPORT_HOST,
  buildSyntheticImportUrl,
  getFileNameFromUrl,
  looksLikeMediaUrl,
  normalizeHttpUrl,
  normalizeIconUrl,
  normalizeSelectionText,
  pickHostLabel,
  resolveMediaType,
  trimMultilineText,
  trimText,
  uniqueList,
} from "@src/workers/background/import-utils";
import {
  selectScreenshotRegion,
  showBrandedToast,
} from "@src/workers/background/import-ui";
import { sendProcessStatus } from "@src/workers/background/process-status";
import { sendForwardedToOffscreen } from "@src/workers/background/runtime";
import { ImportCancelledError } from "@src/workers/background/import-types";

const resolveSaveContentKind = (
  context: ImportClickContext,
): SaveContentKind => {
  const mediaUrl =
    context.mediaUrl ||
    (!context.mediaUrl && looksLikeMediaUrl(context.linkUrl)
      ? context.linkUrl
      : null);
  const mediaType = resolveMediaType(context.mediaType, mediaUrl);
  const hasSelectionText = context.selectionText.length > 0;

  if (mediaType === "image" && !!mediaUrl) {
    return "image-only";
  }
  if (mediaType === "video" && !!mediaUrl) {
    return "video-only";
  }
  if (mediaType === "audio" && !!mediaUrl) {
    return "audio-only";
  }

  const pageMediaUrl = looksLikeMediaUrl(context.pageUrl)
    ? context.pageUrl
    : looksLikeMediaUrl(context.tabUrl)
      ? context.tabUrl
      : looksLikeMediaUrl(context.frameUrl)
        ? context.frameUrl
        : null;
  if (pageMediaUrl) {
    const pageMediaType = resolveMediaType(null, pageMediaUrl);
    if (pageMediaType === "image") return "image-only";
    if (pageMediaType === "video") return "video-only";
    if (pageMediaType === "audio") return "audio-only";
  }

  if (hasSelectionText && !mediaUrl) {
    return "text-only";
  }
  return "default";
};

const resolveSavePrimaryUrl = (context: ImportClickContext) =>
  context.pageUrl ||
  context.frameUrl ||
  context.tabUrl ||
  context.linkUrl ||
  context.mediaUrl ||
  null;

export const resolveLiveArchiveUrl = (
  context: ImportClickContext,
  tab: chrome.tabs.Tab | undefined,
): string | undefined => {
  if (
    tab?.id === undefined ||
    context.linkUrl ||
    context.mediaUrl ||
    context.selectionText ||
    (context.frameUrl && context.frameUrl !== context.tabUrl)
  ) {
    return undefined;
  }
  return (
    normalizeHttpUrl(tab.url || context.tabUrl || context.pageUrl) || undefined
  );
};

type ResolvedSaveUrl = {
  url: string;
  synthetic: boolean;
};

export const resolveSavePrimaryUrlOrFallback = (
  context: ImportClickContext,
  mode: ImportMode,
): ResolvedSaveUrl => {
  const primary = resolveSavePrimaryUrl(context);
  if (primary) {
    return { url: primary, synthetic: false };
  }
  return { url: buildSyntheticImportUrl(context, mode), synthetic: true };
};

export const isMetadataFetchablePageUrl = (url: string): boolean => {
  return isMetadataFetchableUrl(url, { blockedHosts: [LOCAL_IMPORT_HOST] });
};

const fetchImageDomMetadata = async (
  tab: chrome.tabs.Tab | undefined,
  mediaUrl: string,
): Promise<ImageDomMetadata | null> => {
  return await executeScriptInTab<ImageDomMetadata | null, [string]>(
    tab,
    (targetUrl: string) => {
      const normalize = (raw: string | null | undefined) => {
        if (!raw) return "";
        try {
          return new URL(raw, window.location.href).toString();
        } catch {
          return "";
        }
      };
      const normalizedTarget = normalize(targetUrl);
      const images = Array.from(
        document.querySelectorAll<HTMLImageElement>("img"),
      );
      const directMatch = images.find((img) => {
        const current = normalize(img.currentSrc || img.src);
        return !!current && current === normalizedTarget;
      });
      const looseMatch =
        directMatch ||
        images.find((img) => {
          const src = img.currentSrc || img.src || "";
          return src.includes(targetUrl) || targetUrl.includes(src);
        }) ||
        null;

      const siteNameMeta =
        document.querySelector<HTMLMetaElement>('meta[property="og:site_name"]')
          ?.content ||
        document.querySelector<HTMLMetaElement>('meta[name="application-name"]')
          ?.content ||
        "";
      const iconEl = document.querySelector<HTMLLinkElement>(
        'link[rel~="icon"], link[rel="shortcut icon"], link[rel="apple-touch-icon"]',
      );
      const iconHref = iconEl?.getAttribute("href") || "";
      let faviconUrl = "";
      if (iconHref) {
        try {
          faviconUrl = new URL(iconHref, window.location.href).toString();
        } catch {}
      }
      if (!faviconUrl) {
        try {
          faviconUrl = new URL(
            "/favicon.ico",
            window.location.origin,
          ).toString();
        } catch {}
      }

      const image = looseMatch;
      return {
        pageTitle: (document.title || "").trim(),
        siteName: (
          siteNameMeta || window.location.hostname.replace(/^www\./, "")
        ).trim(),
        pageUrl: window.location.href,
        faviconUrl,
        altText: (image?.getAttribute("alt") || "").trim(),
        titleText: (image?.getAttribute("title") || "").trim(),
        ariaLabel: (image?.getAttribute("aria-label") || "").trim(),
        width: Number(image?.naturalWidth || 0),
        height: Number(image?.naturalHeight || 0),
      } satisfies ImageDomMetadata;
    },
    [mediaUrl],
  );
};

const buildTextOnlyContent = (
  context: ImportClickContext,
): PreparedImportContent | null => {
  const selected = normalizeSelectionText(context.selectionText);
  if (!selected) return null;
  const saveTarget = resolveSavePrimaryUrlOrFallback(context, "save");
  const source = inferSource(resolveSavePrimaryUrl(context) || saveTarget.url);
  const title = trimText(
    selected.split(/\n+/).find((line) => line.trim()) || selected,
    80,
  );
  return {
    primaryUrl: saveTarget.url,
    title,
    textContent: selected,
    source,
    iconUrl: context.tabFavIconUrl || undefined,
    tags: uniqueList([
      source !== "web" ? source : "",
      "text",
      pickHostLabel(context),
    ]),
    shouldFetchMetadata: false,
    isMetaFetched: true,
  };
};

const buildImageOnlyContent = async (
  context: ImportClickContext,
  tab: chrome.tabs.Tab | undefined,
): Promise<PreparedImportContent | null> => {
  const mediaUrl =
    context.mediaUrl ||
    (looksLikeMediaUrl(context.linkUrl) ? context.linkUrl : null) ||
    (looksLikeMediaUrl(context.pageUrl) ? context.pageUrl : null) ||
    (looksLikeMediaUrl(context.tabUrl) ? context.tabUrl : null) ||
    (looksLikeMediaUrl(context.frameUrl) ? context.frameUrl : null);
  if (!mediaUrl) return null;
  const mediaType = resolveMediaType(context.mediaType, mediaUrl);
  if (mediaType !== "image") return null;

  const domMeta = await fetchImageDomMetadata(tab, mediaUrl);
  const pageUrl =
    normalizeHttpUrl(domMeta?.pageUrl || null) ||
    context.pageUrl ||
    context.tabUrl ||
    null;
  const source = inferSource(pageUrl || mediaUrl);

  let media: ItemDocType["media"] | undefined;
  let displayImageUrl: string | undefined;
  try {
    const mediaResult = await uploadRemoteMediaIfPresent({
      ...context,
      mediaUrl,
      mediaType: "image",
    });
    if (mediaResult.upload?.url) {
      media = [
        {
          type: "image",
          originalUrl: mediaUrl,
          storageType: "s3",
          s3Url: mediaResult.upload.url,
          altText: domMeta?.altText || undefined,
          titleText: domMeta?.titleText || undefined,
          ariaLabel: domMeta?.ariaLabel || undefined,
          pageUrl: pageUrl || undefined,
          pageTitle: domMeta?.pageTitle || undefined,
          siteName: domMeta?.siteName || undefined,
          faviconUrl:
            normalizeIconUrl(domMeta?.faviconUrl || null) ||
            context.tabFavIconUrl ||
            undefined,
          width: domMeta?.width || undefined,
          height: domMeta?.height || undefined,
          capturedAt: context.capturedAt,
        },
      ];
      displayImageUrl = mediaResult.upload.url || undefined;
    }
  } catch {}

  if (!media) {
    media = [
      {
        type: "image",
        originalUrl: mediaUrl,
        storageType: "hotlink",
        altText: domMeta?.altText || undefined,
        titleText: domMeta?.titleText || undefined,
        ariaLabel: domMeta?.ariaLabel || undefined,
        pageUrl: pageUrl || undefined,
        pageTitle: domMeta?.pageTitle || undefined,
        siteName: domMeta?.siteName || undefined,
        faviconUrl:
          normalizeIconUrl(domMeta?.faviconUrl || null) ||
          context.tabFavIconUrl ||
          undefined,
        width: domMeta?.width || undefined,
        height: domMeta?.height || undefined,
        capturedAt: context.capturedAt,
      },
    ];
    displayImageUrl = mediaUrl;
  }

  const candidateLabel = trimText(
    domMeta?.altText ||
      domMeta?.titleText ||
      domMeta?.ariaLabel ||
      getFileNameFromUrl(mediaUrl),
    80,
  );
  const title = candidateLabel || `Image · ${getFileNameFromUrl(mediaUrl)}`;

  return {
    primaryUrl: mediaUrl,
    title,
    textContent: "",
    source,
    iconUrl:
      normalizeIconUrl(domMeta?.faviconUrl || null) ||
      context.tabFavIconUrl ||
      undefined,
    displayImageUrl,
    media,
    tags: uniqueList([
      source !== "web" ? source : "",
      "image",
      pickHostLabel(context),
    ]),
    shouldFetchMetadata: false,
    isMetaFetched: true,
  };
};

const buildVideoOnlyContent = async (
  context: ImportClickContext,
): Promise<PreparedImportContent | null> => {
  const mediaUrl =
    context.mediaUrl ||
    (looksLikeMediaUrl(context.linkUrl) ? context.linkUrl : null) ||
    (looksLikeMediaUrl(context.pageUrl) ? context.pageUrl : null) ||
    (looksLikeMediaUrl(context.tabUrl) ? context.tabUrl : null) ||
    (looksLikeMediaUrl(context.frameUrl) ? context.frameUrl : null);
  if (!mediaUrl) return null;
  const mediaType = resolveMediaType(context.mediaType, mediaUrl);
  if (mediaType !== "video") return null;

  const pageUrl = context.pageUrl || context.tabUrl || null;
  const source = inferSource(pageUrl || mediaUrl);

  const media: ItemDocType["media"] = [
    {
      type: "video",
      originalUrl: mediaUrl,
      storageType: "hotlink",
      pageUrl: pageUrl || undefined,
      pageTitle: context.tabTitle || undefined,
      faviconUrl: context.tabFavIconUrl || undefined,
      capturedAt: context.capturedAt,
    },
  ];

  const title =
    trimText(
      context.tabTitle || `Video · ${getFileNameFromUrl(mediaUrl)}`,
      80,
    ) || "Video";

  return {
    primaryUrl: mediaUrl,
    title,
    textContent: "",
    source,
    iconUrl: context.tabFavIconUrl || undefined,
    media,
    tags: uniqueList([
      source !== "web" ? source : "",
      "video",
      pickHostLabel(context),
    ]),
    shouldFetchMetadata: false,
    isMetaFetched: true,
  };
};

const buildAudioOnlyContent = async (
  context: ImportClickContext,
): Promise<PreparedImportContent | null> => {
  const mediaUrl =
    context.mediaUrl ||
    (looksLikeMediaUrl(context.linkUrl) ? context.linkUrl : null) ||
    (looksLikeMediaUrl(context.pageUrl) ? context.pageUrl : null) ||
    (looksLikeMediaUrl(context.tabUrl) ? context.tabUrl : null) ||
    (looksLikeMediaUrl(context.frameUrl) ? context.frameUrl : null);
  if (!mediaUrl) return null;
  const mediaType = resolveMediaType(context.mediaType, mediaUrl);
  if (mediaType !== "audio") return null;

  const pageUrl = context.pageUrl || context.tabUrl || null;
  const source = inferSource(pageUrl || mediaUrl);

  const media: ItemDocType["media"] = [
    {
      type: "audio",
      originalUrl: mediaUrl,
      storageType: "hotlink",
      pageUrl: pageUrl || undefined,
      pageTitle: context.tabTitle || undefined,
      faviconUrl: context.tabFavIconUrl || undefined,
      capturedAt: context.capturedAt,
    },
  ];

  const title =
    trimText(
      context.tabTitle || `Audio · ${getFileNameFromUrl(mediaUrl)}`,
      80,
    ) || "Audio";

  return {
    primaryUrl: mediaUrl,
    title,
    textContent: "",
    source,
    iconUrl: context.tabFavIconUrl || undefined,
    media,
    tags: uniqueList([
      source !== "web" ? source : "",
      "audio",
      pickHostLabel(context),
    ]),
    shouldFetchMetadata: false,
    isMetaFetched: true,
  };
};

export const buildExtractedImageTextContent = async (
  context: ImportClickContext,
  tab: chrome.tabs.Tab | undefined,
  job: { id: string; label: string },
): Promise<PreparedImportContent> => {
  const mediaUrl =
    context.mediaUrl ||
    (!context.mediaUrl && looksLikeMediaUrl(context.linkUrl)
      ? context.linkUrl
      : null);
  if (!mediaUrl || resolveMediaType(context.mediaType, mediaUrl) !== "image") {
    throw new Error("No image found for text extraction.");
  }

  const domMeta = await fetchImageDomMetadata(tab, mediaUrl);
  const pageUrl =
    normalizeHttpUrl(domMeta?.pageUrl || null) ||
    context.pageUrl ||
    context.tabUrl ||
    null;
  const source = inferSource(pageUrl || mediaUrl);

  sendProcessStatus(job.id, job.label, "processing", "Running OCR...");
  const result = await sendForwardedToOffscreen<ExtractImageTextResponse>({
    service: "ocr",
    type: "extractImageText",
    payload: { url: mediaUrl },
  });

  const OCR_CONFIDENCE_THRESHOLD = 0.3;
  const hasUsableText =
    result.status === "done" &&
    result.text.trim().length > 0 &&
    (result.confidence === undefined ||
      result.confidence >= OCR_CONFIDENCE_THRESHOLD);

  const text = hasUsableText ? trimMultilineText(result.text, 12000) : "";
  const firstLine = text.split(/\n+/).find((line) => line.trim()) || "";
  const titleSeed =
    firstLine ||
    domMeta?.altText ||
    domMeta?.titleText ||
    domMeta?.ariaLabel ||
    getFileNameFromUrl(mediaUrl);

  type SourceImage = NonNullable<ItemDocType["media"]>[number];
  const sourceImage: SourceImage = {
    type: "image",
    originalUrl: mediaUrl,
    storageType: "hotlink",
    altText: domMeta?.altText || undefined,
    titleText: domMeta?.titleText || undefined,
    ariaLabel: domMeta?.ariaLabel || undefined,
    pageUrl: pageUrl || undefined,
    pageTitle: domMeta?.pageTitle || undefined,
    siteName: domMeta?.siteName || undefined,
    faviconUrl:
      normalizeIconUrl(domMeta?.faviconUrl || null) ||
      context.tabFavIconUrl ||
      undefined,
    width: domMeta?.width || undefined,
    height: domMeta?.height || undefined,
    capturedAt: context.capturedAt,
  };
  if (hasUsableText) {
    sourceImage.ocr = {
      status: "done",
      text,
      confidence: result.confidence ?? null,
      lineCount: result.lineCount,
      modelVersion: OCR_MODEL_VERSION,
      sourceHash: result.sourceHash,
      extractedAt: context.capturedAt,
      engine: "paddleocr",
    };
  }
  const sourceImageMedia: ItemDocType["media"] = [sourceImage];

  return {
    primaryUrl: mediaUrl,
    title: hasUsableText
      ? trimText(`Image text · ${titleSeed}`, 80)
      : trimText(titleSeed || `Image · ${getFileNameFromUrl(mediaUrl)}`, 80) ||
        "Image",
    // Extracted OCR must be saved as visible tab text and as OCR provenance.
    // `textContent` feeds notes/snippets immediately; `ocrText` keeps OCR-specific
    // indexing and later media OCR updates from discarding or duplicating it.
    textContent: hasUsableText ? text : "",
    source,
    iconUrl:
      normalizeIconUrl(domMeta?.faviconUrl || null) ||
      context.tabFavIconUrl ||
      undefined,
    displayImageUrl: mediaUrl,
    media: sourceImageMedia,
    ocrText: hasUsableText ? text : undefined,
    ocrStatus: hasUsableText ? "done" : "skipped",
    ocrConfidence: hasUsableText ? result.confidence : undefined,
    ocrLineCount: hasUsableText ? result.lineCount : undefined,
    ocrModelVersion: hasUsableText ? OCR_MODEL_VERSION : undefined,
    ocrSourceHash: hasUsableText ? result.sourceHash : undefined,
    tags: uniqueList([
      source !== "web" ? source : "",
      hasUsableText ? "image-text" : "image",
      hasUsableText ? "ocr" : "",
      pickHostLabel(context),
    ]),
    shouldFetchMetadata: false,
    isMetaFetched: true,
  };
};

export const captureScreenshotMedia = async (
  context: ImportClickContext,
  tab: chrome.tabs.Tab | undefined,
  job: { id: string; label: string },
  itemId: string,
  mode: "visible" | "region" = "visible",
): Promise<{ media?: ItemDocType["media"] }> => {
  let regionSelection: ScreenshotRegionSelection | undefined;

  if (mode === "region") {
    if (
      typeof OffscreenCanvas === "undefined" ||
      typeof createImageBitmap === "undefined"
    ) {
      sendProcessStatus(
        job.id,
        job.label,
        "processing",
        "Area crop is not available in this browser context. Capturing full tab instead.",
      );
    } else {
      sendProcessStatus(
        job.id,
        job.label,
        "processing",
        "Select an area to capture...",
      );
      const regionResult = await selectScreenshotRegion(tab);
      if (regionResult.status === "cancelled") {
        throw new ImportCancelledError("Screenshot area selection cancelled.");
      }
      if (regionResult.status === "selected") {
        regionSelection = regionResult.selection;
      } else {
        sendProcessStatus(
          job.id,
          job.label,
          "processing",
          "Area selection is unavailable on this page. Capturing full tab instead.",
        );
      }
    }
  }

  sendProcessStatus(job.id, job.label, "processing", "Capturing screenshot...");
  let captured: { blob: Blob; fileName: string };
  try {
    captured = await captureScreenshotBlob(
      context,
      tab,
      0,
      regionSelection,
      async () => {
        sendProcessStatus(
          job.id,
          job.label,
          "processing",
          "Screenshot captured. Saving locally...",
        );
        await showBrandedToast(tab, "Screenshot captured. Saving locally...");
      },
    );
  } catch (error) {
    const detail =
      error instanceof Error ? error.message : "Screenshot capture failed.";
    await showBrandedToast(tab, detail);
    throw error;
  }

  const file = new File([captured.blob], captured.fileName, {
    type: captured.blob.type || "image/png",
    lastModified: context.capturedAt,
  });
  const saved = await saveMediaToOpfs(itemId, file, captured.fileName);

  sendProcessStatus(
    job.id,
    job.label,
    "processing",
    "Screenshot saved locally.",
  );

  const media: ItemDocType["media"] = [
    {
      type: "image",
      originalUrl: captured.fileName,
      storageType: "opfs",
      opfsPath: saved.opfsPath,
      altText: context.tabTitle
        ? `Screenshot of ${context.tabTitle}`
        : "Screenshot",
      pageUrl: context.pageUrl || context.tabUrl || undefined,
      pageTitle: context.tabTitle || undefined,
      faviconUrl: context.tabFavIconUrl || undefined,
      capturedAt: context.capturedAt,
    },
  ];
  return {
    media,
  };
};
export const prepareImportContent = async (
  target: ImportTarget,
  context: ImportClickContext,
  tab: chrome.tabs.Tab | undefined,
  job: { id: string; label: string },
): Promise<PreparedImportContent> => {
  if (target.mode === "shot") {
    const itemId = crypto.randomUUID();
    const resolved = resolveSavePrimaryUrlOrFallback(context, "shot");
    const primaryUrl = resolved.url;
    const screenshot = await captureScreenshotMedia(
      context,
      tab,
      job,
      itemId,
      target.screenshotMode || "visible",
    );
    const source = inferSource(primaryUrl);
    return {
      itemId,
      primaryUrl,
      title: createTitle(context, target.mode, primaryUrl),
      textContent: screenshotText(context),
      source,
      iconUrl: context.tabFavIconUrl || undefined,
      media: screenshot.media,
      ocrStatus: "pending",
      ocrModelVersion: "",
      tags: uniqueList([
        source !== "web" ? source : "",
        "screenshot",
        pickHostLabel(context),
      ]),
      shouldFetchMetadata: false,
      isMetaFetched: true,
    };
  }

  // Extract platform-aware content (canonical URL, title, author, media)
  const extracted = await extractContentFromPage(
    tab,
    context.linkUrl || context.pageUrl || undefined,
  );

  const kind = resolveSaveContentKind(context);
  if (kind === "text-only") {
    const textOnly = buildTextOnlyContent(context);
    if (textOnly) return textOnly;
  }
  if (kind === "image-only") {
    const imageOnly = await buildImageOnlyContent(context, tab);
    if (imageOnly) return imageOnly;
  }
  if (kind === "video-only") {
    const videoOnly = await buildVideoOnlyContent(context);
    if (videoOnly) return videoOnly;
  }
  if (kind === "audio-only") {
    const audioOnly = await buildAudioOnlyContent(context);
    if (audioOnly) return audioOnly;
  }

  const resolved = resolveSavePrimaryUrlOrFallback(context, "save");
  const primaryUrl =
    normalizeHttpUrl(extracted?.canonicalUrl || null) || resolved.url;
  const source = inferSource(primaryUrl);
  let media: ItemDocType["media"] | undefined;
  let displayImageUrl: string | undefined;

  // Use extracted media if available
  if (extracted?.mediaUrls && extracted.mediaUrls.length > 0) {
    media = extracted.mediaUrls.slice(0, 4).map((m) => ({
      type: m.type,
      originalUrl: m.url,
      storageType: "hotlink" as const,
    }));
    if (extracted.mediaUrls[0].type === "image") {
      displayImageUrl = extracted.thumbnailUrl || extracted.mediaUrls[0].url;
    }
  }

  const extractedThumbnailUrl = normalizeHttpUrl(
    extracted?.thumbnailUrl || null,
  );
  if (extractedThumbnailUrl) {
    displayImageUrl = displayImageUrl || extractedThumbnailUrl;
    if (!media) {
      media = [
        {
          type: "image",
          originalUrl: extractedThumbnailUrl,
          storageType: "hotlink" as const,
          pageUrl: primaryUrl,
          capturedAt: context.capturedAt,
        },
      ];
    }
  }

  // Otherwise try to upload remote media from context
  if (!media) {
    try {
      const mediaResult = await uploadRemoteMediaIfPresent(context);
      if (mediaResult.upload?.url && mediaResult.mediaType) {
        media = [
          {
            type: mediaResult.mediaType,
            originalUrl: mediaResult.originalUrl || primaryUrl,
            storageType: "s3",
            s3Url: mediaResult.upload.url,
          },
        ];
        if (mediaResult.mediaType === "image")
          displayImageUrl = mediaResult.upload.url || undefined;
      }
    } catch (error) {
      const detail =
        error instanceof Error ? error.message : "Media upload failed.";
      sendProcessStatus(
        job.id,
        job.label,
        "processing",
        `Media upload failed (${detail}). Continuing without media preview.`,
      );
    }
  }

  // Fallback: if we have a direct media URL but no media entry, store as hotlink
  if (!media) {
    const directMediaUrl =
      context.mediaUrl ||
      (looksLikeMediaUrl(context.linkUrl) ? context.linkUrl : null);
    const directMediaType = resolveMediaType(context.mediaType, directMediaUrl);
    if (directMediaUrl && directMediaType) {
      media = [
        {
          type: directMediaType,
          originalUrl: directMediaUrl,
          storageType: "hotlink",
          pageUrl: resolveSavePrimaryUrl(context) || undefined,
          capturedAt: context.capturedAt,
        },
      ];
      if (directMediaType === "image") displayImageUrl = directMediaUrl;
    }
  }

  // Use extracted content for title, description, author
  const title =
    extracted?.title || createTitle(context, target.mode, primaryUrl);
  const textContent =
    extracted?.description || contextText(context, target.mode);
  const shouldFetchMetadata = isMetadataFetchablePageUrl(primaryUrl);

  return {
    itemId: crypto.randomUUID(),
    primaryUrl,
    title,
    textContent,
    source,
    iconUrl: context.tabFavIconUrl || undefined,
    displayImageUrl,
    media,
    tags: suggestedTags(context, source),
    shouldFetchMetadata,
    isMetaFetched: !shouldFetchMetadata,
    archiveUrl: primaryUrl,
    liveArchiveUrl: resolveLiveArchiveUrl(context, tab),
  };
};

export const toItemPayload = (params: {
  id?: string;
  context: ImportClickContext;
  mode: ImportMode;
  primaryUrl: string;
  folderId: string;
  parentId: string | null;
  title?: string;
  textContent?: string;
  source?: ItemDocType["source"];
  iconUrl?: string;
  displayImageUrl?: string;
  media?: ItemDocType["media"];
  ocrText?: string;
  ocrStatus?: ItemDocType["ocrStatus"];
  ocrConfidence?: number;
  ocrLineCount?: number;
  ocrModelVersion?: string;
  ocrSourceHash?: string;
  shouldFetchMetadata?: boolean;
  isMetaFetched?: boolean;
  deferBackgroundProcessing?: boolean;
}) => ({
  id: params.id,
  folderId: params.folderId,
  url: params.primaryUrl,
  title:
    params.title || createTitle(params.context, params.mode, params.primaryUrl),
  textContent: params.textContent ?? contextText(params.context, params.mode),
  source: params.source || inferSource(params.primaryUrl),
  iconUrl: params.iconUrl,
  displayImageUrl: params.displayImageUrl,
  media: params.media,
  ocrText: params.ocrText,
  ocrStatus: params.ocrStatus,
  ocrConfidence: params.ocrConfidence,
  ocrLineCount: params.ocrLineCount,
  ocrModelVersion: params.ocrModelVersion,
  ocrSourceHash: params.ocrSourceHash,
  parentId: params.parentId,
  chunkOrder: params.context.capturedAt,
  allowLockedPrivateWrite: true,
  isMetaFetched: params.isMetaFetched ?? false,
  shouldFetchMetadata: params.shouldFetchMetadata ?? true,
  deferBackgroundProcessing: params.deferBackgroundProcessing === true,
  isDirty: true,
  createdAt: params.context.capturedAt,
  updatedAt: params.context.capturedAt,
});
