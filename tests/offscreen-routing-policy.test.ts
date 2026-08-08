import { expect, test } from "bun:test";
import {
  isInternalOnlyOffscreenCall,
  isSearchOnlyOffscreenCall,
} from "@src/services/offscreen-routing-policy";

test("raw offscreen forwarding cannot bypass full-library orchestration", () => {
  const internalDbManagerMethods = [
    "buildExportSnapshot",
    "buildExportSnapshotFile",
    "getNotionExportBatch",
    "importSharedSnapshot",
    "buildLocalExtensionMigrationBundle",
    "buildLocalExtensionMigrationDownload",
    "stageLocalExtensionMigrationBundle",
    "stageLocalExtensionMigrationFile",
    "restoreStagedLocalExtensionMigrationBundle",
    "restoreLocalExtensionMigrationBundle",
    "mergeBackupSnapshot",
    "mergeBackupSnapshotFile",
    "filterExistingItemIds",
    "deleteAllData",
  ];

  for (const type of internalDbManagerMethods) {
    expect(isInternalOnlyOffscreenCall({ service: "dbManager", type })).toBe(true);
  }
  expect(isInternalOnlyOffscreenCall({ service: "dbManager", type: "getAllFolders" })).toBe(false);
});

test("ordinary privileged editor operations remain search-page scoped", () => {
  expect(isSearchOnlyOffscreenCall({ service: "spaces", type: "unlockSpace" })).toBe(true);
  expect(isSearchOnlyOffscreenCall({ service: "items", type: "getByIds" })).toBe(true);
  expect(isSearchOnlyOffscreenCall({ service: "items", type: "getAll" })).toBe(false);
});
