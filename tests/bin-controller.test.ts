import { describe, expect, test } from "bun:test";
import type { FolderDocType } from "../src/schemas/folder_schema";
import type { ItemDocType } from "../src/schemas/item_schema";
import type { SpaceDocType } from "../src/schemas/space_schema";
import { compareBinEntries, MAX_BIN_PAGE_SIZE } from "../src/common/bin";
import { BinController } from "../src/services/controllers/bin.controller";

type Row = { id: string; [key: string]: unknown };

const scanStats = {
  queries: 0,
  maxBatch: 0,
  fieldReads: 0,
  fieldsRead: new Set<string>(),
  mutableJsonCalls: 0,
};

const resetScanStats = () => {
  scanStats.queries = 0;
  scanStats.maxBatch = 0;
  scanStats.fieldReads = 0;
  scanStats.fieldsRead.clear();
  scanStats.mutableJsonCalls = 0;
};

class FakeDoc<T extends Row> {
  constructor(private row: T) {}

  get primary(): string {
    return this.row.id;
  }

  get(field: string): unknown {
    scanStats.fieldReads += 1;
    scanStats.fieldsRead.add(field);
    return this.row[field];
  }

  toMutableJSON(): T {
    scanStats.mutableJsonCalls += 1;
    return { ...this.row };
  }
}

const matchesSelector = (row: Row, selector?: Record<string, any>): boolean => {
  if (!selector) return true;
  if (Array.isArray(selector.$and)) {
    return selector.$and.every((part: Record<string, any>) => matchesSelector(row, part));
  }
  return Object.entries(selector).every(([key, condition]) => {
    const value = row[key];
    if (condition && typeof condition === "object" && !Array.isArray(condition)) {
      if ("$eq" in condition) return value === condition.$eq;
      if ("$gt" in condition) return value > condition.$gt;
      if ("$in" in condition) return Array.isArray(condition.$in) && condition.$in.includes(value);
    }
    return value === condition;
  });
};

const collection = <T extends Row>(rows: T[]) => ({
  find: (query?: {
    selector?: Record<string, any>;
    sort?: Array<{ id: "asc" }>;
    limit?: number;
  }) => ({
    exec: async () => {
      scanStats.queries += 1;
      const selected = rows
        .filter((row) => matchesSelector(row, query?.selector))
        .sort((left, right) => left.id.localeCompare(right.id))
        .slice(0, query?.limit ?? rows.length)
        .map((row) => new FakeDoc(row));
      scanStats.maxBatch = Math.max(scanStats.maxBatch, selected.length);
      return selected;
    },
  }),
});

const deletedAt = 1_764_000_000_000;
const purgeAt = deletedAt + 30 * 24 * 60 * 60 * 1000;

const spaces: SpaceDocType[] = [];
const folders: FolderDocType[] = [];
const items: ItemDocType[] = [];

const db = {
  spaces: collection(spaces),
  folders: collection(folders),
  items: collection(items),
};
const binController = new BinController({ getDb: async () => db as never });

const makeSpace = (id: string, name: string, isBinned = false): SpaceDocType =>
  ({
    id,
    name,
    slug: name.toLowerCase(),
    spaceGroupId: "",
    isPrivate: false,
    autoLockMs: 0,
    sortOrder: 0,
    isArchived: false,
    deletedAt: isBinned ? deletedAt : 0,
    purgeAt: isBinned ? purgeAt : 0,
    createdAt: deletedAt,
    updatedAt: deletedAt,
  }) as SpaceDocType;

const makeFolder = (id: string, parentId: string | null, isBinned = false): FolderDocType => ({
  id,
  name: id,
  userId: "user1",
  spaceId: "space-a",
  parentId,
  type: "tab_group",
  sortOrder: 0,
  isLocked: false,
  isPinned: false,
  isCollapsed: false,
  deletedAt: isBinned ? deletedAt : 0,
  purgeAt: isBinned ? purgeAt : 0,
  isDirty: false,
  serverVersion: 0,
  createdAt: deletedAt,
  updatedAt: deletedAt,
});

const makeItem = (id: string, folderId: string, spaceId = "space-a", isBinned = false): ItemDocType =>
  ({
    id,
    userId: "user1",
    title: id,
    textContent: "",
    url: `https://example.com/${id}`,
    source: "web",
    folderId,
    spaceId,
    isFavorite: false,
    parentId: null,
    vector_index: -1,
    vector_indexes: [],
    isEmbedded: false,
    isMetaFetched: true,
    isDirty: false,
    serverVersion: 0,
    createdAt: deletedAt,
    updatedAt: deletedAt,
    deletedAt: isBinned ? deletedAt : 0,
  }) as ItemDocType;

describe("bin contents", () => {
  test("lists binned spaces, top-level folder trees, and individual tabs", async () => {
    resetScanStats();
    spaces.splice(0, spaces.length, makeSpace("space-a", "Space A"), makeSpace("space-b", "Space B", true));
    folders.splice(
      0,
      folders.length,
      makeFolder("root", null, true),
      makeFolder("child", "root", true),
      makeFolder("live-folder", null)
    );
    items.splice(
      0,
      items.length,
      makeItem("root-tab", "root", "space-a", true),
      makeItem("child-tab", "child", "space-a", true),
      makeItem("single-tab", "live-folder", "space-a", true),
      makeItem("space-tab", "any-folder", "space-b", true)
    );

    const page = await binController.listContents();

    expect(page.entries.map((entry) => `${entry.kind}:${entry.id}`).sort()).toEqual([
      "space:space-b",
      "folder:root",
      "item:single-tab",
    ].sort());
    expect(page.total).toBe(3);
    expect(page.hasMore).toBe(false);
    expect(page.nextCursor).toBeNull();
    expect(page.entries.find((entry) => entry.id === "root")?.itemCount).toBe(2);
    expect(scanStats.mutableJsonCalls).toBe(0);
  });

  test("hard-caps pages and advances deterministically through equal sort keys", async () => {
    resetScanStats();
    spaces.splice(0, spaces.length, makeSpace("space-a", "Space A"));
    folders.splice(0, folders.length);
    items.splice(0, items.length);
    for (let index = 0; index < 205; index += 1) {
      const item = makeItem(
        `same-${String(index).padStart(4, "0")}`,
        "live-folder",
        "space-a",
        true
      );
      item.title = "Same title";
      items.push(item);
    }

    const first = await binController.listContents({ limit: 10_000 });
    const second = await binController.listContents({
      limit: 10_000,
      after: first.nextCursor,
    });

    expect(first.entries).toHaveLength(MAX_BIN_PAGE_SIZE);
    expect(first.total).toBe(205);
    expect(first.hasMore).toBe(true);
    expect(second.entries).toHaveLength(5);
    expect(second.total).toBe(205);
    expect(second.hasMore).toBe(false);
    expect(second.nextCursor).toBeNull();
    expect(second.entries[0]?.id).toBe("same-0200");
  });

  test("handles malformed folder cycles without looping or hiding their individual tabs", async () => {
    resetScanStats();
    spaces.splice(0, spaces.length, makeSpace("space-a", "Space A"));
    folders.splice(
      0,
      folders.length,
      makeFolder("cycle-a", "cycle-b", true),
      makeFolder("cycle-b", "cycle-a", true)
    );
    items.splice(
      0,
      items.length,
      makeItem("cycle-tab", "cycle-a", "space-a", true)
    );

    const page = await binController.listContents();

    expect(page.total).toBe(1);
    expect(page.entries.map((entry) => `${entry.kind}:${entry.id}`)).toEqual([
      "item:cycle-tab",
    ]);
  });

  test("surfaces a malformed cross-space child as its own actionable Bin root", async () => {
    resetScanStats();
    spaces.splice(
      0,
      spaces.length,
      makeSpace("space-a", "Space A"),
      makeSpace("space-b", "Space B")
    );
    const parent = makeFolder("parent-a", null, true);
    const crossSpaceChild = makeFolder("child-b", "parent-a", true);
    crossSpaceChild.spaceId = "space-b";
    folders.splice(0, folders.length, parent, crossSpaceChild);
    items.splice(
      0,
      items.length,
      makeItem("child-tab", "child-b", "space-b", true)
    );

    const page = await binController.listContents();
    const byId = new Map(page.entries.map((entry) => [entry.id, entry]));

    expect(page.total).toBe(2);
    expect(byId.get("parent-a")?.itemCount).toBe(0);
    expect(byId.get("child-b")?.kind).toBe("folder");
    expect(byId.get("child-b")?.itemCount).toBe(1);
  });

  test("pages a wide/deep bin with bounded document retention and linear field reads", async () => {
    resetScanStats();
    spaces.splice(0, spaces.length, makeSpace("space-a", "Space A"));

    const folderCount = 2_500;
    const coveredItemCount = 5_000;
    const individualItemCount = 5_000;
    folders.splice(0, folders.length);
    for (let index = 0; index < folderCount; index += 1) {
      const id = `folder-${String(index).padStart(5, "0")}`;
      const parentId = index === 0 ? null : `folder-${String(index - 1).padStart(5, "0")}`;
      const folder = makeFolder(id, parentId, true);
      if (index === 0) folder.name = "00 root tree";
      folders.push(folder);
    }

    items.splice(0, items.length);
    const deepestFolderId = `folder-${String(folderCount - 1).padStart(5, "0")}`;
    for (let index = 0; index < coveredItemCount; index += 1) {
      const item = makeItem(
        `covered-${String(index).padStart(5, "0")}`,
        deepestFolderId,
        "space-a",
        true
      );
      item.textContent = "large body ".repeat(128);
      item.media = [
        {
          type: "image",
          originalUrl: `https://example.com/media/${index}`,
          storageType: "hotlink",
        },
      ];
      items.push(item);
    }
    for (let index = 0; index < individualItemCount; index += 1) {
      const item = makeItem(
        `item-${String(index).padStart(5, "0")}`,
        "live-folder",
        "space-a",
        true
      );
      item.textContent = "large body ".repeat(128);
      item.media = [
        {
          type: "image",
          originalUrl: `https://example.com/media/individual/${index}`,
          storageType: "hotlink",
        },
      ];
      items.push(item);
    }

    const first = await binController.listContents({ limit: 75 });
    const firstQueryCount = scanStats.queries;
    const second = await binController.listContents({
      limit: 75,
      after: first.nextCursor,
    });

    expect(first.entries).toHaveLength(75);
    expect(first.total).toBe(individualItemCount + 1);
    expect(first.hasMore).toBe(true);
    expect(first.nextCursor).not.toBeNull();
    expect(first.entries[0]?.id).toBe("folder-00000");
    expect(first.entries[0]?.itemCount).toBe(coveredItemCount);
    expect(second.entries).toHaveLength(75);
    expect(second.total).toBe(first.total);
    const firstIds = new Set(first.entries.map((entry) => entry.id));
    expect(second.entries.some((entry) => firstIds.has(entry.id))).toBe(false);
    expect(compareBinEntries(first.entries.at(-1)!, second.entries[0]!)).toBeLessThan(0);

    // Each collection query is capped at 200 RxDocuments. Full item JSON,
    // including the large text/media fields above, is never cloned or read.
    expect(scanStats.maxBatch).toBeLessThanOrEqual(MAX_BIN_PAGE_SIZE);
    expect(scanStats.mutableJsonCalls).toBe(0);
    expect(scanStats.fieldsRead.has("textContent")).toBe(false);
    expect(scanStats.fieldsRead.has("media")).toBe(false);
    expect(firstQueryCount).toBeLessThan(70);
    expect(scanStats.queries).toBeLessThan(140);
    expect(scanStats.fieldReads).toBeLessThan((folderCount + items.length) * 20);
  });
});
