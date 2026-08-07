import { describe, expect, mock, test } from "bun:test";
import type { FolderDocType } from "../src/schemas/folder_schema";
import type { ItemDocType } from "../src/schemas/item_schema";
import type { SpaceDocType } from "../src/schemas/space_schema";
import { PRIVATE_SPACE_ID } from "../src/common/spaces";

type Row = { id: string; [key: string]: unknown };

type Deferred = {
  promise: Promise<void>;
  resolve: () => void;
};

const deferred = (): Deferred => {
  let resolve = () => {};
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
};

let beforePatch: ((row: Row, patch: Record<string, unknown>) => Promise<void>) | null = null;
let beforeRemove: ((row: Row) => Promise<void>) | null = null;
let beforeInsert: ((row: Row) => Promise<void>) | null = null;

class FakeDoc<T extends Row> {
  constructor(
    private rows: T[],
    private row: T
  ) {}

  get primary(): string {
    return this.row.id;
  }

  get(key: string): unknown {
    return this.row[key];
  }

  toMutableJSON(): T {
    return { ...this.row };
  }

  async patch(patch: Partial<T>): Promise<void> {
    await beforePatch?.(this.row, patch);
    Object.assign(this.row, patch);
  }

  async incrementalPatch(patch: Partial<T>): Promise<void> {
    await this.patch(patch);
  }

  async remove(): Promise<void> {
    await beforeRemove?.(this.row);
    const index = this.rows.findIndex((entry) => entry.id === this.row.id);
    if (index >= 0) this.rows.splice(index, 1);
  }
}

const matchesSelector = (row: Row, selector?: Record<string, any>): boolean => {
  if (!selector) return true;
  return Object.entries(selector).every(([key, condition]) => {
    const value = row[key];
    if (condition && typeof condition === "object" && !Array.isArray(condition)) {
      if ("$eq" in condition) return value === condition.$eq;
      if ("$gt" in condition) {
        return (
          (typeof value === "number" || typeof value === "string") &&
          value > condition.$gt
        );
      }
      if ("$in" in condition) return Array.isArray(condition.$in) && condition.$in.includes(value);
    }
    return value === condition;
  });
};

const collection = <T extends Row>(rows: T[]) => ({
  find: (query?: {
    selector?: Record<string, any>;
    sort?: Array<Record<string, "asc" | "desc">>;
    limit?: number;
  }) => ({
    exec: async () =>
      rows
        .filter((row) => matchesSelector(row, query?.selector))
        .sort((left, right) => {
          const sort = query?.sort?.[0];
          if (!sort) return 0;
          const [field, direction] = Object.entries(sort)[0];
          const leftValue = left[field] as string | number;
          const rightValue = right[field] as string | number;
          const comparison = leftValue < rightValue ? -1 : leftValue > rightValue ? 1 : 0;
          return direction === "desc" ? -comparison : comparison;
        })
        .slice(0, query?.limit ?? rows.length)
        .map((row) => new FakeDoc(rows, row)),
  }),
  count: (query?: { selector?: Record<string, any> }) => ({
    exec: async () => rows.filter((row) => matchesSelector(row, query?.selector)).length,
  }),
  findOne: (id: string) => ({
    exec: async () => {
      const row = rows.find((entry) => entry.id === id);
      return row ? new FakeDoc(rows, row) : null;
    },
  }),
  insert: async (row: T) => {
    await beforeInsert?.(row);
    rows.push(row);
    return new FakeDoc(rows, row);
  },
  bulkInsert: async (nextRows: T[]) => {
    for (const row of nextRows) {
      await beforeInsert?.(row);
      rows.push(row);
    }
    return { success: nextRows, error: [] };
  },
  bulkUpsert: async (nextRows: T[]) => {
    for (const row of nextRows) {
      const existing = rows.find((entry) => entry.id === row.id);
      if (existing) Object.assign(existing, row);
      else rows.push(row);
    }
    return nextRows.map((row) => new FakeDoc(rows, row));
  },
});

const folders: FolderDocType[] = [];
const items: ItemDocType[] = [];
const spaces: SpaceDocType[] = [];
let db = {
  spaces: collection(spaces),
  folders: collection(folders),
  items: collection(items),
};

mock.module("@src/services/DatabaseService", () => ({
  getDb: async () => db,
}));

mock.module("@src/services/db-manager", () => ({
  databaseManager: {
    deleteItem: async ({ id }: { id: string }) => {
      const item = items.find((entry) => entry.id === id);
      if (item) item.deletedAt = Date.now();
    },
  },
}));

const { FoldersController, foldersController } = await import("../src/services/controllers/folders.controller");
const { ItemsController } = await import("../src/services/controllers/items.controller");
const { SpacesController } = await import("../src/services/controllers/spaces.controller");
const { withEntityMutationLock } = await import("../src/services/entity-mutation-lock");

const now = 1_764_000_000_000;

const makeFolder = (id: string, parentId: string | null = null): FolderDocType => ({
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
  deletedAt: 0,
  purgeAt: 0,
  isDirty: false,
  serverVersion: 0,
  createdAt: now,
  updatedAt: now,
});

const makeItem = (id: string, folderId: string): ItemDocType =>
  ({
    id,
    userId: "user1",
    title: id,
    textContent: "",
    url: `https://example.com/${id}`,
    source: "web",
    folderId,
    spaceId: "space-a",
    isFavorite: false,
    parentId: null,
    vector_index: -1,
    vector_indexes: [],
    isEmbedded: false,
    isMetaFetched: true,
    isDirty: false,
    serverVersion: 0,
    createdAt: now,
    updatedAt: now,
    deletedAt: 0,
  }) as ItemDocType;

const makeSpace = (id: string, deletedAt = 0): SpaceDocType =>
  ({
    id,
    name: id,
    slug: id,
    spaceGroupId: null,
    isPrivate: false,
    autoLockMs: 0,
    sortOrder: 0,
    isArchived: false,
    deletedAt,
    purgeAt: deletedAt > 0 ? deletedAt + 1 : 0,
    createdAt: now,
    updatedAt: now,
  }) as SpaceDocType;

describe("folder tree deletion", () => {
  test("counts and deletes nested tab group items with the root folder", async () => {
    spaces.splice(0, spaces.length, makeSpace("space-a"));
    folders.splice(
      0,
      folders.length,
      makeFolder("root"),
      makeFolder("child", "root"),
      makeFolder("grandchild", "child"),
      makeFolder("sibling")
    );
    items.splice(
      0,
      items.length,
      makeItem("root-item", "root"),
      makeItem("child-item", "child"),
      makeItem("grandchild-item", "grandchild"),
      makeItem("sibling-item", "sibling")
    );

    await expect(foldersController.countItemsInTree({ ids: ["root"] })).resolves.toEqual({
      root: 3,
    });

    const result = await foldersController.delete({ id: "root", alsoDeleteItems: true });

    expect(result).toEqual({ success: true });
    expect(folders.map((folder) => folder.id)).toEqual(["root", "child", "grandchild", "sibling"]);
    expect(folders.filter((folder) => (folder.deletedAt || 0) > 0).map((folder) => folder.id)).toEqual([
      "root",
      "child",
      "grandchild",
    ]);
    expect(folders.find((folder) => folder.id === "sibling")?.deletedAt || 0).toBe(0);
    expect(items.filter((item) => item.deletedAt > 0).map((item) => item.id)).toEqual([
      "root-item",
      "child-item",
      "grandchild-item",
    ]);
    expect(items.find((item) => item.id === "sibling-item")?.deletedAt).toBe(0);
  });

  test("counts a large folder tree without materializing item documents", async () => {
    spaces.splice(0, spaces.length, makeSpace("space-a"));
    folders.splice(0, folders.length, makeFolder("root"), makeFolder("child", "root"));
    items.splice(
      0,
      items.length,
      ...Array.from({ length: 451 }, (_, index) =>
        makeItem(`item-${String(index).padStart(4, "0")}`, index % 2 === 0 ? "root" : "child")
      )
    );
    const originalFind = db.items.find;
    db.items.find = (() => {
      throw new Error("countItemsInTree must use the native count query");
    }) as typeof db.items.find;

    try {
      await expect(foldersController.countItemsInTree({ ids: ["root"] })).resolves.toEqual({
        root: 451,
      });
    } finally {
      db.items.find = originalFind;
    }
  });

  test("keep-items relocates a nested tree to a live root before the folder enters Bin", async () => {
    spaces.splice(0, spaces.length, makeSpace("space-a"));
    folders.splice(
      0,
      folders.length,
      makeFolder("root"),
      makeFolder("child", "root"),
      makeFolder("grandchild", "child"),
      makeFolder("sibling")
    );
    items.splice(
      0,
      items.length,
      makeItem("root-item", "root"),
      makeItem("child-item", "child"),
      makeItem("grandchild-item", "grandchild"),
      makeItem("sibling-item", "sibling")
    );

    await expect(
      foldersController.delete({ id: "root", alsoDeleteItems: false })
    ).resolves.toEqual({ success: true });

    const recovery = folders.find(
      (folder) => !["root", "child", "grandchild", "sibling"].includes(folder.id)
    );
    expect(recovery).toMatchObject({
      spaceId: "space-a",
      parentId: null,
      type: "tab_group",
      deletedAt: 0,
      purgeAt: 0,
    });
    expect(recovery?.name).toContain("Kept tabs from root");
    expect(
      folders
        .filter((folder) => ["root", "child", "grandchild"].includes(folder.id))
        .every((folder) => folder.deletedAt > 0)
    ).toBe(true);
    expect(
      items
        .filter((item) => item.id !== "sibling-item")
        .map((item) => ({ folderId: item.folderId, spaceId: item.spaceId, deletedAt: item.deletedAt }))
    ).toEqual([
      { folderId: recovery?.id, spaceId: "space-a", deletedAt: 0 },
      { folderId: recovery?.id, spaceId: "space-a", deletedAt: 0 },
      { folderId: recovery?.id, spaceId: "space-a", deletedAt: 0 },
    ]);

    // The scheduled janitor only purges explicitly binned spaces. A folder's
    // retention label must never make it sweep relocated live rows by itself.
    const purgeAt = folders.find((folder) => folder.id === "root")?.purgeAt || now;
    const purge = await new SpacesController({
      getDb: async () => db as never,
      now: () => purgeAt + 1,
    }).purgeExpired();
    expect(purge.purgedSpaceIds).toEqual([]);
    expect(items.filter((item) => item.deletedAt === 0)).toHaveLength(4);
    expect(folders.some((folder) => folder.id === recovery?.id)).toBe(true);
  });

  test("permanent folder deletion preserves legacy live descendants in a nested tree", async () => {
    spaces.splice(0, spaces.length, makeSpace("space-a"));
    const root = makeFolder("legacy-root");
    root.deletedAt = now;
    root.purgeAt = now + 1;
    const child = makeFolder("legacy-child", "legacy-root");
    child.deletedAt = now;
    child.purgeAt = now + 1;
    folders.splice(0, folders.length, root, child, makeFolder("sibling"));
    items.splice(
      0,
      items.length,
      makeItem("legacy-root-item", "legacy-root"),
      makeItem("legacy-child-item", "legacy-child"),
      makeItem("sibling-item", "sibling")
    );

    const result = await new FoldersController().deleteForever({
      id: "legacy-root",
      expectedDeletedAt: now,
    });

    expect(result).toEqual({ success: true, removedItems: 0, removedFolders: 2 });
    expect(folders.some((folder) => folder.id === "legacy-root")).toBe(false);
    expect(folders.some((folder) => folder.id === "legacy-child")).toBe(false);
    const recovery = folders.find((folder) => folder.name.includes("Kept tabs from legacy-root"));
    expect(recovery).toMatchObject({
      spaceId: "space-a",
      parentId: null,
      deletedAt: 0,
    });
    expect(items.find((item) => item.id === "legacy-root-item")).toMatchObject({
      folderId: recovery?.id,
      spaceId: "space-a",
      deletedAt: 0,
    });
    expect(items.find((item) => item.id === "legacy-child-item")).toMatchObject({
      folderId: recovery?.id,
      spaceId: "space-a",
      deletedAt: 0,
    });
    expect(items.find((item) => item.id === "sibling-item")?.folderId).toBe("sibling");
  });

  test("does not clean folder-item OPFS when RxDB rejects the item removal", async () => {
    spaces.splice(0, spaces.length, makeSpace("space-a"));
    const root = makeFolder("remove-fails-root");
    root.deletedAt = now;
    root.purgeAt = now + 1;
    const item = makeItem("remove-fails-item", root.id);
    item.deletedAt = now;
    folders.splice(0, folders.length, root);
    items.splice(0, items.length, item);
    let cleanupCalls = 0;
    beforeRemove = async (row) => {
      if (row.id === item.id) throw new Error("RXDB_ITEM_REMOVE_REJECTED");
    };

    try {
      const controller = new FoldersController({
        deleteUnreferencedOpfsItemDirectories: async () => {
          cleanupCalls += 1;
          return [];
        },
      });
      await expect(
        controller.deleteForever({ id: root.id, expectedDeletedAt: now })
      ).rejects.toThrow("RXDB_ITEM_REMOVE_REJECTED");
      expect(cleanupCalls).toBe(0);
      expect(items.some((row) => row.id === item.id)).toBe(true);
      expect(folders.some((row) => row.id === root.id)).toBe(true);
    } finally {
      beforeRemove = null;
    }
  });

  test("cleans folder-item OPFS only after the removed page is gone", async () => {
    spaces.splice(0, spaces.length, makeSpace("space-a"));
    const root = makeFolder("remove-succeeds-root");
    root.deletedAt = now;
    root.purgeAt = now + 1;
    const item = makeItem("remove-succeeds-item", root.id);
    item.deletedAt = now;
    folders.splice(0, folders.length, root);
    items.splice(0, items.length, item);
    let itemExistedDuringCleanup = true;

    const result = await new FoldersController({
      deleteUnreferencedOpfsItemDirectories: async () => {
        itemExistedDuringCleanup = items.some((row) => row.id === item.id);
        return [item.id];
      },
    }).deleteForever({ id: root.id, expectedDeletedAt: now });

    expect(result).toEqual({ success: true, removedItems: 1, removedFolders: 1 });
    expect(itemExistedDuringCleanup).toBe(false);
  });

  test("restores a deleted folder tree and its deleted items", async () => {
    spaces.splice(0, spaces.length, makeSpace("space-a"));
    folders.splice(
      0,
      folders.length,
      makeFolder("root"),
      makeFolder("child", "root"),
      makeFolder("sibling")
    );
    items.splice(
      0,
      items.length,
      makeItem("root-item", "root"),
      makeItem("child-item", "child"),
      makeItem("sibling-item", "sibling")
    );

    await foldersController.delete({ id: "root", alsoDeleteItems: true });
    const result = await foldersController.restoreFromBin({ id: "root" });

    expect(result.success).toBe(true);
    expect(result.restoredItems).toBe(2);
    expect(folders.filter((folder) => (folder.deletedAt || 0) > 0).map((folder) => folder.id)).toEqual([]);
    expect(items.filter((item) => item.deletedAt > 0).map((item) => item.id)).toEqual([]);
    expect(folders.find((folder) => folder.id === "child")?.parentId).toBe("root");
    expect(items.find((item) => item.id === "root-item")?.folderId).toBe("root");
    expect(items.find((item) => item.id === "child-item")?.folderId).toBe("child");
  });

  test("restores a folder tree into a fallback space when the original space is in bin", async () => {
    spaces.splice(
      0,
      spaces.length,
      makeSpace("space-a", now),
      makeSpace("space_public_default")
    );
    folders.splice(0, folders.length, makeFolder("root"), makeFolder("child", "root"));
    items.splice(0, items.length, makeItem("root-item", "root"), makeItem("child-item", "child"));

    await foldersController.delete({ id: "root", alsoDeleteItems: true });
    const result = await foldersController.restoreFromBin({ id: "root" });

    expect(result.success).toBe(true);
    expect(result.relocated).toBe(true);
    expect(result.message).toContain("Heads up");
    expect(folders.find((folder) => folder.id === "root")?.spaceId).toBe("space_public_default");
    expect(folders.find((folder) => folder.id === "root")?.parentId).toBe(null);
    expect(folders.find((folder) => folder.id === "child")?.parentId).toBe("root");
    expect(items.find((item) => item.id === "root-item")?.spaceId).toBe("space_public_default");
    expect(items.find((item) => item.id === "child-item")?.spaceId).toBe("space_public_default");
  });

  test("a restore that wins prevents a stale tab from permanently deleting the live folder", async () => {
    spaces.splice(0, spaces.length, makeSpace("space-a"));
    const root = makeFolder("folder-race");
    root.deletedAt = now;
    root.purgeAt = now + 1;
    folders.splice(0, folders.length, root);
    items.splice(0, items.length);

    const restorePatchStarted = deferred();
    const allowRestorePatch = deferred();
    let removeCalls = 0;
    beforePatch = async (row, patch) => {
      if (row.id === "folder-race" && patch.deletedAt === 0) {
        restorePatchStarted.resolve();
        await allowRestorePatch.promise;
      }
    };
    beforeRemove = async (row) => {
      if (row.id === "folder-race") removeCalls += 1;
    };

    try {
      const restoreController = new FoldersController();
      const deleteController = new FoldersController();
      const restorePromise = restoreController.restoreFromBin({ id: "folder-race" });
      await restorePatchStarted.promise;
      const deletePromise = deleteController.deleteForever({
        id: "folder-race",
        expectedDeletedAt: now,
      });
      const outcomesPromise = Promise.allSettled([restorePromise, deletePromise]);

      allowRestorePatch.resolve();
      const [restoreOutcome, deleteOutcome] = await outcomesPromise;
      expect(restoreOutcome).toMatchObject({
        status: "fulfilled",
        value: { success: true },
      });
      expect(deleteOutcome).toMatchObject({
        status: "rejected",
        reason: expect.objectContaining({ message: "FOLDER_NOT_IN_BIN" }),
      });

      expect(removeCalls).toBe(0);
      expect(folders.find((folder) => folder.id === "folder-race")?.deletedAt).toBe(0);
    } finally {
      beforePatch = null;
      beforeRemove = null;
      allowRestorePatch.resolve();
    }
  });

  test("a permanent delete that wins cannot be followed by a stale folder restore", async () => {
    spaces.splice(0, spaces.length, makeSpace("space-a"));
    const root = makeFolder("folder-race");
    root.deletedAt = now;
    root.purgeAt = now + 1;
    folders.splice(0, folders.length, root);
    items.splice(0, items.length);

    const removeStarted = deferred();
    const allowRemove = deferred();
    beforeRemove = async (row) => {
      if (row.id !== "folder-race") return;
      removeStarted.resolve();
      await allowRemove.promise;
    };

    try {
      const deleteController = new FoldersController();
      const restoreController = new FoldersController();
      const deletePromise = deleteController.deleteForever({
        id: "folder-race",
        expectedDeletedAt: now,
      });
      await removeStarted.promise;
      const restorePromise = restoreController.restoreFromBin({ id: "folder-race" });

      allowRemove.resolve();
      await expect(deletePromise).resolves.toMatchObject({
        success: true,
        removedFolders: 1,
      });
      await expect(restorePromise).resolves.toEqual({
        success: false,
        restoredItems: 0,
        error: "NOT_FOUND",
      });
      expect(folders.some((folder) => folder.id === "folder-race")).toBe(false);
    } finally {
      beforePatch = null;
      beforeRemove = null;
      allowRemove.resolve();
    }
  });

  test("a child-item restore completes before a concurrent parent-folder hard delete", async () => {
    spaces.splice(0, spaces.length, makeSpace("space-a"));
    const root = makeFolder("folder-race");
    root.deletedAt = now;
    root.purgeAt = now + 1;
    const childItem = makeItem("child-item", "folder-race");
    childItem.deletedAt = now;
    folders.splice(0, folders.length, root);
    items.splice(0, items.length, childItem);

    const childPatchStarted = deferred();
    const allowChildPatch = deferred();
    beforePatch = async (row, patch) => {
      if (row.id !== "child-item" || patch.deletedAt !== 0) return;
      childPatchStarted.resolve();
      await allowChildPatch.promise;
    };

    try {
      const itemController = new ItemsController();
      const folderController = new FoldersController();
      const restorePromise = itemController.restoreFromBin({ id: "child-item" });
      await childPatchStarted.promise;
      const deletePromise = folderController.deleteForever({
        id: "folder-race",
        expectedDeletedAt: now,
      });
      const outcomesPromise = Promise.allSettled([restorePromise, deletePromise]);

      allowChildPatch.resolve();
      const [restoreOutcome, deleteOutcome] = await outcomesPromise;
      expect(restoreOutcome).toMatchObject({
        status: "fulfilled",
        value: { success: true },
      });
      expect(deleteOutcome).toMatchObject({
        status: "fulfilled",
        value: { success: true, removedItems: 0, removedFolders: 1 },
      });

      const restoredItem = items.find((item) => item.id === "child-item");
      expect(restoredItem?.deletedAt).toBe(0);
      expect(restoredItem?.folderId).not.toBe("folder-race");
      expect(folders.some((folder) => folder.id === restoredItem?.folderId)).toBe(true);
      expect(folders.some((folder) => folder.id === "folder-race")).toBe(false);
    } finally {
      beforePatch = null;
      beforeRemove = null;
      allowChildPatch.resolve();
    }
  });
});

describe("folder live destination writes", () => {
  test("a parent-space bin that wins makes concurrent folder creation reject", async () => {
    spaces.splice(0, spaces.length, makeSpace("space-a"));
    folders.splice(0, folders.length);
    items.splice(0, items.length);
    const binPatchStarted = deferred();
    const allowBinPatch = deferred();
    beforePatch = async (row, patch) => {
      if (row.id === "space-a" && typeof patch.deletedAt === "number" && patch.deletedAt > 0) {
        binPatchStarted.resolve();
        await allowBinPatch.promise;
      }
    };

    try {
      const binPromise = new SpacesController({ getDb: async () => db, now: () => now + 10 })
        .moveToBin({ id: "space-a" });
      await binPatchStarted.promise;
      const createPromise = new FoldersController().create({
        name: "late folder",
        spaceId: "space-a",
      });
      const outcomes = Promise.allSettled([binPromise, createPromise]);
      allowBinPatch.resolve();

      await expect(outcomes).resolves.toMatchObject([
        { status: "fulfilled", value: { success: true } },
        {
          status: "rejected",
          reason: expect.objectContaining({ message: "DESTINATION_SPACE_NOT_LIVE" }),
        },
      ]);
      expect(folders).toHaveLength(0);
    } finally {
      beforePatch = null;
      beforeInsert = null;
      allowBinPatch.resolve();
    }
  });

  test("rejects creating a child under a binned parent in a live space", async () => {
    spaces.splice(0, spaces.length, makeSpace("space-a"));
    const parent = makeFolder("binned-parent");
    parent.deletedAt = now;
    parent.purgeAt = now + 1;
    folders.splice(0, folders.length, parent);
    items.splice(0, items.length);

    await expect(
      new FoldersController().create({
        name: "child",
        spaceId: "space-a",
        parentId: "binned-parent",
      })
    ).rejects.toThrow("DESTINATION_FOLDER_NOT_LIVE");
    expect(folders).toHaveLength(1);
  });

  test("moves an entire nested folder tree and its items across spaces", async () => {
    spaces.splice(0, spaces.length, makeSpace("space-a"), makeSpace("space-b"));
    const outside = makeFolder("outside");
    const root = makeFolder("root", "outside");
    const child = makeFolder("child", "root");
    const grandchild = makeFolder("grandchild", "child");
    folders.splice(0, folders.length, outside, root, child, grandchild);
    items.splice(
      0,
      items.length,
      makeItem("root-item", "root"),
      makeItem("child-item", "child"),
      makeItem("grandchild-item", "grandchild")
    );

    await expect(
      new FoldersController().moveToSpace({ folderId: "root", targetSpaceId: "space-b" })
    ).resolves.toEqual({ success: true, movedItems: 3 });

    expect(folders.find((folder) => folder.id === "outside")?.spaceId).toBe("space-a");
    expect(folders.find((folder) => folder.id === "root")).toMatchObject({
      spaceId: "space-b",
      parentId: null,
    });
    expect(folders.find((folder) => folder.id === "child")).toMatchObject({
      spaceId: "space-b",
      parentId: "root",
    });
    expect(folders.find((folder) => folder.id === "grandchild")).toMatchObject({
      spaceId: "space-b",
      parentId: "child",
    });
    expect(items.every((item) => item.spaceId === "space-b")).toBe(true);
  });

  test("can retry a partially failed folder move without stranding remaining items", async () => {
    spaces.splice(0, spaces.length, makeSpace("space-a"), makeSpace("space-b"));
    folders.splice(0, folders.length, makeFolder("root"), makeFolder("child", "root"));
    items.splice(
      0,
      items.length,
      makeItem("item-a", "root"),
      makeItem("item-b", "child")
    );
    let failOnce = true;
    beforePatch = async (row, patch) => {
      if (row.id === "item-b" && patch.spaceId === "space-b" && failOnce) {
        failOnce = false;
        throw new Error("injected item write failure");
      }
    };

    try {
      await expect(
        new FoldersController().moveToSpace({ folderId: "root", targetSpaceId: "space-b" })
      ).rejects.toThrow("injected item write failure");
      expect(folders.find((folder) => folder.id === "root")?.spaceId).toBe("space-a");
      expect(folders.find((folder) => folder.id === "child")?.spaceId).toBe("space-a");
      expect(items.find((item) => item.id === "item-a")?.spaceId).toBe("space-b");
      expect(items.find((item) => item.id === "item-b")?.spaceId).toBe("space-a");

      await expect(
        new FoldersController().moveToSpace({ folderId: "root", targetSpaceId: "space-b" })
      ).resolves.toEqual({ success: true, movedItems: 2 });
      expect(folders.every((folder) => folder.spaceId === "space-b")).toBe(true);
      expect(items.every((item) => item.spaceId === "space-b")).toBe(true);
    } finally {
      beforePatch = null;
    }
  });

  test("serializes each moved item so a concurrent delete cannot be resurrected", async () => {
    spaces.splice(0, spaces.length, makeSpace("space-a"), makeSpace("space-b"));
    folders.splice(0, folders.length, makeFolder("root"));
    items.splice(0, items.length, makeItem("root-item", "root"));
    const itemPatchStarted = deferred();
    const allowItemPatch = deferred();
    beforePatch = async (row, patch) => {
      if (row.id === "root-item" && patch.spaceId === "space-b") {
        itemPatchStarted.resolve();
        await allowItemPatch.promise;
      }
    };

    try {
      const move = new FoldersController().moveToSpace({
        folderId: "root",
        targetSpaceId: "space-b",
      });
      await itemPatchStarted.promise;

      let deleteRan = false;
      const concurrentDelete = withEntityMutationLock(db, "item", "root-item", async () => {
        deleteRan = true;
        const item = items.find((row) => row.id === "root-item");
        if (item) item.deletedAt = now + 100;
      });
      await Promise.resolve();
      expect(deleteRan).toBe(false);

      allowItemPatch.resolve();
      await expect(move).resolves.toEqual({ success: true, movedItems: 1 });
      await concurrentDelete;

      expect(items[0]).toMatchObject({
        spaceId: "space-b",
        deletedAt: now + 100,
      });
    } finally {
      beforePatch = null;
      allowItemPatch.resolve();
    }
  });

  test("copies an entire nested folder tree with remapped parents and items", async () => {
    spaces.splice(0, spaces.length, makeSpace("space-a"), makeSpace("space-b"));
    folders.splice(0, folders.length, makeFolder("root"), makeFolder("child", "root"));
    const rootItem = makeItem("root-item", "root");
    rootItem.media = [
      {
        type: "image",
        originalUrl: "local.png",
        storageType: "opfs",
        opfsPath: "media/root-item/local.png",
      },
    ];
    items.splice(
      0,
      items.length,
      rootItem,
      makeItem("child-item", "child")
    );

    const result = await new FoldersController({
      cloneOpfsMediaEntriesForItem: async (media, destinationItemId) => ({
        media: (media || []).map((entry) => ({
          ...entry,
          opfsPath: `media/${destinationItemId}/independent.png`,
        })),
        pathMap: new Map([
          ["media/root-item/local.png", `media/${destinationItemId}/independent.png`],
        ]),
      }),
    }).copyToSpace({
      folderId: "root",
      targetSpaceId: "space-b",
    });

    expect(result).toMatchObject({ success: true, copiedItems: 2 });
    const copiedRoot = folders.find((folder) => folder.id === result.folderId);
    const copiedChild = folders.find(
      (folder) => folder.spaceId === "space-b" && folder.parentId === copiedRoot?.id
    );
    expect(copiedRoot).toMatchObject({ spaceId: "space-b", parentId: null });
    expect(copiedChild?.name).toBe("child");
    expect(items.filter((item) => item.spaceId === "space-b")).toHaveLength(2);
    expect(
      items.some((item) => item.spaceId === "space-b" && item.folderId === copiedChild?.id)
    ).toBe(true);
    const copiedRootItem = items.find(
      (item) => item.spaceId === "space-b" && item.folderId === copiedRoot?.id
    );
    expect(copiedRootItem?.media?.[0]?.opfsPath).toBe(
      `media/${copiedRootItem?.id}/independent.png`
    );
    expect(rootItem.media?.[0]?.opfsPath).toBe("media/root-item/local.png");
  });

  test("rejects destructive folder merges across spaces", async () => {
    spaces.splice(0, spaces.length, makeSpace("space-a"), makeSpace("space-b"));
    const source = makeFolder("source");
    const target = makeFolder("target");
    target.spaceId = "space-b";
    folders.splice(0, folders.length, source, target);
    items.splice(0, items.length, makeItem("source-item", "source"));

    await expect(
      new FoldersController().mergeInto({
        sourceFolderId: "source",
        targetFolderId: "target",
      })
    ).resolves.toEqual({
      success: false,
      movedItems: 0,
      error: "CROSS_SPACE_MERGE_NOT_ALLOWED",
    });
    expect(folders.map((folder) => folder.id)).toEqual(["source", "target"]);
    expect(items[0]).toMatchObject({ folderId: "source", spaceId: "space-a" });
  });

  test("rejects folder copies into a locked private destination space", async () => {
    const privateSpace = makeSpace(PRIVATE_SPACE_ID);
    privateSpace.isPrivate = true;
    spaces.splice(0, spaces.length, makeSpace("space-a"), privateSpace);
    folders.splice(0, folders.length, makeFolder("root"));
    items.splice(0, items.length, makeItem("root-item", "root"));

    await expect(
      new FoldersController().copyToSpace({
        folderId: "root",
        targetSpaceId: PRIVATE_SPACE_ID,
      })
    ).rejects.toThrow("PRIVATE_SPACE_LOCKED");
    expect(folders).toHaveLength(1);
    expect(items).toHaveLength(1);
  });
});
