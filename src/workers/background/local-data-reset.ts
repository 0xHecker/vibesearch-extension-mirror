import { clearMetadataPipelineData } from "@src/services/metadata-pipeline";
import {
  LOCAL_DATA_RESET_EPOCH_STORAGE_KEY,
  LOCAL_DATA_RESET_STORAGE_KEY,
} from "@src/services/large-payload-staging";
import {
  cancelAllArchiveCaptures,
  clearArchiveData,
  resumeArchiveWrites,
  suspendArchiveWrites,
} from "@src/workers/background/archive-orchestrator";
import {
  CLOUD_SYNC_CONTINUATION_ALARM_NAME,
  cancelCloudSyncRequests,
} from "@src/workers/background/cloud-sync-orchestrator";
import { clearHoverSaveTargets } from "@src/workers/background/import-context";
import { clearPendingScreenshots } from "@src/workers/background/import-actions";
import { clearImportStorage } from "@src/workers/background/import-storage";
import {
  OPFS_MEDIA_RECONCILE_CONTINUATION_ALARM_NAME,
  OPFS_MEDIA_RECONCILE_CURSOR_KEY,
} from "@src/workers/background/opfs-media-maintenance";
import { clearRecentProcessStatuses } from "@src/workers/background/process-status";
import {
  beginLocalDataReset,
  finishLocalDataReset,
  sendForwardedToOffscreen,
  setLocalDataResetRecoveryRequired,
  settleTrackedDataJobs,
} from "@src/workers/background/runtime";

type LocalDataResetDependencies = {
  resetBrowserBookmarkImportState: () => Promise<void>;
};

export type LocalDataResetController = {
  deleteAllLocalData: () => Promise<{ deletedCollections: number }>;
  recoverInterruptedReset: () => Promise<boolean>;
};

export const createLocalDataResetController = (
  dependencies: LocalDataResetDependencies,
): LocalDataResetController => {
  const deleteAllLocalDataOrchestrated = async (): Promise<{
    deletedCollections: number;
  }> => {
    beginLocalDataReset();
    suspendArchiveWrites();
    let result: { deletedCollections: number } | undefined;
    let operationError: unknown;
    let cleanupError: unknown;
    let resetMarkerPersisted = false;
    try {
      await chrome.storage.local.set({
        [LOCAL_DATA_RESET_STORAGE_KEY]: true,
        [LOCAL_DATA_RESET_EPOCH_STORAGE_KEY]: Date.now(),
      });
      resetMarkerPersisted = true;
      cancelCloudSyncRequests();
      await sendForwardedToOffscreen({
        service: "cloudSync",
        type: "cancelAndClear",
        payload: {},
      });
      await chrome.alarms.clear(CLOUD_SYNC_CONTINUATION_ALARM_NAME);
      await chrome.alarms.clear(OPFS_MEDIA_RECONCILE_CONTINUATION_ALARM_NAME);
      await chrome.storage.local.remove(OPFS_MEDIA_RECONCILE_CURSOR_KEY);
      await clearMetadataPipelineData();
      await cancelAllArchiveCaptures();
      await dependencies.resetBrowserBookmarkImportState();
      await settleTrackedDataJobs();
      // Jobs already unwinding when cancellation started may have queued a final
      // cloud reference. Clear once more after every tracked writer is settled.
      await sendForwardedToOffscreen({
        service: "cloudSync",
        type: "cancelAndClear",
        payload: {},
      });
      await clearImportStorage();
      clearPendingScreenshots();
      clearHoverSaveTargets();
      clearRecentProcessStatuses();
      const payload = await sendForwardedToOffscreen<{
        deletedCollections: number;
      }>({
        service: "dbManager",
        type: "deleteAllData",
        payload: {},
      });
      // The offscreen operation clears persisted bytes after its collection
      // deletes commit. Repeat through the live background owners so a stale
      // in-memory drain/session cannot recreate state after the wipe.
      await clearArchiveData();
      // Repeat volatile/persisted cleanup after the durable wipe. Any job that
      // was already unwinding when reset began has now settled and cannot
      // repopulate these stores.
      await clearMetadataPipelineData();
      await clearImportStorage();
      clearPendingScreenshots();
      clearHoverSaveTargets();
      result = payload;
    } catch (error) {
      operationError = error;
    } finally {
      const completed = operationError === undefined && result !== undefined;
      // A failed, partially completed wipe intentionally keeps its durable
      // marker. The next worker startup (or an explicit retry) resumes the wipe
      // rather than silently accepting the partial state as complete.
      if (completed || !resetMarkerPersisted) {
        try {
          await chrome.storage.local.remove(LOCAL_DATA_RESET_STORAGE_KEY);
        } catch (error) {
          cleanupError = error;
        }
      }
      const recoveryRequired =
        (!completed && resetMarkerPersisted) || cleanupError !== undefined;
      if (!recoveryRequired) resumeArchiveWrites();
      finishLocalDataReset(recoveryRequired);
    }
    if (cleanupError !== undefined && operationError !== undefined) {
      throw new AggregateError(
        [operationError, cleanupError],
        "LOCAL_DATA_RESET_AND_MARKER_CLEANUP_FAILED",
      );
    }
    if (cleanupError !== undefined) throw cleanupError;
    if (operationError !== undefined) throw operationError;
    if (!result) throw new Error("LOCAL_DATA_RESET_RESULT_MISSING");
    return result;
  };

  let localDataResetRecoveryInFlight: Promise<boolean> | null = null;
  const recoverInterruptedLocalDataReset = (): Promise<boolean> => {
    if (localDataResetRecoveryInFlight) return localDataResetRecoveryInFlight;
    const recovery = (async () => {
      const resetState = await chrome.storage.local.get(
        LOCAL_DATA_RESET_STORAGE_KEY,
      );
      if (resetState[LOCAL_DATA_RESET_STORAGE_KEY] !== true) {
        setLocalDataResetRecoveryRequired(false);
        resumeArchiveWrites();
        return false;
      }
      console.warn("[storage] completing an interrupted local-data reset");
      await deleteAllLocalDataOrchestrated();
      return true;
    })().finally(() => {
      localDataResetRecoveryInFlight = null;
    });
    localDataResetRecoveryInFlight = recovery;
    return recovery;
  };

  return {
    deleteAllLocalData: deleteAllLocalDataOrchestrated,
    recoverInterruptedReset: recoverInterruptedLocalDataReset,
  };
};
