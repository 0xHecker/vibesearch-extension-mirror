import { expect, mock, test } from "bun:test";
import type { FolderDocType } from "../src/schemas/folder_schema";
import type { SpaceDocType } from "../src/schemas/space_schema";

type Row = { id: string; [key: string]: unknown };

class FakeDoc<T extends Row> {
  constructor(private readonly row: T) {}

  get primary(): string {
    return this.row.id;
  }

  get(key: string): unknown {
    return this.row[key];
  }

  toMutableJSON(): T {
    return { ...this.row };
  }
}

const matchesSelector = (row: Row, selector?: Record<string, any>): boolean =>
  !selector ||
  Object.entries(selector).every(([key, condition]) => {
    const value = row[key];
    if (condition && typeof condition === "object" && "$eq" in condition) {
      return value === condition.$eq;
    }
    return value === condition;
  });

const collection = <T extends Row>(rows: T[]) => ({
  find: (query?: { selector?: Record<string, any> }) => ({
    exec: async () =>
      rows
        .filter((row) => matchesSelector(row, query?.selector))
        .map((row) => new FakeDoc(row)),
  }),
});

const now = 1_764_000_000_000;
const makeSpace = (id: string, options: { deletedAt?: number; isArchived?: boolean } = {}): SpaceDocType =>
  ({
    id,
    name: id,
    slug: id,
    spaceGroupId: "",
    isPrivate: false,
    autoLockMs: 300_000,
    sortOrder: 0,
    isArchived: options.isArchived === true,
    deletedAt: options.deletedAt || 0,
    purgeAt: options.deletedAt ? options.deletedAt + 1 : 0,
    createdAt: now,
    updatedAt: now,
  }) as SpaceDocType;

const makeFolder = (id: string, spaceId: string, deletedAt = 0): FolderDocType => ({
  id,
  name: id,
  userId: "",
  spaceId,
  parentId: null,
  type: "tab_group",
  sortOrder: 0,
  isLocked: false,
  isPinned: false,
  isCollapsed: false,
  deletedAt,
  purgeAt: deletedAt ? deletedAt + 1 : 0,
  isDirty: false,
  serverVersion: 0,
  createdAt: now,
  updatedAt: now,
});

const spaces = [
  makeSpace("space-live"),
  makeSpace("space-binned", { deletedAt: now }),
  makeSpace("space-archived", { isArchived: true }),
];
const folders = [
  makeFolder("folder-live", "space-live"),
  makeFolder("folder-binned", "space-live", now),
  makeFolder("folder-in-binned-space", "space-binned"),
];
const db = {
  spaces: collection(spaces),
  folders: collection(folders),
};

mock.module("@src/services/DatabaseService", () => ({
  getDb: async () => db,
}));

const { databaseManager } = await import("../src/services/db-manager");

test("import targets expose only live spaces and live folders", async () => {
  const targets = await databaseManager.getImportTargets({
    maxSpaces: 0,
    maxFoldersPerSpace: 0,
    maxItemsPerFolder: 0,
  });

  expect(targets.map((space) => space.id)).toEqual(["space-live"]);
  expect(targets[0]?.folders.map((folder) => folder.id)).toEqual(["folder-live"]);
});
