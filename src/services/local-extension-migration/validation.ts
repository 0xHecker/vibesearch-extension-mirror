import {
  jsonFiniteNumber,
  jsonObject,
  type JsonObject,
  type JsonValue,
} from "@src/common/json-value";
import { normalizeArchiveItemId } from "@src/services/archive-identity";
import {
  decodedBase64ByteLength,
  LOCAL_MIGRATION_MAX_ARCHIVE_FILE_BYTES,
  LOCAL_MIGRATION_MAX_ARCHIVE_TOTAL_BYTES,
  LOCAL_MIGRATION_MAX_BINARY_FILES,
  LOCAL_MIGRATION_MAX_DECODED_BYTES,
  LOCAL_MIGRATION_MAX_MEDIA_FILE_BYTES,
  parseOpfsPath,
} from "@src/services/local-extension-migration/binary";
import { getReferencedOpfsPaths, redactMigrationCredentials } from "@src/services/local-extension-migration/collections";
import {
  LOCAL_MIGRATION_COLLECTION_NAMES,
  LOCAL_MIGRATION_FORMAT,
  type LocalExtensionMigrationBundle,
  type MigratedArchiveFile,
  type MigratedOpfsFile,
  type MigrationCollections,
} from "@src/services/local-extension-migration/model";
import { z } from "zod";

const migrationRowSchema: z.ZodType<JsonObject> = z.record(
  z.string(),
  z.json(),
);
const migrationRowsSchema = z.array(migrationRowSchema);
const migrationCollectionsSchema: z.ZodType<MigrationCollections> = z.object({
  space_groups: migrationRowsSchema,
  spaces: migrationRowsSchema,
  folders: migrationRowsSchema,
  items: migrationRowsSchema,
  tags: migrationRowsSchema,
  item_tags: migrationRowsSchema,
  search_history: migrationRowsSchema,
  flashcards: migrationRowsSchema,
  deleted_items: migrationRowsSchema,
});
const versionSchema = z
  .union([z.literal(1), z.literal(2), z.literal("1"), z.literal("2")])
  .transform((version) => (version === 1 || version === "1" ? 1 : 2));
const warningsSchema = z.array(z.string().max(2_000)).max(10_000);
const rawFileListSchema = z.array(z.json());
const opfsFileSchema: z.ZodType<MigratedOpfsFile> = z.object({
  opfsPath: z.string(),
  mimeType: z.string(),
  base64: z.string(),
});
const archiveFileSchema: z.ZodType<MigratedArchiveFile> = z.object({
  itemId: z.string(),
  mimeType: z.string(),
  updatedAt: z.number().int().nonnegative().safe(),
  base64: z.string(),
});

function parseCollections(
  value: JsonValue | undefined,
): MigrationCollections {
  const parsed = migrationCollectionsSchema.safeParse(value);
  if (parsed.success) return parsed.data;

  const collectionObject = jsonObject(value);
  if (!collectionObject) {
    throw new Error("MIGRATION_FILE_COLLECTIONS_INVALID");
  }
  for (const name of LOCAL_MIGRATION_COLLECTION_NAMES) {
    if (!migrationRowsSchema.safeParse(collectionObject[name]).success) {
      throw new Error(`MIGRATION_FILE_${name.toUpperCase()}_INVALID`);
    }
  }
  throw new Error("MIGRATION_FILE_COLLECTIONS_INVALID");
}

function parseOpfsFiles(
  value: JsonValue | undefined,
): MigratedOpfsFile[] {
  const rawFiles = rawFileListSchema.safeParse(value);
  if (!rawFiles.success) throw new Error("MIGRATION_FILE_MEDIA_INVALID");
  if (rawFiles.data.length > LOCAL_MIGRATION_MAX_BINARY_FILES) {
    throw new Error("MIGRATION_FILE_TOO_MANY_BINARY_FILES");
  }

  return rawFiles.data.map((rawFile) => {
    const parsed = opfsFileSchema.safeParse(rawFile);
    if (!parsed.success || !parseOpfsPath(parsed.data.opfsPath)) {
      throw new Error("MIGRATION_FILE_MEDIA_ENTRY_INVALID");
    }
    return parsed.data;
  });
}

function parseArchiveFiles(
  value: JsonValue | undefined,
  version: 1 | 2,
): MigratedArchiveFile[] {
  if (value === undefined && version === 1) return [];
  const rawFiles = rawFileListSchema.safeParse(value);
  if (!rawFiles.success) throw new Error("MIGRATION_FILE_ARCHIVES_INVALID");

  return rawFiles.data.map((rawFile) => {
    const parsed = archiveFileSchema.safeParse(rawFile);
    if (!parsed.success || !normalizeArchiveItemId(parsed.data.itemId)) {
      throw new Error("MIGRATION_FILE_ARCHIVE_ENTRY_INVALID");
    }
    return parsed.data;
  });
}

function validateMediaManifest(
  bundle: LocalExtensionMigrationBundle,
): number {
  const referencedPaths = new Set(
    getReferencedOpfsPaths(bundle.collections.items),
  );
  const includedPaths = new Set<string>();
  let decodedBytes = 0;

  for (const file of bundle.opfsFiles) {
    if (includedPaths.has(file.opfsPath)) {
      throw new Error("MIGRATION_FILE_DUPLICATE_MEDIA_PATH");
    }
    includedPaths.add(file.opfsPath);
    if (bundle.version >= 2 && !referencedPaths.has(file.opfsPath)) {
      throw new Error("MIGRATION_FILE_UNREFERENCED_MEDIA_PATH");
    }
    const byteSize = decodedBase64ByteLength(file.base64);
    if (byteSize < 0 || byteSize > LOCAL_MIGRATION_MAX_MEDIA_FILE_BYTES) {
      throw new Error("MIGRATION_FILE_MEDIA_SIZE_INVALID");
    }
    decodedBytes += byteSize;
  }

  if (bundle.version >= 2) {
    for (const referencedPath of referencedPaths) {
      if (!includedPaths.has(referencedPath)) {
        throw new Error("MIGRATION_FILE_REFERENCED_MEDIA_MISSING");
      }
    }
  }
  return decodedBytes;
}

function validateArchiveManifest(
  bundle: LocalExtensionMigrationBundle,
): number {
  if (
    bundle.opfsFiles.length + bundle.archiveFiles.length >
    LOCAL_MIGRATION_MAX_BINARY_FILES
  ) {
    throw new Error("MIGRATION_FILE_TOO_MANY_BINARY_FILES");
  }

  const migrationItemIds = new Set(
    bundle.collections.items
      .map((item) => z.string().safeParse(item.id))
      .filter((result) => result.success)
      .map((result) => result.data),
  );
  const archivedItemIds = new Set<string>();
  let archiveBytes = 0;
  for (const file of bundle.archiveFiles) {
    if (!migrationItemIds.has(file.itemId)) {
      throw new Error("MIGRATION_FILE_UNREFERENCED_ARCHIVE");
    }
    if (archivedItemIds.has(file.itemId)) {
      throw new Error("MIGRATION_FILE_DUPLICATE_ARCHIVE");
    }
    archivedItemIds.add(file.itemId);
    const byteSize = decodedBase64ByteLength(file.base64);
    if (
      byteSize <= 0 ||
      byteSize > LOCAL_MIGRATION_MAX_ARCHIVE_FILE_BYTES
    ) {
      throw new Error("MIGRATION_FILE_ARCHIVE_SIZE_INVALID");
    }
    archiveBytes += byteSize;
    if (archiveBytes > LOCAL_MIGRATION_MAX_ARCHIVE_TOTAL_BYTES) {
      throw new Error("MIGRATION_FILE_ARCHIVES_TOO_LARGE");
    }
  }
  return archiveBytes;
}

export const validateLocalExtensionMigrationBundle = (
  value: JsonValue,
): LocalExtensionMigrationBundle => {
  const root = jsonObject(value);
  if (!root) throw new Error("MIGRATION_FILE_INVALID");

  const versionResult = versionSchema.safeParse(root.version);
  if (root.format !== LOCAL_MIGRATION_FORMAT || !versionResult.success) {
    throw new Error("MIGRATION_FILE_VERSION_UNSUPPORTED");
  }
  const createdAt = jsonFiniteNumber(root.createdAt);
  if (createdAt === undefined) throw new Error("MIGRATION_FILE_INVALID");

  const warningsResult = warningsSchema.safeParse(root.warnings);
  if (!warningsResult.success) {
    throw new Error("MIGRATION_FILE_WARNINGS_INVALID");
  }
  const collections = parseCollections(root.collections);
  const opfsFiles = parseOpfsFiles(root.opfsFiles);
  const archiveFiles = parseArchiveFiles(
    root.archiveFiles,
    versionResult.data,
  );
  const warnings = [...warningsResult.data];
  const bundle: LocalExtensionMigrationBundle = {
    format: LOCAL_MIGRATION_FORMAT,
    version: versionResult.data,
    createdAt,
    collections,
    opfsFiles,
    archiveFiles,
    warnings,
  };

  const decodedBytes =
    validateMediaManifest(bundle) + validateArchiveManifest(bundle);
  if (decodedBytes > LOCAL_MIGRATION_MAX_DECODED_BYTES) {
    throw new Error("MIGRATION_FILE_BINARY_DATA_TOO_LARGE");
  }

  return {
    ...bundle,
    collections: redactMigrationCredentials(collections, warnings),
    warnings,
  };
};
