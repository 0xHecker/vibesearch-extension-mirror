import { addRxPlugin, createRxDatabase } from "rxdb";
import { RxDBDevModePlugin } from "rxdb/plugins/dev-mode";
import { RxDBMigrationSchemaPlugin } from "rxdb/plugins/migration-schema";
import { wrappedValidateZSchemaStorage } from "rxdb/plugins/validate-z-schema";
import { getRxStorageMemory } from "rxdb/plugins/storage-memory";
import { describe, expect, it } from "bun:test";
import { spaceMigrationStrategies, spaceSchema } from "../src/schemas/space_schema";

addRxPlugin(RxDBDevModePlugin);
addRxPlugin(RxDBMigrationSchemaPlugin);

describe("space schema", () => {
  it("allows the space-group field to be indexed by RxDB", async () => {
    const database = await createRxDatabase({
      name: `space-schema-${crypto.randomUUID()}`,
      storage: wrappedValidateZSchemaStorage({ storage: getRxStorageMemory() }),
    });

    try {
      const collections = await database.addCollections({
        spaces: { schema: spaceSchema, migrationStrategies: spaceMigrationStrategies },
      });
      expect(collections.spaces).toBeDefined();
    } finally {
      await database.remove();
    }
  });

  it("indexes the deletedAt and purgeAt fields so bin reads stay cheap", async () => {
    const database = await createRxDatabase({
      name: `space-schema-index-${crypto.randomUUID()}`,
      storage: wrappedValidateZSchemaStorage({ storage: getRxStorageMemory() }),
    });

    try {
      const collections = await database.addCollections({
        spaces: { schema: spaceSchema, migrationStrategies: spaceMigrationStrategies },
      });
      await collections.spaces.insert({
        id: "s1",
        name: "Pinned",
        slug: "pinned",
        spaceGroupId: "",
        isPrivate: false,
        autoLockMs: 60_000,
        sortOrder: 0,
        isArchived: false,
        deletedAt: 0,
        purgeAt: 0,
        createdAt: 1,
        updatedAt: 1,
      });

      const live = await collections.spaces
        .find({ selector: { deletedAt: { $eq: 0 } } })
        .exec();
      expect(live.length).toBe(1);
    } finally {
      await database.remove();
    }
  });

  it("normalizes group and bin fields missing from legacy space rows", () => {
    const migrated = spaceMigrationStrategies[2]({
      id: "legacy-space",
      name: "Legacy",
      slug: "legacy",
      isPrivate: false,
      autoLockMs: 0,
      sortOrder: -1,
      isArchived: false,
      createdAt: 1,
      updatedAt: 1,
    } as any);

    expect(migrated).toMatchObject({
      spaceGroupId: "",
      isPrivate: false,
      sortOrder: 0,
      deletedAt: 0,
      purgeAt: 0,
    });
    expect(migrated.autoLockMs).toBeGreaterThanOrEqual(30_000);
  });
});
