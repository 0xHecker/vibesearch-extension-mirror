import { PUBLIC_SPACE_ID, PRIVATE_SPACE_ID } from "@src/common/spaces";
import type { FolderDocType } from "@src/schemas/folder_schema";
import type { ItemDocType } from "@src/schemas/item_schema";
import type { MyDatabase } from "@src/services/DatabaseService";
import {
  cloneOpfsMediaEntriesForItem,
  withOpfsMutationLock,
} from "@src/services/media-storage";
import { deleteUnreferencedOpfsItemDirectories } from "@src/services/opfs-media-lifecycle";
import { withEntityMutationLock, withSpaceMutationLocks } from "@src/services/entity-mutation-lock";
import {
  requireLiveFolderDestination,
  requireLiveSpaceDestination,
} from "@src/services/live-destination";
import { spaceSessionService } from "@src/services/space-session.service";
import { v4 as uuidv4 } from "uuid";

type TransferMode = "move" | "copy";

export type ItemSpaceTransferPayload = {
  itemIds: string[];
  targetSpaceId: string;
};

export type MoveItemsToSpaceResult = {
  updated: number;
  createdFolders: number;
};

export type CopyItemsToSpaceResult = {
  copied: number;
  createdFolders: number;
};

export type ItemSpaceTransferOptions = {
  cloneOpfsMediaEntriesForItem?: typeof cloneOpfsMediaEntriesForItem;
};

type TransferPlan = {
  sourceItems: ItemDocType[];
  targetFolderBySourceFolder: Map<string, string>;
  maxChunkOrderByFolder: Map<string, number>;
  createdFolders: number;
};

type NormalizedTransferPayload = {
  itemIds: string[];
  targetSpaceId: string;
};

type ItemCopies = {
  clones: ItemDocType[];
  cloneIds: string[];
};

function assertSpaceUnlocked(spaceId: string): void {
  if (spaceId === PRIVATE_SPACE_ID && !spaceSessionService.isUnlocked(PRIVATE_SPACE_ID)) {
    throw new Error("PRIVATE_SPACE_LOCKED");
  }
}

function folderMirrorKey(
  folder: Pick<FolderDocType, "name" | "type" | "isPinned" | "isLocked" | "isCollapsed">,
): string {
  return [
    (folder.name || "").trim().toLowerCase(),
    folder.type || "folder",
    folder.isPinned ? "1" : "0",
    folder.isLocked ? "1" : "0",
    folder.isCollapsed ? "1" : "0",
  ].join("::");
}

function notifyCollectionChanged(scope: "folders" | "items"): void {
  try {
    chrome.runtime.sendMessage({ type: "DB_CHANGE", scope });
  } catch {
    // The database write remains authoritative when no extension listener exists.
  }
}

function groupItemsByFolder(items: readonly ItemDocType[]): Map<string, ItemDocType[]> {
  const grouped = new Map<string, ItemDocType[]>();
  for (const item of items) {
    const existing = grouped.get(item.folderId);
    if (existing) existing.push(item);
    else grouped.set(item.folderId, [item]);
  }
  return grouped;
}

function orderFolderItems(items: readonly ItemDocType[]): ItemDocType[] {
  return [...items].sort((left, right) => {
    const leftOrder = left.chunkOrder ?? Number.MAX_SAFE_INTEGER;
    const rightOrder = right.chunkOrder ?? Number.MAX_SAFE_INTEGER;
    if (leftOrder !== rightOrder) return leftOrder - rightOrder;
    return left.createdAt - right.createdAt;
  });
}

async function readSourceSpaceIds(db: MyDatabase, itemIds: readonly string[]): Promise<string[]> {
  const documents = await db.items.findByIds([...itemIds]).exec();
  return itemIds.flatMap((id) => {
    const document = documents.get(id);
    return document ? [document.get("spaceId") || PUBLIC_SPACE_ID] : [];
  });
}

async function readLiveSourceItems(
  db: MyDatabase,
  itemIds: readonly string[],
  initialSourceSpaceIds: readonly string[],
): Promise<ItemDocType[]> {
  const documents = await db.items.findByIds([...itemIds]).exec();
  const items = itemIds.flatMap((id) => {
    const document = documents.get(id);
    if (!document) return [];
    const item = document.toMutableJSON();
    return item.deletedAt === 0 ? [item] : [];
  });

  for (const item of items) {
    const sourceSpaceId = item.spaceId || PUBLIC_SPACE_ID;
    if (!initialSourceSpaceIds.includes(sourceSpaceId)) {
      throw new Error("SOURCE_ITEM_CHANGED");
    }
    assertSpaceUnlocked(sourceSpaceId);
  }
  return items;
}

async function readSourceFolders(
  db: MyDatabase,
  sourceFolderIds: readonly string[],
): Promise<Map<string, FolderDocType>> {
  const documents = await db.folders.findByIds([...sourceFolderIds]).exec();
  const folders = new Map<string, FolderDocType>();
  for (const [folderId, document] of documents) {
    const folder = document.toMutableJSON();
    const spaceId = folder.spaceId || PUBLIC_SPACE_ID;
    await requireLiveFolderDestination(db, folderId, spaceId);
    assertSpaceUnlocked(spaceId);
    folders.set(folderId, folder);
  }
  return folders;
}

async function createMissingDestinationFolders(
  db: MyDatabase,
  targetSpaceId: string,
  sourceFolderIds: readonly string[],
  sourceFolders: ReadonlyMap<string, FolderDocType>,
): Promise<{ targetFolderBySourceFolder: Map<string, string>; createdFolders: number }> {
  const targetDocuments = await db.folders.find({
    selector: { spaceId: { $eq: targetSpaceId } },
  }).exec();
  const targetFolderByMirrorKey = new Map<string, string>();
  let maxSortOrder = 0;
  for (const document of targetDocuments) {
    const folder = document.toMutableJSON();
    if (folder.deletedAt !== 0) continue;
    maxSortOrder = Math.max(maxSortOrder, folder.sortOrder ?? 0);
    const mirrorKey = folderMirrorKey(folder);
    if (!targetFolderByMirrorKey.has(mirrorKey)) {
      targetFolderByMirrorKey.set(mirrorKey, folder.id);
    }
  }

  const now = Date.now();
  const targetFolderBySourceFolder = new Map<string, string>();
  const foldersToInsert: FolderDocType[] = [];

  for (const sourceFolderId of sourceFolderIds) {
    const sourceFolder = sourceFolders.get(sourceFolderId);
    if (!sourceFolder) continue;
    if ((sourceFolder.spaceId || PUBLIC_SPACE_ID) === targetSpaceId) {
      targetFolderBySourceFolder.set(sourceFolderId, sourceFolderId);
      continue;
    }

    const mirrorKey = folderMirrorKey(sourceFolder);
    const existingTargetFolderId = targetFolderByMirrorKey.get(mirrorKey);
    if (existingTargetFolderId) {
      targetFolderBySourceFolder.set(sourceFolderId, existingTargetFolderId);
      continue;
    }

    maxSortOrder += 1;
    const clonedFolder: FolderDocType = {
      id: uuidv4(),
      name: sourceFolder.name,
      userId: sourceFolder.userId ?? "",
      spaceId: targetSpaceId,
      parentId: null,
      type: sourceFolder.type || "folder",
      sortOrder: maxSortOrder,
      isLocked: sourceFolder.isLocked === true,
      isPinned: sourceFolder.isPinned === true,
      isCollapsed: sourceFolder.isCollapsed === true,
      deletedAt: 0,
      purgeAt: 0,
      isDirty: false,
      serverVersion: 0,
      createdAt: sourceFolder.createdAt || now,
      updatedAt: now,
    };
    foldersToInsert.push(clonedFolder);
    targetFolderBySourceFolder.set(sourceFolderId, clonedFolder.id);
    targetFolderByMirrorKey.set(mirrorKey, clonedFolder.id);
  }

  if (foldersToInsert.length > 0) {
    const insertResult = await db.folders.bulkInsert(foldersToInsert);
    if (insertResult.error.length > 0) {
      throw new Error(`Failed to create ${insertResult.error.length} destination folders.`);
    }
  }
  return {
    targetFolderBySourceFolder,
    createdFolders: foldersToInsert.length,
  };
}

async function readDestinationChunkOrders(
  db: MyDatabase,
  targetFolderIds: readonly string[],
): Promise<Map<string, number>> {
  const maxChunkOrderByFolder = new Map<string, number>();
  if (targetFolderIds.length === 0) return maxChunkOrderByFolder;

  const documents = await db.items.find({
    selector: {
      folderId: { $in: [...targetFolderIds] },
      deletedAt: { $eq: 0 },
    },
  }).exec();
  for (const document of documents) {
    const folderId = document.get("folderId");
    const chunkOrder = document.get("chunkOrder") ?? -1;
    maxChunkOrderByFolder.set(
      folderId,
      Math.max(maxChunkOrderByFolder.get(folderId) ?? -1, chunkOrder),
    );
  }
  return maxChunkOrderByFolder;
}

async function buildTransferPlan(
  db: MyDatabase,
  itemIds: readonly string[],
  targetSpaceId: string,
  initialSourceSpaceIds: readonly string[],
): Promise<TransferPlan> {
  await requireLiveSpaceDestination(db, targetSpaceId);
  assertSpaceUnlocked(targetSpaceId);
  const sourceItems = await readLiveSourceItems(db, itemIds, initialSourceSpaceIds);
  const sourceFolderIds = Array.from(new Set(sourceItems.map((item) => item.folderId)));
  const sourceFolders = await readSourceFolders(db, sourceFolderIds);
  const destinationFolders = await createMissingDestinationFolders(
    db,
    targetSpaceId,
    sourceFolderIds,
    sourceFolders,
  );
  const targetFolderIds = Array.from(
    new Set(destinationFolders.targetFolderBySourceFolder.values()),
  );
  const maxChunkOrderByFolder = await readDestinationChunkOrders(db, targetFolderIds);
  return {
    sourceItems,
    targetFolderBySourceFolder: destinationFolders.targetFolderBySourceFolder,
    maxChunkOrderByFolder,
    createdFolders: destinationFolders.createdFolders,
  };
}

function normalizeTransferPayload(payload: ItemSpaceTransferPayload): NormalizedTransferPayload {
  return {
    itemIds: Array.from(new Set(payload.itemIds.filter(Boolean))),
    targetSpaceId: payload.targetSpaceId.trim(),
  };
}

async function executeMove(
  db: MyDatabase,
  plan: TransferPlan,
  targetSpaceId: string,
): Promise<number> {
  const itemsBySourceFolder = groupItemsByFolder(plan.sourceItems);
  const now = Date.now();
  let updated = 0;

  for (const [sourceFolderId, folderItems] of itemsBySourceFolder) {
    const targetFolderId = plan.targetFolderBySourceFolder.get(sourceFolderId);
    if (!targetFolderId) continue;
    let nextOrder = (plan.maxChunkOrderByFolder.get(targetFolderId) ?? -1) + 1;

    for (const item of orderFolderItems(folderItems)) {
      if (item.spaceId === targetSpaceId && item.folderId === targetFolderId) continue;
      const chunkOrder = nextOrder;
      nextOrder += 1;
      await withEntityMutationLock(db, "item", item.id, async () => {
        const current = await db.items.findOne(item.id).exec();
        if (!current || current.get("deletedAt") !== 0) return;
        await current.incrementalPatch({
          folderId: targetFolderId,
          spaceId: targetSpaceId,
          chunkOrder,
          updatedAt: now,
        });
        updated += 1;
      });
    }
  }
  return updated;
}

async function buildCopies(
  plan: TransferPlan,
  targetSpaceId: string,
  cloneMedia: typeof cloneOpfsMediaEntriesForItem,
): Promise<ItemCopies> {
  const itemsBySourceFolder = groupItemsByFolder(plan.sourceItems);
  const now = Date.now();
  const clones: ItemDocType[] = [];
  const cloneIds: string[] = [];

  for (const [sourceFolderId, folderItems] of itemsBySourceFolder) {
    const targetFolderId = plan.targetFolderBySourceFolder.get(sourceFolderId);
    if (!targetFolderId) continue;
    let nextOrder = (plan.maxChunkOrderByFolder.get(targetFolderId) ?? -1) + 1;

    for (const item of orderFolderItems(folderItems)) {
      const cloneId = uuidv4();
      cloneIds.push(cloneId);
      const clonedMedia = await cloneMedia(item.media, cloneId);
      clones.push({
        ...item,
        id: cloneId,
        userId: item.userId ?? "",
        folderId: targetFolderId,
        spaceId: targetSpaceId,
        chunkOrder: nextOrder,
        media: clonedMedia.media,
        displayImageUrl:
          clonedMedia.pathMap.get(item.displayImageUrl || "") || item.displayImageUrl,
        vector_index: -1,
        vector_indexes: [],
        isEmbedded: false,
        isDirty: true,
        serverVersion: 0,
        createdAt: now,
        updatedAt: now,
      });
      nextOrder += 1;
    }
  }
  return { clones, cloneIds };
}

async function executeCopy(
  db: MyDatabase,
  plan: TransferPlan,
  targetSpaceId: string,
  options: ItemSpaceTransferOptions,
): Promise<number> {
  const cloneMedia = options.cloneOpfsMediaEntriesForItem ?? cloneOpfsMediaEntriesForItem;
  let copies: ItemCopies = {
    clones: [],
    cloneIds: [],
  };
  try {
    await withOpfsMutationLock(async () => {
      copies = await buildCopies(plan, targetSpaceId, cloneMedia);
      if (copies.clones.length === 0) return;
      const insertResult = await db.items.bulkInsert(copies.clones);
      if (insertResult.error.length > 0) {
        throw new Error(`Failed to copy ${insertResult.error.length} items.`);
      }
    });
  } catch (error) {
    try {
      await deleteUnreferencedOpfsItemDirectories(db, copies.cloneIds);
    } catch {
      // Cleanup is best-effort; the reconciliation job owns any leftovers.
    }
    throw error;
  }
  return copies.clones.length;
}

async function runTransfer(
  db: MyDatabase,
  payload: ItemSpaceTransferPayload,
  mode: TransferMode,
  options: ItemSpaceTransferOptions,
): Promise<MoveItemsToSpaceResult | CopyItemsToSpaceResult> {
  const { itemIds, targetSpaceId } = normalizeTransferPayload(payload);
  if (itemIds.length === 0 || targetSpaceId.length === 0) {
    return mode === "move"
      ? { updated: 0, createdFolders: 0 }
      : { copied: 0, createdFolders: 0 };
  }

  const initialSourceSpaceIds = await readSourceSpaceIds(db, itemIds);
  return withSpaceMutationLocks(db, [targetSpaceId, ...initialSourceSpaceIds], async () => {
    const plan = await buildTransferPlan(
      db,
      itemIds,
      targetSpaceId,
      initialSourceSpaceIds,
    );
    if (plan.sourceItems.length === 0) {
      return mode === "move"
        ? { updated: 0, createdFolders: 0 }
        : { copied: 0, createdFolders: 0 };
    }

    if (mode === "move") {
      const updated = await executeMove(db, plan, targetSpaceId);
      if (plan.createdFolders > 0) notifyCollectionChanged("folders");
      if (updated > 0) notifyCollectionChanged("items");
      return { updated, createdFolders: plan.createdFolders };
    }

    const copied = await executeCopy(db, plan, targetSpaceId, options);
    if (plan.createdFolders > 0) notifyCollectionChanged("folders");
    if (copied > 0) notifyCollectionChanged("items");
    return { copied, createdFolders: plan.createdFolders };
  });
}

export async function moveItemsToSpace(
  db: MyDatabase,
  payload: ItemSpaceTransferPayload,
): Promise<MoveItemsToSpaceResult> {
  const result = await runTransfer(db, payload, "move", {});
  if ("updated" in result) return result;
  throw new Error("INVALID_MOVE_RESULT");
}

export async function copyItemsToSpace(
  db: MyDatabase,
  payload: ItemSpaceTransferPayload,
  options: ItemSpaceTransferOptions = {},
): Promise<CopyItemsToSpaceResult> {
  const result = await runTransfer(db, payload, "copy", options);
  if ("copied" in result) return result;
  throw new Error("INVALID_COPY_RESULT");
}
