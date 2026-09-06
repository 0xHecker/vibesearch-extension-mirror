import { getDb } from "@src/services/DatabaseService";
import { spacesController } from "@src/services/controllers/spaces.controller";
import { queryRankerService } from "@src/services/query-ranker.service";
import { syncService } from "@src/services/sync.service";
import { DatabaseChangePublisher } from "./database-change-publisher";
import { subscribeToDatabaseChanges } from "./database-subscriptions";
import type { ProcessingQueues } from "./processing-queues";
import { sendProcessStatus, sendStatusUpdate } from "./process-status";

const BIN_PURGE_INTERVAL_MS = 6 * 60 * 60 * 1_000;

async function purgeExpiredSpaces(): Promise<void> {
  try {
    const purge = await spacesController.purgeExpired();
    if (purge.purgedSpaceIds.length > 0) {
      console.log(
        `[Offscreen] Purged ${purge.purgedSpaceIds.length} expired bin space(s).`,
      );
    }
  } catch (error) {
    console.error("[Offscreen] Bin purge failed:", error);
  }
}

export async function initializeOffscreen(
  changes: DatabaseChangePublisher,
  queues: ProcessingQueues,
): Promise<void> {
  try {
    queryRankerService.prewarm();
    sendStatusUpdate("Initializing database...");
    sendProcessStatus({
      id: "offscreen-runtime",
      label: "Worker runtime",
      state: "processing",
      detail: "Initializing offscreen services...",
    });

    const db = await getDb();
    await spacesController.ensureDefaults();
    await spacesController.maybeRepairFolderAndItemSpaceAssignments();
    await purgeExpiredSpaces();
    sendStatusUpdate("Database initialized.");
    console.log("[Offscreen] Database ready.");

    await syncService.recoverInterruptedMaintenance();
    await queues.embedding.prepare();
    await queues.embedding.process();
    queues.ocr.scheduleIfNeeded();

    subscribeToDatabaseChanges(db, changes, queues);
    window.setInterval(() => void purgeExpiredSpaces(), BIN_PURGE_INTERVAL_MS);

    console.log(
      "[Offscreen] Initialization complete with auto-embedding enabled.",
    );
    sendProcessStatus({
      id: "offscreen-runtime",
      label: "Worker runtime",
      state: "success",
      detail: "Offscreen services are ready.",
    });
  } catch (error) {
    const detail =
      error instanceof Error ? error.message : "An unknown error occurred";
    console.error("[Offscreen] Error during initialization:", error);
    sendStatusUpdate(`Error: ${detail}`);
    sendProcessStatus({
      id: "offscreen-runtime",
      label: "Worker runtime",
      state: "error",
      detail,
      retryAction: "RETRY_QUERY",
    });
  }
}
