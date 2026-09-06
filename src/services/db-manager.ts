import {
  filterExistingItemIds,
  getAllFolders,
  getAllItems,
  getImportTargets,
} from "@src/services/database/access";
import {
  buildExportSnapshot,
  buildExportSnapshotFile,
  buildLocalExtensionMigrationBundle,
  buildLocalExtensionMigrationDownload,
  getNotionExportBatch,
  importSharedSnapshotPayload,
  mergeBackupSnapshot,
  mergeBackupSnapshotFile,
  restoreLocalExtensionMigrationBundle,
  restoreStagedLocalExtensionMigrationBundle,
  stageLocalExtensionMigrationBundle,
  stageLocalExtensionMigrationFile,
} from "@src/services/database/backup";
import {
  createFolder,
  toggleFolderLocked,
  toggleFolderPinned,
  updateFolderName,
} from "@src/services/database/folder-writes";
import {
  addItemToFolder,
  addItems,
  bulkUpdateItems,
  clearDeletedItems,
  deleteItem,
  markItemAsDirty,
  repairItemSpaceIdsFromFolders,
} from "@src/services/database/item-writes";
import {
  getItemsToOcr,
  markItemOcrProcessing,
  saveItemOcrResult,
} from "@src/services/database/ocr-records";
import { deleteAllData } from "@src/services/database/reset";
import {
  applyCompactedVectorIndexCommit,
  applyVectorInvalidation,
  commitCompactedVectorIndexes,
  getActiveItemsByIds,
  getActiveVectorInventory,
  getDirtyItems,
  getItemsToEmbed,
  isEmbeddingStateCommitCurrent,
  markAllActiveItemsForReembedding,
  repairItemsMissingVectors,
} from "@src/services/database/vector-records";

export type {
  DatabaseAccessContext,
  SearchScope,
} from "@src/services/database/access";
export type { CreateFolderPayload } from "@src/services/database/folder-writes";
export type { BulkItemUpdate } from "@src/services/database/item-writes";
export type {
  SavedMediaOcrResult,
  SaveItemOcrResultPayload,
} from "@src/services/database/ocr-records";
export type {
  ActiveVectorEmbeddingSnapshot,
  ActiveVectorInventoryItem,
  CompactedVectorIndexCommit,
} from "@src/services/database/vector-records";
export type {
  ImportTargetFolder,
  ImportTargetItemPreview,
  ImportTargetOptions,
  ImportTargetSpace,
} from "@src/services/imports/targets";

export {
  applyCompactedVectorIndexCommit,
  applyVectorInvalidation,
  isEmbeddingStateCommitCurrent,
};

/**
 * Stable message-router façade. Implementations live in named domain modules so
 * humans and agents can locate a responsibility without opening a god object.
 */
export const databaseManager = {
  getAllItems,
  getAllFolders,
  getImportTargets,
  filterExistingItemIds,
  buildExportSnapshot,
  buildExportSnapshotFile,
  getNotionExportBatch,
  importSharedSnapshot: importSharedSnapshotPayload,
  restoreLocalExtensionMigrationBundle,
  buildLocalExtensionMigrationBundle,
  buildLocalExtensionMigrationDownload,
  stageLocalExtensionMigrationBundle,
  stageLocalExtensionMigrationFile,
  restoreStagedLocalExtensionMigrationBundle,
  mergeBackupSnapshot,
  mergeBackupSnapshotFile,
  deleteAllData,
  getItemsToEmbed,
  repairItemsMissingVectors,
  getActiveVectorInventory,
  getActiveItemsByIds,
  commitCompactedVectorIndexes,
  getDirtyItems,
  getItemsToOcr,
  markItemOcrProcessing,
  saveItemOcrResult,
  markAllActiveItemsForReembedding,
  deleteItem,
  clearDeletedItems,
  bulkUpdateItems,
  markItemAsDirty,
  addItems,
  addItemToFolder,
  createFolder,
  toggleFolderPinned,
  toggleFolderLocked,
  updateFolderName,
  repairItemSpaceIdsFromFolders,
};
