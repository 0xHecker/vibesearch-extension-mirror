import { describe, expect, mock, test } from "bun:test";
import type { FolderDocType } from "../src/schemas/folder_schema";
import type { ItemDocType } from "../src/schemas/item_schema";
import type { SpaceDocType } from "../src/schemas/space_schema";

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
    this.inserted.push(...values);
    rows.push(...values);
  },
  bulkUpsert: async function (values: T[]) {
    this.upserted.push(...values);
    rows.push(...values);
  },
});

let db: TestDb;

mock.module("@src/services/DatabaseService", () => ({
  getDb: async () => db,
}));

const { buildShareSnapshotFromMixed, importSharedSnapshot } = await import("../src/services/share-snapshot");

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
});
