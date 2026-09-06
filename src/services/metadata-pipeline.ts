import type { ItemDocType } from "@src/schemas/item_schema";
import { setupOffscreenDocument } from "@src/services/offscreen-helper";
import { METADATA_API_MAX_URLS_PER_REQUEST } from "@src/services/metadata/constants";
import { fetchMetadataForUrls } from "@src/services/metadata/fetch-client";
import { normalizeMetadataUrls } from "@src/services/metadata/url-normalization";
import {
  filterMetadataFetchableUrls,
  isMetadataFetchableUrl,
} from "@src/utils/metadata-url";
import { z } from "zod";

export { chunkUrlsForMetadataRequest } from "@src/services/metadata/url-normalization";

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

const storedFailedMetadataSchema = z.array(z.object({
  url: z.string(),
  periodicRetryCount: z.coerce.number(),
  nextRetryAt: z.coerce.number(),
  updatedAt: z.coerce.number(),
}));

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
const transientRetryTimers = new Set<ReturnType<typeof setTimeout>>();
const activeFetchControllers = new Set<AbortController>();
const activeBatchPromises = new Set<Promise<void>>();
const activeMetadataWrites = new Set<Promise<unknown>>();
let pipelineGeneration = 0;

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

const trackMetadataWrite = <T>(work: Promise<T>): Promise<T> => {
  activeMetadataWrites.add(work);
  void work.finally(() => activeMetadataWrites.delete(work)).catch(() => {});
  return work;
};

const scheduleTransientRetry = (generation: number, delay: number, callback: () => void) => {
  const timer = setTimeout(() => {
    transientRetryTimers.delete(timer);
    if (generation !== pipelineGeneration) return;
    callback();
  }, delay);
  transientRetryTimers.add(timer);
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
    return globalThis.chrome?.storage?.local ?? null;
  } catch {
    return null;
  }
};

const readStoredFailedMetadata = async (): Promise<Map<string, StoredFailedMetadataUrl>> => {
  const storage = getStorageLocal();
  if (!storage) return new Map();
  const row = await storage.get(FAILED_METADATA_STORAGE_KEY);
  const parsed = storedFailedMetadataSchema.safeParse(row?.[FAILED_METADATA_STORAGE_KEY]);
  const entries = parsed.success ? parsed.data : [];
  const out = new Map<string, StoredFailedMetadataUrl>();

  for (const entry of entries) {
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
  const generation = pipelineGeneration;
  void (async () => {
    const records = await readStoredFailedMetadata();
    if (generation !== pipelineGeneration) return;
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
    if (generation === pipelineGeneration) await writeStoredFailedMetadata(records);
  })().catch((error) => {
    console.warn("[MetadataPipeline] Failed to persist failed metadata URL.", error);
  });
};

const removeStoredFailedMetadata = (url: string) => {
  const generation = pipelineGeneration;
  void (async () => {
    const records = await readStoredFailedMetadata();
    if (generation !== pipelineGeneration) return;
    if (!records.delete(url)) return;
    if (generation === pipelineGeneration) await writeStoredFailedMetadata(records);
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
  void trackMetadataWrite(markMetadataUrlsFetched(
    Object.fromEntries(uniqueUrls.map((url) => [url, { isMetaFetched: true }]))
  )).catch((error) => {
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
  const generation = pipelineGeneration;
  const timer = setTimeout(() => {
    periodicRetryTimers.delete(url);
    if (generation !== pipelineGeneration) return;
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
    const generation = pipelineGeneration;
    const running = fetchAndProcessBatch(batchToProcess, generation);
    activeBatchPromises.add(running);
    running.finally(() => {
      activeBatchPromises.delete(running);
      inflightCount--;
      touchPipelineStats();
      processQueue();
    }).catch(() => {});
  }
  notifyMetadataProgress();
};

const fetchAndProcessBatch = async (batch: QueueItem[], generation = pipelineGeneration) => {
  if (generation !== pipelineGeneration) return;
  const urls = batch.map((b) => b.url);
  const safeUrls = normalizeMetadataUrls(urls);
  if (safeUrls.length === 0) return;
  pipelineStats.fetchedBatches += 1;

  // Check if any URL in batch needs revalidation (force cache bypass)
  const shouldRevalidate = batch.some((b) => b.revalidate);
  const shouldCacheOnly = batch.every((b) => b.cacheOnly);
  const shouldApplyForceRefresh = batch.some((b) => b.revalidate || b.applyForceRefresh);
  const forceRefreshUrlSet = new Set(
    normalizeMetadataUrls(
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
    const fetchResult = await fetchMetadataForUrls(
      safeUrls,
      shouldRevalidate,
      shouldCacheOnly,
      {
        generation,
        isCurrentGeneration: (candidate) => candidate === pipelineGeneration,
        activeControllers: activeFetchControllers,
      },
    );
    if (generation !== pipelineGeneration) return;

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
          if (generation !== pipelineGeneration) return;
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
        scheduleTransientRetry(generation, delay, () => {
          if (state.status === "done") return;
          state.status = "queued";
          touchEntry(state);
          addUrlToPipeline(url, state.revalidate, {
            cacheOnly: state.cacheOnly,
            applyForceRefresh: state.applyForceRefresh,
          });
        });
      } else {
        markUrlFailedForNow(url, state, payloadMap);
        console.warn(`[MetadataPipeline] Permanently failed for URL:`, url);
      }
    }

    if (generation === pipelineGeneration && Object.keys(payloadMap).length > 0) {
      await markMetadataUrlsFetched(payloadMap, {
        forceRefresh: shouldApplyForceRefresh,
        forceRefreshUrls: Array.from(forceRefreshUrlSet),
      });
      console.log(`[MetadataPipeline] Completed metadata work for ${Object.keys(payloadMap).length} URLs`);
    }
  } catch (error) {
    if (generation !== pipelineGeneration) return;
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
        scheduleTransientRetry(generation, delay, () => {
          if (state.status === "done") return;
          state.status = "queued";
          touchEntry(state);
          addUrlToPipeline(url, state.revalidate, {
            cacheOnly: state.cacheOnly,
            applyForceRefresh: state.applyForceRefresh,
          });
        });
      } else {
        markUrlFailedForNow(url, state, payloadMap);
      }
    }
    if (generation !== pipelineGeneration) return;
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
  const normalized = normalizeMetadataUrls(urls);
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

/**
 * Cancel every queued/in-flight metadata mutation and remove its persisted
 * retry URLs. Delete-all awaits this barrier before removing RxDB rows so an
 * old response cannot recreate or modify data after the wipe.
 */
export const clearMetadataPipelineData = async (): Promise<void> => {
  pipelineGeneration += 1;
  if (batchTimeout) {
    clearTimeout(batchTimeout);
    batchTimeout = null;
  }
  for (const timer of transientRetryTimers) clearTimeout(timer);
  transientRetryTimers.clear();
  for (const timer of periodicRetryTimers.values()) clearTimeout(timer);
  periodicRetryTimers.clear();
  for (const timer of queuedPollTimers.values()) clearTimeout(timer);
  queuedPollTimers.clear();
  for (const controller of activeFetchControllers) controller.abort();
  queue.length = 0;
  batchBuffer.length = 0;
  urlState.clear();
  failedMetadataUrls.clear();

  await Promise.allSettled([
    ...Array.from(activeBatchPromises),
    ...Array.from(activeMetadataWrites),
  ]);

  const storage = getStorageLocal();
  if (storage) await storage.remove(FAILED_METADATA_STORAGE_KEY);
  pipelineStats.scheduledUrls = 0;
  pipelineStats.fetchedBatches = 0;
  pipelineStats.successfulUrls = 0;
  pipelineStats.failedUrls = 0;
  pipelineStats.retriesScheduled = 0;
  pipelineStats.queueLength = 0;
  pipelineStats.inflightCount = 0;
  pipelineStats.urlStateSize = 0;
  touchPipelineStats();
  notifyMetadataProgress();
};
