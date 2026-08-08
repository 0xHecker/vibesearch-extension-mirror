const SEARCH_ONLY_OFFSCREEN_METHODS = new Set<string>([
  "items:getByIds",
  "items:moveToSpace",
  "spaces:listSpaces",
  "spaces:createSpace",
  "spaces:renameSpace",
  "spaces:setPrivatePassword",
  "spaces:unlockSpace",
  "spaces:changePrivatePassword",
  "spaces:recoverPrivatePassword",
  "spaces:lockSpace",
  "spaces:touchSpaceActivity",
  "spaces:getSpaceAccessState",
]);

const INTERNAL_ONLY_OFFSCREEN_METHODS = new Set<string>([
  "items:saveFetchedMetadata",
  // Full-library operations must pass through their tracked background control
  // messages. Raw extension-page forwarding would bypass reset cancellation,
  // sender checks, staged-file limits, and destructive-operation orchestration.
  "dbManager:buildExportSnapshot",
  "dbManager:buildExportSnapshotFile",
  "dbManager:getNotionExportBatch",
  "dbManager:importSharedSnapshot",
  "dbManager:buildLocalExtensionMigrationBundle",
  "dbManager:buildLocalExtensionMigrationDownload",
  "dbManager:stageLocalExtensionMigrationBundle",
  "dbManager:stageLocalExtensionMigrationFile",
  "dbManager:restoreStagedLocalExtensionMigrationBundle",
  "dbManager:restoreLocalExtensionMigrationBundle",
  "dbManager:mergeBackupSnapshot",
  "dbManager:mergeBackupSnapshotFile",
  "dbManager:filterExistingItemIds",
  "dbManager:deleteAllData",
]);

type OffscreenCall = {
  service?: unknown;
  type?: unknown;
};

const callKey = (message: OffscreenCall): string =>
  `${typeof message?.service === "string" ? message.service : ""}:` +
  `${typeof message?.type === "string" ? message.type : ""}`;

export const isSearchOnlyOffscreenCall = (message: OffscreenCall): boolean =>
  SEARCH_ONLY_OFFSCREEN_METHODS.has(callKey(message));

export const isInternalOnlyOffscreenCall = (message: OffscreenCall): boolean =>
  INTERNAL_ONLY_OFFSCREEN_METHODS.has(callKey(message));
