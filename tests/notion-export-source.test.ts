import { expect, test } from "bun:test";

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
    {
      id: "item-c",
      title: "Later item",
      url: "https://example.com/c",
      source: "web",
      folderId: "",
      spaceId: "",
      textContent: "Second live export row",
      isFavorite: false,
      createdAt: 30,
      updatedAt: 40,
      deletedAt: 0,
    },
  ]),
  folders: collection([{ id: "folder-a", name: "Reading" }]),
  spaces: collection([{ id: "space-a", name: "Research" }]),
  item_tags: collection([{ id: "item-a|tag-a", itemId: "item-a", tagId: "tag-a" }]),
  tags: collection([{ id: "tag-a", name: "Design" }]),
};

const { loadNotionExportBatch: loadNotionExportBatchFromSource } = await import(
  "../src/services/notion-export-source"
);
const loadNotionExportBatch = (
  payload: Parameters<typeof loadNotionExportBatchFromSource>[0] = {},
) => loadNotionExportBatchFromSource(payload, { getDb: async () => db as never });

test("Notion export batches include live content and portable organization metadata", async () => {
  const batch = await loadNotionExportBatch({ limit: 1 });

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
  expect(batch.hasMore).toBe(true);
  expect(batch.nextCursor).toBe("item-a");
});

test("Notion export pagination advances across live rows without reviving deleted rows", async () => {
  const second = await loadNotionExportBatch({ afterId: "item-a", limit: 1 });
  expect(second.items.map((item) => item.id)).toEqual(["item-c"]);
  expect(second.nextCursor).toBe("item-c");
  expect(second.hasMore).toBe(true);

  const exhausted = await loadNotionExportBatch({ afterId: "item-c", limit: 1 });
  expect(exhausted).toEqual({ items: [], nextCursor: null, hasMore: false });
});
