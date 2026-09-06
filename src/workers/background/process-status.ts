import {
  setMetadataProgressListener,
  type MetadataProgressSnapshot,
} from "@src/services/metadata-pipeline";
import type {
  ImportClickContext,
  ImportMode,
  ImportRetryAction,
  ProcessStatusRecord,
} from "@src/workers/background/import-types";
import { pickHostLabel } from "@src/workers/background/import-utils";

const HISTORY_LIMIT = 120;
const SUCCESS_TTL_MS = 15 * 60 * 1_000;
const PROCESSING_TTL_MS = 45 * 60 * 1_000;
const recentStatuses = new Map<string, ProcessStatusRecord>();
let metadataListenerInitialized = false;

type ImportJob = { id: string; label: string };

function isFresh(row: ProcessStatusRecord, now: number): boolean {
  if (row.state === "success") return now - row.updatedAt <= SUCCESS_TTL_MS;
  if (row.state === "processing")
    return now - row.updatedAt <= PROCESSING_TTL_MS;
  return true;
}

function pruneStatuses(): void {
  const now = Date.now();
  for (const [id, row] of recentStatuses) {
    if (!isFresh(row, now)) recentStatuses.delete(id);
  }
}

export function sendProcessStatus(
  id: string,
  label: string,
  state: ProcessStatusRecord["state"],
  detail: string,
  retryAction?: ImportRetryAction,
): void {
  const payload: ProcessStatusRecord = {
    id,
    label,
    state,
    detail,
    retryAction,
    updatedAt: Date.now(),
  };
  recentStatuses.set(id, payload);
  pruneStatuses();
  if (recentStatuses.size > HISTORY_LIMIT) {
    const retained = [...recentStatuses.values()]
      .sort((left, right) => right.updatedAt - left.updatedAt)
      .slice(0, HISTORY_LIMIT);
    recentStatuses.clear();
    for (const row of retained) recentStatuses.set(row.id, row);
  }
  try {
    void Promise.resolve(
      chrome.runtime.sendMessage({
        type: "PROCESS_STATUS",
        payload,
      }),
    ).catch(() => undefined);
  } catch {
    // Startup and tests may not have an available UI listener.
  }
}

export function listRecentProcessStatuses(max = 24): ProcessStatusRecord[] {
  pruneStatuses();
  return [...recentStatuses.values()]
    .sort((left, right) => right.updatedAt - left.updatedAt)
    .slice(0, Math.max(1, Math.min(200, max)));
}

export function clearRecentProcessStatuses(): void {
  recentStatuses.clear();
}

function importJobLabel(mode: ImportMode): string {
  if (mode === "shot") return "Screenshot";
  if (mode === "extract") return "Extract text";
  return "Import";
}

export function createImportJob(
  mode: ImportMode,
  context: ImportClickContext,
): ImportJob {
  return {
    id: `import-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    label: `${importJobLabel(mode)} • ${pickHostLabel(context)}`,
  };
}

function publishMetadataProgress(snapshot: MetadataProgressSnapshot): void {
  if (snapshot.pending > 0) {
    const failed =
      snapshot.failed > 0 ? `, ${snapshot.failed.toLocaleString()} failed` : "";
    sendProcessStatus(
      "metadata-queue",
      "Metadata",
      "processing",
      `Fetching metadata — ${snapshot.completed.toLocaleString()} done, ${snapshot.pending.toLocaleString()} pending${failed}.`,
    );
    return;
  }
  const detail =
    snapshot.completed > 0
      ? `Metadata complete for ${snapshot.completed.toLocaleString()} links${
          snapshot.failed > 0
            ? ` (${snapshot.failed.toLocaleString()} failed)`
            : ""
        }.`
      : "Metadata is idle.";
  sendProcessStatus("metadata-queue", "Metadata", "success", detail);
}

export function initializeMetadataProgressStatus(): void {
  if (metadataListenerInitialized) return;
  metadataListenerInitialized = true;
  setMetadataProgressListener(publishMetadataProgress);
}
