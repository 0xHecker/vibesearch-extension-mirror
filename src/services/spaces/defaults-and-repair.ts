import {
  DEFAULT_PRIVATE_AUTO_LOCK_MS,
  PRIVATE_SPACE_ID,
  PRIVATE_SPACE_NAME,
  PUBLIC_SPACE_ID,
  PUBLIC_SPACE_NAME,
  SPACE_NOT_BINNED,
} from "@src/common/spaces";
import type { SpaceDocType } from "@src/schemas/space_schema";
import { UNGROUPED_SPACE_GROUP_ID } from "@src/schemas/space_schema";
import { notifyDatabaseChanged } from "@src/services/database/notifications";
import { forEachIdKeysetPage } from "@src/services/rxdb-keyset-pagination";
import {
  getSpaceClock,
  getSpaceDatabase,
  readStoredNumber,
  writeStoredValue,
} from "@src/services/spaces/runtime";
import type {
  SpaceDatabase,
  SpacesControllerOptions,
} from "@src/services/spaces/types";

const SPACE_ASSIGNMENT_REPAIR_VERSION = 1;
const SPACE_REPAIR_VERSION_STORAGE_KEY = "vibe.search.spaceRepair.version";
export const SPACE_ASSIGNMENT_REPAIR_PAGE_SIZE = 200;

function defaultSpaces(now: number): SpaceDocType[] {
  return [
    {
      id: PUBLIC_SPACE_ID,
      name: PUBLIC_SPACE_NAME,
      slug: "public",
      spaceGroupId: UNGROUPED_SPACE_GROUP_ID,
      isPrivate: false,
      autoLockMs: DEFAULT_PRIVATE_AUTO_LOCK_MS,
      sortOrder: 0,
      isArchived: false,
      deletedAt: SPACE_NOT_BINNED,
      purgeAt: 0,
      createdAt: now,
      updatedAt: now,
    },
    {
      id: PRIVATE_SPACE_ID,
      name: PRIVATE_SPACE_NAME,
      slug: "private",
      spaceGroupId: UNGROUPED_SPACE_GROUP_ID,
      isPrivate: true,
      autoLockMs: DEFAULT_PRIVATE_AUTO_LOCK_MS,
      sortOrder: 1,
      isArchived: false,
      deletedAt: SPACE_NOT_BINNED,
      purgeAt: 0,
      createdAt: now,
      updatedAt: now,
    },
  ];
}

export async function ensureDefaultSpaces(
  options: SpacesControllerOptions,
  database?: SpaceDatabase,
): Promise<void> {
  const db = database ?? await getSpaceDatabase(options);
  const defaults = defaultSpaces(getSpaceClock(options));
  const existing = await db.spaces.findByIds(defaults.map((space) => space.id)).exec();
  const missing = defaults.filter((space) => !existing.has(space.id));
  if (missing.length > 0) await db.spaces.bulkUpsert(missing);
}

export async function repairFolderAndItemSpaceAssignments(
  options: SpacesControllerOptions,
): Promise<{ folderUpdates: number; itemUpdates: number }> {
  const db = await getSpaceDatabase(options);
  await ensureDefaultSpaces(options, db);

  const validSpaceIds = new Set<string>();
  await forEachIdKeysetPage({
    collection: db.spaces,
    selector: { isArchived: { $eq: false } },
    pageSize: SPACE_ASSIGNMENT_REPAIR_PAGE_SIZE,
    onPage: (documents) => {
      for (const document of documents) validSpaceIds.add(document.primary);
    },
  });
  validSpaceIds.add(PUBLIC_SPACE_ID);

  const folderSpaceById = new Map<string, string>();
  let folderUpdates = 0;
  await forEachIdKeysetPage({
    collection: db.folders,
    selector: {},
    pageSize: SPACE_ASSIGNMENT_REPAIR_PAGE_SIZE,
    onPage: async (documents) => {
      const updatedAt = getSpaceClock(options);
      await Promise.all(documents.map(async (document) => {
        const currentSpaceId = document.get("spaceId");
        const spaceId = validSpaceIds.has(currentSpaceId) ? currentSpaceId : PUBLIC_SPACE_ID;
        folderSpaceById.set(document.primary, spaceId);
        if (currentSpaceId === spaceId) return;
        await document.incrementalPatch({
          userId: document.get("userId") ?? "",
          spaceId,
          updatedAt,
        });
        folderUpdates += 1;
      }));
    },
  });

  let itemUpdates = 0;
  await forEachIdKeysetPage({
    collection: db.items,
    selector: {},
    pageSize: SPACE_ASSIGNMENT_REPAIR_PAGE_SIZE,
    onPage: async (documents) => {
      const updatedAt = getSpaceClock(options);
      await Promise.all(documents.map(async (document) => {
        const currentSpaceId = document.get("spaceId");
        const spaceId = folderSpaceById.get(document.get("folderId"))
          ?? (validSpaceIds.has(currentSpaceId) ? currentSpaceId : PUBLIC_SPACE_ID);
        if (currentSpaceId === spaceId) return;
        await document.incrementalPatch({
          userId: document.get("userId") ?? "",
          spaceId,
          updatedAt,
        });
        itemUpdates += 1;
      }));
    },
  });

  if (folderUpdates > 0 || itemUpdates > 0) {
    notifyDatabaseChanged("folders");
    notifyDatabaseChanged("items");
  }
  return { folderUpdates, itemUpdates };
}

export async function maybeRepairFolderAndItemSpaceAssignments(
  options: SpacesControllerOptions,
): Promise<{ repaired: boolean; folderUpdates: number; itemUpdates: number }> {
  const version = await readStoredNumber(options, SPACE_REPAIR_VERSION_STORAGE_KEY);
  if (version === SPACE_ASSIGNMENT_REPAIR_VERSION) {
    return { repaired: false, folderUpdates: 0, itemUpdates: 0 };
  }

  const result = await repairFolderAndItemSpaceAssignments(options);
  await writeStoredValue(
    options,
    SPACE_REPAIR_VERSION_STORAGE_KEY,
    SPACE_ASSIGNMENT_REPAIR_VERSION,
  );
  return { repaired: true, ...result };
}
