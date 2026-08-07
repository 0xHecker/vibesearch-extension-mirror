import { ItemDocType } from "@src/schemas/item_schema";
import { setupOffscreenDocument } from "@src/services/offscreen-helper";
import {
  DEFAULT_METADATA_PREFERENCES,
  getPreferencesForHost,
  pickImageField,
  pickStringField,
} from "@src/utils/metadataPreferences";
import { MEDIA_LIMITS } from "@src/services/media-storage";
import { inferSource } from "@src/utils/infer-source";
import {
  getYouTubeVideoIdFromUrl,
  isYouTubeShortsUrl,
  normalizeIframeEmbedUrl,
} from "@src/utils/media-embed";
import {
  filterMetadataFetchableUrls,
  isMetadataFetchableUrl,
} from "@src/utils/metadata-url";

// --- URL Normalization & Helpers ---

const METADATA_WORKER_BASE_URL = "https://metadata-worker.watermelons.workers.dev";
// Retired custom domain (meta.vibesearch.app) — retry the live workers.dev origin
// instead of a dead host on a transient primary failure.
const LEGACY_METADATA_WORKER_BASE_URL = METADATA_WORKER_BASE_URL;
const META_PREFIX = `${METADATA_WORKER_BASE_URL}/?url=`;
// Kept as a literal so we still recognize & unwrap legacy-proxied URLs already
// stored in items from older builds.
const LEGACY_META_PREFIX = "https://meta.vibesearch.app/?url=";
const METADATA_API_MAX_URLS_PER_REQUEST = 20;
const METADATA_API_QUERY_CHAR_BUDGET = 12_000;
// Abort a worker request that hangs so it can't permanently occupy a
// concurrency slot and stall the whole pipeline.
const METADATA_FETCH_TIMEOUT_MS = 15_000;

function maybeDecode(raw: string): string {
  try {
    const decoded = decodeURIComponent(raw);
    return decoded.includes("://") ? decoded : raw;
  } catch {
    return raw;
  }
}

function normalizeIncomingUrls(input: unknown): string[] {
  const out: string[] = [];
  const add = (u: string) => {
    const trimmed = u.trim();
    if (!trimmed) return;
    if (trimmed.startsWith("chrome://") || trimmed.startsWith("chrome-extension://")) return;
    const metadataPrefix = trimmed.startsWith(META_PREFIX)
      ? META_PREFIX
      : trimmed.startsWith(LEGACY_META_PREFIX)
        ? LEGACY_META_PREFIX
        : null;
    if (metadataPrefix) {
      const after = trimmed.slice(metadataPrefix.length);
      const beforeAmp = after.split("&")[0];
      const rawParts = beforeAmp.split(",");
      for (const part of rawParts) add(maybeDecode(part));
      return;
    }
    if (!trimmed.includes("://") && /%[0-9a-fA-F]{2}/.test(trimmed)) {
      const decoded = maybeDecode(trimmed);
      out.push(decoded);
      return;
    }
    if (trimmed.includes(",") && countSubstr(trimmed, "://") > 1) {
      const parts = trimmed.split(",").map((s) => s.trim());
      for (const p of parts) {
        if (p.includes("://")) add(p);
      }
      return;
    }
    out.push(trimmed);
  };

  if (Array.isArray(input)) {
    for (const u of input) if (typeof u === "string") add(u);
  } else if (typeof input === "string") {
    add(input);
  }
  return Array.from(new Set(out));
}

function countSubstr(haystack: string, needle: string): number {
  let count = 0,
    idx = 0;
  while ((idx = haystack.indexOf(needle, idx)) !== -1) {
    count++;
    idx += needle.length;
  }
  return count;
}

// --- Core Fetching Logic ---

type FetchResult = {
  metadata: Record<string, Partial<ItemDocType>>;
  successfulUrls: Set<string>; // URLs that got a successful API response (even if empty metadata)
  failedUrls: Set<string>; // URLs that failed due to 4xx/5xx or network errors
  queuedUrls: Set<string>; // URLs accepted by the worker queue but not refreshed locally yet
  queuedRetryDelays: Map<string, number>; // URL -> suggested poll delay in ms
  failedRetryDelays: Map<string, number>; // URL -> Retry-After delay in ms (429/503 etc.)
};

const fetchMetadataEndpoint = async (
  urls: string[],
  revalidate: boolean,
  cacheOnly = false
): Promise<Response> => {
  const query = buildMetadataQuery(urls);
  const usePost = query.length > METADATA_API_QUERY_CHAR_BUDGET;
  const suffix = `/?${query}${revalidate ? "&re=1&img=1" : ""}${cacheOnly ? "&co=1" : ""}`;
  const primaryUrl = usePost ? `${METADATA_WORKER_BASE_URL}/` : `${METADATA_WORKER_BASE_URL}${suffix}`;
  const legacyUrl = `${LEGACY_METADATA_WORKER_BASE_URL}${suffix}`;
  const primaryInit = usePost
    ? {
      method: "POST" as const,
      headers: { "Content-Type": "application/json", "X-VS-Metadata-Source": "extension" },
      body: JSON.stringify({ urls, revalidate, refreshImage: revalidate, cacheOnly }),
    }
    : { method: "GET" as const };

  const timeoutFetch = (url: string, init: RequestInit): Promise<Response> => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), METADATA_FETCH_TIMEOUT_MS);
    return fetch(url, { ...init, signal: controller.signal }).finally(() => clearTimeout(timer));
  };

  try {
    const primary = await timeoutFetch(primaryUrl, primaryInit);
    if (primary.ok) return primary;
    if (usePost) return primary;
  } catch { }

  return timeoutFetch(legacyUrl, { method: "GET" as const });
};

const normalizeMetadataAssetUrl = (assetUrl: string | undefined, baseUrl: string): string | undefined => {
  if (!assetUrl || typeof assetUrl !== "string") return undefined;
  const trimmed = assetUrl.trim();
  if (!trimmed) return undefined;
  if (trimmed.startsWith("//")) return `https:${trimmed}`;
  if (trimmed.startsWith("/")) {
    try {
      return new URL(trimmed, baseUrl).toString();
    } catch {
      return undefined;
    }
  }
  if (!trimmed.includes("://")) {
    try {
      return new URL(trimmed, baseUrl).toString();
    } catch {
      return undefined;
    }
  }
  return trimmed;
};

const normalizeYouTubeWatchThumbnail = (
  imageUrl: string | undefined,
  pageUrl: string
): string | undefined => {
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
};

type MetadataImageAsset = {
  url: string;
  width?: number;
  height?: number;
};

const collectMetadataImageAssets = (
  entry: Record<string, any>,
  fields: string[],
  baseUrl: string
): MetadataImageAsset[] => {
  const out: MetadataImageAsset[] = [];
  const seen = new Set<string>();
  const add = (raw: unknown) => {
    const candidate =
      typeof raw === "string"
        ? raw
        : raw && typeof raw === "object" && typeof (raw as { url?: unknown }).url === "string"
          ? ((raw as { url: string }).url)
          : undefined;
    const normalized = normalizeMetadataAssetUrl(candidate, baseUrl);
    if (!normalized || seen.has(normalized)) return;
    seen.add(normalized);
    const record = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : null;
    out.push({
      url: normalized,
      width: record ? parseMetadataDimension(record.width) : undefined,
      height: record ? parseMetadataDimension(record.height) : undefined,
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

  return out.slice(0, MEDIA_LIMITS.image);
};

type MetadataVideoAsset = {
  url: string;
  embedUrl?: string;
  embedType?: "iframe";
  width?: number;
  height?: number;
};

const parseMetadataDimension = (value: unknown): number | undefined => {
  const numberValue = typeof value === "string" ? Number(value) : value;
  return Number.isFinite(numberValue) && (numberValue as number) > 0
    ? Math.round(numberValue as number)
    : undefined;
};

const getMetadataAssetUrl = (raw: unknown): string | undefined => {
  if (typeof raw === "string") return raw;
  if (!raw || typeof raw !== "object") return undefined;
  const record = raw as Record<string, unknown>;
  return (
    (typeof record.secure_url === "string" && record.secure_url) ||
    (typeof record.secureUrl === "string" && record.secureUrl) ||
    (typeof record.url === "string" && record.url) ||
    undefined
  );
};

const isIframeVideoAsset = (raw: unknown, field: string, url: string): boolean => {
  if (field === "twitterPlayer" || field === "ogVideoSecureURL") return true;
  if (raw && typeof raw === "object") {
    const type = `${(raw as Record<string, unknown>).type || ""}`.toLowerCase();
    if (type === "text/html") return true;
  }
  try {
    const parsed = new URL(url);
    return /(^|\.)youtube\.com$/i.test(parsed.hostname) && parsed.pathname.startsWith("/embed/");
  } catch {
    return false;
  }
};

const collectMetadataVideoAssets = (
  entry: Record<string, any>,
  baseUrl: string
): MetadataVideoAsset[] => {
  const fields = ["ogVideoSecureURL", "ogVideo", "twitterPlayer", "twitterPlayerStream"];
  const out: MetadataVideoAsset[] = [];
  const seen = new Set<string>();

  const add = (raw: unknown, field: string) => {
    const candidate = getMetadataAssetUrl(raw);
    const normalized = normalizeMetadataAssetUrl(candidate, baseUrl);
    if (!normalized || seen.has(normalized)) return;
    seen.add(normalized);
    const iframe = isIframeVideoAsset(raw, field, normalized);
    out.push({
      url: normalized,
      embedUrl: iframe ? normalizeIframeEmbedUrl(normalized) || normalized : undefined,
      embedType: iframe ? "iframe" : undefined,
      width:
        raw && typeof raw === "object"
          ? parseMetadataDimension((raw as Record<string, unknown>).width)
          : undefined,
      height:
        raw && typeof raw === "object"
          ? parseMetadataDimension((raw as Record<string, unknown>).height)
          : undefined,
    });
  };

  for (const field of fields) {
    const value = entry[field];
    if (Array.isArray(value)) {
      for (const asset of value) add(asset, field);
    } else {
      add(value, field);
    }
  }

  return out.slice(0, MEDIA_LIMITS.video);
};

const isQueuedMetadataEntry = (entry: Record<string, any>): boolean => {
  return entry.isMetadataQueued === true || entry.metadataQueued === true;
};

const buildMetadataQuery = (urls: string[]): string =>
  urls.map((u) => `url=${encodeURIComponent(u)}`).join("&");

export const chunkUrlsForMetadataRequest = (urls: string[]): string[][] => {
  const batches: string[][] = [];
  let current: string[] = [];
  let currentQueryLength = 0;

  for (const url of urls) {
    const encodedLength = `url=${encodeURIComponent(url)}`.length;
    const separatorLength = current.length > 0 ? 1 : 0;
    const wouldExceedCount = current.length >= METADATA_API_MAX_URLS_PER_REQUEST;
    const wouldExceedQueryBudget =
      current.length > 0 &&
      currentQueryLength + separatorLength + encodedLength > METADATA_API_QUERY_CHAR_BUDGET;

    if (wouldExceedCount || wouldExceedQueryBudget) {
      batches.push(current);
      current = [];
      currentQueryLength = 0;
    }

    current.push(url);
    currentQueryLength += (current.length > 1 ? 1 : 0) + encodedLength;
  }

  if (current.length > 0) batches.push(current);
  return batches;
};

const fetchMetadataForUrls = async (
  urls: string[],
  revalidate = false,
  cacheOnly = false
): Promise<FetchResult> => {
  const result: FetchResult = {
    metadata: {},
    successfulUrls: new Set(),
    failedUrls: new Set(),
    queuedUrls: new Set(),
    queuedRetryDelays: new Map(),
    failedRetryDelays: new Map(),
  };

  if (urls.length === 0) return result;

  const safeUrls = normalizeIncomingUrls(urls);
  // The worker hashes cache keys, so a long URL is still valid metadata input.
  // Keep it alone when it exceeds normal query budget; never drop it from a batch.
  const batches = chunkUrlsForMetadataRequest(safeUrls);

  for (const group of batches) {
    try {
      const res = await fetchMetadataEndpoint(group, revalidate, cacheOnly);
      if (!res.ok) {
        // API returned 4xx/5xx - mark all URLs in this batch as failed and
        // honor any Retry-After the worker sent (e.g. 429/503) so we back off
        // by exactly as long as it asked instead of hammering it.
        console.warn(`Metadata API returned ${res.status} for batch:`, group);
        const retryAfterSeconds = Number(res.headers.get("Retry-After") || 0);
        const retryDelayMs =
          Number.isFinite(retryAfterSeconds) && retryAfterSeconds > 0
            ? Math.ceil(retryAfterSeconds * 1000)
            : 0;
        for (const url of group) {
          result.failedUrls.add(url);
          if (retryDelayMs > 0) result.failedRetryDelays.set(url, retryDelayMs);
        }
        continue;
      }
      const responseRetryAfterSeconds = Number(res.headers.get("Retry-After") || 0);
      const arr = (await res.json()) as any[];
      if (Array.isArray(arr)) {
        const accountedUrls = new Set<string>();
        for (let i = 0; i < arr.length; i++) {
          const entry = arr[i] ?? {};
          const inputUrl = group[i];
          const key = inputUrl || entry.url;
          if (!key) continue;
          accountedUrls.add(key);

          if (isQueuedMetadataEntry(entry)) {
            result.queuedUrls.add(key);
            const entryRetryAfterSeconds = Number(entry.retryAfterSeconds || 0);
            const retryAfterSeconds = Number.isFinite(entryRetryAfterSeconds) && entryRetryAfterSeconds > 0
              ? entryRetryAfterSeconds
              : responseRetryAfterSeconds;
            result.queuedRetryDelays.set(
              key,
              Number.isFinite(retryAfterSeconds) && retryAfterSeconds > 0
                ? Math.ceil(retryAfterSeconds * 1000)
                : QUEUED_METADATA_POLL_DELAY
            );
            continue;
          }

          // Mark as successful - we got a response for this URL
          result.successfulUrls.add(key);

          // Map fields using preferences
          let hostname: string | null = null;
          try {
            hostname = new URL(key).hostname;
          } catch {
            hostname = null;
          }
          const domainPrefs = hostname ? getPreferencesForHost(hostname) : {};
          const preferYouTubeOpenGraph = !!getYouTubeVideoIdFromUrl(key);
          const titleFields = preferYouTubeOpenGraph
            ? ["ogTitle", "twitterTitle", "title"]
            : domainPrefs.title || DEFAULT_METADATA_PREFERENCES.title;
          const descriptionFields =
            preferYouTubeOpenGraph
              ? ["ogDescription", "twitterDescription", "description"]
              : domainPrefs.description || DEFAULT_METADATA_PREFERENCES.description;
          const imageFields = preferYouTubeOpenGraph
            ? ["ogImage", "twitterImage", "image"]
            : domainPrefs.image || DEFAULT_METADATA_PREFERENCES.image;
          const imageAssets = collectMetadataImageAssets(entry, imageFields, key);
          const preferredShortThumbnail = isYouTubeShortsUrl(key)
            ? imageAssets.find(
              (asset) =>
                typeof asset.width === "number" &&
                typeof asset.height === "number" &&
                asset.height > asset.width
            )
            : undefined;
          const orderedImageAssets = preferredShortThumbnail
            ? [
              preferredShortThumbnail,
              ...imageAssets.filter((asset) => asset.url !== preferredShortThumbnail.url),
            ]
            : imageAssets;

          const title = pickStringField(entry, titleFields);
          const description = pickStringField(entry, descriptionFields);
          let favicon = entry.favicon as string | undefined;
          if (favicon && typeof favicon === "string") {
            if (favicon.startsWith("//")) {
              favicon = `https:${favicon}`;
            } else if (favicon.startsWith("/")) {
              try {
                const origin = new URL(key).origin;
                favicon = origin + favicon;
              } catch { }
            } else if (!favicon.includes("://")) {
              try {
                favicon = new URL(favicon, key).toString();
              } catch { }
            }
          }
          let displayImageUrl = preferredShortThumbnail?.url || pickImageField(entry, imageFields);
          displayImageUrl = normalizeMetadataAssetUrl(displayImageUrl, key);
          displayImageUrl = normalizeYouTubeWatchThumbnail(displayImageUrl, key);
          const videoMedia = collectMetadataVideoAssets(entry, key).map((asset) => ({
            type: "video" as const,
            originalUrl: asset.url,
            storageType: "hotlink" as const,
            embedUrl: asset.embedUrl,
            embedType: asset.embedType,
            thumbnailUrl: displayImageUrl,
            pageUrl: key,
            width: asset.width,
            height: asset.height,
          }));
          const imageMedia = orderedImageAssets.map((asset) => {
            const normalizedImageUrl = normalizeYouTubeWatchThumbnail(asset.url, key) || asset.url;
            const isWorkerR2Url = normalizedImageUrl.startsWith(`${METADATA_WORKER_BASE_URL}/r2/`);
            return {
              type: "image" as const,
              originalUrl: normalizedImageUrl,
              storageType: isWorkerR2Url ? ("s3" as const) : ("hotlink" as const),
              s3Url: isWorkerR2Url ? normalizedImageUrl : undefined,
              pageUrl: key,
              width: asset.width,
              height: asset.height,
            };
          });
          const media = preferYouTubeOpenGraph
            ? [...imageMedia, ...videoMedia]
            : [...videoMedia, ...imageMedia];

          const validSources = [
            "web",
            "twitter",
            "reddit",
            "note",
            "youtube",
            "instagram",
            "tiktok",
            "substack",
            "linkedin",
            "github",
            "article",
          ];
          const source = validSources.includes(entry.ogType) ? entry.ogType : inferSource(key);

          const mapped: Partial<ItemDocType> = {
            title: title,
            textContent: description,
            iconUrl: favicon,
            displayImageUrl: displayImageUrl,
            media: media.length > 0 ? media : undefined,
            source: source as any,
            createdAt: entry.ogDate ? new Date(entry.ogDate).getTime() : undefined,
            updatedAt: entry.articleModifiedTime
              ? new Date(entry.articleModifiedTime).getTime()
              : undefined,
            authorUsername: entry.ogSiteName,
          } as Partial<ItemDocType>;

          result.metadata[key] = mapped;
          if (entry.url && entry.url !== key) {
            result.metadata[entry.url] = mapped;
            result.successfulUrls.add(entry.url);
            accountedUrls.add(entry.url);
          }
        }
        for (const url of group) {
          if (
            !accountedUrls.has(url) &&
            !result.successfulUrls.has(url) &&
            !result.queuedUrls.has(url) &&
            !result.failedUrls.has(url)
          ) {
            result.successfulUrls.add(url);
          }
        }
      } else {
        for (const url of group) result.failedUrls.add(url);
      }
    } catch (e) {
      console.error("Error fetching metadata for group:", group, e);
      // Network error or parsing error - mark all URLs in this batch as failed
      for (const url of group) {
        result.failedUrls.add(url);
      }
    }
  }

  return result;
};

// --- Manual, Reliable Request Pipeline ---

type UrlStatus = "idle" | "queued" | "inflight" | "done" | "failed";
type UrlEntry = {
  status: UrlStatus;
  /** Hard fetch attempts (non-poll requests). Bounded by MAX_ATTEMPTS. */
  attempts: number;
  /** Cache-only polls while the worker has the URL queued. Bounded by MAX_QUEUE_POLLS. */
  pollCount: number;
  revalidate: boolean;
  cacheOnly: boolean;
  applyForceRefresh: boolean;
  periodicRetryCount: number;
  updatedAt: number;
};
const urlState = new Map<string, UrlEntry>();
type StoredFailedMetadataUrl = {
  url: string;
  periodicRetryCount: number;
  nextRetryAt: number;
  updatedAt: number;
};

// Hard failures (4xx/5xx/network) get a small retry budget.
const MAX_ATTEMPTS = 3;
const RETRY_BACKOFF = [2_000, 15_000, 60_000]; // ms, gentler; only used when the worker sends no Retry-After
const MAX_PERIODIC_RETRY_RUNS = 3;
const PERIODIC_RETRY_DELAY = 30 * 60_000;
const MAX_PERIODIC_RETRY_DELAY = 45 * 60_000;
// A "queued" (HTTP 202) response is NOT a failure: the worker accepted the URL
// and is fetching it behind a per-domain throttle (maxConcurrent 4, one lease
// per 300ms) with its own queue retries. We must poll it patiently instead of
// giving up after a few tries — counting still-queued work as "failed" was the
// main reason a large bulk import reported most links as failed. At ~30s+ per
// poll this is roughly 20+ minutes of patience before we truly give up.
const MAX_QUEUE_POLLS = 15;
// Four in-flight requests: the worker has no per-IP metadata rate limit, and
// jittered/patient polling (below) already prevents retry storms, so this is a
// good balance of throughput without hammering.
const CONCURRENCY = 4;
// Keep extension requests comfortably below the backend cap (maxUrlsPerRequest
// 100). Twenty URLs turns a 100-tab import into five quick queueing requests
// without oversized GET URLs.
const BATCH_SIZE = METADATA_API_MAX_URLS_PER_REQUEST;
const TICK_INTERVAL = 250; // ms — coalesce more URLs per request, fire less often
const QUEUED_METADATA_POLL_DELAY = 30_000; // matches the worker's defaultPollAfterSeconds
const MAX_RETRY_DELAY = 5 * 60_000; // cap any single backoff/poll wait at 5 min

// Spread scheduled work so hundreds of queued URLs don't re-poll in one
// synchronized wave (thundering herd). Adds 0–50% random slack and caps it.
const withJitter = (ms: number, cap = MAX_RETRY_DELAY): number =>
  Math.min(cap, Math.round(ms + Math.random() * ms * 0.5));

// A URL can still be retried only while it has both hard-attempt budget and
// poll budget left. This bounds every path: an initial fetch that keeps
// erroring stops at MAX_ATTEMPTS, and a cache-only poll that keeps erroring
// stops at MAX_QUEUE_POLLS (cache-only requests increment pollCount, not
// attempts, so they can never burn the hard-failure budget).
const canRetryEntry = (state: UrlEntry): boolean =>
  state.attempts < MAX_ATTEMPTS && state.pollCount < MAX_QUEUE_POLLS;
const URL_STATE_MAX_SIZE = 20000;
const URL_STATE_DONE_TTL = 30 * 60 * 1000;
const URL_STATE_FAILED_TTL = 2 * 60 * 60 * 1000;
const URL_STATE_IDLE_TTL = 10 * 60 * 1000;
const URL_STATE_CLEANUP_INTERVAL = 60 * 1000;
const FAILED_METADATA_STORAGE_KEY = "vibesearch:metadata:failed-v1";

let lastUrlStateCleanupAt = 0;
const failedMetadataUrls = new Set<string>();
const periodicRetryTimers = new Map<string, ReturnType<typeof setTimeout>>();
const queuedPollTimers = new Map<string, ReturnType<typeof setTimeout>>();

type MetadataPipelineStats = {
  scheduledUrls: number;
  fetchedBatches: number;
  successfulUrls: number;
  failedUrls: number;
  retriesScheduled: number;
  evictedUrls: number;
  cleanupRuns: number;
  queueLength: number;
  inflightCount: number;
  urlStateSize: number;
  lastUpdatedAt: number;
};

const pipelineStats: MetadataPipelineStats = {
  scheduledUrls: 0,
  fetchedBatches: 0,
  successfulUrls: 0,
  failedUrls: 0,
  retriesScheduled: 0,
  evictedUrls: 0,
  cleanupRuns: 0,
  queueLength: 0,
  inflightCount: 0,
  urlStateSize: 0,
  lastUpdatedAt: Date.now(),
};

const touchPipelineStats = () => {
  pipelineStats.queueLength = queue.length + batchBuffer.length;
  pipelineStats.inflightCount = inflightCount;
  pipelineStats.urlStateSize = urlState.size;
  pipelineStats.failedUrls = failedMetadataUrls.size;
  pipelineStats.lastUpdatedAt = Date.now();
};

export type MetadataProgressSnapshot = {
  /** Work not yet finished: queued + buffered + in-flight URLs. */
  pending: number;
  inflight: number;
  /** Cumulative counts for this background session. */
  completed: number;
  failed: number;
  scheduled: number;
};

type MetadataProgressListener = (snapshot: MetadataProgressSnapshot) => void;
let metadataProgressListener: MetadataProgressListener | null = null;

/**
 * Register a single observer for metadata queue progress. The background worker
 * uses this to publish a live PROCESS_STATUS row without coupling the pipeline
 * to the extension's status plumbing.
 */
export const setMetadataProgressListener = (listener: MetadataProgressListener | null) => {
  metadataProgressListener = listener;
};

const notifyMetadataProgress = () => {
  if (!metadataProgressListener) return;
  // Count every URL that is still being worked on — including ones sitting on a
  // scheduled poll timer (status stays "inflight"/"queued" between polls). Using
  // only queue/buffer/inflight counters dropped to 0 between polls, which made
  // the status flip complete -> processing -> complete and visibly blink.
  let pending = 0;
  for (const state of urlState.values()) {
    if (state.status === "queued" || state.status === "inflight") pending += 1;
  }
  try {
    metadataProgressListener({
      pending,
      inflight: inflightCount,
      completed: pipelineStats.successfulUrls,
      failed: failedMetadataUrls.size,
      scheduled: pipelineStats.scheduledUrls,
    });
  } catch { }
};

type QueueItem = {
  url: string;
  revalidate: boolean;
  cacheOnly: boolean;
  applyForceRefresh: boolean;
};

const queue: QueueItem[] = [];
let inflightCount = 0;
let batchTimeout: NodeJS.Timeout | null = null;
const batchBuffer: QueueItem[] = [];

const touchEntry = (entry: UrlEntry) => {
  entry.updatedAt = Date.now();
};

const clearPeriodicRetryTimer = (url: string) => {
  const timer = periodicRetryTimers.get(url);
  if (timer) clearTimeout(timer);
  periodicRetryTimers.delete(url);
};

const clearQueuedPollTimer = (url: string) => {
  const timer = queuedPollTimers.get(url);
  if (timer) clearTimeout(timer);
  queuedPollTimers.delete(url);
};

const getStorageLocal = (): chrome.storage.LocalStorageArea | null => {
  try {
    return (globalThis as typeof globalThis & { chrome?: typeof chrome }).chrome?.storage?.local ?? null;
  } catch {
    return null;
  }
};

const readStoredFailedMetadata = async (): Promise<Map<string, StoredFailedMetadataUrl>> => {
  const storage = getStorageLocal();
  if (!storage) return new Map();
  const row = await storage.get(FAILED_METADATA_STORAGE_KEY);
  const raw = row?.[FAILED_METADATA_STORAGE_KEY];
  const entries = Array.isArray(raw) ? raw : [];
  const out = new Map<string, StoredFailedMetadataUrl>();

  for (const entry of entries) {
    if (!entry || typeof entry.url !== "string") continue;
    const url = entry.url.trim();
    if (!isMetadataFetchableUrl(url, { blockedHosts: ["local.vibesearch.invalid"] })) continue;
    const periodicRetryCount = Math.max(0, Math.floor(Number(entry.periodicRetryCount) || 0));
    if (periodicRetryCount >= MAX_PERIODIC_RETRY_RUNS) continue;
    out.set(url, {
      url,
      periodicRetryCount,
      nextRetryAt: Math.max(0, Math.floor(Number(entry.nextRetryAt) || 0)),
      updatedAt: Math.max(0, Math.floor(Number(entry.updatedAt) || 0)),
    });
  }

  return out;
};

const writeStoredFailedMetadata = async (
  records: Map<string, StoredFailedMetadataUrl>
): Promise<void> => {
  const storage = getStorageLocal();
  if (!storage) return;
  await storage.set({
    [FAILED_METADATA_STORAGE_KEY]: Array.from(records.values()).sort(
      (a, b) => a.nextRetryAt - b.nextRetryAt
    ),
  });
};

const upsertStoredFailedMetadata = (
  url: string,
  periodicRetryCount: number,
  nextRetryAt: number
) => {
  void (async () => {
    const records = await readStoredFailedMetadata();
    if (periodicRetryCount >= MAX_PERIODIC_RETRY_RUNS) {
      records.delete(url);
    } else {
      records.set(url, {
        url,
        periodicRetryCount,
        nextRetryAt,
        updatedAt: Date.now(),
      });
    }
    await writeStoredFailedMetadata(records);
  })().catch((error) => {
    console.warn("[MetadataPipeline] Failed to persist failed metadata URL.", error);
  });
};

const removeStoredFailedMetadata = (url: string) => {
  void (async () => {
    const records = await readStoredFailedMetadata();
    if (!records.delete(url)) return;
    await writeStoredFailedMetadata(records);
  })().catch((error) => {
    console.warn("[MetadataPipeline] Failed to clear failed metadata URL.", error);
  });
};

const markMetadataUrlsFetched = async (
  metaMap: Record<string, Partial<ItemDocType>>,
  options: { forceRefresh?: boolean; forceRefreshUrls?: string[] } = {}
): Promise<void> => {
  if (Object.keys(metaMap).length === 0) return;
  await setupOffscreenDocument();
  await chrome.runtime.sendMessage({
    service: "items",
    type: "saveFetchedMetadata",
    target: "offscreen",
    isForwarded: true,
    payload: {
      metaMap,
      forceRefresh: options.forceRefresh,
      forceRefreshUrls: options.forceRefreshUrls,
    },
  });
};

const markSkippedUrlsMetadataComplete = (urls: string[]) => {
  const uniqueUrls = Array.from(new Set(urls));
  if (uniqueUrls.length === 0) return;
  void markMetadataUrlsFetched(
    Object.fromEntries(uniqueUrls.map((url) => [url, { isMetaFetched: true }]))
  ).catch((error) => {
    console.warn("[MetadataPipeline] Failed to mark skipped metadata URLs complete.", error);
  });
};

const queueFailedMetadataRetry = (url: string, state: UrlEntry): boolean => {
  if (state.status === "done") {
    clearQueuedPollTimer(url);
    removeStoredFailedMetadata(url);
    return false;
  }
  if (state.periodicRetryCount >= MAX_PERIODIC_RETRY_RUNS) {
    clearPeriodicRetryTimer(url);
    removeStoredFailedMetadata(url);
    return false;
  }
  if (state.status === "queued" || state.status === "inflight") return false;

  failedMetadataUrls.delete(url);
  clearQueuedPollTimer(url);
  state.status = "queued";
  state.attempts = 0;
  state.pollCount = 0;
  state.periodicRetryCount += 1;
  state.revalidate = false;
  state.cacheOnly = false;
  state.applyForceRefresh = false;
  touchEntry(state);
  upsertStoredFailedMetadata(
    url,
    state.periodicRetryCount,
    Date.now() + PERIODIC_RETRY_DELAY
  );
  addUrlToPipeline(url, false);
  return true;
};

const schedulePeriodicRetry = (url: string, state: UrlEntry) => {
  if (state.periodicRetryCount >= MAX_PERIODIC_RETRY_RUNS) {
    clearPeriodicRetryTimer(url);
    removeStoredFailedMetadata(url);
    return;
  }
  if (periodicRetryTimers.has(url)) return;

  const delay = withJitter(PERIODIC_RETRY_DELAY, MAX_PERIODIC_RETRY_DELAY);
  upsertStoredFailedMetadata(url, state.periodicRetryCount, Date.now() + delay);
  const timer = setTimeout(() => {
    periodicRetryTimers.delete(url);
    const current = urlState.get(url);
    if (!current || current.status === "done") return;
    if (queueFailedMetadataRetry(url, current)) {
      touchPipelineStats();
      notifyMetadataProgress();
    }
  }, delay);
  periodicRetryTimers.set(url, timer);
};

const markUrlFailedForNow = (
  url: string,
  state: UrlEntry,
  payloadMap?: Record<string, Partial<ItemDocType>>
) => {
  clearQueuedPollTimer(url);
  state.status = "failed";
  touchEntry(state);
  if (payloadMap) payloadMap[url] = { isMetaFetched: true };
  if (state.periodicRetryCount < MAX_PERIODIC_RETRY_RUNS) {
    failedMetadataUrls.add(url);
    schedulePeriodicRetry(url, state);
  } else {
    failedMetadataUrls.delete(url);
    clearPeriodicRetryTimer(url);
    removeStoredFailedMetadata(url);
  }
};

export const retryStoredFailedMetadataUrls = async (): Promise<number> => {
  const records = await readStoredFailedMetadata();
  const now = Date.now();
  let queued = 0;

  for (const record of records.values()) {
    if (record.nextRetryAt > now) continue;
    let state = urlState.get(record.url);
    if (!state) {
      state = {
        status: "failed",
        attempts: MAX_ATTEMPTS,
        pollCount: 0,
        revalidate: false,
        cacheOnly: false,
        applyForceRefresh: false,
        periodicRetryCount: record.periodicRetryCount,
        updatedAt: record.updatedAt || now,
      };
      urlState.set(record.url, state);
      failedMetadataUrls.add(record.url);
    } else {
      state.periodicRetryCount = Math.max(state.periodicRetryCount, record.periodicRetryCount);
    }

    if (queueFailedMetadataRetry(record.url, state)) queued += 1;
  }

  touchPipelineStats();
  notifyMetadataProgress();
  return queued;
};

const cleanupUrlState = (force = false) => {
  const now = Date.now();
  if (!force && now - lastUrlStateCleanupAt < URL_STATE_CLEANUP_INTERVAL) {
    return;
  }
  lastUrlStateCleanupAt = now;
  pipelineStats.cleanupRuns += 1;

  for (const [url, state] of urlState.entries()) {
    const age = now - state.updatedAt;
    if (state.status === "done" && age > URL_STATE_DONE_TTL) {
      clearPeriodicRetryTimer(url);
      clearQueuedPollTimer(url);
      failedMetadataUrls.delete(url);
      removeStoredFailedMetadata(url);
      urlState.delete(url);
      pipelineStats.evictedUrls += 1;
      continue;
    }
    if (state.status === "failed" && age > URL_STATE_FAILED_TTL) {
      clearPeriodicRetryTimer(url);
      clearQueuedPollTimer(url);
      failedMetadataUrls.delete(url);
      removeStoredFailedMetadata(url);
      urlState.delete(url);
      pipelineStats.evictedUrls += 1;
      continue;
    }
    if (state.status === "idle" && age > URL_STATE_IDLE_TTL) {
      urlState.delete(url);
      pipelineStats.evictedUrls += 1;
    }
  }

  if (urlState.size <= URL_STATE_MAX_SIZE) {
    return;
  }

  const evictable = Array.from(urlState.entries())
    .filter(([, state]) => state.status !== "queued" && state.status !== "inflight")
    .sort((a, b) => a[1].updatedAt - b[1].updatedAt);

  for (const [url] of evictable) {
    if (urlState.size <= URL_STATE_MAX_SIZE) {
      break;
    }
    clearPeriodicRetryTimer(url);
    clearQueuedPollTimer(url);
    failedMetadataUrls.delete(url);
    removeStoredFailedMetadata(url);
    urlState.delete(url);
    pipelineStats.evictedUrls += 1;
  }
  touchPipelineStats();
};

const isCompatibleQueueItem = (a: QueueItem, b: QueueItem) =>
  a.revalidate === b.revalidate &&
  a.cacheOnly === b.cacheOnly &&
  a.applyForceRefresh === b.applyForceRefresh;

const takeNextBatch = (): QueueItem[] => {
  const first = queue.shift();
  if (!first) return [];
  const batch: QueueItem[] = [first];

  for (let i = 0; i < queue.length && batch.length < BATCH_SIZE;) {
    if (!isCompatibleQueueItem(first, queue[i])) {
      i += 1;
      continue;
    }
    const [next] = queue.splice(i, 1);
    batch.push(next);
  }

  return batch;
};

const processQueue = () => {
  cleanupUrlState();
  touchPipelineStats();
  while (inflightCount < CONCURRENCY && queue.length > 0) {
    inflightCount++;
    touchPipelineStats();
    const batchToProcess = takeNextBatch();
    fetchAndProcessBatch(batchToProcess).finally(() => {
      inflightCount--;
      touchPipelineStats();
      processQueue();
    });
  }
  notifyMetadataProgress();
};

const fetchAndProcessBatch = async (batch: QueueItem[]) => {
  const urls = batch.map((b) => b.url);
  const safeUrls = normalizeIncomingUrls(urls);
  if (safeUrls.length === 0) return;
  pipelineStats.fetchedBatches += 1;

  // Check if any URL in batch needs revalidation (force cache bypass)
  const shouldRevalidate = batch.some((b) => b.revalidate);
  const shouldCacheOnly = batch.every((b) => b.cacheOnly);
  const shouldApplyForceRefresh = batch.some((b) => b.revalidate || b.applyForceRefresh);
  const forceRefreshUrlSet = new Set(
    normalizeIncomingUrls(
      batch.filter((b) => b.revalidate || b.applyForceRefresh).map((b) => b.url)
    )
  );

  // Mark inflight and increment the right counter.
  for (const url of safeUrls) {
    const state = urlState.get(url);
    if (!state) continue;
    state.status = "inflight";
    const batchItem = batch.find((item) => item.url === url);
    if (batchItem) {
      state.cacheOnly = batchItem.cacheOnly;
      state.applyForceRefresh = batchItem.applyForceRefresh;
      state.revalidate = batchItem.revalidate;
    }
    // Cache-only requests are queue polls (the worker is still working on the
    // URL), not fetch attempts. Counting them separately keeps patient polling
    // from ever exhausting the hard-failure budget.
    if (state.cacheOnly) state.pollCount++;
    else state.attempts++;
    touchEntry(state);
  }

  console.log(
    `[MetadataPipeline] Fetching ${safeUrls.length} URLs, revalidate=${shouldRevalidate}, cacheOnly=${shouldCacheOnly}`
  );

  try {
    // Usually one request up to BATCH_SIZE; very long URLs split by encoded query budget.
    const fetchResult = await fetchMetadataForUrls(safeUrls, shouldRevalidate, shouldCacheOnly);

    // Apply successful metadata immediately. URLs that exhaust retries are
    // completed below with an empty patch so their cards never wait forever.
    const payloadMap: Record<string, Partial<ItemDocType>> = {};
    for (const url of safeUrls) {
      if (fetchResult.successfulUrls.has(url)) {
        // URL got a successful response - use metadata if available, otherwise just mark as fetched.
        payloadMap[url] = fetchResult.metadata[url] || { isMetaFetched: true };
      }
    }

    // Mark successful URLs as done
    for (const url of fetchResult.successfulUrls) {
      const state = urlState.get(url);
      if (state) {
        clearQueuedPollTimer(url);
        state.status = "done";
        state.periodicRetryCount = 0;
        touchEntry(state);
      }
      failedMetadataUrls.delete(url);
      clearPeriodicRetryTimer(url);
      removeStoredFailedMetadata(url);
    }
    pipelineStats.successfulUrls += fetchResult.successfulUrls.size;

    for (const url of fetchResult.queuedUrls) {
      const state = urlState.get(url);
      if (!state) continue;
      if (state.pollCount < MAX_QUEUE_POLLS) {
        const applyForceRefreshOnPoll = state.revalidate || state.applyForceRefresh;
        pipelineStats.retriesScheduled += 1;
        // Honor the worker's suggested poll delay, grow it gently the longer a
        // URL stays queued, cap it, and jitter it so hundreds of queued URLs
        // don't all re-poll on the same 30s tick.
        const base = fetchResult.queuedRetryDelays.get(url) || QUEUED_METADATA_POLL_DELAY;
        const pollDelay = withJitter(Math.min(base * (1 + state.pollCount * 0.2), 90_000));
        clearQueuedPollTimer(url);
        const timer = setTimeout(() => {
          queuedPollTimers.delete(url);
          const current = urlState.get(url);
          if (!current || current !== state || current.status === "done" || current.status === "failed") {
            return;
          }
          current.status = "queued";
          current.revalidate = false;
          current.cacheOnly = true;
          current.applyForceRefresh = applyForceRefreshOnPoll;
          touchEntry(current);
          addUrlToPipeline(url, false, {
            cacheOnly: true,
            applyForceRefresh: applyForceRefreshOnPoll,
          });
        }, pollDelay);
        queuedPollTimers.set(url, timer);
      } else {
        markUrlFailedForNow(url, state, payloadMap);
        console.warn(`[MetadataPipeline] Queued metadata did not materialize after ${MAX_QUEUE_POLLS} polls:`, url);
      }
    }

    // Handle failed URLs - schedule a retry, honoring Retry-After when present.
    for (const url of fetchResult.failedUrls) {
      const state = urlState.get(url);
      if (!state) continue;
      if (canRetryEntry(state)) {
        const backoff =
          RETRY_BACKOFF[Math.min(state.attempts, RETRY_BACKOFF.length) - 1] ||
          RETRY_BACKOFF[RETRY_BACKOFF.length - 1];
        const delay = withJitter(fetchResult.failedRetryDelays.get(url) || backoff);
        console.log(`[MetadataPipeline] Scheduling retry for ${url} in ${delay}ms`);
        pipelineStats.retriesScheduled += 1;
        setTimeout(() => {
          if (state.status === "done") return;
          state.status = "queued";
          touchEntry(state);
          addUrlToPipeline(url, state.revalidate, {
            cacheOnly: state.cacheOnly,
            applyForceRefresh: state.applyForceRefresh,
          });
        }, delay);
      } else {
        markUrlFailedForNow(url, state, payloadMap);
        console.warn(`[MetadataPipeline] Permanently failed for URL:`, url);
      }
    }

    if (Object.keys(payloadMap).length > 0) {
      await markMetadataUrlsFetched(payloadMap, {
        forceRefresh: shouldApplyForceRefresh,
        forceRefreshUrls: Array.from(forceRefreshUrlSet),
      });
      console.log(`[MetadataPipeline] Completed metadata work for ${Object.keys(payloadMap).length} URLs`);
    }
  } catch (error) {
    // Complete failure (e.g., offscreen document issue) - retry all URLs
    console.error("[MetadataPipeline] Error in fetchAndProcessBatch:", error);
    const payloadMap: Record<string, Partial<ItemDocType>> = {};
    for (const url of safeUrls) {
      const state = urlState.get(url);
      if (!state) continue;
      if (canRetryEntry(state)) {
        const backoff =
          RETRY_BACKOFF[Math.min(state.attempts, RETRY_BACKOFF.length) - 1] ||
          RETRY_BACKOFF[RETRY_BACKOFF.length - 1];
        const delay = withJitter(backoff);
        pipelineStats.retriesScheduled += 1;
        setTimeout(() => {
          if (state.status === "done") return;
          state.status = "queued";
          touchEntry(state);
          addUrlToPipeline(url, state.revalidate, {
            cacheOnly: state.cacheOnly,
            applyForceRefresh: state.applyForceRefresh,
          });
        }, delay);
      } else {
        markUrlFailedForNow(url, state, payloadMap);
      }
    }
    await markMetadataUrlsFetched(payloadMap).catch((saveError) =>
      console.warn("[MetadataPipeline] Failed to complete failed metadata URLs.", saveError)
    );
  } finally {
    cleanupUrlState();
    touchPipelineStats();
  }
};

const flushBatchBuffer = () => {
  if (batchTimeout) {
    clearTimeout(batchTimeout);
    batchTimeout = null;
  }
  if (batchBuffer.length > 0) {
    queue.push(...batchBuffer);
    batchBuffer.length = 0;
    touchPipelineStats();
    processQueue();
  }
};

const addUrlToPipeline = (
  url: string,
  revalidate: boolean,
  options: { cacheOnly?: boolean; applyForceRefresh?: boolean } = {}
) => {
  batchBuffer.push({
    url,
    revalidate,
    cacheOnly: options.cacheOnly === true,
    applyForceRefresh: options.applyForceRefresh === true,
  });
  touchPipelineStats();
  if (batchBuffer.length >= BATCH_SIZE) {
    flushBatchBuffer();
  } else if (!batchTimeout) {
    batchTimeout = setTimeout(flushBatchBuffer, TICK_INTERVAL);
  }
};

/**
 * Schedule URLs for metadata fetching.
 * @param urls - Array of URLs to fetch metadata for
 * @param forceRefresh - If true, bypasses cache and re-fetches even for already-fetched URLs
 */
export const scheduleForProcessing = (urls: string[], forceRefresh = false) => {
  cleanupUrlState();
  const normalized = normalizeIncomingUrls(urls);
  const fetchable = filterMetadataFetchableUrls(normalized, {
    blockedHosts: ["local.vibesearch.invalid"],
  });
  const skipped = normalized.filter(
    (url) =>
      !isMetadataFetchableUrl(url, { blockedHosts: ["local.vibesearch.invalid"] })
  );
  markSkippedUrlsMetadataComplete(skipped);

  const normalizedFetchable = Array.from(new Set(fetchable));
  if (normalizedFetchable.length === 0) return;

  console.log(
    `[MetadataPipeline] Scheduling ${normalizedFetchable.length} URLs, forceRefresh=${forceRefresh}`
  );

  for (const url of normalizedFetchable) {
    const state = urlState.get(url);
    if (!state) {
      // New URL - add to pipeline
      urlState.set(url, {
        status: "queued",
        attempts: 0,
        pollCount: 0,
        revalidate: forceRefresh,
        cacheOnly: false,
        applyForceRefresh: false,
        periodicRetryCount: 0,
        updatedAt: Date.now(),
      });
      addUrlToPipeline(url, forceRefresh);
      pipelineStats.scheduledUrls += 1;
    } else if (forceRefresh) {
      // Force refresh - reset state and requeue with cache bypass
      state.status = "queued";
      state.attempts = 0;
      state.pollCount = 0;
      state.periodicRetryCount = 0;
      state.revalidate = true;
      state.cacheOnly = false;
      state.applyForceRefresh = false;
      failedMetadataUrls.delete(url);
      clearPeriodicRetryTimer(url);
      clearQueuedPollTimer(url);
      removeStoredFailedMetadata(url);
      touchEntry(state);
      addUrlToPipeline(url, true);
      pipelineStats.scheduledUrls += 1;
    } else if (state.status === "done" || state.status === "idle") {
      // A new local item may have been saved after the previous fetch completed.
      // Requeue without cache bypass so cached worker metadata is applied to current matching items.
      state.status = "queued";
      state.attempts = 0;
      state.pollCount = 0;
      state.revalidate = false;
      state.cacheOnly = false;
      state.applyForceRefresh = false;
      failedMetadataUrls.delete(url);
      clearPeriodicRetryTimer(url);
      clearQueuedPollTimer(url);
      removeStoredFailedMetadata(url);
      touchEntry(state);
      addUrlToPipeline(url, false);
      pipelineStats.scheduledUrls += 1;
    } else if (state.status === "failed") {
      // Keep normal UI visibility pings from restarting failed URLs forever.
      // Failed URLs retry on their periodic timer; forceRefresh still overrides.
      markSkippedUrlsMetadataComplete([url]);
      schedulePeriodicRetry(url, state);
    }
    // If state exists and is "done" or "queued" or "inflight", skip unless forceRefresh
  }
  cleanupUrlState();
  touchPipelineStats();
  notifyMetadataProgress();
};

export const getMetadataPipelineStats = (): MetadataPipelineStats => ({
  ...pipelineStats,
  queueLength: queue.length + batchBuffer.length,
  inflightCount,
  urlStateSize: urlState.size,
  lastUpdatedAt: Date.now(),
});
