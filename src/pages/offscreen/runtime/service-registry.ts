import type { JsonValue } from "@src/common/json-value";
import { binController } from "@src/services/controllers/bin.controller";
import { foldersController } from "@src/services/controllers/folders.controller";
import { itemsController } from "@src/services/controllers/items.controller";
import { spaceGroupsController } from "@src/services/controllers/space-groups.controller";
import { spacesController } from "@src/services/controllers/spaces.controller";
import { tagsController } from "@src/services/controllers/tags.controller";
import { browserBookmarkImportService } from "@src/services/browser-bookmark-import";
import { cloudAuthService } from "@src/services/cloud-auth";
import {
  clearCloudPullState,
  cloudSyncService,
  isCloudPullEnabled,
  setCloudPullEnabled,
} from "@src/services/cloud-sync";
import { databaseManager } from "@src/services/db-manager";
import { githubStarsImportService } from "@src/services/github-stars-import";
import { OCR_SUPPORTED, ocrService } from "@src/services/ocr.service";
import { OffscreenRouter } from "@src/services/router";
import { syncService } from "@src/services/sync.service";
import { z } from "zod";
import { DatabaseChangePublisher } from "./database-change-publisher";

const extractImageTextSchema = z.object({ url: z.string().default("") });
const pushItemSchema = z.object({ itemId: z.string().default("") });
const pullPreferenceSchema = z.object({ enabled: z.boolean().optional() });
const itemSyncStateSchema = z.object({
  itemIds: z.array(z.string()).default([]),
});
const authStatusSchema = z.object({ refresh: z.boolean().optional() });

function payloadOrEmpty(payload: JsonValue | undefined): JsonValue {
  return payload ?? {};
}

function createOcrController() {
  return {
    async extractImageText(payload: JsonValue | undefined) {
      if (!OCR_SUPPORTED) {
        throw new Error(
          "Local image OCR is unavailable in this browser build.",
        );
      }
      const { url } = extractImageTextSchema.parse(payloadOrEmpty(payload));
      try {
        return await ocrService.processImageUrl(url);
      } finally {
        // This direct request bypasses the OCR queue and owns model cleanup.
        ocrService.scheduleIdleRelease();
      }
    },
  };
}

function createImportControllers(changes: DatabaseChangePublisher) {
  const browserBookmarks = {
    async hasImported() {
      return browserBookmarkImportService.hasImported();
    },
    async importTree(
      payload: Parameters<typeof browserBookmarkImportService.importTree>[0],
    ) {
      return changes.whileSuppressed(() =>
        browserBookmarkImportService.importTree(payload),
      );
    },
  };

  const githubStars = {
    async importStars(
      payload: Parameters<typeof githubStarsImportService.importStars>[0],
    ) {
      return changes.whileSuppressed(() =>
        githubStarsImportService.importStars(payload),
      );
    },
  };

  return { browserBookmarks, githubStars };
}

function createCloudControllers() {
  const cloudSync = {
    async status() {
      return cloudSyncService.status();
    },
    async drain(payload: Parameters<typeof cloudSyncService.drain>[0]) {
      return cloudSyncService.drain(payload);
    },
    async pushItem(payload: JsonValue | undefined) {
      const { itemId } = pushItemSchema.parse(payloadOrEmpty(payload));
      return cloudSyncService.pushItem(itemId);
    },
    async syncAll(payload: Parameters<typeof cloudSyncService.syncAll>[0]) {
      return cloudSyncService.syncAll(payload);
    },
    async pull(payload: Parameters<typeof cloudSyncService.pull>[0]) {
      return cloudSyncService.pull(payload);
    },
    async pullPreference(payload: JsonValue | undefined) {
      const { enabled } = pullPreferenceSchema.parse(payloadOrEmpty(payload));
      if (enabled !== undefined) await setCloudPullEnabled(enabled);
      return { enabled: await isCloudPullEnabled() };
    },
    async itemSyncState(payload: JsonValue | undefined) {
      const { itemIds } = itemSyncStateSchema.parse(payloadOrEmpty(payload));
      return cloudSyncService.itemSyncState(itemIds);
    },
    async cancelAndClear() {
      return cloudSyncService.cancelAndClear();
    },
  };

  const cloudAuth = {
    async status(payload: JsonValue | undefined) {
      return cloudAuthService.status(
        authStatusSchema.parse(payloadOrEmpty(payload)),
      );
    },
    async connect() {
      const status = await cloudAuthService.connect();
      if (status.connected) {
        // A failed anonymous-archive claim retries during the next sync.
        void chrome.runtime
          .sendMessage({ target: "background", type: "ARCHIVE_CLAIM_ANON" })
          .catch(() => undefined);
      }
      return status;
    },
    async disconnect() {
      const status = await cloudAuthService.disconnect();
      await clearCloudPullState().catch(() => undefined);
      await setCloudPullEnabled(false).catch(() => undefined);
      return status;
    },
  };

  return { cloudSync, cloudAuth };
}

/** Register the narrow RPC surface owned by the offscreen document. */
export function registerOffscreenServices(
  changes: DatabaseChangePublisher,
): OffscreenRouter {
  const router = new OffscreenRouter();
  const imports = createImportControllers(changes);
  const cloud = createCloudControllers();

  router.registerService("dbManager", databaseManager, {
    methods: [
      "getAllFolders",
      "getImportTargets",
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
    ],
  });
  router.registerService("browserBookmarks", imports.browserBookmarks, {
    methods: ["hasImported", "importTree"],
  });
  router.registerService("githubStars", imports.githubStars, {
    methods: ["importStars"],
  });
  router.registerService("cloudSync", cloud.cloudSync, {
    methods: [
      "status",
      "drain",
      "pushItem",
      "syncAll",
      "pull",
      "pullPreference",
      "cancelAndClear",
      "itemSyncState",
    ],
  });
  router.registerService("cloudAuth", cloud.cloudAuth, {
    methods: ["status", "connect", "disconnect"],
  });
  router.registerService("sync", syncService, {
    methods: ["rebuildAndCompact"],
  });
  router.registerService("items", itemsController, {
    methods: [
      "saveFetchedMetadata",
      "getByIds",
      "findLiveByUrls",
      "markSearchIndexDirty",
      "queryLocal",
      "addToFolder",
      "addMany",
      "getPendingMetadataUrls",
      "refetchMetadata",
      "moveToSpace",
      "copyToSpace",
      "moveToFolder",
      "reorder",
      "delete",
      "restoreFromBin",
      "deleteForever",
      "update",
      "updateMedia",
      "removeMedia",
      "addMedia",
      "replaceMedia",
      "listItemsWithOpfsMedia",
      "applyOpfsMediaPromotions",
      "deleteUnreferencedOpfsMedia",
      "reconcileOrphanedOpfsItemDirectories",
    ],
  });
  router.registerService("folders", foldersController, {
    methods: [
      "create",
      "getById",
      "setPinned",
      "setLocked",
      "setCollapsed",
      "rename",
      "delete",
      "restoreFromBin",
      "deleteForever",
      "countItemsInTree",
      "reorder",
      "moveToSpace",
      "copyToSpace",
      "moveToParent",
      "mergeInto",
    ],
  });
  router.registerService("bin", binController, { methods: ["listContents"] });
  router.registerService("tags", tagsController, {
    methods: [
      "getTagsForItem",
      "searchTags",
      "addTagToItem",
      "removeTagFromItem",
      "listAllTags",
      "createTag",
      "renameTag",
      "deleteTag",
      "setTagColor",
      "setTagFavorite",
    ],
  });
  router.registerService("spaces", spacesController, {
    methods: [
      "listSpaces",
      "createSpace",
      "renameSpace",
      "setPrivatePassword",
      "unlockSpace",
      "changePrivatePassword",
      "recoverPrivatePassword",
      "lockSpace",
      "touchSpaceActivity",
      "getSpaceAccessState",
      "moveToSpaceGroup",
      "moveToBin",
      "restoreFromBin",
      "listBinSpaces",
      "purgeExpired",
      "deleteSpaceForever",
      "reorderSpaces",
    ],
  });
  router.registerService("spaceGroups", spaceGroupsController, {
    methods: [
      "listSpaceGroups",
      "createSpaceGroup",
      "renameSpaceGroup",
      "setCollapsed",
      "resolveDropSpace",
      "deleteSpaceGroup",
      "reorderSpaceGroups",
    ],
  });
  router.registerService("ocr", createOcrController(), {
    methods: ["extractImageText"],
  });

  router.listen();
  return router;
}
