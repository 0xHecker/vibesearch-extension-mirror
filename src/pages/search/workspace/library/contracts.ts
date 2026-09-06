import type { BinContentsPage, BinEntry } from "@src/common/bin";
import type { JsonValue } from "@src/common/json-value";
import type { FolderDocType } from "@src/schemas/folder_schema";
import type { SpaceGroupDocType } from "@src/schemas/space_group_schema";
import type { SpaceListItem } from "@src/services/spaces/types";
import { z } from "zod";

/** Runtime schemas for lists loaded into the search library sidebar. */
const nonNegativeInteger = z.number().int().nonnegative();

const spaceAccessSchema: z.ZodType<SpaceListItem["access"]> = z.object({
  isUnlocked: z.boolean(),
  requiresPassword: z.boolean(),
  hasRecovery: z.boolean(),
  recoveryQuestions: z.array(z.string()),
  autoLockMs: nonNegativeInteger,
  remainingMs: nonNegativeInteger.optional(),
  lastActivityAt: nonNegativeInteger.optional(),
});

const spaceListItemSchema: z.ZodType<SpaceListItem> = z.object({
  id: z.string(),
  name: z.string(),
  slug: z.string(),
  spaceGroupId: z.string().nullable(),
  isPrivate: z.boolean(),
  sortOrder: nonNegativeInteger,
  isArchived: z.boolean(),
  deletedAt: nonNegativeInteger,
  purgeAt: nonNegativeInteger,
  createdAt: nonNegativeInteger,
  updatedAt: nonNegativeInteger,
  access: spaceAccessSchema,
});

const spaceGroupSchema: z.ZodType<SpaceGroupDocType> = z.object({
  id: z.string(),
  name: z.string(),
  sortOrder: nonNegativeInteger,
  isCollapsed: z.boolean(),
  parentGroupId: z.string().nullable().optional(),
  createdAt: nonNegativeInteger,
  updatedAt: nonNegativeInteger,
});

const folderSchema: z.ZodType<FolderDocType> = z.object({
  id: z.string(),
  name: z.string(),
  spaceId: z.string(),
  parentId: z.string().nullable(),
  type: z.enum(["folder", "tab_group"]),
  sortOrder: nonNegativeInteger,
  isLocked: z.boolean(),
  isPinned: z.boolean(),
  isCollapsed: z.boolean(),
  encryptionKey: z.string().optional(),
  deletedAt: nonNegativeInteger,
  purgeAt: nonNegativeInteger,
  isDirty: z.boolean(),
  serverVersion: z.number(),
  createdAt: nonNegativeInteger,
  updatedAt: nonNegativeInteger,
  userId: z.string(),
});

const binEntrySchema: z.ZodType<BinEntry> = z.object({
  kind: z.enum(["space", "folder", "item"]),
  id: z.string(),
  name: z.string(),
  subtitle: z.string(),
  deletedAt: nonNegativeInteger,
  purgeAt: nonNegativeInteger,
  spaceId: z.string().optional(),
  folderId: z.string().nullable().optional(),
  itemCount: nonNegativeInteger.optional(),
});

const binPageSchema: z.ZodType<BinContentsPage> = z.object({
  entries: z.array(binEntrySchema),
  total: nonNegativeInteger,
  hasMore: z.boolean(),
  nextCursor: z
    .object({
      purgeAt: nonNegativeInteger,
      name: z.string(),
      kind: z.enum(["space", "folder", "item"]),
      id: z.string(),
    })
    .nullable(),
});

const tagSummarySchema = z.object({ id: z.string(), name: z.string() });

export function parseSpaceList(
  payload: JsonValue | undefined,
): SpaceListItem[] {
  return z.array(spaceListItemSchema).parse(payload);
}

export function parseSpace(payload: JsonValue | undefined): SpaceListItem {
  return spaceListItemSchema.parse(payload);
}

export function parseSpaceGroupList(
  payload: JsonValue | undefined,
): SpaceGroupDocType[] {
  return z.array(spaceGroupSchema).parse(payload);
}

export function parseSpaceGroup(
  payload: JsonValue | undefined,
): SpaceGroupDocType {
  return spaceGroupSchema.parse(payload);
}

export function parseFolderList(
  payload: JsonValue | undefined,
): FolderDocType[] {
  return z.array(folderSchema).parse(payload);
}

export function parseTagSummaries(
  payload: JsonValue | undefined,
): Array<{ id: string; name: string }> {
  return z.array(tagSummarySchema).parse(payload);
}

/** Accept the old array shape while extension pages roll over independently. */
export function parseBinPage(
  payload: JsonValue | undefined,
  pageSize: number,
): BinContentsPage {
  const legacyEntries = z.array(binEntrySchema).safeParse(payload);
  if (legacyEntries.success) {
    return {
      entries: legacyEntries.data.slice(0, pageSize),
      total: legacyEntries.data.length,
      hasMore: false,
      nextCursor: null,
    };
  }
  return binPageSchema.parse(payload);
}
