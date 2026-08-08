import { expect, test } from "bun:test";
import {
  assertBackupFileSize,
  createBackupJsonBlob,
  summarizeBundle,
} from "@src/pages/search/components/settings/backup-ops";
import type { LocalExtensionMigrationBundle } from "@src/services/local-extension-migration";

const bundle: LocalExtensionMigrationBundle = {
  format: "vibesearch-local-extension-migration",
  version: 2,
  createdAt: 1_723_000_000_123,
  collections: {
    space_groups: [{ id: "group-1", name: 'Quoted "name"' }],
    spaces: [],
    folders: [],
    items: [{ id: "item-1", title: "Saved page" }],
    tags: [],
    item_tags: [],
    search_history: [],
    flashcards: [],
    deleted_items: [],
  },
  opfsFiles: [
    { opfsPath: "media/item-1/image.png", mimeType: "image/png", base64: "aW1hZ2U=" },
  ],
  archiveFiles: [
    { itemId: "item-1", mimeType: "text/html", updatedAt: 42, base64: "PGh0bWw+" },
  ],
  warnings: ["example warning"],
};

test("fragmented JSON backup remains a complete round-trippable migration bundle", async () => {
  const blob = createBackupJsonBlob(bundle);
  const restored = JSON.parse(await blob.text()) as LocalExtensionMigrationBundle;

  expect(blob.type.startsWith("application/json")).toBe(true);
  expect(restored).toEqual(bundle);
  expect(summarizeBundle(restored)).toEqual({
    collections: {
      space_groups: 1,
      spaces: 0,
      folders: 0,
      items: 1,
      tags: 0,
      item_tags: 0,
      search_history: 0,
      flashcards: 0,
      deleted_items: 0,
    },
    opfsFileCount: 1,
    archiveFileCount: 1,
    warningCount: 1,
  });
});

test("backup restore size guard rejects empty and unbounded files before reading them", () => {
  expect(() => assertBackupFileSize(0)).toThrow("empty or invalid");
  expect(() => assertBackupFileSize(Number.MAX_SAFE_INTEGER)).toThrow("safe 96 MB restore limit");
  expect(() => assertBackupFileSize(1024)).not.toThrow();
});
