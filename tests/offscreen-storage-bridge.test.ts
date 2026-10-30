import { afterEach, beforeEach, expect, test } from "bun:test";
import { CLOUD_SYNC_API_BASE_KEY } from "@src/services/cloud-config";
import {
  CLOUD_PULL_ENABLED_KEY, CLOUD_SYNC_CLIENT_ID_KEY, CLOUD_SYNC_PULL_STATE_KEY,
  CLOUD_SYNC_QUEUE_KEY,
} from "@src/services/cloud-sync/model";
import {
  clearCloudPullState, getApiBase, getClientId, isCloudPullEnabled, readPullState,
  readQueue, removeQueueRefs, setCloudPullEnabled, writePullState, writeQueue,
} from "@src/services/cloud-sync/runtime";
import {
  OFFSCREEN_STORAGE_BRIDGE_MESSAGE, handleOffscreenStorageBridge,
  runtimeOffscreenStorage, COMPANION_IMPORT_KEY, EMBEDDING_TEXT_VERSION_KEY, EMBEDDING_STATE_REPAIR_KEY,
} from "@src/services/offscreen-storage-bridge";

let previousChrome: PropertyDescriptor | undefined;
beforeEach(() => { previousChrome = Object.getOwnPropertyDescriptor(globalThis, "chrome"); });
afterEach(() => {
  if (previousChrome) Object.defineProperty(globalThis, "chrome", previousChrome);
  else Reflect.deleteProperty(globalThis, "chrome");
});

function fixture() {
  const values: Record<string, unknown> = {};
  const area = {
    async get(key: string) { return key in values ? { [key]: structuredClone(values[key]) } : {}; },
    async set(entries: Record<string, unknown>) { Object.assign(values, structuredClone(entries)); },
    async remove(key: string) { delete values[key]; },
  } as Pick<chrome.storage.LocalStorageArea, "get" | "set" | "remove">;
  const messages: Array<{ target: string; type: string; payload: unknown }> = [];
  Object.defineProperty(globalThis, "chrome", { configurable: true, value: {
    runtime: {
      async sendMessage(message: typeof messages[number]) {
        messages.push(message);
        expect(message.target).toBe("background");
        expect(message.type).toBe(OFFSCREEN_STORAGE_BRIDGE_MESSAGE);
        const payload = await handleOffscreenStorageBridge(JSON.parse(JSON.stringify(message.payload)), area);
        return { success: true, payload: JSON.parse(JSON.stringify(payload)) };
      },
    },
  } });
  return { values, area, messages };
}

test("offscreen relay persists its five sync rows and three migration/repair rows while rejecting unrelated operations", async () => {
  const f = fixture();
  for (const key of [CLOUD_SYNC_QUEUE_KEY, CLOUD_SYNC_CLIENT_ID_KEY, CLOUD_SYNC_PULL_STATE_KEY, CLOUD_PULL_ENABLED_KEY, CLOUD_SYNC_API_BASE_KEY, COMPANION_IMPORT_KEY, EMBEDDING_TEXT_VERSION_KEY, EMBEDDING_STATE_REPAIR_KEY]) {
    await handleOffscreenStorageBridge({ operation: "set", key, value: "synthetic" }, f.area);
    expect(await handleOffscreenStorageBridge({ operation: "get", key }, f.area)).toEqual({ [key]: "synthetic" });
    await handleOffscreenStorageBridge({ operation: "remove", key }, f.area);
    expect(await handleOffscreenStorageBridge({ operation: "get", key }, f.area)).toEqual({});
  }
  for (const key of ["vibesearch:firebaseIdToken", "vibesearch.extension-policy.v1", "unrelated-setting"]) {
    await expect(handleOffscreenStorageBridge({ operation: "set", key, value: "forbidden" }, f.area)).rejects.toThrow();
    await expect(runtimeOffscreenStorage.get(key)).rejects.toThrow();
  }
  await expect(handleOffscreenStorageBridge({ operation: "clear" }, f.area)).rejects.toThrow();
  await expect(handleOffscreenStorageBridge({ operation: "get", key: CLOUD_SYNC_QUEUE_KEY, otherKey: "extra" }, f.area)).rejects.toThrow();
  expect(f.values).toEqual({});
});

test("real sync runtime preserves durable queue, destination, device ID and account pull state without chrome.storage", async () => {
  const f = fixture();
  const ref = { collection: "items" as const, id: "pending", updatedAt: 1, deletedAt: 0, queuedAt: 1 };
  f.values[CLOUD_SYNC_API_BASE_KEY] = "https://synthetic-api.example/";
  await writeQueue([ref]);
  expect((await readQueue()).map(row => row.id)).toEqual(["pending"]);
  expect(await getApiBase()).toBe("https://synthetic-api.example");
  const clientId = await getClientId();
  expect(clientId).toMatch(/^[0-9a-f-]{36}$/u);
  expect(await getClientId()).toBe(clientId);
  expect(f.values[CLOUD_SYNC_CLIENT_ID_KEY]).toBe(clientId);
  await setCloudPullEnabled(true);
  expect(await isCloudPullEnabled()).toBe(true);
  await writePullState({ checkpoint: 23, bootstrapCursor: "cursor", userId: "account-one" });
  expect(await readPullState("account-one")).toEqual({ checkpoint: 23, bootstrapCursor: "cursor", userId: "account-one" });
  expect(await readPullState("account-two")).toEqual({ checkpoint: 0, userId: "account-two" });
  await clearCloudPullState();
  expect(f.values[CLOUD_SYNC_PULL_STATE_KEY]).toEqual({ checkpoint: 0 });
  expect((await readQueue()).map(row => row.id)).toEqual(["pending"]);
  await removeQueueRefs([ref]);
  expect(await readQueue()).toEqual([]);
});

test("unavailable or malformed sync storage authority never turns a read into an empty queue or production destination", async () => {
  for (const reply of [undefined, { success: false, error: "STORAGE_UNAVAILABLE" }, { success: true }, { success: true, payload: null }]) {
    Object.defineProperty(globalThis, "chrome", { configurable: true, value: { runtime: { sendMessage: async () => reply } } });
    await expect(readQueue()).rejects.toThrow();
    await expect(getApiBase()).rejects.toThrow();
  }
  Object.defineProperty(globalThis, "chrome", { configurable: true, value: {
    runtime: { sendMessage: async () => { throw new Error("BACKGROUND_UNAVAILABLE"); } },
  } });
  await expect(writeQueue([])).rejects.toThrow("BACKGROUND_UNAVAILABLE");
  await expect(setCloudPullEnabled(true)).rejects.toThrow("BACKGROUND_UNAVAILABLE");
});
