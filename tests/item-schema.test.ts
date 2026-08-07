import { addRxPlugin, createRxDatabase, type RxJsonSchema } from "rxdb";
import { RxDBDevModePlugin } from "rxdb/plugins/dev-mode";
import { RxDBMigrationSchemaPlugin } from "rxdb/plugins/migration-schema";
import { getRxStorageMemory } from "rxdb/plugins/storage-memory";
import { wrappedValidateZSchemaStorage } from "rxdb/plugins/validate-z-schema";
import { describe, expect, it } from "bun:test";
import {
  itemMigrationStrategies,
  itemSchema,
  type ItemDocType,
} from "@src/schemas/item_schema";

addRxPlugin(RxDBDevModePlugin);
addRxPlugin(RxDBMigrationSchemaPlugin);

const item = (overrides: Partial<ItemDocType> = {}): ItemDocType => ({
  id: "item-1",
  userId: "",
  title: "Saved page",
  textContent: "Body",
  ocrStatus: "skipped",
  ocrModelVersion: "",
  ocrUpdatedAt: 0,
  url: "https://example.com/page",
  source: "web",
  folderId: "folder-1",
  spaceId: "space-1",
  isFavorite: false,
  parentId: null,
  vector_index: -1,
  vector_indexes: [],
  isEmbedded: false,
  isMetaFetched: false,
  isDirty: false,
  serverVersion: 1,
  createdAt: 1,
  updatedAt: 1,
  deletedAt: 0,
  ...overrides,
});

const v0ItemSchema = (): RxJsonSchema<ItemDocType> => {
  const schema = structuredClone(itemSchema) as RxJsonSchema<ItemDocType>;
  schema.version = 0;
  for (const key of ["type", "fields", "blocks", "blobs", "summary", "ai"] as const) {
    delete (schema.properties as Record<string, unknown>)[key];
  }
  return schema;
};

describe("item schema", () => {
  it("stores the shared content and archive surfaces without stripping them", async () => {
    const database = await createRxDatabase({
      name: `item-schema-${crypto.randomUUID()}`,
      storage: wrappedValidateZSchemaStorage({ storage: getRxStorageMemory() }),
    });

    try {
      const { items } = await database.addCollections({
        items: { schema: itemSchema, migrationStrategies: itemMigrationStrategies },
      });
      await items.insert(item({
        type: "article",
        fields: { author: "Ada", readingMinutes: 5, topics: ["crdt", "offline"] },
        blocks: [{ id: "body", kind: "richtext", text: "<p>Hello</p>", json: { type: "doc" } }],
        blobs: [{
          key: "archive/user/item/hash.html",
          kind: "archive",
          contentType: "text/html; charset=utf-8",
          byteSize: 4096,
          hash: "abc123",
          capturedAt: 2,
        }],
        summary: "A summary",
        ai: { status: "done", autoTags: ["saved"], image: { caption: "Preview" } },
      }));

      expect((await items.findOne("item-1").exec())?.toMutableJSON()).toMatchObject({
        type: "article",
        fields: { author: "Ada", readingMinutes: 5, topics: ["crdt", "offline"] },
        blocks: [{ id: "body", kind: "richtext", json: { type: "doc" } }],
        blobs: [{ key: "archive/user/item/hash.html", kind: "archive", byteSize: 4096 }],
        summary: "A summary",
        ai: { status: "done", autoTags: ["saved"], image: { caption: "Preview" } },
      });
    } finally {
      await database.remove();
    }
  });

  it("migrates an existing v0 item database in place", async () => {
    const name = `item-schema-migration-${crypto.randomUUID()}`;
    const storage = wrappedValidateZSchemaStorage({ storage: getRxStorageMemory() });
    const oldDatabase = await createRxDatabase({ name, storage, ignoreDuplicate: true });
    const oldCollections = await oldDatabase.addCollections({ items: { schema: v0ItemSchema() } });
    await oldCollections.items.insert(item());
    await oldDatabase.close();

    const newDatabase = await createRxDatabase({ name, storage, ignoreDuplicate: true });
    try {
      const newCollections = await newDatabase.addCollections({
        items: { schema: itemSchema, migrationStrategies: itemMigrationStrategies },
      });
      const migrated = await newCollections.items.findOne("item-1").exec();

      expect(migrated?.get("title")).toBe("Saved page");
      expect(migrated?.get("url")).toBe("https://example.com/page");
    } finally {
      await newDatabase.remove();
    }
  });

  it("normalizes required fields from every legacy schema lineage", () => {
    const legacy = item() as ItemDocType & Record<string, unknown>;
    delete legacy.userId;
    delete legacy.spaceId;
    delete legacy.ocrStatus;
    delete legacy.ocrModelVersion;
    delete legacy.ocrUpdatedAt;
    legacy.vector_index = Number.NaN;
    legacy.deletedAt = -1;

    const migrated = itemMigrationStrategies[9](legacy as ItemDocType);

    expect(migrated).toMatchObject({
      userId: "",
      spaceId: "space_public_default",
      ocrStatus: "pending",
      ocrModelVersion: "",
      ocrUpdatedAt: 0,
      vector_index: -1,
      deletedAt: 0,
    });
  });
});
