import { getPageData } from "single-file-core/single-file.js";
import {
  PAGE_ARCHIVE_ABORT_MESSAGE,
  PAGE_ARCHIVE_CHUNK_CODE_UNITS,
  PAGE_ARCHIVE_CHUNK_MESSAGE,
  PAGE_ARCHIVE_FINISH_MESSAGE,
  PAGE_ARCHIVE_MAX_RESOURCE_BYTES,
  PAGE_ARCHIVE_MAX_RESOURCE_REQUESTS,
  PAGE_ARCHIVE_MAX_RESOURCE_TOTAL_BYTES,
  PAGE_ARCHIVE_RESOURCE_CONCURRENCY,
  type ArchiveProtocolResponse,
  type PageArchiveCaptureRequest,
} from "@src/services/archive-capture-protocol";
import { isSafeArchiveResourceUrl } from "@src/services/archive-resource-url";
import { mergeCapturedCssWithOriginal } from "@src/services/archive-resource-hints";

type SingleFilePageData = {
  content?: string;
  title?: string;
};

type CaptureContext = {
  sessionId: string;
  deadlineAt: number;
  maxHtmlBytes: number;
  resourceCount: number;
  resourceBytes: number;
  runLimited: <T>(task: () => Promise<T>) => Promise<T>;
};

type OriginalResourceHint = {
  id: string;
  tagName: string;
  attributes: Record<string, string>;
  styleText?: string;
};

let activeContext: CaptureContext | null = null;
let captureInFlight: Promise<{ byteSize: number; chunkCount: number }> | null = null;

const createLimiter = (maxConcurrency: number) => {
  let active = 0;
  const waiting: Array<() => void> = [];
  return async <T>(task: () => Promise<T>): Promise<T> => {
    if (active >= maxConcurrency) await new Promise<void>((resolve) => waiting.push(resolve));
    active += 1;
    try {
      return await task();
    } finally {
      active -= 1;
      waiting.shift()?.();
    }
  };
};

const readLocalResponse = async (response: Response, maxBytes: number): Promise<Uint8Array> => {
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maxBytes) throw new Error("RESOURCE_TOO_LARGE");
  if (!response.body) return new Uint8Array();

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      if (total > maxBytes) throw new Error("RESOURCE_TOO_LARGE");
      chunks.push(value);
    }
  } finally {
    if (total > maxBytes) await reader.cancel().catch(() => {});
    reader.releaseLock();
  }

  const output = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return output;
};

const consumeResourceBudget = (context: CaptureContext, byteSize: number): void => {
  if (byteSize > PAGE_ARCHIVE_MAX_RESOURCE_BYTES) throw new Error("RESOURCE_TOO_LARGE");
  if (context.resourceBytes + byteSize > PAGE_ARCHIVE_MAX_RESOURCE_TOTAL_BYTES) {
    throw new Error("ARCHIVE_RESOURCE_BUDGET");
  }
  context.resourceBytes += byteSize;
};

const fetchForCapture = async (input: RequestInfo | URL, init: RequestInit = {}): Promise<Response> => {
  const context = activeContext;
  if (!context) throw new Error("ARCHIVE_CAPTURE_NOT_ACTIVE");
  if (Date.now() >= context.deadlineAt) throw new Error("ARCHIVE_CAPTURE_DEADLINE");
  if (context.resourceCount >= PAGE_ARCHIVE_MAX_RESOURCE_REQUESTS) throw new Error("ARCHIVE_RESOURCE_LIMIT");
  context.resourceCount += 1;

  const rawUrl = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
  const url = new URL(rawUrl, window.location.href);
  const accept = new Headers(init.headers).get("accept") || "*/*";

  return context.runLimited(async () => {
    if (Date.now() >= context.deadlineAt) throw new Error("ARCHIVE_CAPTURE_DEADLINE");
    if (
      url.protocol !== "data:" &&
      url.protocol !== "blob:" &&
      !isSafeArchiveResourceUrl(url.toString(), window.location.href)
    ) {
      throw new Error("UNSAFE_ARCHIVE_RESOURCE");
    }
    const controller = new AbortController();
    const timeout = window.setTimeout(
      () => controller.abort(),
      Math.max(1, Math.min(12_000, context.deadlineAt - Date.now())),
    );
    try {
      // No host permission is used here. Cross-origin resources are captured only
      // when their own CORS policy allows the current page to read them.
      const response = await fetch(url, {
        method: "GET",
        headers: { accept },
        credentials: url.origin === window.location.origin ? "include" : "omit",
        cache: "force-cache",
        redirect: "follow",
        referrerPolicy: "strict-origin-when-cross-origin",
        signal: controller.signal,
      });
      if (
        response.url &&
        /^https?:/i.test(response.url) &&
        !isSafeArchiveResourceUrl(response.url, window.location.href)
      ) {
        throw new Error("UNSAFE_ARCHIVE_RESOURCE_REDIRECT");
      }
      const bytes = await readLocalResponse(
        response,
        Math.min(PAGE_ARCHIVE_MAX_RESOURCE_BYTES, PAGE_ARCHIVE_MAX_RESOURCE_TOTAL_BYTES - context.resourceBytes),
      );
      consumeResourceBudget(context, bytes.byteLength);
      return new Response(bytes, {
        status: response.status,
        statusText: response.statusText,
        headers: { "content-type": response.headers.get("content-type") || "application/octet-stream" },
      });
    } finally {
      window.clearTimeout(timeout);
    }
  });
};

const singleFileOptions = (deadlineAt: number) => ({
  removeHiddenElements: false,
  removedElementsSelector: "",
  removeUnusedStyles: false,
  removeUnusedFonts: false,
  removeFrames: true,
  compressHTML: true,
  compressCSS: false,
  loadDeferredImages: false,
  filenameTemplate: "archive.html",
  filenameMaxLength: 192,
  filenameMaxLengthUnit: "bytes",
  filenameReplacedCharacters: ["~", "+", "?", "%", "*", ":", "|", "\"", "<", ">", "\\", "\\x00-\\x1f", "\\x7F"],
  filenameReplacementCharacter: "_",
  filenameReplacementCharacters: [],
  replaceEmojisInFilename: false,
  saveFilenameTemplateData: false,
  maxResourceSizeEnabled: true,
  maxResourceSize: PAGE_ARCHIVE_MAX_RESOURCE_BYTES / (1024 * 1024),
  removeAlternativeFonts: true,
  removeAlternativeMedias: true,
  removeAlternativeImages: true,
  groupDuplicateImages: true,
  maxSizeDuplicateImages: 512 * 1024,
  saveRawPage: false,
  saveFavicon: true,
  compressContent: false,
  insertMetaNoIndex: true,
  insertMetaCSP: true,
  insertSingleFileComment: true,
  removeSavedDate: false,
  blockMixedContent: true,
  blockImages: false,
  blockAlternativeImages: true,
  blockStylesheets: false,
  blockFonts: false,
  blockScripts: true,
  blockVideos: false,
  blockAudios: false,
  removeNoScriptTags: true,
  resolveLinks: true,
  resolveFragmentIdentifierURLs: false,
  saveOriginalURLs: true,
  includeInfobar: false,
  displayStats: false,
  userScriptEnabled: false,
  networkTimeout: Math.max(1, Math.min(12_000, deadlineAt - Date.now())),
  imageReductionFactor: 1,
  acceptHeaders: {
    font: "font/woff2,font/woff,*/*;q=0.8",
    image: "image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8",
    stylesheet: "text/css,*/*;q=0.1",
    script: "*/*",
    document: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    video: "video/webm,video/mp4,video/*;q=0.8,*/*;q=0.5",
    audio: "audio/webm,audio/ogg,audio/*;q=0.8,*/*;q=0.5",
  },
});

const isExpectedDocument = (expectedUrl: string): boolean => {
  try {
    const expected = new URL(expectedUrl);
    const current = new URL(window.location.href);
    expected.hash = "";
    current.hash = "";
    return expected.toString() === current.toString();
  } catch {
    return false;
  }
};

const RESOURCE_HINT_ATTRIBUTE = "data-vs-archive-resource-id";
const RESOURCE_HINT_SELECTOR = [
  "link[rel~='stylesheet'][href]",
  "img",
  "source",
  "audio",
  "video",
  "track",
  "[background]",
  "image[href]",
  "feImage[href]",
  "a[download][href]",
  "[style]",
  "style",
].join(",");
const RESOURCE_ATTRIBUTES = ["src", "srcset", "poster", "background", "href", "xlink:href"] as const;

const collectOriginalResourceHints = (sessionId: string): {
  hints: OriginalResourceHint[];
  cleanup: () => void;
} => {
  const hints: OriginalResourceHint[] = [];
  const marked: Array<{ element: Element; previous: string | null }> = [];
  let index = 0;
  for (const element of document.querySelectorAll(RESOURCE_HINT_SELECTOR)) {
    const attributes: Record<string, string> = {};
    for (const name of RESOURCE_ATTRIBUTES) {
      const value = element.getAttribute(name)?.trim();
      if (value) attributes[name] = value;
    }
    const style = element.getAttribute("style");
    if (style) attributes.style = style;
    const styleText = element.tagName.toLowerCase() === "style" ? element.textContent || "" : undefined;
    if (Object.keys(attributes).length === 0 && !styleText) continue;

    const id = `${sessionId}-${index++}`;
    const previous = element.getAttribute(RESOURCE_HINT_ATTRIBUTE);
    element.setAttribute(RESOURCE_HINT_ATTRIBUTE, id);
    marked.push({ element, previous });
    hints.push({ id, tagName: element.tagName.toLowerCase(), attributes, styleText });
  }
  return {
    hints,
    cleanup: () => {
      for (const { element, previous } of marked) {
        if (previous === null) element.removeAttribute(RESOURCE_HINT_ATTRIBUTE);
        else element.setAttribute(RESOURCE_HINT_ATTRIBUTE, previous);
      }
    },
  };
};

const isUsableEmbeddedResource = (value: string | null): boolean =>
  Boolean(value && /^data:/i.test(value) && !/^data:,*$/i.test(value));

const restoreOriginalResourceHints = (html: string, hints: OriginalResourceHint[]): string => {
  const parsed = new DOMParser().parseFromString(html, "text/html");
  const restoredIds = new Set<string>();
  for (const hint of hints) {
    const element = parsed.querySelector(`[${RESOURCE_HINT_ATTRIBUTE}="${CSS.escape(hint.id)}"]`);
    if (!element) continue;
    restoredIds.add(hint.id);
    for (const [name, original] of Object.entries(hint.attributes)) {
      if (name === "style") {
        element.setAttribute(
          name,
          mergeCapturedCssWithOriginal(original, element.getAttribute(name), "declaration"),
        );
        continue;
      }
      const current = element.getAttribute(name);
      if (!isUsableEmbeddedResource(current)) element.setAttribute(name, original);
    }
    if (hint.styleText !== undefined) {
      element.textContent = mergeCapturedCssWithOriginal(
        hint.styleText,
        element.textContent,
        "stylesheet",
      );
    }
    element.removeAttribute(RESOURCE_HINT_ATTRIBUTE);
  }

  // SingleFile can drop an unreadable cross-origin stylesheet. Reinsert only
  // those missing links so the API can fetch and inline them under its SSRF cap.
  for (const hint of hints) {
    if (restoredIds.has(hint.id) || hint.tagName !== "link" || !hint.attributes.href) continue;
    const link = parsed.createElement("link");
    link.setAttribute("rel", "stylesheet");
    link.setAttribute("href", hint.attributes.href);
    parsed.head.appendChild(link);
  }
  parsed.querySelectorAll(`[${RESOURCE_HINT_ATTRIBUTE}]`).forEach((element) =>
    element.removeAttribute(RESOURCE_HINT_ATTRIBUTE),
  );
  const doctype = parsed.doctype ? "<!doctype html>" : "";
  return `${doctype}${parsed.documentElement.outerHTML}`;
};

const nextChunkEnd = (content: string, start: number): number => {
  let end = Math.min(content.length, start + PAGE_ARCHIVE_CHUNK_CODE_UNITS);
  if (
    end < content.length &&
    end > start &&
    content.charCodeAt(end - 1) >= 0xd800 &&
    content.charCodeAt(end - 1) <= 0xdbff &&
    content.charCodeAt(end) >= 0xdc00 &&
    content.charCodeAt(end) <= 0xdfff
  ) {
    end -= 1;
  }
  return end;
};

const sendArchive = async (
  sessionId: string,
  content: string,
  capturedUrl: string,
  title: string,
  maxHtmlBytes: number,
): Promise<{ byteSize: number; chunkCount: number }> => {
  const estimatedBytes = new Blob([content]).size;
  if (estimatedBytes > maxHtmlBytes) throw new Error("ARCHIVE_HTML_TOO_LARGE");

  let sequence = 0;
  for (let start = 0; start < content.length; sequence += 1) {
    const end = nextChunkEnd(content, start);
    const response = (await chrome.runtime.sendMessage({
      target: "background",
      type: PAGE_ARCHIVE_CHUNK_MESSAGE,
      payload: { sessionId, sequence, chunk: content.slice(start, end) },
    })) as ArchiveProtocolResponse<{ byteSize: number }>;
    if (!response?.success) throw new Error(response?.error || "ARCHIVE_CHUNK_FAILED");
    start = end;
  }

  const finished = (await chrome.runtime.sendMessage({
    target: "background",
    type: PAGE_ARCHIVE_FINISH_MESSAGE,
    payload: { sessionId, chunkCount: sequence, capturedUrl, title },
  })) as ArchiveProtocolResponse<{ byteSize: number }>;
  if (!finished?.success || !finished.payload) throw new Error(finished?.error || "ARCHIVE_FINISH_FAILED");
  return { byteSize: finished.payload.byteSize, chunkCount: sequence };
};

export const capturePageArchive = async (
  request: PageArchiveCaptureRequest["payload"],
): Promise<{ byteSize: number; chunkCount: number }> => {
  if (captureInFlight) throw new Error("ARCHIVE_CAPTURE_BUSY");
  if (!isExpectedDocument(request.expectedUrl)) throw new Error("ARCHIVE_PAGE_NAVIGATED");

  const run = (async () => {
    const originalResources = collectOriginalResourceHints(request.sessionId);
    activeContext = {
      sessionId: request.sessionId,
      deadlineAt: request.deadlineAt,
      maxHtmlBytes: request.maxHtmlBytes,
      resourceCount: 0,
      resourceBytes: 0,
      runLimited: createLimiter(PAGE_ARCHIVE_RESOURCE_CONCURRENCY),
    };
    try {
      const pageData = (await getPageData(
        singleFileOptions(request.deadlineAt),
        { fetch: fetchForCapture, frameFetch: fetchForCapture },
        document,
        window,
      )) as SingleFilePageData;
      const rawContent = typeof pageData.content === "string" ? pageData.content : "";
      const content = restoreOriginalResourceHints(rawContent, originalResources.hints);
      if (content.length < 20) throw new Error("ARCHIVE_CAPTURE_EMPTY");
      if (!isExpectedDocument(request.expectedUrl)) throw new Error("ARCHIVE_PAGE_NAVIGATED");
      return await sendArchive(
        request.sessionId,
        content,
        window.location.href,
        pageData.title || document.title || "",
        request.maxHtmlBytes,
      );
    } catch (error) {
      await chrome.runtime.sendMessage({
        target: "background",
        type: PAGE_ARCHIVE_ABORT_MESSAGE,
        payload: {
          sessionId: request.sessionId,
          reason: error instanceof Error ? error.message : "ARCHIVE_CAPTURE_FAILED",
        },
      }).catch(() => {});
      throw error;
    } finally {
      originalResources.cleanup();
      activeContext = null;
    }
  })();
  captureInFlight = run;
  try {
    return await run;
  } finally {
    if (captureInFlight === run) captureInFlight = null;
  }
};
