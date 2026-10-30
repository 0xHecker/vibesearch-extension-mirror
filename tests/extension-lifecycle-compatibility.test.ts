import { afterAll, expect, mock, test } from "bun:test";
import { EXTENSION_POLICY_KEY } from "../src/services/extension-policy";

const noop = async () => {};
const alarms = new Map<string, unknown>();
const sent: unknown[] = [];
const storage = new Map<string, unknown>();
let bookmarkResyncs = 0;
function event<T extends (...args: never[]) => unknown>() {
  const listeners: T[] = [];
  return { listeners, addListener: (listener: T) => listeners.push(listener) };
}
const onChanged = event<(changes: Record<string, chrome.storage.StorageChange>, area: string) => void>();
const onAlarm = event<(alarm: chrome.alarms.Alarm) => void>();
const originalChrome = Object.getOwnPropertyDescriptor(globalThis, "chrome");
const originalListener = Object.getOwnPropertyDescriptor(globalThis, "addEventListener");
Object.defineProperty(globalThis, "chrome", { configurable: true, value: {
  storage: { local: { get: async (key: string) => ({ [key]: storage.get(key) }) }, onChanged },
  alarms: { create: (name: string, options: unknown) => alarms.set(name, options), clear: async (name: string) => alarms.delete(name), getAll: async () => Array.from(alarms.keys(), name => ({ name, scheduledTime: 0 })), onAlarm },
  runtime: { onInstalled: event<() => void>(), onStartup: event<() => void>(), sendMessage: async (message: unknown) => { sent.push(message); } },
  tabs: { onRemoved: event<() => void>(), onCreated: event<() => void>() },
  commands: { onCommand: event<() => void>() },
} });
Object.defineProperty(globalThis, "addEventListener", { configurable: true, value: () => {} });
mock.module("@src/services/metadata-pipeline", () => ({ retryStoredFailedMetadataUrls: noop }));
mock.module("@src/services/offscreen-helper", () => ({ setupOffscreenDocument: noop }));
mock.module("@src/services/browser-bookmark-events", () => ({ registerBrowserBookmarkEvents: () => {} }));
mock.module("@src/services/cloud-sync", () => ({ CLOUD_SYNC_TOKEN_KEY: "vibesearch_cloud_sync_token_v1" }));
mock.module("@src/services/connectors/registry", () => ({
  CONNECTOR_SYNC_ALARM: "connector-sync", CONNECTOR_CONTINUATION_ALARM: "connector-continuation", onConnectorAlarm: noop,
  setupConnectorScheduler: async () => { alarms.set("connector-sync", {}); },
}));
mock.module("@src/services/large-payload-staging", () => ({ cleanupStagedPayloads: noop }));
mock.module("@src/workers/background/archive-orchestrator", () => ({ ARCHIVE_OUTBOX_RETRY_ALARM_NAME: "archive-retry", cleanupArchiveData: noop, reconcileArchivedItemsWithDatabase: noop, triggerArchiveOutboxDrain: noop }));
mock.module("@src/services/archive-outbox", () => ({ ARCHIVE_OUTBOX_ALARM_NAME: "archive-outbox-alarm" }));
mock.module("@src/workers/background/cloud-sync-orchestrator", () => ({ CLOUD_SYNC_CONTINUATION_ALARM_NAME: "cloud-continuation", triggerCloudSync: noop }));
mock.module("@src/workers/background/context-menus", () => ({ scheduleContextMenuRefresh: () => {} }));
mock.module("@src/workers/background/import-context", () => ({ collectContextFromTab: () => ({}), forgetHoverSaveTarget: () => {}, getActiveTab: noop }));
mock.module("@src/workers/background/import-actions", () => ({ runTargetAction: noop }));
mock.module("@src/workers/background/metadata-retry", () => ({ retryPendingLocalMetadataUrls: noop }));
mock.module("@src/workers/background/opfs-media-maintenance", () => ({ OPFS_MEDIA_RECONCILE_CONTINUATION_ALARM_NAME: "opfs-reconcile", reconcileOrphanedOpfsMedia: noop, triggerOpfsPromotion: noop }));

const { registerBackgroundLifecycle } = await import("../src/workers/background/lifecycle-events");
const flush = async () => { for (let index = 0; index < 80; index++) await Promise.resolve(); };
const browserPolicy = { version: 1, mode: "legacy-browser", legacyCloudEnabled: true };
const localPolicy = { version: 1, mode: "local-only", legacyCloudEnabled: false };

test("browser background jobs recover on worker startup and after returning from local mode", async () => {
  storage.set(EXTENSION_POLICY_KEY, browserPolicy);
  registerBackgroundLifecycle({
    recoverInterruptedLocalDataReset: async () => false,
    requestBrowserBookmarkResync: () => { bookmarkResyncs++; },
    onBrowserBookmarkImportBegan: noop, onBrowserBookmarkImportEnded: noop,
    onBrowserBookmarkResyncAlarm: noop, refreshConnectorCloudAuth: noop,
  });
  await flush();
  const expected = ["cloud-sync-alarm", "metadata-retry-alarm", "embedding-alarm", "vector-sync-alarm", "archive-outbox-alarm", "opfs-promote-alarm", "connector-sync"];
  for (const name of expected) expect(alarms.has(name)).toBe(true);

  alarms.set("cloud-sync-alarm", { when: 123 });
  for (const listener of onChanged.listeners) listener({ [EXTENSION_POLICY_KEY]: { oldValue: browserPolicy, newValue: browserPolicy } }, "local");
  await flush();
  expect(alarms.get("cloud-sync-alarm")).toEqual({ when: 123 });

  storage.set(EXTENSION_POLICY_KEY, localPolicy);
  for (const listener of onChanged.listeners) listener({ [EXTENSION_POLICY_KEY]: { oldValue: browserPolicy, newValue: localPolicy } }, "local");
  await flush();
  for (const name of expected) expect(alarms.has(name)).toBe(false);
  sent.length = 0;
  for (const listener of onAlarm.listeners) listener({ name: "embedding-alarm", scheduledTime: 0, periodInMinutes: 5 });
  await flush();
  expect(sent).toHaveLength(0);

  storage.set(EXTENSION_POLICY_KEY, browserPolicy);
  for (const listener of onChanged.listeners) listener({ [EXTENSION_POLICY_KEY]: { oldValue: localPolicy, newValue: browserPolicy } }, "local");
  await flush();
  for (const name of expected) expect(alarms.has(name)).toBe(true);
  expect(bookmarkResyncs).toBeGreaterThan(0);
  sent.length = 0;
  for (const listener of onAlarm.listeners) listener({ name: "embedding-alarm", scheduledTime: 0, periodInMinutes: 5 });
  await flush();
  expect(sent).toContainEqual({ type: "TRIGGER_EMBEDDING", target: "offscreen", isForwarded: true });
});

afterAll(() => {
  if (originalChrome) Object.defineProperty(globalThis, "chrome", originalChrome); else Reflect.deleteProperty(globalThis, "chrome");
  if (originalListener) Object.defineProperty(globalThis, "addEventListener", originalListener); else Reflect.deleteProperty(globalThis, "addEventListener");
});
