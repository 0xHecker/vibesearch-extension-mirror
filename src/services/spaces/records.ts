import {
  DEFAULT_PRIVATE_AUTO_LOCK_MS,
  LIVE_SPACE_SELECTOR,
  PRIVATE_SPACE_ID,
  PUBLIC_SPACE_ID,
  SPACE_NOT_BINNED,
  normalizeSpaceName,
} from "@src/common/spaces";
import type { SpaceDocType } from "@src/schemas/space_schema";
import { UNGROUPED_SPACE_GROUP_ID } from "@src/schemas/space_schema";
import { notifyDatabaseChanged } from "@src/services/database/notifications";
import { ensureDefaultSpaces } from "@src/services/spaces/defaults-and-repair";
import {
  buildSpaceId,
  safeSpaceSlug,
  sortSpaceList,
  toSpaceListItem,
} from "@src/services/spaces/presentation";
import {
  getSpaceClock,
  getSpaceDatabase,
} from "@src/services/spaces/runtime";
import type {
  SpaceListItem,
  SpacesControllerOptions,
} from "@src/services/spaces/types";
import { appendUnorderedIds } from "@src/utils/ordered-ids";

function normalizedGroupId(groupId: string | null | undefined): string {
  return groupId?.trim() || UNGROUPED_SPACE_GROUP_ID;
}

async function requireExistingGroup(
  options: SpacesControllerOptions,
  groupId: string,
): Promise<void> {
  if (!groupId) return;
  const db = await getSpaceDatabase(options);
  const group = await db.space_groups.findOne(groupId).exec();
  if (!group) throw new Error("SPACE_GROUP_NOT_FOUND");
}

export async function listSpaces(options: SpacesControllerOptions): Promise<SpaceListItem[]> {
  const db = await getSpaceDatabase(options);
  await ensureDefaultSpaces(options, db);
  const documents = await db.spaces.find({ selector: { ...LIVE_SPACE_SELECTOR } }).exec();
  return sortSpaceList(documents.map((document) => toSpaceListItem(document.toMutableJSON())));
}

export async function createSpace(
  options: SpacesControllerOptions,
  payload: { name: string; spaceGroupId?: string | null },
): Promise<SpaceListItem> {
  const db = await getSpaceDatabase(options);
  await ensureDefaultSpaces(options, db);
  const name = normalizeSpaceName(payload.name || "");
  if (!name) throw new Error("SPACE_NAME_REQUIRED");

  const spaceGroupId = normalizedGroupId(payload.spaceGroupId);
  await requireExistingGroup(options, spaceGroupId);
  const existingDocuments = await db.spaces.find({
    selector: { isArchived: { $eq: false } },
  }).exec();
  const existingSpaces = existingDocuments.map((document) => document.toMutableJSON());
  if (existingSpaces.some((space) => space.name.toLowerCase() === name.toLowerCase())) {
    throw new Error("SPACE_NAME_EXISTS");
  }

  const now = getSpaceClock(options);
  const maxSortOrder = existingSpaces.reduce(
    (maximum, space) => Math.max(maximum, space.sortOrder),
    0,
  );
  const space: SpaceDocType = {
    id: buildSpaceId(),
    name,
    slug: safeSpaceSlug(name, `space-${now}`),
    spaceGroupId,
    isPrivate: false,
    autoLockMs: DEFAULT_PRIVATE_AUTO_LOCK_MS,
    sortOrder: maxSortOrder + 1,
    isArchived: false,
    deletedAt: SPACE_NOT_BINNED,
    purgeAt: 0,
    createdAt: now,
    updatedAt: now,
  };
  await db.spaces.insert(space);
  notifyDatabaseChanged("spaces");
  return toSpaceListItem(space);
}

export async function renameSpace(
  options: SpacesControllerOptions,
  payload: { id: string; name: string },
): Promise<{ success: boolean }> {
  const db = await getSpaceDatabase(options);
  const document = await db.spaces.findOne(payload.id).exec();
  if (!document) return { success: false };
  const current = document.toMutableJSON();
  if (current.id === PUBLIC_SPACE_ID || current.id === PRIVATE_SPACE_ID) {
    throw new Error("SPACE_RENAME_NOT_ALLOWED");
  }
  const name = normalizeSpaceName(payload.name || "");
  if (!name) throw new Error("SPACE_NAME_REQUIRED");

  const liveDocuments = await db.spaces.find({
    selector: { isArchived: { $eq: false } },
  }).exec();
  const duplicate = liveDocuments.some((candidate) => {
    const space = candidate.toMutableJSON();
    return space.id !== current.id && space.name.toLowerCase() === name.toLowerCase();
  });
  if (duplicate) throw new Error("SPACE_NAME_EXISTS");

  await document.patch({
    name,
    slug: safeSpaceSlug(name, current.slug),
    updatedAt: getSpaceClock(options),
  });
  notifyDatabaseChanged("spaces");
  return { success: true };
}

export async function moveSpaceToGroup(
  options: SpacesControllerOptions,
  payload: { spaceId: string; spaceGroupId: string | null },
): Promise<{ success: boolean }> {
  const db = await getSpaceDatabase(options);
  const document = await db.spaces.findOne(payload.spaceId).exec();
  if (!document) return { success: false };
  const current = document.toMutableJSON();
  if (current.id === PUBLIC_SPACE_ID || current.id === PRIVATE_SPACE_ID) {
    throw new Error("DEFAULT_SPACE_GROUP_MOVE_NOT_ALLOWED");
  }

  const spaceGroupId = normalizedGroupId(payload.spaceGroupId);
  await requireExistingGroup(options, spaceGroupId);
  await document.patch({ spaceGroupId, updatedAt: getSpaceClock(options) });
  notifyDatabaseChanged("spaces");
  return { success: true };
}

export async function reorderSpaces(
  options: SpacesControllerOptions,
  payload: { orderedIds: string[]; spaceGroupId?: string | null },
): Promise<{ success: boolean }> {
  const db = await getSpaceDatabase(options);
  const spaceGroupId = normalizedGroupId(payload.spaceGroupId);
  const documents = await db.spaces.find({
    selector: { ...LIVE_SPACE_SELECTOR, spaceGroupId: { $eq: spaceGroupId } },
  }).exec();
  const allIds = documents.map((document) => document.primary);
  const requestedIds = payload.orderedIds.filter((id) => id && allIds.includes(id));
  const finalOrder = appendUnorderedIds(requestedIds, allIds);
  const now = getSpaceClock(options);
  await Promise.all(finalOrder.map(async (id, index) => {
    const document = await db.spaces.findOne(id).exec();
    if (!document || document.get("sortOrder") === index) return;
    await document.patch({ sortOrder: index, updatedAt: now });
  }));
  notifyDatabaseChanged("spaces");
  return { success: true };
}
