import { nextBinMutationTimestamp } from "@src/common/bin";
import { PRIVATE_SPACE_ID, PUBLIC_SPACE_ID } from "@src/common/spaces";
import type { ItemDocType } from "@src/schemas/item_schema";
import { notifyArchivedItemsPurged } from "@src/services/archive-lifecycle";
import {
  createRestoreTabGroup,
  resolveRestoreSpace,
  restoreFallbackMessage,
} from "@src/services/bin-restore-location";
import {
  assertSpaceUnlocked,
  notifyDatabaseChanged,
} from "@src/services/items/runtime";
import type { MyDatabase } from "@src/services/DatabaseService";
import {
  withBinMutationLock,
  withEntityMutationLock,
} from "@src/services/entity-mutation-lock";
import {
  deleteUnreferencedOpfsItemDirectories,
  requestOpfsMediaReconciliation,
} from "@src/services/opfs-media-lifecycle";
import { spaceSessionService } from "@src/services/space-session.service";

export type DeleteItemPayload = {
  id: string;
  scope?: "current" | "all";
};

export type ItemBinMutationResult = {
  success: boolean;
  error?: string;
};

export type RestoreItemFromBinPayload = {
  id: string;
};

export type RestoreItemFromBinResult = ItemBinMutationResult & {
  relocated?: boolean;
  message?: string;
};

export type DeleteItemForeverPayload = {
  id: string;
  expectedDeletedAt: number;
};

export type ItemBinLifecycleOptions = {
  deleteUnreferencedOpfsItemDirectories?: typeof deleteUnreferencedOpfsItemDirectories;
  notifyArchivedItemsPurged?: typeof notifyArchivedItemsPurged;
};

/** Move one item to Bin and enqueue vector cleanup under the item's mutation lock. */
export async function moveItemToBin(
  db: MyDatabase,
  itemId: string,
  clock = Date.now,
): Promise<void> {
  await withEntityMutationLock(db, "item", itemId, async () => {
    const item = await db.items.findOne(itemId).exec();
    if (!item) return;

    const current = item.toMutableJSON();
    const deletedAt = nextBinMutationTimestamp(
      clock(),
      current.updatedAt,
      current.deletedAt,
    );
    await item.patch({ deletedAt, updatedAt: deletedAt });

    const vectorIndex = current.vector_index;
    if (vectorIndex !== undefined && vectorIndex > -1) {
      await db.deleted_items.upsert({
        id: item.primary,
        vector_index: vectorIndex,
        deletedAt,
      });
    }
  });
}

async function removeDeletedItemTombstone(
  db: MyDatabase,
  itemId: string,
): Promise<void> {
  if (!db.deleted_items?.findOne) return;
  const tombstone = await db.deleted_items.findOne(itemId).exec();
  if (tombstone) await tombstone.remove();
}

export async function deleteItem(
  db: MyDatabase,
  payload: DeleteItemPayload,
): Promise<ItemBinMutationResult> {
  const document = await db.items.findOne(payload.id).exec();
  if (!document) return { success: false, error: "NOT_FOUND" };
  const item = document.toMutableJSON();
  assertSpaceUnlocked(item.spaceId || PUBLIC_SPACE_ID);
  const itemIds = new Set<string>([payload.id]);

  if (payload.scope === "all") {
    const siblings = await db.items.find({
      selector: { url: { $eq: item.url }, deletedAt: { $eq: 0 } },
    }).exec();
    for (const sibling of siblings) {
      const spaceId = sibling.get("spaceId") || PUBLIC_SPACE_ID;
      const lockedPrivateItem =
        spaceId === PRIVATE_SPACE_ID && !spaceSessionService.isUnlocked(PRIVATE_SPACE_ID);
      if (!lockedPrivateItem) itemIds.add(sibling.primary);
    }
  }

  for (const itemId of itemIds) await moveItemToBin(db, itemId);
  notifyDatabaseChanged("items");
  return { success: true };
}

async function originalFolderNeedsFallback(
  db: MyDatabase,
  item: ItemDocType,
): Promise<boolean> {
  if (!item.folderId) return true;
  if (!db.folders?.findOne) return false;
  const folder = await db.folders.findOne(item.folderId).exec();
  return !folder || (folder.get("deletedAt") || 0) > 0;
}

export async function restoreItemFromBin(
  db: MyDatabase,
  payload: RestoreItemFromBinPayload,
): Promise<RestoreItemFromBinResult> {
  const itemId = payload.id.trim();
  if (!itemId) return { success: false, error: "NOT_FOUND" };

  return withBinMutationLock(db, () =>
    withEntityMutationLock(db, "item", itemId, async () => {
      const document = await db.items.findOne(itemId).exec();
      if (!document) return { success: false, error: "NOT_FOUND" };
      const item = document.toMutableJSON();
      assertSpaceUnlocked(item.spaceId || PUBLIC_SPACE_ID);
      if (item.deletedAt === 0) return { success: true };

      const restoreSpace = await resolveRestoreSpace(db, item.spaceId || PUBLIC_SPACE_ID);
      let targetFolderId = item.folderId;
      let relocated = restoreSpace.relocated || await originalFolderNeedsFallback(db, item);
      if (relocated) {
        const fallbackFolder = await createRestoreTabGroup(db, {
          spaceId: restoreSpace.space.id,
          userId: item.userId,
        });
        targetFolderId = fallbackFolder.id;
      }

      const updatedAt = nextBinMutationTimestamp(
        Date.now(),
        item.updatedAt,
        item.deletedAt,
      );
      await document.patch({
        folderId: targetFolderId,
        spaceId: restoreSpace.space.id,
        deletedAt: 0,
        updatedAt,
        isDirty: true,
      });
      await removeDeletedItemTombstone(db, itemId);

      if (restoreSpace.created) notifyDatabaseChanged("spaces");
      if (relocated) notifyDatabaseChanged("folders");
      notifyDatabaseChanged("items");
      return {
        success: true,
        relocated,
        message: relocated ? restoreFallbackMessage(restoreSpace.space.name) : undefined,
      };
    }),
  );
}

export async function deleteItemForever(
  db: MyDatabase,
  payload: DeleteItemForeverPayload,
  options: ItemBinLifecycleOptions = {},
): Promise<ItemBinMutationResult> {
  const itemId = payload.id.trim();
  if (!itemId) return { success: false, error: "NOT_FOUND" };

  return withBinMutationLock(db, () =>
    withEntityMutationLock(db, "item", itemId, async () => {
      const document = await db.items.findOne(itemId).exec();
      if (!document) return { success: false, error: "NOT_FOUND" };
      const item = document.toMutableJSON();
      assertSpaceUnlocked(item.spaceId || PUBLIC_SPACE_ID);
      if (item.deletedAt <= 0) throw new Error("ITEM_NOT_IN_BIN");
      if (item.deletedAt !== payload.expectedDeletedAt) {
        throw new Error("ITEM_BIN_ENTRY_CHANGED");
      }

      await document.remove();
      await removeDeletedItemTombstone(db, itemId);
      const deleteDirectories =
        options.deleteUnreferencedOpfsItemDirectories ??
        deleteUnreferencedOpfsItemDirectories;
      try {
        await deleteDirectories(db, [itemId]);
      } catch (error) {
        console.warn("[items] media cleanup deferred after permanent delete", error);
        requestOpfsMediaReconciliation();
      }
      const notifyPurged = options.notifyArchivedItemsPurged ?? notifyArchivedItemsPurged;
      await notifyPurged([itemId]);
      notifyDatabaseChanged("items");
      return { success: true };
    }),
  );
}
