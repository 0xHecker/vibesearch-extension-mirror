import {
  LEGACY_METADATA_PROXY_PREFIX,
  METADATA_API_MAX_URLS_PER_REQUEST,
  METADATA_API_QUERY_CHAR_BUDGET,
  METADATA_PROXY_PREFIX,
} from "@src/services/metadata/constants";

function maybeDecodeUrl(raw: string): string {
  try {
    const decoded = decodeURIComponent(raw);
    return decoded.includes("://") ? decoded : raw;
  } catch {
    return raw;
  }
}

function occurrenceCount(haystack: string, needle: string): number {
  let count = 0;
  let cursor = 0;
  while (true) {
    cursor = haystack.indexOf(needle, cursor);
    if (cursor === -1) return count;
    count += 1;
    cursor += needle.length;
  }
}

function metadataProxyPrefix(url: string): string | null {
  if (url.startsWith(METADATA_PROXY_PREFIX)) return METADATA_PROXY_PREFIX;
  if (url.startsWith(LEGACY_METADATA_PROXY_PREFIX)) return LEGACY_METADATA_PROXY_PREFIX;
  return null;
}

export function normalizeMetadataUrls(input: string | string[]): string[] {
  const normalized: string[] = [];
  const add = (candidate: string): void => {
    const url = candidate.trim();
    if (!url || url.startsWith("chrome://") || url.startsWith("chrome-extension://")) return;

    const proxyPrefix = metadataProxyPrefix(url);
    if (proxyPrefix) {
      const encodedUrls = url.slice(proxyPrefix.length).split("&")[0].split(",");
      for (const encodedUrl of encodedUrls) add(maybeDecodeUrl(encodedUrl));
      return;
    }
    if (!url.includes("://") && /%[0-9a-fA-F]{2}/.test(url)) {
      normalized.push(maybeDecodeUrl(url));
      return;
    }
    if (url.includes(",") && occurrenceCount(url, "://") > 1) {
      for (const part of url.split(",")) {
        if (part.includes("://")) add(part);
      }
      return;
    }
    normalized.push(url);
  };

  for (const candidate of Array.isArray(input) ? input : [input]) add(candidate);
  return [...new Set(normalized)];
}

export function buildMetadataQuery(urls: string[]): string {
  return urls.map((url) => `url=${encodeURIComponent(url)}`).join("&");
}

export function chunkUrlsForMetadataRequest(urls: string[]): string[][] {
  const batches: string[][] = [];
  let current: string[] = [];
  let currentQueryLength = 0;

  for (const url of urls) {
    const encodedLength = `url=${encodeURIComponent(url)}`.length;
    const separatorLength = current.length > 0 ? 1 : 0;
    const exceedsCount = current.length >= METADATA_API_MAX_URLS_PER_REQUEST;
    const exceedsBudget =
      current.length > 0 &&
      currentQueryLength + separatorLength + encodedLength > METADATA_API_QUERY_CHAR_BUDGET;
    if (exceedsCount || exceedsBudget) {
      batches.push(current);
      current = [];
      currentQueryLength = 0;
    }
    current.push(url);
    currentQueryLength += (current.length > 1 ? 1 : 0) + encodedLength;
  }
  if (current.length > 0) batches.push(current);
  return batches;
}
