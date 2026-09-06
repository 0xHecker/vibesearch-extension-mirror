import { addRxPlugin, createRxDatabase, type RxJsonSchema } from "rxdb";
import { RxDBMigrationSchemaPlugin } from "rxdb/plugins/migration-schema";
import { getRxStorageMemory } from "rxdb/plugins/storage-memory";
import { wrappedValidateZSchemaStorage } from "rxdb/plugins/validate-z-schema";
import { describe, expect, it } from "bun:test";
import {
  itemMigrationStrategies,
  itemSchema,
  type ItemDocType,
} from "@src/schemas/item_schema";

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

  it("accepts the current shared content contract without losing fields", async () => {
    const database = await createRxDatabase({
      name: `item-schema-shared-${crypto.randomUUID()}`,
      storage: wrappedValidateZSchemaStorage({ storage: getRxStorageMemory() }),
    });

    try {
      const { items } = await database.addCollections({
        items: { schema: itemSchema, migrationStrategies: itemMigrationStrategies },
      });
      const shared = item({
        userId: "",
        source: "threads" as ItemDocType["source"],
        updatedAt: 3,
        folderChangedAt: 2,
        fields: {
          provenance: { importer: "extension", revisions: [1, 2] },
        },
        media: [{
          id: "attachment-1",
          type: "file",
          originalUrl: "https://example.com/brief.pdf",
          storageType: "s3",
          s3Url: "https://cdn.example.com/brief.pdf",
          mimeType: "application/pdf",
          fileName: "brief.pdf",
          byteSize: 4096,
          contentHash: `sha256:${"a".repeat(64)}`,
          provider: "threads",
          externalId: "external-1",
        }],
        blocks: [{
          id: "body",
          kind: "text",
          text: "Shared body",
          createdAt: 2,
          updatedAt: 3,
        }],
        textArtifacts: [{
          key: "text/user/item/transcript.txt",
          purpose: "transcript",
          contentType: "text/plain",
          byteSize: 11,
          hash: `sha256:${"b".repeat(64)}`,
          createdAt: 3,
          language: "en",
        }],
        metadata: {
          schemaVersion: 1,
          social: { platform: "threads", postId: "post-1" },
          provenance: { method: "extension", capturedAt: 2 },
        },
        ai: {
          status: "done",
          generatedUnderstanding: {
            schemaVersion: "1",
            inputHash: "input-hash",
            generatedAt: 3,
            extractor: { identity: "server", version: "1" },
            summary: "Current generated summary",
            retrievalTerms: [],
            tagCandidates: [],
          },
        },
      } as Partial<ItemDocType>);

      await items.insert(shared);

      expect((await items.findOne("item-1").exec())?.toMutableJSON()).toMatchObject({
        userId: "",
        source: "threads",
        folderChangedAt: 2,
        fields: {
          provenance: { importer: "extension", revisions: [1, 2] },
        },
        media: [{
          id: "attachment-1",
          type: "file",
          mimeType: "application/pdf",
          fileName: "brief.pdf",
          byteSize: 4096,
          provider: "threads",
          externalId: "external-1",
        }],
        blocks: [{ id: "body", updatedAt: 3 }],
        textArtifacts: [{ purpose: "transcript", contentType: "text/plain" }],
        metadata: {
          schemaVersion: 1,
          social: { platform: "threads", postId: "post-1" },
        },
        ai: {
          status: "done",
          generatedUnderstanding: {
            schemaVersion: "1",
            summary: "Current generated summary",
          },
        },
      });
    } finally {
      await database.remove();
    }
  });

  it("migrates an existing v0 item database in place", async () => {
    const name = `item-schema-migration-${crypto.randomUUID()}`;
    const storage = wrappedValidateZSchemaStorage({ storage: getRxStorageMemory() });
    const oldDatabase = await createRxDatabase({ name, storage });
    const oldCollections = await oldDatabase.addCollections({ items: { schema: v0ItemSchema() } });
    await oldCollections.items.insert(item());
    await oldDatabase.close();

    const newDatabase = await createRxDatabase({ name, storage });
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

    const migrated = itemMigrationStrategies[itemSchema.version](legacy as ItemDocType);

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
