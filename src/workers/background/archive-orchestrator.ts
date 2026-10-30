import { legacyCloudEnabled } from "@src/services/extension-policy";
import { getArchiveCache } from "@src/services/archive-cache";
import { ArchiveCaptureSessionManager } from "@src/services/archive-capture-session";
import { collectArchiveItemIds } from "@src/services/archive-identity";
import {
  ARCHIVE_OUTBOX_DRAIN_LIMIT,
  ArchiveOutbox,
  type ArchiveOutboxDrainResult,
  createChromeArchiveOutboxStorage,
  createOpfsArchiveOutboxFiles,
} from "@src/services/archive-outbox";
import {
  PAGE_ARCHIVE_CAPTURE_MESSAGE,
  PAGE_ARCHIVE_CAPTURE_TIMEOUT_MS,
  type ArchiveProtocolResponse,
  type PageArchiveCaptureRequest,
} from "@src/services/archive-capture-protocol";
import { isServerCapturableArchiveUrl } from "@src/services/archive-resource-url";
import {
  pickLiveArchiveCaptureTab,
  withTemporaryArchiveTab,
} from "@src/services/archive-tab-recovery";
export { claimAnonymousArchives } from "@src/services/archive-cloud-claim";
import { normalizeHttpUrl } from "@src/workers/background/import-utils";
import { sendProcessStatus } from "@src/workers/background/process-status";
import { sendForwardedToOffscreen } from "@src/workers/background/runtime";
import { z } from "zod";

export const ARCHIVE_OUTBOX_RETRY_ALARM_NAME = "archive-outbox-retry";

type CloudSyncPushItemResponse = { ready?: boolean; reason?: string };
export type ArchiveCaptureResult = {
  capturedLocally: boolean;
  reason?: string;
};
export type ArchiveRecoveryResult = { captured: boolean; reason?: string };

const protocolResponseSchema: z.ZodType<ArchiveProtocolResponse> = z.object({
  success: z.boolean(),
  payload: z.unknown().optional(),
  error: z.string().optional(),
});
const archiveCache = getArchiveCache();
const archiveOutbox = new ArchiveOutbox({
  storage: createChromeArchiveOutboxStorage(),
  files: createOpfsArchiveOutboxFiles(),
  ensureItem: async (itemId) => {
    if (globalThis.navigator?.onLine === false) {
      return { ready: false, reason: "OFFLINE", retryAfterMs: 60_000 };
    }
    const result = await sendForwardedToOffscreen<CloudSyncPushItemResponse>({
      service: "cloudSync",
      type: "pushItem",
      payload: { itemId },
    });
    if (result.ready) return { ready: true };
    return {
      ready: false,
      reason: result.reason || "ITEM_NOT_SYNCED",
      retryAfterMs:
        result.reason === "missing-local-item" ? 5 * 60_000 : 30_000,
    };
  },
  retainUploadedArchive: (itemId, body, updatedAt) =>
    archiveCache.put(itemId, body, updatedAt).then(() => undefined),
  retainUploadedArchiveWithinMutationLock: (itemId, body, updatedAt) =>
    archiveCache
      .putWithinMutationLock(itemId, body, updatedAt, {
        source: "local",
        replaceCloudNewer: true,
      })
      .then(() => undefined),
  isUploadedArchiveRetained: async (itemId, updatedAt, byteSize) => {
    const entry = (await archiveCache.list()).find(
      (candidate) => candidate.itemId === itemId,
    );
    if (!entry || entry.updatedAt !== updatedAt || entry.byteSize !== byteSize)
      return false;
    return (await archiveCache.get(itemId))?.size === byteSize;
  },
});
const captureSessions = new ArchiveCaptureSessionManager({
  outbox: archiveOutbox,
});
const cancelledItems = new Map<string, number>();
const sessionCaptureInFlight = new Set<string>();
let writesSuspended = false;

function errorFromCause(cause: unknown, fallback: string): Error {
  return cause instanceof Error ? cause : new Error(fallback);
}

export function areArchiveWritesSuspended(): boolean {
  return writesSuspended;
}

export function suspendArchiveWrites(): void {
  writesSuspended = true;
  archiveOutbox.invalidateInFlight();
}

export function resumeArchiveWrites(): void {
  writesSuspended = false;
}

export function forgetCancelledArchiveItem(itemId: string): void {
  cancelledItems.delete(itemId);
}

export async function purgeArchivedItems(
  itemIdsRaw: Iterable<string>,
): Promise<void> {
  const itemIds = collectArchiveItemIds(itemIdsRaw);
  if (itemIds.length === 0) return;
  const cancelledAt = Date.now();
  for (const itemId of itemIds) cancelledItems.set(itemId, cancelledAt);
  for (const [id, markedAt] of cancelledItems) {
    if (Date.now() - markedAt > 60 * 60 * 1_000) cancelledItems.delete(id);
  }
  await Promise.all(
    itemIds.map((itemId) => captureSessions.cancelItem(itemId)),
  );
  await archiveOutbox.discardItems(itemIds);
  await archiveCache.deleteMany(itemIds);
}

export async function reconcileArchivedItemsWithDatabase(): Promise<void> {
  const [cached, queued] = await Promise.all([
    archiveCache.list(),
    archiveOutbox.list(),
  ]);
  const candidateIds = [
    ...new Set([
      ...cached.map((entry) => entry.itemId),
      ...queued.map((job) => job.itemId),
    ]),
  ];
  const existing = new Set<string>();
  for (let start = 0; start < candidateIds.length; start += 2_000) {
    const itemIds = candidateIds.slice(start, start + 2_000);
    const found = await sendForwardedToOffscreen<string[]>({
      service: "dbManager",
      type: "filterExistingItemIds",
      payload: { itemIds },
    });
    for (const itemId of found) existing.add(itemId);
  }
  await purgeArchivedItems(
    candidateIds.filter((itemId) => !existing.has(itemId)),
  );
}

export async function markArchiveItemCancelled(itemId: string): Promise<void> {
  if (itemId) await purgeArchivedItems([itemId]);
}

export async function scheduleArchiveOutboxRetry(): Promise<void> {
  if (!await legacyCloudEnabled()) return;
  const jobs = (await archiveOutbox.list()).filter((job) => !job.terminal);
  if (jobs.length === 0) {
    await chrome.alarms.clear(ARCHIVE_OUTBOX_RETRY_ALARM_NAME);
    return;
  }
  const nextAttemptAt = Math.min(...jobs.map((job) => job.nextAttemptAt));
  await chrome.alarms.create(ARCHIVE_OUTBOX_RETRY_ALARM_NAME, {
    when: Math.max(Date.now() + 30_000, nextAttemptAt),
  });
}

export async function triggerArchiveOutboxDrain(): Promise<
  ArchiveOutboxDrainResult | undefined
> {
  if (!await legacyCloudEnabled()) return undefined;
  if (writesSuspended || globalThis.navigator?.onLine === false)
    return undefined;
  try {
    const result = await archiveOutbox.drain(ARCHIVE_OUTBOX_DRAIN_LIMIT);
    const escalated = await escalateTerminalArchivesToSessionCapture();
    const jobs = await archiveOutbox.list();
    for (const job of jobs
      .filter((candidate) => candidate.terminal)
      .slice(-20)) {
      if (escalated.has(job.itemId) || sessionCaptureInFlight.has(job.itemId))
        continue;
      const detail = job.lastError || "This site blocks automated archiving.";
      sendProcessStatus(
        `archive-${job.itemId}`,
        "Offline preview",
        "error",
        `${detail} Open the page in a tab, then use View to capture it again.`,
      );
    }
    if (
      jobs.some((job) => !job.terminal) &&
      result.reason !== "missing-token"
    ) {
      await scheduleArchiveOutboxRetry();
    }
    return result;
  } catch (cause) {
    console.warn("[archive] outbox drain skipped", cause);
    await scheduleArchiveOutboxRetry().catch(() => undefined);
    return undefined;
  }
}

export async function queueServerArchive(
  itemId: string,
  archiveUrl: string,
): Promise<void> {
  if (writesSuspended || cancelledItems.has(itemId)) return;
  await archiveOutbox.enqueueServerCapture(itemId, archiveUrl);
  const statusId = `archive-${itemId}`;
  sendProcessStatus(
    statusId,
    "Offline preview",
    "processing",
    "Queued for capture.",
  );
  const result = await triggerArchiveOutboxDrain();
  const job = (await archiveOutbox.list()).find(
    (candidate) => candidate.itemId === itemId,
  );
  if (!job) {
    sendProcessStatus(statusId, "Offline preview", "success", "Captured.");
  } else if (result?.attempted) {
    sendProcessStatus(
      statusId,
      "Offline preview",
      "error",
      `Capture not finished: ${job.lastError || "will retry"}`,
    );
  }
}

const RECEIVER_RETRY_DELAY_MS = 400;
const RECEIVER_MAX_ATTEMPTS = 8;

function isMissingCaptureReceiverError(error: Error): boolean {
  return /receiving end does not exist|could not establish connection|message port closed/i.test(
    error.message,
  );
}

async function sendArchiveCaptureRequest(
  tabId: number,
  message: PageArchiveCaptureRequest,
  deadlineAt: number,
): Promise<ArchiveProtocolResponse> {
  let lastError = new Error("ARCHIVE_CAPTURE_NO_RECEIVER");
  for (let attempt = 0; attempt < RECEIVER_MAX_ATTEMPTS; attempt += 1) {
    try {
      return protocolResponseSchema.parse(
        await chrome.tabs.sendMessage(tabId, message),
      );
    } catch (cause) {
      const error = errorFromCause(cause, "ARCHIVE_CAPTURE_NO_RECEIVER");
      lastError = error;
      if (!isMissingCaptureReceiverError(error)) throw error;
      if (Date.now() + RECEIVER_RETRY_DELAY_MS >= deadlineAt) break;
      await new Promise<void>((resolve) =>
        setTimeout(resolve, RECEIVER_RETRY_DELAY_MS),
      );
    }
  }
  throw lastError;
}

export async function capturePageArchiveForItem(input: {
  itemId: string;
  archiveUrl: string;
  liveArchiveUrl?: string;
  tab?: chrome.tabs.Tab;
  deferDrain?: boolean;
}): Promise<ArchiveCaptureResult> {
  if (writesSuspended)
    return { capturedLocally: false, reason: "ARCHIVE_WRITES_SUSPENDED" };
  cancelledItems.delete(input.itemId);
  const tabId = input.tab?.id;
  const liveUrl = normalizeHttpUrl(input.liveArchiveUrl);
  const serverFallbackUsable = isServerCapturableArchiveUrl(input.archiveUrl);
  if (tabId === undefined || !liveUrl) {
    if (serverFallbackUsable)
      await queueServerArchive(input.itemId, input.archiveUrl);
    return { capturedLocally: false, reason: "ARCHIVE_LIVE_TAB_UNAVAILABLE" };
  }

  const statusId = `archive-${input.itemId}`;
  sendProcessStatus(
    statusId,
    "Offline preview",
    "processing",
    "Capturing this page in the background...",
  );
  let sessionId = "";
  try {
    const currentTab = await chrome.tabs.get(tabId);
    if (normalizeHttpUrl(currentTab.url) !== liveUrl)
      throw new Error("ARCHIVE_PAGE_NAVIGATED");

    const deadlineAt = Date.now() + PAGE_ARCHIVE_CAPTURE_TIMEOUT_MS;
    if (serverFallbackUsable) {
      await archiveOutbox.enqueueServerCapture(input.itemId, input.archiveUrl, {
        notBefore: deadlineAt + 2_000,
      });
      await scheduleArchiveOutboxRetry();
    }
    const opened = await captureSessions.open({
      itemId: input.itemId,
      tabId,
      sourceUrl: liveUrl,
      deadlineAt,
    });
    sessionId = opened.sessionId;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const timeoutPromise = new Promise<never>((_resolve, reject) => {
      timeout = setTimeout(
        () => reject(new Error("ARCHIVE_CAPTURE_DEADLINE")),
        PAGE_ARCHIVE_CAPTURE_TIMEOUT_MS + 2_000,
      );
    });
    let response: ArchiveProtocolResponse;
    try {
      response = await Promise.race([
        sendArchiveCaptureRequest(
          tabId,
          {
            type: PAGE_ARCHIVE_CAPTURE_MESSAGE,
            payload: {
              sessionId,
              expectedUrl: liveUrl,
              deadlineAt,
              maxHtmlBytes: opened.maxHtmlBytes,
            },
          },
          deadlineAt,
        ),
        timeoutPromise,
      ]);
    } finally {
      if (timeout) clearTimeout(timeout);
    }
    if (!response.success)
      throw new Error(response.error || "ARCHIVE_CAPTURE_FAILED");
    if (captureSessions.isOpen(sessionId))
      throw new Error("ARCHIVE_CAPTURE_INCOMPLETE");
    if (writesSuspended || cancelledItems.has(input.itemId)) {
      await archiveOutbox.discardItem(input.itemId);
      return { capturedLocally: false, reason: "ARCHIVE_CAPTURE_CANCELLED" };
    }
    sendProcessStatus(
      statusId,
      "Offline preview",
      "processing",
      "Captured locally; waiting to sync.",
    );
    if (!input.deferDrain) void triggerArchiveOutboxDrain();
    return { capturedLocally: true };
  } catch (cause) {
    if (sessionId)
      await captureSessions.abort(sessionId, tabId).catch(() => undefined);
    const error = errorFromCause(cause, "ARCHIVE_CAPTURE_FAILED");
    if (writesSuspended || cancelledItems.has(input.itemId)) {
      return { capturedLocally: false, reason: error.message };
    }
    console.warn(
      "[archive] live page capture fell back to server capture",
      cause,
    );
    if (serverFallbackUsable)
      await queueServerArchive(input.itemId, input.archiveUrl);
    return { capturedLocally: false, reason: error.message };
  }
}

export async function captureArchiveForPreviewRecovery(
  itemId: string,
  sourceUrlRaw: string,
): Promise<ArchiveRecoveryResult> {
  const sourceUrl = normalizeHttpUrl(sourceUrlRaw);
  if (!itemId || !sourceUrl) {
    return {
      captured: false,
      reason: "This item has no valid web address to capture.",
    };
  }
  const captureLoadedTab = async (tab: chrome.tabs.Tab): Promise<void> => {
    const liveUrl = normalizeHttpUrl(tab.url);
    if (!liveUrl) throw new Error("ARCHIVE_RECOVERY_TAB_URL_INVALID");
    const result = await capturePageArchiveForItem({
      itemId,
      archiveUrl: sourceUrl,
      liveArchiveUrl: liveUrl,
      tab,
      deferDrain: true,
    });
    if (!result.capturedLocally)
      throw new Error(result.reason || "ARCHIVE_BROWSER_CAPTURE_FAILED");
  };

  try {
    const openTabs = await chrome.tabs.query({});
    const existing = pickLiveArchiveCaptureTab(
      openTabs,
      sourceUrl,
      normalizeHttpUrl,
    );
    if (existing) {
      try {
        await captureLoadedTab(existing);
      } catch (cause) {
        console.warn(
          "[archive] open tab could not be captured; retrying in a temporary tab",
          cause,
        );
        await withTemporaryArchiveTab(sourceUrl, captureLoadedTab);
      }
    } else {
      await withTemporaryArchiveTab(sourceUrl, captureLoadedTab);
    }
  } catch (cause) {
    const queued = (await archiveOutbox.list()).some(
      (job) => job.itemId === itemId,
    );
    if (!queued && isServerCapturableArchiveUrl(sourceUrl)) {
      await archiveOutbox.enqueueServerCapture(itemId, sourceUrl);
      await triggerArchiveOutboxDrain();
    }
    return {
      captured: false,
      reason: errorFromCause(cause, "ARCHIVE_BROWSER_CAPTURE_FAILED").message,
    };
  }
  void triggerArchiveOutboxDrain();
  return { captured: true };
}

async function escalateTerminalArchivesToSessionCapture(): Promise<
  Set<string>
> {
  const handled = new Set<string>();
  if (writesSuspended) return handled;
  const candidates = await archiveOutbox
    .claimSessionCaptureCandidates(1)
    .catch(() => []);
  for (const job of candidates) {
    if (
      cancelledItems.has(job.itemId) ||
      sessionCaptureInFlight.has(job.itemId)
    )
      continue;
    const statusId = `archive-${job.itemId}`;
    sessionCaptureInFlight.add(job.itemId);
    handled.add(job.itemId);
    sendProcessStatus(
      statusId,
      "Offline preview",
      "processing",
      "Automated capture was refused. Capturing this page from your browser session…",
    );
    try {
      const result = await captureArchiveForPreviewRecovery(
        job.itemId,
        job.sourceUrl,
      );
      if (result.captured) {
        sendProcessStatus(
          statusId,
          "Offline preview",
          "success",
          "Captured from your browser session.",
        );
        void chrome.runtime
          .sendMessage({ type: "DB_CHANGE", scope: "items" })
          .catch(() => undefined);
      } else {
        sendProcessStatus(
          statusId,
          "Offline preview",
          "error",
          `Could not capture this page, even from your browser session. ${result.reason ?? ""}`.trim(),
        );
      }
    } catch (cause) {
      console.warn("[archive] browser-session recovery failed", cause);
      sendProcessStatus(
        statusId,
        "Offline preview",
        "error",
        "Could not capture this page. Open it in a tab and use View to capture it again.",
      );
    } finally {
      sessionCaptureInFlight.delete(job.itemId);
    }
  }
  return handled;
}

export async function cancelAllArchiveCaptures(): Promise<void> {
  await captureSessions.cancelAll();
}

export async function clearArchiveData(): Promise<void> {
  await archiveOutbox.clear();
  await archiveCache.clear();
  await chrome.alarms.clear(ARCHIVE_OUTBOX_RETRY_ALARM_NAME);
  cancelledItems.clear();
}

export async function cleanupArchiveData(): Promise<void> {
  await Promise.all([archiveCache.cleanup(), archiveOutbox.cleanup()]);
}

export async function drainArchiveOutboxNow(): Promise<ArchiveOutboxDrainResult> {
  return archiveOutbox.drainNow(ARCHIVE_OUTBOX_DRAIN_LIMIT);
}

export function appendArchiveCaptureChunk(
  sessionId: string,
  tabId: number,
  sequence: number,
  chunk: string,
) {
  return captureSessions.append(sessionId, tabId, sequence, chunk);
}

export function finishArchiveCapture(
  sessionId: string,
  tabId: number,
  payload: { chunkCount: number; capturedUrl: string },
) {
  return captureSessions.finish(sessionId, tabId, payload);
}

export function abortArchiveCapture(
  sessionId: string,
  tabId: number,
): Promise<void> {
  return captureSessions.abort(sessionId, tabId);
}
