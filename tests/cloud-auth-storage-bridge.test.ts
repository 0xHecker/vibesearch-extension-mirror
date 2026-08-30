import { expect, test } from "bun:test";
import { CLOUD_SYNC_TOKEN_KEY } from "@src/services/cloud-config";
import {
  CLOUD_AUTH_EXPIRES_AT_KEY,
  CLOUD_AUTH_OPT_IN_KEY,
  CLOUD_AUTH_PROFILE_KEY,
  handleCloudAuthStorageBridge,
  isCloudAuthStorageBridgeSender,
} from "@src/services/cloud-auth-storage-bridge";

const createStorage = (initial: Record<string, unknown> = {}) => {
  const values = structuredClone(initial);
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
    } as Pick<chrome.storage.LocalStorageArea, "get" | "set" | "remove">,
  };
};

test("offscreen cloud auth bridge persists only the bounded auth rows", async () => {
  const storage = createStorage();
  const profile = {
    uid: "user-1",
    name: "User",
    email: "user@example.com",
    photoURL: null,
  };

  await handleCloudAuthStorageBridge({
    operation: "set",
    values: {
      [CLOUD_SYNC_TOKEN_KEY]: "firebase-token",
      [CLOUD_AUTH_EXPIRES_AT_KEY]: 1234,
      [CLOUD_AUTH_PROFILE_KEY]: profile,
      [CLOUD_AUTH_OPT_IN_KEY]: true,
    },
  }, storage.area);

  expect(await handleCloudAuthStorageBridge({
    operation: "get",
    keys: [
      CLOUD_SYNC_TOKEN_KEY,
      CLOUD_AUTH_EXPIRES_AT_KEY,
      CLOUD_AUTH_PROFILE_KEY,
      CLOUD_AUTH_OPT_IN_KEY,
    ],
  }, storage.area)).toEqual({
    [CLOUD_SYNC_TOKEN_KEY]: "firebase-token",
    [CLOUD_AUTH_EXPIRES_AT_KEY]: 1234,
    [CLOUD_AUTH_PROFILE_KEY]: profile,
    [CLOUD_AUTH_OPT_IN_KEY]: true,
  });

  await handleCloudAuthStorageBridge({
    operation: "remove",
    keys: [CLOUD_SYNC_TOKEN_KEY, CLOUD_AUTH_EXPIRES_AT_KEY],
  }, storage.area);
  expect(storage.values[CLOUD_SYNC_TOKEN_KEY]).toBeUndefined();
  expect(storage.values[CLOUD_AUTH_EXPIRES_AT_KEY]).toBeUndefined();
  expect(storage.values[CLOUD_AUTH_PROFILE_KEY]).toEqual(profile);
});

test("offscreen cloud auth bridge rejects unrelated and oversized storage", async () => {
  const storage = createStorage();

  await expect(handleCloudAuthStorageBridge({
    operation: "get",
    keys: "unrelated-setting",
  }, storage.area)).rejects.toThrow("CLOUD_AUTH_STORAGE_KEYS_INVALID");
  await expect(handleCloudAuthStorageBridge({
    operation: "set",
    values: { [CLOUD_SYNC_TOKEN_KEY]: "x".repeat(70 * 1024) },
  }, storage.area)).rejects.toThrow("CLOUD_AUTH_STORAGE_VALUES_TOO_LARGE");
  await expect(handleCloudAuthStorageBridge({
    operation: "everything" as never,
  }, storage.area)).rejects.toThrow("CLOUD_AUTH_STORAGE_OPERATION_INVALID");
});

test("cloud auth storage bridge accepts only the exact offscreen document", () => {
  const runtimeId = "extension-id";
  const offscreenUrl = `chrome-extension://${runtimeId}/src/pages/offscreen/offscreen.html`;

  expect(isCloudAuthStorageBridgeSender({ id: runtimeId, url: offscreenUrl }, runtimeId, offscreenUrl)).toBe(true);
  expect(isCloudAuthStorageBridgeSender({
    id: runtimeId,
    url: `chrome-extension://${runtimeId}/src/pages/search/index.html`,
  }, runtimeId, offscreenUrl)).toBe(false);
  expect(isCloudAuthStorageBridgeSender({
    id: runtimeId,
    url: offscreenUrl,
    tab: { id: 1 } as chrome.tabs.Tab,
  }, runtimeId, offscreenUrl)).toBe(false);
  expect(isCloudAuthStorageBridgeSender({ id: "other", url: offscreenUrl }, runtimeId, offscreenUrl)).toBe(false);
});
