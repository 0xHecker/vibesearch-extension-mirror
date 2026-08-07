import { describe, expect, test } from "bun:test";
import {
  BROWSER_BOOKMARKS_SPACE_GROUP_ID,
  BrowserBookmarkImportService,
  MAX_BOOKMARKS_PER_SPACE,
  buildBrowserBookmarkImportPlan,
  type BrowserBookmarkNode,
} from "../src/services/browser-bookmark-import";
import type { CloudSyncDocBatch } from "../src/services/cloud-sync";

const NOW = 1_764_000_000_000;

type StoredRow = Record<string, unknown>;

const cloneRow = <T extends StoredRow>(row: T): T => ({ ...row });

class FakeCollection {
  readonly rows = new Map<string, StoredRow>();
  readonly upsertBatches: StoredRow[][] = [];
  readonly removedBatches: string[][] = [];
  nextBulkUpsertResult: { success: StoredRow[]; error: unknown[] } | null = null;
  findCalls = 0;

  findOne(id: string) {
    return {
      exec: async () => {
        const row = this.rows.get(id);
        return row ? { toMutableJSON: () => cloneRow(row) } : null;
      },
    };
  }

  find(query: { selector?: Record<string, unknown> }) {
    this.findCalls += 1;
    const selector = query.selector ?? {};
    return {
      exec: async () =>
        Array.from(this.rows.values())
          .filter((row) => {
            const spaceGroupId = selector.spaceGroupId as { $eq?: unknown } | undefined;
            if (spaceGroupId && row.spaceGroupId !== spaceGroupId.$eq) return false;
            const spaceId = selector.spaceId as { $in?: unknown } | undefined;
            if (spaceId && (!Array.isArray(spaceId.$in) || !spaceId.$in.includes(row.spaceId))) return false;
            const id = selector.id as { $in?: unknown } | undefined;
            if (id && (!Array.isArray(id.$in) || !id.$in.includes(row.id))) return false;
            return true;
          })
          .map((row) => ({
            get: (key: string) => row[key],
            toMutableJSON: () => cloneRow(row),
          })),
    };
  }

  async bulkUpsert(rows: StoredRow[]) {
    this.upsertBatches.push(rows.map(cloneRow));
    if (this.nextBulkUpsertResult) {
      const result = this.nextBulkUpsertResult;
      this.nextBulkUpsertResult = null;
      return result;
    }
    for (const row of rows) this.rows.set(String(row.id), cloneRow(row));
    return { success: rows.map(cloneRow), error: [] };
  }

  async bulkRemove(ids: string[]) {
    this.removedBatches.push([...ids]);
    for (const id of ids) this.rows.delete(id);
  }

  resetWriteHistory() {
    this.upsertBatches.length = 0;
    this.removedBatches.length = 0;
  }
}

const createFakeBookmarkDb = () => {
  const space_groups = new FakeCollection();
  const spaces = new FakeCollection();
  const folders = new FakeCollection();
  const items = new FakeCollection();
  return { space_groups, spaces, folders, items };
};

const createLargeBookmarkTree = (count: number): BrowserBookmarkNode[] => [
  {
    id: "0",
    children: [
      {
        id: "bookmarks-menu",
        title: "Bookmarks menu",
        dateAdded: NOW,
        dateGroupModified: NOW,
        children: Array.from({ length: count }, (_, index) => ({
          id: `bookmark-${index}`,
          title: `Bookmark ${index}`,
          url: `https://example.com/${index}`,
          dateAdded: NOW + index,
          index,
        })),
      },
    ],
  },
];

const createWideBookmarkTree = (count: number): BrowserBookmarkNode[] => [
  {
    id: "0",
    children: Array.from({ length: count }, (_, index) => ({
      id: `folder-${index}`,
      title: `Folder ${index}`,
      dateAdded: NOW + index,
      dateGroupModified: NOW + index,
      children: [
        {
          id: `bookmark-in-folder-${index}`,
          title: `Bookmark ${index}`,
          url: `https://example.com/folder/${index}`,
          dateAdded: NOW + index,
          index: 0,
        },
      ],
    })),
  },
];

describe("buildBrowserBookmarkImportPlan", () => {
  test("preserves nested paths inside a top-level source space", () => {
    const tree: BrowserBookmarkNode[] = [
      {
        id: "0",
        children: [
          {
            id: "10",
            title: "Research",
            children: [
              {
                id: "11",
                title: "AI",
                children: [
                  { id: "100", title: "Deep link", url: "https://example.com/deep", index: 7 },
                ],
              },
            ],
          },
        ],
      },
    ];

    const plan = buildBrowserBookmarkImportPlan({ tree }, { now: NOW });
    const foldersByName = new Map(plan.folders.map((folder) => [folder.name, folder]));
    const root = foldersByName.get("Research");
    const child = foldersByName.get("AI");

    expect(plan.spaceGroup.id).toBe(BROWSER_BOOKMARKS_SPACE_GROUP_ID);
    expect(plan.spaces).toHaveLength(1);
    expect(plan.spaces[0]).toMatchObject({ name: "Research", spaceGroupId: BROWSER_BOOKMARKS_SPACE_GROUP_ID });
    expect(root?.parentId).toBeNull();
    expect(child?.parentId).toBe(root?.id);
    expect(plan.bookmarks).toHaveLength(1);
    expect(plan.bookmarks[0]).toMatchObject({
      title: "Deep link",
      folderId: child?.id,
      spaceId: plan.spaces[0].id,
      isEmbedded: false,
      isMetaFetched: false,
    });
  });

  test("places root bookmarks in their own deterministic source space", () => {
    const tree: BrowserBookmarkNode[] = [
      { id: "0", children: [{ id: "101", title: "Loose", url: "https://loose.example" }] },
    ];
    const first = buildBrowserBookmarkImportPlan({ tree }, { now: NOW });
    const second = buildBrowserBookmarkImportPlan({ tree }, { now: NOW + 5_000 });

    expect(first.spaces).toHaveLength(1);
    expect(first.spaces[0].name).toBe("Unsorted bookmarks");
    expect(first.folders[0].name).toBe("Unsorted bookmarks");
    expect(first.bookmarks[0].id).toBe(second.bookmarks[0].id);
    expect(first.spaces[0].id).toBe(second.spaces[0].id);
  });

  test("splits huge bookmark folders into spaces capped at 500 items", () => {
    const total = MAX_BOOKMARKS_PER_SPACE * 2 + 1;
    const tree: BrowserBookmarkNode[] = [
      {
        id: "0",
        children: [
          {
            id: "folder",
            title: "Big folder",
            children: Array.from({ length: total }, (_, index) => ({
              id: `bookmark-${index}`,
              title: `Bookmark ${index}`,
              url: `https://example.com/${index}`,
              index,
            })),
          },
        ],
      },
    ];

    const plan = buildBrowserBookmarkImportPlan({ tree }, { now: NOW });
    const itemsBySpace = new Map<string, number>();
    for (const bookmark of plan.bookmarks) {
      itemsBySpace.set(bookmark.spaceId, (itemsBySpace.get(bookmark.spaceId) || 0) + 1);
    }

    expect(plan.spaces.map((space) => space.name)).toEqual(["Big folder (1)", "Big folder (2)", "Big folder (3)"]);
    expect(plan.bookmarks).toHaveLength(total);
    expect(new Set(plan.bookmarks.map((bookmark) => bookmark.id)).size).toBe(total);
    expect(Array.from(itemsBySpace.values()).every((count) => count <= MAX_BOOKMARKS_PER_SPACE)).toBe(true);
    expect(plan.folders.filter((folder) => folder.isCollapsed)).toHaveLength(2);
  });

  test("reconciles 10,000 bookmarks in bounded writes without requeueing unchanged records", async () => {
    const db = createFakeBookmarkDb();
    const enqueued: CloudSyncDocBatch[] = [];
    let now = NOW + 100_000;
    const service = new BrowserBookmarkImportService({
      getDb: async () => db as never,
      cloudSync: {
        enqueueDocs: async (batch) => {
          enqueued.push(batch);
          return { queued: 0, added: 0 };
        },
        sync: async () => ({}) as never,
      } as never,
      markSearchDirty: () => {},
      now: () => now,
      yieldToEventLoop: async () => {},
      notifyDbChange: () => {},
    });
    const tree = createLargeBookmarkTree(10_000);

    const initial = await service.importTree({ tree });
    expect(initial.updatedBookmarkCount).toBe(10_000);
    expect(enqueued).toHaveLength(1);
    expect(enqueued[0].items).toHaveLength(10_000);
    expect(db.items.upsertBatches).toHaveLength(50);
    expect(Math.max(...db.items.upsertBatches.map((batch) => batch.length))).toBeLessThanOrEqual(200);

    enqueued.length = 0;
    db.space_groups.resetWriteHistory();
    db.spaces.resetWriteHistory();
    db.folders.resetWriteHistory();
    db.items.resetWriteHistory();
    now += 1_000;

    const unchanged = await service.importTree({ tree });
    expect(unchanged.updatedFolderCount).toBe(0);
    expect(unchanged.updatedBookmarkCount).toBe(0);
    expect(enqueued).toHaveLength(0);
    expect(db.space_groups.upsertBatches).toHaveLength(0);
    expect(db.spaces.upsertBatches).toHaveLength(0);
    expect(db.folders.upsertBatches).toHaveLength(0);
    expect(db.items.upsertBatches).toHaveLength(0);

    const renamedTree = structuredClone(tree);
    renamedTree[0].children![0].children![125].title = "Renamed bookmark";
    now += 1_000;
    await service.importTree({ tree: renamedTree });
    expect(enqueued).toHaveLength(1);
    expect(enqueued[0]).toMatchObject({
      items: [expect.objectContaining({ title: "Renamed bookmark", deletedAt: 0 })],
      folders: [],
      spaces: [],
    });
    expect(enqueued[0].items).toHaveLength(1);

    enqueued.length = 0;
    const deletedTree = structuredClone(renamedTree);
    deletedTree[0].children![0].children!.pop();
    now += 1_000;
    const deleted = await service.importTree({ tree: deletedTree });
    expect(deleted.removedBookmarkCount).toBe(1);
    expect(enqueued).toHaveLength(1);
    expect(enqueued[0].items).toHaveLength(1);
    expect(enqueued[0].items![0]).toMatchObject({ deletedAt: now, updatedAt: now });
  });

  test("automatic resync preserves user-owned records inside the managed bookmark group", async () => {
    const db = createFakeBookmarkDb();
    let now = NOW + 100_000;
    const service = new BrowserBookmarkImportService({
      getDb: async () => db as never,
      cloudSync: {
        enqueueDocs: async () => ({ queued: 0, added: 0 }),
      } as never,
      markSearchDirty: () => {},
      now: () => now,
      yieldToEventLoop: async () => {},
      notifyDbChange: () => {},
    });
    const tree = createLargeBookmarkTree(1);
    const initial = await service.importTree({ tree });
    const importedSpaceId = initial.primarySpaceId!;
    const importedFolder = Array.from(db.folders.rows.values())[0];
    const importedBookmark = Array.from(db.items.rows.values())[0];

    db.spaces.rows.set("user-space", {
      ...db.spaces.rows.get(importedSpaceId)!,
      id: "user-space",
      name: "My saved research",
      slug: "my-saved-research",
    });
    db.folders.rows.set("user-folder", {
      ...importedFolder,
      id: "user-folder",
      name: "My folder",
      spaceId: importedSpaceId,
      parentId: importedFolder.id,
    });
    db.items.rows.set("user-item-in-imported-folder", {
      ...importedBookmark,
      id: "user-item-in-imported-folder",
      title: "Keep me",
      url: "https://example.com/user-owned",
      folderId: importedFolder.id,
      deletedAt: 0,
    });
    db.items.rows.set("user-item-in-user-space", {
      ...importedBookmark,
      id: "user-item-in-user-space",
      title: "Keep my space",
      url: "https://example.com/user-space",
      spaceId: "user-space",
      folderId: "user-folder",
      deletedAt: 0,
    });

    now += 1_000;
    const result = await service.importTree({ tree: [{ id: "0", children: [] }] });

    expect(result.removedBookmarkCount).toBe(1);
    expect(db.items.rows.get(String(importedBookmark.id))?.deletedAt).toBe(now);
    expect(db.items.rows.get("user-item-in-imported-folder")?.deletedAt).toBe(0);
    expect(db.items.rows.get("user-item-in-user-space")?.deletedAt).toBe(0);
    expect(db.folders.rows.has(String(importedFolder.id))).toBe(true);
    expect(db.folders.rows.has("user-folder")).toBe(true);
    expect(db.spaces.rows.get(importedSpaceId)?.isArchived).toBe(false);
    expect(db.spaces.rows.get("user-space")?.isArchived).toBe(false);
  });

  test("reimport preserves a relocated managed bookmark and all of its local edits", async () => {
    const db = createFakeBookmarkDb();
    const enqueued: CloudSyncDocBatch[] = [];
    let now = NOW + 100_000;
    const service = new BrowserBookmarkImportService({
      getDb: async () => db as never,
      cloudSync: {
        enqueueDocs: async (batch) => {
          enqueued.push(batch);
          return { queued: 0, added: 0 };
        },
      } as never,
      markSearchDirty: () => {},
      now: () => now,
      yieldToEventLoop: async () => {},
      notifyDbChange: () => {},
    });
    const initialTree = createLargeBookmarkTree(1);
    await service.importTree({ tree: initialTree });
    const imported = Array.from(db.items.rows.values())[0];
    const relocated = {
      ...imported,
      title: "My annotated bookmark",
      textContent: "Local notes that must survive source reconciliation",
      folderId: "user-folder",
      spaceId: "user-space",
      isFavorite: true,
      media: [{ type: "image", url: "https://example.com/local-preview.png" }],
      updatedAt: now + 1,
    };
    db.items.rows.set(String(imported.id), cloneRow(relocated));
    db.spaces.rows.set("user-space", {
      id: "user-space",
      name: "My research",
      slug: "my-research",
      spaceGroupId: "",
      isPrivate: false,
      isArchived: false,
      deletedAt: 0,
    });
    db.folders.rows.set("user-folder", {
      id: "user-folder",
      name: "My notes",
      spaceId: "user-space",
      parentId: null,
      deletedAt: 0,
    });
    enqueued.length = 0;
    db.items.resetWriteHistory();

    const changedTree = structuredClone(initialTree);
    changedTree[0].children![0].children![0] = {
      ...changedTree[0].children![0].children![0],
      title: "Source renamed this",
      url: "https://example.com/source-changed",
    };
    now += 1_000;
    const result = await service.importTree({ tree: changedTree });

    expect(result.updatedBookmarkCount).toBe(0);
    expect(result.metadataUrls).toEqual([]);
    expect(db.items.rows.get(String(imported.id))).toEqual(relocated);
    expect(db.items.upsertBatches).toHaveLength(0);
    expect(enqueued).toHaveLength(0);
  });

  test("rejects a managed bookmark import when RxDB rejects an item batch", async () => {
    const db = createFakeBookmarkDb();
    const enqueued: CloudSyncDocBatch[] = [];
    const writeError = {
      status: 422,
      documentId: "browser-bookmark-rejected",
      isError: true,
      message: "schema validation failed",
    };
    db.items.nextBulkUpsertResult = { success: [], error: [writeError] };
    let searchDirtyCalls = 0;
    const notifications: string[] = [];
    const service = new BrowserBookmarkImportService({
      getDb: async () => db as never,
      cloudSync: {
        enqueueDocs: async (batch) => {
          enqueued.push(batch);
          return { queued: 0, added: 0 };
        },
      } as never,
      markSearchDirty: () => {
        searchDirtyCalls += 1;
      },
      now: () => NOW,
      yieldToEventLoop: async () => {},
      notifyDbChange: (scope) => notifications.push(scope),
    });

    const importError = await service.importTree({ tree: createLargeBookmarkTree(1) }).then(
      () => null,
      (error: unknown) => error
    );

    expect(importError).toBeInstanceOf(AggregateError);
    expect(importError).toMatchObject({
      message: "RXDB_BULK_WRITE_FAILED:browser-bookmarks.items:1",
      errors: [writeError],
    });
    expect(db.items.rows.size).toBe(0);
    expect(enqueued).toHaveLength(0);
    expect(searchDirtyCalls).toBe(0);
    expect(notifications).toEqual([]);
  });

  test("retains structure when user content lands at the final resync cleanup boundary", async () => {
    const db = createFakeBookmarkDb();
    let now = NOW + 100_000;
    let armed = false;
    let injected = false;
    let concurrentItem: StoredRow | null = null;
    let staleManagedItemId: string | null = null;
    const service = new BrowserBookmarkImportService({
      getDb: async () => db as never,
      cloudSync: {
        enqueueDocs: async () => ({ queued: 0, added: 0 }),
      } as never,
      markSearchDirty: () => {},
      now: () => now,
      yieldToEventLoop: async () => {
        if (!armed || injected || !concurrentItem) return;
        if (!staleManagedItemId || db.items.rows.get(staleManagedItemId)?.deletedAt !== now) return;
        db.items.rows.set(String(concurrentItem.id), cloneRow(concurrentItem));
        injected = true;
      },
      notifyDbChange: () => {},
    });
    const initialTree: BrowserBookmarkNode[] = [{
      id: "0",
      children: [
        {
          id: "keep-folder",
          title: "Keep",
          children: [{ id: "keep-bookmark", title: "Keep", url: "https://example.com/keep" }],
        },
        {
          id: "stale-folder",
          title: "Stale",
          children: [{ id: "stale-bookmark", title: "Stale", url: "https://example.com/stale" }],
        },
      ],
    }];
    const initialPlan = buildBrowserBookmarkImportPlan({ tree: initialTree }, { now });
    await service.importTree({ tree: initialTree });

    const staleSpace = initialPlan.spaces.find((space) => space.name === "Stale")!;
    const staleFolder = initialPlan.folders.find((folder) => folder.spaceId === staleSpace.id)!;
    const staleBookmark = initialPlan.bookmarks.find((item) => item.spaceId === staleSpace.id)!;
    staleManagedItemId = staleBookmark.id;
    concurrentItem = {
      ...staleBookmark,
      id: "user-save-during-browser-resync",
      title: "Saved while syncing",
      url: "https://example.com/concurrent-user-save",
      folderId: staleFolder.id,
      spaceId: staleSpace.id,
      deletedAt: 0,
    };
    armed = true;
    now += 1_000;

    await service.importTree({ tree: [{ id: "0", children: [initialTree[0].children![0]] }] });

    expect(injected).toBe(true);
    expect(db.items.rows.get("user-save-during-browser-resync")?.deletedAt).toBe(0);
    expect(db.folders.rows.has(staleFolder.id)).toBe(true);
    expect(db.spaces.rows.get(staleSpace.id)?.isArchived).toBe(false);
  });

  test("rejects a missing bookmark tree before destructive reconciliation", async () => {
    const db = createFakeBookmarkDb();
    const service = new BrowserBookmarkImportService({
      getDb: async () => db as never,
      cloudSync: {
        enqueueDocs: async () => ({ queued: 0, added: 0 }),
      } as never,
      markSearchDirty: () => {},
      now: () => NOW,
      yieldToEventLoop: async () => {},
      notifyDbChange: () => {},
    });
    const tree = createLargeBookmarkTree(1);
    await service.importTree({ tree });
    const before = {
      spaces: Array.from(db.spaces.rows.keys()),
      folders: Array.from(db.folders.rows.keys()),
      items: Array.from(db.items.rows.entries()),
    };

    await expect(service.importTree({ tree: [] })).rejects.toThrow("BOOKMARK_TREE_INVALID");

    expect(Array.from(db.spaces.rows.keys())).toEqual(before.spaces);
    expect(Array.from(db.folders.rows.keys())).toEqual(before.folders);
    expect(Array.from(db.items.rows.entries())).toEqual(before.items);
  });

  test("does not silently resurrect a managed destination space from Bin", async () => {
    const db = createFakeBookmarkDb();
    const service = new BrowserBookmarkImportService({
      getDb: async () => db as never,
      cloudSync: { enqueueDocs: async () => ({ queued: 0, added: 0 }) } as never,
      markSearchDirty: () => {},
      now: () => NOW,
      yieldToEventLoop: async () => {},
      notifyDbChange: () => {},
    });
    const tree = createLargeBookmarkTree(1);
    const initial = await service.importTree({ tree });
    const space = db.spaces.rows.get(initial.primarySpaceId!)!;
    space.deletedAt = NOW + 1;
    space.purgeAt = NOW + 2;
    db.items.resetWriteHistory();

    await expect(service.importTree({ tree })).rejects.toThrow("DESTINATION_SPACE_NOT_LIVE");
    expect(space.deletedAt).toBe(NOW + 1);
    expect(db.items.upsertBatches).toHaveLength(0);
  });

  test("bounds space and folder writes for a very wide bookmark tree", async () => {
    const db = createFakeBookmarkDb();
    const service = new BrowserBookmarkImportService({
      getDb: async () => db as never,
      cloudSync: {
        enqueueDocs: async () => ({ queued: 0, added: 0 }),
      } as never,
      markSearchDirty: () => {},
      now: () => NOW,
      yieldToEventLoop: async () => {},
      notifyDbChange: () => {},
    });

    const result = await service.importTree({ tree: createWideBookmarkTree(1_001) });

    expect(result).toMatchObject({ bookmarkCount: 1_001, folderCount: 1_001 });
    expect(db.spaces.upsertBatches).toHaveLength(6);
    expect(db.folders.upsertBatches).toHaveLength(6);
    expect(Math.max(...db.spaces.upsertBatches.map((batch) => batch.length))).toBeLessThanOrEqual(200);
    expect(Math.max(...db.folders.upsertBatches.map((batch) => batch.length))).toBeLessThanOrEqual(200);
  });
});
