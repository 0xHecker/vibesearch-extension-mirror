import { describe, expect, test } from "bun:test";
import {
  SPACE_ASSIGNMENT_REPAIR_PAGE_SIZE,
  SpacesController,
} from "../src/services/controllers/spaces.controller";
import { PRIVATE_SPACE_ID, PUBLIC_SPACE_ID } from "../src/common/spaces";

type Row = Record<string, unknown> & { id: string };

const createCollection = (
  rows: Row[],
  metrics: {
    maxPage: number;
    maxRequestedLimit: number;
    activePatches: number;
    peakPatches: number;
    forbiddenBodyReads: number;
  }
) => {
  const matches = (row: Row, selector: Record<string, any>): boolean => {
    if (Array.isArray(selector.$and)) {
      return selector.$and.every((part: Record<string, any>) => matches(row, part));
    }
    for (const [field, condition] of Object.entries(selector)) {
      if (field === "$and") continue;
      const value = row[field];
      if (condition && typeof condition === "object") {
        if (condition.$eq !== undefined && value !== condition.$eq) return false;
        if (condition.$gt !== undefined && String(value) <= String(condition.$gt)) return false;
      } else if (value !== condition) {
        return false;
      }
    }
    return true;
  };

  const documentFor = (row: Row) => ({
    primary: row.id,
    get: (field: string) => {
      if (["textContent", "ocrText", "media", "displayImageUrl"].includes(field)) {
        metrics.forbiddenBodyReads += 1;
        throw new Error(`repair read heavy item field ${field}`);
      }
      return row[field];
    },
    toMutableJSON: () => {
      metrics.forbiddenBodyReads += 1;
      throw new Error("repair cloned a complete document body");
    },
    incrementalPatch: async (patch: Record<string, unknown>) => {
      metrics.activePatches += 1;
      metrics.peakPatches = Math.max(metrics.peakPatches, metrics.activePatches);
      await Promise.resolve();
      Object.assign(row, patch);
      metrics.activePatches -= 1;
    },
  });

  return {
    findByIds: (ids: string[]) => ({
      exec: async () =>
        new Map(
          rows
            .filter((row) => ids.includes(row.id))
            .map((row) => [row.id, documentFor(row)])
        ),
    }),
    find: ({ selector, limit }: { selector: Record<string, any>; limit: number }) => ({
      exec: async () => {
        metrics.maxRequestedLimit = Math.max(metrics.maxRequestedLimit, limit);
        const page = rows
          .filter((row) => matches(row, selector))
          .sort((left, right) => left.id.localeCompare(right.id))
          .slice(0, limit)
          .map(documentFor);
        metrics.maxPage = Math.max(metrics.maxPage, page.length);
        return page;
      },
    }),
    bulkUpsert: async () => {
      throw new Error("bounded repair must patch pages instead of bulk-cloning documents");
    },
  };
};

describe("startup space assignment repair", () => {
  test("repairs a large library in bounded keyset pages without reading heavy item bodies", async () => {
    const metrics = {
      maxPage: 0,
      maxRequestedLimit: 0,
      activePatches: 0,
      peakPatches: 0,
      forbiddenBodyReads: 0,
    };
    const spaces: Row[] = [
      { id: PUBLIC_SPACE_ID, isArchived: false },
      { id: PRIVATE_SPACE_ID, isArchived: false },
      { id: "space-live", isArchived: false },
      { id: "space-archived", isArchived: true },
    ];
    const folders: Row[] = Array.from({ length: 451 }, (_, index) => ({
      id: `folder-${index.toString().padStart(4, "0")}`,
      userId: null,
      spaceId: index % 3 === 0 ? "space-archived" : "space-live",
    }));
    const items: Row[] = Array.from({ length: 1_005 }, (_, index) => {
      const folder = folders[index % folders.length];
      return {
        id: `item-${index.toString().padStart(5, "0")}`,
        folderId: folder.id,
        spaceId: index % 2 === 0 ? "wrong-space" : folder.spaceId,
        userId: null,
        textContent: "x".repeat(8_192),
        ocrText: "y".repeat(8_192),
        media: [{ type: "image", dataUrl: "z".repeat(1_024) }],
      };
    });
    const originalFolderSpaces = new Map(
      folders.map((folder) => [folder.id, folder.spaceId as string])
    );
    const expectedFolderUpdates = folders.filter(
      (folder) => folder.spaceId === "space-archived"
    ).length;
    const expectedItemUpdates = items.filter((item) => {
      const originalFolderSpace = originalFolderSpaces.get(item.folderId as string);
      const target =
        originalFolderSpace === "space-archived" ? PUBLIC_SPACE_ID : originalFolderSpace;
      return item.spaceId !== target;
    }).length;

    const db = {
      spaces: createCollection(spaces, metrics),
      folders: createCollection(folders, metrics),
      items: createCollection(items, metrics),
    };
    const controller = new SpacesController({ getDb: async () => db as never });

    await expect(controller.repairFolderAndItemSpaceAssignments()).resolves.toEqual({
      folderUpdates: expectedFolderUpdates,
      itemUpdates: expectedItemUpdates,
    });

    expect(metrics.maxRequestedLimit).toBe(SPACE_ASSIGNMENT_REPAIR_PAGE_SIZE);
    expect(metrics.maxPage).toBeLessThanOrEqual(SPACE_ASSIGNMENT_REPAIR_PAGE_SIZE);
    expect(metrics.peakPatches).toBeLessThanOrEqual(SPACE_ASSIGNMENT_REPAIR_PAGE_SIZE);
    expect(metrics.forbiddenBodyReads).toBe(0);
    for (const item of items) {
      const folder = folders.find((candidate) => candidate.id === item.folderId);
      expect(item.spaceId).toBe(folder?.spaceId);
    }
  });
});
