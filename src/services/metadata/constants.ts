export const METADATA_WORKER_BASE_URL = "https://metadata-worker.watermelons.workers.dev";
export const METADATA_PROXY_PREFIX = `${METADATA_WORKER_BASE_URL}/?url=`;
export const LEGACY_METADATA_PROXY_PREFIX = "https://meta.vibesearch.app/?url=";
export const METADATA_API_MAX_URLS_PER_REQUEST = 20;
export const METADATA_API_QUERY_CHAR_BUDGET = 12_000;
export const METADATA_FETCH_TIMEOUT_MS = 15_000;
export const QUEUED_METADATA_POLL_DELAY_MS = 30_000;
