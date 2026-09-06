import { z } from "zod";
import { shouldScheduleCloudSyncContinuation } from "@src/services/cloud-sync-continuation";
import type { CloudSyncAllResult } from "@src/services/cloud-sync";
import { markCloudSessionRejected } from "@src/services/cloud-auth";
import {
  PAGE_ARCHIVE_ABORT_MESSAGE,
  PAGE_ARCHIVE_CHUNK_CODE_UNITS,
  PAGE_ARCHIVE_CHUNK_MESSAGE,
  PAGE_ARCHIVE_FINISH_MESSAGE,
  type ArchiveProtocolResponse,
} from "@src/services/archive-capture-protocol";
import {
  abortArchiveCapture,
  appendArchiveCaptureChunk,
  areArchiveWritesSuspended,
  captureArchiveForPreviewRecovery,
  claimAnonymousArchives,
  drainArchiveOutboxNow,
  finishArchiveCapture,
  purgeArchivedItems,
  scheduleArchiveOutboxRetry,
  triggerArchiveOutboxDrain,
} from "@src/workers/background/archive-orchestrator";
import {
  CLOUD_SYNC_SELECTION_LIMIT,
  pullCloudChanges,
  scheduleCloudSyncContinuation,
  triggerCloudSync,
} from "@src/workers/background/cloud-sync-orchestrator";
import {
  isSearchPageSender,
  isTrustedExtensionSender,
} from "@src/workers/background/message-security";
import { isOnline } from "@src/workers/background/network-state";
import { reconcileOrphanedOpfsMedia } from "@src/workers/background/opfs-media-maintenance";
import { sendProcessStatus } from "@src/workers/background/process-status";
import {
  runBackgroundDataJob,
  sendForwardedToOffscreen,
} from "@src/workers/background/runtime";

const ArchiveCloudPayloadSchema = z.object({
  sessionId: z.string().optional(),
  sequence: z.number().int().optional(),
  chunk: z.string().optional(),
  chunkCount: z.number().int().optional(),
  capturedUrl: z.string().optional(),
  itemId: z.string().optional(),
  itemIds: z.array(z.string()).optional(),
  url: z.string().optional(),
});
const ArchiveCloudMessageSchema = z.object({
  target: z.string().optional(),
  type: z.string().optional(),
  payload: ArchiveCloudPayloadSchema.optional(),
});

type ArchiveCloudMessageInput = z.input<typeof ArchiveCloudMessageSchema>;
type SendResponse = Parameters<
  Parameters<typeof chrome.runtime.onMessage.addListener>[0]
>[2];

type ArchiveCloudHandlerDependencies = {
  deleteAllLocalData: () => Promise<{ deletedCollections: number }>;
};

export const handleArchiveCloudMessage = (
  input: ArchiveCloudMessageInput,
  sender: chrome.runtime.MessageSender,
  sendResponse: SendResponse,
  dependencies: ArchiveCloudHandlerDependencies,
): true | undefined | null => {
  const parsed = ArchiveCloudMessageSchema.safeParse(input);
  if (!parsed.success) return null;
  const request = parsed.data;
  const payload = request.payload ?? {};
  const archiveSenderTabId =
    sender.id === chrome.runtime.id && sender.tab?.id !== undefined
      ? sender.tab.id
      : null;
  if (
    request.target === "background" &&
    request.type === PAGE_ARCHIVE_CHUNK_MESSAGE
  ) {
    if (archiveSenderTabId === null) {
      sendResponse({
        success: false,
        error: "UNAUTHORIZED_ARCHIVE_SENDER",
      } satisfies ArchiveProtocolResponse);
      return true;
    }
    const sessionId = payload.sessionId ?? "";
    const sequence = Number.isSafeInteger(payload.sequence)
      ? Number(payload.sequence)
      : -1;
    const chunk = payload.chunk ?? "";
    if (chunk.length > PAGE_ARCHIVE_CHUNK_CODE_UNITS + 1) {
      sendResponse({
        success: false,
        error: "ARCHIVE_CHUNK_TOO_LARGE",
      } satisfies ArchiveProtocolResponse);
      return true;
    }
    void appendArchiveCaptureChunk(
      sessionId,
      archiveSenderTabId,
      sequence,
      chunk,
    )
      .then((payload) =>
        sendResponse({
          success: true,
          payload,
        } satisfies ArchiveProtocolResponse),
      )
      .catch((error) =>
        sendResponse({
          success: false,
          error:
            error instanceof Error ? error.message : "ARCHIVE_CHUNK_FAILED",
        } satisfies ArchiveProtocolResponse),
      );
    return true;
  }

  if (
    request.target === "background" &&
    request.type === PAGE_ARCHIVE_FINISH_MESSAGE
  ) {
    if (archiveSenderTabId === null) {
      sendResponse({
        success: false,
        error: "UNAUTHORIZED_ARCHIVE_SENDER",
      } satisfies ArchiveProtocolResponse);
      return true;
    }
    const sessionId = payload.sessionId ?? "";
    const chunkCount = Number.isSafeInteger(payload.chunkCount)
      ? Number(payload.chunkCount)
      : -1;
    const capturedUrl = (payload.capturedUrl ?? "").slice(0, 8192);
    void finishArchiveCapture(sessionId, archiveSenderTabId, {
      chunkCount,
      capturedUrl,
    })
      .then((payload) =>
        sendResponse({
          success: true,
          payload,
        } satisfies ArchiveProtocolResponse),
      )
      .catch((error) =>
        sendResponse({
          success: false,
          error:
            error instanceof Error ? error.message : "ARCHIVE_FINISH_FAILED",
        } satisfies ArchiveProtocolResponse),
      );
    return true;
  }

  if (
    request.target === "background" &&
    request.type === PAGE_ARCHIVE_ABORT_MESSAGE
  ) {
    if (archiveSenderTabId === null) {
      sendResponse({
        success: false,
        error: "UNAUTHORIZED_ARCHIVE_SENDER",
      } satisfies ArchiveProtocolResponse);
      return true;
    }
    const sessionId = payload.sessionId ?? "";
    void abortArchiveCapture(sessionId, archiveSenderTabId)
      .then(() =>
        sendResponse({ success: true } satisfies ArchiveProtocolResponse),
      )
      .catch((error) =>
        sendResponse({
          success: false,
          error:
            error instanceof Error ? error.message : "ARCHIVE_ABORT_FAILED",
        } satisfies ArchiveProtocolResponse),
      );
    return true;
  }

  if (
    request.target === "background" &&
    request.type === "ARCHIVE_ITEMS_PURGED"
  ) {
    if (!isTrustedExtensionSender(sender)) {
      sendResponse({ success: false, error: "UNAUTHORIZED_CONTEXT" });
      return true;
    }
    const itemIds = (payload.itemIds ?? []).slice(0, 2_000);
    void purgeArchivedItems(itemIds)
      .then(() => sendResponse({ success: true }))
      .catch((error) =>
        sendResponse({
          success: false,
          error:
            error instanceof Error ? error.message : "Archive cleanup failed",
        }),
      );
    return true;
  }

  if (
    request.target === "background" &&
    request.type === "OPFS_MEDIA_RECONCILE_REQUESTED"
  ) {
    if (!isTrustedExtensionSender(sender)) {
      sendResponse({ success: false, error: "UNAUTHORIZED_CONTEXT" });
      return true;
    }
    void reconcileOrphanedOpfsMedia()
      .then(() => sendResponse({ success: true }))
      .catch((error) =>
        sendResponse({
          success: false,
          error:
            error instanceof Error
              ? error.message
              : "OPFS media reconciliation failed",
        }),
      );
    return true;
  }

  if (
    request.target === "background" &&
    request.type === "DELETE_ALL_LOCAL_DATA"
  ) {
    if (!isTrustedExtensionSender(sender) || !isSearchPageSender(sender)) {
      sendResponse({ success: false, error: "UNAUTHORIZED_CONTEXT" });
      return true;
    }
    void dependencies
      .deleteAllLocalData()
      .then((payload) => sendResponse({ success: true, payload }))
      .catch((error) =>
        sendResponse({
          success: false,
          error:
            error instanceof Error ? error.message : "Delete all data failed",
        }),
      );
    return true;
  }

  if (
    request.target === "background" &&
    request.type === "ARCHIVE_CLAIM_ANON"
  ) {
    if (isTrustedExtensionSender(sender)) {
      void claimAnonymousArchives();
    }
    return;
  }

  if (
    request.target === "background" &&
    request.type === "ARCHIVE_CAPTURE_NOW"
  ) {
    if (!isTrustedExtensionSender(sender) || !isSearchPageSender(sender)) {
      sendResponse({ success: false, error: "UNAUTHORIZED_CONTEXT" });
      return true;
    }
    const itemId = payload.itemId ?? "";
    const sourceUrl = payload.url ?? "";
    void (async () => {
      if (areArchiveWritesSuspended()) {
        throw new Error("Archive writes are temporarily suspended.");
      }
      const statusId = `archive-${itemId}`;
      sendProcessStatus(
        statusId,
        "Offline preview",
        "processing",
        "Capturing this page from your browser session…",
      );
      const result = await captureArchiveForPreviewRecovery(itemId, sourceUrl);
      if (result.captured) {
        sendProcessStatus(
          statusId,
          "Offline preview",
          "success",
          "Captured. Open the archived copy again.",
        );
        chrome.runtime
          .sendMessage({ type: "DB_CHANGE", scope: "items" })
          .catch(() => {});
        return { queued: true, captured: true };
      }
      const detail = result.reason || "Capture is queued for retry.";
      sendProcessStatus(
        statusId,
        "Offline preview",
        "error",
        `Capture not finished: ${detail}`,
      );
      return { queued: true, captured: false, reason: detail };
    })()
      .then((payload) => sendResponse({ success: true, payload }))
      .catch((error) =>
        sendResponse({
          success: false,
          error:
            error instanceof Error ? error.message : "Capture request failed",
        }),
      );
    return true;
  }

  if (request.target === "background" && request.type === "CLOUD_SYNC_ITEMS") {
    if (!isTrustedExtensionSender(sender) || !isSearchPageSender(sender)) {
      sendResponse({ success: false, error: "UNAUTHORIZED_CONTEXT" });
      return true;
    }
    const itemIds = (payload.itemIds ?? []).filter((id) => id.trim() !== "");
    void (async () => {
      if (itemIds.length === 0) return { synced: 0, pending: 0 };
      if (!isOnline())
        throw new Error("You're offline. Reconnect, then try again.");
      // Push these first, then read back what other devices have added.
      for (const itemId of itemIds.slice(0, CLOUD_SYNC_SELECTION_LIMIT)) {
        await sendForwardedToOffscreen({
          service: "cloudSync",
          type: "pushItem",
          payload: { itemId },
        });
      }
      await pullCloudChanges();
      const states = await sendForwardedToOffscreen<Record<string, string>>({
        service: "cloudSync",
        type: "itemSyncState",
        payload: { itemIds },
      });
      const values = Object.values(states || {});
      return {
        synced: values.filter((state) => state === "synced").length,
        pending: values.filter((state) => state !== "synced").length,
      };
    })()
      .then((payload) => sendResponse({ success: true, payload }))
      .catch((error) =>
        sendResponse({
          success: false,
          error: error instanceof Error ? error.message : "Backup failed.",
        }),
      );
    return true;
  }

  if (
    request.target === "background" &&
    request.type === "CLOUD_SYNC_ITEM_STATE"
  ) {
    if (!isTrustedExtensionSender(sender)) {
      sendResponse({ success: false, error: "UNAUTHORIZED_CONTEXT" });
      return true;
    }
    const itemIds = payload.itemIds ?? [];
    void sendForwardedToOffscreen<Record<string, string>>({
      service: "cloudSync",
      type: "itemSyncState",
      payload: { itemIds },
    })
      .then((payload) => sendResponse({ success: true, payload }))
      .catch(() => sendResponse({ success: true, payload: {} }));
    return true;
  }

  if (request.target === "background" && request.type === "CLOUD_SYNC_QUEUED") {
    if (isTrustedExtensionSender(sender)) {
      void triggerCloudSync().then(() => triggerArchiveOutboxDrain());
    }
    return;
  }

  if (request.target === "background" && request.type === "CLOUD_SYNC_NOW") {
    if (!isTrustedExtensionSender(sender) || !isSearchPageSender(sender)) {
      sendResponse({ success: false, error: "UNAUTHORIZED_CONTEXT" });
      return true;
    }
    void runBackgroundDataJob(async () => {
      if (!isOnline())
        throw new Error("You’re offline. Reconnect, then try syncing again.");
      sendProcessStatus(
        "cloud-manual-sync",
        "Cloud library",
        "processing",
        "Checking local records and syncing them to your account…",
      );
      const result = await sendForwardedToOffscreen<CloudSyncAllResult>({
        service: "cloudSync",
        type: "syncAll",
        payload: { pageSize: 250, maxBatches: 25 },
      });
      if (shouldScheduleCloudSyncContinuation(result.push)) {
        await scheduleCloudSyncContinuation();
      }
      if (result.push.reason && result.push.reason !== "empty") {
        const refusedByServer =
          result.push.reason === "invalid-auth" ||
          (result.push.reason === "http-error" &&
            /^(401|403)\b/.test(result.push.error || ""));
        if (refusedByServer) {
          // The server rejected this session: stop reporting "Connected".
          await markCloudSessionRejected().catch(() => {});
          throw new Error(
            "Your Vibesearch session expired. Reconnect your cloud account and try again.",
          );
        }
        if (result.push.reason === "missing-token") {
          throw new Error("Connect your cloud account to sync this library.");
        }
        throw new Error(
          result.push.error || `Cloud sync stopped: ${result.push.reason}`,
        );
      }

      const archive = await (async () => {
        await claimAnonymousArchives();
        return drainArchiveOutboxNow();
      })();
      if (archive.remaining > 0 && archive.reason !== "missing-token") {
        await scheduleArchiveOutboxRetry();
      }
      if (archive.reason === "auth-required" || archive.tokenRejected) {
        // The API actually refused a token: the session is dead.
        await markCloudSessionRejected().catch(() => {});
        throw new Error(
          "Your Vibesearch session expired. Reconnect your cloud account and try again.",
        );
      }
      if (archive.reason === "missing-token") {
        // No usable credential on this device — not a refusal, so the account is
        // left alone and the user is told what to do.
        throw new Error("Connect your cloud account to back up archives.");
      }

      // Two-way: hand this device's changes over, then bring the others' down.
      const pulled = await pullCloudChanges();
      const remaining = result.push.remaining + archive.remaining;
      const arrived = pulled?.inserted ?? 0;
      const arrivedNote =
        arrived > 0
          ? ` ${arrived.toLocaleString()} ${arrived === 1 ? "item" : "items"} from your other devices arrived.`
          : "";
      sendProcessStatus(
        "cloud-manual-sync",
        "Cloud library",
        "success",
        remaining > 0
          ? `Checked ${result.scanned.toLocaleString()} local records; ${remaining.toLocaleString()} uploads will continue in the background.${arrivedNote}`
          : `Checked and synced ${result.scanned.toLocaleString()} local records.${arrivedNote}`,
      );
      return { ...result, archive, pull: pulled };
    })
      .then((payload) => sendResponse({ success: true, payload }))
      .catch((error) => {
        const detail =
          error instanceof Error ? error.message : "Cloud sync failed.";
        sendProcessStatus(
          "cloud-manual-sync",
          "Cloud library",
          "error",
          detail,
        );
        sendResponse({ success: false, error: detail });
      });
    return true;
  }

  return null;
};
