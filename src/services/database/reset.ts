import { ARCHIVE_OUTBOX_DIRECTORY } from "@src/services/archive-outbox";
import {
  clearOffscreenArchiveOutboxMetadata,
  getOffscreenArchiveCache,
} from "@src/services/archive-migration-storage-bridge";
import { getDb } from "@src/services/DatabaseService";
import { clearStagedPayloads } from "@src/services/large-payload-staging";
import { spaceSessionService } from "@src/services/space-session.service";
import { vectorMaintenanceJournalService } from "@src/services/vector-maintenance-journal.service";
import { vectorPipelineCoordinator } from "@src/services/vector-pipeline-coordinator";
import { vectorStoreService } from "@src/services/vector-store.service";
import { clearStagedMigrationBundles } from "@src/services/database/backup";

type CleanupTask = {
  name: string;
  run(): Promise<void>;
};

function errorFromRejection(cause: unknown, taskName: string): Error {
  if (cause instanceof Error) return cause;
  return new Error(`${taskName} failed`);
}

function isMissingDirectory(cause: unknown): boolean {
  return cause instanceof DOMException && cause.name === "NotFoundError";
}

async function removeOpfsDirectory(name: string): Promise<void> {
  try {
    const root = await navigator.storage.getDirectory();
    await root.removeEntry(name, { recursive: true });
  } catch (cause) {
    if (!isMissingDirectory(cause)) throw cause;
  }
}

async function runCleanupTasks(tasks: CleanupTask[], failureCode: string): Promise<void> {
  const results = await Promise.allSettled(tasks.map((task) => task.run()));
  const failures = results.flatMap((result, index) => {
    if (result.status === "fulfilled") return [];
    return [errorFromRejection(result.reason, tasks[index]?.name ?? "cleanup")];
  });
  if (failures.length > 0) throw new AggregateError(failures, failureCode);
}

async function deleteAllDataLocked(): Promise<{ deletedCollections: number }> {
  clearStagedMigrationBundles();
  spaceSessionService.lockAll();
  const db = await getDb();
  const collectionTasks: CleanupTask[] = [
    { name: "items", run: async () => { await db.items.find().remove(); } },
    { name: "folders", run: async () => { await db.folders.find().remove(); } },
    { name: "spaces", run: async () => { await db.spaces.find().remove(); } },
    { name: "space groups", run: async () => { await db.space_groups.find().remove(); } },
    { name: "tags", run: async () => { await db.tags.find().remove(); } },
    { name: "item tags", run: async () => { await db.item_tags.find().remove(); } },
    { name: "search history", run: async () => { await db.search_history.find().remove(); } },
    { name: "flashcards", run: async () => { await db.flashcards.find().remove(); } },
    { name: "deleted items", run: async () => { await db.deleted_items.find().remove(); } },
  ];
  await runCleanupTasks(
    collectionTasks,
    `DELETE_ALL_COLLECTIONS_FAILED:0/${collectionTasks.length}`,
  );

  const payloadTasks: CleanupTask[] = [
    { name: "media", run: () => removeOpfsDirectory("media") },
    { name: "archive cache", run: () => getOffscreenArchiveCache().clear() },
    { name: "archive outbox", run: () => removeOpfsDirectory(ARCHIVE_OUTBOX_DIRECTORY) },
    { name: "archive metadata", run: clearOffscreenArchiveOutboxMetadata },
    { name: "staged payloads", run: clearStagedPayloads },
    { name: "vector storage", run: () => vectorStoreService.deleteAllStorageFiles() },
    { name: "vector journal", run: () => vectorMaintenanceJournalService.remove() },
  ];
  await runCleanupTasks(payloadTasks, "DELETE_ALL_PAYLOAD_CLEANUP_FAILED");

  for (const scope of ["items", "folders", "spaces"] as const) {
    try {
      void chrome.runtime.sendMessage({ type: "DB_CHANGE", scope });
    } catch {
      // Tests and non-extension contexts do not have runtime messaging.
    }
  }
  return { deletedCollections: collectionTasks.length };
}

/** Permanently clear all local records and payloads under the vector reset lock. */
export function deleteAllData(): Promise<{ deletedCollections: number }> {
  return vectorPipelineCoordinator.runResetExclusive(deleteAllDataLocked);
}
