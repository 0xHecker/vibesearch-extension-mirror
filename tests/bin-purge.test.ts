import { describe, expect, test } from "bun:test";
import {
  BIN_RETENTION_MS,
  computeBinPurgeAt,
  isSpacePurgeable,
  LIVE_SPACE_SELECTOR,
  SPACE_NOT_BINNED,
} from "../src/common/spaces";
import { SpacesController } from "../src/services/controllers/spaces.controller";

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

const createSpaceDeleteRaceHarness = () => {
  let storedSpace: Record<string, unknown> | null = {
    id: "space-race",
    name: "Space race",
    slug: "space-race",
    spaceGroupId: "",
    isPrivate: false,
    autoLockMs: 60_000,
    sortOrder: 0,
    isArchived: false,
    deletedAt: 100,
    purgeAt: 1_000,
    createdAt: 1,
    updatedAt: 100,
  };
  let beforePatch: ((patch: Record<string, unknown>) => Promise<void>) | null = null;
  let beforeRemove: (() => Promise<void>) | null = null;
  let removeCalls = 0;

  const createDoc = () => {
    if (!storedSpace) return null;
    return {
      primary: String(storedSpace.id),
      get: (key: string) => storedSpace?.[key],
      toMutableJSON: () => ({ ...storedSpace }),
      patch: async (patch: Record<string, unknown>) => {
        await beforePatch?.(patch);
        if (!storedSpace) throw new Error("CONFLICT");
        storedSpace = { ...storedSpace, ...patch };
      },
      remove: async () => {
        removeCalls += 1;
        await beforeRemove?.();
        if (!storedSpace) throw new Error("CONFLICT");
        storedSpace = null;
      },
    };
  };

  const db = {
    spaces: {
      findOne: (id: string) => ({
        exec: async () => (id === "space-race" ? createDoc() : null),
      }),
      find: ({ selector }: { selector: Record<string, any> }) => ({
        exec: async () => {
          if (!storedSpace) return [];
          const deletedAt = selector.deletedAt;
          if (deletedAt?.$eq !== undefined && storedSpace.deletedAt !== deletedAt.$eq) return [];
          if (deletedAt?.$gt !== undefined && Number(storedSpace.deletedAt) <= deletedAt.$gt) return [];
          const doc = createDoc();
          return doc ? [doc] : [];
        },
      }),
    },
    space_groups: {
      findOne: () => ({ exec: async () => null }),
    },
    folders: {
      find: () => ({ exec: async () => [] }),
      bulkRemove: async () => {},
    },
    items: {
      find: () => ({ exec: async () => [] }),
      bulkRemove: async () => {},
    },
  };

  return {
    db,
    getStoredSpace: () => storedSpace,
    getRemoveCalls: () => removeCalls,
    setBeforePatch: (hook: typeof beforePatch) => {
      beforePatch = hook;
    },
    setBeforeRemove: (hook: typeof beforeRemove) => {
      beforeRemove = hook;
    },
  };
};

describe("bin purge helpers", () => {
  test("computeBinPurgeAt schedules the purge 30 days out", () => {
    expect(computeBinPurgeAt(1_000_000)).toBe(1_000_000 + BIN_RETENTION_MS);
  });

  test("computeBinPurgeAt returns 0 for invalid inputs", () => {
    expect(computeBinPurgeAt(0)).toBe(0);
    expect(computeBinPurgeAt(Number.NaN)).toBe(0);
    expect(computeBinPurgeAt(-1)).toBe(0);
  });

  test("isSpacePurgeable only fires when the retention window has elapsed", () => {
    const now = 10_000_000;
    expect(isSpacePurgeable({ deletedAt: 1_000, purgeAt: now }, now)).toBe(true);
    expect(isSpacePurgeable({ deletedAt: 1_000, purgeAt: now + 1 }, now)).toBe(false);
    expect(isSpacePurgeable({ deletedAt: 0, purgeAt: 0 }, now)).toBe(false);
    expect(isSpacePurgeable({ deletedAt: 1_000, purgeAt: 0 }, now)).toBe(false);
  });

  test("LIVE_SPACE_SELECTOR excludes binned spaces", () => {
    expect(LIVE_SPACE_SELECTOR).toMatchObject({
      isArchived: { $eq: false },
      deletedAt: { $eq: SPACE_NOT_BINNED },
    });
  });

  test("the purge call path repairs missing deadlines and only deletes truly expired spaces", async () => {
    const now = 10_000_000_000;
    const rows = [
      { id: "missing-deadline", deletedAt: now - 1_000, purgeAt: 0, updatedAt: now - 1_000 },
      { id: "future", deletedAt: now - 1_000, purgeAt: now + 1, updatedAt: now - 1_000 },
      { id: "expired", deletedAt: now - BIN_RETENTION_MS - 1, purgeAt: now - 1, updatedAt: now - 1_000 },
    ];
    const removed = new Set<string>();
    const patches = new Map<string, Record<string, unknown>>();
    const docs = rows.map((row) => ({
      primary: row.id,
      toMutableJSON: () => ({ ...row, ...(patches.get(row.id) || {}) }),
      patch: async (patch: Record<string, unknown>) => {
        patches.set(row.id, { ...(patches.get(row.id) || {}), ...patch });
      },
      remove: async () => {
        removed.add(row.id);
      },
    }));
    const matches = (row: (typeof rows)[number], selector: Record<string, any>) => {
      const deletedAt = selector.deletedAt;
      const purgeAt = selector.purgeAt;
      if (deletedAt?.$gt !== undefined && row.deletedAt <= deletedAt.$gt) return false;
      if (purgeAt?.$lte !== undefined && row.purgeAt > purgeAt.$lte) return false;
      return true;
    };
    const db = {
      spaces: {
        findOne: (id: string) => ({
          exec: async () => docs.find((doc) => doc.primary === id && !removed.has(id)) ?? null,
        }),
        find: ({ selector }: { selector: Record<string, any> }) => ({
          exec: async () => docs.filter((_, index) => matches(rows[index], selector)),
        }),
      },
      folders: {
        find: () => ({ exec: async () => [] }),
        bulkRemove: async () => {},
      },
      items: {
        find: () => ({ exec: async () => [] }),
        bulkRemove: async () => {},
      },
    };
    const controller = new SpacesController({
      getDb: async () => db as never,
      now: () => now,
    });

    const result = await controller.purgeExpired();

    expect(result.purgedSpaceIds).toEqual(["expired"]);
    expect(removed).toEqual(new Set(["expired"]));
    expect(patches.get("missing-deadline")).toMatchObject({
      purgeAt: now + BIN_RETENTION_MS,
    });
    expect(patches.has("future")).toBe(false);
  });

  test("space purge confirms bounded item removal before cleaning media and tombstones", async () => {
    const now = 10_000;
    let storedSpace: Record<string, unknown> | null = {
      id: "expired-space",
      deletedAt: 100,
      purgeAt: 1_000,
      updatedAt: 100,
    };
    const itemIds = new Set(Array.from({ length: 201 }, (_, index) => `item-${String(index).padStart(3, "0")}`));
    const tombstoneIds = new Set(itemIds);
    const cleanedMediaIds = new Set<string>();
    const requestedLimits: number[] = [];
    const removedBatchSizes: number[] = [];
    const itemRemovalSawResourcesIntact: boolean[] = [];
    const spaceDoc = () =>
      storedSpace
        ? {
            primary: "expired-space",
            toMutableJSON: () => ({ ...storedSpace }),
            patch: async (patch: Record<string, unknown>) => {
              storedSpace = { ...storedSpace, ...patch };
            },
            remove: async () => {
              storedSpace = null;
            },
          }
        : null;
    const db = {
      spaces: {
        findOne: () => ({ exec: async () => spaceDoc() }),
        find: () => ({ exec: async () => (spaceDoc() ? [spaceDoc()] : []) }),
      },
      folders: {
        find: () => ({ exec: async () => [] }),
        bulkRemove: async () => {},
      },
      items: {
        find: ({ limit }: { limit: number }) => ({
          exec: async () => {
            requestedLimits.push(limit);
            return Array.from(itemIds)
              .slice(0, limit)
              .map((primary) => ({ primary }));
          },
        }),
        bulkRemove: async (ids: string[]) => {
          itemRemovalSawResourcesIntact.push(
            ids.every((id) => !cleanedMediaIds.has(id) && tombstoneIds.has(id))
          );
          removedBatchSizes.push(ids.length);
          for (const id of ids) itemIds.delete(id);
          return {
            success: ids.map((primary) => ({ primary })),
            error: [],
          };
        },
      },
      deleted_items: {
        find: ({ selector }: { selector: { id: { $in: string[] } } }) => ({
          exec: async () =>
            selector.id.$in
              .filter((id) => tombstoneIds.has(id))
              .map((primary) => ({ primary })),
        }),
        bulkRemove: async (ids: string[]) => {
          for (const id of ids) tombstoneIds.delete(id);
        },
      },
    };

    const result = await new SpacesController({
      getDb: async () => db as never,
      now: () => now,
      deleteAllMediaForItem: async (id) => {
        cleanedMediaIds.add(id);
      },
    }).purgeExpired();

    expect(result.purgedSpaceIds).toEqual(["expired-space"]);
    expect(removedBatchSizes).toEqual([200, 1]);
    expect(requestedLimits).toEqual([200, 200, 200]);
    expect(itemRemovalSawResourcesIntact).toEqual([true, true]);
    expect(cleanedMediaIds.size).toBe(201);
    expect(itemIds.size).toBe(0);
    expect(tombstoneIds.size).toBe(0);
  });

  test("item write rejection aborts space purge before media, folders, or parent removal", async () => {
    const writeError = {
      status: 500,
      documentId: "item-rejected",
      isError: true,
      message: "storage write rejected",
    };
    let spaceExists = true;
    let folderExists = true;
    let itemExists = true;
    let tombstoneExists = true;
    let itemRemoveAttempts = 0;
    const cleanedMediaIds: string[] = [];
    const spaceDoc = () =>
      spaceExists
        ? {
            primary: "expired-space",
            toMutableJSON: () => ({
              id: "expired-space",
              deletedAt: 100,
              purgeAt: 1_000,
              updatedAt: 100,
            }),
            remove: async () => {
              spaceExists = false;
            },
          }
        : null;
    const db = {
      spaces: {
        findOne: () => ({ exec: async () => spaceDoc() }),
        find: () => ({ exec: async () => (spaceDoc() ? [spaceDoc()] : []) }),
      },
      folders: {
        find: () => ({
          exec: async () => (folderExists ? [{ primary: "folder-a" }] : []),
        }),
        bulkRemove: async () => {
          folderExists = false;
          return { success: [{ primary: "folder-a" }], error: [] };
        },
      },
      items: {
        find: () => ({
          exec: async () => (itemExists ? [{ primary: "item-rejected" }] : []),
        }),
        bulkRemove: async () => {
          itemRemoveAttempts += 1;
          if (itemRemoveAttempts === 1) return { success: [], error: [writeError] };
          itemExists = false;
          return { success: [{ primary: "item-rejected" }], error: [] };
        },
      },
      deleted_items: {
        find: () => ({
          exec: async () => (tombstoneExists ? [{ primary: "item-rejected" }] : []),
        }),
        bulkRemove: async () => {
          tombstoneExists = false;
          return { success: [{ primary: "item-rejected" }], error: [] };
        },
      },
    };

    const purge = new SpacesController({
      getDb: async () => db as never,
      now: () => 10_000,
      deleteAllMediaForItem: async (id) => {
        cleanedMediaIds.push(id);
      },
    }).purgeExpired();

    await expect(purge).rejects.toThrow("SPACE_ITEM_PURGE_WRITE_FAILED:1");
    expect(itemRemoveAttempts).toBe(1);
    expect(itemExists).toBe(true);
    expect(tombstoneExists).toBe(true);
    expect(cleanedMediaIds).toEqual([]);
    expect(folderExists).toBe(true);
    expect(spaceExists).toBe(true);
  });

  test("no-progress item removal aborts instead of cleaning media or retrying forever", async () => {
    let removeAttempts = 0;
    let spaceRemoved = false;
    let folderRemoved = false;
    const cleanedMediaIds: string[] = [];
    const spaceDoc = {
      primary: "expired-space",
      toMutableJSON: () => ({
        id: "expired-space",
        deletedAt: 100,
        purgeAt: 1_000,
        updatedAt: 100,
      }),
      remove: async () => {
        spaceRemoved = true;
      },
    };
    const db = {
      spaces: {
        findOne: () => ({ exec: async () => spaceDoc }),
        find: () => ({ exec: async () => [spaceDoc] }),
      },
      folders: {
        find: () => ({ exec: async () => [{ primary: "folder-a" }] }),
        bulkRemove: async () => {
          folderRemoved = true;
          return { success: [{ primary: "folder-a" }], error: [] };
        },
      },
      items: {
        find: () => ({ exec: async () => [{ primary: "item-stuck" }] }),
        bulkRemove: async () => {
          removeAttempts += 1;
          if (removeAttempts > 1) throw new Error("PURGE_RETRIED_WITHOUT_PROGRESS");
          return { success: [], error: [] };
        },
      },
      deleted_items: {
        find: () => ({ exec: async () => [] }),
        bulkRemove: async () => ({ success: [], error: [] }),
      },
    };

    const purge = new SpacesController({
      getDb: async () => db as never,
      now: () => 10_000,
      deleteAllMediaForItem: async (id) => {
        cleanedMediaIds.push(id);
      },
    }).purgeExpired();

    await expect(purge).rejects.toThrow("SPACE_ITEM_PURGE_NO_PROGRESS:0/1");
    expect(removeAttempts).toBe(1);
    expect(cleanedMediaIds).toEqual([]);
    expect(folderRemoved).toBe(false);
    expect(spaceRemoved).toBe(false);
  });

  test("database-scoped locking prevents purge from emptying a concurrently restored space", async () => {
    let now = 999;
    let storedSpace: (Record<string, unknown> & { revision: number }) | null = {
      id: "racing-space",
      name: "Racing space",
      slug: "racing-space",
      spaceGroupId: "",
      isPrivate: false,
      autoLockMs: 60_000,
      sortOrder: 0,
      isArchived: false,
      deletedAt: 100,
      purgeAt: 1_000,
      createdAt: 1,
      updatedAt: 100,
      revision: 0,
    };
    const itemIds = new Set(["saved-item"]);

    let releaseRestoreQuery = () => {};
    const restoreQueryGate = new Promise<void>((resolve) => {
      releaseRestoreQuery = resolve;
    });
    let markRestoreQueryStarted = () => {};
    const restoreQueryStarted = new Promise<void>((resolve) => {
      markRestoreQueryStarted = resolve;
    });
    let restoreQueryHasStarted = false;

    let allowSpaceRemove = () => {};
    const spaceRemoveGate = new Promise<void>((resolve) => {
      allowSpaceRemove = resolve;
    });
    let markSpaceRemoveStarted = () => {};
    const spaceRemoveStarted = new Promise<void>((resolve) => {
      markSpaceRemoveStarted = resolve;
    });
    let removeStarted = false;

    const createSpaceDoc = () => {
      if (!storedSpace) return null;
      const observedRevision = storedSpace.revision;
      return {
        primary: String(storedSpace.id),
        get: (key: string) => storedSpace?.[key],
        toMutableJSON: () => ({ ...storedSpace }),
        patch: async (patch: Record<string, unknown>) => {
          if (!storedSpace || storedSpace.revision !== observedRevision) throw new Error("CONFLICT");
          storedSpace = { ...storedSpace, ...patch, revision: observedRevision + 1 };
        },
        remove: async () => {
          removeStarted = true;
          markSpaceRemoveStarted();
          await spaceRemoveGate;
          if (!storedSpace || storedSpace.revision !== observedRevision) throw new Error("CONFLICT");
          storedSpace = null;
        },
      };
    };
    const db = {
      spaces: {
        findOne: () => ({ exec: async () => createSpaceDoc() }),
        find: ({ selector }: { selector: Record<string, any> }) => ({
          exec: async () => {
            const deletedAt = selector.deletedAt;
            if (deletedAt?.$eq === SPACE_NOT_BINNED && !restoreQueryHasStarted) {
              restoreQueryHasStarted = true;
              markRestoreQueryStarted();
              await restoreQueryGate;
            }
            if (!storedSpace) return [];
            if (deletedAt?.$eq !== undefined && storedSpace.deletedAt !== deletedAt.$eq) return [];
            if (deletedAt?.$gt !== undefined && Number(storedSpace.deletedAt) <= deletedAt.$gt) return [];
            const doc = createSpaceDoc();
            return doc ? [doc] : [];
          },
        }),
      },
      space_groups: {
        findOne: () => ({ exec: async () => null }),
      },
      folders: {
        find: () => ({ exec: async () => [] }),
        bulkRemove: async () => {},
      },
      items: {
        find: () => ({
          exec: async () => Array.from(itemIds).map((primary) => ({ primary })),
        }),
        bulkRemove: async (ids: string[]) => {
          for (const id of ids) itemIds.delete(id);
        },
      },
    };
    const getSharedDb = async () => db as never;
    const restoreController = new SpacesController({ getDb: getSharedDb, now: () => now });
    const purgeController = new SpacesController({ getDb: getSharedDb, now: () => now });

    const restorePromise = restoreController.restoreFromBin({ id: "racing-space" });
    await restoreQueryStarted;
    now = 1_000;
    const purgePromise = purgeController.purgeExpired();

    await Promise.race([
      spaceRemoveStarted,
      new Promise<void>((resolve) => setTimeout(resolve, 10)),
    ]);
    const purgeReachedRemoveBeforeRestore = removeStarted;
    releaseRestoreQuery();
    const restoreResult = await restorePromise;
    allowSpaceRemove();
    const purgeResult = await purgePromise;

    expect(purgeReachedRemoveBeforeRestore).toBe(false);
    expect(restoreResult.success).toBe(true);
    expect(purgeResult.purgedSpaceIds).toEqual([]);
    expect(storedSpace?.deletedAt).toBe(SPACE_NOT_BINNED);
    expect(itemIds).toEqual(new Set(["saved-item"]));
  });

  test("a restore that wins prevents a stale tab from permanently deleting the live space", async () => {
    const harness = createSpaceDeleteRaceHarness();
    const restorePatchStarted = deferred();
    const allowRestorePatch = deferred();
    harness.setBeforePatch(async (patch) => {
      if (patch.deletedAt !== SPACE_NOT_BINNED) return;
      restorePatchStarted.resolve();
      await allowRestorePatch.promise;
    });

    const getSharedDb = async () => harness.db as never;
    const restoreController = new SpacesController({ getDb: getSharedDb, now: () => 500 });
    const deleteController = new SpacesController({ getDb: getSharedDb, now: () => 500 });
    const restorePromise = restoreController.restoreFromBin({ id: "space-race" });
    await restorePatchStarted.promise;
    const deletePromise = deleteController.deleteSpaceForever({
      id: "space-race",
      expectedDeletedAt: 100,
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
      reason: expect.objectContaining({ message: "SPACE_NOT_IN_BIN" }),
    });

    expect(harness.getRemoveCalls()).toBe(0);
    expect(harness.getStoredSpace()?.deletedAt).toBe(SPACE_NOT_BINNED);
  });

  test("a permanent delete that wins cannot be followed by a stale space restore", async () => {
    const harness = createSpaceDeleteRaceHarness();
    const removeStarted = deferred();
    const allowRemove = deferred();
    harness.setBeforeRemove(async () => {
      removeStarted.resolve();
      await allowRemove.promise;
    });

    const getSharedDb = async () => harness.db as never;
    const deleteController = new SpacesController({ getDb: getSharedDb, now: () => 500 });
    const restoreController = new SpacesController({ getDb: getSharedDb, now: () => 500 });
    const deletePromise = deleteController.deleteSpaceForever({
      id: "space-race",
      expectedDeletedAt: 100,
    });
    await removeStarted.promise;
    const restorePromise = restoreController.restoreFromBin({ id: "space-race" });
    const outcomesPromise = Promise.allSettled([deletePromise, restorePromise]);

    allowRemove.resolve();
    const [deleteOutcome, restoreOutcome] = await outcomesPromise;
    expect(deleteOutcome).toEqual({
      status: "fulfilled",
      value: { success: true, removedItems: 0 },
    });
    expect(restoreOutcome).toMatchObject({
      status: "rejected",
      reason: expect.objectContaining({ message: "SPACE_NOT_FOUND" }),
    });
    expect(harness.getStoredSpace()).toBeNull();
  });
});
