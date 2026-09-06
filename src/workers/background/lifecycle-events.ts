import { OPEN_ON_NEW_TAB_STORAGE_KEY } from "@src/common/new-tab-pref";
import { PUBLIC_SPACE_ID } from "@src/common/spaces";
import { retryStoredFailedMetadataUrls } from "@src/services/metadata-pipeline";
import { setupOffscreenDocument } from "@src/services/offscreen-helper";
import { BROWSER_BOOKMARK_RESYNC_ALARM_NAME } from "@src/services/browser-bookmark-resync";
import { registerBrowserBookmarkEvents } from "@src/services/browser-bookmark-events";
import { CLOUD_SYNC_TOKEN_KEY } from "@src/services/cloud-sync";
import {
  CONNECTOR_CONTINUATION_ALARM,
  CONNECTOR_SYNC_ALARM,
  onConnectorAlarm,
  setupConnectorScheduler,
} from "@src/services/connectors/registry";
import { cleanupStagedPayloads } from "@src/services/large-payload-staging";
import {
  ARCHIVE_OUTBOX_RETRY_ALARM_NAME,
  cleanupArchiveData,
  reconcileArchivedItemsWithDatabase,
  triggerArchiveOutboxDrain,
} from "@src/workers/background/archive-orchestrator";
import { ARCHIVE_OUTBOX_ALARM_NAME } from "@src/services/archive-outbox";
import {
  CLOUD_SYNC_CONTINUATION_ALARM_NAME,
  triggerCloudSync,
} from "@src/workers/background/cloud-sync-orchestrator";
import { scheduleContextMenuRefresh } from "@src/workers/background/context-menus";
import {
  collectContextFromTab,
  forgetHoverSaveTarget,
  getActiveTab,
} from "@src/workers/background/import-context";
import { runTargetAction } from "@src/workers/background/import-actions";
import { retryPendingLocalMetadataUrls } from "@src/workers/background/metadata-retry";
import {
  OPFS_MEDIA_RECONCILE_CONTINUATION_ALARM_NAME,
  reconcileOrphanedOpfsMedia,
  triggerOpfsPromotion,
} from "@src/workers/background/opfs-media-maintenance";

const SYNC_ALARM_NAME = "vector-sync-alarm";
const CLOUD_SYNC_ALARM_NAME = "cloud-sync-alarm";
const EMBEDDING_ALARM_NAME = "embedding-alarm";
const METADATA_RETRY_ALARM_NAME = "metadata-retry-alarm";

type BackgroundLifecycleDependencies = {
  recoverInterruptedLocalDataReset: () => Promise<boolean>;
  requestBrowserBookmarkResync: () => void;
  onBrowserBookmarkImportBegan: () => Promise<void>;
  onBrowserBookmarkImportEnded: () => Promise<void>;
  onBrowserBookmarkResyncAlarm: () => Promise<void>;
  refreshConnectorCloudAuth: () => Promise<void>;
};

export const registerBackgroundLifecycle = (
  dependencies: BackgroundLifecycleDependencies,
): void => {
  chrome.runtime.onInstalled.addListener((details) => {
    chrome.alarms.create(SYNC_ALARM_NAME, { periodInMinutes: 6 * 60 });
    chrome.alarms.create(CLOUD_SYNC_ALARM_NAME, { periodInMinutes: 15 });
    chrome.alarms.create(EMBEDDING_ALARM_NAME, { periodInMinutes: 5 });
    chrome.alarms.create(METADATA_RETRY_ALARM_NAME, { periodInMinutes: 30 });
    void setupConnectorScheduler();
    chrome.alarms.create(ARCHIVE_OUTBOX_ALARM_NAME, { periodInMinutes: 10 });
    void retryStoredFailedMetadataUrls().catch(() => {});
    void retryPendingLocalMetadataUrls().catch(() => {});
    if (details.reason !== "install")
      dependencies.requestBrowserBookmarkResync();
    scheduleContextMenuRefresh("high");
  });

  chrome.runtime.onStartup.addListener(() => {
    void (async () => {
      if (await dependencies.recoverInterruptedLocalDataReset()) return;
      await setupOffscreenDocument();
      await chrome.runtime.sendMessage({
        type: "TRIGGER_EMBEDDING",
        target: "offscreen",
        isForwarded: true,
      });
      await retryStoredFailedMetadataUrls();
      await retryPendingLocalMetadataUrls();
      await triggerCloudSync();
      await cleanupArchiveData();
      await reconcileOrphanedOpfsMedia();
      await reconcileArchivedItemsWithDatabase();
      await triggerArchiveOutboxDrain();
      dependencies.requestBrowserBookmarkResync();
    })().catch(() => {});
    scheduleContextMenuRefresh("high");
  });

  const onBrowserBookmarkMutation = () => {
    dependencies.requestBrowserBookmarkResync();
  };

  registerBrowserBookmarkEvents({
    onMutation: onBrowserBookmarkMutation,
    onImportBegan: () => {
      void dependencies.onBrowserBookmarkImportBegan();
    },
    onImportEnded: () => {
      void dependencies.onBrowserBookmarkImportEnded();
    },
  });

  chrome.alarms.onAlarm.addListener((alarm) => {
    void (async () => {
      if (alarm.name === BROWSER_BOOKMARK_RESYNC_ALARM_NAME) {
        await dependencies.onBrowserBookmarkResyncAlarm();
        return;
      }
      await setupOffscreenDocument();
      if (alarm.name === SYNC_ALARM_NAME) {
        await chrome.runtime.sendMessage({
          service: "sync",
          type: "rebuildAndCompact",
          target: "offscreen",
          isForwarded: true,
        });
      } else if (alarm.name === CLOUD_SYNC_ALARM_NAME) {
        await triggerCloudSync();
      } else if (alarm.name === CLOUD_SYNC_CONTINUATION_ALARM_NAME) {
        await triggerCloudSync();
      } else if (alarm.name === EMBEDDING_ALARM_NAME) {
        await chrome.runtime.sendMessage({
          type: "TRIGGER_EMBEDDING",
          target: "offscreen",
          isForwarded: true,
        });
      } else if (alarm.name === METADATA_RETRY_ALARM_NAME) {
        await retryStoredFailedMetadataUrls();
        await retryPendingLocalMetadataUrls();
      } else if (
        alarm.name === ARCHIVE_OUTBOX_ALARM_NAME ||
        alarm.name === ARCHIVE_OUTBOX_RETRY_ALARM_NAME
      ) {
        await reconcileArchivedItemsWithDatabase();
        await triggerArchiveOutboxDrain();
      } else if (
        alarm.name === CONNECTOR_SYNC_ALARM ||
        alarm.name === CONNECTOR_CONTINUATION_ALARM
      ) {
        await dependencies.refreshConnectorCloudAuth();
        await onConnectorAlarm();
      } else if (alarm.name === "opfs-promote-alarm") {
        await Promise.allSettled([
          triggerOpfsPromotion(),
          reconcileOrphanedOpfsMedia(),
        ]);
      } else if (alarm.name === OPFS_MEDIA_RECONCILE_CONTINUATION_ALARM_NAME) {
        await reconcileOrphanedOpfsMedia();
      }
    })().catch(() => {});
  });

  // Attempt repair and promotion on startup. An interrupted user-requested wipe
  // takes precedence over every sync/import path and is completed before any of
  // them are allowed to start.
  void (async () => {
    if (await dependencies.recoverInterruptedLocalDataReset()) return;
    void triggerOpfsPromotion();
    void triggerCloudSync();
    await setupOffscreenDocument();
    // Staged files can contain a full library, so do not let unrelated cache
    // repair failures prevent their expiry cleanup.
    await Promise.allSettled([
      cleanupArchiveData(),
      cleanupStagedPayloads(),
      reconcileOrphanedOpfsMedia(),
    ]);
    await reconcileArchivedItemsWithDatabase();
    await triggerArchiveOutboxDrain();
  })().catch(() => {});

  // Service workers receive the same online event through their global scope.
  globalThis.addEventListener("online", () => {
    void triggerOpfsPromotion();
    void triggerCloudSync();
    void triggerArchiveOutboxDrain();
  });

  chrome.alarms.create("opfs-promote-alarm", { periodInMinutes: 30 });
  chrome.alarms.create(ARCHIVE_OUTBOX_ALARM_NAME, { periodInMinutes: 10 });

  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName === "local" && changes[CLOUD_SYNC_TOKEN_KEY]?.newValue) {
      void triggerArchiveOutboxDrain();
    }
  });

  chrome.tabs.onRemoved.addListener((tabId) => {
    forgetHoverSaveTarget(tabId);
  });

  // Open VibeSearch on the new-tab page when enabled (Settings → Misc). A
  // background redirect (not a manifest override) keeps the native new tab when
  // the option is off.
  chrome.tabs.onCreated.addListener((tab) => {
    try {
      const url = tab.pendingUrl || tab.url || "";
      if (!/^chrome:\/\/newtab\/?$/.test(url)) return;
      const tabId = tab.id;
      if (tabId === undefined) return;
      chrome.storage.local.get(OPEN_ON_NEW_TAB_STORAGE_KEY, (result) => {
        if (result?.[OPEN_ON_NEW_TAB_STORAGE_KEY] !== true) return;
        void chrome.tabs.update(tabId, {
          url: chrome.runtime.getURL("src/pages/search/index.html"),
        });
      });
    } catch {}
  });

  // Keyboard command shortcuts (Settings → Shortcuts). Reuse the same actions the
  // context menu uses so behavior stays identical.
  if (chrome.commands?.onCommand) {
    chrome.commands.onCommand.addListener((command) => {
      void (async () => {
        if (command === "quick-save") {
          const tab = await getActiveTab();
          await runTargetAction(
            { mode: "save", spaceId: PUBLIC_SPACE_ID },
            collectContextFromTab(tab),
            tab,
          );
        } else if (command === "take-screenshot") {
          const tab = await getActiveTab();
          await runTargetAction(
            { mode: "shot", spaceId: PUBLIC_SPACE_ID },
            collectContextFromTab(tab),
            tab,
          );
        }
      })().catch((error) => {
        console.error("[background] command failed:", command, error);
      });
    });
  }
};
