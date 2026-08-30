import { expect, test } from "bun:test";
import {
  ArchiveCache,
  type ArchiveCacheEntry,
  type ArchiveCacheFiles,
  type ArchiveCacheStorage,
} from "@src/services/archive-cache";

class MemoryStorage implements ArchiveCacheStorage {
  value: unknown = [];

  async read() {
    return structuredClone(this.value);
  }

  async write(entries: ArchiveCacheEntry[]) {
    this.value = structuredClone(entries);
  }

  async clear() {
    this.value = [];
  }
}

class MemoryFiles implements ArchiveCacheFiles {
  files = new Map<string, Blob>();
  deleted: string[] = [];

  async write(fileName: string, body: Blob) {
    this.files.set(fileName, body);
  }

  async read(fileName: string) {
    return this.files.get(fileName) ?? null;
  }

  async delete(fileName: string) {
    this.deleted.push(fileName);
    this.files.delete(fileName);
  }

  async cleanup(keep: Set<string>) {
    for (const name of this.files.keys()) {
      if (!keep.has(name)) this.files.delete(name);
    }
  }

  async clear() {
    this.files.clear();
  }
}

const createHarness = (options: {
  maxDiskBytes?: number;
  maxEntries?: number;
  readResetState?: () => Promise<{ inProgress: boolean; resetAt: number }>;
} = {}) => {
  const storage = new MemoryStorage();
  const files = new MemoryFiles();
  let now = 1_000;
  let id = 0;
  const cache = new ArchiveCache({
    storage,
    files,
    now: () => now,
    randomId: () => `archive-${++id}`,
    maxDiskBytes: options.maxDiskBytes,
    maxEntries: options.maxEntries,
    readResetState: options.readResetState,
  });
  return {
    cache,
    files,
    storage,
    get now() {
      return now;
    },
    set now(value: number) {
      now = value;
    },
  };
};

const deferred = <T,>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
};

test("archive cache keeps a successful snapshot readable after the network is gone", async () => {
  const harness = createHarness();
  const original = new Blob(["<html>offline archive</html>"], { type: "text/html" });

  await harness.cache.put("item-1", original);
  const cached = await harness.cache.get("item-1");

  expect(await cached?.text()).toBe("<html>offline archive</html>");
  expect(await harness.cache.list()).toMatchObject([
    { itemId: "item-1", byteSize: original.size, mimeType: "text/html", updatedAt: 1_000 },
  ]);
});

test("archive cache preserves the full shared opaque item identity", async () => {
  const harness = createHarness();
  const itemId = ` item/${"x".repeat(480)} `;
  const archive = new Blob(["<html>opaque identity</html>"], { type: "text/html" });

  await harness.cache.put(itemId, archive);

  expect(await (await harness.cache.get(itemId))?.text()).toBe("<html>opaque identity</html>");
  expect(await harness.cache.list()).toMatchObject([{ itemId }]);
});

test("archive cache replaces an item's older bytes without leaking the old file", async () => {
  const harness = createHarness();
  await harness.cache.put("item-1", new Blob(["old"]));
  const [oldEntry] = await harness.cache.list();
  harness.now += 1;

  await harness.cache.put("item-1", new Blob(["new snapshot"]));

  expect(await (await harness.cache.get("item-1"))?.text()).toBe("new snapshot");
  expect(await harness.cache.list()).toHaveLength(1);
  expect(harness.files.files.has(oldEntry.fileName)).toBe(false);
});

test("archive cache evicts oldest entries within a strict disk budget", async () => {
  const harness = createHarness({ maxDiskBytes: 10 });
  await harness.cache.put("old", new Blob(["123456"]));
  harness.now += 1;
  await harness.cache.put("new", new Blob(["abcdef"]));

  expect((await harness.cache.list()).map((entry) => entry.itemId)).toEqual(["new"]);
  expect(await harness.cache.get("old")).toBeNull();
  expect(await (await harness.cache.get("new"))?.text()).toBe("abcdef");
});

test("archive cache backup enumeration returns only verified files", async () => {
  const harness = createHarness();
  await harness.cache.put("item-1", new Blob(["one"], { type: "text/html" }));
  await harness.cache.put("item-2", new Blob(["two"], { type: "text/html" }));
  const entries = await harness.cache.list();
  harness.files.files.delete(entries.find((entry) => entry.itemId === "item-1")!.fileName);

  const files = await harness.cache.listFiles();

  expect(files.map(({ entry }) => entry.itemId)).toEqual(["item-2"]);
  expect(await files[0].file.text()).toBe("two");
});

test("archive cache startup cleanup drops missing index rows and orphan files", async () => {
  const harness = createHarness();
  await harness.cache.put("item-1", new Blob(["one"], { type: "text/html" }));
  await harness.cache.put("item-2", new Blob(["two"], { type: "text/html" }));
  const entries = await harness.cache.list();
  const missing = entries.find((entry) => entry.itemId === "item-1")!;
  harness.files.files.delete(missing.fileName);
  harness.files.files.set("orphan.html", new Blob(["orphan"]));

  await harness.cache.cleanup();

  expect((await harness.cache.list()).map((entry) => entry.itemId)).toEqual(["item-2"]);
  expect(harness.files.files.has("orphan.html")).toBe(false);
});

test("archive cache never lets an older or cache-fill write replace a newer capture", async () => {
  const harness = createHarness();
  await harness.cache.put("item-1", new Blob(["new capture"]), 2_000);

  await harness.cache.put("item-1", new Blob(["old upload"]), 1_000);
  await harness.cache.putIfAbsent("item-1", new Blob(["cloud fill"]), 3_000);

  expect(await (await harness.cache.get("item-1"))?.text()).toBe("new capture");
  expect(await harness.cache.list()).toMatchObject([{ updatedAt: 2_000 }]);
});

test("a stale cache read cannot delete a newer concurrent capture", async () => {
  const harness = createHarness();
  await harness.cache.put("item-1", new Blob(["old capture"]), 1_000);
  const [oldEntry] = await harness.cache.list();
  const readStarted = deferred<void>();
  const releaseOldRead = deferred<void>();
  const originalRead = harness.files.read.bind(harness.files);
  harness.files.read = async (fileName) => {
    if (fileName !== oldEntry.fileName) return originalRead(fileName);
    readStarted.resolve();
    await releaseOldRead.promise;
    return null;
  };

  const staleRead = harness.cache.get("item-1");
  await readStarted.promise;
  await harness.cache.put("item-1", new Blob(["new capture"]), 2_000);
  releaseOldRead.resolve();

  expect(await staleRead).toBeNull();
  expect(await (await harness.cache.get("item-1"))?.text()).toBe("new capture");
  expect(await harness.cache.list()).toMatchObject([{ itemId: "item-1", updatedAt: 2_000 }]);
});

test("startup cleanup preserves its index when OPFS has a transient read failure", async () => {
  const harness = createHarness();
  await harness.cache.put("item-1", new Blob(["durable capture"]), 1_000);
  const before = await harness.cache.list();
  harness.files.read = async () => {
    throw new DOMException("storage temporarily unavailable", "UnknownError");
  };

  await expect(harness.cache.cleanup()).rejects.toMatchObject({ name: "UnknownError" });
  expect(await harness.cache.list()).toEqual(before);
});

test("a missing newer index row cannot discard an older readable upload", async () => {
  const harness = createHarness();
  harness.storage.value = [{
    itemId: "item-1",
    fileName: "missing-newer.html",
    byteSize: 12,
    mimeType: "text/html",
    updatedAt: 2_000,
  }];

  await harness.cache.put("item-1", new Blob(["older but durable"]), 1_000);

  expect(await (await harness.cache.get("item-1"))?.text()).toBe("older but durable");
  expect(await harness.cache.list()).toMatchObject([{ itemId: "item-1", updatedAt: 1_000 }]);
});

test("an acknowledged local upload replaces a later-stamped stale cloud preview", async () => {
  const harness = createHarness();
  await harness.cache.putCloud("item-1", new Blob(["old cloud body"]), 2_000);

  await harness.cache.putWithinMutationLock(
    "item-1",
    new Blob(["new uploaded body"]),
    1_000,
    { source: "local", replaceCloudNewer: true },
  );

  expect(await (await harness.cache.get("item-1"))?.text()).toBe("new uploaded body");
  expect(await harness.cache.list()).toMatchObject([
    { itemId: "item-1", updatedAt: 1_000, source: "local" },
  ]);
});

test("a cloud preview started before delete-all cannot repopulate the cleared cache", async () => {
  const resetState = { inProgress: false, resetAt: 2_000 };
  const harness = createHarness({ readResetState: async () => resetState });

  await expect(
    harness.cache.putCloud("item-1", new Blob(["stale cloud archive"]), 1_999),
  ).rejects.toThrow("LOCAL_DATA_RESET_IN_PROGRESS");

  expect(await harness.cache.list()).toEqual([]);
  expect(harness.files.files.size).toBe(0);
});

test("the durable reset marker blocks every archive cache write", async () => {
  const harness = createHarness({
    readResetState: async () => ({ inProgress: true, resetAt: 2_000 }),
  });

  await expect(
    harness.cache.put("item-1", new Blob(["capture finishing during reset"]), 2_001),
  ).rejects.toThrow("LOCAL_DATA_RESET_IN_PROGRESS");
  expect(harness.files.files.size).toBe(0);
});
