import { expect, test } from "bun:test";
import {
  cloudSyncRefsForDocs,
  cloudSyncRefsForRxChange,
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

test("equal-clock live refs cannot replace a queued deletion tombstone", () => {
  const tombstone = { ...ref("same", 200), deletedAt: 200 };
  expect(mergeCloudSyncQueue([tombstone], [ref("same", 200)])).toEqual([
    { ...tombstone, attempts: 0 },
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

test("RxDB changes queue live documents and durable deletion tombstones", () => {
  expect(cloudSyncRefsForRxChange("itemTags", {
    events: [
      {
        operation: "INSERT",
        documentId: "item-1|tag-1",
        documentData: {
          id: "item-1|tag-1",
          updatedAt: 100,
          deletedAt: 0,
        },
      },
      {
        operation: "DELETE",
        documentId: "item-2|tag-2",
        previousDocumentData: {
          id: "item-2|tag-2",
          updatedAt: 200,
          deletedAt: 0,
        },
      },
    ],
  }, 500)).toEqual([
    {
      collection: "itemTags",
      id: "item-1|tag-1",
      updatedAt: 100,
      deletedAt: 0,
      queuedAt: 500,
    },
    {
      collection: "itemTags",
      id: "item-2|tag-2",
      updatedAt: 500,
      deletedAt: 500,
      queuedAt: 500,
    },
  ]);
});

test("cloud sync preserves opaque RxDB primary keys exactly", () => {
  expect(cloudSyncRefsForRxChange("items", {
    operation: "UPDATE",
    documentId: " item/with?reserved#characters ",
    documentData: {
      id: " item/with?reserved#characters ",
      updatedAt: 100,
      deletedAt: 0,
    },
  }, 500)[0]?.id).toBe(" item/with?reserved#characters ");
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

test("cloud item normalization classifies every shared provider family", () => {
  const expected = {
    threads: "social",
    mastodon: "social",
    bluesky: "social",
    vimeo: "video",
    spotify: "audio",
    ytmusic: "audio",
    soundcloud: "audio",
  } as const;

  for (const [source, type] of Object.entries(expected)) {
    const normalized = normalizeCloudDoc(
      "items",
      item({ source: source as ItemDocType["source"], type: undefined }),
    ) as Record<string, any>;
    expect(normalized.type, source).toBe(type);
    if (type === "social") {
      expect(normalized.fields, source).toMatchObject({ platform: source, author: "user", likes: 42 });
    }
  }
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
    url: "https://x.com/user/status/1",
    type: "article",
    fields: { author: "Ada", readingMinutes: 4 },
    blocks,
    blobs,
    summary: "A useful summary",
    ai: { status: "done", autoTags: ["research"], updatedAt: 301 },
  });
});

test("manual cloud sync backfills every local collection under the signed-in user", async () => {
  const originalChrome = Object.getOwnPropertyDescriptor(globalThis, "chrome");
  const storage = new Map<string, unknown>();
  Object.defineProperty(globalThis, "chrome", {
    configurable: true,
    value: {
      runtime: {
        sendMessage: async () => undefined,
      },
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

  const records: Record<CloudSyncQueueRef["collection"], Array<Record<string, unknown> & { id: string }>> = {
    spaceGroups: [{ id: "group-1", name: "Research", sortOrder: 0, isCollapsed: false, createdAt: 1, updatedAt: 2 }],
    spaces: [{ id: "space-1", name: "Public", slug: "public", spaceGroupId: "group-1", isPrivate: false, autoLockMs: 30_000, sortOrder: 0, isArchived: false, deletedAt: 0, purgeAt: 0, createdAt: 1, updatedAt: 3 }],
    folders: [{ id: "folder-1", name: "Reading", spaceId: "space-1", parentId: null, type: "folder", sortOrder: 0, isLocked: false, isPinned: false, isCollapsed: false, deletedAt: 0, purgeAt: 0, isDirty: true, serverVersion: 0, createdAt: 1, updatedAt: 4, userId: "" }],
    items: [item({
      id: "archived-item",
      url: "https://example.com/article?from=extension#saved",
      updatedAt: 5,
    }) as ItemDocType & Record<string, unknown>],
    tags: [{ id: "tag-1", name: "Read later", userId: null, isDirty: true, serverVersion: 0, createdAt: 1, updatedAt: 6 }],
    itemTags: [{
      id: "archived-item|tag-1",
      itemId: "archived-item",
      tagId: "tag-1",
      userId: null,
      createdAt: 1,
      updatedAt: 6,
      deletedAt: 0,
    }],
  };
  const document = (row: Record<string, unknown> & { id: string }) => ({
    primary: row.id,
    get: (field: string) => row[field],
    toMutableJSON: () => ({ ...row }),
  });
  const resolver: CloudSyncCollectionResolver = (collection) => ({
    findByIds(ids) {
      return {
        exec: async () => new Map(
          records[collection]
            .filter((row) => ids.includes(row.id))
            .map((row) => [row.id, document(row)] as const),
        ),
      };
    },
    find(query) {
      const selector = query.selector as { id?: { $gt?: string } };
      const afterId = selector.id?.$gt || "";
      return {
        exec: async () => records[collection]
          .filter((row) => row.id > afterId)
          .sort((left, right) => left.id.localeCompare(right.id))
          .slice(0, query.limit)
          .map(document),
      };
    },
  });
  const credentialRefreshes: boolean[] = [];
  const sent: CloudSyncChange[] = [];

  try {
    const service = new CloudSyncService({
      getCollectionResolver: async () => resolver,
      getCredentials: async (forceRefresh) => {
        credentialRefreshes.push(forceRefresh === true);
        return { token: "signed-in-token", userId: "user-1" };
      },
      fetcher: async (_input, init) => {
        const body = JSON.parse(String(init?.body)) as { changes: CloudSyncChange[] };
        sent.push(...body.changes);
        return Response.json({
          checkpoint: 1,
          applied: body.changes.length,
          conflicts: 0,
          acceptedRefs: body.changes.map(({ collection, id }) => ({ collection, id })),
          conflictRefs: [],
        });
      },
    });

    const result = await service.syncAll({ pageSize: 1, maxBatches: 10 });

    expect(result).toMatchObject({
      scanned: 6,
      enqueued: 6,
      push: { pushed: 6, remaining: 0 },
    });
    expect(credentialRefreshes[0]).toBe(true);
    expect(new Set(sent.map((change) => change.collection))).toEqual(new Set([
      "spaceGroups",
      "spaces",
      "folders",
      "items",
      "tags",
      "itemTags",
    ]));
    expect(sent.find((change) => change.id === "archived-item")?.doc).toMatchObject({
      userId: "user-1",
      url: "https://example.com/article?from=extension#saved",
    });
    expect(storage.get(CLOUD_SYNC_QUEUE_KEY)).toEqual([]);
  } finally {
    if (originalChrome) Object.defineProperty(globalThis, "chrome", originalChrome);
    else Reflect.deleteProperty(globalThis, "chrome");
  }
});

test("manual cloud sync refuses to scan local data without a signed-in account", async () => {
  let collectionReads = 0;
  const service = new CloudSyncService({
    getCredentials: async () => ({ token: "", userId: "" }),
    getCollectionResolver: async () => {
      collectionReads += 1;
      throw new Error("must not scan");
    },
  });

  await expect(service.syncAll()).rejects.toThrow("CLOUD_SYNC_AUTH_REQUIRED");
  expect(collectionReads).toBe(0);
});

test("manual cloud sync never uploads a scan after the signed-in account changes", async () => {
  const originalChrome = Object.getOwnPropertyDescriptor(globalThis, "chrome");
  const queuedItem = item({ id: "account-bound", updatedAt: 100 });
  const storage = new Map<string, unknown>();
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
  const document = (row: ItemDocType) => ({
    primary: row.id,
    get: (field: string) => row[field as keyof ItemDocType],
    toMutableJSON: () => ({ ...row }),
  });
  const resolver: CloudSyncCollectionResolver = (collection) => ({
    findByIds(ids) {
      return {
        exec: async () => collection === "items" && ids.includes(queuedItem.id)
          ? new Map([[queuedItem.id, document(queuedItem)]])
          : new Map(),
      };
    },
    find() {
      return {
        exec: async () => collection === "items" ? [document(queuedItem)] : [],
      };
    },
  });
  let fetchCalls = 0;

  try {
    const service = new CloudSyncService({
      getCollectionResolver: async () => resolver,
      getCredentials: async (forceRefresh) => forceRefresh
        ? { token: "token-1", userId: "user-1" }
        : { token: "token-2", userId: "user-2" },
      fetcher: async () => {
        fetchCalls += 1;
        return Response.json({ checkpoint: 1, applied: 1, conflicts: 0 });
      },
    });

    const result = await service.syncAll({ pageSize: 10, maxBatches: 1 });

    expect(result.push).toMatchObject({ reason: "invalid-auth", pushed: 0, remaining: 1 });
    expect(fetchCalls).toBe(0);
    expect(storage.get(CLOUD_SYNC_QUEUE_KEY)).toEqual([
      expect.objectContaining({ collection: "items", id: "account-bound" }),
    ]);
  } finally {
    if (originalChrome) Object.defineProperty(globalThis, "chrome", originalChrome);
    else Reflect.deleteProperty(globalThis, "chrome");
  }
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

test("malformed qualified acknowledgements leave the entire pushed batch queued", async () => {
  const originalChrome = Object.getOwnPropertyDescriptor(globalThis, "chrome");
  const storage = new Map<string, unknown>();
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

  const first = item({ id: "first", updatedAt: 100 });
  const second = item({ id: "second", updatedAt: 101 });
  const fake = fakeCollections({ items: [first, second] });
  const cases = [
    {
      name: "duplicate ref",
      response: {
        checkpoint: 1,
        applied: 2,
        conflicts: 0,
        acceptedRefs: [
          { collection: "items", id: "first" },
          { collection: "items", id: "first" },
        ],
        conflictRefs: [],
      },
    },
    {
      name: "unknown ref",
      response: {
        checkpoint: 1,
        applied: 2,
        conflicts: 0,
        acceptedRefs: [
          { collection: "items", id: "first" },
          { collection: "items", id: "unknown" },
        ],
        conflictRefs: [],
      },
    },
    {
      name: "partial acknowledgement",
      response: {
        checkpoint: 1,
        applied: 1,
        conflicts: 0,
        acceptedRefs: [{ collection: "items", id: "first" }],
        conflictRefs: [],
      },
    },
    {
      name: "overlapping accepted and conflicted refs",
      response: {
        checkpoint: 1,
        applied: 1,
        conflicts: 1,
        acceptedRefs: [{ collection: "items", id: "first" }],
        conflictRefs: [{ collection: "items", id: "first" }],
      },
    },
  ] as const;

  try {
    for (const scenario of cases) {
      const queued = [ref("first", 100), ref("second", 101)];
      storage.set(CLOUD_SYNC_QUEUE_KEY, queued);
      const service = new CloudSyncService({
        getCollectionResolver: async () => fake.resolve,
        getCredentials: async () => ({ token: "test-token", userId: "user-1" }),
        fetcher: async () => Response.json(scenario.response),
      });

      const result = await service.drain({ batchSize: 2, maxBatches: 1 });

      expect(result.reason, scenario.name).toBe("invalid-response");
      expect(result.pushed, scenario.name).toBe(0);
      expect(result.conflicts, scenario.name).toBe(0);
      expect(storage.get(CLOUD_SYNC_QUEUE_KEY), scenario.name).toEqual(queued);
    }
  } finally {
    if (originalChrome) Object.defineProperty(globalThis, "chrome", originalChrome);
    else Reflect.deleteProperty(globalThis, "chrome");
  }
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

test("reset cancellation aborts a stalled cloud request and removes its durable queue", async () => {
  const originalChrome = Object.getOwnPropertyDescriptor(globalThis, "chrome");
  const storage = new Map<string, unknown>([
    [CLOUD_SYNC_QUEUE_KEY, [ref("stalled", 100)]],
  ]);
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
          async remove(key: string) {
            storage.delete(key);
          },
        },
      },
    },
  });

  const requestStarted = (() => {
    let resolve = () => {};
    const promise = new Promise<void>((done) => { resolve = done; });
    return { promise, resolve };
  })();
  try {
    const fake = fakeCollections({ items: [item({ id: "stalled", updatedAt: 100 })] });
    const service = new CloudSyncService({
      getCollectionResolver: async () => fake.resolve,
      getCredentials: async () => ({ token: "test-token", userId: "user-1" }),
      fetcher: (_input, init) => new Promise<Response>((_resolve, reject) => {
        requestStarted.resolve();
        init?.signal?.addEventListener(
          "abort",
          () => reject(new DOMException("Aborted", "AbortError")),
          { once: true },
        );
      }),
    });

    const draining = service.drain();
    await requestStarted.promise;
    await service.cancelAndClear();

    expect(await draining).toMatchObject({ reason: "cancelled" });
    expect(storage.has(CLOUD_SYNC_QUEUE_KEY)).toBe(false);
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
          checkpoint: sentBatches.length,
          applied: body.changes.length,
          conflicts: 0,
          acceptedRefs: body.changes.map(({ collection, id }) => ({ collection, id })),
          conflictRefs: [],
        });
      },
    });

    const result = await service.drain({ batchSize: 200, maxBatches: 1_000 });

    expect(result).toMatchObject({ pushed: 10_000, batches: 1_000, remaining: 0 });
    expect(sentBatches).toHaveLength(1_000);
    expect(sentBatches.every((batch) => batch.length === CLOUD_SYNC_PUSH_BATCH_MAX)).toBe(true);
    // A push drain only ever pushes: reading the server's log is a separate,
    // explicit step so an upload can never be mistaken for a merge.
    expect(requests.every(({ url, method }) => url.endsWith("/v1/sync/push") && method === "POST")).toBe(true);
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
