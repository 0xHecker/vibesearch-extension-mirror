import type { ItemDocType } from "@src/schemas/item_schema";
import {
  getVectorIndexes,
  hasEmbeddableText,
  isMetadataReadyForEmbedding,
} from "@src/search-core/embedding-state";
import { getDb } from "@src/services/DatabaseService";
import { forEachIdKeysetPage } from "@src/services/rxdb-keyset-pagination";

const VECTOR_RECORD_BATCH_SIZE = 400;

export type ActiveVectorInventoryItem = Pick<
  ItemDocType,
  | "id"
  | "vector_index"
  | "vector_indexes"
  | "isEmbedded"
  | "isMetaFetched"
  | "isDirty"
> & { revision: string };

export type ActiveVectorEmbeddingSnapshot = {
  item: ItemDocType;
  revision: string;
};

export type CompactedVectorIndexCommit = {
  id: string;
  vector_index: number;
  vector_indexes: number[];
  expectedRevision: string;
  isEmbeddedOnMatch: boolean;
  isDirtyOnMatch: boolean;
};

export function applyCompactedVectorIndexCommit<T extends ItemDocType>(
  current: T,
  currentRevision: string,
  update: CompactedVectorIndexCommit,
): T {
  return {
    ...current,
    vector_index: update.vector_index,
    vector_indexes: [...update.vector_indexes],
    isEmbedded: currentRevision === update.expectedRevision
      ? update.isEmbeddedOnMatch
      : false,
    isDirty: currentRevision === update.expectedRevision
      ? update.isDirtyOnMatch
      : true,
  };
}

export function applyVectorInvalidation<T extends ItemDocType>(
  current: T,
  options?: { touchUpdatedAt?: boolean; now?: number },
): T {
  return {
    ...current,
    vector_index: -1,
    vector_indexes: [],
    isEmbedded: false,
    isDirty: true,
    updatedAt: options?.touchUpdatedAt ? options.now ?? Date.now() : current.updatedAt,
  };
}

export function isEmbeddingStateCommitCurrent(
  current: Pick<ItemDocType, "deletedAt" | "updatedAt">,
  currentRevision: string,
  expected: { expectedRevision?: string; expectedUpdatedAt?: number },
): boolean {
  return (
    (current.deletedAt || 0) === 0 &&
    (expected.expectedRevision === undefined || currentRevision === expected.expectedRevision) &&
    (expected.expectedUpdatedAt === undefined || current.updatedAt === expected.expectedUpdatedAt)
  );
}

export async function getItemsToEmbed(
  payload?: { limit?: number },
): Promise<(ItemDocType & { expectedRevision: string })[]> {
  const db = await getDb();
  const limit = Math.max(1, Math.min(100, Math.floor(payload?.limit || 100)));
  const documents = await db.items.find({
    selector: { isEmbedded: false, isMetaFetched: true, deletedAt: { $eq: 0 } },
    limit,
  }).exec();
  return documents
    .map((document) => ({
      ...document.toMutableJSON(),
      expectedRevision: document.revision,
    }))
    .filter(isMetadataReadyForEmbedding);
}

export async function repairItemsMissingVectors(
  vectorCount = Number.MAX_SAFE_INTEGER,
): Promise<number> {
  const db = await getDb();
  let repairedCount = 0;
  await forEachIdKeysetPage({
    collection: db.items,
    selector: { deletedAt: { $eq: 0 }, isEmbedded: { $eq: true } },
    pageSize: VECTOR_RECORD_BATCH_SIZE,
    onPage: async (documents) => {
      const updates = documents
        .map((document) => document.toMutableJSON())
        .filter((item) => {
          if (!hasEmbeddableText(item)) return false;
          const indexes = getVectorIndexes(item);
          return indexes.length === 0 || indexes.some((index) => index >= vectorCount);
        })
        .map((item) => ({
          ...item,
          vector_index: -1,
          vector_indexes: [],
          isEmbedded: false,
          isDirty: true,
        }));
      if (updates.length === 0) return;
      await db.items.bulkUpsert(updates);
      repairedCount += updates.length;
    },
  });
  return repairedCount;
}

export async function getActiveVectorInventory(): Promise<ActiveVectorInventoryItem[]> {
  const db = await getDb();
  const inventory: ActiveVectorInventoryItem[] = [];
  await forEachIdKeysetPage({
    collection: db.items,
    selector: { deletedAt: { $eq: 0 } },
    pageSize: VECTOR_RECORD_BATCH_SIZE,
    onPage: (documents) => {
      for (const document of documents) {
        const item = document.toMutableJSON();
        inventory.push({
          id: item.id,
          vector_index: item.vector_index,
          vector_indexes: [...(item.vector_indexes || [])],
          isEmbedded: item.isEmbedded,
          isMetaFetched: item.isMetaFetched,
          isDirty: item.isDirty,
          revision: document.revision,
        });
      }
    },
  });
  return inventory;
}

export async function getActiveItemsByIds(
  itemIds: string[],
): Promise<ActiveVectorEmbeddingSnapshot[]> {
  const db = await getDb();
  const ids = Array.from(new Set(itemIds.filter(Boolean)));
  const items: ActiveVectorEmbeddingSnapshot[] = [];
  for (let start = 0; start < ids.length; start += VECTOR_RECORD_BATCH_SIZE) {
    const batchIds = ids.slice(start, start + VECTOR_RECORD_BATCH_SIZE);
    const documents = await db.items.findByIds(batchIds).exec();
    for (const itemId of batchIds) {
      const document = documents.get(itemId);
      if (!document) continue;
      const item = document.toMutableJSON();
      if ((item.deletedAt || 0) !== 0) continue;
      items.push({ item, revision: document.revision });
    }
    if (start + batchIds.length < ids.length) {
      await new Promise<void>((resolve) => globalThis.setTimeout(resolve, 0));
    }
  }
  return items;
}

export async function commitCompactedVectorIndexes(
  updates: CompactedVectorIndexCommit[],
): Promise<void> {
  const db = await getDb();
  const updateById = new Map<string, CompactedVectorIndexCommit>();
  for (const update of updates) {
    if (update.id) updateById.set(update.id, update);
  }
  const ids = Array.from(updateById.keys());
  for (let start = 0; start < ids.length; start += VECTOR_RECORD_BATCH_SIZE) {
    const batchIds = ids.slice(start, start + VECTOR_RECORD_BATCH_SIZE);
    const documents = await db.items.findByIds(batchIds).exec();
    await Promise.all(batchIds.map(async (itemId) => {
      const document = documents.get(itemId);
      const update = updateById.get(itemId);
      if (!document || !update) return;
      await db.items.incrementalWriteQueue.addWrite(document._data, (current) =>
        applyCompactedVectorIndexCommit(current, current._rev, update));
    }));
    if (start + batchIds.length < ids.length) {
      await new Promise<void>((resolve) => globalThis.setTimeout(resolve, 0));
    }
  }
}

export async function getDirtyItems(
  payload?: { limit?: number },
): Promise<(ItemDocType & { expectedRevision: string })[]> {
  const db = await getDb();
  const limit = Math.max(1, Math.min(100, Math.floor(payload?.limit || 100)));
  const documents = await db.items.find({
    selector: { isDirty: true, isMetaFetched: true, deletedAt: { $eq: 0 } },
    limit,
  }).exec();
  return documents
    .map((document) => ({
      ...document.toMutableJSON(),
      expectedRevision: document.revision,
    }))
    .filter(isMetadataReadyForEmbedding);
}

export async function markAllActiveItemsForReembedding(options?: {
  touchUpdatedAt?: boolean;
}): Promise<number> {
  const db = await getDb();
  const now = Date.now();
  const touchUpdatedAt = options?.touchUpdatedAt === true;
  let updatedCount = 0;
  await forEachIdKeysetPage({
    collection: db.items,
    selector: { deletedAt: { $eq: 0 } },
    pageSize: VECTOR_RECORD_BATCH_SIZE,
    onPage: async (documents) => {
      await Promise.all(documents.map((document) =>
        db.items.incrementalWriteQueue.addWrite(document._data, (current) =>
          applyVectorInvalidation(current, { touchUpdatedAt, now }))));
      updatedCount += documents.length;
    },
  });
  return updatedCount;
}
