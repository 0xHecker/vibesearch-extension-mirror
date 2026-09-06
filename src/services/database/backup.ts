import type { JsonValue } from "@src/common/json-value";
import {
  buildLocalExtensionMigrationBundle as buildMigrationBundle,
  LOCAL_MIGRATION_MAX_JSON_BYTES,
  restoreLocalExtensionMigrationBundle as restoreMigrationBundle,
  summarizeLocalExtensionMigrationBundle,
  validateLocalExtensionMigrationBundle,
  type LocalExtensionMigrationBundle,
  type LocalExtensionMigrationSummary,
  type RestoreLocalExtensionMigrationResult,
} from "@src/services/local-extension-migration";
import { createLocalMigrationJsonBlob } from "@src/services/local-extension-migration-json";
import {
  clearOffscreenArchiveOutboxMetadata,
  getOffscreenArchiveCache,
  getOffscreenArchiveOutboxReader,
} from "@src/services/archive-migration-storage-bridge";
import { GOOGLE_BACKUP_MAX_BYTES } from "@src/services/google-backup-limits";
import {
  deleteStagedPayloadFile,
  readStagedPayloadFile,
  stagePayloadFile,
} from "@src/services/large-payload-staging";
import { loadNotionExportBatch } from "@src/services/notion-export-source";
import {
  buildLocalExportSnapshot,
  importSharedSnapshot,
  mergeBackupSnapshot as mergeSnapshot,
  type BuildExportSnapshotPayload,
  type ImportSharedSnapshotPayload,
  type ImportSharedSnapshotResult,
  type MergeBackupSnapshotResult,
  type ShareSnapshotV1,
} from "@src/services/share-snapshot";

const STAGED_RESTORE_TTL_MS = 15 * 60 * 1000;
const stagedMigrationBundles = new Map<string, LocalExtensionMigrationBundle>();

export async function buildExportSnapshot(
  payload?: BuildExportSnapshotPayload,
): Promise<ShareSnapshotV1> {
  return buildLocalExportSnapshot(payload);
}

export async function buildExportSnapshotFile(
  payload?: BuildExportSnapshotPayload,
): Promise<{ fileName: string; itemCount: number; folderCount: number }> {
  const snapshot = await buildLocalExportSnapshot(payload);
  const blob = new Blob([JSON.stringify(snapshot)], { type: "application/json" });
  if (blob.size > GOOGLE_BACKUP_MAX_BYTES) throw new Error("GOOGLE_BACKUP_TOO_LARGE");
  return {
    fileName: await stagePayloadFile(blob, "drive-export"),
    itemCount: snapshot.items.length,
    folderCount: snapshot.folders.length,
  };
}

export function getNotionExportBatch(payload?: {
  afterId?: string;
  limit?: number;
}) {
  return loadNotionExportBatch(payload);
}

export async function importSharedSnapshotPayload(
  payload: ImportSharedSnapshotPayload,
): Promise<ImportSharedSnapshotResult> {
  return importSharedSnapshot(payload);
}

export async function restoreLocalExtensionMigrationBundle(payload: {
  bundle: LocalExtensionMigrationBundle;
}): Promise<RestoreLocalExtensionMigrationResult> {
  return restoreMigrationBundle(payload.bundle, {
    archiveCache: getOffscreenArchiveCache(),
  });
}

export async function buildLocalExtensionMigrationBundle(): Promise<LocalExtensionMigrationBundle> {
  return buildMigrationBundle({
    archiveCache: getOffscreenArchiveCache(),
    archiveOutbox: getOffscreenArchiveOutboxReader(),
  });
}

export async function buildLocalExtensionMigrationDownload(): Promise<{
  fileName: string;
  createdAt: number;
  summary: LocalExtensionMigrationSummary;
  warnings: string[];
}> {
  const bundle = await buildLocalExtensionMigrationBundle();
  const blob = createLocalMigrationJsonBlob(bundle);
  if (blob.size > LOCAL_MIGRATION_MAX_JSON_BYTES) {
    throw new Error("MIGRATION_FILE_JSON_TOO_LARGE");
  }
  return {
    fileName: await stagePayloadFile(blob, "local-export"),
    createdAt: bundle.createdAt,
    summary: summarizeLocalExtensionMigrationBundle(bundle),
    warnings: bundle.warnings.slice(0, 100),
  };
}

export async function stageLocalExtensionMigrationBundle(payload: {
  json: string;
}): Promise<{ stageId: string; summary: LocalExtensionMigrationSummary }> {
  if (payload.json.length > LOCAL_MIGRATION_MAX_JSON_BYTES) {
    throw new Error("MIGRATION_FILE_JSON_TOO_LARGE");
  }
  stagedMigrationBundles.clear();
  const bundle = validateLocalExtensionMigrationBundle(JSON.parse(payload.json));
  const stageId = crypto.randomUUID();
  stagedMigrationBundles.set(stageId, bundle);
  globalThis.setTimeout(() => stagedMigrationBundles.delete(stageId), STAGED_RESTORE_TTL_MS);
  return { stageId, summary: summarizeLocalExtensionMigrationBundle(bundle) };
}

export async function stageLocalExtensionMigrationFile(payload: {
  fileName: string;
}): Promise<{ stageId: string; summary: LocalExtensionMigrationSummary }> {
  try {
    const file = await readStagedPayloadFile(payload.fileName);
    if (file.size <= 0 || file.size > LOCAL_MIGRATION_MAX_JSON_BYTES) {
      throw new Error("MIGRATION_FILE_JSON_TOO_LARGE");
    }
    return await stageLocalExtensionMigrationBundle({ json: await file.text() });
  } finally {
    await deleteStagedPayloadFile(payload.fileName).catch(() => undefined);
  }
}

export async function restoreStagedLocalExtensionMigrationBundle(payload: {
  stageId: string;
}): Promise<RestoreLocalExtensionMigrationResult> {
  const bundle = stagedMigrationBundles.get(payload.stageId);
  if (!bundle) throw new Error("MIGRATION_FILE_NOT_STAGED");
  const result = await restoreMigrationBundle(bundle, {
    archiveCache: getOffscreenArchiveCache(),
  });
  stagedMigrationBundles.delete(payload.stageId);
  return result;
}

export async function mergeBackupSnapshot(payload: {
  snapshot: JsonValue;
}): Promise<MergeBackupSnapshotResult> {
  return mergeSnapshot(payload.snapshot);
}

export async function mergeBackupSnapshotFile(payload: {
  fileName: string;
}): Promise<MergeBackupSnapshotResult> {
  try {
    const file = await readStagedPayloadFile(payload.fileName);
    if (file.size <= 0 || file.size > GOOGLE_BACKUP_MAX_BYTES) {
      throw new Error("GOOGLE_BACKUP_TOO_LARGE");
    }
    return await mergeSnapshot(JSON.parse(await file.text()));
  } finally {
    await deleteStagedPayloadFile(payload.fileName).catch(() => undefined);
  }
}

export function clearStagedMigrationBundles(): void {
  stagedMigrationBundles.clear();
}

export { clearOffscreenArchiveOutboxMetadata };
