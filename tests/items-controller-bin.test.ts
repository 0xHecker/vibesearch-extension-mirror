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
          (typeof value === "number" && value > condition.$gt) ||
          (typeof value === "string" && value > condition.$gt)
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
    sort?: Array<{ id: "asc" | "desc" }>;
    limit?: number;
  }) => ({
    exec: async () => {
      let matched = rows.filter((row) => matchesSelector(row, query?.selector));
      const idDirection = query?.sort?.[0]?.id;
      if (idDirection) {
        matched = [...matched].sort((left, right) =>
          idDirection === "asc"
            ? left.id.localeCompare(right.id)
            : right.id.localeCompare(left.id)
        );
      }
      if (typeof query?.limit === "number") matched = matched.slice(0, query.limit);
      return matched.map((row) => new FakeDoc(rows, row));
    },
  }),
  findOne: (id: string) => ({
    exec: async () => {
      const row = rows.find((entry) => entry.id === id);
      return row ? new FakeDoc(rows, row) : null;
    },
  }),
  findByIds: (ids: string[]) => ({
    exec: async () =>
      new Map(
        rows
          .filter((row) => ids.includes(row.id))
          .map((row) => [row.id, new FakeDoc(rows, row)] as const)
      ),
  }),
  count: (query?: { selector?: Record<string, any> }) => ({
    exec: async () => rows.filter((row) => matchesSelector(row, query?.selector)).length,
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

const now = 1_764_000_000_000;
const spaces: SpaceDocType[] = [];
const folders: FolderDocType[] = [];
const items: ItemDocType[] = [];
const db = {
  spaces: collection(spaces),
  folders: collection(folders),
  items: collection(items),
};

mock.module("@src/services/DatabaseService", () => ({
  getDb: async () => db,
}));

const { ItemsController, itemsController } = await import("../src/services/controllers/items.controller");
const { SpacesController } = await import("../src/services/controllers/spaces.controller");
const {
  deleteUnreferencedOpfsFiles,
  deleteUnreferencedOpfsItemDirectories,
} = await import(
  "../src/services/opfs-media-lifecycle"
);

const makeSpace = (id: string): SpaceDocType =>
  ({
    id,
    name: id,
    slug: id,
    spaceGroupId: "",
    isPrivate: false,
    autoLockMs: 0,
    sortOrder: 0,
    isArchived: false,
    deletedAt: 0,
    purgeAt: 0,
    createdAt: now,
    updatedAt: now,
  }) as SpaceDocType;

const makeFolder = (id: string, deletedAt = 0, spaceId = "space-a"): FolderDocType => ({
  id,
  name: id,
  userId: "user1",
  spaceId,
  parentId: null,
  type: "tab_group",
  sortOrder: 0,
  isLocked: false,
  isPinned: false,
  isCollapsed: false,
  deletedAt,
  purgeAt: deletedAt > 0 ? deletedAt + 1 : 0,
  isDirty: false,
  serverVersion: 0,
  createdAt: now,
  updatedAt: now,
});

const makeItem = (
  id: string,
  folderId: string,
  deletedAt = now,
  spaceId = "space-a"
): ItemDocType =>
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
    createdAt: now,
    updatedAt: now,
    deletedAt,
  }) as ItemDocType;

const testOpfsIdentity = {
  size: 123,
  lastModified: 456,
  sampleSha256: "test-opfs-sample",
};

const promotionController = () =>
  new ItemsController({
    readOpfsFileIdentity: async () => testOpfsIdentity,
  });

describe("item bin restore", () => {
  test("restores an item into a new tab group when its original folder is in bin", async () => {
    spaces.splice(0, spaces.length, makeSpace("space-a"));
    folders.splice(0, folders.length, makeFolder("old-folder", now));
    items.splice(0, items.length, makeItem("tab-a", "old-folder"));

    const result = await itemsController.restoreFromBin({ id: "tab-a" });

    expect(result.success).toBe(true);
    expect(result.relocated).toBe(true);
    expect(result.message).toContain("Heads up");
    expect(folders).toHaveLength(2);
    const restoredFolder = folders.find((folder) => folder.id !== "old-folder");
    expect(restoredFolder?.name).toBe("Restored tabs");
    expect(restoredFolder?.spaceId).toBe("space-a");
    expect(items[0].deletedAt).toBe(0);
    expect(items[0].spaceId).toBe("space-a");
    expect(items[0].folderId).toBe(restoredFolder?.id);
  });

  test("a restore that wins prevents a stale tab from permanently deleting the live item", async () => {
    spaces.splice(0, spaces.length, makeSpace("space-a"));
    folders.splice(0, folders.length, makeFolder("folder-a"));
    items.splice(0, items.length, makeItem("tab-race", "folder-a"));

    const restorePatchStarted = deferred();
    const allowRestorePatch = deferred();
    let removeCalls = 0;
    beforePatch = async (row, patch) => {
      if (row.id === "tab-race" && patch.deletedAt === 0) {
        restorePatchStarted.resolve();
        await allowRestorePatch.promise;
      }
    };
    beforeRemove = async (row) => {
      if (row.id === "tab-race") removeCalls += 1;
    };

    try {
      const restoreController = new ItemsController();
      const deleteController = new ItemsController();
      const restorePromise = restoreController.restoreFromBin({ id: "tab-race" });
      await restorePatchStarted.promise;
      const deletePromise = deleteController.deleteForever({
        id: "tab-race",
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
        reason: expect.objectContaining({ message: "ITEM_NOT_IN_BIN" }),
      });

      expect(removeCalls).toBe(0);
      expect(items.find((item) => item.id === "tab-race")?.deletedAt).toBe(0);
    } finally {
      beforePatch = null;
      beforeRemove = null;
      allowRestorePatch.resolve();
    }
  });

  test("a permanent delete that wins cannot be followed by a stale restore", async () => {
    spaces.splice(0, spaces.length, makeSpace("space-a"));
    folders.splice(0, folders.length, makeFolder("folder-a"));
    items.splice(0, items.length, makeItem("tab-race", "folder-a"));

    const removeStarted = deferred();
    const allowRemove = deferred();
    beforeRemove = async (row) => {
      if (row.id !== "tab-race") return;
      removeStarted.resolve();
      await allowRemove.promise;
    };

    try {
      const deleteController = new ItemsController();
      const restoreController = new ItemsController();
      const deletePromise = deleteController.deleteForever({
        id: "tab-race",
        expectedDeletedAt: now,
      });
      await removeStarted.promise;
      const restorePromise = restoreController.restoreFromBin({ id: "tab-race" });

      allowRemove.resolve();
      await expect(deletePromise).resolves.toEqual({ success: true });
      await expect(restorePromise).resolves.toEqual({ success: false, error: "NOT_FOUND" });
      expect(items.some((item) => item.id === "tab-race")).toBe(false);
    } finally {
      beforePatch = null;
      beforeRemove = null;
      allowRemove.resolve();
    }
  });

  test("does not clean OPFS when standalone item removal is rejected", async () => {
    spaces.splice(0, spaces.length, makeSpace("space-a"));
    folders.splice(0, folders.length, makeFolder("folder-a"));
    items.splice(0, items.length, makeItem("remove-fails", "folder-a"));
    let cleanupCalls = 0;
    beforeRemove = async (row) => {
      if (row.id === "remove-fails") throw new Error("RXDB_REMOVE_REJECTED");
    };

    try {
      const controller = new ItemsController({
        deleteUnreferencedOpfsItemDirectories: async () => {
          cleanupCalls += 1;
          return [];
        },
      });
      await expect(
        controller.deleteForever({ id: "remove-fails", expectedDeletedAt: now })
      ).rejects.toThrow("RXDB_REMOVE_REJECTED");
      expect(cleanupCalls).toBe(0);
      expect(items.some((item) => item.id === "remove-fails")).toBe(true);
    } finally {
      beforeRemove = null;
    }
  });

  test("cleans standalone item OPFS only after the row is gone", async () => {
    spaces.splice(0, spaces.length, makeSpace("space-a"));
    folders.splice(0, folders.length, makeFolder("folder-a"));
    items.splice(0, items.length, makeItem("remove-succeeds", "folder-a"));
    let itemExistedDuringCleanup = true;

    const controller = new ItemsController({
      deleteUnreferencedOpfsItemDirectories: async () => {
        itemExistedDuringCleanup = items.some((item) => item.id === "remove-succeeds");
        return ["remove-succeeds"];
      },
    });
    await expect(
      controller.deleteForever({ id: "remove-succeeds", expectedDeletedAt: now })
    ).resolves.toEqual({ success: true });
    expect(itemExistedDuringCleanup).toBe(false);
  });

  test("an old Bin entry cannot delete a same-clock restore and re-bin incarnation", async () => {
    spaces.splice(0, spaces.length, makeSpace("space-a"));
    folders.splice(0, folders.length, makeFolder("folder-a"));
    items.splice(0, items.length, makeItem("tab-aba", "folder-a"));

    const originalDateNow = Date.now;
    Date.now = () => now;
    try {
      const controller = new ItemsController();
      await expect(controller.restoreFromBin({ id: "tab-aba" })).resolves.toMatchObject({
        success: true,
      });
      await expect(controller.delete({ id: "tab-aba" })).resolves.toEqual({ success: true });

      const nextDeletedAt = items.find((entry) => entry.id === "tab-aba")?.deletedAt || 0;
      expect(nextDeletedAt).toBeGreaterThan(now);
      await expect(
        controller.deleteForever({ id: "tab-aba", expectedDeletedAt: now })
      ).rejects.toThrow("ITEM_BIN_ENTRY_CHANGED");
      expect(items.find((entry) => entry.id === "tab-aba")?.deletedAt).toBe(nextDeletedAt);
    } finally {
      Date.now = originalDateNow;
    }
  });

  test("a concurrent re-bin invalidates a stale permanent-delete generation", async () => {
    spaces.splice(0, spaces.length, makeSpace("space-a"));
    folders.splice(0, folders.length, makeFolder("folder-a"));
    items.splice(0, items.length, makeItem("tab-rebin-race", "folder-a"));
    const rebinPatchStarted = deferred();
    const allowRebinPatch = deferred();
    beforePatch = async (row, patch) => {
      if (
        row.id === "tab-rebin-race" &&
        typeof patch.deletedAt === "number" &&
        patch.deletedAt > now
      ) {
        rebinPatchStarted.resolve();
        await allowRebinPatch.promise;
      }
    };

    try {
      const softDeletePromise = new ItemsController().delete({ id: "tab-rebin-race" });
      await rebinPatchStarted.promise;
      const hardDeletePromise = new ItemsController().deleteForever({
        id: "tab-rebin-race",
        expectedDeletedAt: now,
      });
      const outcomes = Promise.allSettled([softDeletePromise, hardDeletePromise]);
      allowRebinPatch.resolve();

      await expect(outcomes).resolves.toMatchObject([
        { status: "fulfilled", value: { success: true } },
        {
          status: "rejected",
          reason: expect.objectContaining({ message: "ITEM_BIN_ENTRY_CHANGED" }),
        },
      ]);
      expect(items[0].deletedAt).toBeGreaterThan(now);
    } finally {
      beforePatch = null;
      allowRebinPatch.resolve();
    }
  });
});

describe("item live destination writes", () => {
  test("pages OPFS media discovery without returning the full live library", async () => {
    spaces.splice(0, spaces.length, makeSpace("space-a"));
    folders.splice(0, folders.length, makeFolder("folder-a"));
    items.splice(
      0,
      items.length,
      ...Array.from({ length: 230 }, (_, index) => {
        const item = makeItem(
          `media-${index.toString().padStart(4, "0")}`,
          "folder-a",
          index % 41 === 0 ? now : 0
        );
        if (index % 17 === 0) {
          item.media = [
            {
              type: "image",
              originalUrl: `https://example.com/${index}.png`,
              storageType: "opfs",
              opfsPath: `media/${item.id}/capture.png`,
            },
          ];
        } else if (index % 19 === 0) {
          item.media = [
            {
              type: "image",
              originalUrl: `https://example.com/${index}.png`,
              storageType: "hotlink",
            },
          ];
        }
        return item;
      })
    );

    const discoveredIds: string[] = [];
    let afterId = "";
    let pageCount = 0;
    while (true) {
      const page = await new ItemsController().listItemsWithOpfsMedia({
        afterId,
        limit: 37,
      });
      pageCount += 1;
      expect(page.scannedCount).toBeLessThanOrEqual(37);
      expect(page.items.length).toBeLessThanOrEqual(page.scannedCount);
      discoveredIds.push(...page.items.map((item) => item.id));
      if (!page.hasMore) break;
      expect(page.nextCursor).toBeTruthy();
      expect((page.nextCursor as string) > afterId).toBe(true);
      afterId = page.nextCursor as string;
      expect(pageCount).toBeLessThan(10);
    }

    const expectedIds = items
      .filter((item) => item.deletedAt === 0)
      .filter((item) => item.media?.some((media) => media.opfsPath))
      .map((item) => item.id)
      .sort();
    expect(discoveredIds).toEqual(expectedIds);
    expect(pageCount).toBeGreaterThan(1);
  });

  test("promotes only matching OPFS entries and preserves concurrent media edits", async () => {
    spaces.splice(0, spaces.length, makeSpace("space-a"));
    folders.splice(0, folders.length, makeFolder("folder-a"));
    const item = makeItem("media-race", "folder-a", 0);
    item.media = [
      {
        type: "image",
        originalUrl: "https://example.com/a.png",
        storageType: "opfs",
        opfsPath: "media/media-race/a.png",
      },
      {
        type: "image",
        originalUrl: "https://example.com/b.png",
        storageType: "hotlink",
      },
    ];
    items.splice(0, items.length, item);

    const result = await promotionController().applyOpfsMediaPromotions({
      id: item.id,
      promotions: [
        {
          opfsPath: "media/media-race/a.png",
          s3Url: "https://cdn.example.com/a.png",
          sourceIdentity: testOpfsIdentity,
        },
      ],
    });

    expect(result).toEqual({
      success: true,
      promotedOpfsPaths: ["media/media-race/a.png"],
    });
    expect(items[0].media).toEqual([
      {
        type: "image",
        originalUrl: "https://example.com/a.png",
        storageType: "s3",
        s3Url: "https://cdn.example.com/a.png",
      },
      {
        type: "image",
        originalUrl: "https://example.com/b.png",
        storageType: "hotlink",
      },
    ]);
  });

  test("serializes an in-flight media add behind promotion and recomputes from the promoted state", async () => {
    spaces.splice(0, spaces.length, makeSpace("space-a"));
    folders.splice(0, folders.length, makeFolder("folder-a"));
    const item = makeItem("media-interleave", "folder-a", 0);
    item.media = [
      {
        type: "image",
        originalUrl: "https://example.com/a.png",
        storageType: "opfs",
        opfsPath: "media/media-interleave/a.png",
      },
    ];
    items.splice(0, items.length, item);

    const promotionPatchStarted = deferred();
    const allowPromotionPatch = deferred();
    beforePatch = async (row, patch) => {
      const firstMedia = Array.isArray(patch.media) ? patch.media[0] : undefined;
      if (row.id === item.id && firstMedia?.storageType === "s3") {
        promotionPatchStarted.resolve();
        await allowPromotionPatch.promise;
      }
    };

    try {
      const promotionPromise = promotionController().applyOpfsMediaPromotions({
        id: item.id,
        promotions: [
          {
            opfsPath: "media/media-interleave/a.png",
            s3Url: "https://cdn.example.com/a.png",
            sourceIdentity: testOpfsIdentity,
          },
        ],
      });
      await promotionPatchStarted.promise;
      const addPromise = new ItemsController().addMedia({
        id: item.id,
        url: "https://example.com/b.png",
        type: "image",
      });

      allowPromotionPatch.resolve();
      const [promotionResult, addResult] = await Promise.all([
        promotionPromise,
        addPromise,
      ]);

      expect(promotionResult).toEqual({
        success: true,
        promotedOpfsPaths: ["media/media-interleave/a.png"],
      });
      expect(addResult).toEqual({ success: true });
      expect(items[0].media).toEqual([
        {
          type: "image",
          originalUrl: "https://example.com/a.png",
          storageType: "s3",
          s3Url: "https://cdn.example.com/a.png",
        },
        {
          type: "image",
          originalUrl: "https://example.com/b.png",
          storageType: "hotlink",
        },
      ]);
    } finally {
      beforePatch = null;
      allowPromotionPatch.resolve();
    }
  });

  test("rejects a stale whole-media replacement after OPFS promotion", async () => {
    spaces.splice(0, spaces.length, makeSpace("space-a"));
    folders.splice(0, folders.length, makeFolder("folder-a"));
    const item = makeItem("media-stale-update", "folder-a", 0);
    const originalMedia: NonNullable<ItemDocType["media"]> = [
      {
        type: "image",
        originalUrl: "https://example.com/a.png",
        storageType: "opfs",
        opfsPath: "media/media-stale-update/a.png",
      },
    ];
    item.media = structuredClone(originalMedia);
    items.splice(0, items.length, item);

    await promotionController().applyOpfsMediaPromotions({
      id: item.id,
      promotions: [
        {
          opfsPath: "media/media-stale-update/a.png",
          s3Url: "https://cdn.example.com/a.png",
          sourceIdentity: testOpfsIdentity,
        },
      ],
    });
    const result = await new ItemsController().updateMedia({
      id: item.id,
      expectedMedia: originalMedia,
      media: [
        ...originalMedia,
        {
          type: "image",
          originalUrl: "https://example.com/b.png",
          storageType: "hotlink",
        },
      ],
    });

    expect(result).toEqual({ success: false, error: "MEDIA_CHANGED" });
    expect(items[0].media).toEqual([
      {
        type: "image",
        originalUrl: "https://example.com/a.png",
        storageType: "s3",
        s3Url: "https://cdn.example.com/a.png",
      },
    ]);
  });

  test("reports conflict instead of success when a media mutation never commits", async () => {
    spaces.splice(0, spaces.length, makeSpace("space-a"));
    folders.splice(0, folders.length, makeFolder("folder-a"));
    const item = makeItem("media-conflict", "folder-a", 0);
    item.media = [
      {
        type: "image",
        originalUrl: "local.png",
        storageType: "opfs",
        opfsPath: "media/media-conflict/local.png",
      },
    ];
    items.splice(0, items.length, item);
    beforePatch = async (row) => {
      if (row.id === item.id) throw { status: 409 };
    };

    try {
      const result = await new ItemsController().removeMedia({
        id: item.id,
        index: 0,
      });
      expect(result).toEqual({ success: false, error: "CONFLICT" });
      expect(items[0].media?.[0]?.opfsPath).toBe(
        "media/media-conflict/local.png"
      );
    } finally {
      beforePatch = null;
    }
  });

  test("does not commit or confirm an upload after its OPFS entry was removed", async () => {
    spaces.splice(0, spaces.length, makeSpace("space-a"));
    folders.splice(0, folders.length, makeFolder("folder-a"));
    const item = makeItem("media-removed", "folder-a", 0);
    item.media = [
      {
        type: "image",
        originalUrl: "https://example.com/replacement.png",
        storageType: "hotlink",
      },
    ];
    items.splice(0, items.length, item);
    const mediaBefore = structuredClone(item.media);

    const result = await promotionController().applyOpfsMediaPromotions({
      id: item.id,
      promotions: [
        {
          opfsPath: "media/media-removed/old.png",
          s3Url: "https://cdn.example.com/old.png",
          sourceIdentity: testOpfsIdentity,
        },
      ],
    });

    expect(result).toEqual({ success: true, promotedOpfsPaths: [] });
    expect(items[0].media).toEqual(mediaBefore);
  });

  test("rejects an upload when the same OPFS path now names different bytes", async () => {
    spaces.splice(0, spaces.length, makeSpace("space-a"));
    folders.splice(0, folders.length, makeFolder("folder-a"));
    const item = makeItem("media-aba", "folder-a", 0);
    item.media = [
      {
        type: "image",
        originalUrl: "restored.png",
        storageType: "opfs",
        opfsPath: "media/media-aba/same-name.png",
      },
    ];
    items.splice(0, items.length, item);

    const result = await new ItemsController({
      readOpfsFileIdentity: async () => ({
        ...testOpfsIdentity,
        sampleSha256: "restored-file",
      }),
    }).applyOpfsMediaPromotions({
      id: item.id,
      promotions: [
        {
          opfsPath: "media/media-aba/same-name.png",
          s3Url: "https://cdn.example.com/stale-upload.png",
          sourceIdentity: testOpfsIdentity,
        },
      ],
    });

    expect(result).toEqual({ success: true, promotedOpfsPaths: [] });
    expect(items[0].media?.[0]).toMatchObject({
      storageType: "opfs",
      opfsPath: "media/media-aba/same-name.png",
    });
  });

  test("never physically deletes an OPFS path still referenced by another live item", async () => {
    spaces.splice(0, spaces.length, makeSpace("space-a"));
    folders.splice(0, folders.length, makeFolder("folder-a"));
    const source = makeItem("source-item", "folder-a", now);
    const liveAlias = makeItem("live-alias", "folder-a", 0);
    liveAlias.media = [
      {
        type: "image",
        originalUrl: "shared.png",
        storageType: "opfs",
        opfsPath: "media/source-item/shared.png",
      },
    ];
    items.splice(0, items.length, source, liveAlias);
    const deletedPaths: string[] = [];

    const deleted = await deleteUnreferencedOpfsFiles(
      db,
      [{ opfsPath: "media/source-item/shared.png" }],
      {
        deleteMediaFromOpfs: async (opfsPath) => {
          deletedPaths.push(opfsPath);
          return true;
        },
      }
    );

    expect(deleted).toEqual([]);
    expect(deletedPaths).toEqual([]);

    const deletedDirectories: string[] = [];
    const deletedOwners = await deleteUnreferencedOpfsItemDirectories(
      db,
      [source.id],
      {
        deleteAllMediaForItem: async (itemId) => {
          deletedDirectories.push(itemId);
        },
      }
    );
    expect(deletedOwners).toEqual([]);
    expect(deletedDirectories).toEqual([]);
  });

  test("item copy remaps OPFS media into the clone's own directory", async () => {
    spaces.splice(0, spaces.length, makeSpace("space-a"), makeSpace("space-b"));
    folders.splice(0, folders.length, makeFolder("folder-a", 0, "space-a"));
    const source = makeItem("copy-source", "folder-a", 0, "space-a");
    source.media = [
      {
        type: "image",
        originalUrl: "local.png",
        storageType: "opfs",
        opfsPath: "media/copy-source/local.png",
      },
    ];
    source.displayImageUrl = "media/copy-source/local.png";
    items.splice(0, items.length, source);

    const result = await new ItemsController({
      cloneOpfsMediaEntriesForItem: async (media, destinationItemId) => ({
        media: (media || []).map((entry) => ({
          ...entry,
          opfsPath: `media/${destinationItemId}/independent.png`,
        })),
        pathMap: new Map([
          ["media/copy-source/local.png", `media/${destinationItemId}/independent.png`],
        ]),
      }),
    }).copyToSpace({ itemIds: [source.id], targetSpaceId: "space-b" });

    expect(result.copied).toBe(1);
    const clone = items.find((item) => item.id !== source.id);
    expect(clone?.media?.[0]?.opfsPath).toBe(
      `media/${clone?.id}/independent.png`
    );
    expect(clone?.displayImageUrl).toBe(`media/${clone?.id}/independent.png`);
    expect(source.media?.[0]?.opfsPath).toBe("media/copy-source/local.png");
  });

  test("rejects a save into a binned folder even when its space is live", async () => {
    spaces.splice(0, spaces.length, makeSpace("space-a"));
    folders.splice(0, folders.length, makeFolder("folder-binned", now));
    items.splice(0, items.length);

    await expect(
      new ItemsController().addToFolder({
        folderId: "folder-binned",
        url: "https://example.com/new",
      })
    ).rejects.toThrow("DESTINATION_FOLDER_NOT_LIVE");
    expect(items).toHaveLength(0);
  });

  test("rejects a live child destination beneath a binned ancestor", async () => {
    spaces.splice(0, spaces.length, makeSpace("space-a"));
    const parent = makeFolder("parent-binned", now);
    const child = makeFolder("child-live");
    child.parentId = parent.id;
    folders.splice(0, folders.length, parent, child);
    items.splice(0, items.length);

    await expect(
      new ItemsController().addToFolder({
        folderId: "child-live",
        url: "https://example.com/under-binned-parent",
      })
    ).rejects.toThrow("DESTINATION_FOLDER_NOT_LIVE");
    expect(items).toHaveLength(0);
  });

  test("a parent-space bin that wins makes a concurrent save reject", async () => {
    spaces.splice(0, spaces.length, makeSpace("space-a"));
    folders.splice(0, folders.length, makeFolder("folder-a"));
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
      const savePromise = new ItemsController().addToFolder({
        folderId: "folder-a",
        url: "https://example.com/race-save",
      });
      const outcomes = Promise.allSettled([binPromise, savePromise]);
      allowBinPatch.resolve();

      await expect(outcomes).resolves.toMatchObject([
        { status: "fulfilled", value: { success: true } },
        {
          status: "rejected",
          reason: expect.objectContaining({ message: "DESTINATION_SPACE_NOT_LIVE" }),
        },
      ]);
      expect(items).toHaveLength(0);
    } finally {
      beforePatch = null;
      beforeInsert = null;
      allowBinPatch.resolve();
    }
  });

  test("a target-space bin that wins makes a concurrent move reject", async () => {
    spaces.splice(0, spaces.length, makeSpace("space-source"), makeSpace("space-target"));
    folders.splice(
      0,
      folders.length,
      makeFolder("folder-source", 0, "space-source"),
      makeFolder("folder-target", 0, "space-target")
    );
    items.splice(0, items.length, makeItem("moving-item", "folder-source", 0, "space-source"));
    const binPatchStarted = deferred();
    const allowBinPatch = deferred();
    beforePatch = async (row, patch) => {
      if (
        row.id === "space-target" &&
        typeof patch.deletedAt === "number" &&
        patch.deletedAt > 0
      ) {
        binPatchStarted.resolve();
        await allowBinPatch.promise;
      }
    };

    try {
      const binPromise = new SpacesController({ getDb: async () => db, now: () => now + 10 })
        .moveToBin({ id: "space-target" });
      await binPatchStarted.promise;
      const movePromise = new ItemsController().moveToFolder({
        itemIds: ["moving-item"],
        targetFolderId: "folder-target",
      });
      const outcomes = Promise.allSettled([binPromise, movePromise]);
      allowBinPatch.resolve();

      await expect(outcomes).resolves.toMatchObject([
        { status: "fulfilled", value: { success: true } },
        {
          status: "rejected",
          reason: expect.objectContaining({ message: "DESTINATION_SPACE_NOT_LIVE" }),
        },
      ]);
      expect(items[0]).toMatchObject({
        id: "moving-item",
        folderId: "folder-source",
        spaceId: "space-source",
      });
    } finally {
      beforePatch = null;
      allowBinPatch.resolve();
    }
  });

  test("reorder ignores caller IDs from another folder", async () => {
    spaces.splice(0, spaces.length, makeSpace("space-a"));
    folders.splice(0, folders.length, makeFolder("folder-a"), makeFolder("folder-b"));
    items.splice(
      0,
      items.length,
      makeItem("item-a", "folder-a", 0),
      makeItem("item-b", "folder-b", 0)
    );

    await expect(
      new ItemsController().reorder({
        folders: [{ folderId: "folder-a", orderedIds: ["item-b", "item-a"] }],
      })
    ).resolves.toEqual({ updated: 1 });
    expect(items.find((item) => item.id === "item-b")).toMatchObject({
      folderId: "folder-b",
      spaceId: "space-a",
    });
  });

  test("rejects moves into a locked private destination space", async () => {
    const privateSpace = makeSpace(PRIVATE_SPACE_ID);
    privateSpace.isPrivate = true;
    spaces.splice(0, spaces.length, makeSpace("space-a"), privateSpace);
    folders.splice(0, folders.length, makeFolder("folder-a"));
    items.splice(0, items.length, makeItem("private-move", "folder-a", 0));

    await expect(
      new ItemsController().moveToSpace({
        itemIds: ["private-move"],
        targetSpaceId: PRIVATE_SPACE_ID,
      })
    ).rejects.toThrow("PRIVATE_SPACE_LOCKED");
    expect(items[0].spaceId).toBe("space-a");
  });

  test("a concurrent item delete cannot be resurrected by a space move", async () => {
    spaces.splice(0, spaces.length, makeSpace("space-a"), makeSpace("space-b"));
    folders.splice(0, folders.length, makeFolder("folder-a"));
    items.splice(0, items.length, makeItem("delete-during-move", "folder-a", 0));
    const deletePatchStarted = deferred();
    const allowDeletePatch = deferred();
    const moveReachedFinalWrite = deferred();
    beforePatch = async (row, patch) => {
      if (
        row.id === "delete-during-move" &&
        typeof patch.deletedAt === "number" &&
        patch.deletedAt > 0
      ) {
        deletePatchStarted.resolve();
        await allowDeletePatch.promise;
      }
    };
    beforeInsert = async (row) => {
      if (row.spaceId === "space-b" && row.id !== "delete-during-move") {
        moveReachedFinalWrite.resolve();
      }
    };

    try {
      const deletePromise = new ItemsController().delete({ id: "delete-during-move" });
      await deletePatchStarted.promise;
      const movePromise = new ItemsController().moveToSpace({
        itemIds: ["delete-during-move"],
        targetSpaceId: "space-b",
      });
      await moveReachedFinalWrite.promise;
      const outcomes = Promise.allSettled([deletePromise, movePromise]);
      allowDeletePatch.resolve();

      await expect(outcomes).resolves.toMatchObject([
        { status: "fulfilled", value: { success: true } },
        { status: "fulfilled", value: { updated: 0, createdFolders: 1 } },
      ]);
      expect(items[0]).toMatchObject({
        id: "delete-during-move",
        folderId: "folder-a",
        spaceId: "space-a",
      });
      expect(items[0].deletedAt).toBeGreaterThan(0);
    } finally {
      beforePatch = null;
      beforeInsert = null;
      allowDeletePatch.resolve();
    }
  });
});
