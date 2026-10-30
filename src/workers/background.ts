import "@src/workers/background/local-companion";
import { EXTENSION_POLICY_KEY, EXTENSION_POLICY_READ_MESSAGE, legacyBrowserEnabled, parseExtensionPolicy } from "@src/services/extension-policy";
import { LOCAL_LIBRARY_PATH } from "@src/services/local-companion-protocol";
import { z } from "zod";
import { scheduleForProcessing } from "@src/services/metadata-pipeline";
import { setupOffscreenDocument } from "@src/services/offscreen-helper";
import { PUBLIC_SPACE_ID } from "@src/common/spaces";
import {
  ARCHIVE_MIGRATION_STORAGE_BRIDGE_MESSAGE,
  handleArchiveMigrationStorageBridge,
  isArchiveMigrationStorageBridgeSender,
  OFFSCREEN_DOCUMENT_PATH,
} from "@src/services/archive-migration-storage-bridge";
import {
  CLOUD_AUTH_STORAGE_BRIDGE_MESSAGE,
  handleCloudAuthStorageBridge,
  isCloudAuthStorageBridgeSender,
} from "@src/services/cloud-auth-storage-bridge";
import type { CloudAuthStatus } from "@src/services/cloud-auth";
import { OFFSCREEN_STORAGE_BRIDGE_MESSAGE, handleOffscreenStorageBridge } from "@src/services/offscreen-storage-bridge";
import {
  cancelConnectorSync,
  connect as connectConnector,
  disconnect as disconnectConnector,
  listConnectors,
  setAutoSync as setConnectorAutoSync,
  syncAllConnected,
  syncConnector,
  type ConnectorSyncOutcome,
} from "@src/services/connectors/registry";
import type { ConnectorPlatform } from "@src/services/connectors/types";
import {
  isInternalOnlyOffscreenCall,
  isSearchOnlyOffscreenCall,
} from "@src/services/offscreen-routing-policy";
import { markArchiveItemCancelled } from "@src/workers/background/archive-orchestrator";
import { handleArchiveCloudMessage } from "@src/workers/background/archive-cloud-message-handler";
import { handleBackupExportMessage } from "@src/workers/background/backup-export-message-handler";
import { triggerCloudSync } from "@src/workers/background/cloud-sync-orchestrator";
import { registerContextMenuEvents } from "@src/workers/background/context-menu-events";
import { scheduleContextMenuRefresh } from "@src/workers/background/context-menus";
import {
  buildContextFromUrl,
  collectContextFromTab,
  getActiveTab,
  rememberHoverSaveTarget,
} from "@src/workers/background/import-context";
import {
  finalizeScreenshotSave,
  moveSavedItemToFolder,
  runArchiveSnapshotAction,
  runImportAction,
  runScreenshotAction,
} from "@src/workers/background/import-actions";
import { handleImportControlMessage } from "@src/workers/background/import-control-handler";
import { createLibraryImportCoordinator } from "@src/workers/background/library-imports";
import { createLocalDataResetController } from "@src/workers/background/local-data-reset";
import { registerBackgroundLifecycle } from "@src/workers/background/lifecycle-events";
import {
  isSearchPageSender,
  isTrustedExtensionSender,
} from "@src/workers/background/message-security";
import { triggerOpfsPromotion } from "@src/workers/background/opfs-media-maintenance";
import {
  forwardProcessingTriggerToOffscreen,
  isProcessingTrigger,
} from "@src/workers/background/processing-triggers";
import {
  initializeMetadataProgressStatus,
  sendProcessStatus,
} from "@src/workers/background/process-status";
import {
  isLocalDataResetBlocked,
  runBackgroundDataJob,
  sendForwardedToOffscreen,
  trackOffscreenRequest,
} from "@src/workers/background/runtime";
import { importSharedLink } from "@src/workers/background/share-import";
import {
  isVibeShareUrl,
  normalizeHttpUrl,
} from "@src/workers/background/import-utils";

const BackgroundPayloadSchema = z.object({
  accessToken: z.string().optional(),
  accountId: z.string().optional(),
  autoSave: z.boolean().optional(),
  folderId: z.string().optional(),
  force: z.boolean().optional(),
  itemId: z.string().optional(),
  mode: z.string().optional(),
  on: z.boolean().optional(),
  pendingId: z.string().optional(),
  platform: z.string().optional(),
  primaryUrl: z.string().optional(),
  revalidate: z.boolean().optional(),
  source: z.string().optional(),
  spaceId: z.string().optional(),
  targetSpaceId: z.string().optional(),
  title: z.string().optional(),
  url: z.string().optional(),
  urls: z.array(z.string()).optional(),
});
const BackgroundMessageSchema = z.object({
  target: z.string().optional(),
  type: z.string().optional(),
  scope: z.enum(["items", "folders", "spaces"]).optional(),
  isForwarded: z.boolean().optional(),
  payload: BackgroundPayloadSchema.optional(),
});

const CONNECTOR_MESSAGE_TYPES = new Set([
  "RUN_CONNECTOR_SYNC",
  "CANCEL_CONNECTOR_SYNC",
  "CONNECTOR_LIST",
  "CONNECTOR_CONNECT",
  "CONNECTOR_DISCONNECT",
  "CONNECTOR_SET_AUTOSYNC",
]);
const GOOGLE_WORKSPACE_MESSAGE_TYPES = new Set([
  "GOOGLE_AUTH_STATUS",
  "GOOGLE_AUTH_CONNECT",
  "GOOGLE_SYNC_STATUS",
  "GOOGLE_SYNC_CLEAR_AUTH",
  "GOOGLE_BACKUP_LIST",
  "GOOGLE_BACKUP_RESTORE",
  "GOOGLE_SYNC_EXPORT_ALL",
]);
const LOCAL_BACKUP_MESSAGE_TYPES = new Set([
  "LOCAL_BACKUP_BUILD_DOWNLOAD",
  "LOCAL_BACKUP_STAGE_FILE",
  "LOCAL_BACKUP_RESTORE_STAGED",
]);
const NOTION_MESSAGE_TYPES = new Set([
  "NOTION_AUTH_STATUS",
  "NOTION_AUTH_CONNECT",
  "NOTION_AUTH_DISCONNECT",
  "NOTION_EXPORT_ALL",
]);

initializeMetadataProgressStatus();
const CONNECTOR_LABELS: Record<ConnectorPlatform, string> = {
  x: "X (Twitter)",
  reddit: "Reddit",
  instagram: "Instagram",
};
const isConnectorPlatform = (value: string): value is ConnectorPlatform =>
  value === "x" || value === "reddit" || value === "instagram";
const describeConnectorOutcome = (
  who: string,
  outcome: ConnectorSyncOutcome,
): string => {
  if (outcome.error) return outcome.error;
  if (outcome.cancelled) {
    return `${who}: cancelled — ${outcome.pushed} synced before stopping.`;
  }
  if (outcome.fetched === 0) {
    return outcome.hasMore
      ? `${who}: backlog checkpoint saved; continuing shortly.`
      : `${who}: already up to date — nothing new to sync.`;
  }
  const parts = [
    `${outcome.pushed} new item${outcome.pushed === 1 ? "" : "s"} synced`,
  ];
  if (outcome.skipped) parts.push(`${outcome.skipped} already saved`);
  if (outcome.failed) parts.push(`${outcome.failed} failed`);
  if (outcome.hasMore) parts.push("more queued for the next bounded run");
  return `${who}: ${parts.join(", ")}.`;
};
const FORCE_DEV_OFFSCREEN_RESET =
  import.meta.env.VITE_FORCE_DEV_OFFSCREEN_RESET === "1";
const {
  importBrowserBookmarks,
  importGitHubStars,
  onBrowserBookmarkImportBegan,
  onBrowserBookmarkImportEnded,
  onBrowserBookmarkResyncAlarm,
  requestBrowserBookmarkResync,
  resetBrowserBookmarkImportState,
} = createLibraryImportCoordinator({
  scheduleMenuRefresh: () => scheduleContextMenuRefresh("high"),
  triggerCloudSync: () => triggerCloudSync(),
});
const {
  deleteAllLocalData: deleteAllLocalDataOrchestrated,
  recoverInterruptedReset: recoverInterruptedLocalDataReset,
} = createLocalDataResetController({ resetBrowserBookmarkImportState });
const refreshConnectorCloudAuth = async (): Promise<CloudAuthStatus | null> => {
  try {
    return await sendForwardedToOffscreen<CloudAuthStatus>({
      service: "cloudAuth",
      type: "status",
      payload: { refresh: true },
    });
  } catch {
    return null;
  }
};

registerContextMenuEvents();
registerBackgroundLifecycle({
  recoverInterruptedLocalDataReset,
  requestBrowserBookmarkResync,
  onBrowserBookmarkImportBegan,
  onBrowserBookmarkImportEnded,
  onBrowserBookmarkResyncAlarm,
  refreshConnectorCloudAuth: async () => {
    await refreshConnectorCloudAuth();
  },
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.target === "background" && message?.type === OFFSCREEN_STORAGE_BRIDGE_MESSAGE) {
    if (!isCloudAuthStorageBridgeSender(sender, chrome.runtime.id, chrome.runtime.getURL(OFFSCREEN_DOCUMENT_PATH))) {
      sendResponse({ success: false, error: "UNAUTHORIZED_CONTEXT" });
      return true;
    }
    void handleOffscreenStorageBridge(message.payload)
      .then(payload => sendResponse({ success: true, payload }))
      .catch(error => sendResponse({ success: false, error: error instanceof Error ? error.message : "Offscreen storage bridge failed" }));
    return true;
  }
  if (message?.target === "background" && message?.type === EXTENSION_POLICY_READ_MESSAGE) {
    if (!isCloudAuthStorageBridgeSender(sender, chrome.runtime.id, chrome.runtime.getURL(OFFSCREEN_DOCUMENT_PATH))) {
      sendResponse({ success: false, error: "UNAUTHORIZED_CONTEXT" });
      return true;
    }
    void (async () => {
      const row = await chrome.storage.local.get(EXTENSION_POLICY_KEY);
      return parseExtensionPolicy(row[EXTENSION_POLICY_KEY]);
    })().then(payload => sendResponse({ success: true, payload })).catch(error => sendResponse({
      success: false, error: error instanceof Error ? error.message : "Extension policy read failed",
    }));
    return true;
  }
  if (
    message?.target === "background" &&
    message?.type === CLOUD_AUTH_STORAGE_BRIDGE_MESSAGE
  ) {
    if (
      !isCloudAuthStorageBridgeSender(
        sender,
        chrome.runtime.id,
        chrome.runtime.getURL(OFFSCREEN_DOCUMENT_PATH),
      )
    ) {
      sendResponse({ success: false, error: "UNAUTHORIZED_CONTEXT" });
      return true;
    }
    void handleCloudAuthStorageBridge(message?.payload)
      .then((payload) => sendResponse({ success: true, payload }))
      .catch((error) =>
        sendResponse({
          success: false,
          error:
            error instanceof Error
              ? error.message
              : "Cloud auth storage bridge failed",
        }),
      );
    return true;
  }
  if (
    message?.target === "background" &&
    message?.type === ARCHIVE_MIGRATION_STORAGE_BRIDGE_MESSAGE
  ) {
    if (
      !isArchiveMigrationStorageBridgeSender(
        sender,
        chrome.runtime.id,
        chrome.runtime.getURL(OFFSCREEN_DOCUMENT_PATH),
      )
    ) {
      sendResponse({ success: false, error: "UNAUTHORIZED_CONTEXT" });
      return true;
    }
    void handleArchiveMigrationStorageBridge(message?.payload)
      .then((payload) => sendResponse({ success: true, payload }))
      .catch((error) =>
        sendResponse({
          success: false,
          error:
            error instanceof Error
              ? error.message
              : "Archive storage bridge failed",
        }),
      );
    return true;
  }
  if (
    message?.target === "background" &&
    CONNECTOR_MESSAGE_TYPES.has(String(message?.type || "")) &&
    (!isTrustedExtensionSender(sender) || !isSearchPageSender(sender))
  ) {
    sendResponse({ ok: false, error: "UNAUTHORIZED_CONTEXT" });
    return true;
  }
  if (
    message?.target === "background" &&
    GOOGLE_WORKSPACE_MESSAGE_TYPES.has(String(message?.type || "")) &&
    (!isTrustedExtensionSender(sender) || !isSearchPageSender(sender))
  ) {
    sendResponse({ success: false, error: "UNAUTHORIZED_CONTEXT" });
    return true;
  }
  if (
    message?.target === "background" &&
    LOCAL_BACKUP_MESSAGE_TYPES.has(String(message?.type || "")) &&
    (!isTrustedExtensionSender(sender) || !isSearchPageSender(sender))
  ) {
    sendResponse({ success: false, error: "UNAUTHORIZED_CONTEXT" });
    return true;
  }
  if (
    message?.target === "background" &&
    NOTION_MESSAGE_TYPES.has(String(message?.type || "")) &&
    (!isTrustedExtensionSender(sender) || !isSearchPageSender(sender))
  ) {
    sendResponse({ success: false, error: "UNAUTHORIZED_CONTEXT" });
    return true;
  }

  const archiveCloudResult = handleArchiveCloudMessage(
    message,
    sender,
    sendResponse,
    { deleteAllLocalData: deleteAllLocalDataOrchestrated },
  );
  if (archiveCloudResult !== null) return archiveCloudResult;

  const parsedMessage = BackgroundMessageSchema.safeParse(message);
  const request = parsedMessage.success ? parsedMessage.data : {};
  const payload = request.payload ?? {};

  if (request.target === "background" && request.type === "HOVER_SAVE_TARGET") {
    const tabId = sender.tab?.id;
    const url = normalizeHttpUrl(payload.url ?? null);
    const title = payload.title;
    if (sender.id === chrome.runtime.id && tabId !== undefined && url) {
      rememberHoverSaveTarget(tabId, url, title);
    }
    return;
  }

  if (request.target === "background" && request.type === "FETCH_METADATA") {
    scheduleForProcessing(payload.urls ?? [], payload.revalidate === true);
    return;
  }

  if (
    request.target === "background" &&
    request.type === "IMPORT_SHARED_LINK_FROM_PAGE"
  ) {
    // Triggered by the share-viewer bridge content script. Import the share the
    // visitor is viewing — the URL comes from sender.url (set by Chrome, not the
    // page) and must be a recognized vibe share link.
    const senderUrl = sender.url ?? "";
    if (sender.id !== chrome.runtime.id || !isVibeShareUrl(senderUrl)) {
      sendResponse({ success: false, error: "UNAUTHORIZED_SHARE_IMPORT" });
      return true;
    }
    void runBackgroundDataJob(() =>
      importSharedLink(senderUrl, PUBLIC_SPACE_ID),
    )
      .then(() => sendResponse({ success: true }))
      .catch((error) =>
        sendResponse({
          success: false,
          error:
            error instanceof Error ? error.message : "Share import failed.",
        }),
      );
    return true;
  }

  if (
    request.target === "background" &&
    request.type === "IMPORT_BROWSER_BOOKMARKS"
  ) {
    if (!isTrustedExtensionSender(sender) || !isSearchPageSender(sender)) {
      sendResponse({ success: false, error: "UNAUTHORIZED_CONTEXT" });
      return true;
    }
    void runBackgroundDataJob(() => importBrowserBookmarks())
      .then((payload) => sendResponse({ success: true, payload }))
      .catch((error) =>
        sendResponse({
          success: false,
          error:
            error instanceof Error
              ? error.message
              : "Browser bookmark import failed.",
        }),
      );
    return true;
  }

  if (
    request.target === "background" &&
    request.type === "IMPORT_GITHUB_STARS"
  ) {
    if (!isTrustedExtensionSender(sender) || !isSearchPageSender(sender)) {
      sendResponse({ success: false, error: "UNAUTHORIZED_CONTEXT" });
      return true;
    }
    const accessToken = payload.accessToken ?? "";
    void runBackgroundDataJob(() => importGitHubStars(accessToken))
      .then((payload) => sendResponse({ success: true, payload }))
      .catch((error) =>
        sendResponse({
          success: false,
          error:
            error instanceof Error
              ? error.message
              : "GitHub stars import failed.",
        }),
      );
    return true;
  }

  if (request.target === "background" && isProcessingTrigger(request.type)) {
    const triggerPayload = {
      itemId: payload.itemId,
      force: payload.force === true,
    };
    void forwardProcessingTriggerToOffscreen(request.type, triggerPayload)
      .then(() => sendResponse({ success: true }))
      .catch((error) =>
        sendResponse({
          success: false,
          error: error instanceof Error ? error.message : String(error),
        }),
      );
    return true;
  }

  if (
    request.target === "background" &&
    request.type === "PROMOTE_OPFS_MEDIA"
  ) {
    triggerOpfsPromotion();
    return;
  }

  if (request.target === "background" && request.type === "UNDO_SAVE") {
    const primaryUrl = payload.primaryUrl ?? "";
    const itemId = payload.itemId ?? "";
    void (async () => {
      if (itemId) await markArchiveItemCancelled(itemId);
      if (primaryUrl) {
        await sendForwardedToOffscreen({
          service: "items",
          type: "deleteByUrl",
          payload: { url: primaryUrl },
        });
      }
    })()
      .then(() => sendResponse({ success: true }))
      .catch((error) =>
        sendResponse({
          success: false,
          error: error instanceof Error ? error.message : "Undo failed.",
        }),
      );
    return true;
  }

  if (request.target === "background" && request.type === "OPEN_SEARCH") {
    void legacyBrowserEnabled().then(legacy => chrome.tabs.create({ url: chrome.runtime.getURL(legacy ? "src/pages/search/index.html" : LOCAL_LIBRARY_PATH) }));
    return;
  }

  if (
    request.target === "background" &&
    request.type === "SAVE_SCREENSHOT_TO"
  ) {
    const pendingId = payload.pendingId ?? "";
    const folderId = payload.folderId ?? "";
    const spaceId = payload.spaceId ?? PUBLIC_SPACE_ID;
    const autoSave = payload.autoSave === true;
    if (pendingId) {
      void finalizeScreenshotSave(pendingId, folderId, spaceId, {
        preferLru: autoSave,
      });
    }
    return;
  }

  if (request.target === "background" && request.type === "MOVE_SAVED_ITEM") {
    const itemId = payload.itemId ?? "";
    const folderId = payload.folderId ?? "";
    if (itemId && folderId) {
      void moveSavedItemToFolder(itemId, folderId, sender?.tab);
    }
    return;
  }

  if (request.target === "background" && request.type === "QUICK_SAVE_PAGE") {
    void (async () => {
      const tab = await getActiveTab();
      if (!tab?.id) return;
      const context = collectContextFromTab(tab);
      await runImportAction(
        { mode: "save", spaceId: PUBLIC_SPACE_ID },
        context,
        tab,
      );
    })();
    return;
  }

  if (
    request.target === "background" &&
    request.type === "QUICK_ARCHIVE_PAGE"
  ) {
    void (async () => {
      const tab = await getActiveTab();
      if (!tab?.id) return;
      const context = collectContextFromTab(tab);
      await runArchiveSnapshotAction(context, tab);
    })();
    return;
  }

  if (
    request.target === "background" &&
    request.type === "RUN_CONNECTOR_SYNC"
  ) {
    const source = payload.source ?? "";
    const accountId = payload.accountId ?? "";
    let platform: ConnectorPlatform | null = null;
    if (source) {
      if (!isConnectorPlatform(source)) {
        sendResponse({ ok: false, error: "UNKNOWN_CONNECTOR" });
        return true;
      }
      platform = source;
    }
    const nice = platform ? CONNECTOR_LABELS[platform] : "connectors";
    void (async () => {
      const job = {
        id: `connector-${source || "all"}-${Date.now()}`,
        label: `Sync • ${nice}`,
      };
      const report = (detail: string) => {
        console.log(
          `[Vibesearch · Sync${source ? " · " + nice : ""}] ${detail}`,
        );
        sendProcessStatus(job.id, job.label, "processing", detail);
      };
      report(
        source ? `Connecting to ${nice}…` : "Syncing your connected accounts…",
      );
      try {
        await refreshConnectorCloudAuth();
        if (platform) {
          const state = accountId
            ? (await listConnectors()).find(
                (entry) =>
                  entry.platform === platform && entry.accountId === accountId,
              )
            : await connectConnector(platform);
          if (!state)
            throw new Error(
              "Connector account not found — reconnect it first.",
            );
          const who = state.handle.startsWith("id:")
            ? "your account"
            : `@${state.handle}`;
          report(`Reading saved items for ${who}…`);
          const r = await syncConnector(platform, state.accountId, report);
          sendProcessStatus(
            job.id,
            job.label,
            r.error ? "error" : "success",
            describeConnectorOutcome(who, r),
          );
        } else {
          const results = await syncAllConnected(report);
          const pushed = results.reduce((n, r) => n + r.pushed, 0);
          sendProcessStatus(
            job.id,
            job.label,
            "success",
            `Synced ${results.length} account${results.length === 1 ? "" : "s"} — ${pushed} new item${pushed === 1 ? "" : "s"} to Vibesearch.`,
          );
        }
        sendResponse({ ok: true });
      } catch (err) {
        sendProcessStatus(
          job.id,
          job.label,
          "error",
          err instanceof Error ? err.message : "Sync failed.",
        );
        sendResponse({ ok: false });
      }
    })();
    return true;
  }

  if (
    request.target === "background" &&
    request.type === "CANCEL_CONNECTOR_SYNC"
  ) {
    const source = payload.source ?? "";
    if (isConnectorPlatform(source)) cancelConnectorSync(source);
    sendResponse({ ok: true });
    return true;
  }

  if (request.target === "background" && request.type === "CONNECTOR_LIST") {
    void (async () =>
      sendResponse({ ok: true, connectors: await listConnectors() }))().catch(
      () => sendResponse({ ok: false, connectors: [] }),
    );
    return true;
  }

  if (request.target === "background" && request.type === "CONNECTOR_CONNECT") {
    void (async () => {
      try {
        const platform = payload.platform ?? "";
        if (!isConnectorPlatform(platform))
          throw new Error("Unknown connector.");
        const state = await connectConnector(platform);
        sendResponse({ ok: true, state });
      } catch (err) {
        sendResponse({
          ok: false,
          error: err instanceof Error ? err.message : "Connect failed.",
        });
      }
    })();
    return true;
  }

  if (
    request.target === "background" &&
    request.type === "CONNECTOR_DISCONNECT"
  ) {
    void (async () => {
      const platform = payload.platform ?? "";
      if (!isConnectorPlatform(platform)) throw new Error("Unknown connector.");
      await disconnectConnector(platform, payload.accountId ?? "");
      sendResponse({ ok: true });
    })().catch(() => sendResponse({ ok: false }));
    return true;
  }

  if (
    request.target === "background" &&
    request.type === "CONNECTOR_SET_AUTOSYNC"
  ) {
    void (async () => {
      const platform = payload.platform ?? "";
      if (!isConnectorPlatform(platform)) throw new Error("Unknown connector.");
      await setConnectorAutoSync(
        platform,
        payload.accountId ?? "",
        payload.on === true,
      );
      sendResponse({ ok: true });
    })().catch(() => sendResponse({ ok: false }));
    return true;
  }

  if (request.target === "background" && request.type === "QUICK_SCREENSHOT") {
    const screenshotMode = payload.mode === "region" ? "region" : "visible";
    void (async () => {
      const tab = await getActiveTab();
      if (!tab?.id) return;
      const context = collectContextFromTab(tab);
      await runScreenshotAction(
        { mode: "shot", spaceId: PUBLIC_SPACE_ID, screenshotMode },
        context,
        tab,
      );
    })();
    return;
  }

  if (
    request.target === "background" &&
    request.type === "QUICK_EXTRACT_PAGE"
  ) {
    void (async () => {
      const tab = await getActiveTab();
      if (!tab?.id) return;
      const context = collectContextFromTab(tab);
      await runScreenshotAction(
        {
          mode: "shot",
          spaceId: PUBLIC_SPACE_ID,
          screenshotMode: "visible",
          extractIntent: true,
        },
        context,
        tab,
      );
    })();
    return;
  }

  if (request.target === "background" && request.type === "SAVE_PASTED_URL") {
    const url = normalizeHttpUrl(payload.url?.trim() ?? "");
    if (!url) return;
    void (async () => {
      const context = buildContextFromUrl(url);
      await runImportAction(
        { mode: "save", spaceId: PUBLIC_SPACE_ID },
        context,
        undefined,
      );
    })();
    return;
  }

  if (
    request.target === "background" &&
    request.type === "SHARE_IMPORT_FROM_URL"
  ) {
    void runBackgroundDataJob(async () => {
      const url = normalizeHttpUrl(payload.url ?? "");
      if (!url) throw new Error("INVALID_SHARE_URL");
      const targetSpaceId = payload.targetSpaceId ?? PUBLIC_SPACE_ID;
      const result = await importSharedLink(url, targetSpaceId);
      sendResponse({ success: true, payload: result });
    }).catch((error) =>
      sendResponse({
        success: false,
        error: error instanceof Error ? error.message : "Share import failed",
      }),
    );
    return true;
  }

  const backupExportResult = handleBackupExportMessage(message, sendResponse);
  if (backupExportResult !== null) return backupExportResult;

  if (request.target === "background" && request.type?.startsWith("IMPORT_")) {
    void runBackgroundDataJob(() => handleImportControlMessage(message, sender))
      .then((result) => sendResponse(result))
      .catch((error) =>
        sendResponse({
          success: false,
          error: error instanceof Error ? error.message : "Unknown error",
        }),
      );
    return true;
  }

  if (request.type === "DB_CHANGE" && request.scope !== undefined) {
    scheduleContextMenuRefresh(request.scope === "items" ? "low" : "high");
    return;
  }

  if (message?.target !== "offscreen" || message?.isForwarded) {
    return;
  }

  if (!isTrustedExtensionSender(sender)) {
    sendResponse({ success: false, error: "UNAUTHORIZED_SENDER" });
    return true;
  }

  if (isSearchOnlyOffscreenCall(message) && !isSearchPageSender(sender)) {
    sendResponse({ success: false, error: "UNAUTHORIZED_CONTEXT" });
    return true;
  }

  if (isInternalOnlyOffscreenCall(message)) {
    sendResponse({ success: false, error: "UNAUTHORIZED_CONTEXT" });
    return true;
  }

  if (isLocalDataResetBlocked()) {
    sendResponse({ success: false, error: "LOCAL_DATA_RESET_IN_PROGRESS" });
    return true;
  }

  const forwardedRequest = trackOffscreenRequest(
    (async () => {
      try {
        if (
          import.meta.env.MODE === "development" &&
          FORCE_DEV_OFFSCREEN_RESET
        ) {
          try {
            await chrome.offscreen?.closeDocument();
          } catch {}
        }

        await setupOffscreenDocument();
        const response = await chrome.runtime.sendMessage({
          ...message,
          isForwarded: true,
        });
        sendResponse(response);
      } catch (error) {
        sendResponse({
          success: false,
          error: error instanceof Error ? error.message : "Unknown error",
        });
      }
    })(),
  );
  void forwardedRequest;

  return true;
});

scheduleContextMenuRefresh("high");

console.log(
  "Background script loaded with offscreen routing, context import, and draft review.",
);
