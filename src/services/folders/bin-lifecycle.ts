import { nextBinMutationTimestamp } from "@src/common/bin";
import type { FolderDocType } from "@src/schemas/folder_schema";
import { notifyArchivedItemsPurged } from "@src/services/archive-lifecycle";
import { createRestoreTabGroup } from "@src/services/bin-restore-location";
import type { MyDatabase } from "@src/services/DatabaseService";
import { withEntityMutationLock } from "@src/services/entity-mutation-lock";
import {
  deleteUnreferencedOpfsItemDirectories,
  requestOpfsMediaReconciliation,
} from "@src/services/opfs-media-lifecycle";
import { requireLiveSpaceDestination } from "@src/services/live-destination";
import { forEachIdKeysetPage } from "@src/services/rxdb-keyset-pagination";

const FOLDER_ITEM_PAGE_SIZE = 200;

export type FolderBinLifecycleOptions = {
  deleteUnreferencedOpfsItemDirectories?: typeof deleteUnreferencedOpfsItemDirectories;
  notifyArchivedItemsPurged?: typeof notifyArchivedItemsPurged;
};

export function collectFolderTreeIds(
  folders: readonly FolderDocType[],
  rootId: string,
): Set<string> {
  const childrenByParent = new Map<string, string[]>();
  for (const folder of folders) {
    const parentId = folder.parentId || null;
    if (!parentId) continue;
    const children = childrenByParent.get(parentId);
    if (children) children.push(folder.id);
    else childrenByParent.set(parentId, [folder.id]);
  }

  const visited = new Set<string>();
  const pending = [rootId];
  while (pending.length > 0) {
    const id = pending.pop();
    if (!id || visited.has(id)) continue;
    visited.add(id);
    for (const childId of childrenByParent.get(id) || []) {
      if (!visited.has(childId)) pending.push(childId);
    }
  }
  return visited;
}

export async function removeDeletedItemTombstone(
  db: MyDatabase,
  itemId: string,
): Promise<void> {
  if (!db.deleted_items?.findOne) return;
  const tombstone = await db.deleted_items.findOne(itemId).exec();
  if (tombstone) await tombstone.remove();
}

/**
 * Move live rows out of a folder tree before that tree enters the bin. The
 * destination is a new live root tab group, so kept tabs remain discoverable.
 */
export async function relocateLiveItemsFromTree(
  db: MyDatabase,
  folderIds: ReadonlySet<string>,
  sourceFolder: FolderDocType,
  targetSpaceId: string,
): Promise<number> {
  let recoveryFolder: FolderDocType | null = null;
  let relocatedItems = 0;
  const clockNow = Date.now();

  await forEachIdKeysetPage({
    collection: db.items,
    selector: { folderId: { $in: Array.from(folderIds) } },
    pageSize: FOLDER_ITEM_PAGE_SIZE,
    onPage: async (candidates) => {
      for (const candidate of candidates) {
        const itemId = candidate.primary;
        await withEntityMutationLock(db, "item", itemId, async () => {
          const itemDoc = await db.items.findOne(itemId).exec();
          if (!itemDoc) return;
          const item = itemDoc.toMutableJSON();
          if (item.deletedAt > 0 || !folderIds.has(item.folderId)) return;

          if (!recoveryFolder) {
            await requireLiveSpaceDestination(db, targetSpaceId);
            recoveryFolder = await createRestoreTabGroup(db, {
              spaceId: targetSpaceId,
              userId: sourceFolder.userId,
              name: `Kept tabs from ${sourceFolder.name || "deleted folder"}`,
            });
          }
          const updatedAt = nextBinMutationTimestamp(
            clockNow,
            item.updatedAt,
            item.deletedAt,
          );
          await itemDoc.patch({
            folderId: recoveryFolder.id,
            spaceId: targetSpaceId,
            deletedAt: 0,
            updatedAt,
            isDirty: true,
          });
          await removeDeletedItemTombstone(db, itemId);
          relocatedItems += 1;
        });
      }
    },
  });
  return relocatedItems;
}

/**
 * Permanently remove binned rows in a folder tree while rescuing legacy live
 * descendants into a new live root group.
 */
export async function purgeFolderTreeItems(
  db: MyDatabase,
  folderIds: ReadonlySet<string>,
  sourceFolder: FolderDocType,
  targetSpaceId: string,
  options: FolderBinLifecycleOptions = {},
): Promise<number> {
  // Validate before deleting even the first row so a malformed legacy tree
  // never leaves a partially purged set when its live fallback is unsafe.
  await requireLiveSpaceDestination(db, targetSpaceId);
  let recoveryFolder: FolderDocType | null = null;
  let removedItems = 0;
  const clockNow = Date.now();

  await forEachIdKeysetPage({
    collection: db.items,
    selector: { folderId: { $in: Array.from(folderIds) } },
    pageSize: FOLDER_ITEM_PAGE_SIZE,
    onPage: async (candidates) => {
      const removedItemIds: string[] = [];
      for (const candidate of candidates) {
        const itemId = candidate.primary;
        await withEntityMutationLock(db, "item", itemId, async () => {
          const itemDoc = await db.items.findOne(itemId).exec();
          if (!itemDoc) return;
          const item = itemDoc.toMutableJSON();
          if (!folderIds.has(item.folderId)) return;

          if (item.deletedAt > 0) {
            await itemDoc.remove();
            await removeDeletedItemTombstone(db, itemId);
            removedItemIds.push(itemId);
            removedItems += 1;
            return;
          }

          if (!recoveryFolder) {
            recoveryFolder = await createRestoreTabGroup(db, {
              spaceId: targetSpaceId,
              userId: sourceFolder.userId,
              name: `Kept tabs from ${sourceFolder.name || "deleted folder"}`,
            });
          }
          const updatedAt = nextBinMutationTimestamp(
            clockNow,
            item.updatedAt,
            item.deletedAt,
          );
          await itemDoc.patch({
            folderId: recoveryFolder.id,
            spaceId: targetSpaceId,
            deletedAt: 0,
            updatedAt,
            isDirty: true,
          });
          await removeDeletedItemTombstone(db, itemId);
        });
      }

      const deleteDirectories =
        options.deleteUnreferencedOpfsItemDirectories ??
        deleteUnreferencedOpfsItemDirectories;
      try {
        await deleteDirectories(db, removedItemIds);
      } catch (error) {
        console.warn("[folders] media cleanup deferred after permanent delete", error);
        requestOpfsMediaReconciliation();
      }
      await (options.notifyArchivedItemsPurged ?? notifyArchivedItemsPurged)(removedItemIds);
    },
  });
  return removedItems;
}
