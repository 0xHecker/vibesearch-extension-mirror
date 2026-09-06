import type { JsonObject } from "@src/common/json-value";

export const LOCAL_MIGRATION_FORMAT = "vibesearch-local-extension-migration";
export const LOCAL_MIGRATION_VERSION = 2;
export const SUPPORTED_LOCAL_MIGRATION_VERSIONS = new Set([1, LOCAL_MIGRATION_VERSION]);

export const LOCAL_MIGRATION_COLLECTION_NAMES = [
  // Groups come first because spaces reference them during restore.
  "space_groups",
  "spaces",
  "folders",
  "items",
  "tags",
  "item_tags",
  "search_history",
  "flashcards",
  "deleted_items",
] as const;

export type MigrationCollectionName =
  (typeof LOCAL_MIGRATION_COLLECTION_NAMES)[number];

export type MigrationCollections = {
  space_groups: JsonObject[];
  spaces: JsonObject[];
  folders: JsonObject[];
  items: JsonObject[];
  tags: JsonObject[];
  item_tags: JsonObject[];
  search_history: JsonObject[];
  flashcards: JsonObject[];
  deleted_items: JsonObject[];
};

export type MigratedOpfsFile = {
  opfsPath: string;
  mimeType: string;
  base64: string;
};

export type MigratedArchiveFile = {
  itemId: string;
  mimeType: string;
  updatedAt: number;
  base64: string;
};

export type LocalExtensionMigrationBundle = {
  format: typeof LOCAL_MIGRATION_FORMAT;
  version: 1 | typeof LOCAL_MIGRATION_VERSION;
  createdAt: number;
  collections: MigrationCollections;
  opfsFiles: MigratedOpfsFile[];
  archiveFiles: MigratedArchiveFile[];
  warnings: string[];
};

export type MigrationCollectionCounts = {
  space_groups: number;
  spaces: number;
  folders: number;
  items: number;
  tags: number;
  item_tags: number;
  search_history: number;
  flashcards: number;
  deleted_items: number;
};

export type LocalExtensionMigrationSummary = {
  collections: MigrationCollectionCounts;
  opfsFileCount: number;
  archiveFileCount: number;
  warningCount: number;
};

export type RestoreLocalExtensionMigrationResult =
  LocalExtensionMigrationSummary & {
    restoredOpfsFileCount: number;
    restoredArchiveFileCount: number;
    scheduledReembeddingItemCount: number;
    metadataPendingUrlCount: number;
  };

export const createEmptyMigrationCollections = (): MigrationCollections => ({
  space_groups: [],
  spaces: [],
  folders: [],
  items: [],
  tags: [],
  item_tags: [],
  search_history: [],
  flashcards: [],
  deleted_items: [],
});

export const summarizeMigration = (
  collections: MigrationCollections,
  opfsFileCount: number,
  archiveFileCount: number,
  warningCount: number,
): LocalExtensionMigrationSummary => ({
  collections: {
    space_groups: collections.space_groups.length,
    spaces: collections.spaces.length,
    folders: collections.folders.length,
    items: collections.items.length,
    tags: collections.tags.length,
    item_tags: collections.item_tags.length,
    search_history: collections.search_history.length,
    flashcards: collections.flashcards.length,
    deleted_items: collections.deleted_items.length,
  },
  opfsFileCount,
  archiveFileCount,
  warningCount,
});
