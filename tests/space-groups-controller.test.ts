import { describe, expect, test } from "bun:test";
import { BIN_RETENTION_MS, SPACE_NOT_BINNED } from "../src/common/spaces";
import type { SpaceDocType } from "../src/schemas/space_schema";
import { UNGROUPED_SPACE_GROUP_ID } from "../src/schemas/space_schema";
import type { SpaceGroupDocType } from "../src/schemas/space_group_schema";
import { SpacesController } from "../src/services/controllers/spaces.controller";
import { SpaceGroupsController } from "../src/services/controllers/space-groups.controller";

type Row = { id: string; [key: string]: unknown };

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
    Object.assign(this.row, patch);
  }

  async remove(): Promise<void> {
    const index = this.rows.findIndex((row) => row.id === this.row.id);
    if (index >= 0) this.rows.splice(index, 1);
  }
}

const matchesSelector = (row: Row, selector?: Record<string, any>): boolean => {
  if (!selector) return true;
  return Object.entries(selector).every(([key, condition]) => {
    const value = row[key];
    if (condition && typeof condition === "object" && !Array.isArray(condition)) {
      if ("$eq" in condition) return value === condition.$eq;
      if ("$in" in condition) return Array.isArray(condition.$in) && condition.$in.includes(value);
    }
    return value === condition;
  });
};

const collection = <T extends Row>(rows: T[]) => ({
  rows,
  find: (query?: { selector?: Record<string, any> }) => ({
    exec: async () =>
      rows
        .filter((row) => matchesSelector(row, query?.selector))
        .map((row) => new FakeDoc(rows, row)),
  }),
  findOne: (id: string) => ({
    exec: async () => {
      const row = rows.find((entry) => entry.id === id);
      return row ? new FakeDoc(rows, row) : null;
    },
  }),
});

const groups: SpaceGroupDocType[] = [];
const spaces: SpaceDocType[] = [];
let db = {
  space_groups: collection(groups),
  spaces: collection(spaces),
};

const getTestDb = async () => db as never;
const spacesController = new SpacesController({ getDb: getTestDb });
const spaceGroupsController = new SpaceGroupsController({
  getDb: getTestDb,
  moveSpaceToBin: (payload) => spacesController.moveToBin(payload),
});

const now = 1_764_000_000_000;

const makeGroup = (id: string, parentGroupId: string | null = null): SpaceGroupDocType => ({
  id,
  name: id,
  parentGroupId,
  sortOrder: 0,
  isCollapsed: false,
  createdAt: now,
  updatedAt: now,
});

const makeSpace = (id: string, spaceGroupId: string): SpaceDocType =>
  ({
    id,
    name: id,
    slug: id,
    spaceGroupId,
    isPrivate: false,
    autoLockMs: 0,
    sortOrder: 0,
    isArchived: false,
    deletedAt: SPACE_NOT_BINNED,
    purgeAt: 0,
    createdAt: now,
    updatedAt: now,
  }) as SpaceDocType;

describe("space group deletion", () => {
  test("moves spaces in the group tree to bin instead of unlinking or hard deleting them", async () => {
    const realDateNow = Date.now;
    Date.now = () => now;
    groups.splice(0, groups.length, makeGroup("parent"), makeGroup("child", "parent"), makeGroup("other"));
    spaces.splice(
      0,
      spaces.length,
      makeSpace("space-a", "parent"),
      makeSpace("space-b", "child"),
      makeSpace("space-c", "other")
    );

    try {
      const result = await spaceGroupsController.deleteSpaceGroup({ id: "parent" });

      expect(result).toEqual({ success: true, affectedSpaces: 2 });
      expect(groups.map((group) => group.id)).toEqual(["other"]);
      expect(spaces.map((space) => space.id)).toEqual(["space-a", "space-b", "space-c"]);
      const spaceA = spaces.find((space) => space.id === "space-a");
      const spaceB = spaces.find((space) => space.id === "space-b");
      expect(spaceA).toMatchObject({
        spaceGroupId: UNGROUPED_SPACE_GROUP_ID,
      });
      expect(spaceB).toMatchObject({
        spaceGroupId: UNGROUPED_SPACE_GROUP_ID,
      });
      expect(spaceA?.deletedAt).toBeGreaterThan(now);
      expect(spaceA?.purgeAt).toBe((spaceA?.deletedAt || 0) + BIN_RETENTION_MS);
      expect(spaceB?.deletedAt).toBeGreaterThan(now);
      expect(spaceB?.purgeAt).toBe((spaceB?.deletedAt || 0) + BIN_RETENTION_MS);
      expect(spaces.find((space) => space.id === "space-c")).toMatchObject({
        deletedAt: SPACE_NOT_BINNED,
        purgeAt: 0,
        spaceGroupId: "other",
      });
    } finally {
      Date.now = realDateNow;
    }
  });
});
