import { expect, test } from "bun:test";
import {
  ARCHIVE_CACHE_STORAGE_KEY,
} from "@src/services/archive-cache";
import {
  ARCHIVE_OUTBOX_STORAGE_KEY,
} from "@src/services/archive-outbox";
import {
  handleArchiveMigrationStorageBridge,
  isArchiveMigrationStorageBridgeSender,
} from "@src/services/archive-migration-storage-bridge";
import {
  LOCAL_DATA_RESET_EPOCH_STORAGE_KEY,
  LOCAL_DATA_RESET_STORAGE_KEY,
} from "@src/services/large-payload-staging";

const createStorage = (initial: Record<string, unknown> = {}) => {
  const values: Record<string, unknown> = structuredClone(initial);
  return {
    values,
    area: {
      async get(keys: string | string[]) {
        const names = Array.isArray(keys) ? keys : [keys];
        return Object.fromEntries(names.map((key) => [key, values[key]]));
      },
      async set(next: Record<string, unknown>) {
        Object.assign(values, structuredClone(next));
      },
      async remove(keys: string | string[]) {
        for (const key of Array.isArray(keys) ? keys : [keys]) delete values[key];
      },
    } as any,
  };
};

test("offscreen archive bridge exposes only normalized migration metadata", async () => {
  const storage = createStorage({
    [ARCHIVE_OUTBOX_STORAGE_KEY]: [{
      id: "job-1",
      itemId: "item-1",
      mode: "upload",
      sourceUrl: "https://example.com/",
      fileName: "archive.html",
      byteSize: 120,
      createdAt: 10,
      updatedAt: 20,
      attempts: 0,
      nextAttemptAt: 10,
    }, { id: "invalid" }],
    [LOCAL_DATA_RESET_STORAGE_KEY]: true,
    [LOCAL_DATA_RESET_EPOCH_STORAGE_KEY]: 42,
  });

  await handleArchiveMigrationStorageBridge({
    operation: "cache-write",
    entries: [{
      itemId: "item-1",
      fileName: "archive.html",
      byteSize: 120,
      mimeType: "text/html",
      updatedAt: 20,
      source: "local",
    }, { itemId: "", fileName: "../invalid", byteSize: -1 }],
  }, storage.area);

  expect(await handleArchiveMigrationStorageBridge(
    { operation: "cache-read" },
    storage.area,
  )).toMatchObject([{ itemId: "item-1", fileName: "archive.html" }]);
  const outbox = await handleArchiveMigrationStorageBridge(
    { operation: "outbox-read" },
    storage.area,
  ) as Array<Record<string, unknown>>;
  expect(outbox).toMatchObject([{
    itemId: "item-1",
    mode: "upload",
    fileName: "archive.html",
    byteSize: 120,
    updatedAt: 20,
  }]);
  expect(outbox[0].id).toBeUndefined();
  expect(outbox[0].sourceUrl).toBeUndefined();
  expect(await handleArchiveMigrationStorageBridge(
    { operation: "reset-state-read" },
    storage.area,
  )).toEqual({ inProgress: true, resetAt: 42 });

  await handleArchiveMigrationStorageBridge({ operation: "cache-clear" }, storage.area);
  await handleArchiveMigrationStorageBridge({ operation: "outbox-clear" }, storage.area);
  expect(storage.values[ARCHIVE_CACHE_STORAGE_KEY]).toBeUndefined();
  expect(storage.values[ARCHIVE_OUTBOX_STORAGE_KEY]).toBeUndefined();
});

test("archive migration storage bridge accepts only the exact offscreen document", () => {
  const runtimeId = "extension-id";
  const offscreenUrl = `chrome-extension://${runtimeId}/src/pages/offscreen/offscreen.html`;

  expect(isArchiveMigrationStorageBridgeSender({
    id: runtimeId,
    url: offscreenUrl,
  }, runtimeId, offscreenUrl)).toBe(true);
  expect(isArchiveMigrationStorageBridgeSender({
    id: runtimeId,
    url: `chrome-extension://${runtimeId}/src/pages/search/index.html`,
  }, runtimeId, offscreenUrl)).toBe(false);
  expect(isArchiveMigrationStorageBridgeSender({
    id: runtimeId,
    url: offscreenUrl,
    tab: { id: 1 } as chrome.tabs.Tab,
  }, runtimeId, offscreenUrl)).toBe(false);
  expect(isArchiveMigrationStorageBridgeSender({
    id: "another-extension",
    url: offscreenUrl,
  }, runtimeId, offscreenUrl)).toBe(false);
});

test("archive migration storage bridge rejects unlisted operations", async () => {
  const storage = createStorage();
  await expect(handleArchiveMigrationStorageBridge(
    { operation: "read-everything" as never },
    storage.area,
  )).rejects.toThrow("ARCHIVE_MIGRATION_STORAGE_OPERATION_INVALID");
});
