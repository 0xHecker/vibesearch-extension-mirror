import type { FolderDocType } from "@src/schemas/folder_schema";
import type { ItemDocType } from "@src/schemas/item_schema";

const compareFolderItems = (a: ItemDocType, b: ItemDocType) => {
  const ao = a.chunkOrder ?? Number.MAX_SAFE_INTEGER;
  const bo = b.chunkOrder ?? Number.MAX_SAFE_INTEGER;
  if (ao !== bo) return ao - bo;
  return b.createdAt - a.createdAt;
};

/**
 * Buckets the visible result set in one pass. The former per-folder filter
 * rescanned every item for every folder whenever the search result changed.
 */
export const groupItemsByFolder = (
  folders: readonly Pick<FolderDocType, "id">[],
  items: readonly ItemDocType[],
  preserveInputOrder: boolean,
  prioritizedItemId?: string
): Map<string, ItemDocType[]> => {
  const itemsByFolder = new Map<string, ItemDocType[]>();

  for (const folder of folders) {
    itemsByFolder.set(folder.id, []);
  }

  for (const item of items) {
    const bucket = itemsByFolder.get(item.folderId);
    if (bucket) bucket.push(item);
  }

  if (!preserveInputOrder) {
    for (const bucket of itemsByFolder.values()) {
      bucket.sort(compareFolderItems);
    }
  }

  if (prioritizedItemId) {
    for (const bucket of itemsByFolder.values()) {
      const index = bucket.findIndex((item) => item.id === prioritizedItemId);
      if (index <= 0) continue;
      const [prioritizedItem] = bucket.splice(index, 1);
      bucket.unshift(prioritizedItem);
      break;
    }
  }

  return itemsByFolder;
};
