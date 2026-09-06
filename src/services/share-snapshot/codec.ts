import { jsonObject, type JsonValue } from "@src/common/json-value";
import { PUBLIC_SPACE_ID } from "@src/common/spaces";
import type {
  ItemDocType,
  MediaOcrMetadata,
} from "@src/schemas/item_schema";
import type { ItemTagDocType } from "@src/schemas/item_tag_schema";
import type { FolderDocType } from "@src/schemas/folder_schema";
import type { SpaceDocType } from "@src/schemas/space_schema";
import type { SpaceGroupDocType } from "@src/schemas/space_group_schema";
import type { TagDocType } from "@src/schemas/tag_schema";
import type {
  ShareSnapshotV1,
  ShareSnapshotWarning,
  SharedFolder,
  SharedItem,
  SharedItemTag,
  SharedMedia,
  SharedSpace,
  SharedSpaceGroup,
  SharedTag,
} from "@src/services/share-snapshot/model";
import { z } from "zod";

const MAX_RECORDS_PER_COLLECTION = 500_000;
const itemSourceSchema: z.ZodType<ItemDocType["source"]> = z.enum([
  "web",
  "twitter",
  "reddit",
  "note",
  "youtube",
  "instagram",
  "tiktok",
  "substack",
  "linkedin",
  "threads",
  "mastodon",
  "bluesky",
  "github",
  "spotify",
  "ytmusic",
  "vimeo",
  "soundcloud",
  "article",
]);
const snapshotIdSchema = z
  .string()
  .max(100)
  .refine((value) => value.trim().length > 0);
const safeIntegerSchema = z
  .number()
  .int()
  .nonnegative()
  .lt(Number.MAX_SAFE_INTEGER);
const finiteNumberSchema = z.number().finite();
const optionalReference = (maxLength: number) =>
  z.union([z.string().max(maxLength), z.null()]).optional();
const optionalJsonOwner = <Owner>() =>
  z
    .custom<Owner>((value: any) => jsonObject(value) !== undefined)
    .optional();

const ocrSchema = z
  .object({
    status: z.enum(["pending", "processing", "done", "error", "skipped"]),
    text: z.string().optional(),
    confidence: z.number().finite().min(0).max(1).nullable().optional(),
    lineCount: safeIntegerSchema.optional(),
    extractedAt: safeIntegerSchema.optional(),
    language: z.string().optional(),
    engine: z.string().optional(),
  })
  .loose();

const mediaSchema: z.ZodType<SharedMedia> = z
  .object({
    id: z.string().max(512).optional(),
    type: z.enum(["image", "video", "audio", "file"]),
    originalUrl: z.string().optional(),
    storageType: z.enum(["hotlink", "s3"]),
    s3Url: z.string().optional(),
    s3ThumbnailUrl: z.string().optional(),
    embedUrl: z.string().optional(),
    embedType: z.literal("iframe").optional(),
    thumbnailUrl: z.string().optional(),
    mimeType: z.string().max(255).optional(),
    fileName: z.string().max(1_024).optional(),
    byteSize: safeIntegerSchema.optional(),
    contentHash: z.string().max(512).optional(),
    durationSec: finiteNumberSchema.nonnegative().optional(),
    provider: z.string().max(256).optional(),
    externalId: z.string().max(512).optional(),
    altText: z.string().optional(),
    titleText: z.string().optional(),
    ariaLabel: z.string().optional(),
    pageUrl: z.string().optional(),
    pageTitle: z.string().optional(),
    siteName: z.string().optional(),
    faviconUrl: z.string().optional(),
    width: finiteNumberSchema.optional(),
    height: finiteNumberSchema.optional(),
    capturedAt: safeIntegerSchema.optional(),
    ocr: ocrSchema.optional(),
  })
  .loose();

const blockSchema: z.ZodType<
  NonNullable<SharedItem["blocks"]>[number]
> = z
  .object({
    id: z.string().min(1).max(200),
    kind: z.enum(["text", "markdown", "html", "code", "quote", "richtext"]),
    label: z.string().optional(),
    text: z.string().optional(),
    json: z.any().optional(),
    r2Key: z.string().optional(),
    language: z.string().max(200).optional(),
    searchable: z.boolean().optional(),
    createdAt: safeIntegerSchema.optional(),
    updatedAt: safeIntegerSchema.optional(),
  })
  .strict();

const blobSchema: z.ZodType<
  NonNullable<SharedItem["blobs"]>[number]
> = z
  .object({
    key: z.string().min(1),
    kind: z.enum(["html", "pdf", "json", "text", "archive", "other"]),
    contentType: z.string().max(500).optional(),
    byteSize: safeIntegerSchema.optional(),
    label: z.string().optional(),
    hash: z.string().max(256).optional(),
    capturedAt: safeIntegerSchema.optional(),
  })
  .strict();

const sharedItemSchema: z.ZodType<SharedItem> = z
  .object({
    id: snapshotIdSchema,
    title: z.string(),
    textContent: z.string().optional(),
    ocrText: z.string().optional(),
    url: z.string(),
    source: itemSourceSchema.catch("web"),
    folderId: optionalReference(1_000).transform((value) => value ?? undefined),
    spaceId: optionalReference(1_000).transform((value) => value ?? undefined),
    authorUsername: z.string().optional(),
    likes: finiteNumberSchema.optional(),
    upvotes: finiteNumberSchema.optional(),
    media: z.array(mediaSchema).max(MAX_RECORDS_PER_COLLECTION).optional(),
    iconUrl: z.string().optional(),
    displayImageUrl: z.string().optional(),
    createdAt: safeIntegerSchema.optional(),
    updatedAt: safeIntegerSchema.optional(),
    isFavorite: z.boolean().optional(),
    type: z.string().max(200).optional(),
    fields: optionalJsonOwner<NonNullable<SharedItem["fields"]>>(),
    blocks: z.array(blockSchema).max(MAX_RECORDS_PER_COLLECTION).optional(),
    blobs: z.array(blobSchema).max(MAX_RECORDS_PER_COLLECTION).optional(),
    summary: z.string().optional(),
    ai: optionalJsonOwner<NonNullable<SharedItem["ai"]>>(),
    parentId: optionalReference(100),
    chunkOrder: finiteNumberSchema.optional(),
  })
  .loose();

const sharedSpaceGroupSchema: z.ZodType<SharedSpaceGroup> = z
  .object({
    id: snapshotIdSchema,
    name: z.string(),
    sortOrder: safeIntegerSchema.optional(),
    isCollapsed: z.boolean().optional(),
    parentGroupId: optionalReference(100),
    createdAt: safeIntegerSchema.optional(),
    updatedAt: safeIntegerSchema.optional(),
  })
  .loose();

const sharedSpaceSchema: z.ZodType<SharedSpace> = z
  .object({
    id: snapshotIdSchema,
    name: z.string(),
    slug: z.string().max(120).optional(),
    spaceGroupId: optionalReference(100),
    sortOrder: safeIntegerSchema.optional(),
    isPrivate: z.boolean().optional(),
    createdAt: safeIntegerSchema.optional(),
    updatedAt: safeIntegerSchema.optional(),
  })
  .loose();

const sharedFolderSchema: z.ZodType<SharedFolder> = z
  .object({
    id: snapshotIdSchema,
    name: z.string(),
    spaceId: optionalReference(1_000).transform((value) => value ?? undefined),
    parentId: optionalReference(1_000),
    type: z.enum(["folder", "tab_group"]).optional(),
    sortOrder: safeIntegerSchema.optional(),
    isPinned: z.boolean().optional(),
    isCollapsed: z.boolean().optional(),
    createdAt: safeIntegerSchema.optional(),
    updatedAt: safeIntegerSchema.optional(),
  })
  .loose();

const sharedTagSchema: z.ZodType<SharedTag> = z
  .object({
    id: snapshotIdSchema,
    name: z.string(),
    color: z.string().max(32).nullable().optional(),
    isFavorite: z.boolean().optional(),
    createdAt: safeIntegerSchema.optional(),
    updatedAt: safeIntegerSchema.optional(),
  })
  .loose();

const sharedItemTagSchema: z.ZodType<SharedItemTag> = z
  .object({
    itemId: snapshotIdSchema,
    tagId: snapshotIdSchema,
  })
  .loose();

const warningSchema: z.ZodType<ShareSnapshotWarning> = z
  .object({
    code: z.string(),
    itemId: z.string().optional(),
    detail: z.string().optional(),
  })
  .loose();

function parseBoundedArray<Row>(
  value: JsonValue | undefined,
  rowSchema: z.ZodType<Row>,
  collectionCode: string,
  rowCode: string,
): Row[] {
  const arrayResult = z
    .array(z.any())
    .max(MAX_RECORDS_PER_COLLECTION)
    .safeParse(value);
  if (!arrayResult.success) throw new Error(collectionCode);
  return arrayResult.data.map((row) => {
    const parsed = rowSchema.safeParse(row);
    if (!parsed.success) throw new Error(rowCode);
    return parsed.data;
  });
}

function assertUniqueKeys<Row>(
  rows: readonly Row[],
  getKey: (row: Row) => string,
  code: string,
): void {
  const seen = new Set<string>();
  for (const row of rows) {
    const key = getKey(row);
    if (seen.has(key)) throw new Error(code);
    seen.add(key);
  }
}

function itemValidationCode(error: z.ZodError): string {
  const topLevelField = error.issues[0]?.path[0];
  if (topLevelField === "media") return "SHARE_SNAPSHOT_ITEM_MEDIA_INVALID";
  if (topLevelField === "blocks") return "SHARE_SNAPSHOT_ITEM_BLOCKS_INVALID";
  if (topLevelField === "blobs") return "SHARE_SNAPSHOT_ITEM_BLOBS_INVALID";
  if (topLevelField === "fields") return "SHARE_SNAPSHOT_ITEM_FIELDS_INVALID";
  if (topLevelField === "ai") return "SHARE_SNAPSHOT_ITEM_AI_INVALID";
  return "SHARE_SNAPSHOT_ITEM_INVALID";
}

export function validateSnapshot(value: any): ShareSnapshotV1 {
  const root = jsonObject(value);
  if (!root) throw new Error("SHARE_SNAPSHOT_INVALID");
  if (root.schemaVersion !== 1) {
    throw new Error("SHARE_SNAPSHOT_VERSION_UNSUPPORTED");
  }
  if (
    root.backupMetadataVersion !== undefined &&
    root.backupMetadataVersion !== 1
  ) {
    throw new Error("SHARE_SNAPSHOT_BACKUP_METADATA_VERSION_INVALID");
  }
  const header = z
    .object({
      title: z.string(),
      description: z.string().optional(),
      createdAt: safeIntegerSchema,
      source: z.object({
        kind: z.enum(["folder", "folders", "items"]),
        ids: z.array(snapshotIdSchema).max(MAX_RECORDS_PER_COLLECTION),
      }),
    })
    .safeParse(root);
  if (!header.success) {
    const field = header.error.issues[0]?.path[0];
    throw new Error(
      field === "source"
        ? "SHARE_SNAPSHOT_SOURCE_INVALID"
        : "SHARE_SNAPSHOT_INVALID",
    );
  }

  const spaceGroups = parseBoundedArray(
    root.spaceGroups ?? [],
    sharedSpaceGroupSchema,
    "SHARE_SNAPSHOT_SPACE_GROUPS_INVALID",
    "SHARE_SNAPSHOT_SPACE_GROUP_INVALID",
  );
  const spaces = parseBoundedArray(
    root.spaces,
    sharedSpaceSchema,
    "SHARE_SNAPSHOT_SPACES_INVALID",
    "SHARE_SNAPSHOT_SPACE_INVALID",
  );
  const folders = parseBoundedArray(
    root.folders,
    sharedFolderSchema,
    "SHARE_SNAPSHOT_FOLDERS_INVALID",
    "SHARE_SNAPSHOT_FOLDER_INVALID",
  );

  const rawItems = z
    .array(z.any())
    .max(MAX_RECORDS_PER_COLLECTION)
    .safeParse(root.items);
  if (!rawItems.success) throw new Error("SHARE_SNAPSHOT_ITEMS_INVALID");
  const items = rawItems.data.map((row) => {
    const parsed = sharedItemSchema.safeParse(row);
    if (!parsed.success) throw new Error(itemValidationCode(parsed.error));
    return parsed.data;
  });

  const tags = parseBoundedArray(
    root.tags,
    sharedTagSchema,
    "SHARE_SNAPSHOT_TAGS_INVALID",
    "SHARE_SNAPSHOT_TAG_INVALID",
  );
  const itemTags = parseBoundedArray(
    root.itemTags,
    sharedItemTagSchema,
    "SHARE_SNAPSHOT_ITEM_TAGS_INVALID",
    "SHARE_SNAPSHOT_ITEM_TAG_INVALID",
  );
  const warnings =
    root.warnings === undefined
      ? undefined
      : parseBoundedArray(
          root.warnings,
          warningSchema,
          "SHARE_SNAPSHOT_WARNINGS_INVALID",
          "SHARE_SNAPSHOT_WARNINGS_INVALID",
        );

  assertUniqueKeys(
    spaceGroups,
    (row) => row.id,
    "SHARE_SNAPSHOT_DUPLICATE_SPACE_GROUP_ID",
  );
  assertUniqueKeys(
    spaces,
    (row) => row.id,
    "SHARE_SNAPSHOT_DUPLICATE_SPACE_ID",
  );
  assertUniqueKeys(
    folders,
    (row) => row.id,
    "SHARE_SNAPSHOT_DUPLICATE_FOLDER_ID",
  );
  assertUniqueKeys(
    items,
    (row) => row.id,
    "SHARE_SNAPSHOT_DUPLICATE_ITEM_ID",
  );
  assertUniqueKeys(
    tags,
    (row) => row.id,
    "SHARE_SNAPSHOT_DUPLICATE_TAG_ID",
  );
  assertUniqueKeys(
    itemTags,
    (row) => `${row.itemId}\0${row.tagId}`,
    "SHARE_SNAPSHOT_DUPLICATE_ITEM_TAG",
  );

  return {
    schemaVersion: 1,
    backupMetadataVersion:
      root.backupMetadataVersion === 1 ? 1 : undefined,
    ...header.data,
    spaceGroups,
    spaces,
    folders,
    items,
    tags,
    itemTags,
    warnings,
  };
}

export function normalizeText(
  value: string | null | undefined,
  maxLength: number,
): string | undefined {
  if (!value) return undefined;
  const text = value.replace(/\r\n/g, "\n").trim();
  return text ? text.slice(0, maxLength) : undefined;
}

export function normalizeTitle(
  value: string | null | undefined,
  fallback: string,
): string {
  return normalizeText(value, 160) || fallback.slice(0, 160);
}

export function normalizeEntityName(
  value: string | null | undefined,
  fallback: string,
  maxLength: number,
): string {
  return normalizeText(value, maxLength) || fallback.slice(0, maxLength);
}

export function normalizeUrl(
  value: string | null | undefined,
): string | undefined {
  const trimmed = value?.trim();
  if (!trimmed) return undefined;
  if (trimmed.startsWith("data:image/")) return trimmed;
  try {
    const parsed = new URL(trimmed);
    if (parsed.protocol === "http:" || parsed.protocol === "https:") {
      return parsed.toString();
    }
  } catch {}
  return undefined;
}

export function normalizeNumber(
  value: number | null | undefined,
): number | undefined {
  if (!Number.isFinite(value)) return undefined;
  return Math.min(
    Number.MAX_SAFE_INTEGER - 1,
    Math.max(0, Math.floor(value ?? 0)),
  );
}

export function normalizeSource(
  value: ItemDocType["source"] | undefined,
): ItemDocType["source"] {
  return itemSourceSchema.safeParse(value).data ?? "web";
}

export function normalizeSourceIds(
  value: readonly string[] | undefined,
): string[] {
  return (value ?? []).filter((entry) => entry.trim().length > 0);
}

export function sanitizeSpace(space: SpaceDocType): SharedSpace {
  return {
    id: space.id,
    name: normalizeEntityName(space.name, "Space", 80),
    slug: normalizeText(space.slug, 120),
    spaceGroupId: space.spaceGroupId || null,
    sortOrder: normalizeNumber(space.sortOrder),
    isPrivate: space.isPrivate === true,
    createdAt: normalizeNumber(space.createdAt),
    updatedAt: normalizeNumber(space.updatedAt),
  };
}

export function sanitizeSpaceGroup(
  group: SpaceGroupDocType,
): SharedSpaceGroup {
  return {
    id: group.id,
    name: normalizeEntityName(group.name, "Space group", 80),
    sortOrder: normalizeNumber(group.sortOrder) || 0,
    isCollapsed: group.isCollapsed === true,
    parentGroupId: group.parentGroupId || null,
    createdAt: normalizeNumber(group.createdAt) || 0,
    updatedAt: normalizeNumber(group.updatedAt) || 0,
  };
}

export function sanitizeFolder(folder: FolderDocType): SharedFolder {
  return {
    id: folder.id,
    name: normalizeTitle(folder.name, "Folder"),
    spaceId: folder.spaceId || PUBLIC_SPACE_ID,
    parentId: folder.parentId || null,
    type: folder.type === "tab_group" ? "tab_group" : "folder",
    sortOrder: normalizeNumber(folder.sortOrder),
    isPinned: folder.isPinned === true,
    isCollapsed: folder.isCollapsed === true,
    createdAt: normalizeNumber(folder.createdAt),
    updatedAt: normalizeNumber(folder.updatedAt),
  };
}

function sanitizeOcr(
  value: MediaOcrMetadata | undefined,
): SharedMedia["ocr"] | undefined {
  if (!value) return undefined;
  return {
    status: value.status,
    text: normalizeText(value.text, 20_000),
    confidence:
      value.confidence !== undefined && Number.isFinite(value.confidence)
        ? value.confidence
        : null,
    lineCount: normalizeNumber(value.lineCount),
    extractedAt: normalizeNumber(value.extractedAt),
    language: normalizeText(value.language, 40),
    engine: normalizeText(value.engine, 80),
  };
}

function sanitizeMedia(
  item: ItemDocType,
  warnings: ShareSnapshotWarning[],
): SharedMedia[] {
  const output: SharedMedia[] = [];
  for (const entry of item.media || []) {
    const originalUrl =
      normalizeUrl(entry.originalUrl) ||
      normalizeUrl(entry.s3Url) ||
      normalizeUrl(entry.thumbnailUrl);
    const s3Url = normalizeUrl(entry.s3Url);
    if (entry.storageType === "opfs" && !s3Url && !originalUrl) {
      warnings.push({
        code: "MEDIA_OPFS_SKIPPED",
        itemId: item.id,
        detail: "Local OPFS media must be promoted before export.",
      });
      continue;
    }
    output.push({
      id: normalizeText(entry.id, 512),
      type: entry.type,
      originalUrl,
      storageType: s3Url ? "s3" : "hotlink",
      s3Url,
      s3ThumbnailUrl: normalizeUrl(entry.s3ThumbnailUrl),
      embedUrl: normalizeUrl(entry.embedUrl),
      embedType: entry.embedType === "iframe" ? "iframe" : undefined,
      thumbnailUrl: normalizeUrl(entry.thumbnailUrl),
      mimeType: normalizeText(entry.mimeType, 255),
      fileName: normalizeText(entry.fileName, 1_024),
      byteSize: normalizeNumber(entry.byteSize),
      contentHash: normalizeText(entry.contentHash, 512),
      durationSec: normalizeNumber(entry.durationSec),
      provider: normalizeText(entry.provider, 256),
      externalId: normalizeText(entry.externalId, 512),
      altText: normalizeText(entry.altText, 500),
      titleText: normalizeText(entry.titleText, 500),
      ariaLabel: normalizeText(entry.ariaLabel, 500),
      pageUrl: normalizeUrl(entry.pageUrl),
      pageTitle: normalizeText(entry.pageTitle, 500),
      siteName: normalizeText(entry.siteName, 200),
      faviconUrl: normalizeUrl(entry.faviconUrl),
      width: normalizeNumber(entry.width),
      height: normalizeNumber(entry.height),
      capturedAt: normalizeNumber(entry.capturedAt),
      ocr: sanitizeOcr(entry.ocr),
    });
  }
  return output;
}

export function sanitizeItem(
  item: ItemDocType,
  warnings: ShareSnapshotWarning[],
  options: { includeBackupMetadata?: boolean } = {},
): SharedItem {
  const sanitized: SharedItem = {
    id: item.id,
    title: normalizeTitle(item.title, item.url || "Untitled"),
    textContent: normalizeText(item.textContent, 20_000),
    ocrText: normalizeText(item.ocrText, 20_000),
    url:
      normalizeUrl(item.url) ||
      `https://local.vibesearch.invalid/item/${encodeURIComponent(item.id)}`,
    source: normalizeSource(item.source),
    folderId: item.folderId,
    spaceId: item.spaceId || PUBLIC_SPACE_ID,
    authorUsername: normalizeText(item.authorUsername, 160),
    likes: normalizeNumber(item.likes),
    upvotes: normalizeNumber(item.upvotes),
    media: sanitizeMedia(item, warnings),
    iconUrl: normalizeUrl(item.iconUrl),
    displayImageUrl: normalizeUrl(item.displayImageUrl),
    createdAt: normalizeNumber(item.createdAt),
    updatedAt: normalizeNumber(item.updatedAt),
  };
  if (!options.includeBackupMetadata) return sanitized;

  sanitized.isFavorite = item.isFavorite === true;
  sanitized.type = normalizeText(item.type, 120);
  sanitized.fields = item.fields ? structuredClone(item.fields) : undefined;
  sanitized.blocks = item.blocks ? structuredClone(item.blocks) : undefined;
  sanitized.blobs = item.blobs ? structuredClone(item.blobs) : undefined;
  sanitized.summary = normalizeText(item.summary, 20_000);
  sanitized.ai = item.ai ? structuredClone(item.ai) : undefined;
  sanitized.parentId = item.parentId || null;
  sanitized.chunkOrder = normalizeNumber(item.chunkOrder);
  return sanitized;
}

export function sanitizeTag(tag: TagDocType): SharedTag {
  return {
    id: tag.id,
    name: normalizeEntityName(tag.name, "tag", 100),
    color: tag.color ?? null,
    isFavorite: tag.isFavorite === true,
    createdAt: normalizeNumber(tag.createdAt),
    updatedAt: normalizeNumber(tag.updatedAt),
  };
}

export function sanitizeItemTag(join: ItemTagDocType): SharedItemTag {
  return { itemId: join.itemId, tagId: join.tagId };
}

export function toImportedItem(
  item: SharedItem,
  id: string,
  folderId: string,
  spaceId: string,
  now: number,
): ItemDocType {
  return {
    id,
    userId: "",
    title: normalizeTitle(item.title, item.url || "Imported item"),
    textContent: normalizeText(item.textContent, 20_000) || "",
    ocrText: normalizeText(item.ocrText, 20_000),
    ocrStatus: item.ocrText ? "done" : "pending",
    ocrModelVersion: "",
    ocrUpdatedAt: item.ocrText ? now : 0,
    url:
      normalizeUrl(item.url) ||
      `https://local.vibesearch.invalid/import/${id}`,
    source: normalizeSource(item.source),
    folderId,
    spaceId,
    isFavorite: item.isFavorite === true,
    authorUsername: normalizeText(item.authorUsername, 160),
    likes: normalizeNumber(item.likes),
    upvotes: normalizeNumber(item.upvotes),
    media: (item.media || [])
      .map(toImportedMedia)
      .filter((entry) => entry !== null),
    type: normalizeText(item.type, 120),
    fields: item.fields ? structuredClone(item.fields) : undefined,
    blocks: item.blocks ? structuredClone(item.blocks) : undefined,
    blobs: item.blobs ? structuredClone(item.blobs) : undefined,
    iconUrl: normalizeUrl(item.iconUrl),
    displayImageUrl: normalizeUrl(item.displayImageUrl),
    summary: normalizeText(item.summary, 20_000),
    ai: item.ai ? structuredClone(item.ai) : undefined,
    parentId: item.parentId || null,
    chunkOrder: normalizeNumber(item.chunkOrder),
    vector_index: -1,
    vector_indexes: [],
    isEmbedded: false,
    isMetaFetched: true,
    isDirty: true,
    serverVersion: 0,
    createdAt: normalizeNumber(item.createdAt) || now,
    updatedAt: now,
    deletedAt: 0,
  };
}

function toImportedMedia(
  entry: SharedMedia,
): NonNullable<ItemDocType["media"]>[number] | null {
  const originalUrl =
    normalizeUrl(entry.originalUrl) ||
    normalizeUrl(entry.s3Url) ||
    normalizeUrl(entry.thumbnailUrl);
  if (!originalUrl) return null;
  return {
    id: normalizeText(entry.id, 512),
    type: entry.type,
    originalUrl,
    storageType: entry.s3Url ? "s3" : "hotlink",
    s3Url: normalizeUrl(entry.s3Url),
    s3ThumbnailUrl: normalizeUrl(entry.s3ThumbnailUrl),
    embedUrl: normalizeUrl(entry.embedUrl),
    embedType: entry.embedType === "iframe" ? "iframe" : undefined,
    thumbnailUrl: normalizeUrl(entry.thumbnailUrl),
    mimeType: normalizeText(entry.mimeType, 255),
    fileName: normalizeText(entry.fileName, 1_024),
    byteSize: normalizeNumber(entry.byteSize),
    contentHash: normalizeText(entry.contentHash, 512),
    durationSec: normalizeNumber(entry.durationSec),
    provider: normalizeText(entry.provider, 256),
    externalId: normalizeText(entry.externalId, 512),
    altText: normalizeText(entry.altText, 500),
    titleText: normalizeText(entry.titleText, 500),
    ariaLabel: normalizeText(entry.ariaLabel, 500),
    pageUrl: normalizeUrl(entry.pageUrl),
    pageTitle: normalizeText(entry.pageTitle, 500),
    siteName: normalizeText(entry.siteName, 200),
    faviconUrl: normalizeUrl(entry.faviconUrl),
    width: normalizeNumber(entry.width),
    height: normalizeNumber(entry.height),
    capturedAt: normalizeNumber(entry.capturedAt),
    ocr: entry.ocr
      ? {
          status: entry.ocr.status,
          text: normalizeText(entry.ocr.text, 20_000),
          confidence:
            entry.ocr.confidence !== undefined &&
            Number.isFinite(entry.ocr.confidence)
              ? entry.ocr.confidence
              : null,
          lineCount: normalizeNumber(entry.ocr.lineCount),
          extractedAt: normalizeNumber(entry.ocr.extractedAt),
          language: normalizeText(entry.ocr.language, 40),
          engine: normalizeText(entry.ocr.engine, 80),
        }
      : undefined,
  };
}

export function sendDbChange(
  scope: "items" | "folders" | "tags" | "spaces",
): void {
  try {
    chrome.runtime.sendMessage({ type: "DB_CHANGE", scope });
  } catch {}
}
