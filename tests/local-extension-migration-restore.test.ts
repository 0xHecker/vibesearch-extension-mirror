import { describe, expect, mock, test } from "bun:test";

type Row = Record<string, unknown> & { id: string };
type CollectionName =
  | "space_groups"
  | "spaces"
  | "folders"
  | "items"
  | "tags"
  | "item_tags"
  | "search_history"
  | "flashcards"
  | "deleted_items";

const collectionNames: CollectionName[] = [
  "space_groups",
  "spaces",
  "folders",
  "items",
  "tags",
  "item_tags",
  "search_history",
  "flashcards",
  "deleted_items",
];

let db: ReturnType<typeof makeDb>;

mock.module("@src/services/DatabaseService", () => ({
  getDb: async () => db,
}));

mock.module("@src/services/media-storage", () => ({
  readOpfsFile: async () => null,
  saveMediaToOpfs: async () => {},
  withOpfsMutationLock: async <T>(work: () => Promise<T>) => work(),
}));

const { restoreLocalExtensionMigrationBundle } = await import(
  "../src/services/local-extension-migration"
);
const { withBinMutationLock, withSpaceMutationLock } = await import(
  "../src/services/entity-mutation-lock"
);

const makeDoc = (row: Row) => ({
  primary: row.id,
  get: (field: string) => row[field],
  toMutableJSON: () => ({ ...row }),
});

function makeDb(
  initial: Partial<Record<CollectionName, Row[]>> = {},
  onBulkUpsert?: (
    name: CollectionName,
    rows: Row[]
  ) => Promise<{ success: unknown[]; error: unknown[] } | void>
) {
  const writeOrder: CollectionName[] = [];
  const collections = Object.fromEntries(
    collectionNames.map((name) => {
      const rows = [...(initial[name] || [])];
      return [
        name,
        {
          rows,
          find: () => ({ exec: async () => rows.map(makeDoc) }),
          bulkUpsert: async (values: Row[]) => {
            writeOrder.push(name);
            const result = await onBulkUpsert?.(name, values);
            if (result?.error.length) return result;
            for (const value of values) {
              const index = rows.findIndex((row) => row.id === value.id);
              if (index >= 0) rows[index] = { ...value };
              else rows.push({ ...value });
            }
            return result ?? { success: values, error: [] };
          },
        },
      ];
    })
  ) as Record<
    CollectionName,
    {
      rows: Row[];
      find: () => { exec: () => Promise<ReturnType<typeof makeDoc>[]> };
      bulkUpsert: (rows: Row[]) => Promise<void>;
    }
  >;
  return Object.assign(collections, { writeOrder });
}

const emptyCollections = (): Record<CollectionName, Row[]> =>
  Object.fromEntries(collectionNames.map((name) => [name, []])) as Record<
    CollectionName,
    Row[]
  >;

const bundle = (collections: Partial<Record<CollectionName, Row[]>>) => ({
  format: "vibesearch-local-extension-migration",
  version: 1,
  createdAt: 1,
  collections: { ...emptyCollections(), ...collections },
  opfsFiles: [],
  warnings: [],
});

const deferred = () => {
  let resolve = () => {};
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
};

// The service intentionally yields between restore batches in the browser.
// Bun has timers but no `window`, so expose only the timer API this test uses.
(globalThis as typeof globalThis & { window: Pick<Window, "setTimeout"> }).window = {
  setTimeout: globalThis.setTimeout.bind(globalThis) as typeof window.setTimeout,
};

describe("whole-origin migration restore safety", () => {
  test("serializes all ordered collection writes against Bin lifecycle work", async () => {
    const writeStarted = deferred();
    const releaseWrite = deferred();
    db = makeDb({}, async (name) => {
      if (name !== "spaces") return;
      writeStarted.resolve();
      await releaseWrite.promise;
    });

    const restore = restoreLocalExtensionMigrationBundle(
      bundle({
        space_groups: [{ id: "group-a", name: "A" }],
        spaces: [{ id: "space-a", name: "A", spaceGroupId: "group-a" }],
        folders: [{ id: "folder-a", name: "Folder", spaceId: "space-a" }],
        items: [
          {
            id: "item-a",
            folderId: "folder-a",
            spaceId: "space-a",
            url: "https://example.com",
          },
        ],
      })
    );
    await writeStarted.promise;

    let competingBinWorkRan = false;
    const competingBinWork = withBinMutationLock(db, async () => {
      competingBinWorkRan = true;
    });
    await Promise.resolve();
    expect(competingBinWorkRan).toBe(false);

    releaseWrite.resolve();
    await restore;
    await competingBinWork;

    expect(competingBinWorkRan).toBe(true);
    expect(db.writeOrder).toEqual(["space_groups", "spaces", "folders", "items"]);
  });

  test("repairs malformed references while preserving unresolved legacy rows", async () => {
    db = makeDb({
      spaces: [
        {
          id: "space_public_default",
          name: "Public",
          deletedAt: 0,
          isArchived: false,
        },
      ],
    });

    const result = await restoreLocalExtensionMigrationBundle(
      bundle({
        spaces: [
          { id: "space-a", name: "A", spaceGroupId: "" },
          { id: "space-b", name: "B", spaceGroupId: "" },
        ],
        folders: [
          { id: "folder-a", name: "A", spaceId: "space-a", parentId: null },
          {
            id: "cross-space-child",
            name: "Cross",
            spaceId: "space-b",
            parentId: "folder-a",
          },
          { id: "cycle-a", name: "Cycle A", spaceId: "space-a", parentId: "cycle-b" },
          { id: "cycle-b", name: "Cycle B", spaceId: "space-a", parentId: "cycle-a" },
          { id: "relocated", name: "Relocated", spaceId: "missing-space", parentId: null },
        ],
        items: [
          {
            id: "fixed-item",
            folderId: "cross-space-child",
            spaceId: "space-a",
            url: "about:blank",
          },
          {
            id: "legacy-item",
            folderId: "missing-folder",
            spaceId: "missing-space",
            url: "about:blank",
          },
        ],
      })
    );

    const folderRows = db.folders.rows;
    const itemRows = db.items.rows;
    expect(folderRows.find((row) => row.id === "cross-space-child")?.parentId).toBeNull();
    expect(folderRows.find((row) => row.id === "relocated")?.spaceId).toBe(
      "space_public_default"
    );
    expect(
      folderRows.filter((row) => row.id === "cycle-a" || row.id === "cycle-b")
        .some((row) => row.parentId === null)
    ).toBe(true);
    expect(itemRows.find((row) => row.id === "fixed-item")?.spaceId).toBe("space-b");
    expect(itemRows.find((row) => row.id === "legacy-item")).toBeDefined();
    expect(result.warningCount).toBeGreaterThanOrEqual(5);
  });

  test("waits for current owner spaces before relocating existing rows", async () => {
    db = makeDb({
      spaces: [
        { id: "space_public_default", name: "Public", deletedAt: 0, isArchived: false },
        { id: "space-current", name: "Current", deletedAt: 0, isArchived: false },
        {
          id: "space-destination",
          name: "Destination",
          deletedAt: 0,
          isArchived: false,
        },
      ],
      folders: [
        { id: "folder-existing", name: "Existing", spaceId: "space-current" },
      ],
      items: [
        {
          id: "item-existing",
          folderId: "folder-existing",
          spaceId: "space-current",
          url: "about:blank",
        },
      ],
    });

    const currentLockStarted = deferred();
    const releaseCurrentLock = deferred();
    const currentLock = withSpaceMutationLock(db, "space-current", async () => {
      currentLockStarted.resolve();
      await releaseCurrentLock.promise;
    });
    await currentLockStarted.promise;

    const restore = restoreLocalExtensionMigrationBundle(
      bundle({
        folders: [
          {
            id: "folder-existing",
            name: "Moved",
            spaceId: "space-destination",
          },
        ],
        items: [
          {
            id: "item-existing",
            folderId: "folder-existing",
            spaceId: "space-destination",
            url: "about:blank",
          },
        ],
      })
    );
    await Promise.resolve();
    await Promise.resolve();
    expect(db.writeOrder).toEqual([]);

    releaseCurrentLock.resolve();
    await currentLock;
    await restore;

    expect(db.folders.rows.find((row) => row.id === "folder-existing")?.spaceId).toBe(
      "space-destination"
    );
    expect(db.items.rows.find((row) => row.id === "item-existing")?.spaceId).toBe(
      "space-destination"
    );
  });

  test("rejects the restore when RxDB reports a rejected bulk-upsert row", async () => {
    const rejectedWrite = {
      status: 422,
      documentId: "space-rejected",
      isError: true,
      message: "schema validation failed",
    };
    db = makeDb({}, async (name) =>
      name === "spaces"
        ? { success: [], error: [rejectedWrite] }
        : undefined
    );

    const restore = restoreLocalExtensionMigrationBundle(
      bundle({
        spaces: [{ id: "space-rejected", name: "Rejected", spaceGroupId: "" }],
        folders: [
          { id: "folder-must-not-run", name: "Later batch", spaceId: "space-rejected" },
        ],
      })
    );

    const restoreError = await restore.then(
      () => null,
      (error: unknown) => error
    );
    expect(restoreError).toBeInstanceOf(AggregateError);
    expect(restoreError).toMatchObject({
      message: "MIGRATION_RESTORE_WRITE_FAILED:spaces:1",
      errors: [rejectedWrite],
    });
    expect(db.writeOrder).toEqual(["spaces"]);
    expect(db.spaces.rows).toEqual([]);
    expect(db.folders.rows).toEqual([]);
  });
});
