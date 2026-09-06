import { z } from "zod";
import {
  clearGoogleWorkspaceAuth,
  connectGoogleWorkspace,
  downloadGoogleWorkspaceBackupBlob,
  getGoogleWorkspaceSyncState,
  listGoogleWorkspaceBackups,
  syncSnapshotFileToGoogleWorkspace,
} from "@src/services/google-workspace-sync";
import {
  appendNotionExportItems,
  createNotionExportPage,
} from "@src/services/notion-export";
import {
  NOTION_EXPORT_BATCH_SIZE,
  NOTION_EXPORT_MAX_ITEMS,
  type NotionExportBatch,
} from "@src/services/notion-export-source";
import {
  connectNotion,
  disconnectNotion,
  getNotionConnectionStatus,
  runWithNotionAccessToken,
} from "@src/services/notion-auth";
import {
  deleteStagedPayloadFile,
  stagePayloadFile,
  takeStagedPayloadFile,
} from "@src/services/large-payload-staging";
import { scheduleContextMenuRefresh } from "@src/workers/background/context-menus";
import { sendProcessStatus } from "@src/workers/background/process-status";
import {
  runBackgroundDataJob,
  sendForwardedToOffscreen,
} from "@src/workers/background/runtime";

const BackupExportPayloadSchema = z.object({
  fileName: z.string().optional(),
  stageId: z.string().optional(),
  fileId: z.string().optional(),
});
const BackupExportMessageSchema = z.object({
  target: z.string().optional(),
  type: z.string().optional(),
  payload: BackupExportPayloadSchema.optional(),
});
type BackupExportMessageInput = z.input<typeof BackupExportMessageSchema>;
type SendResponse = Parameters<
  Parameters<typeof chrome.runtime.onMessage.addListener>[0]
>[2];

export const handleBackupExportMessage = (
  input: BackupExportMessageInput,
  sendResponse: SendResponse,
): true | null => {
  const parsed = BackupExportMessageSchema.safeParse(input);
  if (!parsed.success) return null;
  const request = parsed.data;
  if (
    request.target === "background" &&
    request.type === "LOCAL_BACKUP_BUILD_DOWNLOAD"
  ) {
    void runBackgroundDataJob(() =>
      sendForwardedToOffscreen({
        service: "dbManager",
        type: "buildLocalExtensionMigrationDownload",
        payload: {},
      }),
    )
      .then((payload) => sendResponse({ success: true, payload }))
      .catch((error) =>
        sendResponse({
          success: false,
          error:
            error instanceof Error
              ? error.message
              : "Local backup export failed",
        }),
      );
    return true;
  }

  if (
    request.target === "background" &&
    request.type === "LOCAL_BACKUP_STAGE_FILE"
  ) {
    void runBackgroundDataJob(() =>
      sendForwardedToOffscreen({
        service: "dbManager",
        type: "stageLocalExtensionMigrationFile",
        payload: { fileName: request.payload?.fileName },
      }),
    )
      .then((payload) => sendResponse({ success: true, payload }))
      .catch((error) =>
        sendResponse({
          success: false,
          error:
            error instanceof Error
              ? error.message
              : "Local backup validation failed",
        }),
      );
    return true;
  }

  if (
    request.target === "background" &&
    request.type === "LOCAL_BACKUP_RESTORE_STAGED"
  ) {
    void runBackgroundDataJob(() =>
      sendForwardedToOffscreen({
        service: "dbManager",
        type: "restoreStagedLocalExtensionMigrationBundle",
        payload: { stageId: request.payload?.stageId },
      }),
    )
      .then((payload) => sendResponse({ success: true, payload }))
      .catch((error) =>
        sendResponse({
          success: false,
          error:
            error instanceof Error
              ? error.message
              : "Local backup restore failed",
        }),
      );
    return true;
  }

  if (
    request.target === "background" &&
    request.type === "GOOGLE_SYNC_STATUS"
  ) {
    void getGoogleWorkspaceSyncState()
      .then((payload) => sendResponse({ success: true, payload }))
      .catch((error) =>
        sendResponse({
          success: false,
          error:
            error instanceof Error
              ? error.message
              : "Google sync status failed",
        }),
      );
    return true;
  }

  if (
    request.target === "background" &&
    request.type === "GOOGLE_AUTH_STATUS"
  ) {
    void connectGoogleWorkspace({ interactive: false })
      .then((payload) => sendResponse({ success: true, payload }))
      .catch((error) =>
        sendResponse({
          success: false,
          error:
            error instanceof Error
              ? error.message
              : "Google auth status failed",
        }),
      );
    return true;
  }

  if (
    request.target === "background" &&
    request.type === "GOOGLE_AUTH_CONNECT"
  ) {
    void connectGoogleWorkspace({ interactive: true })
      .then((payload) => sendResponse({ success: true, payload }))
      .catch((error) =>
        sendResponse({
          success: false,
          error:
            error instanceof Error ? error.message : "Google connection failed",
        }),
      );
    return true;
  }

  if (
    request.target === "background" &&
    request.type === "GOOGLE_SYNC_CLEAR_AUTH"
  ) {
    void clearGoogleWorkspaceAuth()
      .then(() => sendResponse({ success: true, payload: { cleared: true } }))
      .catch((error) =>
        sendResponse({
          success: false,
          error:
            error instanceof Error ? error.message : "Google auth clear failed",
        }),
      );
    return true;
  }

  if (
    request.target === "background" &&
    request.type === "GOOGLE_BACKUP_LIST"
  ) {
    void listGoogleWorkspaceBackups()
      .then((payload) => sendResponse({ success: true, payload }))
      .catch((error) =>
        sendResponse({
          success: false,
          error:
            error instanceof Error
              ? error.message
              : "Google backup listing failed",
        }),
      );
    return true;
  }

  if (
    request.target === "background" &&
    request.type === "GOOGLE_BACKUP_RESTORE"
  ) {
    void runBackgroundDataJob(async () => {
      const fileId = request.payload?.fileId ?? "";
      if (!fileId) throw new Error("GOOGLE_BACKUP_FILE_ID_MISSING");
      sendProcessStatus(
        "google-backup-restore",
        "Google backup",
        "processing",
        "Downloading backup...",
      );
      const backupBlob = await downloadGoogleWorkspaceBackupBlob(fileId);
      const stagedFileName = await stagePayloadFile(backupBlob, "drive-import");
      sendProcessStatus(
        "google-backup-restore",
        "Google backup",
        "processing",
        "Validating and merging the downloaded backup...",
      );
      let payload: unknown;
      try {
        payload = await sendForwardedToOffscreen({
          service: "dbManager",
          type: "mergeBackupSnapshotFile",
          payload: { fileName: stagedFileName },
        });
      } finally {
        await deleteStagedPayloadFile(stagedFileName).catch(() => {});
      }
      scheduleContextMenuRefresh("high");
      sendProcessStatus(
        "google-backup-restore",
        "Google backup",
        "success",
        "Backup merged.",
      );
      sendResponse({ success: true, payload });
    }).catch((error) => {
      const detail =
        error instanceof Error ? error.message : "Google backup restore failed";
      sendProcessStatus(
        "google-backup-restore",
        "Google backup",
        "error",
        detail,
      );
      sendResponse({ success: false, error: detail });
    });
    return true;
  }

  if (
    request.target === "background" &&
    request.type === "GOOGLE_SYNC_EXPORT_ALL"
  ) {
    void runBackgroundDataJob(async () => {
      sendProcessStatus(
        "google-sync",
        "Google sync",
        "processing",
        "Building local export...",
      );
      const staged = await sendForwardedToOffscreen<{
        fileName: string;
        itemCount: number;
        folderCount: number;
      }>({
        service: "dbManager",
        type: "buildExportSnapshotFile",
        payload: { title: "VibeSearch export" },
      });
      const snapshotFile = await takeStagedPayloadFile(staged.fileName);
      sendProcessStatus(
        "google-sync",
        "Google sync",
        "processing",
        `Syncing ${staged.itemCount} items...`,
      );
      const payload = await syncSnapshotFileToGoogleWorkspace(
        snapshotFile,
        { itemCount: staged.itemCount, folderCount: staged.folderCount },
        { interactive: true },
      );
      sendProcessStatus(
        "google-sync",
        "Google backup",
        "success",
        `Backed up ${staged.itemCount} items to Drive.`,
      );
      sendResponse({ success: true, payload });
    }).catch((error) => {
      const detail =
        error instanceof Error ? error.message : "Google sync failed";
      sendProcessStatus("google-sync", "Google sync", "error", detail);
      sendResponse({ success: false, error: detail });
    });
    return true;
  }

  if (
    request.target === "background" &&
    request.type === "NOTION_AUTH_STATUS"
  ) {
    void getNotionConnectionStatus()
      .then((payload) => sendResponse({ success: true, payload }))
      .catch((error) =>
        sendResponse({
          success: false,
          error:
            error instanceof Error
              ? error.message
              : "Notion auth status failed",
        }),
      );
    return true;
  }

  if (
    request.target === "background" &&
    request.type === "NOTION_AUTH_CONNECT"
  ) {
    void connectNotion()
      .then((payload) => sendResponse({ success: true, payload }))
      .catch((error) =>
        sendResponse({
          success: false,
          error:
            error instanceof Error ? error.message : "Notion connection failed",
        }),
      );
    return true;
  }

  if (
    request.target === "background" &&
    request.type === "NOTION_AUTH_DISCONNECT"
  ) {
    void disconnectNotion()
      .then(() =>
        sendResponse({ success: true, payload: { disconnected: true } }),
      )
      .catch((error) =>
        sendResponse({
          success: false,
          error:
            error instanceof Error ? error.message : "Notion disconnect failed",
        }),
      );
    return true;
  }

  if (request.target === "background" && request.type === "NOTION_EXPORT_ALL") {
    void runBackgroundDataJob(async () => {
      sendProcessStatus(
        "notion-export",
        "Notion export",
        "processing",
        "Connecting to Notion...",
      );
      const page = await runWithNotionAccessToken(
        (token) => createNotionExportPage(token),
        { interactive: true },
      );
      let itemCount = 0;
      let afterId = "";
      try {
        while (true) {
          const batch = await sendForwardedToOffscreen<NotionExportBatch>({
            service: "dbManager",
            type: "getNotionExportBatch",
            payload: { afterId, limit: NOTION_EXPORT_BATCH_SIZE },
          });
          if (batch.items.length === 0) break;
          if (itemCount + batch.items.length > NOTION_EXPORT_MAX_ITEMS) {
            throw new Error("NOTION_EXPORT_ITEM_LIMIT");
          }
          await runWithNotionAccessToken(
            (token) => appendNotionExportItems(token, page.id, batch.items),
            { interactive: false },
          );
          itemCount += batch.items.length;
          sendProcessStatus(
            "notion-export",
            "Notion export",
            "processing",
            `Exported ${itemCount.toLocaleString()} items...`,
          );
          if (!batch.hasMore || !batch.nextCursor) break;
          afterId = batch.nextCursor;
        }
      } catch (error) {
        const detail =
          error instanceof Error ? error.message : "Notion export failed";
        throw new Error(`${detail}. Partial page: ${page.url}`);
      }
      const payload = { pageId: page.id, pageUrl: page.url, itemCount };
      sendProcessStatus(
        "notion-export",
        "Notion export",
        "success",
        `Exported ${itemCount.toLocaleString()} items.`,
      );
      sendResponse({ success: true, payload });
    }).catch((error) => {
      const detail =
        error instanceof Error ? error.message : "Notion export failed";
      sendProcessStatus("notion-export", "Notion export", "error", detail);
      sendResponse({ success: false, error: detail });
    });
    return true;
  }

  return null;
};
