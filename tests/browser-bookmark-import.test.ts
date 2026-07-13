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
    for (const row of rows) this.rows.set(String(row.id), cloneRow(row));
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
