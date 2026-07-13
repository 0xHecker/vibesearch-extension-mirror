export const CLOUD_SYNC_CONTINUATION_DELAY_MS = 30_000;

type CloudSyncContinuationResult = {
  remaining?: unknown;
  reason?: unknown;
};

/** Continue only after a successful bounded page, never on an auth or transport failure. */
export const shouldScheduleCloudSyncContinuation = (value: unknown): boolean => {
  if (!value || typeof value !== "object") return false;
  const result = value as CloudSyncContinuationResult;
  return typeof result.remaining === "number" && result.remaining > 0 && result.reason === undefined;
};
