import { PRIVATE_SPACE_ID, PUBLIC_SPACE_ID } from "@src/common/spaces";
import type { ItemDocType } from "@src/schemas/item_schema";
import { MAX_GRID_QUERY_LIMIT } from "@src/search-core/pagination";
import {
  normalizeHttpUrl,
  resolveAllowedSpaceIds,
  type ItemSearchAccessContext,
} from "@src/services/items/access";
import {
  assertSpaceUnlocked,
  isWriteConflict,
  notifyDatabaseChanged,
  triggerBackgroundProcessing,
} from "@src/services/items/runtime";
import type { MyDatabase } from "@src/services/DatabaseService";
import { withSpaceMutationLocks } from "@src/services/entity-mutation-lock";
import {
  requireLiveFolderDestination,
  withLiveFolderDestination,
} from "@src/services/live-destination";
import { spaceSessionService } from "@src/services/space-session.service";
import { appendUnorderedIds } from "@src/utils/ordered-ids";
import { isMetadataFetchableUrl } from "@src/utils/metadata-url";
import { v4 as uuidv4 } from "uuid";

export type GetItemsByIdsPayload = {
  itemIds?: string[];
  spaceIds?: string[];
  accessContext?: ItemSearchAccessContext;
};

export type FindLiveItemsByUrlPayload = {
  urls?: string[];
};

export type LiveItemIdentity = {
  id: string;
  url: string;
};

export type AddItemToFolderPayload = {
  id?: string;
  folderId: string;
  url: string;
  title?: string;
  userId?: string | null;
  iconUrl?: string;
  displayImageUrl?: string;
  textContent?: string;
  source?: ItemDocType["source"];
  authorUsername?: string;
  likes?: number;
  upvotes?: number;
  media?: ItemDocType["media"];
  ocrText?: string;
  ocrStatus?: ItemDocType["ocrStatus"];
  ocrConfidence?: number | null;
  ocrLineCount?: number;
  ocrModelVersion?: string;
  ocrSourceHash?: string;
  isMetaFetched?: boolean;
  isDirty?: boolean;
  shouldFetchMetadata?: boolean;
  deferBackgroundProcessing?: boolean;
  allowLockedPrivateWrite?: boolean;
  parentId?: string | null;
  chunkOrder?: number;
  createdAt?: number;
  updatedAt?: number;
};

export type AddManyItemsPayload = {
  items: ItemDocType[];
};

export type AddManyItemsResult = {
  inserted: number;
};

export type MoveItemsToFolderPayload = {
  itemIds: string[];
  targetFolderId: string;
};

export type ItemUpdateCount = {
  updated: number;
};

export type ReorderItemsPayload = {
  folders: { folderId: string; orderedIds: string[] }[];
};

export type UpdateItemPayload = {
  id: string;
  title?: string;
  url?: string;
  textContent?: string;
  source?: ItemDocType["source"];
  isFavorite?: boolean;
  authorUsername?: string;
  likes?: number;
  upvotes?: number;
};

export type UpdateItemResult = {
  success: boolean;
  error?: string;
};

type BuiltItemPatch = {
  patch: Partial<ItemDocType>;
  embeddingRelevantChanged: boolean;
  error?: string;
};

function requestMetadataFetch(urls: readonly string[], revalidate: boolean): void {
  if (urls.length === 0) return;
  try {
    void Promise.resolve(
      chrome.runtime.sendMessage({
        type: "FETCH_METADATA",
        payload: { urls: [...urls], revalidate },
        target: "background",
      }),
    ).catch(() => undefined);
  } catch {
    // The background startup path will discover pending metadata later.
  }
}

function requestOpfsPromotion(): void {
  try {
    void Promise.resolve(
      chrome.runtime.sendMessage({ type: "PROMOTE_OPFS_MEDIA", target: "background" }),
    ).catch(() => undefined);
  } catch {
    // The background startup path will discover pending OPFS media later.
  }
}

export async function getItemsByIds(
  db: MyDatabase,
  payload: GetItemsByIdsPayload,
): Promise<ItemDocType[]> {
  const itemIds = Array.from(new Set((payload.itemIds || []).filter(Boolean))).slice(
    0,
    MAX_GRID_QUERY_LIMIT,
  );
  if (itemIds.length === 0) return [];

  const baseAllowedSpaceIds = await resolveAllowedSpaceIds(db, payload.accessContext);
  const requestedSpaceIds = new Set((payload.spaceIds || []).filter(Boolean));
  const allowedSpaceIds = requestedSpaceIds.size > 0
    ? baseAllowedSpaceIds.filter((spaceId) => requestedSpaceIds.has(spaceId))
    : baseAllowedSpaceIds;
  if (allowedSpaceIds.length === 0) return [];

  const allowed = new Set(allowedSpaceIds);
  const documents = await db.items.findByIds(itemIds).exec();
  return itemIds.flatMap((itemId) => {
    const document = documents.get(itemId);
    if (!document) return [];
    const item = document.toMutableJSON();
    return item.deletedAt === 0 && allowed.has(item.spaceId) ? [item] : [];
  });
}

export async function findLiveItemByUrls(
  db: MyDatabase,
  payload: FindLiveItemsByUrlPayload,
): Promise<LiveItemIdentity | null> {
  const urls = Array.from(
    new Set(
      (payload.urls || []).slice(0, 20).flatMap((url) => {
        const normalized = normalizeHttpUrl(url);
        return normalized ? [normalized] : [];
      }),
    ),
  );
  if (urls.length === 0) return null;

  const documents = await db.items.find({
    selector: { url: { $in: urls }, deletedAt: { $eq: 0 } },
  }).exec();
  const newest = documents
    .map((document) => document.toMutableJSON())
    .sort((left, right) =>
      right.updatedAt - left.updatedAt ||
      right.createdAt - left.createdAt ||
      right.id.localeCompare(left.id),
    )[0];
  return newest ? { id: newest.id, url: newest.url } : null;
}

function buildNewItem(
  payload: AddItemToFolderPayload,
  normalizedUrl: string,
  folderSpaceId: string,
): ItemDocType {
  const now = Date.now();
  const createdAt = payload.createdAt ?? now;
  const updatedAt = payload.updatedAt ?? createdAt;
  const shouldFetchMetadata =
    payload.shouldFetchMetadata !== false && isMetadataFetchableUrl(normalizedUrl);
  const item: ItemDocType = {
    id: payload.id || uuidv4(),
    userId: payload.userId ?? "",
    title: (payload.title || normalizedUrl).slice(0, 80),
    textContent: payload.textContent ?? "",
    url: normalizedUrl,
    source: payload.source ?? "web",
    folderId: payload.folderId,
    spaceId: folderSpaceId,
    isFavorite: false,
    parentId: payload.parentId ?? null,
    chunkOrder: payload.chunkOrder ?? createdAt,
    vector_index: -1,
    vector_indexes: [],
    ocrStatus: payload.ocrStatus ?? "pending",
    ocrModelVersion: payload.ocrModelVersion ?? "",
    ocrUpdatedAt: payload.ocrStatus ? updatedAt : 0,
    isEmbedded: false,
    isMetaFetched: shouldFetchMetadata ? payload.isMetaFetched ?? false : true,
    isDirty: payload.isDirty ?? true,
    serverVersion: 0,
    createdAt,
    updatedAt,
    deletedAt: 0,
  };

  if (payload.iconUrl !== undefined) item.iconUrl = payload.iconUrl;
  if (payload.displayImageUrl !== undefined) item.displayImageUrl = payload.displayImageUrl;
  if (payload.authorUsername !== undefined) item.authorUsername = payload.authorUsername;
  if (payload.likes !== undefined) item.likes = payload.likes;
  if (payload.upvotes !== undefined) item.upvotes = payload.upvotes;
  if (payload.media !== undefined) item.media = payload.media;
  if (payload.ocrText !== undefined) item.ocrText = payload.ocrText;
  if (payload.ocrConfidence !== undefined) item.ocrConfidence = payload.ocrConfidence;
  if (payload.ocrLineCount !== undefined) item.ocrLineCount = payload.ocrLineCount;
  if (payload.ocrSourceHash !== undefined) item.ocrSourceHash = payload.ocrSourceHash;
  return item;
}

function startNewItemBackgroundWork(
  item: ItemDocType,
  shouldFetchMetadata: boolean,
): void {
  if (shouldFetchMetadata) requestMetadataFetch([item.url], false);
  triggerBackgroundProcessing("TRIGGER_EMBEDDING");
  if ((item.media || []).some((entry) => entry.type === "image")) {
    triggerBackgroundProcessing("TRIGGER_OCR");
  }
  if ((item.media || []).some((entry) => Boolean(entry.opfsPath))) {
    requestOpfsPromotion();
  }
}

export async function addItemToFolder(
  db: MyDatabase,
  payload: AddItemToFolderPayload,
): Promise<ItemDocType> {
  const normalizedUrl = normalizeHttpUrl(payload.url);
  if (!normalizedUrl) throw new Error("INVALID_URL");

  return withLiveFolderDestination(db, payload.folderId, async ({ spaceId }) => {
    const canBypassLock =
      payload.allowLockedPrivateWrite === true && spaceId === PRIVATE_SPACE_ID;
    if (!canBypassLock) assertSpaceUnlocked(spaceId);

    const maxTabsPerFolder = 500;
    const existingCount = await db.items.count({
      selector: { folderId: { $eq: payload.folderId }, deletedAt: { $eq: 0 } },
    }).exec();
    if (existingCount >= maxTabsPerFolder) {
      throw new Error(`Tab group is full — max ${maxTabsPerFolder} tabs per group.`);
    }

    const item = buildNewItem(payload, normalizedUrl, spaceId);
    await db.items.insert(item);
    notifyDatabaseChanged("items");
    if (!payload.deferBackgroundProcessing) {
      const shouldFetchMetadata =
        payload.shouldFetchMetadata !== false && isMetadataFetchableUrl(normalizedUrl);
      startNewItemBackgroundWork(item, shouldFetchMetadata);
    }
    return item;
  });
}

export async function addManyItems(
  db: MyDatabase,
  payload: AddManyItemsPayload,
): Promise<AddManyItemsResult> {
  if (payload.items.length === 0) return { inserted: 0 };
  const folderIds = Array.from(new Set(payload.items.map((item) => item.folderId)));
  const folderDocuments = await db.folders.find({
    selector: { id: { $in: folderIds } },
  }).exec();
  const folderSpaceById = new Map<string, string>();
  for (const document of folderDocuments) {
    folderSpaceById.set(document.primary, document.get("spaceId") || PUBLIC_SPACE_ID);
  }
  if (folderSpaceById.size !== folderIds.length) {
    throw new Error("DESTINATION_FOLDER_NOT_FOUND");
  }

  return withSpaceMutationLocks(db, folderSpaceById.values(), async () => {
    for (const [folderId, spaceId] of folderSpaceById) {
      await requireLiveFolderDestination(db, folderId, spaceId);
    }
    const items: ItemDocType[] = payload.items.map((item) => {
      const targetSpaceId = folderSpaceById.get(item.folderId);
      if (!targetSpaceId) throw new Error("DESTINATION_FOLDER_NOT_FOUND");
      assertSpaceUnlocked(targetSpaceId);
      return {
        ...item,
        userId: item.userId ?? "",
        spaceId: targetSpaceId,
        isMetaFetched: isMetadataFetchableUrl(item.url)
          ? item.isMetaFetched === true
          : true,
      };
    });

    const insertResult = await db.items.bulkInsert(items);
    if (insertResult.error.length > 0) {
      throw new Error(`Failed to insert ${insertResult.error.length} items.`);
    }
    notifyDatabaseChanged("items");
    const urlsToFetch = items
      .filter((item) => !item.isMetaFetched && isMetadataFetchableUrl(item.url))
      .map((item) => item.url);
    requestMetadataFetch(urlsToFetch, false);
    triggerBackgroundProcessing("TRIGGER_EMBEDDING");
    return { inserted: items.length };
  });
}

export async function refetchItemMetadata(
  db: MyDatabase,
  itemIds: string[],
): Promise<void> {
  const documentsById = await db.items.findByIds(itemIds).exec();
  const urls = Array.from(documentsById.values()).flatMap((document) => {
    const spaceId = document.get("spaceId") || PUBLIC_SPACE_ID;
    const canRead =
      spaceId !== PRIVATE_SPACE_ID || spaceSessionService.isUnlocked(PRIVATE_SPACE_ID);
    const url = document.get("url");
    return canRead && isMetadataFetchableUrl(url) ? [url] : [];
  });
  requestMetadataFetch(urls, true);
}

async function readInitialItemSpaces(
  db: MyDatabase,
  itemIds: readonly string[],
): Promise<string[]> {
  const documents = await db.items.findByIds([...itemIds]).exec();
  return itemIds.flatMap((itemId) => {
    const document = documents.get(itemId);
    return document ? [document.get("spaceId") || PUBLIC_SPACE_ID] : [];
  });
}

async function normalizeFolderOrder(db: MyDatabase, folderId: string): Promise<number> {
  const documents = await db.items.find({
    selector: { folderId: { $eq: folderId }, deletedAt: { $eq: 0 } },
  }).exec();
  const items = documents
    .map((document) => document.toMutableJSON())
    .sort((left, right) => {
      const leftOrder = left.chunkOrder ?? Number.MAX_SAFE_INTEGER;
      const rightOrder = right.chunkOrder ?? Number.MAX_SAFE_INTEGER;
      if (leftOrder !== rightOrder) return leftOrder - rightOrder;
      return right.createdAt - left.createdAt;
    });

  let updated = 0;
  for (let index = 0; index < items.length; index += 1) {
    const item = items[index];
    if (item.chunkOrder === index) continue;
    const document = await db.items.findOne(item.id).exec();
    if (!document) continue;
    await document.patch({ chunkOrder: index, updatedAt: Date.now() });
    updated += 1;
  }
  return updated;
}

export async function moveItemsToFolder(
  db: MyDatabase,
  payload: MoveItemsToFolderPayload,
): Promise<ItemUpdateCount> {
  const targetFolderId = payload.targetFolderId.trim();
  const itemIds = Array.from(new Set(payload.itemIds.filter(Boolean)));
  if (!targetFolderId || itemIds.length === 0) return { updated: 0 };

  const targetFolder = await db.folders.findOne(targetFolderId).exec();
  if (!targetFolder) throw new Error("TARGET_FOLDER_NOT_FOUND");
  const targetSpaceId = targetFolder.get("spaceId") || PUBLIC_SPACE_ID;
  const initialSourceSpaceIds = await readInitialItemSpaces(db, itemIds);

  return withSpaceMutationLocks(
    db,
    [targetSpaceId, ...initialSourceSpaceIds],
    async () => {
      await requireLiveFolderDestination(db, targetFolderId, targetSpaceId);
      assertSpaceUnlocked(targetSpaceId);
      const targetDocuments = await db.items.find({
        selector: { folderId: { $eq: targetFolderId }, deletedAt: { $eq: 0 } },
      }).exec();
      let nextTargetOrder = targetDocuments.reduce(
        (maximum, document) => Math.max(maximum, document.get("chunkOrder") ?? -1),
        -1,
      ) + 1;
      let updated = 0;
      const affectedSourceFolders = new Set<string>();
      const validatedFolders = new Set<string>([targetFolderId]);

      for (const itemId of itemIds) {
        const document = await db.items.findOne(itemId).exec();
        if (!document) continue;
        const current = document.toMutableJSON();
        if (current.deletedAt !== 0) continue;
        const sourceSpaceId = current.spaceId || PUBLIC_SPACE_ID;
        if (!initialSourceSpaceIds.includes(sourceSpaceId)) {
          throw new Error("SOURCE_ITEM_CHANGED");
        }
        assertSpaceUnlocked(sourceSpaceId);
        if (!validatedFolders.has(current.folderId)) {
          await requireLiveFolderDestination(db, current.folderId, sourceSpaceId);
          validatedFolders.add(current.folderId);
        }
        if (current.folderId !== targetFolderId) {
          affectedSourceFolders.add(current.folderId);
        }

        const desiredOrder = current.folderId === targetFolderId
          ? current.chunkOrder
          : nextTargetOrder;
        const needsUpdate =
          current.folderId !== targetFolderId ||
          current.chunkOrder !== desiredOrder ||
          current.spaceId !== targetSpaceId;
        if (needsUpdate) {
          await document.patch({
            folderId: targetFolderId,
            spaceId: targetSpaceId,
            chunkOrder: desiredOrder,
            updatedAt: Date.now(),
          });
          updated += 1;
        }
        if (current.folderId !== targetFolderId) nextTargetOrder += 1;
      }

      for (const sourceFolderId of affectedSourceFolders) {
        updated += await normalizeFolderOrder(db, sourceFolderId);
      }
      if (updated > 0) notifyDatabaseChanged("items");
      return { updated };
    },
  );
}

export async function reorderItems(
  db: MyDatabase,
  payload: ReorderItemsPayload,
): Promise<ItemUpdateCount> {
  const entries = payload.folders.filter((entry) => Boolean(entry.folderId));
  if (entries.length === 0) return { updated: 0 };

  const initialFolders = await Promise.all(
    entries.map((entry) => db.folders.findOne(entry.folderId).exec()),
  );
  const folderSpaceById = new Map<string, string>();
  for (let index = 0; index < entries.length; index += 1) {
    const folder = initialFolders[index];
    if (!folder) throw new Error("DESTINATION_FOLDER_NOT_FOUND");
    folderSpaceById.set(
      entries[index].folderId,
      folder.get("spaceId") || PUBLIC_SPACE_ID,
    );
  }

  return withSpaceMutationLocks(db, folderSpaceById.values(), async () => {
    let updated = 0;
    for (const entry of entries) {
      const spaceId = folderSpaceById.get(entry.folderId);
      if (!spaceId) throw new Error("DESTINATION_FOLDER_NOT_FOUND");
      await requireLiveFolderDestination(db, entry.folderId, spaceId);
      assertSpaceUnlocked(spaceId);
      const documents = await db.items.find({
        selector: { folderId: { $eq: entry.folderId }, deletedAt: { $eq: 0 } },
      }).exec();
      const allIds = documents.map((document) => document.primary);
      const validIds = new Set(allIds);
      const requestedIds = entry.orderedIds.filter((id) => validIds.has(id));
      const finalOrder = appendUnorderedIds(requestedIds, allIds);

      for (let index = 0; index < finalOrder.length; index += 1) {
        const document = await db.items.findOne(finalOrder[index]).exec();
        if (!document) continue;
        const current = document.toMutableJSON();
        const needsUpdate =
          current.folderId !== entry.folderId ||
          current.chunkOrder !== index ||
          current.spaceId !== spaceId;
        if (!needsUpdate) continue;
        await document.patch({
          folderId: entry.folderId,
          spaceId,
          chunkOrder: index,
          updatedAt: Date.now(),
        });
        updated += 1;
      }
    }
    if (updated > 0) notifyDatabaseChanged("items");
    return { updated };
  });
}

function buildItemPatch(
  current: ItemDocType,
  payload: UpdateItemPayload,
): BuiltItemPatch {
  const patch: Partial<ItemDocType> = {};
  let embeddingRelevantChanged = false;
  if (payload.title !== undefined && payload.title !== current.title) {
    const title = payload.title.trim().slice(0, 500);
    if (title) {
      patch.title = title;
      embeddingRelevantChanged = true;
    }
  }
  if (payload.url !== undefined && payload.url !== current.url) {
    const url = payload.url.trim();
    if (url) {
      try {
        new URL(url);
        patch.url = url;
      } catch {
        return { patch, embeddingRelevantChanged, error: "INVALID_URL" };
      }
    }
  }
  if (payload.textContent !== undefined && payload.textContent !== current.textContent) {
    patch.textContent = payload.textContent;
    embeddingRelevantChanged = true;
  }
  if (payload.source !== undefined && payload.source !== current.source) {
    patch.source = payload.source;
    embeddingRelevantChanged = true;
  }
  if (payload.isFavorite !== undefined && payload.isFavorite !== current.isFavorite) {
    patch.isFavorite = payload.isFavorite;
  }
  if (
    payload.authorUsername !== undefined &&
    payload.authorUsername !== current.authorUsername
  ) {
    patch.authorUsername = payload.authorUsername.trim() || undefined;
  }
  if (payload.likes !== undefined && payload.likes !== current.likes) {
    patch.likes = Math.max(0, Math.floor(payload.likes));
  }
  if (payload.upvotes !== undefined && payload.upvotes !== current.upvotes) {
    patch.upvotes = Math.max(0, Math.floor(payload.upvotes));
  }
  return { patch, embeddingRelevantChanged };
}

export async function updateItem(
  db: MyDatabase,
  payload: UpdateItemPayload,
): Promise<UpdateItemResult> {
  const initialDocument = await db.items.findOne(payload.id).exec();
  if (!initialDocument) return { success: false, error: "NOT_FOUND" };
  assertSpaceUnlocked(initialDocument.get("spaceId") || PUBLIC_SPACE_ID);
  const built = buildItemPatch(initialDocument.toMutableJSON(), payload);
  if (built.error) return { success: false, error: built.error };
  if (Object.keys(built.patch).length === 0) return { success: true };
  if (built.embeddingRelevantChanged) built.patch.isDirty = true;
  built.patch.updatedAt = Date.now();

  const maxAttempts = 5;
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    const document = await db.items.findOne(payload.id).exec();
    if (!document) return { success: false, error: "NOT_FOUND" };
    try {
      await document.patch(built.patch);
      notifyDatabaseChanged("items");
      if (built.embeddingRelevantChanged) {
        triggerBackgroundProcessing("TRIGGER_EMBEDDING");
      }
      return { success: true };
    } catch (error) {
      if (!isWriteConflict(error)) throw error;
    }
  }
  return { success: false, error: "CONFLICT" };
}
