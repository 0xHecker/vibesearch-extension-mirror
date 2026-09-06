import {
  jsonBoolean,
  jsonString,
} from "@src/common/json-value";
import type { ItemDocType } from "@src/schemas/item_schema";
import {
  collectMetadataImageAssets,
  collectMetadataVideoAssets,
  normalizeMetadataAssetUrl,
  parseMetadataNumber,
} from "@src/services/metadata/assets";
import { METADATA_WORKER_BASE_URL } from "@src/services/metadata/constants";
import type { MetadataEntry } from "@src/services/metadata/types";
import { inferSource } from "@src/utils/infer-source";
import {
  getYouTubeVideoIdFromUrl,
  isYouTubeShortsUrl,
} from "@src/utils/media-embed";
import {
  DEFAULT_METADATA_PREFERENCES,
  getPreferencesForHost,
  pickImageField,
  pickStringField,
} from "@src/utils/metadataPreferences";
import { z } from "zod";

const itemSourceSchema: z.ZodType<ItemDocType["source"]> = z.enum([
  "web",
  "twitter",
  "reddit",
  "note",
  "youtube",
  "instagram",
  "tiktok",
  "substack",
  "linkedin",
  "threads",
  "mastodon",
  "bluesky",
  "github",
  "spotify",
  "ytmusic",
  "vimeo",
  "soundcloud",
  "article",
]);

function normalizeYouTubeWatchThumbnail(
  imageUrl: string | undefined,
  pageUrl: string,
): string | undefined {
  const videoId = getYouTubeVideoIdFromUrl(pageUrl);
  if (!imageUrl || !videoId) return imageUrl;
  try {
    const parsed = new URL(imageUrl);
    const host = parsed.hostname.replace(/^www\./, "").toLowerCase();
    if (host !== "i.ytimg.com" && host !== "img.youtube.com") return imageUrl;
    if (!/\/(maxresdefault|sddefault)\.jpg$/i.test(parsed.pathname)) return imageUrl;
    return `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`;
  } catch {
    return imageUrl;
  }
}

function normalizeFavicon(entry: MetadataEntry, pageUrl: string): string | undefined {
  const favicon = jsonString(entry.favicon)?.trim();
  if (!favicon) return undefined;
  if (favicon.startsWith("//")) return `https:${favicon}`;
  if (favicon.startsWith("/") || !favicon.includes("://")) {
    try {
      return new URL(favicon, pageUrl).toString();
    } catch {
      return undefined;
    }
  }
  return favicon;
}

function metadataTimestamp(entry: MetadataEntry, field: string): number | undefined {
  const value = jsonString(entry[field]);
  if (!value) return undefined;
  const timestamp = new Date(value).getTime();
  return Number.isFinite(timestamp) ? timestamp : undefined;
}

function resolveSource(entry: MetadataEntry, pageUrl: string): ItemDocType["source"] {
  const parsed = itemSourceSchema.safeParse(jsonString(entry.ogType));
  return parsed.success ? parsed.data : inferSource(pageUrl);
}

export function isQueuedMetadataEntry(entry: MetadataEntry): boolean {
  return jsonBoolean(entry.isMetadataQueued) === true
    || jsonBoolean(entry.metadataQueued) === true;
}

export function metadataEntryRetryAfterSeconds(entry: MetadataEntry): number | undefined {
  return parseMetadataNumber(entry.retryAfterSeconds);
}

export function metadataEntryUrl(entry: MetadataEntry): string | undefined {
  return jsonString(entry.url);
}

export function mapMetadataEntry(
  entry: MetadataEntry,
  pageUrl: string,
): Partial<ItemDocType> {
  let hostname: string | null = null;
  try {
    hostname = new URL(pageUrl).hostname;
  } catch {
    hostname = null;
  }
  const preferences = hostname ? getPreferencesForHost(hostname) : {};
  const isYouTube = Boolean(getYouTubeVideoIdFromUrl(pageUrl));
  const titleFields = isYouTube
    ? ["ogTitle", "twitterTitle", "title"]
    : preferences.title || DEFAULT_METADATA_PREFERENCES.title;
  const descriptionFields = isYouTube
    ? ["ogDescription", "twitterDescription", "description"]
    : preferences.description || DEFAULT_METADATA_PREFERENCES.description;
  const imageFields = isYouTube
    ? ["ogImage", "twitterImage", "image"]
    : preferences.image || DEFAULT_METADATA_PREFERENCES.image;

  const imageAssets = collectMetadataImageAssets(entry, imageFields, pageUrl);
  const verticalThumbnail = isYouTubeShortsUrl(pageUrl)
    ? imageAssets.find((asset) =>
        asset.width !== undefined
        && asset.height !== undefined
        && asset.height > asset.width)
    : undefined;
  const orderedImages = verticalThumbnail
    ? [verticalThumbnail, ...imageAssets.filter((asset) => asset.url !== verticalThumbnail.url)]
    : imageAssets;
  let displayImageUrl = verticalThumbnail?.url || pickImageField(entry, imageFields);
  displayImageUrl = normalizeMetadataAssetUrl(displayImageUrl, pageUrl);
  displayImageUrl = normalizeYouTubeWatchThumbnail(displayImageUrl, pageUrl);

  const videos = collectMetadataVideoAssets(entry, pageUrl).map((asset) => ({
    type: "video" as const,
    originalUrl: asset.url,
    storageType: "hotlink" as const,
    embedUrl: asset.embedUrl,
    embedType: asset.embedType,
    thumbnailUrl: displayImageUrl,
    pageUrl,
    width: asset.width,
    height: asset.height,
  }));
  const images = orderedImages.map((asset) => {
    const url = normalizeYouTubeWatchThumbnail(asset.url, pageUrl) || asset.url;
    const storedByWorker = url.startsWith(`${METADATA_WORKER_BASE_URL}/r2/`);
    return {
      type: "image" as const,
      originalUrl: url,
      storageType: storedByWorker ? "s3" as const : "hotlink" as const,
      s3Url: storedByWorker ? url : undefined,
      pageUrl,
      width: asset.width,
      height: asset.height,
    };
  });
  const media = isYouTube ? [...images, ...videos] : [...videos, ...images];

  return {
    title: pickStringField(entry, titleFields),
    textContent: pickStringField(entry, descriptionFields),
    iconUrl: normalizeFavicon(entry, pageUrl),
    displayImageUrl,
    media: media.length > 0 ? media : undefined,
    source: resolveSource(entry, pageUrl),
    createdAt: metadataTimestamp(entry, "ogDate"),
    updatedAt: metadataTimestamp(entry, "articleModifiedTime"),
    authorUsername: jsonString(entry.ogSiteName),
  };
}
