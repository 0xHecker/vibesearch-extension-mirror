import { describe, expect, test } from "bun:test";
import { addRxPlugin, createRxDatabase } from "rxdb";
import { RxDBMigrationSchemaPlugin } from "rxdb/plugins/migration-schema";
import { getRxStorageMemory } from "rxdb/plugins/storage-memory";
import { folderMigrationStrategies, folderSchema } from "../src/schemas/folder_schema";
import { itemMigrationStrategies, itemSchema } from "../src/schemas/item_schema";
import { itemTagMigrationStrategies, itemTagSchema } from "../src/schemas/item_tag_schema";
import { spaceMigrationStrategies, spaceSchema } from "../src/schemas/space_schema";
import {
  boundedMigrationRecoveryBatchSize,
  historicalWinnerForDocument,
  MIGRATION_RECOVERY_MAX_BATCH_SIZE,
  migrateAllHistoricalCollectionVersions,
  shouldReplaceHistoricalWinner,
} from "../src/services/rxdb-migration-recovery";

addRxPlugin(RxDBMigrationSchemaPlugin);

const recoverySchema = (version: number) => ({
  title: "schema version recovery fixture",
  version,
  primaryKey: "id",
  type: "object",
  properties: {
    id: { type: "string", maxLength: 100 },
    value: { type: "string" },
    updatedAt: { type: "number" },
  },
  required: ["id", "value"],
} as const);

const recoveryStrategies = {
  1: (row: Record<string, unknown>) => row,
  2: (row: Record<string, unknown>) => row,
};

describe("database schema version high-water marks", () => {
  test("never reuses or downgrades a released RxDB collection version", () => {
    // Older releases wrote these versions. Reusing a lower number opens a
    // different Dexie store and makes the existing records appear deleted.
    expect(itemSchema.version).toBeGreaterThan(8);
    expect(itemTagSchema.version).toBeGreaterThan(0);
    expect(folderSchema.version).toBeGreaterThan(6);
    expect(spaceSchema.version).toBeGreaterThan(1);
  });

  test("prefers normalized soft tombstones over equally fresh live historical rows", () => {
    const normalizers = [
      ["item", itemMigrationStrategies[itemSchema.version]],
      ["itemTag", itemTagMigrationStrategies[itemTagSchema.version]],
      ["folder", folderMigrationStrategies[folderSchema.version]],
      ["space", spaceMigrationStrategies[spaceSchema.version]],
    ] as const;

    for (const [collectionName, normalize] of normalizers) {
      const softDeleted = normalize({
        id: `${collectionName}-shared`,
        createdAt: 100,
        updatedAt: 100,
        deletedAt: 500,
      } as never) as Record<string, any>;
      const live = normalize({
        id: `${collectionName}-shared`,
        createdAt: 100,
        updatedAt: 500,
        deletedAt: 0,
      } as never) as Record<string, any>;
      softDeleted._deleted = false;
      live._deleted = false;
      softDeleted._meta = { lwt: 700 };
      live._meta = { lwt: 700 };

      const softDeletedWinner = historicalWinnerForDocument(softDeleted, 0);
      const newerSchemaLiveWinner = historicalWinnerForDocument(live, 1);

      expect(softDeletedWinner.deleted, collectionName).toBe(true);
      expect(
        shouldReplaceHistoricalWinner(softDeletedWinner, newerSchemaLiveWinner),
        collectionName
      ).toBe(false);
      expect(
        shouldReplaceHistoricalWinner(newerSchemaLiveWinner, softDeletedWinner),
        collectionName
      ).toBe(true);
    }
  });

  test("uses storage time, app time, deletion, then source version as winner precedence", () => {
    const winner = historicalWinnerForDocument(
      {
        id: "shared",
        updatedAt: 500,
        deletedAt: 0,
        _deleted: false,
        _meta: { lwt: 1_000 },
      },
      0
    );

    expect(
      shouldReplaceHistoricalWinner(
        winner,
        historicalWinnerForDocument(
          {
            id: "shared",
            updatedAt: 9_999,
            deletedAt: 9_999,
            _deleted: true,
            _meta: { lwt: 999 },
          },
          9
        )
      )
    ).toBe(false);
    expect(
      shouldReplaceHistoricalWinner(
        winner,
        historicalWinnerForDocument(
          {
            id: "shared",
            updatedAt: 501,
            deletedAt: 0,
            _deleted: false,
            _meta: { lwt: 1_000 },
          },
          0
        )
      )
    ).toBe(true);
    expect(
      shouldReplaceHistoricalWinner(
        winner,
        historicalWinnerForDocument(
          {
            id: "shared",
            updatedAt: 500,
            deletedAt: 500,
            _deleted: true,
            _meta: { lwt: 1_000 },
          },
          0
        )
      )
    ).toBe(true);
    expect(
      shouldReplaceHistoricalWinner(
        winner,
        historicalWinnerForDocument(
          {
            id: "shared",
            updatedAt: 500,
            deletedAt: 0,
            _deleted: false,
            _meta: { lwt: 1_000 },
          },
          1
        )
      )
    ).toBe(true);
  });

  test("recovers both the regressed store and a stranded higher-version store in one startup", async () => {
    const storage = getRxStorageMemory();
    const databaseName = `schema-recovery-${crypto.randomUUID()}`;

    const legacyDatabase = await createRxDatabase({
      name: databaseName,
      storage,
      multiInstance: false,
    });
    const legacyCollection = (await legacyDatabase.addCollections({
      records: {
        schema: recoverySchema(1),
        migrationStrategies: recoveryStrategies,
      },
    })).records;
    await legacyCollection.bulkInsert([
      { id: "legacy-only", value: "legacy" },
      { id: "shared", value: "legacy" },
    ]);
    await legacyDatabase.close();

    const regressedDatabase = await createRxDatabase({
      name: databaseName,
      storage,
      multiInstance: false,
    });
    const regressedCollection = (await regressedDatabase.addCollections({
      records: { schema: recoverySchema(0) },
    })).records;
    await regressedCollection.bulkInsert([
      { id: "regressed-only", value: "regressed" },
      { id: "shared", value: "current" },
    ]);
    await regressedDatabase.close();

    const recoveredDatabase = await createRxDatabase({
      name: databaseName,
      storage,
      multiInstance: false,
    });
    try {
      const recoveredCollection = (await recoveredDatabase.addCollections({
        records: {
          schema: recoverySchema(2),
          migrationStrategies: recoveryStrategies,
          autoMigrate: false,
        },
      })).records;

      await recoveredCollection.bulkInsert([
        { id: "target-only", value: "target" },
        { id: "shared", value: "target" },
      ]);

      const migratedVersions = await migrateAllHistoricalCollectionVersions(recoveredCollection);
      const recoveredRows = (await recoveredCollection.find().exec())
        .map((doc) => doc.toMutableJSON() as { id: string; value: string })
        .sort((left, right) => left.id.localeCompare(right.id));

      expect(migratedVersions).toEqual([0, 1]);
      expect(recoveredRows).toEqual([
        { id: "legacy-only", value: "legacy" },
        { id: "regressed-only", value: "regressed" },
        { id: "shared", value: "target" },
        { id: "target-only", value: "target" },
      ]);
    } finally {
      await recoveredDatabase.remove();
    }
  });

  test("does not scan the current collection when no historical store exists", async () => {
    const database = await createRxDatabase({
      name: `schema-no-recovery-${crypto.randomUUID()}`,
      storage: getRxStorageMemory(),
      multiInstance: false,
    });

    try {
      const collection = (await database.addCollections({
        records: {
          schema: recoverySchema(2),
          migrationStrategies: recoveryStrategies,
          autoMigrate: false,
        },
      })).records;
      await collection.insert({ id: "current", value: "keep" });

      const storage = collection.storageInstance.originalStorageInstance as any;
      const originalQuery = storage.query.bind(storage);
      let currentCollectionScans = 0;
      storage.query = async (...args: unknown[]) => {
        currentCollectionScans += 1;
        return originalQuery(...args);
      };

      expect(await migrateAllHistoricalCollectionVersions(collection)).toEqual([]);
      expect(currentCollectionScans).toBe(0);
    } finally {
      await database.remove();
    }
  });

  test("keeps reconciliation state bounded across many migration batches", async () => {
    const storage = getRxStorageMemory();
    const databaseName = `schema-bounded-recovery-${crypto.randomUUID()}`;
    const documentCount = 1_250;

    const legacyDatabase = await createRxDatabase({
      name: databaseName,
      storage,
      multiInstance: false,
    });
    const legacyCollection = (await legacyDatabase.addCollections({
      records: { schema: recoverySchema(0) },
    })).records;
    await legacyCollection.bulkInsert(
      Array.from({ length: documentCount }, (_, index) => ({
        id: `legacy-${index.toString().padStart(5, "0")}`,
        value: `older-${index}`,
      }))
    );
    await legacyDatabase.close();

    const newerLegacyDatabase = await createRxDatabase({
      name: databaseName,
      storage,
      multiInstance: false,
    });
    const newerLegacyCollection = (await newerLegacyDatabase.addCollections({
      records: {
        schema: recoverySchema(1),
        migrationStrategies: recoveryStrategies,
        autoMigrate: false,
      },
    })).records;
    await newerLegacyCollection.bulkInsert(
      Array.from({ length: documentCount }, (_, index) => ({
        id: `legacy-${index.toString().padStart(5, "0")}`,
        value: `newer-${index}`,
      }))
    );
    await newerLegacyDatabase.close();

    const targetDatabase = await createRxDatabase({
      name: databaseName,
      storage,
      multiInstance: false,
    });
    try {
      const targetCollection = (await targetDatabase.addCollections({
        records: {
          schema: recoverySchema(2),
          migrationStrategies: recoveryStrategies,
          autoMigrate: false,
        },
      })).records;

      let peakCombinedRetainedEntries = 0;
      let peakPendingOrActiveRequests = 0;
      let peakRetainedPrimaryCount = 0;
      let peakLookupDocumentCount = 0;
      let peakResolvedRequestCount = 0;

      // Even an accidentally library-sized request is clamped. This is the
      // same cap for 100k and 1m IDs; document count never enters retained
      // reconciliation state.
      expect(boundedMigrationRecoveryBatchSize(100_000)).toBe(
        MIGRATION_RECOVERY_MAX_BATCH_SIZE
      );
      expect(boundedMigrationRecoveryBatchSize(1_000_000)).toBe(
        MIGRATION_RECOVERY_MAX_BATCH_SIZE
      );

      expect(
        await migrateAllHistoricalCollectionVersions(targetCollection, 1_000_000, {
          onRetentionSample(sample) {
            peakPendingOrActiveRequests = Math.max(
              peakPendingOrActiveRequests,
              sample.pendingRequestCount + sample.activeRequestCount
            );
            peakRetainedPrimaryCount = Math.max(
              peakRetainedPrimaryCount,
              sample.retainedPrimaryCount
            );
            peakLookupDocumentCount = Math.max(
              peakLookupDocumentCount,
              sample.retainedLookupDocumentCount
            );
            peakResolvedRequestCount = Math.max(
              peakResolvedRequestCount,
              sample.resolvedRequestCount
            );
            peakCombinedRetainedEntries = Math.max(
              peakCombinedRetainedEntries,
              sample.pendingRequestCount +
                sample.activeRequestCount +
                sample.retainedPrimaryCount +
                sample.retainedLookupDocumentCount
            );
          },
        })
      ).toEqual([0, 1]);

      expect(await targetCollection.count().exec()).toBe(documentCount);
      expect(peakResolvedRequestCount).toBe(documentCount);
      expect((await targetCollection.findOne("legacy-00000").exec())?.get("value")).toBe(
        "newer-0"
      );
      // RxDB 16 pipelines at most four upstream batches concurrently. The
      // recovery queue therefore has a fixed small multiple of the batch cap,
      // never a library-sized backlog.
      expect(peakPendingOrActiveRequests).toBeLessThanOrEqual(
        MIGRATION_RECOVERY_MAX_BATCH_SIZE * 4
      );
      expect(peakRetainedPrimaryCount).toBeLessThanOrEqual(
        MIGRATION_RECOVERY_MAX_BATCH_SIZE * 4
      );
      expect(peakLookupDocumentCount).toBeLessThanOrEqual(
        MIGRATION_RECOVERY_MAX_BATCH_SIZE
      );
      expect(peakCombinedRetainedEntries).toBeLessThanOrEqual(
        MIGRATION_RECOVERY_MAX_BATCH_SIZE * 9
      );
    } finally {
      await targetDatabase.remove();
    }
  });

  test("retries a failed recovery in the same database session", async () => {
    const storage = getRxStorageMemory();
    const databaseName = `schema-recovery-retry-${crypto.randomUUID()}`;

    const legacyDatabase = await createRxDatabase({
      name: databaseName,
      storage,
      multiInstance: false,
    });
    const legacyCollection = (await legacyDatabase.addCollections({
      records: { schema: recoverySchema(0) },
    })).records;
    await legacyCollection.bulkInsert(
      Array.from({ length: 8 }, (_, index) => ({
        id: `retry-${index}`,
        value: `recover-${index}`,
      }))
    );
    await legacyDatabase.close();

    let failOnce = true;
    const retryStrategies = {
      1: (row: Record<string, unknown>) => row,
      2: (row: Record<string, unknown>) => {
        // With a two-row migration batch, the first rows have already reached
        // the target when this later batch fails.
        if (row.id === "retry-2" && failOnce) {
          failOnce = false;
          throw new Error("injected recovery failure");
        }
        return row;
      },
    };
    const targetDatabase = await createRxDatabase({
      name: databaseName,
      storage,
      multiInstance: false,
    });

    try {
      const targetCollection = (await targetDatabase.addCollections({
        records: {
          schema: recoverySchema(2),
          migrationStrategies: retryStrategies,
          autoMigrate: false,
        },
      })).records;

      await expect(
        migrateAllHistoricalCollectionVersions(targetCollection, 2)
      ).rejects.toThrow();
      const partiallyRecoveredCount = await targetCollection.count().exec();
      expect(partiallyRecoveredCount).toBeGreaterThan(0);
      expect(partiallyRecoveredCount).toBeLessThan(8);
      expect(await migrateAllHistoricalCollectionVersions(targetCollection, 2)).toEqual([0]);
      expect(
        (await targetCollection.find().exec())
          .map((document) => document.primary)
          .sort()
      ).toEqual(Array.from({ length: 8 }, (_, index) => `retry-${index}`));
    } finally {
      await targetDatabase.remove();
    }
  });

  test("resets progress and retries after a winner lookup pump failure", async () => {
    const storage = getRxStorageMemory();
    const databaseName = `schema-lookup-retry-${crypto.randomUUID()}`;

    const legacyDatabase = await createRxDatabase({
      name: databaseName,
      storage,
      multiInstance: false,
    });
    const legacyCollection = (await legacyDatabase.addCollections({
      records: { schema: recoverySchema(0) },
    })).records;
    await legacyCollection.bulkInsert(
      Array.from({ length: 6 }, (_, index) => ({
        id: `lookup-retry-${index}`,
        value: `value-${index}`,
      }))
    );
    await legacyDatabase.close();

    const targetDatabase = await createRxDatabase({
      name: databaseName,
      storage,
      multiInstance: false,
    });
    try {
      const targetCollection = (await targetDatabase.addCollections({
        records: {
          schema: recoverySchema(2),
          migrationStrategies: recoveryStrategies,
          autoMigrate: false,
        },
      })).records;
      const targetStorage = targetCollection.storageInstance
        .originalStorageInstance as typeof targetCollection.storageInstance.originalStorageInstance;
      const originalFindDocumentsById = targetStorage.findDocumentsById.bind(targetStorage);
      let failWinnerLookupOnce = true;
      targetStorage.findDocumentsById = async (ids, withDeleted) => {
        if (failWinnerLookupOnce && withDeleted && ids.some((id) => id.startsWith("lookup-retry-"))) {
          failWinnerLookupOnce = false;
          throw new Error("injected winner lookup failure");
        }
        return originalFindDocumentsById(ids, withDeleted);
      };

      await expect(
        migrateAllHistoricalCollectionVersions(targetCollection, 2)
      ).rejects.toThrow();
      expect(await migrateAllHistoricalCollectionVersions(targetCollection, 2)).toEqual([0]);
      expect(await targetCollection.count().exec()).toBe(6);
    } finally {
      await targetDatabase.remove();
    }
  });

  test("never resurrects a row deleted in the current target store", async () => {
    const storage = getRxStorageMemory();
    const databaseName = `schema-target-tombstone-${crypto.randomUUID()}`;

    const legacyDatabase = await createRxDatabase({
      name: databaseName,
      storage,
      multiInstance: false,
    });
    const legacyCollection = (await legacyDatabase.addCollections({
      records: { schema: recoverySchema(0) },
    })).records;
    await legacyCollection.insert({ id: "deleted-in-target", value: "legacy-live" });
    await legacyDatabase.close();

    const targetDatabase = await createRxDatabase({
      name: databaseName,
      storage,
      multiInstance: false,
    });
    try {
      const targetCollection = (await targetDatabase.addCollections({
        records: {
          schema: recoverySchema(2),
          migrationStrategies: recoveryStrategies,
          autoMigrate: false,
        },
      })).records;
      const targetRow = await targetCollection.insert({
        id: "deleted-in-target",
        value: "target-value",
      });
      await targetRow.remove();

      expect(await migrateAllHistoricalCollectionVersions(targetCollection)).toEqual([0]);
      expect(await targetCollection.findOne("deleted-in-target").exec()).toBeNull();
      expect(
        await targetCollection.storageInstance.originalStorageInstance.findDocumentsById(
          ["deleted-in-target"],
          true
        )
      ).toHaveLength(1);
    } finally {
      await targetDatabase.remove();
    }
  });

  test("chooses the freshest historical duplicate and never resurrects its tombstone", async () => {
    const storage = getRxStorageMemory();
    const databaseName = `schema-winner-${crypto.randomUUID()}`;

    const oldestDatabase = await createRxDatabase({
      name: databaseName,
      storage,
      multiInstance: false,
    });
    const oldestCollection = (await oldestDatabase.addCollections({
      records: { schema: recoverySchema(0) },
    })).records;
    await oldestCollection.bulkInsert([
      { id: "historical-shared", value: "older", updatedAt: 100 },
      { id: "historical-deleted", value: "must-not-return", updatedAt: 100 },
    ]);
    await oldestDatabase.close();

    // Leave both physical stores in place, as an interrupted migration or a
    // released version reset can. RxDB will enumerate v0 first even though the
    // v1 writes below are newer.
    await Bun.sleep(5);
    const newerDatabase = await createRxDatabase({
      name: databaseName,
      storage,
      multiInstance: false,
    });
    const newerCollection = (await newerDatabase.addCollections({
      records: {
        schema: recoverySchema(1),
        migrationStrategies: recoveryStrategies,
        autoMigrate: false,
      },
    })).records;
    await newerCollection.bulkInsert([
      { id: "historical-shared", value: "newer", updatedAt: 200 },
      { id: "historical-deleted", value: "delete-me", updatedAt: 200 },
    ]);
    await (await newerCollection.findOne("historical-deleted").exec())!.remove();
    await newerDatabase.close();

    const targetDatabase = await createRxDatabase({
      name: databaseName,
      storage,
      multiInstance: false,
    });
    try {
      const targetCollection = (await targetDatabase.addCollections({
        records: {
          schema: recoverySchema(2),
          migrationStrategies: recoveryStrategies,
          autoMigrate: false,
        },
      })).records;

      expect(await migrateAllHistoricalCollectionVersions(targetCollection)).toEqual([0, 1]);
      expect((await targetCollection.findOne("historical-shared").exec())?.get("value")).toBe(
        "newer"
      );
      expect(await targetCollection.findOne("historical-deleted").exec()).toBeNull();
    } finally {
      await targetDatabase.remove();
    }
  });
});
