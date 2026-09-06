import {
  jsonObject,
  readJsonResponse,
} from "@src/common/json-value";
import {
  METADATA_API_QUERY_CHAR_BUDGET,
  METADATA_FETCH_TIMEOUT_MS,
  METADATA_WORKER_BASE_URL,
  QUEUED_METADATA_POLL_DELAY_MS,
} from "@src/services/metadata/constants";
import {
  isQueuedMetadataEntry,
  mapMetadataEntry,
  metadataEntryRetryAfterSeconds,
  metadataEntryUrl,
} from "@src/services/metadata/entry-mapper";
import type {
  MetadataFetchResult,
  MetadataFetchRuntime,
} from "@src/services/metadata/types";
import {
  buildMetadataQuery,
  chunkUrlsForMetadataRequest,
  normalizeMetadataUrls,
} from "@src/services/metadata/url-normalization";

function emptyFetchResult(): MetadataFetchResult {
  return {
    metadata: {},
    successfulUrls: new Set(),
    failedUrls: new Set(),
    queuedUrls: new Set(),
    queuedRetryDelays: new Map(),
    failedRetryDelays: new Map(),
  };
}

async function fetchWithTimeout(
  runtime: MetadataFetchRuntime,
  url: string,
  init: RequestInit,
): Promise<Response> {
  if (!runtime.isCurrentGeneration(runtime.generation)) {
    throw new DOMException("Metadata pipeline reset", "AbortError");
  }
  const controller = new AbortController();
  runtime.activeControllers.add(controller);
  const timeout = setTimeout(() => controller.abort(), METADATA_FETCH_TIMEOUT_MS);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timeout);
    runtime.activeControllers.delete(controller);
  }
}

async function fetchMetadataEndpoint(
  urls: string[],
  revalidate: boolean,
  cacheOnly: boolean,
  runtime: MetadataFetchRuntime,
): Promise<Response> {
  const query = buildMetadataQuery(urls);
  const usePost = query.length > METADATA_API_QUERY_CHAR_BUDGET;
  const flags = `${revalidate ? "&re=1&img=1" : ""}${cacheOnly ? "&co=1" : ""}`;
  const queryUrl = `${METADATA_WORKER_BASE_URL}/?${query}${flags}`;
  const primaryUrl = usePost ? `${METADATA_WORKER_BASE_URL}/` : queryUrl;
  const primaryInit: RequestInit = usePost
    ? {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-VS-Metadata-Source": "extension",
        },
        body: JSON.stringify({ urls, revalidate, refreshImage: revalidate, cacheOnly }),
      }
    : { method: "GET" };

  try {
    const response = await fetchWithTimeout(runtime, primaryUrl, primaryInit);
    if (response.ok || usePost) return response;
  } catch {
    // Retry GET below; transient worker errors should not strand the queue.
  }
  return fetchWithTimeout(runtime, queryUrl, { method: "GET" });
}

function retryAfterMilliseconds(seconds: number | undefined): number {
  return seconds !== undefined && seconds > 0 ? Math.ceil(seconds * 1_000) : 0;
}

async function processResponseBatch(
  response: Response,
  group: string[],
  result: MetadataFetchResult,
): Promise<void> {
  if (!response.ok) {
    console.warn(`Metadata API returned ${response.status} for batch:`, group);
    const retryDelay = retryAfterMilliseconds(Number(response.headers.get("Retry-After")));
    for (const url of group) {
      result.failedUrls.add(url);
      if (retryDelay > 0) result.failedRetryDelays.set(url, retryDelay);
    }
    return;
  }

  const responseRetrySeconds = Number(response.headers.get("Retry-After"));
  const payload = await readJsonResponse(response);
  if (!Array.isArray(payload)) {
    for (const url of group) result.failedUrls.add(url);
    return;
  }

  const accountedUrls = new Set<string>();
  for (const [index, value] of payload.entries()) {
    const entry = jsonObject(value) ?? {};
    const inputUrl = group[index];
    const key = inputUrl || metadataEntryUrl(entry);
    if (!key) continue;
    accountedUrls.add(key);

    if (isQueuedMetadataEntry(entry)) {
      result.queuedUrls.add(key);
      const requestedDelay = metadataEntryRetryAfterSeconds(entry) ?? responseRetrySeconds;
      result.queuedRetryDelays.set(
        key,
        retryAfterMilliseconds(requestedDelay) || QUEUED_METADATA_POLL_DELAY_MS,
      );
      continue;
    }

    result.successfulUrls.add(key);
    const mapped = mapMetadataEntry(entry, key);
    result.metadata[key] = mapped;
    const responseUrl = metadataEntryUrl(entry);
    if (responseUrl && responseUrl !== key) {
      result.metadata[responseUrl] = mapped;
      result.successfulUrls.add(responseUrl);
      accountedUrls.add(responseUrl);
    }
  }

  for (const url of group) {
    if (
      !accountedUrls.has(url)
      && !result.successfulUrls.has(url)
      && !result.queuedUrls.has(url)
      && !result.failedUrls.has(url)
    ) {
      result.successfulUrls.add(url);
    }
  }
}

export async function fetchMetadataForUrls(
  urls: string[],
  revalidate: boolean,
  cacheOnly: boolean,
  runtime: MetadataFetchRuntime,
): Promise<MetadataFetchResult> {
  const result = emptyFetchResult();
  const safeUrls = normalizeMetadataUrls(urls);
  for (const group of chunkUrlsForMetadataRequest(safeUrls)) {
    if (!runtime.isCurrentGeneration(runtime.generation)) break;
    try {
      const response = await fetchMetadataEndpoint(group, revalidate, cacheOnly, runtime);
      if (!runtime.isCurrentGeneration(runtime.generation)) break;
      await processResponseBatch(response, group, result);
    } catch (cause) {
      console.error("Error fetching metadata for group:", group, cause);
      for (const url of group) result.failedUrls.add(url);
    }
  }
  return result;
}
