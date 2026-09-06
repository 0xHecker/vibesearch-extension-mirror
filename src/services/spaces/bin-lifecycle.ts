import { nextBinMutationTimestamp } from "@src/common/bin";
import {
  LIVE_SPACE_SELECTOR,
  PRIVATE_SPACE_ID,
  PUBLIC_SPACE_ID,
  SPACE_NOT_BINNED,
  computeBinPurgeAt,
  hasValidSpacePurgeDeadline,
  isSpacePurgeable,
  normalizeSpaceName,
} from "@src/common/spaces";
import type { SpaceDocType } from "@src/schemas/space_schema";
import { UNGROUPED_SPACE_GROUP_ID } from "@src/schemas/space_schema";
import { notifyArchivedItemsPurged } from "@src/services/archive-lifecycle";
import { notifyDatabaseChanged } from "@src/services/database/notifications";
import {
  withBinMutationLock,
  withSpaceMutationLock,
} from "@src/services/entity-mutation-lock";
import {
  deleteUnreferencedOpfsItemDirectories,
  requestOpfsMediaReconciliation,
} from "@src/services/opfs-media-lifecycle";
import { spaceSessionService } from "@src/services/space-session.service";
import {
  safeSpaceSlug,
  toSpaceListItem,
} from "@src/services/spaces/presentation";
import {
  getSpaceClock,
  getSpaceDatabase,
} from "@src/services/spaces/runtime";
import type {
  SpaceDatabase,
  SpaceListItem,
  SpacesControllerOptions,
} from "@src/services/spaces/types";

const SPACE_PURGE_BATCH_SIZE = 200;

function notifySpaceTreeChanged(): void {
  notifyDatabaseChanged("spaces");
  notifyDatabaseChanged("folders");
  notifyDatabaseChanged("items");
}

async function removePurgedItemMedia(
  options: SpacesControllerOptions,
  db: SpaceDatabase,
  itemIds: string[],
): Promise<void> {
  try {
    if (options.deleteAllMediaForItem) {
      for (const itemId of itemIds) await options.deleteAllMediaForItem(itemId);
      return;
    }
    await deleteUnreferencedOpfsItemDirectories(db, itemIds);
  } catch (cause) {
    console.warn("[spaces] media cleanup deferred after permanent delete", cause);
    requestOpfsMediaReconciliation();
  }
}

async function removeSpaceItems(
  options: SpacesControllerOptions,
  db: SpaceDatabase,
  spaceId: string,
): Promise<number> {
  let removedItems = 0;
  while (true) {
    const itemDocuments = await db.items.find({
      selector: { spaceId: { $eq: spaceId } },
      limit: SPACE_PURGE_BATCH_SIZE,
    }).exec();
    if (itemDocuments.length === 0) return removedItems;

    const itemIds = itemDocuments.map((document) => document.primary);
    const result = await db.items.bulkRemove(itemIds);
    if (result.error.length > 0) {
      throw new AggregateError(
        result.error,
        `SPACE_ITEM_PURGE_WRITE_FAILED:${result.error.length}`,
      );
    }
    if (result.success.length !== itemIds.length) {
      throw new Error(`SPACE_ITEM_PURGE_NO_PROGRESS:${result.success.length}/${itemIds.length}`);
    }

    if (db.deleted_items?.find && db.deleted_items?.bulkRemove) {
      const tombstones = await db.deleted_items.find({
        selector: { id: { $in: itemIds } },
      }).exec();
      if (tombstones.length > 0) {
        await db.deleted_items.bulkRemove(tombstones.map((document) => document.primary));
      }
    }

    removedItems += itemDocuments.length;
    await removePurgedItemMedia(options, db, itemIds);
    await (options.notifyArchivedItemsPurged ?? notifyArchivedItemsPurged)(itemIds);
  }
}

async function removeSpaceFolders(db: SpaceDatabase, spaceId: string): Promise<void> {
  const documents = await db.folders.find({ selector: { spaceId: { $eq: spaceId } } }).exec();
  for (let start = 0; start < documents.length; start += SPACE_PURGE_BATCH_SIZE) {
    const batch = documents.slice(start, start + SPACE_PURGE_BATCH_SIZE);
    await db.folders.bulkRemove(batch.map((document) => document.primary));
  }
}

async function hardDeleteSpaceContents(
  options: SpacesControllerOptions,
  db: SpaceDatabase,
  spaceId: string,
): Promise<number> {
  const removedItems = await removeSpaceItems(options, db, spaceId);
  await removeSpaceFolders(db, spaceId);
  return removedItems;
}

export async function moveSpaceToBin(
  options: SpacesControllerOptions,
  payload: { id: string },
): Promise<{ success: boolean; purgeAt: number }> {
  const db = await getSpaceDatabase(options);
  const id = payload.id.trim();
  if (!id || id === PUBLIC_SPACE_ID || id === PRIVATE_SPACE_ID) {
    throw new Error("DEFAULT_SPACE_BIN_NOT_ALLOWED");
  }
  return withBinMutationLock(db, () => withSpaceMutationLock(db, id, async () => {
    const document = await db.spaces.findOne(id).exec();
    if (!document) throw new Error("SPACE_NOT_FOUND");
    const space = document.toMutableJSON();
    if (space.deletedAt > SPACE_NOT_BINNED) {
      return { success: true, purgeAt: space.purgeAt || 0 };
    }

    const now = nextBinMutationTimestamp(
      getSpaceClock(options),
      space.updatedAt,
      space.deletedAt,
    );
    const purgeAt = computeBinPurgeAt(now);
    await document.patch({ deletedAt: now, purgeAt, updatedAt: now });
    if (space.isPrivate) spaceSessionService.lockSpace(space.id);
    notifyDatabaseChanged("spaces");
    return { success: true, purgeAt };
  }));
}

export async function restoreSpaceFromBin(
  options: SpacesControllerOptions,
  payload: { id: string },
): Promise<{ success: boolean; relocated?: boolean; message?: string }> {
  const db = await getSpaceDatabase(options);
  const id = payload.id.trim();
  if (!id) return { success: false };
  return withBinMutationLock(db, () => withSpaceMutationLock(db, id, async () => {
    const document = await db.spaces.findOne(id).exec();
    if (!document) throw new Error("SPACE_NOT_FOUND");
    const space = document.toMutableJSON();
    if (space.deletedAt === SPACE_NOT_BINNED) return { success: true };

    const now = nextBinMutationTimestamp(
      getSpaceClock(options),
      space.updatedAt,
      space.deletedAt,
    );
    if (isSpacePurgeable(space, now)) throw new Error("SPACE_PURGE_IN_PROGRESS");

    const baseName = normalizeSpaceName(space.name).trim() || "Restored space";
    const liveDocuments = await db.spaces.find({ selector: { ...LIVE_SPACE_SELECTOR } }).exec();
    const existingNames = new Set(
      liveDocuments
        .map((candidate) => candidate.get("name").toLowerCase())
        .filter((name) => name !== baseName.toLowerCase()),
    );
    let name = baseName;
    for (let suffix = 2; existingNames.has(name.toLowerCase()); suffix += 1) {
      name = `${baseName} (restored ${suffix})`;
    }

    const patch: Partial<SpaceDocType> = {
      deletedAt: SPACE_NOT_BINNED,
      purgeAt: 0,
      updatedAt: now,
    };
    if (name !== baseName) {
      patch.name = name;
      patch.slug = safeSpaceSlug(name, space.slug);
    }
    let relocated = false;
    const originalGroupId = space.spaceGroupId.trim();
    if (originalGroupId && db.space_groups?.findOne) {
      const group = await db.space_groups.findOne(originalGroupId).exec();
      if (!group) {
        patch.spaceGroupId = UNGROUPED_SPACE_GROUP_ID;
        relocated = true;
      }
    }
    await document.patch(patch);
    notifyDatabaseChanged("spaces");
    return relocated
      ? {
          success: true,
          relocated: true,
          message: "Heads up: the original space group is no longer available, so this space was restored to Ungrouped.",
        }
      : { success: true, relocated: false };
  }));
}

export async function listBinnedSpaces(
  options: SpacesControllerOptions,
): Promise<SpaceListItem[]> {
  const db = await getSpaceDatabase(options);
  const documents = await db.spaces.find({
    selector: { deletedAt: { $gt: SPACE_NOT_BINNED } },
  }).exec();
  return documents
    .map((document) => toSpaceListItem(document.toMutableJSON()))
    .sort((left, right) => left.purgeAt - right.purgeAt);
}

export async function purgeExpiredSpaces(
  options: SpacesControllerOptions,
): Promise<{ purgedSpaceIds: string[] }> {
  const db = await getSpaceDatabase(options);
  return withBinMutationLock(db, async () => {
    const now = getSpaceClock(options);
    const candidates = await db.spaces.find({
      selector: { deletedAt: { $gt: SPACE_NOT_BINNED } },
    }).exec();
    const purgedSpaceIds: string[] = [];
    for (const candidate of candidates) {
      const spaceId = candidate.primary;
      const purged = await withSpaceMutationLock(db, spaceId, async () => {
        const document = await db.spaces.findOne(spaceId).exec();
        if (!document) return false;
        const space = document.toMutableJSON();
        if (space.deletedAt === SPACE_NOT_BINNED) return false;
        if (!hasValidSpacePurgeDeadline(space)) {
          await document.patch({ purgeAt: computeBinPurgeAt(now), updatedAt: now });
          return false;
        }
        if (!isSpacePurgeable(space, now)) return false;

        await hardDeleteSpaceContents(options, db, spaceId);
        await document.remove();
        return true;
      });
      if (purged) purgedSpaceIds.push(spaceId);
    }
    notifySpaceTreeChanged();
    return { purgedSpaceIds };
  });
}

export async function deleteSpaceForever(
  options: SpacesControllerOptions,
  payload: { id: string; expectedDeletedAt: number },
): Promise<{ success: boolean; removedItems: number }> {
  const db = await getSpaceDatabase(options);
  const id = payload.id.trim();
  if (!id || id === PUBLIC_SPACE_ID || id === PRIVATE_SPACE_ID) {
    throw new Error("DEFAULT_SPACE_DELETE_NOT_ALLOWED");
  }
  return withBinMutationLock(db, () => withSpaceMutationLock(db, id, async () => {
    const document = await db.spaces.findOne(id).exec();
    if (!document) return { success: false, removedItems: 0 };
    const space = document.toMutableJSON();
    if (space.deletedAt <= SPACE_NOT_BINNED) throw new Error("SPACE_NOT_IN_BIN");
    if (space.deletedAt !== payload.expectedDeletedAt) {
      throw new Error("SPACE_BIN_ENTRY_CHANGED");
    }

    const removedItems = await hardDeleteSpaceContents(options, db, id);
    await document.remove();
    notifySpaceTreeChanged();
    return { success: true, removedItems };
  }));
}
