import { extractContent } from "./platform-adapters";
import {
  PAGE_ARCHIVE_CAPTURE_MESSAGE,
  type ArchiveProtocolResponse,
  type PageArchiveCaptureRequest,
} from "@src/services/archive-capture-protocol";

type HoverSaveTarget = {
  url: string;
  title?: string;
};

const normalizeHttpUrl = (value: string | null | undefined): string | null => {
  if (!value) return null;
  try {
    const url = new URL(value, window.location.href);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    return url.toString();
  } catch {
    return null;
  }
};

const findPostAnchor = (target: HTMLElement): HTMLAnchorElement | null => {
  const direct = target.closest("a[href]") as HTMLAnchorElement | null;
  if (direct) return direct;

  const container = target.closest(
    "article, [role='article'], [data-testid='post-container'], shreddit-post, ytd-rich-item-renderer, ytd-video-renderer, .feed-shared-update-v2"
  );
  if (!container) return null;

  return container.querySelector(
    "a[href*='/watch'], a[href*='/shorts/'], a[href*='/status/'], a[href*='/comments/'], a[href*='/feed/update/'], a[href*='/p/'], a[href*='/@']"
  ) as HTMLAnchorElement | null;
};

const resolveHoverSaveTarget = (target: HTMLElement): HoverSaveTarget | null => {
  const anchor = findPostAnchor(target);
  const linkedUrl = normalizeHttpUrl(anchor?.href);
  const extracted = extractContent(target, linkedUrl || undefined);
  const extractedUrl = normalizeHttpUrl(extracted?.canonicalUrl);
  const pageUrl = normalizeHttpUrl(window.location.href);
  const url = extractedUrl && extractedUrl !== pageUrl ? extractedUrl : linkedUrl || extractedUrl;
  if (!url) return null;

  return {
    url,
    title: (extracted?.title || anchor?.textContent || "").trim().slice(0, 160) || undefined,
  };
};

document.addEventListener(
  "contextmenu",
  (event) => {
    const target = event.target instanceof HTMLElement ? event.target : null;
    if (!target) return;

    const saveTarget = resolveHoverSaveTarget(target);
    if (!saveTarget) return;
    void chrome.runtime.sendMessage({
      target: "background",
      type: "HOVER_SAVE_TARGET",
      payload: saveTarget,
    });
  },
  true
);

let archiveCaptureModule: Promise<typeof import("./page-archive-capture")> | null = null;

chrome.runtime.onMessage.addListener((message: PageArchiveCaptureRequest, _sender, sendResponse) => {
  if (message?.type !== PAGE_ARCHIVE_CAPTURE_MESSAGE) return;
  archiveCaptureModule ||= import("./page-archive-capture");
  void archiveCaptureModule
    .then(({ capturePageArchive }) => capturePageArchive(message.payload))
    .then((payload) => sendResponse({ success: true, payload } satisfies ArchiveProtocolResponse))
    .catch((error) =>
      sendResponse({
        success: false,
        error: error instanceof Error ? error.message : "ARCHIVE_CAPTURE_FAILED",
      } satisfies ArchiveProtocolResponse),
    );
  return true;
});
