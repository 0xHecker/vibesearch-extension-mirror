import { expect, test } from "bun:test";
import {
  cloudSyncRefsForDocs,
  CLOUD_SYNC_PUSH_BATCH_MAX,
  CLOUD_SYNC_QUEUE_KEY,
  CLOUD_SYNC_TOKEN_KEY,
  CloudSyncService,
  mergeCloudSyncQueue,
  normalizeCloudDoc,
  removeAcknowledgedQueueRefs,
  selectCloudSyncBatch,
  selectAcknowledgedQueueRefs,
  type CloudSyncQueueRef,
  type CloudSyncChange,
  type CloudSyncCollectionResolver,
} from "@src/services/cloud-sync";
import type { ItemDocType } from "@src/schemas/item_schema";

const ref = (id: string, updatedAt: number, collection: CloudSyncQueueRef["collection"] = "items"): CloudSyncQueueRef => ({
  collection,
  id,
  updatedAt,
  deletedAt: 0,
  queuedAt: updatedAt,
});

const item = (overrides: Partial<ItemDocType> = {}): ItemDocType => ({
  id: "item-1",
  userId: "",
  title: "Saved thing",
  textContent: "body",
  ocrText: "",
  ocrStatus: "skipped",
  ocrModelVersion: "",
  ocrUpdatedAt: 0,
  url: "https://x.com/user/status/1",
  source: "twitter",
  folderId: "folder-1",
  spaceId: "space-1",
  isFavorite: false,
  authorUsername: "user",
  likes: 42,
  media: [],
  parentId: null,
  chunkOrder: 0,
  vector_index: -1,
  vector_indexes: [],
  isEmbedded: false,
  isMetaFetched: false,
  isDirty: false,
  serverVersion: 0,
  createdAt: 100,
  updatedAt: 200,
  deletedAt: 0,
  ...overrides,
});

test("cloud sync queue keeps the newest ref per collection/id", () => {
  const merged = mergeCloudSyncQueue(
    [ref("same", 100), ref("folder", 120, "folders")],
    [ref("same", 200), ref("new", 150)]
  );

  expect(merged.map((entry) => `${entry.collection}:${entry.id}:${entry.updatedAt}`)).toEqual([
    "folders:folder:120",
    "items:new:150",
    "items:same:200",
  ]);
});

test("cloud sync refs are compact for very large imports", () => {
  const items = Array.from({ length: 10_000 }, (_, index) =>
    item({ id: `item-${index}`, updatedAt: 1_000 + index })
  );
  const refs = cloudSyncRefsForDocs({
    items,
    deletes: [{ collection: "folders", id: "old-folder", updatedAt: 20_000, deletedAt: 20_000 }],
  }, 30_000);

  expect(refs).toHaveLength(10_001);
  expect(refs[0]).toEqual({
    collection: "items",
    id: "item-0",
    updatedAt: 1_000,
    deletedAt: 0,
    queuedAt: 30_000,
  });
  expect(refs.at(-1)).toEqual({
    collection: "folders",
    id: "old-folder",
    updatedAt: 20_000,
    deletedAt: 20_000,
    queuedAt: 30_000,
  });
  expect(Object.keys(refs[0]).sort()).toEqual(["collection", "deletedAt", "id", "queuedAt", "updatedAt"]);
});

test("cloud item normalization fills the web/mobile content type surface", () => {
  const normalized = normalizeCloudDoc("items", item()) as Record<string, any>;

  expect(normalized.userId).toBeNull();
  expect(normalizeCloudDoc("items", item(), "user-1").userId).toBe("user-1");
  expect(normalized.type).toBe("social");
  expect(normalized.fields).toMatchObject({
    platform: "twitter",
    author: "user",
    likes: 42,
  });
});

test("cloud item normalization maps GitHub stars to repo fields", () => {
  const normalized = normalizeCloudDoc(
    "items",
    item({
      source: "github",
      url: "https://github.com/acme/repo",
      title: "acme/repo",
      authorUsername: "acme",
      likes: 1234,
    })
  ) as Record<string, any>;

  expect(normalized.type).toBe("repo");
  expect(normalized.fields).toMatchObject({
    owner: "acme",
    stars: 1234,
  });
});

test("cloud item normalization preserves polymorphic content and archive metadata", () => {
  const blocks: NonNullable<ItemDocType["blocks"]> = [
    { id: "body", kind: "richtext", text: "<p>Draft</p>", json: { type: "doc" } },
  ];
  const blobs: NonNullable<ItemDocType["blobs"]> = [
    {
      key: "archive/user/item/hash.html",
      kind: "archive",
      contentType: "text/html; charset=utf-8",
      byteSize: 1234,
      hash: "abc123",
      capturedAt: 300,
    },
  ];
  const normalized = normalizeCloudDoc(
    "items",
    item({
      type: "article",
      fields: { author: "Ada", readingMinutes: 4 },
      blocks,
      blobs,
      summary: "A useful summary",
      ai: { status: "done", autoTags: ["research"], updatedAt: 301 },
    }),
  ) as Record<string, any>;

  expect(normalized).toMatchObject({
    type: "article",
    fields: { author: "Ada", readingMinutes: 4 },
    blocks,
    blobs,
    summary: "A useful summary",
    ai: { status: "done", autoTags: ["research"], updatedAt: 301 },
  });
});

test("cloud sync only clears acknowledged refs from a pushed batch", () => {
  const batch = [ref("accepted", 100), ref("pending", 101), ref("conflicted", 102)];

  expect(selectAcknowledgedQueueRefs(batch, ["accepted", "conflicted"]).map((entry) => entry.id)).toEqual([
    "accepted",
    "conflicted",
  ]);
});

test("qualified acknowledgements cannot clear the same id in another collection", () => {
  const batch = [ref("same", 100, "items"), ref("same", 101, "tags")];
  expect(selectAcknowledgedQueueRefs(batch, [{ collection: "tags", id: "same" }])).toEqual([batch[1]]);
});

test("cloud sync priority selection moves a dependent item into a bounded batch", () => {
  const queue = Array.from({ length: 10_000 }, (_, index) => ref(`item-${index}`, index + 1));
  const batch = selectCloudSyncBatch(queue, 10, [{ collection: "items", id: "item-9999" }]);

  expect(batch).toHaveLength(10);
  expect(batch[0].id).toBe("item-9999");
  expect(new Set(batch.map((entry) => entry.id)).size).toBe(10);
});

test("cloud sync push batches cannot exceed ten or repeat a bare id", () => {
  const queue = [
    ref("same", 1, "items"),
    ref("same", 2, "tags"),
    ...Array.from({ length: 20 }, (_, index) => ref(`item-${index}`, index + 3)),
  ];
  const batch = selectCloudSyncBatch(queue, Number.POSITIVE_INFINITY, [{ collection: "tags", id: "same" }]);
  expect(batch).toHaveLength(CLOUD_SYNC_PUSH_BATCH_MAX);
  expect(batch[0]).toMatchObject({ collection: "tags", id: "same" });
  expect(new Set(batch.map((entry) => entry.id)).size).toBe(batch.length);
});

test("an old sync acknowledgment cannot clear a newer in-flight local edit", () => {
  const sent = ref("same", 100);
  const queueAfterEdit = mergeCloudSyncQueue([sent], [ref("same", 200), ref("other", 150)]);

  expect(removeAcknowledgedQueueRefs(queueAfterEdit, [sent])).toEqual(queueAfterEdit);
});

test("an acknowledgment clears an unchanged re-queued version", () => {
  const sent = ref("same", 100);
  const requeuedSameVersion = { ...sent, queuedAt: 200 };

  expect(removeAcknowledgedQueueRefs([requeuedSameVersion], [sent])).toEqual([]);
});

test("an old live acknowledgment cannot clear a newer tombstone", () => {
  const sent = ref("same", 100);
  const tombstone = { ...ref("same", 100), deletedAt: 200, queuedAt: 200 };

  expect(removeAcknowledgedQueueRefs([tombstone], [sent])).toEqual([tombstone]);
});

test("concurrent outbox enqueues retain both local mutations", async () => {
  const originalChrome = Object.getOwnPropertyDescriptor(globalThis, "chrome");
  const storage = new Map<string, unknown>();
  Object.defineProperty(globalThis, "chrome", {
    configurable: true,
    value: {
      storage: {
        local: {
          async get(keys: string | string[]) {
            const requested = Array.isArray(keys) ? keys : [keys];
            const snapshot = Object.fromEntries(
              requested.filter((key) => storage.has(key)).map((key) => [key, storage.get(key)]),
            );
            await new Promise((resolve) => setTimeout(resolve, 1));
            return snapshot;
          },
          async set(entries: Record<string, unknown>) {
            for (const [key, value] of Object.entries(entries)) storage.set(key, value);
          },
        },
      },
    },
  });

  try {
    const service = new CloudSyncService();
    await Promise.all([
      service.enqueueDocs({ items: [item({ id: "first", updatedAt: 100 })] }),
      service.enqueueDocs({ items: [item({ id: "second", updatedAt: 101 })] }),
    ]);

    const queue = storage.get(CLOUD_SYNC_QUEUE_KEY) as CloudSyncQueueRef[];
    expect(queue.map((entry) => entry.id).sort()).toEqual(["first", "second"]);
  } finally {
    if (originalChrome) Object.defineProperty(globalThis, "chrome", originalChrome);
    else Reflect.deleteProperty(globalThis, "chrome");
  }
});

test("cloud push drains 10,000 queued bookmarks with indexed reads per network batch", async () => {
  const originalChrome = Object.getOwnPropertyDescriptor(globalThis, "chrome");
  const storage = new Map<string, unknown>([[CLOUD_SYNC_TOKEN_KEY, "test-token"]]);
  Object.defineProperty(globalThis, "chrome", {
    configurable: true,
    value: {
      storage: {
        local: {
          async get(keys: string | string[]) {
            const requested = Array.isArray(keys) ? keys : [keys];
            return Object.fromEntries(
              requested.filter((key) => storage.has(key)).map((key) => [key, storage.get(key)]),
            );
          },
          async set(entries: Record<string, unknown>) {
            for (const [key, value] of Object.entries(entries)) storage.set(key, value);
          },
        },
      },
    },
  });

  try {
    const items = Array.from({ length: 10_000 }, (_, index) =>
      item({ id: `queued-${index}`, updatedAt: index + 1 })
    );
    storage.set(
      CLOUD_SYNC_QUEUE_KEY,
      items.map((entry) => ref(entry.id, entry.updatedAt))
    );
    const fake = fakeCollections({ items });
    const sentBatches: CloudSyncChange[][] = [];
    const requests: Array<{ url: string; method?: string }> = [];
    const service = new CloudSyncService({
      getCollectionResolver: async () => fake.resolve,
      getCredentials: async () => ({ token: "test-token", userId: "user-1" }),
      fetcher: async (input, init) => {
        requests.push({ url: String(input), method: init?.method });
        const body = JSON.parse(String(init?.body)) as { changes: CloudSyncChange[] };
        sentBatches.push(body.changes);
        return Response.json({
          applied: body.changes.length,
          acceptedRefs: body.changes.map(({ collection, id }) => ({ collection, id })),
        });
      },
    });

    const result = await service.drain({ batchSize: 200, maxBatches: 1_000 });

    expect(result).toMatchObject({ pushed: 10_000, batches: 1_000, remaining: 0 });
    expect(sentBatches).toHaveLength(1_000);
    expect(sentBatches.every((batch) => batch.length === CLOUD_SYNC_PUSH_BATCH_MAX)).toBe(true);
    expect(requests.every(({ url, method }) => url.endsWith("/v1/sync/push") && method === "POST")).toBe(true);
    expect("pull" in service).toBe(false);
    expect("sync" in service).toBe(false);
    expect(fake.calls.items.findByIds).toBe(1_000);
    expect(storage.get(CLOUD_SYNC_QUEUE_KEY)).toEqual([]);
  } finally {
    if (originalChrome) Object.defineProperty(globalThis, "chrome", originalChrome);
    else Reflect.deleteProperty(globalThis, "chrome");
  }
});

const fakeCollections = (seed: Partial<Record<CloudSyncQueueRef["collection"], ItemDocType[]>> = {}) => {
  const docs = {
    items: new Map<string, Record<string, unknown>>(),
    folders: new Map<string, Record<string, unknown>>(),
    spaces: new Map<string, Record<string, unknown>>(),
    spaceGroups: new Map<string, Record<string, unknown>>(),
    tags: new Map<string, Record<string, unknown>>(),
    itemTags: new Map<string, Record<string, unknown>>(),
  };
  const calls = {
    items: { findByIds: 0 },
    folders: { findByIds: 0 },
    spaces: { findByIds: 0 },
    spaceGroups: { findByIds: 0 },
    tags: { findByIds: 0 },
    itemTags: { findByIds: 0 },
  };
  for (const [collection, records] of Object.entries(seed)) {
    for (const record of records || []) docs[collection as keyof typeof docs].set(record.id, { ...record });
  }

  const resolve: CloudSyncCollectionResolver = (collection) => ({
    findByIds(ids) {
      calls[collection].findByIds += 1;
      return {
        exec: async () =>
          new Map(
            ids.flatMap((id) => {
              const record = docs[collection].get(id);
              return record ? [[id, { toMutableJSON: () => ({ ...record }) }] as const] : [];
            }),
          ),
      };
    },
  });

  return { calls, docs, resolve };
};
