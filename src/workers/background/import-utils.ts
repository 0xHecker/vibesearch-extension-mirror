import type {
  ImportClickContext,
  ImportMode,
} from "@src/workers/background/import-types";
import { isLikelyDirectResourceUrl } from "@src/utils/metadata-url";

export const LOCAL_IMPORT_HOST = "local.vibesearch.invalid";

const SHARE_URL_HOSTS = new Set([
  "share-worker.shanmukh6789op.workers.dev",
  "share.shanmukh6789op.workers.dev",
  "share-worker.watermelons.workers.dev",
  "share.watermelons.workers.dev",
  "share.vibesearch.app",
]);

export function trimText(value: string, max = 80): string {
  return value.length <= max
    ? value
    : `${value.slice(0, Math.max(0, max - 1)).trim()}…`;
}

export function trimMultilineText(value: string, max = 4_000): string {
  return value
    .replace(/\r\n/g, "\n")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n[ \t]+/g, "\n")
    .replace(/[ \t]{2,}/g, " ")
    .replace(/\s+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim()
    .slice(0, max);
}

export function normalizeHttpUrl(
  value: string | null | undefined,
): string | null {
  if (!value) return null;
  try {
    const parsed = new URL(value.trim());
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:")
      return null;
    return parsed.toString();
  } catch {
    return null;
  }
}

export function isVibeShareUrl(value: string | null | undefined): boolean {
  const normalized = normalizeHttpUrl(value);
  if (!normalized) return false;
  try {
    const parsed = new URL(normalized);
    return (
      SHARE_URL_HOSTS.has(parsed.hostname) &&
      (parsed.pathname.startsWith("/s/") ||
        parsed.pathname.startsWith("/v1/public-shares/"))
    );
  } catch {
    return false;
  }
}

export function pickSharedUrl(context: ImportClickContext): string | null {
  const candidates = [
    context.linkUrl,
    context.pageUrl,
    context.tabUrl,
    context.frameUrl,
  ];
  return candidates.find(isVibeShareUrl) || null;
}

export function normalizeIconUrl(
  value: string | null | undefined,
): string | null {
  const trimmed = value?.trim();
  if (!trimmed) return null;
  if (trimmed.startsWith("data:image/")) return trimmed;
  try {
    const parsed = new URL(trimmed);
    return parsed.protocol === "http:" || parsed.protocol === "https:"
      ? parsed.toString()
      : null;
  } catch {
    return null;
  }
}

export function getFileNameFromUrl(url: string | null | undefined): string {
  if (!url) return "image";
  try {
    const parsed = new URL(url);
    const raw = parsed.pathname.split("/").filter(Boolean).pop() || "image";
    const decoded = decodeURIComponent(raw).replace(/\.[a-z0-9]{2,5}$/i, "");
    return trimText(decoded || "image", 60);
  } catch {
    return "image";
  }
}

export function normalizeSelectionText(value: string): string {
  const lines = value
    .replace(/\r\n/g, "\n")
    .split("\n")
    .map((line) => line.replace(/[ \t]{2,}/g, " ").trim());
  return trimMultilineText(lines.join("\n"), 6_000);
}

export function getHostname(url: string | null | undefined): string | null {
  if (!url) return null;
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return null;
  }
}

export function uniqueList(values: string[]): string[] {
  const seen = new Set<string>();
  const unique: string[] = [];
  for (const raw of values) {
    const value = raw.trim();
    const key = value.toLowerCase();
    if (!value || seen.has(key)) continue;
    seen.add(key);
    unique.push(value);
  }
  return unique;
}

export function pickHostLabel(context: ImportClickContext): string {
  return (
    getHostname(context.linkUrl) ||
    getHostname(context.pageUrl) ||
    getHostname(context.frameUrl) ||
    getHostname(context.mediaUrl) ||
    getHostname(context.tabUrl) ||
    "web"
  ).replace(/^www\./, "");
}

function importModeLabel(mode: ImportMode): string {
  if (mode === "shot") return "Screenshots";
  if (mode === "extract") return "Image text";
  return "Imports";
}

function importModePath(mode: ImportMode): string {
  if (mode === "shot") return "screenshot";
  if (mode === "extract") return "image-text";
  return "import";
}

export function autoFolderName(
  context: ImportClickContext,
  mode: ImportMode,
): string {
  const day = new Date(context.capturedAt).toISOString().slice(0, 10);
  return trimText(
    `${importModeLabel(mode)} · ${pickHostLabel(context)} · ${day}`,
    80,
  );
}

export function buildSyntheticImportUrl(
  context: ImportClickContext,
  mode: ImportMode,
): string {
  const host = pickHostLabel(context)
    .replace(/[^a-z0-9-]/gi, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
  const path = importModePath(mode);
  return `https://${LOCAL_IMPORT_HOST}/${path}/${host || "capture"}/${context.capturedAt}`;
}

export function looksLikeMediaUrl(url: string | null): boolean {
  return isLikelyDirectResourceUrl(url);
}

export function resolveMediaType(
  mediaType: chrome.contextMenus.OnClickData["mediaType"] | null,
  url: string | null,
): "image" | "video" | "audio" | null {
  if (mediaType === "image" || mediaType === "video" || mediaType === "audio") {
    return mediaType;
  }
  if (!url) return null;
  const lower = url.toLowerCase();
  if (
    [".jpg", ".jpeg", ".png", ".gif", ".webp", ".avif"].some((ext) =>
      lower.includes(ext),
    )
  ) {
    return "image";
  }
  if ([".mp4", ".webm", ".mov", ".m3u8"].some((ext) => lower.includes(ext))) {
    return "video";
  }
  if (
    [".mp3", ".wav", ".ogg", ".m4a", ".aac"].some((ext) => lower.includes(ext))
  ) {
    return "audio";
  }
  return null;
}
