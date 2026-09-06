import {
  jsonFiniteNumber,
  jsonObject,
  jsonString,
  type JsonValue,
} from "@src/common/json-value";
import { MEDIA_LIMITS } from "@src/services/media-storage";
import type {
  MetadataEntry,
  MetadataImageAsset,
  MetadataVideoAsset,
} from "@src/services/metadata/types";
import { normalizeIframeEmbedUrl } from "@src/utils/media-embed";

export function normalizeMetadataAssetUrl(
  assetUrl: string | undefined,
  baseUrl: string,
): string | undefined {
  const trimmed = assetUrl?.trim();
  if (!trimmed) return undefined;
  if (trimmed.startsWith("//")) return `https:${trimmed}`;
  if (trimmed.startsWith("/") || !trimmed.includes("://")) {
    try {
      return new URL(trimmed, baseUrl).toString();
    } catch {
      return undefined;
    }
  }
  return trimmed;
}

export function parseMetadataNumber(value: JsonValue | undefined): number | undefined {
  const direct = jsonFiniteNumber(value);
  const parsed = direct ?? Number(jsonString(value));
  return Number.isFinite(parsed) ? parsed : undefined;
}

function parseMetadataDimension(value: JsonValue | undefined): number | undefined {
  const parsed = parseMetadataNumber(value);
  return parsed !== undefined && parsed > 0 ? Math.round(parsed) : undefined;
}

function metadataAssetUrl(value: JsonValue | undefined): string | undefined {
  const direct = jsonString(value);
  if (direct) return direct;
  const record = jsonObject(value);
  return jsonString(record?.secure_url)
    || jsonString(record?.secureUrl)
    || jsonString(record?.url);
}

function isIframeVideoAsset(value: JsonValue | undefined, field: string, url: string): boolean {
  if (field === "twitterPlayer" || field === "ogVideoSecureURL") return true;
  const mimeType = jsonString(jsonObject(value)?.type)?.toLowerCase();
  if (mimeType === "text/html") return true;
  try {
    const parsed = new URL(url);
    return /(^|\.)youtube\.com$/i.test(parsed.hostname) && parsed.pathname.startsWith("/embed/");
  } catch {
    return false;
  }
}

export function collectMetadataImageAssets(
  entry: MetadataEntry,
  fields: string[],
  baseUrl: string,
): MetadataImageAsset[] {
  const assets: MetadataImageAsset[] = [];
  const seen = new Set<string>();
  const add = (value: JsonValue | undefined): void => {
    const record = jsonObject(value);
    const normalized = normalizeMetadataAssetUrl(
      jsonString(value) || jsonString(record?.url),
      baseUrl,
    );
    if (!normalized || seen.has(normalized)) return;
    seen.add(normalized);
    assets.push({
      url: normalized,
      width: parseMetadataDimension(record?.width),
      height: parseMetadataDimension(record?.height),
    });
  };

  for (const field of fields) {
    const value = entry[field];
    if (Array.isArray(value)) {
      for (const image of value) add(image);
    } else {
      add(value);
    }
  }
  return assets.slice(0, MEDIA_LIMITS.image);
}

export function collectMetadataVideoAssets(
  entry: MetadataEntry,
  baseUrl: string,
): MetadataVideoAsset[] {
  const fields = ["ogVideoSecureURL", "ogVideo", "twitterPlayer", "twitterPlayerStream"];
  const assets: MetadataVideoAsset[] = [];
  const seen = new Set<string>();
  const add = (value: JsonValue | undefined, field: string): void => {
    const normalized = normalizeMetadataAssetUrl(metadataAssetUrl(value), baseUrl);
    if (!normalized || seen.has(normalized)) return;
    seen.add(normalized);
    const record = jsonObject(value);
    const iframe = isIframeVideoAsset(value, field, normalized);
    assets.push({
      url: normalized,
      embedUrl: iframe ? normalizeIframeEmbedUrl(normalized) || normalized : undefined,
      embedType: iframe ? "iframe" : undefined,
      width: parseMetadataDimension(record?.width),
      height: parseMetadataDimension(record?.height),
    });
  };

  for (const field of fields) {
    const value = entry[field];
    if (Array.isArray(value)) {
      for (const video of value) add(video, field);
    } else {
      add(value, field);
    }
  }
  return assets.slice(0, MEDIA_LIMITS.video);
}
