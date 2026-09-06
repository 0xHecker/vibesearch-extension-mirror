import { describe, expect, test } from "bun:test";

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

const {
  buildLocalExtensionMigrationBundle: buildLocalExtensionMigrationBundleFromSource,
  restoreLocalExtensionMigrationBundle: restoreLocalExtensionMigrationBundleFromSource,
  validateLocalExtensionMigrationBundle,
} = await import(
  "../src/services/local-extension-migration"
);
const { withBinMutationLock, withSpaceMutationLock } = await import(
  "../src/services/entity-mutation-lock"
);

const migrationDependencies = {
  getDb: async () => db as never,
  readOpfsFile: async () => null,
  saveMediaToOpfs: async () => {},
  withOpfsMutationLock: async <T>(work: () => Promise<T>) => work(),
};
const buildLocalExtensionMigrationBundle = (
  options: Parameters<typeof buildLocalExtensionMigrationBundleFromSource>[0] = {},
) => buildLocalExtensionMigrationBundleFromSource({ ...migrationDependencies, ...options });
const restoreLocalExtensionMigrationBundle = (
  value: Parameters<typeof restoreLocalExtensionMigrationBundleFromSource>[0],
  options: Parameters<typeof restoreLocalExtensionMigrationBundleFromSource>[1] = {},
) => restoreLocalExtensionMigrationBundleFromSource(value, {
  ...migrationDependencies,
  ...options,
});

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
          find: (query?: any) => ({
            exec: async () => {
              const afterId = query?.selector?.id?.$gt ??
                query?.selector?.$and?.find((clause: any) => clause?.id?.$gt)?.id?.$gt;
              const selected = typeof afterId === "string"
                ? rows.filter((row) => row.id > afterId)
                : rows;
              const ordered = query?.sort?.[0]?.id === "asc"
                ? [...selected].sort((left, right) => left.id.localeCompare(right.id))
                : [...selected];
              return ordered.slice(0, query?.limit ?? ordered.length).map(makeDoc);
            },
          }),
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
      find: (query?: any) => { exec: () => Promise<ReturnType<typeof makeDoc>[]> };
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
  test("keeps version-one backups restorable when archive files were not part of the format", () => {
    const validated = validateLocalExtensionMigrationBundle(bundle({}));

    expect(validated.version).toBe(1);
    expect(validated.archiveFiles).toEqual([]);
  });

  test("requires the archive manifest in version-two backups", () => {
    expect(() => validateLocalExtensionMigrationBundle({
      ...bundle({}),
      version: 2,
    })).toThrow("MIGRATION_FILE_ARCHIVES_INVALID");
  });

  test("accepts archived item identities up to the shared 512-character contract", () => {
    const itemId = `item/${"x".repeat(500)}`;
    const validated = validateLocalExtensionMigrationBundle({
      ...bundle({
        items: [{
          id: itemId,
          folderId: "",
          spaceId: "space_public_default",
          url: "https://example.com/long-id",
        }],
      }),
      version: 2,
      archiveFiles: [{
        itemId,
        mimeType: "text/html",
        updatedAt: 1,
        base64: btoa("<html>saved archive</html>"),
      }],
    });

    expect(validated.archiveFiles?.[0]?.itemId).toBe(itemId);
  });

  test("rejects malformed archive bytes before committing any database rows", async () => {
    db = makeDb();
    const invalid = {
      ...bundle({
        items: [{
          id: "item-invalid-archive",
          folderId: "",
          spaceId: "space_public_default",
          url: "https://example.com",
        }],
      }),
      version: 2,
      archiveFiles: [{
        itemId: "item-invalid-archive",
        mimeType: "text/html",
        updatedAt: 1,
        base64: "not valid base64%%%",
      }],
    };

    await expect(restoreLocalExtensionMigrationBundle(invalid)).rejects.toThrow(
      "MIGRATION_FILE_ARCHIVE_SIZE_INVALID",
    );
    expect(db.writeOrder).toEqual([]);
  });

  test("rejects malformed padded media before committing any database rows", async () => {
    db = makeDb();
    const invalid = {
      ...bundle({
        spaces: [{ id: "space-a", name: "A", spaceGroupId: "" }],
        items: [{
          id: "item-a",
          folderId: "",
          spaceId: "space-a",
          url: "https://example.com/media",
          media: [{
            type: "image",
            storageType: "opfs",
            opfsPath: "media/item-a/file.bin",
          }],
        }],
      }),
      version: 2,
      opfsFiles: [{
        opfsPath: "media/item-a/file.bin",
        mimeType: "application/octet-stream",
        base64: "AA=",
      }],
      archiveFiles: [],
    };

    await expect(restoreLocalExtensionMigrationBundle(invalid)).rejects.toThrow(
      "MIGRATION_FILE_MEDIA_SIZE_INVALID",
    );
    expect(db.writeOrder).toEqual([]);
  });

  test("rejects missing or unreferenced OPFS payloads before database writes", async () => {
    const referencedPath = "media/item-media/referenced.bin";
    const collections = {
      items: [{
        id: "item-media",
        folderId: "",
        spaceId: "space_public_default",
        url: "https://example.com/media",
        media: [{
          type: "image",
          storageType: "opfs",
          opfsPath: referencedPath,
        }],
      }],
    };
    db = makeDb();
    await expect(restoreLocalExtensionMigrationBundle({
      ...bundle(collections),
      version: 2,
      archiveFiles: [],
    })).rejects.toThrow("MIGRATION_FILE_REFERENCED_MEDIA_MISSING");
    expect(db.writeOrder).toEqual([]);

    await expect(restoreLocalExtensionMigrationBundle({
      ...bundle(collections),
      version: 2,
      opfsFiles: [
        { opfsPath: referencedPath, mimeType: "application/octet-stream", base64: "AA==" },
        {
          opfsPath: "media/item-media/unreferenced.bin",
          mimeType: "application/octet-stream",
          base64: "AA==",
        },
      ],
      archiveFiles: [],
    })).rejects.toThrow("MIGRATION_FILE_UNREFERENCED_MEDIA_PATH");
    expect(db.writeOrder).toEqual([]);
  });

  test("full backup fails visibly when referenced local media bytes are missing", async () => {
    db = makeDb({
      items: [{
        id: "item-missing-media",
        folderId: "",
        spaceId: "space_public_default",
        url: "https://example.com/missing-media",
        media: [{
          type: "image",
          storageType: "opfs",
          opfsPath: "media/item-missing-media/missing.bin",
        }],
      }],
    });

    await expect(buildLocalExtensionMigrationBundle({
      archiveCache: { listFiles: async () => [], put: async () => ({} as never) },
      archiveOutbox: { list: async () => [], read: async () => null },
    })).rejects.toThrow("MIGRATION_BACKUP_REFERENCED_MEDIA_MISSING");
  });

  test("oversized collection data is rejected during a bounded page scan", async () => {
    db = makeDb({
      items: [{
        id: "item-too-large",
        folderId: "",
        spaceId: "space_public_default",
        url: "https://example.com/large",
        textContent: "x".repeat(16 * 1024),
      }],
    });

    await expect(buildLocalExtensionMigrationBundle({
      maxEstimatedJsonBytes: 4 * 1024,
      pageSize: 1,
      archiveCache: { listFiles: async () => [], put: async () => ({} as never) },
      archiveOutbox: { list: async () => [], read: async () => null },
    })).rejects.toThrow("MIGRATION_FILE_JSON_TOO_LARGE");
  });

  test("full JSON backup exports and restores durable offline archives", async () => {
    const archiveHtml = "<html><body>offline after restore</body></html>";
    db = makeDb({
      items: [{
        id: "item-archive",
        folderId: "",
        spaceId: "space_public_default",
        url: "https://example.com/archive",
      }],
    });
    const archiveCache = {
      listFiles: async () => [{
        entry: {
          itemId: "item-archive",
          fileName: "cached.html",
          byteSize: archiveHtml.length,
          mimeType: "text/html",
          updatedAt: 123,
        },
        file: new Blob([archiveHtml], { type: "text/html" }),
      }],
      put: async () => {
        throw new Error("restore cache not configured");
      },
    };

    const exported = await buildLocalExtensionMigrationBundle({ archiveCache });
    expect(exported.version).toBe(2);
    expect(exported.archiveFiles).toHaveLength(1);

    const restored: Array<{ itemId: string; html: string; updatedAt?: number }> = [];
    const result = await restoreLocalExtensionMigrationBundle(exported, {
      archiveCache: {
        listFiles: async () => [],
        put: async (itemId: string, body: Blob, updatedAt?: number) => {
          restored.push({ itemId, html: await body.text(), updatedAt });
          return {} as never;
        },
      },
    });

    expect(restored).toEqual([{ itemId: "item-archive", html: archiveHtml, updatedAt: 123 }]);
    expect(result.restoredArchiveFileCount).toBe(1);
  });

  test("full JSON backup includes an authoritative pending outbox archive", async () => {
    const archiveHtml = "<html><body>pending offline upload</body></html>";
    const pendingFile = new Blob([archiveHtml], { type: "text/html" });
    db = makeDb({
      items: [{
        id: "item-pending-archive",
        folderId: "",
        spaceId: "space_public_default",
        url: "https://example.com/pending",
      }],
    });

    const exported = await buildLocalExtensionMigrationBundle({
      archiveCache: {
        listFiles: async () => [],
        put: async () => ({} as never),
      },
      archiveOutbox: {
        list: async () => [{
          id: "job-1",
          itemId: "item-pending-archive",
          mode: "upload" as const,
          sourceUrl: "https://example.com/pending",
          fileName: "pending.html",
          byteSize: pendingFile.size,
          createdAt: 100,
          updatedAt: 456,
          attempts: 0,
          nextAttemptAt: 100,
        }],
        read: async (fileName) => fileName === "pending.html" ? pendingFile : null,
      },
    });

    expect(exported.archiveFiles).toHaveLength(1);
    expect(exported.archiveFiles[0]).toMatchObject({
      itemId: "item-pending-archive",
      updatedAt: 456,
    });
    expect(atob(exported.archiveFiles[0].base64)).toBe(archiveHtml);
  });

  test("unencrypted JSON backups exclude private-space credentials and folder keys", async () => {
    db = makeDb({
      spaces: [{
        id: "space-private",
        name: "Private",
        isPrivate: true,
        passwordSalt: "secret-salt",
        passwordHash: "secret-password-hash",
        recoveryQuestion1: "secret recovery question",
        recoveryHash1: "secret-recovery-hash",
      }],
      folders: [{
        id: "folder-private",
        name: "Locked",
        spaceId: "space-private",
        isLocked: true,
        encryptionKey: "secret-folder-key",
      }],
    });

    const exported = await buildLocalExtensionMigrationBundle({
      archiveCache: {
        listFiles: async () => [],
        put: async () => ({} as never),
      },
      archiveOutbox: { list: async () => [], read: async () => null },
    });
    const serialized = JSON.stringify(exported);

    expect(serialized).not.toContain("secret-salt");
    expect(serialized).not.toContain("secret-password-hash");
    expect(serialized).not.toContain("secret recovery question");
    expect(serialized).not.toContain("secret-recovery-hash");
    expect(serialized).not.toContain("secret-folder-key");
    expect(exported.collections.spaces[0].isPrivate).toBe(false);
    expect(exported.collections.folders[0]).toMatchObject({ isLocked: false });
    expect(exported.warnings.some((warning) => warning.includes("credentials"))).toBe(true);
  });

  test("restoring redacted rows cannot unlock existing private spaces or folders", async () => {
    db = makeDb({
      spaces: [{
        id: "space-private",
        name: "Existing private",
        isPrivate: true,
        passwordSalt: "keep-salt",
        passwordHash: "keep-hash",
      }],
      folders: [{
        id: "folder-private",
        name: "Existing locked",
        spaceId: "space-private",
        isLocked: true,
        encryptionKey: "keep-folder-key",
      }],
    });

    await restoreLocalExtensionMigrationBundle(bundle({
      spaces: [{ id: "space-private", name: "Restored name", isPrivate: false }],
      folders: [{
        id: "folder-private",
        name: "Restored folder name",
        spaceId: "space-private",
        isLocked: false,
      }],
      deleted_items: [{ id: "source-vector-tombstone", vector_index: 5, deletedAt: 10 }],
    }));

    expect(db.spaces.rows[0]).toMatchObject({
      id: "space-private",
      name: "Restored name",
      isPrivate: true,
      passwordSalt: "keep-salt",
      passwordHash: "keep-hash",
    });
    expect(db.folders.rows[0]).toMatchObject({
      id: "folder-private",
      name: "Restored folder name",
      isLocked: true,
      encryptionKey: "keep-folder-key",
    });
    expect(db.deleted_items.rows).toEqual([]);
  });

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
