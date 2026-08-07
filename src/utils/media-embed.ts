const METADATA_WORKER_BASE_URL = "https://metadata-worker.watermelons.workers.dev";

const YOUTUBE_VIDEO_ID_PATTERN = /^[a-zA-Z0-9_-]{6,20}$/;

export const getYouTubeVideoIdFromUrl = (value: string): string | null => {
  try {
    const parsed = new URL(value);
    const host = parsed.hostname.replace(/^www\./, "").toLowerCase();
    if (host === "youtu.be") {
      const id = parsed.pathname.split("/").filter(Boolean)[0] || "";
      return YOUTUBE_VIDEO_ID_PATTERN.test(id) ? id : null;
    }
    if (host !== "youtube.com" && host !== "youtube-nocookie.com") return null;

    const pathParts = parsed.pathname.split("/").filter(Boolean);
    const first = pathParts[0] || "";
    if (first === "embed" || first === "shorts") {
      const id = pathParts[1] || "";
      return YOUTUBE_VIDEO_ID_PATTERN.test(id) ? id : null;
    }

    const watchId = parsed.searchParams.get("v") || "";
    return YOUTUBE_VIDEO_ID_PATTERN.test(watchId) ? watchId : null;
  } catch {
    return null;
  }
};

export const getPreferredYouTubeVideoId = (
  clickedUrl: string | null | undefined,
  pageUrl: string | null | undefined
): string | null => getYouTubeVideoIdFromUrl(clickedUrl || "") || getYouTubeVideoIdFromUrl(pageUrl || "");

export const getWorkerYouTubeEmbedUrl = (videoId: string): string | null => {
  if (!YOUTUBE_VIDEO_ID_PATTERN.test(videoId)) return null;
  return `${METADATA_WORKER_BASE_URL}/embed/youtube/${encodeURIComponent(videoId)}`;
};

export const isYouTubeWatchUrl = (value: string | undefined): boolean => {
  if (!value) return false;
  try {
    const parsed = new URL(value);
    const host = parsed.hostname.replace(/^www\./, "").toLowerCase();
    return host === "youtube.com" && parsed.pathname === "/watch" && !!parsed.searchParams.get("v");
  } catch {
    return false;
  }
};

export const isYouTubeShortsUrl = (value: string | undefined): boolean => {
  if (!value) return false;
  try {
    const parsed = new URL(value);
    const host = parsed.hostname.replace(/^www\./, "").toLowerCase();
    return (host === "youtube.com" || host === "m.youtube.com") && parsed.pathname.startsWith("/shorts/");
  } catch {
    return false;
  }
};

export const normalizeIframeEmbedUrl = (value: string | undefined): string | null => {
  if (!value) return null;
  try {
    const parsed = new URL(value);
    if (parsed.protocol !== "https:") return null;
    const youtubeVideoId = getYouTubeVideoIdFromUrl(parsed.toString());
    if (youtubeVideoId) return getWorkerYouTubeEmbedUrl(youtubeVideoId);
    return parsed.toString();
  } catch {
    return null;
  }
};

type IframeSandboxOptions = {
  allowForms?: boolean;
  allowPopups?: boolean;
  allowPresentation?: boolean;
};

const isExternalWebUrl = (value: string): boolean => {
  try {
    const parsed = new URL(value);
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
};

/**
 * External embeds need their own origin for common media-player behavior.
 * Never grant it to an extension-relative, data, blob, or malformed source:
 * combining scripts and same-origin for those sources would let same-origin
 * content escape its iframe sandbox.
 */
export const getExternalEmbedSandbox = (
  source: string,
  options: IframeSandboxOptions = {}
): string => {
  const permissions = ["allow-scripts"];
  if (isExternalWebUrl(source)) permissions.push("allow-same-origin");
  if (options.allowForms) permissions.push("allow-forms");
  if (options.allowPopups) permissions.push("allow-popups");
  if (options.allowPresentation) permissions.push("allow-presentation");
  return permissions.join(" ");
};
