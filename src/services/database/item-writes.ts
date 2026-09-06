import { PUBLIC_SPACE_ID } from "@src/common/spaces";
import type { ItemDocType } from "@src/schemas/item_schema";
import { getDb } from "@src/services/DatabaseService";
import { withEntityMutationLock } from "@src/services/entity-mutation-lock";
import { moveItemToBin } from "@src/services/items/bin-lifecycle";
import {
  addItemToFolder as addItemRecordToFolder,
  addManyItems,
  type AddItemToFolderPayload,
} from "@src/services/items/records";
import { notifyDatabaseChanged } from "@src/services/database/notifications";
import { forEachIdKeysetPage } from "@src/services/rxdb-keyset-pagination";
import { isEmbeddingStateCommitCurrent } from "@src/services/database/vector-records";

const BULK_ITEM_UPDATE_BATCH_SIZE = 400;

export type BulkItemUpdate = Partial<ItemDocType> & {
  expectedRevision?: string;
  expectedUpdatedAt?: number;
};

function normalizeUserId(userId: string | null | undefined): string {
  return userId ?? "";
}

function createItemPatch(update: BulkItemUpdate): Partial<ItemDocType> {
  const patch = { ...update };
  delete patch.id;
  delete patch.deletedAt;
  delete patch.expectedRevision;
  delete patch.expectedUpdatedAt;
  if (patch.userId !== undefined) patch.userId = normalizeUserId(patch.userId);
  return patch;
}

/** Soft-delete an item and create the tombstone consumed by vector sync. */
export async function deleteItem(payload: { id: string }): Promise<void> {
  const db = await getDb();
  await moveItemToBin(db, payload.id);
}

/** Purge vector-sync tombstones after the remote side acknowledges them. */
export async function clearDeletedItems(): Promise<void> {
  const db = await getDb();
  const tombstones = await db.deleted_items.find().exec();
  if (tombstones.length === 0) return;
  await db.deleted_items.bulkRemove(tombstones.map((document) => document.primary));
}

/** Apply embedding-state updates only to the exact item revisions they describe. */
export async function bulkUpdateItems(updates: BulkItemUpdate[]): Promise<void> {
  const updatesById = new Map<string, BulkItemUpdate>();
  for (const update of updates) {
    if (update.id) updatesById.set(update.id, update);
  }
  if (updatesById.size === 0) return;

  const db = await getDb();
  const ids = [...updatesById.keys()];
  for (let start = 0; start < ids.length; start += BULK_ITEM_UPDATE_BATCH_SIZE) {
    const batchIds = ids.slice(start, start + BULK_ITEM_UPDATE_BATCH_SIZE);
    await Promise.all(batchIds.map(async (id) => {
      const update = updatesById.get(id);
      if (!update) return;
      await withEntityMutationLock(db, "item", id, async () => {
        const document = await db.items.findOne(id).exec();
        if (!document) return;
        const current = document.toMutableJSON();
        if (!isEmbeddingStateCommitCurrent(current, document.revision, update)) return;

        const patch = createItemPatch(update);
        if (Object.keys(patch).length > 0) await document.incrementalPatch(patch);
      });
    }));
    if (start + batchIds.length < ids.length) {
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
    }
  }
}

export async function markItemAsDirty(payload: { id: string }): Promise<void> {
  const db = await getDb();
  const document = await db.items.findOne(payload.id).exec();
  if (document) await document.patch({ isDirty: true });
}

/** Use the canonical item-write path while preserving the legacy manager API. */
export async function addItems(payload: { items: ItemDocType[] }): Promise<void> {
  const db = await getDb();
  await addManyItems(db, payload);
}

/** Use the canonical item-write path while preserving the legacy manager API. */
export async function addItemToFolder(
  payload: AddItemToFolderPayload,
): Promise<ItemDocType> {
  const db = await getDb();
  return addItemRecordToFolder(db, payload);
}

/** Repair denormalized item space IDs in bounded pages. */
export async function repairItemSpaceIdsFromFolders(): Promise<number> {
  const db = await getDb();
  const folderDocuments = await db.folders.find().exec();
  const folderSpaceById = new Map<string, string>();
  for (const document of folderDocuments) {
    const folder = document.toMutableJSON();
    folderSpaceById.set(folder.id, folder.spaceId || PUBLIC_SPACE_ID);
  }

  let repaired = 0;
  await forEachIdKeysetPage({
    collection: db.items,
    selector: {},
    pageSize: BULK_ITEM_UPDATE_BATCH_SIZE,
    onPage: async (documents) => {
      const now = Date.now();
      const updates = documents.flatMap((document) => {
        const item = document.toMutableJSON();
        const spaceId = folderSpaceById.get(item.folderId) || item.spaceId || PUBLIC_SPACE_ID;
        if (item.spaceId === spaceId) return [];
        return [{ ...item, userId: normalizeUserId(item.userId), spaceId, updatedAt: now }];
      });
      if (updates.length === 0) return;
      await db.items.bulkUpsert(updates);
      repaired += updates.length;
    },
  });

  if (repaired > 0) notifyDatabaseChanged("items");
  return repaired;
}
