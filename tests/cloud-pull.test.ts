import { expect, test } from "bun:test";
import type { CloudAuthCredentials } from "@src/services/cloud-auth";
import {
  CLOUD_SYNC_PULL_STATE_KEY,
  CloudSyncService,
  localizePulledDoc,
  normalizePulledPage,
  type CloudSyncCollectionName,
  type CloudSyncLocalCollection,
  type CloudSyncLocalDocument,
} from "@src/services/cloud-sync";

/** A stand-in for one RxDB collection: ids, docs, schema and bulkInsert. */
class FakeCollection implements CloudSyncLocalCollection {
  inserted: Record<string, unknown>[] = [];
  constructor(
    private readonly rows: Record<string, unknown>[] = [],
    readonly schema = {
      jsonSchema: {
        properties: {
          id: {}, url: {}, spaceId: {}, title: {}, updatedAt: {}, createdAt: {}, isDirty: {},
        },
        required: ["id", "updatedAt"],
      },
    },
  ) {}

  private document(row: Record<string, unknown>): CloudSyncLocalDocument {
    return { primary: String(row.id), toMutableJSON: () => ({ ...row }) };
  }

  findByIds(ids: string[]) {
    return {
      exec: async () => {
        const found = new Map<string, CloudSyncLocalDocument>();
        for (const row of this.rows) {
          if (ids.includes(String(row.id))) found.set(String(row.id), this.document(row));
        }
        return found;
      },
    };
  }

  find(query: { selector: Record<string, unknown> }) {
    return {
      exec: async () => {
        const urls = (query.selector?.url as { $in?: string[] })?.$in ?? [];
        return this.rows
          .filter((row) => urls.includes(String(row.url)))
          .map((row) => this.document(row));
      },
    };
  }

  async bulkInsert(docs: Record<string, unknown>[]) {
    this.inserted.push(...docs);
    this.rows.push(...docs);
    return { error: [] };
  }
}

const harness = (options: {
  pages: unknown[];
  local?: Partial<Record<CloudSyncCollectionName, FakeCollection>>;
  /** Omit to opt this device into incoming rows; false keeps the default. */
  pullEnabled?: false;
  getCredentials?: () => Promise<CloudAuthCredentials>;
  fetcher?: typeof fetch;
}) => {
  const store = new Map<string, unknown>(
    options.pullEnabled === false ? [] : [["vibesearch:cloudPullEnabled:v1", true]],
  );
  (globalThis as any).chrome = {
    storage: {
      local: {
        async get(key: string) {
          return store.has(key) ? { [key]: store.get(key) } : {};
        },
        async set(entries: Record<string, unknown>) {
          for (const [key, value] of Object.entries(entries)) store.set(key, value);
        },
        async remove(key: string) {
          store.delete(key);
        },
      },
    },
  };

  const collections: Partial<Record<CloudSyncCollectionName, FakeCollection>> = {
    items: new FakeCollection(),
    spaces: new FakeCollection(),
    folders: new FakeCollection(),
    spaceGroups: new FakeCollection(),
    tags: new FakeCollection(),
    itemTags: new FakeCollection(),
    ...options.local,
  };

  const requests: string[] = [];
  let page = 0;
  const service = new CloudSyncService({
    getCredentials: options.getCredentials ?? (async () => ({ token: "token", userId: "user-1" })),
    getCollectionResolver: async () => (collection) => collections[collection] as CloudSyncLocalCollection,
    fetcher: options.fetcher ?? (async (input: RequestInfo | URL) => {
      requests.push(String(input));
      const body = options.pages[Math.min(page, options.pages.length - 1)];
      page += 1;
      return new Response(JSON.stringify(body), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch,
  });

  return { service, collections, requests, store };
};

test("a pull is off by default: backup leaves this device one-way", async () => {
  const { service, requests } = harness({
    pages: [{ changes: [], checkpoint: 1, hasMore: false }],
    pullEnabled: false,
  });

  // No opt-in stored, so nothing is even requested.
  expect(await service.pull()).toMatchObject({ reason: "disabled", inserted: 0 });
  expect(requests).toEqual([]);
});

test("a retired pull cannot insert its old page or advance its checkpoint", async () => {
  let current = true;
  const { service, store, collections } = harness({
    pages: [],
    getCredentials: async () => ({ token: "old-token", userId: "user-1", isCurrent: () => current }),
    fetcher: async () => {
      current = false;
      return Response.json({ changes: [{ collection: "spaces", id: "old-space", doc: { id: "old-space", updatedAt: 10, syncOrigin: "extension" }, updatedAt: 10, deletedAt: 0 }], checkpoint: 10, hasMore: true });
    },
  });
  expect(await service.pull()).toMatchObject({ inserted: 0, reason: "cancelled" });
  expect(collections.spaces?.inserted).toEqual([]);
  expect(store.has(CLOUD_SYNC_PULL_STATE_KEY)).toBe(false);
});

test("a pull retired during its local lookup cannot publish the received row", async () => {
  let current = true;
  const local = new FakeCollection();
  local.findByIds = () => ({ exec: async () => { current = false; return new Map<string, CloudSyncLocalDocument>(); } });
  const { service, store } = harness({
    local: { spaces: local },
    getCredentials: async () => ({ token: "old-token", userId: "user-1", isCurrent: () => current }),
    pages: [{ changes: [{ collection: "spaces", id: "old-space", doc: { id: "old-space", updatedAt: 10, syncOrigin: "extension" }, updatedAt: 10, deletedAt: 0 }], checkpoint: 10, hasMore: false }],
  });
  expect(await service.pull()).toMatchObject({ inserted: 0, reason: "cancelled" });
  expect(local.inserted).toEqual([]);
  expect(store.has(CLOUD_SYNC_PULL_STATE_KEY)).toBe(false);
});

test("a delayed pull refusal cannot reject the replacement connection", async () => {
  let current = true;
  let rejections = 0;
  const { service } = harness({
    pages: [],
    getCredentials: async () => ({ token: "old-token", userId: "user-1", isCurrent: () => current, reject: async () => { rejections += 1; } }),
    fetcher: async () => { current = false; return new Response(null, { status: 401 }); },
  });
  expect(await service.pull()).toMatchObject({ reason: "cancelled" });
  expect(rejections).toBe(0);
});

test("a pull adds rows from another device and never touches local ones", async () => {
  const local = new FakeCollection([
    { id: "mine", url: "https://example.com/mine", spaceId: "public", title: "My title", updatedAt: 10 },
  ]);
  const { service, collections } = harness({
    local: { items: local },
    pages: [{
      changes: [
        // Already here: must be left exactly as it is.
        { collection: "items", id: "mine", doc: { id: "mine", url: "https://example.com/mine", spaceId: "public", title: "Remote title", updatedAt: 99, syncOrigin: "extension" }, updatedAt: 99, deletedAt: 0 },
        // New from the other device.
        { collection: "items", id: "theirs", doc: { id: "theirs", url: "https://example.com/theirs", spaceId: "public", updatedAt: 50, syncOrigin: "extension" }, updatedAt: 50, deletedAt: 0 },
        // A remote deletion must not delete anything here.
        { collection: "items", id: "mine", doc: null, updatedAt: 120, deletedAt: 120 },
      ],
      checkpoint: 120,
      hasMore: false,
    }],
  });

  const result = await service.pull();

  expect(result).toMatchObject({ inserted: 1, pages: 1, checkpoint: 120, hasMore: false });
  expect(collections.items?.inserted.map((doc) => doc.id)).toEqual(["theirs"]);
  // The local row keeps its own title, and still exists.
  const kept = await local.findByIds(["mine"]).exec();
  expect(kept.get("mine")?.toMutableJSON()).toMatchObject({ title: "My title", updatedAt: 10 });
});

test("the same page saved on two devices does not become two rows", async () => {
  const local = new FakeCollection([
    { id: "local-id", url: "https://example.com/page", spaceId: "public", updatedAt: 10 },
  ]);
  const { service, collections } = harness({
    local: { items: local },
    pages: [{
      changes: [{
        collection: "items",
        id: "remote-id",
        doc: { id: "remote-id", url: "https://example.com/page", spaceId: "public", updatedAt: 60, syncOrigin: "extension" },
        updatedAt: 60,
        deletedAt: 0,
      }],
      checkpoint: 60,
      hasMore: false,
    }],
  });

  const result = await service.pull();

  expect(result.inserted).toBe(0);
  expect(collections.items?.inserted).toEqual([]);
});

test("a pull follows pages and remembers where it stopped", async () => {
  const { service, requests, store } = harness({
    pages: [
      {
        changes: [{ collection: "spaces", id: "space-1", doc: { id: "space-1", updatedAt: 5, syncOrigin: "extension" }, updatedAt: 5, deletedAt: 0 }],
        checkpoint: 5,
        hasMore: true,
      },
      {
        changes: [{ collection: "items", id: "item-1", doc: { id: "item-1", url: "https://example.com/a", spaceId: "space-1", updatedAt: 9, syncOrigin: "extension" }, updatedAt: 9, deletedAt: 0 }],
        checkpoint: 9,
        hasMore: false,
      },
    ],
  });

  const result = await service.pull();

  expect(result).toMatchObject({ inserted: 2, pages: 2, checkpoint: 9, hasMore: false });
  expect(requests[0]).toContain("since=0");
  // The second request resumes from the first page's checkpoint.
  expect(requests[1]).toContain("since=5");
  expect(store.get(CLOUD_SYNC_PULL_STATE_KEY)).toMatchObject({ checkpoint: 9 });

  // A later pull starts from the stored checkpoint, not from zero.
  await service.pull();
  expect(requests.at(-1)).toContain("since=9");
});

test("a bootstrap replay keeps its cursor until the snapshot completes", async () => {
  const { service, requests, store } = harness({
    pages: [
      {
        changes: [],
        checkpoint: 0,
        hasMore: true,
        bootstrap: { complete: false, cursor: "resume-here" },
      },
      { changes: [], checkpoint: 42, hasMore: false, bootstrap: { complete: true } },
    ],
  });

  await service.pull();

  expect(requests[1]).toContain("cursor=resume-here");
  // The bootstrap cursor is dropped once the snapshot is complete.
  expect(store.get(CLOUD_SYNC_PULL_STATE_KEY)).toMatchObject({ checkpoint: 42 });
  expect((store.get(CLOUD_SYNC_PULL_STATE_KEY) as { bootstrapCursor?: string }).bootstrapCursor)
    .toBeUndefined();
});

test("a refused session stops the pull without moving the checkpoint", async () => {
  const { service, store } = harness({ pages: [{}] });
  (globalThis as any).chrome.storage.local.set({
    [CLOUD_SYNC_PULL_STATE_KEY]: { checkpoint: 77, userId: "user-1" },
  });
  const refused = new CloudSyncService({
    getCredentials: async () => ({ token: "dead", userId: "user-1" }),
    getCollectionResolver: async () => (() => new FakeCollection()) as never,
    fetcher: (async () => new Response("unauthorized", { status: 401 })) as typeof fetch,
  });

  const result = await refused.pull();

  expect(result).toMatchObject({ reason: "invalid-auth", inserted: 0, checkpoint: 77 });
  expect(store.get(CLOUD_SYNC_PULL_STATE_KEY)).toMatchObject({ checkpoint: 77 });
  void service;
});

test("a pull without a session does nothing at all", async () => {
  const service = new CloudSyncService({
    getCredentials: async () => ({ token: "", userId: "" }),
    fetcher: (async () => {
      throw new Error("must not reach the network");
    }) as typeof fetch,
  });

  expect(await service.pull()).toMatchObject({ reason: "missing-token", inserted: 0 });
});

test("a malformed page is refused before it can touch the database", () => {
  expect(normalizePulledPage(null)).toBeNull();
  expect(normalizePulledPage({ changes: [], checkpoint: -1, hasMore: false })).toBeNull();
  expect(normalizePulledPage({ changes: [], checkpoint: 1, hasMore: "yes" })).toBeNull();
  expect(normalizePulledPage({ changes: "nope", checkpoint: 1, hasMore: false })).toBeNull();

  const page = normalizePulledPage({
    changes: [
      { collection: "items", id: "ok", doc: { id: "ok" }, updatedAt: 3, deletedAt: 0 },
      { collection: "unknown", id: "skip", doc: {}, updatedAt: 1, deletedAt: 0 },
      { collection: "items", id: "", doc: {}, updatedAt: 1, deletedAt: 0 },
    ],
    checkpoint: 3,
    hasMore: false,
  });
  expect(page?.changes.map((change) => change.id)).toEqual(["ok"]);
});

test("an incoming doc is trimmed to the local schema and marked in sync", () => {
  const schema = {
    jsonSchema: { properties: { id: {}, title: {}, isDirty: {} }, required: ["id"] },
  };

  expect(localizePulledDoc({ id: "a", title: "T", serverOnly: 1, userId: "u" }, schema))
    .toEqual({ id: "a", title: "T", isDirty: false });
  // A row missing a required field is skipped, never invented.
  expect(localizePulledDoc({ title: "no id" }, schema)).toBeNull();
});

test("a page of web-app rows is fetched but nothing is written", async () => {
  const { service, collections } = harness({
    pages: [{
      changes: [{
        collection: "items",
        id: "web-item",
        doc: { id: "web-item", url: "https://example.com/from-web", spaceId: "public", updatedAt: 40 },
        updatedAt: 40,
        deletedAt: 0,
      }],
      checkpoint: 40,
      hasMore: false,
    }],
  });

  const result = await service.pull();

  expect(result).toMatchObject({ inserted: 0, checkpoint: 40 });
  expect(collections.items?.inserted).toEqual([]);
});

test("another account never inherits this account's read position", async () => {
  const { service, requests, store } = harness({
    pages: [{ changes: [], checkpoint: 5, hasMore: false }],
  });
  // Account A read up to 5000.
  store.set("vibesearch:cloudSyncPullState:v1", { checkpoint: 5_000, userId: "user-A" });

  // The signed-in account is user-1 (see harness), so A's cursor must not apply:
  // "seq > 5000" would match nothing in a different account's store and the
  // whole library would stay invisible.
  await service.pull();

  expect(requests[0]).toContain("since=0");
  expect(store.get("vibesearch:cloudSyncPullState:v1")).toMatchObject({ userId: "user-1" });
});

test("a repeated checkpoint cannot rewind this device", async () => {
  const { service, store } = harness({
    pages: [
      { changes: [], checkpoint: 90, hasMore: true },
      { changes: [], checkpoint: 40, hasMore: false },
    ],
  });

  await service.pull();

  expect(store.get("vibesearch:cloudSyncPullState:v1")).toMatchObject({ checkpoint: 90 });
});

test("a store that refuses a row does not let the checkpoint pass it", async () => {
  const refusing = new FakeCollection();
  refusing.bulkInsert = async () => ({ error: [{ status: 409 }] });
  const { service } = harness({
    local: { items: refusing },
    pages: [{
      changes: [{
        collection: "items",
        id: "conflicted",
        doc: { id: "conflicted", url: "https://example.com/x", spaceId: "public", updatedAt: 7, syncOrigin: "extension" },
        updatedAt: 7,
        deletedAt: 0,
      }],
      checkpoint: 7,
      hasMore: false,
    }],
  });

  const result = await service.pull();

  // Reported honestly rather than counted as an insert.
  expect(result).toMatchObject({ inserted: 0, rejected: 1 });
});

test("a pulled row does not carry another device's vector slot", () => {
  const schema = {
    jsonSchema: {
      properties: { id: {}, updatedAt: {}, vector_index: {}, vector_indexes: {}, isEmbedded: {}, isDirty: {} },
      required: ["id", "updatedAt"],
    },
  };

  expect(localizePulledDoc(
    { id: "a", updatedAt: 1, vector_index: 4_821, vector_indexes: [4_821], isEmbedded: true, isDirty: true },
    schema,
  )).toEqual({
    id: "a",
    updatedAt: 1,
    // A foreign offset would resolve to a local neighbour's embedding.
    vector_index: -1,
    vector_indexes: [],
    isEmbedded: false,
    isDirty: false,
  });
});
