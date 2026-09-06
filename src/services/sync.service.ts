import { databaseManager } from "./db-manager";
import {
  isVectorStoreIntegrityError,
  vectorStoreService,
} from "./vector-store.service";
import { vectorPipelineCoordinator } from "./vector-pipeline-coordinator";
import { vectorMaintenanceJournalService } from "./vector-maintenance-journal.service";
import {
  commitCompactionWithRecovery,
  invalidatePartiallyCommittedCompaction,
} from "./vector-store/compaction-commit";
import {
  getVectorIndexes,
  isMetadataReadyForEmbedding,
} from "@src/search-core/embedding-state";

const sendProcessStatus = (payload: {
  id: string;
  label: string;
  state: "processing" | "success" | "error";
  detail: string;
  retryAction?: "REBUILD_VECTORS";
}) => {
  try {
    chrome.runtime.sendMessage({
      type: "PROCESS_STATUS",
      payload: {
        ...payload,
        updatedAt: Date.now(),
      },
    });
  } catch {}
};

class SyncService {
  private isSyncing = false;
  private readonly tempFileName = "vectors.tmp";
  private readonly backupFileName = "vectors.bak";

  private async cleanupResidualCompactionFiles() {
    await vectorStoreService.deleteFile(this.tempFileName);
    await vectorStoreService.deleteFile(this.backupFileName);
  }

  public async recoverInterruptedMaintenance() {
    if (this.isSyncing) {
      return;
    }

    this.isSyncing = true;
    try {
      await vectorPipelineCoordinator.runExclusive("compaction", async () => {
        const journal = await vectorMaintenanceJournalService.read();
        if (journal.phase === "idle") {
          try {
            await vectorStoreService.getVectorCount();
          } catch (error) {
            if (!isVectorStoreIntegrityError(error)) throw error;
            const recoveryOperationId =
              crypto.randomUUID?.() ?? `integrity-${Date.now()}-${Math.random()}`;
            await vectorMaintenanceJournalService.setPhase("swapped", {
              operationId: recoveryOperationId,
              startedAt: Date.now(),
              detail: `Recovering corrupt vector storage: ${error.message}`,
            });
            let resetCount = 0;
            await vectorStoreService.runWithSearchesPaused(
              async () => {
                resetCount = await invalidatePartiallyCommittedCompaction({
                  clearVectors: () => vectorStoreService.clearStorage(),
                  invalidateItems: () => databaseManager.markAllActiveItemsForReembedding(),
                });
                await databaseManager.clearDeletedItems();
                await this.cleanupResidualCompactionFiles();
                await vectorMaintenanceJournalService.clear(
                  `Recovered corrupt vector storage; scheduled ${resetCount} items for re-embedding.`
                );
              },
              { blockSearchesOnError: true }
            );
          }
          await this.cleanupResidualCompactionFiles();
          return;
        }

        sendProcessStatus({
          id: "vector-sync",
          label: "Vector store",
          state: "processing",
          detail: "Recovering from interrupted vector maintenance...",
        });

        if (journal.phase === "preparing" || journal.phase === "prepared") {
          await this.cleanupResidualCompactionFiles();
          await vectorMaintenanceJournalService.clear("Recovered pre-swap interruption.");
          sendProcessStatus({
            id: "vector-sync",
            label: "Vector store",
            state: "success",
            detail: "Recovered interrupted vector maintenance.",
          });
          return;
        }

        if (journal.phase === "swapped") {
          // `swapped` may mean the process died after any DB commit batch. We
          // cannot safely restore only the old file because earlier batches may
          // already contain compacted indexes. Discard all vectors and rebuild.
          let resetCount = 0;
          await vectorStoreService.runWithSearchesPaused(
            async () => {
              resetCount = await invalidatePartiallyCommittedCompaction({
                clearVectors: () => vectorStoreService.clearStorage(),
                invalidateItems: () => databaseManager.markAllActiveItemsForReembedding(),
              });
              await databaseManager.clearDeletedItems();
              await this.cleanupResidualCompactionFiles();
              await vectorMaintenanceJournalService.clear(
                `Recovered interrupted swap; scheduled ${resetCount} items for re-embedding.`
              );
            },
            { blockSearchesOnError: true }
          );

          sendProcessStatus({
            id: "vector-sync",
            label: "Vector store",
            state: "processing",
            detail: `Recovered interrupted commit. Re-embedding ${resetCount} items...`,
          });
          return;
        }

        if (journal.phase === "db_committed") {
          await this.cleanupResidualCompactionFiles();
          await vectorMaintenanceJournalService.clear("Recovered post-commit cleanup.");
          sendProcessStatus({
            id: "vector-sync",
            label: "Vector store",
            state: "success",
            detail: "Recovered vector maintenance cleanup.",
          });
          return;
        }
      });
    } catch (error) {
      console.error("Error during vector maintenance recovery:", error);
      sendProcessStatus({
        id: "vector-sync",
        label: "Vector store",
        state: "error",
        detail: error instanceof Error ? error.message : "Vector maintenance recovery failed.",
        retryAction: "REBUILD_VECTORS",
      });
      throw error;
    } finally {
      this.isSyncing = false;
    }
  }

  /**
   * Philosophy: To maintain a healthy and efficient vector store, we use a
   * "rebuild and compact" strategy. This process runs periodically to:
   *  1. Remove vectors for deleted items.
   *  2. Re-embed items whose content has changed (marked as `isDirty`).
   *  3. Compact the vector file to reclaim space and keep searches fast.
   * This is a safe, atomic operation that works on a temporary file and
   * replaces the old one only upon successful completion, preventing data loss.
   */
  public async rebuildAndCompact(options?: { reembedMissing?: boolean }) {
    if (this.isSyncing) {
      console.log("Sync already in progress. Skipping.");
      sendProcessStatus({
        id: "vector-sync",
        label: "Vector store",
        state: "processing",
        detail: "Vector compaction already in progress.",
      });
      return;
    }

    this.isSyncing = true;
    console.log("Starting vector store rebuild and compaction...");

    if (vectorPipelineCoordinator.getActiveOperation() === "embedding") {
      sendProcessStatus({
        id: "vector-sync",
        label: "Vector store",
        state: "processing",
        detail: "Waiting for embedding queue to settle...",
      });
    } else {
      sendProcessStatus({
        id: "vector-sync",
        label: "Vector store",
        state: "processing",
        detail: "Compacting vector store...",
      });
    }

    const tempFileName = this.tempFileName;
    const backupFileName = this.backupFileName;
    let backupExists = false;
    const operationId = crypto.randomUUID?.() ?? `${Date.now()}-${Math.random()}`;

    try {
      await vectorPipelineCoordinator.runExclusive("compaction", async () => {
        await vectorMaintenanceJournalService.begin(operationId, "Vector compaction started.");
        sendProcessStatus({
          id: "vector-sync",
          label: "Vector store",
          state: "processing",
          detail: "Compacting vector store...",
        });

        // Step 1: Build a lightweight inventory. Full text/media is loaded only
        // for each small batch that actually needs re-embedding.
        const inventory = await databaseManager.getActiveVectorInventory();
        if (inventory.length === 0) {
          console.log("No active items found. Clearing vector store.");
          await vectorStoreService.clearStorage();
          sendProcessStatus({
            id: "vector-sync",
            label: "Vector store",
            state: "success",
            detail: "Vector store cleared. No active records.",
          });
          return;
        }

        // Step 2: Create a new temporary vector file
        await vectorStoreService.createNewVectorFile(tempFileName);

        // Step 3: Separate dirty and clean items. A restore/import can be left
        // without vectors until the user explicitly asks to create them; routine
        // periodic compaction must not silently start that expensive work.
        const shouldReembed = (item: (typeof inventory)[number]) =>
          isMetadataReadyForEmbedding(item) &&
          (item.isDirty ||
            !item.isEmbedded ||
            (options?.reembedMissing === true && getVectorIndexes(item).length === 0));
        const dirtyItemIds = inventory.filter(shouldReembed).map((item) => item.id);
        const dirtyItemIdSet = new Set(dirtyItemIds);
        const inventoryByItemId = new Map(inventory.map((item) => [item.id, item]));
        const cleanItems = inventory
          .filter((item) => !shouldReembed(item))
          .flatMap((item) => {
            return getVectorIndexes(item).map((vector_index) => ({
              id: item.id,
              vector_index,
              snapshotRevision: item.revision,
            }));
          });

        // Step 4: Re-embed dirty items and copy clean vectors
        let lastReportedEmbedded = 0;
        const { newIndexMap, sourceRevisionByItemId } = await vectorStoreService.rebuildVectors(
          tempFileName,
          dirtyItemIds,
          (itemIds) => databaseManager.getActiveItemsByIds(itemIds),
          cleanItems,
          ({ completedItems, totalItems }) => {
            if (completedItems < totalItems && completedItems - lastReportedEmbedded < 100) return;
            lastReportedEmbedded = completedItems;
            sendProcessStatus({
              id: "vector-sync",
              label: "Vector store",
              state: "processing",
              detail: `Embedding ${completedItems.toLocaleString()} of ${totalItems.toLocaleString()} records...`,
            });
          }
        );
        await vectorMaintenanceJournalService.setPhase("prepared", {
          operationId,
          detail: `Prepared compacted vectors for ${newIndexMap.length} items.`,
        });

        // Step 5: Create backup, swap in rebuilt vectors, then commit DB index updates.
        await vectorStoreService.copyFile("vectors.bin", backupFileName, { truncateDest: true });
        backupExists = true;
        let recoveredCommitError: Error | null = null;
        await vectorStoreService.runWithSearchesPaused(
          async () => {
            await vectorStoreService.renameFile(tempFileName, "vectors.bin");
            await vectorMaintenanceJournalService.setPhase("swapped", {
              operationId,
              detail: "Swapped compacted vector file into place.",
            });

            try {
              await commitCompactionWithRecovery({
                commit: async () => {
                  const indexesByItemId = new Map<string, number[]>();
                  for (const item of newIndexMap) {
                    const indexes = indexesByItemId.get(item.id) || [];
                    indexes.push(item.vector_index);
                    indexesByItemId.set(item.id, indexes);
                  }
                  const updates = Array.from(indexesByItemId.entries()).map(
                    ([id, vectorIndexes]) => {
                      const expectedRevision = sourceRevisionByItemId.get(id);
                      if (!expectedRevision) {
                        throw new Error(`Missing source revision for compacted item ${id}.`);
                      }
                      const snapshot = inventoryByItemId.get(id);
                      if (!snapshot) {
                        throw new Error(`Missing inventory state for compacted item ${id}.`);
                      }
                      const wasReembedded = dirtyItemIdSet.has(id);
                      return {
                        id,
                        vector_index: vectorIndexes[0] ?? -1,
                        vector_indexes: vectorIndexes,
                        expectedRevision,
                        // Copied vectors retain the snapshot's pending/clean state.
                        // Only a vector regenerated now becomes freshly clean.
                        isEmbeddedOnMatch: wasReembedded ? true : snapshot.isEmbedded,
                        isDirtyOnMatch: wasReembedded ? false : snapshot.isDirty,
                      };
                    }
                  );

                  await databaseManager.commitCompactedVectorIndexes(updates);
                  await databaseManager.clearDeletedItems();
                  await vectorMaintenanceJournalService.setPhase("db_committed", {
                    operationId,
                    detail: `Committed vector indexes for ${updates.length} items.`,
                  });
                },
                clearVectors: () => vectorStoreService.clearStorage(),
                invalidateItems: () => databaseManager.markAllActiveItemsForReembedding(),
                finalizeRecovery: async (invalidatedCount) => {
                  await databaseManager.clearDeletedItems();
                  if (backupExists) {
                    await vectorStoreService.deleteFile(backupFileName);
                    backupExists = false;
                  }
                  await vectorStoreService.deleteFile(tempFileName);
                  await vectorMaintenanceJournalService.clear(
                    `Discarded a partial vector commit; scheduled ${invalidatedCount} items for re-embedding.`
                  );
                },
              });
            } catch (error) {
              const journal = await vectorMaintenanceJournalService.read();
              if (journal.phase === "idle") {
                recoveredCommitError =
                  error instanceof Error ? error : new Error("Vector index commit failed.");
                return;
              }
              throw error;
            }
          },
          { blockSearchesOnError: true }
        );
        if (recoveredCommitError) throw recoveredCommitError;

        if (backupExists) {
          await vectorStoreService.deleteFile(backupFileName);
          backupExists = false;
        }
        await vectorMaintenanceJournalService.clear("Vector compaction complete.");

        console.log("Vector store rebuild and compaction complete.");
        sendProcessStatus({
          id: "vector-sync",
          label: "Vector store",
          state: "success",
          detail: "Vector compaction complete.",
        });
      });
    } catch (error) {
      console.error("Error during vector store rebuild:", error);
      sendProcessStatus({
        id: "vector-sync",
        label: "Vector store",
        state: "error",
        detail: error instanceof Error ? error.message : "Vector compaction failed.",
        retryAction: "REBUILD_VECTORS",
      });
      // Preserve the backup while a swapped journal still needs conservative
      // startup recovery. Other phases are safe to clean immediately.
      let preserveBackupForRecovery = true;
      try {
        const journal = await vectorMaintenanceJournalService.read();
        preserveBackupForRecovery =
          journal.operationId === operationId && journal.phase === "swapped";
        if (journal.operationId === operationId && journal.phase !== "swapped") {
          await vectorMaintenanceJournalService.clear("Compaction failed before commit completion.");
        }
      } catch {}
      try {
        await vectorStoreService.deleteFile(tempFileName);
      } catch {}
      if (!preserveBackupForRecovery) {
        try {
          await vectorStoreService.deleteFile(backupFileName);
        } catch {}
      }
    } finally {
      this.isSyncing = false;
    }
  }
}

export const syncService = new SyncService();
