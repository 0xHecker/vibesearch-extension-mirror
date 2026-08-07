import {
  DEFAULT_PRIVATE_AUTO_LOCK_MS,
  LIVE_SPACE_SELECTOR,
  PUBLIC_SPACE_ID,
  SPACE_NOT_BINNED,
  normalizeSpaceName,
  slugifySpaceName,
} from "@src/common/spaces";
import type { FolderDocType } from "@src/schemas/folder_schema";
import type { SpaceDocType } from "@src/schemas/space_schema";
import { UNGROUPED_SPACE_GROUP_ID } from "@src/schemas/space_schema";
import { v4 as uuidv4 } from "uuid";

export type RestoreSpaceResolution = {
  space: SpaceDocType;
  created: boolean;
  relocated: boolean;
  reason?: "space_missing" | "space_in_bin" | "space_archived" | "space_unavailable";
};

const isLiveSpace = (space: SpaceDocType | null): space is SpaceDocType =>
  !!space && !space.isArchived && (space.deletedAt || SPACE_NOT_BINNED) === SPACE_NOT_BINNED;

const sortSpaces = (spaces: SpaceDocType[]) =>
  [...spaces].sort((left, right) => {
    if (left.id === PUBLIC_SPACE_ID) return -1;
    if (right.id === PUBLIC_SPACE_ID) return 1;
    if (!!left.isPrivate !== !!right.isPrivate) return left.isPrivate ? 1 : -1;
    return left.sortOrder - right.sortOrder || left.createdAt - right.createdAt;
  });

const toSpace = (doc: any | null): SpaceDocType | null =>
  doc ? (doc.toMutableJSON() as SpaceDocType) : null;

const createRestoredSpace = async (db: any): Promise<SpaceDocType> => {
  const now = Date.now();
  const name = "Restored";
  const space: SpaceDocType = {
    id: uuidv4(),
    name,
    slug: slugifySpaceName(name) || `restored-${now}`,
    spaceGroupId: UNGROUPED_SPACE_GROUP_ID,
    isPrivate: false,
    autoLockMs: DEFAULT_PRIVATE_AUTO_LOCK_MS,
    sortOrder: now,
    isArchived: false,
    deletedAt: SPACE_NOT_BINNED,
    purgeAt: 0,
    createdAt: now,
    updatedAt: now,
  };
  await db.spaces.insert(space);
  return space;
};

export const resolveRestoreSpace = async (
  db: any,
  originalSpaceId: string | null | undefined
): Promise<RestoreSpaceResolution> => {
  const requestedId = (originalSpaceId || PUBLIC_SPACE_ID).trim() || PUBLIC_SPACE_ID;
  const originalDoc = await db.spaces.findOne(requestedId).exec();
  const originalSpace = toSpace(originalDoc);
  if (isLiveSpace(originalSpace)) {
    return { space: originalSpace, created: false, relocated: false };
  }

  const liveDocs = await db.spaces.find({ selector: { ...LIVE_SPACE_SELECTOR } }).exec();
  const liveSpaces: SpaceDocType[] = liveDocs.map((doc: any) => doc.toMutableJSON() as SpaceDocType);
  const fallback = sortSpaces(liveSpaces.filter((space: SpaceDocType) => !space.isPrivate))[0];
  if (fallback) {
    const unavailableSpace = originalSpace as SpaceDocType | null;
    const reason = !unavailableSpace
      ? "space_missing"
      : (unavailableSpace.deletedAt || 0) > 0
        ? "space_in_bin"
        : unavailableSpace.isArchived
          ? "space_archived"
          : "space_unavailable";
    return { space: fallback, created: false, relocated: true, reason };
  }

  const created = await createRestoredSpace(db);
  return {
    space: created,
    created: true,
    relocated: true,
    reason: originalSpace ? "space_unavailable" : "space_missing",
  };
};

export const createRestoreTabGroup = async (
  db: any,
  payload: { spaceId: string; userId?: string | null; name?: string }
): Promise<FolderDocType> => {
  const now = Date.now();
  const name = normalizeSpaceName(payload.name || "Restored tabs") || "Restored tabs";
  const siblingDocs = await db.folders
    .find({ selector: { spaceId: { $eq: payload.spaceId }, parentId: { $eq: null } } })
    .exec();
  const maxOrder = siblingDocs.reduce((max: number, doc: any) => {
    const sortOrder = (doc.get("sortOrder") as number | undefined) ?? 0;
    return Math.max(max, sortOrder);
  }, -1);
  const folder: FolderDocType = {
    id: uuidv4(),
    name,
    userId: typeof payload.userId === "string" ? payload.userId : "",
    spaceId: payload.spaceId,
    parentId: null,
    type: "tab_group",
    sortOrder: maxOrder + 1,
    isLocked: false,
    isPinned: false,
    isCollapsed: false,
    deletedAt: 0,
    purgeAt: 0,
    isDirty: true,
    serverVersion: 0,
    createdAt: now,
    updatedAt: now,
  };
  await db.folders.insert(folder);
  return folder;
};

export const restoreFallbackMessage = (targetName: string): string =>
  `Heads up: the original location is no longer available, so this was restored to "${targetName}".`;
