import { PRIVATE_SPACE_ID, PUBLIC_SPACE_ID } from "@src/common/spaces";
import type { FolderDocType } from "@src/schemas/folder_schema";
import type { ItemDocType } from "@src/schemas/item_schema";
import { getDb, type MyDatabase } from "@src/services/DatabaseService";
import {
  readImportTargets,
  type ImportTargetOptions,
  type ImportTargetSpace,
} from "@src/services/imports/targets";
import { spaceSessionService } from "@src/services/space-session.service";

export type SearchScope = "current" | "global" | "private" | "public";

export type DatabaseAccessContext = {
  activeSpaceId?: string;
  searchScope?: SearchScope;
};

async function resolveAllowedSpaceIds(
  db: MyDatabase,
  accessContext?: DatabaseAccessContext,
): Promise<string[]> {
  const activeSpaceId = accessContext?.activeSpaceId || PUBLIC_SPACE_ID;
  const requestedScope = accessContext?.searchScope || "current";
  const privateUnlocked = spaceSessionService.isUnlocked(PRIVATE_SPACE_ID);
  const spaceDocs = await db.spaces.find({
    selector: { isArchived: { $eq: false }, deletedAt: { $eq: 0 } },
  }).exec();
  const spaces = spaceDocs.map((document) => document.toMutableJSON());
  const allSpaceIds = spaces.map((space) => space.id);
  const publicSpaceIds = spaces
    .filter((space) => !space.isPrivate)
    .map((space) => space.id);
  const safeActiveSpaceId = spaces.some((space) => space.id === activeSpaceId)
    ? activeSpaceId
    : PUBLIC_SPACE_ID;
  const visiblePublicSpaces = publicSpaceIds.length > 0
    ? publicSpaceIds
    : [PUBLIC_SPACE_ID];
  const visibleAllSpaces = allSpaceIds.length > 0 ? allSpaceIds : visiblePublicSpaces;

  if (requestedScope === "global") {
    return privateUnlocked ? visibleAllSpaces : visiblePublicSpaces;
  }
  if (requestedScope === "public") return visiblePublicSpaces;
  if (requestedScope === "private") {
    return privateUnlocked ? [PRIVATE_SPACE_ID] : [];
  }
  if (safeActiveSpaceId === PRIVATE_SPACE_ID) {
    return privateUnlocked ? [PRIVATE_SPACE_ID] : [];
  }
  return [safeActiveSpaceId];
}

export async function getAllItems(payload?: {
  accessContext?: DatabaseAccessContext;
}): Promise<ItemDocType[]> {
  const db = await getDb();
  const allowedSpaceIds = await resolveAllowedSpaceIds(db, payload?.accessContext);
  if (allowedSpaceIds.length === 0) return [];
  const documents = await db.items.find({
    selector: { deletedAt: { $eq: 0 }, spaceId: { $in: allowedSpaceIds } },
  }).exec();
  return documents.map((document) => document.toMutableJSON());
}

export async function getAllFolders(payload?: {
  accessContext?: DatabaseAccessContext;
  spaceIds?: string[];
}): Promise<FolderDocType[]> {
  const db = await getDb();
  const visibleSpaceIds = await resolveAllowedSpaceIds(db, payload?.accessContext);
  const requestedSpaceIds = Array.from(new Set((payload?.spaceIds || []).filter(Boolean)));
  const allowedSpaceIds = requestedSpaceIds.length > 0
    ? visibleSpaceIds.filter((spaceId) => requestedSpaceIds.includes(spaceId))
    : visibleSpaceIds;
  if (allowedSpaceIds.length === 0) return [];
  const documents = await db.folders.find({
    selector: { spaceId: { $in: allowedSpaceIds }, deletedAt: { $eq: 0 } },
  }).exec();
  return documents.map((document) => document.toMutableJSON());
}

export async function getImportTargets(
  payload?: ImportTargetOptions,
): Promise<ImportTargetSpace[]> {
  return readImportTargets(await getDb(), payload);
}

export async function filterExistingItemIds(payload: {
  itemIds?: string[];
}): Promise<string[]> {
  const itemIds = Array.from(new Set((payload.itemIds || []).filter(Boolean))).slice(0, 2_000);
  if (itemIds.length === 0) return [];
  const documents = await (await getDb()).items.findByIds(itemIds).exec();
  return itemIds.filter((itemId) => documents.has(itemId));
}
