import type { ItemDocType } from "@src/schemas/item_schema";
import { uploadRemoteMediaToR2 } from "@src/services/media-storage";
import type {
  ExtractedContent,
  HoverSaveTarget,
  ImportClickContext,
  ImportMediaUpload,
  ImportMode,
  ImportTarget,
  ScreenshotRegionSelection,
} from "@src/workers/background/import-types";
import {
  looksLikeMediaUrl,
  normalizeHttpUrl,
  normalizeIconUrl,
  normalizeSelectionText,
  pickHostLabel,
  resolveMediaType,
  trimText,
  uniqueList,
} from "@src/workers/background/import-utils";

const HOVER_SAVE_TARGET_TTL_MS = 30_000;

const captureVisibleTabPng = async (tab?: chrome.tabs.Tab) =>
  await new Promise<string>((resolve, reject) => {
    const callback = (dataUrl?: string) => {
      if (chrome.runtime.lastError)
        return reject(new Error(chrome.runtime.lastError.message));
      if (!dataUrl)
        return reject(new Error("captureVisibleTab returned empty image"));
      resolve(dataUrl);
    };
    if (tab?.windowId !== undefined)
      chrome.tabs.captureVisibleTab(tab.windowId, { format: "png" }, callback);
    else chrome.tabs.captureVisibleTab({ format: "png" }, callback);
  });
const parseImportMode = (value: string | undefined): ImportMode | null => {
  if (value === "save" || value === "shot" || value === "extract") return value;
  return null;
};
export const parseTargetFromMenuId = (menuId: string): ImportTarget | null => {
  const bySpace = /^vs:(save|shot|extract):space:([^:]+)$/i.exec(menuId);
  const spaceMode = parseImportMode(bySpace?.[1]);
  if (spaceMode && bySpace?.[2])
    return { mode: spaceMode, spaceId: bySpace[2] };
  const byFolder = /^vs:(save|shot|extract):folder:([^:]+)$/i.exec(menuId);
  const folderMode = parseImportMode(byFolder?.[1]);
  if (folderMode && byFolder?.[2])
    return { mode: folderMode, folderId: byFolder[2] };
  const byLru = /^vs:save:lru:folder:([^:]+)$/i.exec(menuId);
  if (byLru) return { mode: "save", folderId: byLru[1] };
  return null;
};
const hoverSaveTargetsByTab = new Map<number, HoverSaveTarget>();

export const clearHoverSaveTargets = (): void => {
  hoverSaveTargetsByTab.clear();
};

export const forgetHoverSaveTarget = (tabId: number): void => {
  hoverSaveTargetsByTab.delete(tabId);
};

const getHoverSaveTarget = (
  tabId: number | undefined,
): HoverSaveTarget | null => {
  if (tabId === undefined) return null;
  const target = hoverSaveTargetsByTab.get(tabId);
  if (!target) return null;
  if (Date.now() - target.capturedAt > HOVER_SAVE_TARGET_TTL_MS) {
    hoverSaveTargetsByTab.delete(tabId);
    return null;
  }
  return target;
};

export const rememberHoverSaveTarget = (
  tabId: number,
  url: string,
  title?: string,
): void => {
  hoverSaveTargetsByTab.set(tabId, {
    url,
    title: title ? trimText(title.trim(), 160) : undefined,
    capturedAt: Date.now(),
  });
};

export const collectContext = (
  info: chrome.contextMenus.OnClickData,
  tab?: chrome.tabs.Tab,
): ImportClickContext => {
  const hoverTarget = getHoverSaveTarget(tab?.id);
  const pageUrl = normalizeHttpUrl(info.pageUrl || null);
  const nativeLinkUrl = normalizeHttpUrl(info.linkUrl || null);
  const hoverLinkUrl = hoverTarget?.url || null;
  const linkUrl =
    hoverLinkUrl &&
    nativeLinkUrl &&
    pageUrl &&
    nativeLinkUrl === pageUrl &&
    hoverLinkUrl !== pageUrl
      ? hoverLinkUrl
      : nativeLinkUrl || hoverLinkUrl;
  return {
    pageUrl,
    frameUrl: normalizeHttpUrl(info.frameUrl || null),
    linkUrl,
    mediaUrl: normalizeHttpUrl(info.srcUrl || null),
    mediaType: info.mediaType || null,
    selectionText: normalizeSelectionText(info.selectionText || ""),
    tabUrl: normalizeHttpUrl(tab?.url || null),
    tabTitle: hoverTarget?.title || (tab?.title || "").trim(),
    tabFavIconUrl: normalizeIconUrl(tab?.favIconUrl || null),
    capturedAt: Date.now(),
  };
};
export const collectContextFromTab = (
  tab?: chrome.tabs.Tab,
): ImportClickContext => ({
  pageUrl: normalizeHttpUrl(tab?.url || null),
  frameUrl: null,
  linkUrl: null,
  mediaUrl: null,
  mediaType: null,
  selectionText: "",
  tabUrl: normalizeHttpUrl(tab?.url || null),
  tabTitle: (tab?.title || "").trim(),
  tabFavIconUrl: normalizeIconUrl(tab?.favIconUrl || null),
  capturedAt: Date.now(),
});
export const getActiveTab = async (): Promise<chrome.tabs.Tab | undefined> => {
  try {
    const [active] = await chrome.tabs.query({
      active: true,
      currentWindow: true,
    });
    return active;
  } catch {
    return undefined;
  }
};
export const buildContextFromUrl = (url: string): ImportClickContext => {
  const normalized = normalizeHttpUrl(url);
  let host: string | null = null;
  try {
    host = new URL(normalized!).hostname.replace(/^www\./, "");
  } catch {}
  return {
    pageUrl: normalized,
    frameUrl: null,
    linkUrl: normalized,
    mediaUrl: null,
    mediaType: null,
    selectionText: "",
    tabUrl: normalized,
    tabTitle: host || normalized || "Pasted link",
    tabFavIconUrl: host ? `https://${host}/favicon.ico` : null,
    capturedAt: Date.now(),
  };
};
export const createTitle = (
  context: ImportClickContext,
  mode: ImportMode,
  fallbackUrl: string,
) => {
  if (mode === "shot")
    return trimText(
      context.tabTitle
        ? `Screenshot · ${context.tabTitle}`
        : `Screenshot · ${fallbackUrl}`,
    );
  if (mode === "extract")
    return trimText(
      context.tabTitle
        ? `Image text · ${context.tabTitle}`
        : `Image text · ${fallbackUrl}`,
    );
  if (context.selectionText)
    return trimText(context.selectionText.replace(/\s+/g, " "));
  if (context.tabTitle) return trimText(context.tabTitle);
  return trimText(fallbackUrl);
};
export const contextText = (context: ImportClickContext, mode: ImportMode) => {
  const lines: string[] = [];
  if (context.selectionText) lines.push(context.selectionText, "");
  lines.push(
    `Imported via: ${mode === "shot" ? "page-screenshot" : mode === "extract" ? "image-ocr" : "context-menu"}`,
  );
  lines.push(`Imported at: ${new Date(context.capturedAt).toISOString()}`);
  if (context.tabTitle) lines.push(`Tab: ${context.tabTitle}`);
  if (context.pageUrl) lines.push(`Page: ${context.pageUrl}`);
  if (context.frameUrl && context.frameUrl !== context.pageUrl)
    lines.push(`Frame: ${context.frameUrl}`);
  if (context.linkUrl) lines.push(`Link: ${context.linkUrl}`);
  if (context.mediaUrl) lines.push(`Media source: ${context.mediaUrl}`);
  return lines.join("\n");
};
export const screenshotText = (context: ImportClickContext) => {
  const lines: string[] = [];
  lines.push("Imported via: page-screenshot");
  lines.push(`Imported at: ${new Date(context.capturedAt).toISOString()}`);
  if (context.tabTitle) lines.push(`Tab: ${context.tabTitle}`);
  return lines.join("\n");
};
export const suggestedTags = (
  context: ImportClickContext,
  source: ItemDocType["source"],
) =>
  uniqueList([
    source !== "web" ? source : "",
    pickHostLabel(context),
    context.mediaType || "",
  ]).slice(0, 6);

type RemoteMediaResult = {
  upload: ImportMediaUpload | null;
  mediaType: "image" | "video" | "audio" | null;
  originalUrl: string | null;
};

export const uploadRemoteMediaIfPresent = async (
  context: ImportClickContext,
): Promise<RemoteMediaResult> => {
  const mediaUrl =
    context.mediaUrl ||
    (!context.mediaUrl && looksLikeMediaUrl(context.linkUrl)
      ? context.linkUrl
      : null);
  if (!mediaUrl) return { upload: null, mediaType: null, originalUrl: null };
  const mediaType = resolveMediaType(context.mediaType, mediaUrl);
  if (!mediaType)
    return { upload: null, mediaType: null, originalUrl: mediaUrl };
  const uploaded = await uploadRemoteMediaToR2(
    mediaUrl,
    context.pageUrl || context.tabUrl || mediaUrl,
  );
  const upload = uploaded ? { url: uploaded.r2Url, key: uploaded.key } : null;
  return { upload, mediaType, originalUrl: mediaUrl };
};
const dataUrlToBlob = (dataUrl: string): Blob => {
  const commaIndex = dataUrl.indexOf(",");
  if (!dataUrl.startsWith("data:") || commaIndex < 0) {
    throw new Error("Invalid screenshot data URL.");
  }

  const meta = dataUrl.slice(5, commaIndex);
  const rawBody = dataUrl.slice(commaIndex + 1);
  const mimeType = (meta.split(";")[0] || "image/png").trim() || "image/png";
  const isBase64 = /;base64/i.test(meta);

  if (isBase64) {
    const binary = atob(rawBody);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) {
      bytes[i] = binary.charCodeAt(i);
    }
    return new Blob([bytes], { type: mimeType });
  }

  const text = decodeURIComponent(rawBody);
  return new Blob([text], { type: mimeType });
};
const cropScreenshotBlob = async (
  sourceBlob: Blob,
  selection: ScreenshotRegionSelection,
): Promise<Blob> => {
  if (
    typeof OffscreenCanvas === "undefined" ||
    typeof createImageBitmap === "undefined"
  ) {
    return sourceBlob;
  }

  const bitmap = await createImageBitmap(sourceBlob);
  try {
    const viewportWidth = Math.max(1, Math.floor(selection.viewportWidth || 1));
    const viewportHeight = Math.max(
      1,
      Math.floor(selection.viewportHeight || 1),
    );
    const scaleX = bitmap.width / viewportWidth;
    const scaleY = bitmap.height / viewportHeight;

    const sx = Math.max(
      0,
      Math.min(bitmap.width - 1, Math.floor(selection.x * scaleX)),
    );
    const sy = Math.max(
      0,
      Math.min(bitmap.height - 1, Math.floor(selection.y * scaleY)),
    );
    const maxWidth = Math.max(1, bitmap.width - sx);
    const maxHeight = Math.max(1, bitmap.height - sy);
    const sw = Math.max(
      1,
      Math.min(maxWidth, Math.floor(selection.width * scaleX)),
    );
    const sh = Math.max(
      1,
      Math.min(maxHeight, Math.floor(selection.height * scaleY)),
    );

    const canvas = new OffscreenCanvas(sw, sh);
    const ctx = canvas.getContext("2d");
    if (!ctx) {
      return sourceBlob;
    }
    ctx.drawImage(bitmap, sx, sy, sw, sh, 0, 0, sw, sh);
    const cropped = await canvas.convertToBlob({
      type: "image/png",
      quality: 1,
    });
    return cropped || sourceBlob;
  } catch {
    return sourceBlob;
  } finally {
    bitmap.close();
  }
};
export const captureScreenshotBlob = async (
  context: ImportClickContext,
  tab: chrome.tabs.Tab | undefined,
  sequence = 0,
  selection?: ScreenshotRegionSelection,
  onCaptured?: () => Promise<void> | void,
) => {
  if (selection) {
    await new Promise((r) => setTimeout(r, 150));
  }
  const dataUrl = await captureVisibleTabPng(tab);
  if (onCaptured) {
    await onCaptured();
  }
  const sourceBlob = dataUrlToBlob(dataUrl);
  const uploadBlob = selection
    ? await cropScreenshotBlob(sourceBlob, selection)
    : sourceBlob;
  const suffix = sequence > 0 ? `-${sequence + 1}` : "";
  return {
    blob: uploadBlob,
    fileName: `screenshot-${context.capturedAt}${suffix}.png`,
  };
};

export const extractContentFromPage = async (
  tab: chrome.tabs.Tab | undefined,
  clickedUrl?: string,
): Promise<ExtractedContent | null> => {
  if (tab?.id === undefined) return null;

  try {
    // Inject a minimal universal extractor (OG meta + canonical link)
    const result = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: (clickedUrl?: string): ExtractedContent | null => {
        const getMeta = (name: string): string | null => {
          for (const sel of [
            `meta[property="${name}"]`,
            `meta[name="${name}"]`,
            `meta[property="og:${name}"]`,
            `meta[name="twitter:${name}"]`,
          ]) {
            const el = document.querySelector(sel);
            if (el) return el.getAttribute("content") || null;
          }
          return null;
        };
        const trim = (s: string | null | undefined, max = 500): string => {
          const v = (s || "").trim();
          return v.length <= max ? v : v.slice(0, max - 1) + "…";
        };
        const resolveUrl = (href: string | null | undefined): string | null => {
          if (!href) return null;
          try {
            return new URL(href, window.location.href).href;
          } catch {
            return null;
          }
        };
        const text = (el: Element | null | undefined): string =>
          trim(el?.textContent || "");
        const queryText = (root: ParentNode, selectors: string[]): string => {
          for (const selector of selectors) {
            const value = text(root.querySelector(selector));
            if (value) return value;
          }
          return "";
        };
        const youtubeVideoId = (): string | null => {
          const href = clickedUrl || "";
          const clickedWatchMatch = /[?&]v=([^&#]+)/.exec(href);
          if (clickedWatchMatch?.[1]) return clickedWatchMatch[1];
          const clickedShortMatch = /\/shorts\/([^/?#]+)/.exec(href);
          if (clickedShortMatch?.[1]) return clickedShortMatch[1];

          const path = window.location.pathname;
          if (path.startsWith("/shorts/")) {
            return path.split("/shorts/")[1]?.split(/[?#/]/)[0] || null;
          }
          const fromSearch = new URLSearchParams(window.location.search).get(
            "v",
          );
          if (fromSearch) return fromSearch;
          const watchMatch = /[?&]v=([^&#]+)/.exec(window.location.href);
          if (watchMatch?.[1]) return watchMatch[1];
          const shortMatch = /\/shorts\/([^/?#]+)/.exec(window.location.href);
          return shortMatch?.[1] || null;
        };
        const visibleScore = (el: Element): number => {
          const rect = el.getBoundingClientRect();
          if (rect.width <= 0 || rect.height <= 0)
            return Number.POSITIVE_INFINITY;
          if (rect.bottom < 0 || rect.top > window.innerHeight)
            return Number.POSITIVE_INFINITY;
          const centerY = rect.top + rect.height / 2;
          return Math.abs(centerY - window.innerHeight / 2);
        };
        const findShortRenderer = (videoId: string): Element | null => {
          const renderers = Array.from(
            document.querySelectorAll(
              "ytd-reel-video-renderer, ytd-shorts, [is-active]",
            ),
          );
          const matching = renderers
            .filter((el) =>
              Array.from(el.querySelectorAll("a[href]")).some((anchor) =>
                (anchor.getAttribute("href") || "").includes(videoId),
              ),
            )
            .sort((a, b) => visibleScore(a) - visibleScore(b));
          if (matching[0]) return matching[0];

          const active = renderers.find((el) => {
            const attr = el.getAttribute("is-active");
            return attr === "" || attr === "true";
          });
          if (active) return active;

          return (
            renderers.sort((a, b) => visibleScore(a) - visibleScore(b))[0] ||
            null
          );
        };
        const extractYouTube = (): ExtractedContent | null => {
          const host = window.location.hostname.replace(/^www\./, "");
          if (host !== "youtube.com" && host !== "youtu.be") return null;

          const videoId = youtubeVideoId();
          if (!videoId) return null;
          const clickedIsShort = /\/shorts\/[^/?#]+/.test(clickedUrl || "");
          const isShort =
            clickedIsShort ||
            (!clickedUrl && window.location.pathname.startsWith("/shorts/"));
          const canonicalUrl = isShort
            ? `https://www.youtube.com/shorts/${videoId}`
            : `https://www.youtube.com/watch?v=${videoId}`;
          const thumbnailUrl = `https://i.ytimg.com/vi/${videoId}/maxresdefault.jpg`;

          if (isShort) {
            const root = findShortRenderer(videoId) || document;
            const title =
              queryText(root, [
                "#title h2",
                "h2 #video-title",
                "h2 yt-formatted-string",
                "#video-title",
                "h2",
              ]) || "YouTube Short";
            const author = queryText(root, [
              "ytd-channel-name a",
              "#channel-name a",
              "a[href^='/@']",
              "a[href*='/@']",
            ]);
            return {
              canonicalUrl,
              title: trim(title, 160),
              author: author || undefined,
              description: trim(getMeta("description"), 300),
              thumbnailUrl,
              platform: "youtube",
            };
          }

          const title =
            queryText(document, [
              "h1.ytd-watch-metadata yt-formatted-string",
              "h1.title",
              "h1",
            ]) ||
            trim((document.title || "").replace(/\s+-\s+YouTube$/, ""), 160) ||
            "YouTube video";
          const author = queryText(document, [
            "ytd-channel-name a",
            "#owner-name a",
            "#channel-name a",
            "a[href^='/@']",
          ]);
          return {
            canonicalUrl,
            title: trim(title, 160),
            author: author || undefined,
            description: trim(getMeta("description"), 300),
            thumbnailUrl,
            platform: "youtube",
          };
        };

        const platformResult = extractYouTube();
        if (platformResult) return platformResult;

        const canonicalUrl =
          resolveUrl(clickedUrl) ||
          resolveUrl(getMeta("url")) ||
          resolveUrl(
            document
              .querySelector('link[rel="canonical"]')
              ?.getAttribute("href"),
          ) ||
          window.location.href;
        const title =
          getMeta("title") ||
          document.querySelector("h1")?.textContent?.trim() ||
          document.title ||
          "Saved page";
        const description = getMeta("description");
        const thumbnailUrl = resolveUrl(getMeta("image"));
        const author = getMeta("author");

        return {
          canonicalUrl,
          title: trim(title),
          author: author ?? undefined,
          description: trim(description, 300),
          thumbnailUrl: thumbnailUrl ?? undefined,
          platform: "web",
        };
      },
      args: [clickedUrl],
    });

    return result[0]?.result ?? null;
  } catch {
    return null;
  }
};
