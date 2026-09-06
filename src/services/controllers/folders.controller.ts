import { getDb, type MyDatabase } from "@src/services/DatabaseService";
import { FolderDocType } from "@src/schemas/folder_schema";
import { ItemDocType } from "@src/schemas/item_schema";
import { v4 as uuidv4 } from "uuid";
import { moveItemToBin } from "@src/services/items/bin-lifecycle";
import { appendUnorderedIds } from "@src/utils/ordered-ids";
import { PRIVATE_SPACE_ID, PUBLIC_SPACE_ID, computeBinPurgeAt } from "@src/common/spaces";
import { spaceSessionService } from "@src/services/space-session.service";
import {
  cloneOpfsMediaEntriesForItem,
  withOpfsMutationLock,
} from "@src/services/media-storage";
import {
  deleteUnreferencedOpfsItemDirectories,
} from "@src/services/opfs-media-lifecycle";
import {
  resolveRestoreSpace,
  restoreFallbackMessage,
} from "@src/services/bin-restore-location";
import { nextBinMutationTimestamp } from "@src/common/bin";
import {
  withBinMutationLock,
  withEntityMutationLock,
  withSpaceMutationLock,
  withSpaceMutationLocks,
} from "@src/services/entity-mutation-lock";
import {
  requireLiveFolderDestination,
  requireLiveSpaceDestination,
  withLiveSpaceDestination,
} from "@src/services/live-destination";
import { forEachIdKeysetPage } from "@src/services/rxdb-keyset-pagination";
import { notifyArchivedItemsPurged } from "@src/services/archive-lifecycle";
import {
  collectFolderTreeIds,
  purgeFolderTreeItems,
  relocateLiveItemsFromTree,
  removeDeletedItemTombstone,
} from "@src/services/folders/bin-lifecycle";
import type { RxDocument } from "rxdb";

const FOLDER_ITEM_PAGE_SIZE = 200;
type FolderDocument = RxDocument<FolderDocType>;

export type FoldersControllerOptions = {
  getDb?: typeof getDb;
  cloneOpfsMediaEntriesForItem?: typeof cloneOpfsMediaEntriesForItem;
  deleteUnreferencedOpfsItemDirectories?: typeof deleteUnreferencedOpfsItemDirectories;
  notifyArchivedItemsPurged?: typeof notifyArchivedItemsPurged;
};

export class FoldersController {
  constructor(private readonly options: FoldersControllerOptions = {}) {}

  private getDatabase(): ReturnType<typeof getDb> {
    return (this.options.getDb ?? getDb)();
  }

  private normalizeUserId(userId: string | null | undefined): string {
    return userId ?? "";
  }

  private assertSpaceUnlocked(spaceId: string): void {
    if (spaceId === PRIVATE_SPACE_ID && !spaceSessionService.isUnlocked(PRIVATE_SPACE_ID)) {
      throw new Error("PRIVATE_SPACE_LOCKED");
    }
  }

  private resolveSpaceId(value: string | undefined): string {
    return (value || PUBLIC_SPACE_ID).trim() || PUBLIC_SPACE_ID;
  }

  private async getFolderWithAccess(
    db: MyDatabase,
    folderId: string,
  ): Promise<FolderDocument | null> {
    const doc = await db.folders.findOne(folderId).exec();
    if (!doc) return null;
    const spaceId = this.resolveSpaceId(doc.get("spaceId"));
    this.assertSpaceUnlocked(spaceId);
    return doc;
  }

  async getById(payload: { id: string; skipLockCheck?: boolean }): Promise<FolderDocType | null> {
    const db = await this.getDatabase();
    const doc = payload.skipLockCheck
      ? await db.folders.findOne(payload.id).exec()
      : await this.getFolderWithAccess(db, payload.id);
    if (!doc) return null;
    return doc.toMutableJSON();
  }

  async create(payload: {
    name: string;
    userId?: string | null;
    parentId?: string | null;
    spaceId?: string;
    allowLockedPrivateWrite?: boolean;
  }): Promise<FolderDocType> {
    const db = await this.getDatabase();
    const requestedSpaceId = (payload.spaceId || PUBLIC_SPACE_ID).trim() || PUBLIC_SPACE_ID;
    return withLiveSpaceDestination(db, requestedSpaceId, async (_spaceDoc, spaceId) => {
      const bypassLockCheck =
        payload.allowLockedPrivateWrite === true && spaceId === PRIVATE_SPACE_ID;
      if (!bypassLockCheck) this.assertSpaceUnlocked(spaceId);
      if (payload.parentId) {
        await requireLiveFolderDestination(db, payload.parentId, spaceId);
      }

      const now = Date.now();
      const folder: FolderDocType = {
        id: uuidv4(),
        name: payload.name,
        userId: this.normalizeUserId(payload.userId),
        spaceId,
        parentId: payload.parentId ?? null,
        type: "folder",
        sortOrder: now,
        isLocked: false,
        isPinned: false,
        isCollapsed: false,
        deletedAt: 0,
        purgeAt: 0,
        isDirty: false,
        serverVersion: 0,
        createdAt: now,
        updatedAt: now,
      };
      await db.folders.insert(folder);
      try {
        chrome.runtime.sendMessage({ type: "DB_CHANGE", scope: "folders" });
      } catch {}
      return folder;
    });
  }

  async setPinned(payload: { id: string; value: boolean }): Promise<{ success: boolean }> {
    const db = await this.getDatabase();
    const doc = await this.getFolderWithAccess(db, payload.id);
    if (!doc) return { success: false };
    await doc.incrementalPatch({ isPinned: payload.value, updatedAt: Date.now() });
    try {
      chrome.runtime.sendMessage({ type: "DB_CHANGE", scope: "folders" });
    } catch {}
    return { success: true };
  }

  async setLocked(payload: { id: string; value: boolean }): Promise<{ success: boolean }> {
    const db = await this.getDatabase();
    const doc = await this.getFolderWithAccess(db, payload.id);
    if (!doc) return { success: false };
    await doc.incrementalPatch({ isLocked: payload.value, updatedAt: Date.now() });
    try {
      chrome.runtime.sendMessage({ type: "DB_CHANGE", scope: "folders" });
    } catch {}
    return { success: true };
  }

  async setCollapsed(payload: { id: string; value: boolean }): Promise<{ success: boolean }> {
    const db = await this.getDatabase();
    const doc = await this.getFolderWithAccess(db, payload.id);
    if (!doc) return { success: false };
    await doc.incrementalPatch({ isCollapsed: payload.value, updatedAt: Date.now() });
    return { success: true };
  }

  async rename(payload: { id: string; name: string }): Promise<{ success: boolean }> {
    const db = await this.getDatabase();
    const doc = await this.getFolderWithAccess(db, payload.id);
    if (!doc) return { success: false };
    const name = payload.name.trim().slice(0, 80);
    await doc.incrementalPatch({ name, updatedAt: Date.now() });
    try {
      chrome.runtime.sendMessage({ type: "DB_CHANGE", scope: "folders" });
    } catch {}
    return { success: true };
  }

  /**
   * Deletes a folder tree and optionally soft-deletes all items inside it.
   * Respects the root folder's locked state; locked folders will not be deleted.
   */
  async delete(payload: {
    id: string;
    alsoDeleteItems?: boolean;
  }): Promise<{ success: boolean; error?: string }> {
    const db = await this.getDatabase();
    const id = (payload.id || "").trim();
    if (!id) return { success: false, error: "NOT_FOUND" };
    return withBinMutationLock(db, () =>
      withEntityMutationLock(db, "folder", id, async () => {
        const initial = await this.getFolderWithAccess(db, id);
        if (!initial) return { success: false, error: "NOT_FOUND" };
        const initialSpaceId = this.resolveSpaceId(initial.get("spaceId"));
        return withSpaceMutationLock(db, initialSpaceId, async () => {
          const doc = await this.getFolderWithAccess(db, id);
          if (!doc) return { success: false, error: "NOT_FOUND" };
          const current = doc.toMutableJSON();
          if (this.resolveSpaceId(current.spaceId) !== initialSpaceId) {
            throw new Error("DESTINATION_FOLDER_CHANGED");
          }
          if (current.deletedAt !== 0) return { success: true };
          if (current.isLocked) return { success: false, error: "LOCKED" };

          const alsoDeleteItems = payload.alsoDeleteItems !== false;
          // Keeping live items needs a provably live destination. The older
          // delete-with-items path is also used while constructing/restoring
          // binned-space trees and does not create any live descendants.
          if (!alsoDeleteItems) {
            await requireLiveSpaceDestination(db, initialSpaceId);
          }

          const folderDocs = await db.folders
            .find({ selector: { spaceId: { $eq: current.spaceId } } })
            .exec();
          const folders = folderDocs.map((folderDoc) => folderDoc.toMutableJSON());
          const folderIds = collectFolderTreeIds(folders, id);

          const clockNow = Date.now();
          let relocatedItems = 0;
          if (alsoDeleteItems) {
            await forEachIdKeysetPage({
              collection: db.items,
              selector: {
                folderId: { $in: Array.from(folderIds) },
                deletedAt: { $eq: 0 },
              },
              pageSize: FOLDER_ITEM_PAGE_SIZE,
              onPage: async (items) => {
                for (const item of items) {
                  await moveItemToBin(db, item.primary);
                }
              },
            });
          } else {
            relocatedItems = await relocateLiveItemsFromTree(
              db,
              folderIds,
              current,
              initialSpaceId
            );
          }

          for (const folderDoc of folderDocs) {
            if (!folderIds.has(folderDoc.primary)) continue;
            const folder = folderDoc.toMutableJSON();
            const deletedAt = nextBinMutationTimestamp(
              clockNow,
              folder.updatedAt,
              folder.deletedAt
            );
            await folderDoc.patch({
              deletedAt,
              purgeAt: computeBinPurgeAt(deletedAt),
              updatedAt: deletedAt,
            });
          }
          try {
            chrome.runtime.sendMessage({ type: "DB_CHANGE", scope: "folders" });
          } catch {}
          if (relocatedItems > 0) {
            try {
              chrome.runtime.sendMessage({ type: "DB_CHANGE", scope: "items" });
            } catch {}
          }
          return { success: true };
        });
      })
    );
  }

  async restoreFromBin(payload: {
    id: string;
  }): Promise<{ success: boolean; restoredItems: number; error?: string; relocated?: boolean; message?: string }> {
    const db = await this.getDatabase();
    const id = (payload.id || "").trim();
    if (!id) return { success: false, restoredItems: 0, error: "NOT_FOUND" };
    return withBinMutationLock(db, () =>
      withEntityMutationLock(db, "folder", id, async () => {
        const doc = await this.getFolderWithAccess(db, id);
        if (!doc) return { success: false, restoredItems: 0, error: "NOT_FOUND" };

        const current = doc.toMutableJSON();
        if ((current.deletedAt || 0) === 0) return { success: true, restoredItems: 0 };

        const restoreSpace = await resolveRestoreSpace(db, current.spaceId || PUBLIC_SPACE_ID);
        return withSpaceMutationLocks(
          db,
          [current.spaceId || PUBLIC_SPACE_ID, restoreSpace.space.id],
          async () => {
        const lockedDoc = await db.folders.findOne(id).exec();
        if (!lockedDoc) {
          return { success: false, restoredItems: 0, error: "NOT_FOUND" };
        }
        const current = lockedDoc.toMutableJSON();
        if ((current.deletedAt || 0) === 0) return { success: true, restoredItems: 0 };
        let targetParentId = current.parentId || null;
        let relocated = restoreSpace.relocated;
        const parentId = current.parentId || null;
        if (!relocated && parentId) {
          const parentDoc = await db.folders.findOne(parentId).exec();
          const parentDeletedAt = parentDoc?.get("deletedAt") || 0;
          relocated = !parentDoc || parentDeletedAt > 0;
        }
        if (relocated) targetParentId = null;

        const folderDocs = await db.folders
          .find({ selector: { spaceId: { $eq: current.spaceId } } })
          .exec();
        const folders = folderDocs.map((folderDoc) => folderDoc.toMutableJSON());
        const folderIds = collectFolderTreeIds(folders, id);
        const clockNow = Date.now();

        for (const folderDoc of folderDocs) {
          if (!folderIds.has(folderDoc.primary)) continue;
          const folder = folderDoc.toMutableJSON();
          const updatedAt = nextBinMutationTimestamp(
            clockNow,
            folder.updatedAt,
            folder.deletedAt
          );
          await folderDoc.patch({
            spaceId: restoreSpace.space.id,
            parentId:
              folderDoc.primary === id
                ? targetParentId
                : folderDoc.get("parentId"),
            deletedAt: 0,
            purgeAt: 0,
            updatedAt,
          });
        }

        let restoredItems = 0;
        await forEachIdKeysetPage({
          collection: db.items,
          selector: {
            folderId: { $in: Array.from(folderIds) },
            deletedAt: { $gt: 0 },
          },
          pageSize: FOLDER_ITEM_PAGE_SIZE,
          onPage: async (candidates) => {
            for (const candidate of candidates) {
              const itemId = candidate.primary;
              await withEntityMutationLock(db, "item", itemId, async () => {
                const itemDoc = await db.items.findOne(itemId).exec();
                if (!itemDoc) return;
                const item = itemDoc.toMutableJSON();
                if (!(item.deletedAt > 0) || !folderIds.has(item.folderId)) return;
                const updatedAt = nextBinMutationTimestamp(
                  clockNow,
                  item.updatedAt,
                  item.deletedAt
                );
                await itemDoc.patch({
                  spaceId: restoreSpace.space.id,
                  deletedAt: 0,
                  updatedAt,
                  isDirty: true,
                });
                await removeDeletedItemTombstone(db, itemId);
                restoredItems += 1;
              });
            }
          },
        });

        if (restoreSpace.created) {
          try {
            chrome.runtime.sendMessage({ type: "DB_CHANGE", scope: "spaces" });
          } catch {}
        }
        try {
          chrome.runtime.sendMessage({ type: "DB_CHANGE", scope: "folders" });
        } catch {}
        try {
          chrome.runtime.sendMessage({ type: "DB_CHANGE", scope: "items" });
        } catch {}

            return {
              success: true,
              restoredItems,
              relocated,
              message: relocated
                ? restoreFallbackMessage(restoreSpace.space.name)
                : undefined,
            };
          }
        );
      })
    );
  }

  async deleteForever(payload: {
    id: string;
    expectedDeletedAt: number;
  }): Promise<{ success: boolean; removedItems: number; removedFolders: number; error?: string }> {
    const db = await this.getDatabase();
    const id = (payload.id || "").trim();
    if (!id) return { success: false, removedItems: 0, removedFolders: 0, error: "NOT_FOUND" };
    return withBinMutationLock(db, () =>
      withEntityMutationLock(db, "folder", id, async () => {
        const doc = await this.getFolderWithAccess(db, id);
        if (!doc) {
          return { success: false, removedItems: 0, removedFolders: 0, error: "NOT_FOUND" };
        }

        const current = doc.toMutableJSON();
        if (current.isLocked) {
          return { success: false, removedItems: 0, removedFolders: 0, error: "LOCKED" };
        }
        if (!(current.deletedAt > 0)) throw new Error("FOLDER_NOT_IN_BIN");
        if (current.deletedAt !== payload.expectedDeletedAt) {
          throw new Error("FOLDER_BIN_ENTRY_CHANGED");
        }
        const spaceId = this.resolveSpaceId(current.spaceId);
        return withSpaceMutationLock(db, spaceId, async () => {
          const freshDoc = await db.folders.findOne(id).exec();
          if (!freshDoc) {
            return {
              success: false,
              removedItems: 0,
              removedFolders: 0,
              error: "NOT_FOUND",
            };
          }
          const fresh = freshDoc.toMutableJSON();
          if (this.resolveSpaceId(fresh.spaceId) !== spaceId) {
            throw new Error("FOLDER_BIN_ENTRY_CHANGED");
          }
          if (!(fresh.deletedAt > 0)) throw new Error("FOLDER_NOT_IN_BIN");
          if (fresh.deletedAt !== payload.expectedDeletedAt) {
            throw new Error("FOLDER_BIN_ENTRY_CHANGED");
          }

          const folderDocs = await db.folders
            .find({ selector: { spaceId: { $eq: spaceId } } })
            .exec();
          const folders = folderDocs.map((folderDoc) => folderDoc.toMutableJSON());
          const folderIds = collectFolderTreeIds(folders, id);

          const removedItems = await purgeFolderTreeItems(
            db,
            folderIds,
            fresh,
            spaceId,
            this.options,
          );

          for (const folderDoc of folderDocs) {
            if (folderIds.has(folderDoc.primary)) await folderDoc.remove();
          }

          try {
            chrome.runtime.sendMessage({ type: "DB_CHANGE", scope: "folders" });
          } catch {}
          try {
            chrome.runtime.sendMessage({ type: "DB_CHANGE", scope: "items" });
          } catch {}

          return {
            success: true,
            removedItems,
            removedFolders: folderIds.size,
          };
        });
      })
    );
  }

  async countItemsInTree(payload: { ids: string[] }): Promise<Record<string, number>> {
    const db = await this.getDatabase();
    const ids = Array.from(new Set((payload.ids || []).map((id) => id.trim()).filter(Boolean)));
    const counts: Record<string, number> = {};
    for (const id of ids) {
      const doc = await this.getFolderWithAccess(db, id);
      if (!doc) {
        counts[id] = 0;
        continue;
      }
      const root = doc.toMutableJSON();
      const folderDocs = await db.folders.find({ selector: { spaceId: { $eq: root.spaceId } } }).exec();
      const folders = folderDocs.map((folderDoc) => folderDoc.toMutableJSON());
      const folderIds = collectFolderTreeIds(folders, id);
      counts[id] = await db.items
        .count({
          selector: {
            folderId: { $in: Array.from(folderIds) },
            deletedAt: { $eq: 0 },
          },
        })
        .exec();
    }
    return counts;
  }

  async reorder(payload: {
    orderedIds: string[];
    spaceId?: string;
    parentId?: string | null;
  }): Promise<{ success: boolean }> {
    const db = await this.getDatabase();
    if (payload.spaceId) {
      this.assertSpaceUnlocked(this.resolveSpaceId(payload.spaceId));
    }
    const docs = payload.spaceId
      ? await db.folders.find({ selector: { spaceId: { $eq: payload.spaceId } } }).exec()
      : await db.folders.find().exec();
    const accessibleDocs = docs.filter((doc) => {
      const spaceId = this.resolveSpaceId(doc.get("spaceId"));
      return spaceId !== PRIVATE_SPACE_ID || spaceSessionService.isUnlocked(PRIVATE_SPACE_ID);
    });
    const isSibling = (doc: FolderDocument): boolean => {
      if (payload.parentId === undefined) return true;
      const docParent = doc.get("parentId") || null;
      const filterParent = (payload.parentId ?? null) || null;
      return docParent === filterParent;
    };
    const siblings = accessibleDocs.filter(isSibling);
    if (siblings.length === 0) return { success: true };
    const allIds = siblings.map((d) => d.primary);
    const provided = (payload.orderedIds || []).filter((id) => id && allIds.includes(id));
    const finalOrder = appendUnorderedIds(provided, allIds);
    const now = Date.now();

    const lookup = new Map(siblings.map((doc) => [doc.primary, doc]));
    for (let i = 0; i < finalOrder.length; i++) {
      const id = finalOrder[i];
      const doc = lookup.get(id);
      if (!doc) continue;
      const currentOrder = doc.get("sortOrder") ?? 0;
      if (currentOrder !== i) {
        await doc.incrementalPatch({ sortOrder: i, updatedAt: now });
      }
    }
    try {
      chrome.runtime.sendMessage({ type: "DB_CHANGE", scope: "folders" });
    } catch {}
    return { success: true };
  }

  async moveToParent(payload: {
    folderId: string;
    parentId: string | null;
  }): Promise<{ success: boolean; error?: string }> {
    const db = await this.getDatabase();
    const folderId = (payload.folderId || "").trim();
    const parentId = payload.parentId ?? null;
    if (!folderId) return { success: false, error: "FOLDER_ID_REQUIRED" };
    if (folderId === parentId) {
      return { success: false, error: "FOLDER_CANNOT_BE_OWN_DESCENDANT" };
    }

    const initialFolderDoc = await this.getFolderWithAccess(db, folderId);
    if (!initialFolderDoc) return { success: false, error: "NOT_FOUND" };
    const initialSpaceId = this.resolveSpaceId(initialFolderDoc.get("spaceId"));

    return withSpaceMutationLock(db, initialSpaceId, async () => {
      const { folderDoc, spaceId } = await requireLiveFolderDestination(
        db,
        folderId,
        initialSpaceId
      );
      this.assertSpaceUnlocked(spaceId);
      const folder = folderDoc.toMutableJSON();

      if (parentId) {
        const parent = await requireLiveFolderDestination(db, parentId, spaceId);
        this.assertSpaceUnlocked(parent.spaceId);
        const descendantIds = await this.collectDescendantIds(folderId, spaceId);
        if (descendantIds.has(parentId)) {
          return { success: false, error: "FOLDER_CANNOT_BE_OWN_DESCENDANT" };
        }
      }

      if (folder.parentId === parentId) return { success: true };

      const patch: Partial<FolderDocType> = {
        parentId,
        updatedAt: Date.now(),
      };
      const selector = parentId
        ? { parentId: { $eq: parentId }, spaceId: { $eq: spaceId }, deletedAt: { $eq: 0 } }
        : { parentId: { $eq: null }, spaceId: { $eq: spaceId }, deletedAt: { $eq: 0 } };
      const siblings = await db.folders.find({ selector }).exec();
      patch.sortOrder =
        siblings.reduce((max, doc) => {
          const order = doc.get("sortOrder") ?? 0;
          return Math.max(max, order);
        }, 0) + 1;

      await folderDoc.incrementalPatch(patch);
      try {
        chrome.runtime.sendMessage({ type: "DB_CHANGE", scope: "folders" });
      } catch {}
      return { success: true };
    });
  }

  /**
   * Merge one tab group into another — the canonical "drop a tab group onto
   * another tab group" behaviour (see docs/drag-and-drop.md):
   *   - every tab in the source group moves into the target group (folderId +
   *     spaceId updated, appended after the target's existing tabs),
   *   - any sub-groups of the source are re-parented to the target so nothing
   *     is orphaned,
   *   - the now-empty source group is deleted.
   * Merging is destructive (the source group disappears) so callers confirm
   * first. Locked source groups are refused.
   */
  async mergeInto(payload: {
    sourceFolderId: string;
    targetFolderId: string;
  }): Promise<{ success: boolean; movedItems: number; error?: string }> {
    const db = await this.getDatabase();
    const sourceId = (payload.sourceFolderId || "").trim();
    const targetId = (payload.targetFolderId || "").trim();
    if (!sourceId || !targetId || sourceId === targetId) {
      return { success: false, movedItems: 0, error: "INVALID_MERGE" };
    }
    const initialSource = await this.getFolderWithAccess(db, sourceId);
    const initialTarget = await this.getFolderWithAccess(db, targetId);
    if (!initialSource || !initialTarget) {
      return { success: false, movedItems: 0, error: "NOT_FOUND" };
    }
    const sourceSpaceId = this.resolveSpaceId(initialSource.get("spaceId"));
    const targetSpaceId = this.resolveSpaceId(initialTarget.get("spaceId"));

    return withSpaceMutationLocks(db, [sourceSpaceId, targetSpaceId], async () => {
      const source = await requireLiveFolderDestination(db, sourceId, sourceSpaceId);
      const target = await requireLiveFolderDestination(db, targetId, targetSpaceId);
      this.assertSpaceUnlocked(source.spaceId);
      this.assertSpaceUnlocked(target.spaceId);
      if (source.spaceId !== target.spaceId) {
        return {
          success: false,
          movedItems: 0,
          error: "CROSS_SPACE_MERGE_NOT_ALLOWED",
        };
      }
      if (source.folderDoc.get("isLocked") === true) {
        return { success: false, movedItems: 0, error: "LOCKED" };
      }

      const now = Date.now();
      const targetItems = await db.items
        .find({ selector: { folderId: { $eq: targetId }, deletedAt: { $eq: 0 } } })
        .exec();
      let nextOrder =
        targetItems.reduce(
          (max, doc) =>
            Math.max(max, doc.get("chunkOrder") ?? -1),
          -1
        ) + 1;

      const sourceItems = await db.items
        .find({ selector: { folderId: { $eq: sourceId }, deletedAt: { $eq: 0 } } })
        .exec();
      for (const doc of sourceItems) {
        await doc.incrementalPatch({
          folderId: targetId,
          spaceId: target.spaceId,
          chunkOrder: nextOrder++,
          updatedAt: now,
        });
      }
      const movedItems = sourceItems.length;

      const childFolders = await db.folders
        .find({ selector: { parentId: { $eq: sourceId }, deletedAt: { $eq: 0 } } })
        .exec();
      for (const child of childFolders) {
        await child.incrementalPatch({
          parentId: targetId,
          spaceId: target.spaceId,
          updatedAt: now,
        });
      }

      await source.folderDoc.remove();
      try {
        chrome.runtime.sendMessage({ type: "DB_CHANGE", scope: "items" });
      } catch {}
      try {
        chrome.runtime.sendMessage({ type: "DB_CHANGE", scope: "folders" });
      } catch {}

      return { success: true, movedItems };
    });
  }

  private async collectDescendantIds(folderId: string, spaceId: string): Promise<Set<string>> {
    const db = await this.getDatabase();
    const all = await db.folders
      .find({ selector: { spaceId: { $eq: spaceId } } })
      .exec();
    const childrenByParent = new Map<string, string[]>();
    for (const doc of all) {
      const parentId = doc.get("parentId") || null;
      if (!parentId) continue;
      const list = childrenByParent.get(parentId) || [];
      list.push(doc.primary);
      childrenByParent.set(parentId, list);
    }
    const visited = new Set<string>();
    const stack = [folderId];
    while (stack.length > 0) {
      const id = stack.pop();
      if (!id) continue;
      if (visited.has(id)) continue;
      visited.add(id);
      for (const childId of childrenByParent.get(id) || []) {
        if (!visited.has(childId)) stack.push(childId);
      }
    }
    return visited;
  }

  async moveToSpace(payload: {
    folderId: string;
    targetSpaceId: string;
  }): Promise<{ success: boolean; movedItems: number }> {
    const db = await this.getDatabase();
    const folderId = (payload.folderId || "").trim();
    const targetSpaceId = (payload.targetSpaceId || "").trim();
    if (!folderId || !targetSpaceId) {
      return { success: false, movedItems: 0 };
    }

    const initialFolder = await this.getFolderWithAccess(db, folderId);
    if (!initialFolder) return { success: false, movedItems: 0 };
    const sourceSpaceId = this.resolveSpaceId(initialFolder.get("spaceId"));
    return withSpaceMutationLocks(db, [sourceSpaceId, targetSpaceId], async () => {
      const source = await requireLiveFolderDestination(db, folderId, sourceSpaceId);
      await requireLiveSpaceDestination(db, targetSpaceId);
      this.assertSpaceUnlocked(source.spaceId);
      this.assertSpaceUnlocked(targetSpaceId);
      if (source.spaceId === targetSpaceId) {
        return { success: true, movedItems: 0 };
      }

      const sourceFolderDocs = await db.folders
        .find({ selector: { spaceId: { $in: [sourceSpaceId, targetSpaceId] } } })
        .exec();
      const sourceFolders = sourceFolderDocs.map((doc) => doc.toMutableJSON());
      const treeIds = collectFolderTreeIds(sourceFolders, folderId);
      const treeDocs = sourceFolderDocs.filter((doc) => treeIds.has(doc.primary));
      if (treeDocs.some((doc) => doc.get("deletedAt") !== 0)) {
        throw new Error("SOURCE_FOLDER_TREE_NOT_LIVE");
      }

      const targetFolders = await db.folders
        .find({ selector: { spaceId: { $eq: targetSpaceId }, deletedAt: { $eq: 0 } } })
        .exec();
      const maxSortOrder = targetFolders.reduce((max, doc) => {
        if (treeIds.has(doc.primary)) return max;
        const sortOrder = doc.get("sortOrder") ?? 0;
        return Math.max(max, sortOrder);
      }, 0);
      const now = Date.now();
      let movedItems = 0;
      await forEachIdKeysetPage({
        collection: db.items,
        selector: { folderId: { $in: Array.from(treeIds) } },
        pageSize: FOLDER_ITEM_PAGE_SIZE,
        onPage: async (candidates) => {
          for (const candidate of candidates) {
            const itemId = candidate.primary;
            await withEntityMutationLock(db, "item", itemId, async () => {
              const itemDoc = await db.items.findOne(itemId).exec();
              if (!itemDoc) return;
              const currentFolderId = itemDoc.get("folderId");
              if (!currentFolderId || !treeIds.has(currentFolderId)) return;
              await itemDoc.incrementalPatch({
                spaceId: targetSpaceId,
                updatedAt: now,
              });
              movedItems += 1;
            });
          }
        },
      });

      // Items move first and the root folder moves last. If any write fails,
      // the root remains in the source space, so retrying can rediscover the
      // complete tree (including descendants already patched to the target).
      const orderedTreeDocs = [...treeDocs].sort((left, right) => {
        if (left.primary === folderId) return 1;
        if (right.primary === folderId) return -1;
        return 0;
      });
      for (const doc of orderedTreeDocs) {
        await doc.incrementalPatch({
          spaceId: targetSpaceId,
          parentId: doc.primary === folderId ? null : doc.get("parentId"),
          sortOrder: doc.primary === folderId ? maxSortOrder + 1 : doc.get("sortOrder"),
          updatedAt: now,
        });
      }

      try {
        chrome.runtime.sendMessage({ type: "DB_CHANGE", scope: "folders" });
      } catch {}
      try {
        chrome.runtime.sendMessage({ type: "DB_CHANGE", scope: "items" });
      } catch {}
      return { success: true, movedItems };
    });
  }

  async copyToSpace(payload: {
    folderId: string;
    targetSpaceId: string;
    name?: string;
  }): Promise<{ success: boolean; folderId?: string; copiedItems: number }> {
    const db = await this.getDatabase();
    const folderId = (payload.folderId || "").trim();
    const targetSpaceId = (payload.targetSpaceId || "").trim();
    if (!folderId || !targetSpaceId) {
      return { success: false, copiedItems: 0 };
    }

    const initialSourceFolder = await this.getFolderWithAccess(db, folderId);
    if (!initialSourceFolder) return { success: false, copiedItems: 0 };
    const sourceSpaceId = this.resolveSpaceId(initialSourceFolder.get("spaceId"));
    return withSpaceMutationLocks(db, [sourceSpaceId, targetSpaceId], async () => {
      const source = await requireLiveFolderDestination(db, folderId, sourceSpaceId);
      await requireLiveSpaceDestination(db, targetSpaceId);
      this.assertSpaceUnlocked(source.spaceId);
      this.assertSpaceUnlocked(targetSpaceId);
      const sourceFolder = source.folderDoc.toMutableJSON();

      const sourceFolderDocs = await db.folders
        .find({ selector: { spaceId: { $eq: sourceSpaceId } } })
        .exec();
      const sourceFolders = sourceFolderDocs.map((doc) => doc.toMutableJSON());
      const treeIds = collectFolderTreeIds(sourceFolders, folderId);
      const treeFolders = sourceFolders.filter((folder) => treeIds.has(folder.id));
      if (treeFolders.some((folder) => folder.deletedAt !== 0)) {
        throw new Error("SOURCE_FOLDER_TREE_NOT_LIVE");
      }

      const now = Date.now();
      const targetFolders = await db.folders
        .find({ selector: { spaceId: { $eq: targetSpaceId }, deletedAt: { $eq: 0 } } })
        .exec();
      const existingNames = new Set(
        targetFolders.map((doc) => (doc.get("name") || "").toLowerCase())
      );
      const baseName =
        (payload.name || sourceFolder.name || "Untitled").trim().slice(0, 80) ||
        "Untitled";
      let nextName = baseName;
      if (existingNames.has(nextName.toLowerCase())) {
        let index = 2;
        while (existingNames.has(`${baseName} (copy ${index})`.toLowerCase())) index += 1;
        nextName = `${baseName} (copy ${index})`;
      }
      const maxSortOrder = targetFolders.reduce((max, doc) => {
        const sortOrder = doc.get("sortOrder") ?? 0;
        return Math.max(max, sortOrder);
      }, 0);

      const folderIdMap = new Map(treeFolders.map((folder) => [folder.id, uuidv4()]));
      const copiedFolderId = (sourceId: string): string => {
        const copiedId = folderIdMap.get(sourceId);
        if (!copiedId) throw new Error(`FOLDER_COPY_MAPPING_MISSING:${sourceId}`);
        return copiedId;
      };
      const clonedFolders = treeFolders.map((folder) => ({
        ...folder,
        id: copiedFolderId(folder.id),
        name: folder.id === folderId ? nextName : folder.name,
        userId: this.normalizeUserId(folder.userId),
        spaceId: targetSpaceId,
        parentId:
          folder.id === folderId
            ? null
            : folder.parentId
              ? copiedFolderId(folder.parentId)
              : null,
        sortOrder: folder.id === folderId ? maxSortOrder + 1 : folder.sortOrder,
        deletedAt: 0,
        purgeAt: 0,
        isDirty: false,
        serverVersion: 0,
        createdAt: now,
        updatedAt: now,
      })) satisfies FolderDocType[];
      const folderInsert = await db.folders.bulkInsert(clonedFolders);
      if (folderInsert.error.length > 0) {
        throw new Error(`Failed to copy ${folderInsert.error.length} folders.`);
      }

      const sourceItemDocs = await db.items
        .find({
          selector: {
            folderId: { $in: Array.from(treeIds) },
            deletedAt: { $eq: 0 },
          },
        })
        .exec();
      const sourceItems = sourceItemDocs.map((doc) => doc.toMutableJSON());
      const itemIdMap = new Map(sourceItems.map((item) => [item.id, uuidv4()]));
      const copiedItemId = (sourceId: string): string => {
        const copiedId = itemIdMap.get(sourceId);
        if (!copiedId) throw new Error(`ITEM_COPY_MAPPING_MISSING:${sourceId}`);
        return copiedId;
      };
      const clonedItems: ItemDocType[] = [];
      const cloneIds = Array.from(itemIdMap.values());
      try {
        await withOpfsMutationLock(async () => {
          for (let index = 0; index < sourceItems.length; index += 1) {
            const item = sourceItems[index];
            const cloneId = copiedItemId(item.id);
            const cloneMedia =
              this.options.cloneOpfsMediaEntriesForItem || cloneOpfsMediaEntriesForItem;
            const clonedMedia = await cloneMedia(item.media, cloneId);
            clonedItems.push({
              ...item,
              id: cloneId,
              userId: this.normalizeUserId(item.userId),
              folderId: copiedFolderId(item.folderId),
              spaceId: targetSpaceId,
              parentId: item.parentId ? itemIdMap.get(item.parentId) || null : null,
              media: clonedMedia.media,
              displayImageUrl:
                clonedMedia.pathMap.get(item.displayImageUrl || "") || item.displayImageUrl,
              vector_index: -1,
              vector_indexes: [],
              isEmbedded: false,
              isDirty: true,
              serverVersion: 0,
              createdAt: now + index,
              updatedAt: now + index,
              deletedAt: 0,
            });
          }
          if (clonedItems.length > 0) {
            const itemInsert = await db.items.bulkInsert(clonedItems);
            if (itemInsert.error.length > 0) {
              throw new Error(`Failed to copy ${itemInsert.error.length} items.`);
            }
          }
        });
      } catch (error) {
        await deleteUnreferencedOpfsItemDirectories(db, cloneIds).catch(() => {});
        throw error;
      }

      try {
        chrome.runtime.sendMessage({ type: "DB_CHANGE", scope: "folders" });
      } catch {}
      try {
        chrome.runtime.sendMessage({ type: "DB_CHANGE", scope: "items" });
      } catch {}

      return {
        success: true,
        folderId: folderIdMap.get(folderId),
        copiedItems: clonedItems.length,
      };
    });
  }
}

export const foldersController = new FoldersController();
