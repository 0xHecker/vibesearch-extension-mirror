import type {
  LocalExtensionMigrationBundle,
  LocalExtensionMigrationSummary,
  RestoreLocalExtensionMigrationResult,
} from "@src/services/local-extension-migration";
import { LOCAL_MIGRATION_MAX_JSON_BYTES } from "@src/services/local-extension-migration";
import { createLocalMigrationJsonBlob } from "@src/services/local-extension-migration-json";
import {
  deleteStagedPayloadFile,
  stagePayloadFile,
  takeStagedPayloadFile,
} from "@src/services/large-payload-staging";
import type {
  GoogleDriveBackup,
  GoogleWorkspaceSyncResult,
} from "@src/services/google-workspace-sync";
import type { MergeBackupSnapshotResult } from "@src/services/share-snapshot";

/**
 * Backup / restore operations, ported out of the old full-page MigrationTool so
 * the Settings modal can own them. The bundle never leaves the device unless
 * the user explicitly restores from Google Drive.
 */

export type StagedLocalMigration = {
  stageId: string;
  summary: LocalExtensionMigrationSummary;
};

export type StagedLocalMigrationDownload = {
  fileName: string;
  createdAt: number;
  summary: LocalExtensionMigrationSummary;
  warnings: string[];
};

export type {
  LocalExtensionMigrationBundle,
  LocalExtensionMigrationSummary,
  RestoreLocalExtensionMigrationResult,
  GoogleDriveBackup,
  MergeBackupSnapshotResult,
};

const callBackground = async <T,>(type: string, payload?: unknown): Promise<T> => {
  const response = await chrome.runtime.sendMessage({ target: "background", type, payload });
  if (!response?.success) throw new Error(response?.error || `${type} failed`);
  return response.payload as T;
};

export const formatDateForFile = (value: number) =>
  new Date(value).toISOString().replace(/[:.]/g, "-");

export const formatMigrationSummary = (summary: LocalExtensionMigrationSummary) =>
  `${summary.collections.items} items, ${summary.collections.folders} folders, ${summary.collections.spaces} spaces, ${summary.opfsFileCount} local media files, ${summary.archiveFileCount} offline archives`;

export const buildBackupDownload = () =>
  callBackground<StagedLocalMigrationDownload>("LOCAL_BACKUP_BUILD_DOWNLOAD");

type StageBackupFileDependencies = {
  stage: typeof stagePayloadFile;
  remove: typeof deleteStagedPayloadFile;
  submit: (fileName: string) => Promise<StagedLocalMigration>;
};

export const stageBackupFile = async (
  file: File,
  dependencies: StageBackupFileDependencies = {
    stage: stagePayloadFile,
    remove: deleteStagedPayloadFile,
    submit: (fileName) =>
      callBackground<StagedLocalMigration>("LOCAL_BACKUP_STAGE_FILE", { fileName }),
  },
): Promise<StagedLocalMigration> => {
  assertBackupFileSize(file.size);
  const fileName = await dependencies.stage(file, "local-import");
  try {
    return await dependencies.submit(fileName);
  } catch (error) {
    // The offscreen handler removes the payload in its own finally block once
    // it receives the request. If the background reset barrier rejects before
    // forwarding, that finally block never runs; clean up idempotently here so
    // repeated failed restores cannot retain up to 96 MiB each for an hour.
    await dependencies.remove(fileName).catch(() => {});
    throw error;
  }
};

export const assertBackupFileSize = (byteSize: number): void => {
  if (!Number.isSafeInteger(byteSize) || byteSize <= 0) {
    throw new Error("That backup file is empty or invalid.");
  }
  if (byteSize > LOCAL_MIGRATION_MAX_JSON_BYTES) {
    throw new Error(
      `That backup is larger than the safe ${(LOCAL_MIGRATION_MAX_JSON_BYTES / (1024 * 1024)).toFixed(0)} MB restore limit.`,
    );
  }
};

export const restoreStagedBundle = (stageId: string) =>
  callBackground<RestoreLocalExtensionMigrationResult>("LOCAL_BACKUP_RESTORE_STAGED", { stageId });

export const listDriveBackups = () => callBackground<GoogleDriveBackup[]>("GOOGLE_BACKUP_LIST");

export const createDriveBackup = () =>
  callBackground<GoogleWorkspaceSyncResult>("GOOGLE_SYNC_EXPORT_ALL");

export type NotionExportResult = {
  pageId: string;
  pageUrl: string;
  itemCount: number;
};

export const exportToNotion = () =>
  callBackground<NotionExportResult>("NOTION_EXPORT_ALL");

export const restoreDriveBackup = (fileId: string) =>
  callBackground<MergeBackupSnapshotResult>("GOOGLE_BACKUP_RESTORE", { fileId });

export const rebuildVectorIndex = async () => {
  const response = await chrome.runtime.sendMessage({
    service: "sync",
    type: "rebuildAndCompact",
    target: "offscreen",
    payload: { reembedMissing: true },
  });
  if (!response?.success) throw new Error(response?.error || "Vector indexing failed");
};

/** Wipe every local collection + OPFS media/archive payload. Destructive and irreversible. */
export const deleteAllLocalData = () =>
  callBackground<{ deletedCollections: number }>("DELETE_ALL_LOCAL_DATA");

export const summarizeBundle = (
  bundle: LocalExtensionMigrationBundle
): LocalExtensionMigrationSummary => ({
  collections: Object.fromEntries(
    Object.entries(bundle.collections).map(([name, rows]) => [name, rows.length])
  ) as LocalExtensionMigrationSummary["collections"],
  opfsFileCount: bundle.opfsFiles.length,
  archiveFileCount: bundle.archiveFiles.length,
  warningCount: bundle.warnings.length,
});

/**
 * Build a valid backup payload without creating a second library-sized string.
 * Binary fields are already base64 strings, so keeping each file as its own
 * Blob part prevents the browser from retaining both one giant JSON string and
 * the final Blob at the same time.
 */
export const createBackupJsonBlob = createLocalMigrationJsonBlob;

/** Trigger a browser download of the migration bundle as JSON. */
export const downloadStagedBackup = async (
  staged: StagedLocalMigrationDownload,
): Promise<void> => {
  const file = await takeStagedPayloadFile(staged.fileName);
  const href = URL.createObjectURL(file);
  const anchor = document.createElement("a");
  anchor.href = href;
  anchor.download = `vibesearch-extension-migration-${formatDateForFile(staged.createdAt)}.json`;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  window.setTimeout(() => URL.revokeObjectURL(href), 0);
};
