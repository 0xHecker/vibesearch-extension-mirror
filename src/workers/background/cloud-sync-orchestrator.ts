import { legacyCloudEnabled } from "@src/services/extension-policy";
import {
  CLOUD_SYNC_CONTINUATION_DELAY_MS,
  shouldScheduleCloudSyncContinuation,
} from "@src/services/cloud-sync-continuation";
import type { CloudSyncPullResult } from "@src/services/cloud-sync";
import { isOnline } from "@src/workers/background/network-state";
import { sendForwardedToOffscreen } from "@src/workers/background/runtime";

export const CLOUD_SYNC_CONTINUATION_ALARM_NAME = "cloud-sync-continuation";
export const CLOUD_SYNC_SELECTION_LIMIT = 200;

let syncInFlight: Promise<void> | null = null;
let syncRequestVersion = 0;

export const cancelCloudSyncRequests = (): void => {
  syncRequestVersion += 1;
};

export const scheduleCloudSyncContinuation = async (): Promise<void> => {
  if (!await legacyCloudEnabled()) return;
  try {
    await chrome.alarms.create(CLOUD_SYNC_CONTINUATION_ALARM_NAME, {
      when: Date.now() + CLOUD_SYNC_CONTINUATION_DELAY_MS,
    });
  } catch (error) {
    console.warn("[cloudSync] continuation alarm was not scheduled", error);
  }
};

/** Pull is additive, so a failed cross-device merge cannot remove local data. */
export const pullCloudChanges = async (): Promise<
  CloudSyncPullResult | undefined
> => {
  if (!await legacyCloudEnabled()) return;
  try {
    const result = await sendForwardedToOffscreen<CloudSyncPullResult>({
      service: "cloudSync",
      type: "pull",
      payload: { maxPages: 4 },
    });
    if (result.inserted) {
      chrome.runtime
        .sendMessage({ type: "DB_CHANGE", scope: "items" })
        .catch(() => {});
    }
    return result;
  } catch (error) {
    console.warn("[cloudSync] pull skipped", error);
    return undefined;
  }
};

export const triggerCloudSync = (): Promise<void> => {
  if (!isOnline()) return Promise.resolve();
  syncRequestVersion += 1;
  if (syncInFlight) return syncInFlight;

  const runVersion = syncRequestVersion;
  const run = (async () => {
    if (!await legacyCloudEnabled()) return;
    try {
      const rawResult = await sendForwardedToOffscreen<unknown>({
        service: "cloudSync",
        type: "drain",
        payload: { maxBatches: 10 },
      });

      const pulled = await pullCloudChanges();
      if (
        shouldScheduleCloudSyncContinuation(rawResult) ||
        pulled?.hasMore === true ||
        syncRequestVersion > runVersion
      ) {
        await scheduleCloudSyncContinuation();
      }
    } catch (error) {
      console.warn("[cloudSync] upload skipped", error);
      if (syncRequestVersion > runVersion)
        await scheduleCloudSyncContinuation();
    }
  })().finally(() => {
    syncInFlight = null;
  });
  syncInFlight = run;
  return run;
};
