import { describe, expect, mock, test } from "bun:test";
import type { FolderDocType } from "../src/schemas/folder_schema";
import type { ItemDocType } from "../src/schemas/item_schema";
import type { SpaceDocType } from "../src/schemas/space_schema";
import type { ShareSnapshotV1 } from "../src/services/share-snapshot";

type MutableDoc<T> = {
  toMutableJSON: () => T;
  get: <K extends keyof T>(key: K) => T[K];
};

type TestDb = {
  space_groups: ReturnType<typeof collection>;
  spaces: ReturnType<typeof collection>;
  folders: ReturnType<typeof collection>;
  items: ReturnType<typeof collection>;
  tags: ReturnType<typeof collection>;
  item_tags: ReturnType<typeof collection>;
};

const doc = <T,>(value: T): MutableDoc<T> => ({
  toMutableJSON: () => ({ ...value }),
  get: (key) => value[key],
});

const collection = <T,>(rows: T[]) => ({
  inserted: [] as T[],
  upserted: [] as T[],
  nextBulkInsertResult: null as { success: T[]; error: unknown[] } | null,
  nextBulkUpsertResult: null as { success: T[]; error: unknown[] } | null,
  find: () => ({
    exec: async () => rows.map(doc),
  }),
  findOne: (query: any) => ({
    exec: async () => {
      if (typeof query === "string") {
        const found = rows.find((row: any) => row.id === query);
        return found ? doc(found) : null;
      }
      const selector = query?.selector || {};
      const found = rows.find((row: any) =>
        Object.entries(selector).every(([key, clause]: [string, any]) => row[key] === clause?.$eq)
      );
      return found ? doc(found) : null;
    },
  }),
  bulkInsert: async function (values: T[]) {
    if (this.nextBulkInsertResult) {
      const result = this.nextBulkInsertResult;
      this.nextBulkInsertResult = null;
      return result;
    }
    this.inserted.push(...values);
    rows.push(...values);
    return { success: values, error: [] };
  },
  bulkUpsert: async function (values: T[]) {
    if (this.nextBulkUpsertResult) {
      const result = this.nextBulkUpsertResult;
      this.nextBulkUpsertResult = null;
      return result;
    }
    this.upserted.push(...values);
    for (const value of values) {
      const id = (value as any)?.id;
      const index = rows.findIndex((row: any) => row?.id === id);
      if (index >= 0) rows[index] = value;
      else rows.push(value);
    }
    return { success: values, error: [] };
  },
});

let db: TestDb;

mock.module("@src/services/DatabaseService", () => ({
  getDb: async () => db,
}));

const {
  buildLocalExportSnapshot,
  buildShareSnapshotFromMixed,
  importSharedSnapshot,
  mergeBackupSnapshot,
} = await import("../src/services/share-snapshot");
const { withSpaceMutationLock } = await import("../src/services/entity-mutation-lock");

const now = 1_764_000_000_000;

const makeSpace = (id: string): SpaceDocType =>
  ({
    id,
    name: id,
    slug: id,
    spaceGroupId: null,
    isPrivate: false,
    autoLockMs: 0,
    sortOrder: 0,
    isArchived: false,
    deletedAt: 0,
    purgeAt: 0,
    createdAt: now,
    updatedAt: now,
  }) as SpaceDocType;

const makeFolder = (id: string, spaceId: string, parentId: string | null = null): FolderDocType =>
  ({
    id,
    name: id,
    userId: "user1",
    spaceId,
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
  }) as FolderDocType;

const makeItem = (id: string, folderId: string, spaceId: string): ItemDocType =>
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
    deletedAt: 0,
  }) as ItemDocType;

const makeSnapshot = (overrides: Partial<ShareSnapshotV1> = {}): ShareSnapshotV1 => ({
  schemaVersion: 1,
  title: "Backup",
  createdAt: now,
  source: { kind: "folders", ids: ["all"] },
  spaceGroups: [],
  spaces: [],
  folders: [],
  items: [],
  tags: [],
  itemTags: [],
  ...overrides,
});

const seedDb = () => {
  const spaces = [makeSpace("space-a")];
  const folders = [makeFolder("folder-a", "space-a"), makeFolder("folder-b", "space-a")];
  const items = [
    makeItem("selected", "folder-a", "space-a"),
    makeItem("sibling", "folder-a", "space-a"),
    makeItem("other-folder", "folder-b", "space-a"),
  ];

  db = {
    space_groups: collection([]),
    spaces: collection(spaces),
    folders: collection(folders),
    items: collection(items),
    tags: collection([]),
    item_tags: collection([]),
  };
};

describe("buildShareSnapshotFromMixed", () => {
  test("selected items include their container folder without sharing unselected siblings", async () => {
    seedDb();

    const snapshot = await buildShareSnapshotFromMixed({
      selection: {
        folderIds: new Set(),
        itemIds: new Set(["selected"]),
        spaceIds: new Set(),
        spaceGroupIds: new Set(),
      },
      title: "Selection",
    });

    expect(snapshot.folders.map((folder) => folder.id)).toEqual(["folder-a"]);
    expect(snapshot.items.map((item) => item.id)).toEqual(["selected"]);
    expect(snapshot.source).toEqual({ kind: "items", ids: ["selected"] });
  });

  test("explicit folder shares still include every item in that folder", async () => {
    seedDb();

    const snapshot = await buildShareSnapshotFromMixed({
      selection: {
        folderIds: new Set(["folder-a"]),
        itemIds: new Set(),
        spaceIds: new Set(),
        spaceGroupIds: new Set(),
      },
      title: "Folder",
    });

    expect(snapshot.items.map((item) => item.id)).toEqual(["selected", "sibling"]);
    expect(snapshot.source).toEqual({ kind: "folder", ids: ["folder-a"] });
  });

  test("explicit parent folder shares include descendant tab groups and their items", async () => {
    db = {
      space_groups: collection([]),
      spaces: collection([makeSpace("space-a")]),
      folders: collection([
        makeFolder("folder-parent", "space-a"),
        makeFolder("folder-child", "space-a", "folder-parent"),
      ]),
      items: collection([makeItem("nested", "folder-child", "space-a")]),
      tags: collection([]),
      item_tags: collection([]),
    };

    const snapshot = await buildShareSnapshotFromMixed({
      selection: {
        folderIds: new Set(["folder-parent"]),
        itemIds: new Set(),
        spaceIds: new Set(),
        spaceGroupIds: new Set(),
      },
      title: "Nested folder",
    });

    expect(snapshot.folders.map((folder) => folder.id)).toEqual([
      "folder-parent",
      "folder-child",
    ]);
    expect(snapshot.items.map((item) => item.id)).toEqual(["nested"]);
  });

  test("normal shares and exports exclude spaces in Bin and their contents", async () => {
    const liveSpace = makeSpace("space-live");
    const binnedSpace = makeSpace("space-binned");
    binnedSpace.deletedAt = now;
    binnedSpace.purgeAt = now + 30 * 24 * 60 * 60 * 1000;
    db = {
      space_groups: collection([]),
      spaces: collection([liveSpace, binnedSpace]),
      folders: collection([
        makeFolder("folder-live", liveSpace.id),
        makeFolder("folder-binned", binnedSpace.id),
      ]),
      items: collection([
        makeItem("item-live", "folder-live", liveSpace.id),
        makeItem("item-binned", "folder-binned", binnedSpace.id),
      ]),
      tags: collection([]),
      item_tags: collection([]),
    };

    const mixed = await buildShareSnapshotFromMixed({
      selection: {
        folderIds: new Set(),
        itemIds: new Set(["item-binned"]),
        spaceIds: new Set(),
        spaceGroupIds: new Set(),
      },
    });
    const exported = await buildLocalExportSnapshot();

    expect(mixed.spaces).toHaveLength(0);
    expect(mixed.folders).toHaveLength(0);
    expect(mixed.items).toHaveLength(0);
    expect(exported.spaces.map((space) => space.id)).toEqual(["space-live"]);
    expect(exported.folders.map((folder) => folder.id)).toEqual(["folder-live"]);
    expect(exported.items.map((item) => item.id)).toEqual(["item-live"]);
  });

  test("imports snapshot folders directly instead of creating an empty wrapper group", async () => {
    db = {
      space_groups: collection([]),
      spaces: collection([makeSpace("space-a")]),
      folders: collection([]),
      items: collection([]),
      tags: collection([]),
      item_tags: collection([]),
    };

    const result = await importSharedSnapshot({
      targetSpaceId: "space-a",
      rootFolderName: "Shared snapshot",
      snapshot: {
        schemaVersion: 1,
        title: "Shared snapshot",
        createdAt: now,
        source: { kind: "folder", ids: ["shared-folder"] },
        spaceGroups: [],
        spaces: [],
        folders: [makeFolder("shared-folder", "space-a")],
        items: [makeItem("shared-item", "shared-folder", "space-a")],
        tags: [],
        itemTags: [],
      },
    });

    expect(result.folderCount).toBe(1);
    expect(result.itemCount).toBe(1);
    expect(db.folders.inserted).toHaveLength(1);
    expect(db.items.inserted).toHaveLength(1);
    expect(db.items.inserted[0].folderId).toBe(db.folders.inserted[0].id);
    expect(result.rootFolderId).toBe(db.folders.inserted[0].id);
  });

  test("rejects a shared import when RxDB rejects its folder batch", async () => {
    db = {
      space_groups: collection([]),
      spaces: collection([makeSpace("space-a")]),
      folders: collection([]),
      items: collection([]),
      tags: collection([]),
      item_tags: collection([]),
    };
    const writeError = {
      status: 422,
      documentId: "folder-rejected",
      isError: true,
      message: "schema validation failed",
    };
    db.folders.nextBulkInsertResult = { success: [], error: [writeError] };

    const importError = await importSharedSnapshot({
      targetSpaceId: "space-a",
      snapshot: makeSnapshot({
        folders: [makeFolder("shared-folder", "space-a")],
        items: [makeItem("shared-item", "shared-folder", "space-a")],
      }),
    }).then(
      () => null,
      (error: unknown) => error
    );

    expect(importError).toBeInstanceOf(AggregateError);
    expect(importError).toMatchObject({
      message: "RXDB_BULK_WRITE_FAILED:shared-import.folders:1",
      errors: [writeError],
    });
    expect(db.folders.inserted).toHaveLength(0);
    expect(db.items.inserted).toHaveLength(0);
  });

  test("rejects a shared import when its destination is already in Bin", async () => {
    const target = makeSpace("space-a");
    target.deletedAt = now;
    target.purgeAt = now + 30 * 24 * 60 * 60 * 1000;
    db = {
      space_groups: collection([]),
      spaces: collection([target]),
      folders: collection([]),
      items: collection([]),
      tags: collection([]),
      item_tags: collection([]),
    };

    await expect(
      importSharedSnapshot({
        targetSpaceId: "space-a",
        snapshot: makeSnapshot({
          folders: [makeFolder("shared-folder", "space-a")],
          items: [makeItem("shared-item", "shared-folder", "space-a")],
        }),
      })
    ).rejects.toThrow("DESTINATION_SPACE_NOT_LIVE");
    expect(db.folders.inserted).toHaveLength(0);
    expect(db.items.inserted).toHaveLength(0);
  });

  test("re-reads a shared-import target under the lifecycle lock before writing", async () => {
    const target = makeSpace("space-a");
    const spaces = collection([target]);
    const findOne = spaces.findOne;
    let targetReads = 0;
    spaces.findOne = ((query: any) => {
      const pending = findOne(query);
      return {
        exec: async () => {
          const result = await pending.exec();
          targetReads += 1;
          if (targetReads === 1) {
            // Deterministically inject the old TOCTOU window: the target was
            // live when resolved for UX, then entered Bin before persistence.
            target.deletedAt = now;
            target.purgeAt = now + 30 * 24 * 60 * 60 * 1000;
          }
          return result;
        },
      };
    }) as typeof spaces.findOne;
    db = {
      space_groups: collection([]),
      spaces,
      folders: collection([]),
      items: collection([]),
      tags: collection([]),
      item_tags: collection([]),
    };

    await expect(
      importSharedSnapshot({
        targetSpaceId: "space-a",
        snapshot: makeSnapshot({
          folders: [makeFolder("shared-folder", "space-a")],
          items: [makeItem("shared-item", "shared-folder", "space-a")],
        }),
      })
    ).rejects.toThrow("DESTINATION_SPACE_NOT_LIVE");
    expect(targetReads).toBe(2);
    expect(db.folders.inserted).toHaveLength(0);
    expect(db.items.inserted).toHaveLength(0);
  });

  test("backup restore revives snapshot spaces before writing live children", async () => {
    const publicSpace = makeSpace("space_public_default");
    const binnedSpace = makeSpace("space-restored");
    binnedSpace.deletedAt = now;
    binnedSpace.purgeAt = now + 30 * 24 * 60 * 60 * 1000;
    binnedSpace.isArchived = true;
    db = {
      space_groups: collection([]),
      spaces: collection([publicSpace, binnedSpace]),
      folders: collection([]),
      items: collection([]),
      tags: collection([]),
      item_tags: collection([]),
    };

    const result = await mergeBackupSnapshot(
      makeSnapshot({
        spaces: [{ id: "space-restored", name: "Restored space" }],
        folders: [{ id: "folder-restored", name: "Folder", spaceId: "space-restored" }],
        items: [makeItem("item-restored", "folder-restored", "space-restored")],
      })
    );

    const restoredSpace = db.spaces.upserted.find((space: any) => space.id === "space-restored") as SpaceDocType;
    const restoredFolder = db.folders.upserted[0] as FolderDocType;
    const restoredItem = db.items.upserted[0] as ItemDocType;
    expect(restoredSpace.deletedAt).toBe(0);
    expect(restoredSpace.purgeAt).toBe(0);
    expect(restoredSpace.isArchived).toBe(false);
    expect(restoredFolder.spaceId).toBe(restoredSpace.id);
    expect(restoredFolder.deletedAt).toBe(0);
    expect(restoredItem.spaceId).toBe(restoredSpace.id);
    expect(restoredItem.deletedAt).toBe(0);
    expect(result.itemCount).toBe(1);
  });

  test("rejects a backup restore when RxDB rejects its space batch", async () => {
    db = {
      space_groups: collection([]),
      spaces: collection([makeSpace("space_public_default")]),
      folders: collection([]),
      items: collection([]),
      tags: collection([]),
      item_tags: collection([]),
    };
    const writeError = {
      status: 500,
      documentId: "space-rejected",
      isError: true,
      message: "storage write rejected",
    };
    db.spaces.nextBulkUpsertResult = { success: [], error: [writeError] };

    const restoreError = await mergeBackupSnapshot(
      makeSnapshot({
        spaces: [{ id: "space-rejected", name: "Rejected" }],
        folders: [{ id: "folder-must-not-run", name: "Later", spaceId: "space-rejected" }],
      })
    ).then(
      () => null,
      (error: unknown) => error
    );

    expect(restoreError).toBeInstanceOf(AggregateError);
    expect(restoreError).toMatchObject({
      message: "RXDB_BULK_WRITE_FAILED:backup-restore.spaces:1",
      errors: [writeError],
    });
    expect(db.spaces.upserted).toHaveLength(0);
    expect(db.folders.upserted).toHaveLength(0);
  });

  test("backup restore relocates children away from a binned space omitted by the snapshot", async () => {
    const publicSpace = makeSpace("space_public_default");
    const binnedSpace = makeSpace("space-binned");
    binnedSpace.deletedAt = now;
    binnedSpace.purgeAt = now + 30 * 24 * 60 * 60 * 1000;
    db = {
      space_groups: collection([]),
      spaces: collection([publicSpace, binnedSpace]),
      folders: collection([]),
      items: collection([]),
      tags: collection([]),
      item_tags: collection([]),
    };

    const result = await mergeBackupSnapshot(
      makeSnapshot({
        folders: [{ id: "folder-safe", name: "Safe folder", spaceId: "space-binned" }],
        items: [makeItem("item-safe", "folder-safe", "space-binned")],
      })
    );

    expect((db.folders.upserted[0] as FolderDocType).spaceId).toBe("space_public_default");
    expect((db.items.upserted[0] as ItemDocType).spaceId).toBe("space_public_default");
    expect(result.warnings.some((warning) => warning.includes("default space"))).toBe(true);
  });

  test("backup restore waits for the current owner space before relocating an existing row", async () => {
    const currentSpace = makeSpace("space-current");
    const destinationSpace = makeSpace("space-destination");
    const existingFolder = makeFolder("folder-existing", currentSpace.id);
    const existingItem = makeItem("item-existing", existingFolder.id, currentSpace.id);
    db = {
      space_groups: collection([]),
      spaces: collection([makeSpace("space_public_default"), currentSpace, destinationSpace]),
      folders: collection([existingFolder]),
      items: collection([existingItem]),
      tags: collection([]),
      item_tags: collection([]),
    };

    let releaseCurrentSpace = () => {};
    const currentSpaceReleased = new Promise<void>((resolve) => {
      releaseCurrentSpace = resolve;
    });
    let currentLockStarted = () => {};
    const currentLockReady = new Promise<void>((resolve) => {
      currentLockStarted = resolve;
    });
    const currentLock = withSpaceMutationLock(db, currentSpace.id, async () => {
      currentLockStarted();
      await currentSpaceReleased;
    });
    await currentLockReady;

    const restore = mergeBackupSnapshot(
      makeSnapshot({
        folders: [
          { id: existingFolder.id, name: "Moved folder", spaceId: destinationSpace.id },
        ],
        items: [makeItem(existingItem.id, existingFolder.id, destinationSpace.id)],
      })
    );
    await Promise.resolve();
    await Promise.resolve();
    expect(db.folders.upserted).toHaveLength(0);
    expect(db.items.upserted).toHaveLength(0);

    releaseCurrentSpace();
    await currentLock;
    await restore;

    expect((db.folders.upserted[0] as FolderDocType).spaceId).toBe(destinationSpace.id);
    expect((db.items.upserted[0] as ItemDocType).spaceId).toBe(destinationSpace.id);
  });

  test("backup restore breaks cross-space parent links before the folder bulk write", async () => {
    db = {
      space_groups: collection([]),
      spaces: collection([makeSpace("space_public_default")]),
      folders: collection([]),
      items: collection([]),
      tags: collection([]),
      item_tags: collection([]),
    };

    const result = await mergeBackupSnapshot(
      makeSnapshot({
        spaces: [
          { id: "space-a", name: "A" },
          { id: "space-b", name: "B" },
        ],
        folders: [
          { id: "parent-a", name: "Parent", spaceId: "space-a" },
          { id: "child-b", name: "Child", spaceId: "space-b", parentId: "parent-a" },
        ],
      })
    );

    const child = db.folders.upserted.find((folder: any) => folder.id === "child-b") as FolderDocType;
    expect(child.parentId).toBeNull();
    expect(result.warnings.some((warning) => warning.includes("another space"))).toBe(true);
  });
});
