import { expect, mock, test } from "bun:test";

type Row = { id: string; [key: string]: unknown };

const document = <T extends Row>(row: T) => ({
  primary: row.id,
  get: (key: string) => row[key],
  toMutableJSON: () => ({ ...row }),
});

const matchesSelector = (row: Row, selector: Record<string, any> = {}): boolean => {
  if (Array.isArray(selector.$and)) {
    return selector.$and.every((clause: Record<string, any>) => matchesSelector(row, clause));
  }
  return Object.entries(selector).every(([key, condition]) => {
    if (key === "$and") return true;
    if (condition && typeof condition === "object") {
      if ("$eq" in condition) return row[key] === condition.$eq;
      if ("$gt" in condition) return String(row[key]) > String(condition.$gt);
      if ("$in" in condition) return condition.$in.includes(row[key]);
    }
    return row[key] === condition;
  });
};

const collection = <T extends Row>(rows: T[]) => ({
  find: (query: { selector?: Record<string, any>; limit?: number } = {}) => ({
    exec: async () => rows
      .filter((row) => matchesSelector(row, query.selector))
      .sort((left, right) => left.id.localeCompare(right.id))
      .slice(0, query.limit ?? rows.length)
      .map(document),
  }),
  findByIds: (ids: string[]) => ({
    exec: async () => new Map(
      rows.filter((row) => ids.includes(row.id)).map((row) => [row.id, document(row)]),
    ),
  }),
});

const db = {
  items: collection([
    {
      id: "item-a",
      title: "Saved article",
      url: "https://example.com/a",
      source: "article",
      type: "article",
      folderId: "folder-a",
      spaceId: "space-a",
      summary: "Concise summary",
      textContent: "Long body",
      isFavorite: true,
      createdAt: 10,
      updatedAt: 20,
      deletedAt: 0,
    },
    {
      id: "item-b",
      title: "Deleted",
      url: "https://example.com/deleted",
      source: "web",
      folderId: "folder-a",
      spaceId: "space-a",
      textContent: "Must not export",
      isFavorite: false,
      createdAt: 10,
      updatedAt: 20,
      deletedAt: 99,
    },
  ]),
  folders: collection([{ id: "folder-a", name: "Reading" }]),
  spaces: collection([{ id: "space-a", name: "Research" }]),
  item_tags: collection([{ id: "item-a|tag-a", itemId: "item-a", tagId: "tag-a" }]),
  tags: collection([{ id: "tag-a", name: "Design" }]),
};

mock.module("@src/services/DatabaseService", () => ({
  getDb: async () => db,
}));

const { loadNotionExportBatch } = await import("../src/services/notion-export-source");

test("Notion export batches include live content and portable organization metadata", async () => {
  const batch = await loadNotionExportBatch({ limit: 10 });

  expect(batch.items).toEqual([{
    id: "item-a",
    title: "Saved article",
    url: "https://example.com/a",
    source: "article",
    type: "article",
    spaceName: "Research",
    folderName: "Reading",
    tags: ["Design"],
    description: "Concise summary",
    isFavorite: true,
    createdAt: 10,
    updatedAt: 20,
  }]);
  expect(batch.hasMore).toBe(false);
  expect(batch.nextCursor).toBe("item-a");
});
