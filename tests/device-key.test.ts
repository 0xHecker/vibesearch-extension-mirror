import { beforeEach, expect, test } from "bun:test";

type StorageRow = Record<string, unknown>;
const backing = new Map<string, unknown>();

const chromeMock = {
  storage: {
    local: {
      get: async (keys: string | string[]) => {
        const out: StorageRow = {};
        for (const key of Array.isArray(keys) ? keys : [keys]) {
          if (backing.has(key)) out[key] = backing.get(key);
        }
        return out;
      },
      set: async (values: StorageRow) => {
        for (const [key, value] of Object.entries(values)) backing.set(key, value);
      },
      remove: async (keys: string | string[]) => {
        for (const key of Array.isArray(keys) ? keys : [keys]) backing.delete(key);
      },
    },
  },
};

// @ts-expect-error test global
globalThis.chrome = chromeMock;

const { getArchiveDeviceKey, resetArchiveDeviceKeyForTests } = await import(
  "@src/services/device-key"
);

beforeEach(async () => {
  backing.clear();
  await resetArchiveDeviceKeyForTests();
});

test("device key is generated once and then stable across reads", async () => {
  const first = await getArchiveDeviceKey();
  expect(first).toHaveLength(43);
  expect(first).toMatch(/^[A-Za-z0-9_-]{43}$/);
  expect(await getArchiveDeviceKey()).toBe(first);
  expect(backing.get("vibesearch:archiveDeviceKey")).toBe(first);
});

test("a persisted key survives without regeneration", async () => {
  backing.set("vibesearch:archiveDeviceKey", "existing-key-from-storage");
  expect(await getArchiveDeviceKey()).toBe("existing-key-from-storage");
});

test("storage failures still return a usable in-memory key", async () => {
  backing.clear();
  const broken = {
    storage: {
      local: {
        get: async () => {
          throw new Error("storage unavailable");
        },
        set: async () => {
          throw new Error("storage unavailable");
        },
        remove: async () => {},
      },
    },
  };
  // @ts-expect-error test global
  globalThis.chrome = broken;
  try {
    const key = await getArchiveDeviceKey();
    expect(key).toHaveLength(43);
  } finally {
    // @ts-expect-error test global
    globalThis.chrome = chromeMock;
  }
});
