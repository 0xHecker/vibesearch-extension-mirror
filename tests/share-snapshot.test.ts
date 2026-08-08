import { describe, expect, mock, test } from "bun:test";
import type { FolderDocType } from "../src/schemas/folder_schema";
import type { ItemDocType } from "../src/schemas/item_schema";
import type { SpaceDocType } from "../src/schemas/space_schema";
import type { SpaceGroupDocType } from "../src/schemas/space_group_schema";
import type { TagDocType } from "../src/schemas/tag_schema";
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
  find: (query?: any) => ({
    exec: async () => {
      const afterId = query?.selector?.id?.$gt ??
        query?.selector?.$and?.find((clause: any) => clause?.id?.$gt)?.id?.$gt;
      const selected = typeof afterId === "string"
        ? rows.filter((row: any) => typeof row?.id === "string" && row.id > afterId)
        : rows;
      const ordered = query?.sort?.[0]?.id === "asc"
        ? [...selected].sort((left: any, right: any) => String(left?.id).localeCompare(String(right?.id)))
        : [...selected];
      return ordered.slice(0, query?.limit ?? ordered.length).map(doc);
    },
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

  test("whole-space and group shares retain root items that have no folder", async () => {
    const group: SpaceGroupDocType = {
      id: "group-a",
      name: "Group A",
      parentGroupId: null,
      sortOrder: 0,
      isCollapsed: false,
      createdAt: now,
      updatedAt: now,
    };
    const space = makeSpace("space-a");
    space.spaceGroupId = group.id;
    db = {
      space_groups: collection([group]),
      spaces: collection([space]),
      folders: collection([makeFolder("folder-a", space.id)]),
      items: collection([
        makeItem("folder-item", "folder-a", space.id),
        makeItem("root-item", "", space.id),
      ]),
      tags: collection([]),
      item_tags: collection([]),
    };

    const bySpace = await buildShareSnapshotFromMixed({
      selection: {
        folderIds: new Set(),
        itemIds: new Set(),
        spaceIds: new Set([space.id]),
        spaceGroupIds: new Set(),
      },
    });
    const byGroup = await buildShareSnapshotFromMixed({
      selection: {
        folderIds: new Set(),
        itemIds: new Set(),
        spaceIds: new Set(),
        spaceGroupIds: new Set([group.id]),
      },
    });

    expect(bySpace.items.map((item) => item.id).sort()).toEqual(["folder-item", "root-item"]);
    expect(byGroup.items.map((item) => item.id).sort()).toEqual(["folder-item", "root-item"]);
    expect(bySpace.spaces.map((entry) => entry.id)).toEqual([space.id]);
    expect(byGroup.spaces.map((entry) => entry.id)).toEqual([space.id]);
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

  test("private Drive exports preserve rich item and archive metadata without leaking it into public shares", async () => {
    const item = makeItem("item-rich", "folder-a", "space-a");
    item.isFavorite = true;
    item.type = "article";
    item.fields = { author: "Ada", readingMinutes: 4 };
    item.blocks = [{ id: "body", kind: "richtext", text: "<p>Saved</p>" }];
    item.blobs = [{
      key: "u/user/item-rich/archive.html",
      kind: "archive",
      contentType: "text/html; charset=utf-8",
      byteSize: 123,
      capturedAt: now,
    }];
    item.summary = "A durable saved page";
    item.ai = { status: "done", autoTags: ["reference"], updatedAt: now };
    db = {
      space_groups: collection([]),
      spaces: collection([makeSpace("space-a")]),
      folders: collection([makeFolder("folder-a", "space-a")]),
      items: collection([item]),
      tags: collection([]),
      item_tags: collection([]),
    };

    const privateBackup = await buildLocalExportSnapshot();
    const publicShare = await buildShareSnapshotFromMixed({
      selection: {
        folderIds: new Set(),
        itemIds: new Set([item.id]),
        spaceIds: new Set(),
        spaceGroupIds: new Set(),
      },
    });

    expect(privateBackup.backupMetadataVersion).toBe(1);
    expect(publicShare.backupMetadataVersion).toBeUndefined();
    expect(privateBackup.items[0]).toMatchObject({
      isFavorite: true,
      type: "article",
      fields: item.fields,
      blocks: item.blocks,
      blobs: item.blobs,
      summary: item.summary,
      ai: item.ai,
    });
    expect(publicShare.items[0]).not.toHaveProperty("blobs");
    expect(publicShare.items[0]).not.toHaveProperty("ai");
  });

  test("Drive export rejects oversized rows during bounded collection paging", async () => {
    const item = makeItem("item-too-large", "folder-a", "space-a");
    item.textContent = "x".repeat(16 * 1024);
    db = {
      space_groups: collection([]),
      spaces: collection([makeSpace("space-a")]),
      folders: collection([makeFolder("folder-a", "space-a")]),
      items: collection([item]),
      tags: collection([]),
      item_tags: collection([]),
    };

    await expect(buildLocalExportSnapshot({}, {
      maxEstimatedJsonBytes: 4 * 1024,
      pageSize: 1,
    })).rejects.toThrow("GOOGLE_BACKUP_TOO_LARGE");
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

  test("private backup round-trip preserves organization, root items, and tag styling", async () => {
    const parentGroup: SpaceGroupDocType = {
      id: "group-parent",
      name: "Parent group",
      parentGroupId: null,
      sortOrder: 1,
      isCollapsed: true,
      createdAt: now,
      updatedAt: now,
    };
    const childGroup: SpaceGroupDocType = {
      id: "group-child",
      name: "Child group",
      parentGroupId: parentGroup.id,
      sortOrder: 2,
      isCollapsed: false,
      createdAt: now,
      updatedAt: now,
    };
    const space = makeSpace("space-grouped");
    space.spaceGroupId = childGroup.id;
    const folder = makeFolder("folder-pinned", space.id);
    folder.isPinned = true;
    folder.isCollapsed = true;
    const rootItem = makeItem("item-root", "", space.id);
    rootItem.parentId = "item-parent";
    rootItem.chunkOrder = 7;
    const tag: TagDocType = {
      id: "tag-styled",
      name: "Styled",
      color: "#ff5500",
      isFavorite: true,
      userId: "user1",
      isDirty: false,
      serverVersion: 0,
      createdAt: now,
      updatedAt: now,
    };
    db = {
      space_groups: collection([parentGroup, childGroup]),
      spaces: collection([space]),
      folders: collection([folder]),
      items: collection([rootItem]),
      tags: collection([tag]),
      item_tags: collection([{ id: `${rootItem.id}|${tag.id}`, itemId: rootItem.id, tagId: tag.id, userId: "user1" }]),
    };

    const snapshot = await buildLocalExportSnapshot();
    db = {
      space_groups: collection([]),
      spaces: collection([makeSpace("space_public_default")]),
      folders: collection([]),
      items: collection([]),
      tags: collection([]),
      item_tags: collection([]),
    };

    await mergeBackupSnapshot(snapshot);

    expect(db.space_groups.upserted.find((group: any) => group.id === childGroup.id)).toMatchObject({
      parentGroupId: parentGroup.id,
      isCollapsed: false,
    });
    expect(db.spaces.upserted.find((row: any) => row.id === space.id)?.spaceGroupId).toBe(childGroup.id);
    expect(db.folders.upserted.find((row: any) => row.id === folder.id)).toMatchObject({
      isPinned: true,
      isCollapsed: true,
    });
    expect(db.items.upserted.find((row: any) => row.id === rootItem.id)).toMatchObject({
      folderId: "",
      spaceId: space.id,
      parentId: "item-parent",
      chunkOrder: 7,
    });
    expect(db.tags.upserted.find((row: any) => row.id === tag.id)).toMatchObject({
      color: "#ff5500",
      isFavorite: true,
    });
    expect(db.item_tags.upserted).toHaveLength(1);
  });

  test("malformed rich item metadata is rejected before the first backup write", async () => {
    db = {
      space_groups: collection([]),
      spaces: collection([makeSpace("space_public_default")]),
      folders: collection([]),
      items: collection([]),
      tags: collection([]),
      item_tags: collection([]),
    };
    const malformed = makeItem("item-malformed", "folder-new", "space-new") as ItemDocType & {
      media: unknown;
    };
    malformed.media = [null];

    await expect(mergeBackupSnapshot(makeSnapshot({
      spaces: [{ id: "space-new", name: "New space" }],
      folders: [{ id: "folder-new", name: "New folder", spaceId: "space-new" }],
      items: [malformed],
    }))).rejects.toThrow("SHARE_SNAPSHOT_ITEM_MEDIA_INVALID");

    expect(db.space_groups.upserted).toHaveLength(0);
    expect(db.spaces.upserted).toHaveLength(0);
    expect(db.folders.upserted).toHaveLength(0);
    expect(db.items.upserted).toHaveLength(0);
  });

  test("nested rows that cannot satisfy RxDB are rejected before any backup write", async () => {
    const malformedItems = [
      {
        ...makeItem("bad-parent", "folder-new", "space-new"),
        parentId: "p".repeat(101),
      },
      {
        ...makeItem("bad-block", "folder-new", "space-new"),
        blocks: [{ id: "block", kind: "text", searchable: "yes" }],
      },
      {
        ...makeItem("bad-blob", "folder-new", "space-new"),
        blobs: [{ key: "blob", kind: "archive", byteSize: -1 }],
      },
      {
        ...makeItem("bad-ocr", "folder-new", "space-new"),
        media: [{
          type: "image",
          storageType: "hotlink",
          originalUrl: "https://example.com/image.png",
          ocr: { status: "done", confidence: 2 },
        }],
      },
    ];

    for (const malformed of malformedItems) {
      db = {
        space_groups: collection([]),
        spaces: collection([makeSpace("space_public_default")]),
        folders: collection([]),
        items: collection([]),
        tags: collection([]),
        item_tags: collection([]),
      };
      await expect(mergeBackupSnapshot(makeSnapshot({
        spaces: [{ id: "space-new", name: "New space" }],
        folders: [{ id: "folder-new", name: "New folder", spaceId: "space-new" }],
        items: [malformed as ItemDocType],
      }))).rejects.toThrow();
      expect(db.space_groups.upserted).toHaveLength(0);
      expect(db.spaces.upserted).toHaveLength(0);
      expect(db.folders.upserted).toHaveLength(0);
      expect(db.items.upserted).toHaveLength(0);
    }
  });

  test("duplicate primary and join keys are rejected before any backup write", async () => {
    const duplicateCases: Array<Partial<ShareSnapshotV1>> = [
      {
        spaces: [
          { id: "space-duplicate", name: "First" },
          { id: "space-duplicate", name: "Second" },
        ],
      },
      {
        items: [
          makeItem("item-duplicate", "", "space_public_default"),
          makeItem("item-duplicate", "", "space_public_default"),
        ],
      },
      {
        tags: [
          { id: "tag-duplicate", name: "First" },
          { id: "tag-duplicate", name: "Second" },
        ],
      },
      {
        itemTags: [
          { itemId: "item-a", tagId: "tag-a" },
          { itemId: "item-a", tagId: "tag-a" },
        ],
      },
    ];

    for (const duplicateCase of duplicateCases) {
      db = {
        space_groups: collection([]),
        spaces: collection([makeSpace("space_public_default")]),
        folders: collection([]),
        items: collection([]),
        tags: collection([]),
        item_tags: collection([]),
      };
      await expect(mergeBackupSnapshot(makeSnapshot(duplicateCase))).rejects.toThrow(
        "SHARE_SNAPSHOT_DUPLICATE",
      );
      expect(db.space_groups.upserted).toHaveLength(0);
      expect(db.spaces.upserted).toHaveLength(0);
      expect(db.folders.upserted).toHaveLength(0);
      expect(db.items.upserted).toHaveLength(0);
      expect(db.tags.upserted).toHaveLength(0);
      expect(db.item_tags.upserted).toHaveLength(0);
    }
  });

  test("legacy backups preserve omitted rich metadata while current backups can clear it", async () => {
    const space = makeSpace("space-metadata");
    const folder = makeFolder("folder-metadata", space.id);
    folder.parentId = "folder-parent";
    folder.isPinned = true;
    folder.isCollapsed = true;
    const parent = makeFolder("folder-parent", space.id);
    const item = makeItem("item-metadata", folder.id, space.id);
    item.isFavorite = true;
    item.parentId = "old-parent";
    item.chunkOrder = 4;
    const tag: TagDocType = {
      id: "tag-metadata",
      name: "Metadata",
      color: "#123456",
      isFavorite: true,
      userId: "user1",
      isDirty: false,
      serverVersion: 0,
      createdAt: now,
      updatedAt: now,
    };
    db = {
      space_groups: collection([]),
      spaces: collection([makeSpace("space_public_default"), space]),
      folders: collection([parent, folder]),
      items: collection([item]),
      tags: collection([tag]),
      item_tags: collection([]),
    };
    const minimalItem = {
      id: item.id,
      title: "Restored",
      url: item.url,
      source: "web" as const,
      folderId: folder.id,
      spaceId: space.id,
      updatedAt: now + 100,
    };

    await mergeBackupSnapshot(makeSnapshot({
      createdAt: now + 100,
      folders: [{ id: folder.id, name: folder.name, spaceId: space.id, updatedAt: now + 100 }],
      items: [minimalItem],
      tags: [{ id: tag.id, name: tag.name, updatedAt: now + 100 }],
    }));
    expect(db.folders.upserted.at(-1)).toMatchObject({
      parentId: parent.id,
      isPinned: true,
      isCollapsed: true,
    });
    expect(db.items.upserted.at(-1)).toMatchObject({
      isFavorite: true,
      parentId: "old-parent",
      chunkOrder: 4,
    });
    expect(db.tags.upserted.at(-1)).toMatchObject({ color: "#123456", isFavorite: true });

    await mergeBackupSnapshot(makeSnapshot({
      backupMetadataVersion: 1,
      createdAt: now + 200,
      folders: [{ id: folder.id, name: folder.name, spaceId: space.id, updatedAt: now + 200 }],
      items: [{ ...minimalItem, updatedAt: now + 200 }],
      tags: [{ id: tag.id, name: tag.name, updatedAt: now + 200 }],
    }));
    expect(db.folders.upserted.at(-1)).toMatchObject({
      parentId: null,
      isPinned: false,
      isCollapsed: false,
    });
    expect(db.items.upserted.at(-1)).toMatchObject({
      isFavorite: false,
      parentId: null,
    });
    expect(db.items.upserted.at(-1)?.chunkOrder).toBeUndefined();
    expect(db.tags.upserted.at(-1)).toMatchObject({ color: null, isFavorite: false });
  });

  test("folder cycle detection includes retained existing parents", async () => {
    const space = makeSpace("space-cycle");
    const folderA = makeFolder("folder-a", space.id);
    const folderB = makeFolder("folder-b", space.id, folderA.id);
    db = {
      space_groups: collection([]),
      spaces: collection([makeSpace("space_public_default"), space]),
      folders: collection([folderA, folderB]),
      items: collection([]),
      tags: collection([]),
      item_tags: collection([]),
    };

    await mergeBackupSnapshot(makeSnapshot({
      createdAt: now + 100,
      folders: [{
        id: folderA.id,
        name: folderA.name,
        spaceId: space.id,
        parentId: folderB.id,
        updatedAt: now + 100,
      }],
    }));

    expect(db.folders.upserted.find((row: any) => row.id === folderA.id)?.parentId).toBeNull();
  });

  test("backup merge keeps newer local organization and lets a newer backup win exactly", async () => {
    const space = makeSpace("space-lww");
    const folder = makeFolder("folder-lww", space.id);
    const item = makeItem("item-lww", folder.id, space.id);
    space.name = "Newer local space";
    folder.name = "Newer local folder";
    item.title = "Newer local item";
    item.isFavorite = true;
    item.parentId = "old-parent";
    space.updatedAt = now + 100;
    folder.updatedAt = now + 100;
    item.updatedAt = now + 100;
    db = {
      space_groups: collection([]),
      spaces: collection([makeSpace("space_public_default"), space]),
      folders: collection([folder]),
      items: collection([item]),
      tags: collection([]),
      item_tags: collection([]),
    };

    await mergeBackupSnapshot(makeSnapshot({
      createdAt: now,
      spaces: [{ id: space.id, name: "Old backup space", updatedAt: now }],
      folders: [{ id: folder.id, name: "Old backup folder", spaceId: space.id, updatedAt: now }],
      items: [{ ...makeItem(item.id, folder.id, space.id), title: "Old backup item", updatedAt: now }],
    }));
    expect(db.spaces.upserted.find((row: any) => row.id === space.id)).toBeUndefined();
    expect(db.folders.upserted.find((row: any) => row.id === folder.id)).toBeUndefined();
    expect(db.items.upserted.find((row: any) => row.id === item.id)).toBeUndefined();

    await mergeBackupSnapshot(makeSnapshot({
      createdAt: now + 200,
      spaces: [{ id: space.id, name: "Newest backup space", updatedAt: now + 200 }],
      folders: [{ id: folder.id, name: "Newest backup folder", spaceId: space.id, updatedAt: now + 200 }],
      items: [{
        ...makeItem(item.id, folder.id, space.id),
        title: "Newest backup item",
        isFavorite: false,
        parentId: "new-parent",
        chunkOrder: 9,
        updatedAt: now + 200,
      }],
    }));
    expect(db.spaces.upserted.find((row: any) => row.id === space.id)?.name).toBe("Newest backup space");
    expect(db.folders.upserted.find((row: any) => row.id === folder.id)?.name).toBe("Newest backup folder");
    expect(db.items.upserted.find((row: any) => row.id === item.id)).toMatchObject({
      title: "Newest backup item",
      isFavorite: false,
      parentId: "new-parent",
      chunkOrder: 9,
    });
  });

  test("tag name collisions map to one deterministic tag and join", async () => {
    const space = makeSpace("space-tag-collision");
    const item = makeItem("item-tag-collision", "", space.id);
    const existingTag: TagDocType = {
      id: "tag-existing",
      name: "Foo",
      color: null,
      isFavorite: false,
      userId: "user1",
      isDirty: false,
      serverVersion: 0,
      createdAt: now,
      updatedAt: now,
    };
    db = {
      space_groups: collection([]),
      spaces: collection([makeSpace("space_public_default"), space]),
      folders: collection([]),
      items: collection([item]),
      tags: collection([existingTag]),
      item_tags: collection([]),
    };

    await mergeBackupSnapshot(makeSnapshot({
      createdAt: now + 100,
      spaces: [{ id: space.id, name: space.name, updatedAt: now + 100 }],
      items: [{ ...item, updatedAt: now + 100 }],
      tags: [
        { id: "tag-source-a", name: "Foo", updatedAt: now + 100 },
        { id: "tag-source-b", name: "foo", updatedAt: now + 200 },
      ],
      itemTags: [
        { itemId: item.id, tagId: "tag-source-a" },
        { itemId: item.id, tagId: "tag-source-b" },
      ],
    }));

    expect(db.tags.upserted).toHaveLength(1);
    expect(db.tags.upserted[0]).toMatchObject({ id: existingTag.id, name: "foo" });
    expect(db.item_tags.upserted).toEqual([
      expect.objectContaining({
        id: `${item.id}|${existingTag.id}`,
        itemId: item.id,
        tagId: existingTag.id,
      }),
    ]);
  });

  test("a zero snapshot timestamp remains older than newer local rows", async () => {
    const space = makeSpace("space-zero-time");
    space.name = "Keep local";
    space.updatedAt = 1;
    db = {
      space_groups: collection([]),
      spaces: collection([makeSpace("space_public_default"), space]),
      folders: collection([]),
      items: collection([]),
      tags: collection([]),
      item_tags: collection([]),
    };

    await mergeBackupSnapshot(makeSnapshot({
      createdAt: 0,
      spaces: [{ id: space.id, name: "Ancient backup" }],
    }));

    expect(db.spaces.upserted.find((row: any) => row.id === space.id)).toBeUndefined();
  });
});
