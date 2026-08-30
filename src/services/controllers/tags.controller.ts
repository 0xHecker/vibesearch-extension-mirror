import { getDb } from "@src/services/DatabaseService";
import { v4 as uuidv4 } from "uuid";
import type { TagDocType } from "@src/schemas/tag_schema";
import { PRIVATE_SPACE_ID, PUBLIC_SPACE_ID } from "@src/common/spaces";
import { spaceSessionService } from "@src/services/space-session.service";

type SearchScope = "current" | "global" | "private" | "public";
type AccessContext = {
  activeSpaceId?: string;
  searchScope?: SearchScope;
};

export class TagsController {
  [key: string]: any;

  private normalizeName(name: string): string {
    return name.trim().slice(0, 100);
  }

  private assertSpaceUnlocked(spaceId: string): void {
    if (spaceId === PRIVATE_SPACE_ID && !spaceSessionService.isUnlocked(PRIVATE_SPACE_ID)) {
      throw new Error("PRIVATE_SPACE_LOCKED");
    }
  }

  private async resolveAllowedSpaceIds(
    db: any,
    accessContext?: AccessContext
  ): Promise<string[]> {
    const activeSpaceId = accessContext?.activeSpaceId || PUBLIC_SPACE_ID;
    const requestedScope = accessContext?.searchScope || "global";
    const privateUnlocked = spaceSessionService.isUnlocked(PRIVATE_SPACE_ID);

    const spaceDocs = await db.spaces
      .find({ selector: { isArchived: { $eq: false }, deletedAt: { $eq: 0 } } })
      .exec();
    const spaces = spaceDocs.map((doc: any) => doc.toMutableJSON() as any);
    const allSpaceIds = spaces.map((space: any) => space.id as string);
    const nonPrivateSpaceIds = spaces
      .filter((space: any) => !space.isPrivate)
      .map((space: any) => space.id as string);
    const hasActiveSpace = spaces.some((space: any) => space.id === activeSpaceId);
    const safeActiveSpaceId = hasActiveSpace ? activeSpaceId : PUBLIC_SPACE_ID;
    const fallbackPublic = nonPrivateSpaceIds.length > 0 ? nonPrivateSpaceIds : [PUBLIC_SPACE_ID];
    const fallbackAll = allSpaceIds.length > 0 ? allSpaceIds : fallbackPublic;

    if (requestedScope === "global") {
      return privateUnlocked ? fallbackAll : fallbackPublic;
    }
    if (requestedScope === "public") {
      return fallbackPublic;
    }
    if (requestedScope === "private") {
      return privateUnlocked ? [PRIVATE_SPACE_ID] : [];
    }
    if (safeActiveSpaceId === PRIVATE_SPACE_ID) {
      return privateUnlocked ? [PRIVATE_SPACE_ID] : [];
    }
    return [safeActiveSpaceId];
  }

  private async getAccessibleItem(db: any, itemId: string): Promise<any | null> {
    const itemDoc = await db.items.findOne(itemId).exec();
    if (!itemDoc) return null;
    const item = itemDoc.toMutableJSON() as any;
    const spaceId = (item.spaceId as string | undefined) || PUBLIC_SPACE_ID;
    this.assertSpaceUnlocked(spaceId);
    return itemDoc;
  }

  private async findVisibleItemIds(
    db: any,
    itemIds: string[],
    allowedSpaceIds: string[]
  ): Promise<Set<string>> {
    const visible = new Set<string>();
    if (itemIds.length === 0 || allowedSpaceIds.length === 0) return visible;

    const uniqueIds = Array.from(new Set(itemIds.filter(Boolean)));
    const chunkSize = 600;
    for (let i = 0; i < uniqueIds.length; i += chunkSize) {
      const chunk = uniqueIds.slice(i, i + chunkSize);
      const docs = await db.items
        .find({
          selector: {
            id: { $in: chunk },
            deletedAt: { $eq: 0 },
            spaceId: { $in: allowedSpaceIds },
          },
        })
        .exec();
      for (const doc of docs) {
        const id = doc.get("id") as string;
        if (id) visible.add(id);
      }
    }
    return visible;
  }

  private async collectVisibleTagIds(
    db: any,
    candidateTagIds: string[],
    allowedSpaceIds: string[]
  ): Promise<Set<string>> {
    const visibleTagIds = new Set<string>();
    if (candidateTagIds.length === 0 || allowedSpaceIds.length === 0) return visibleTagIds;

    const joins = await db.item_tags.find({ selector: { tagId: { $in: candidateTagIds } } }).exec();
    if (joins.length === 0) return visibleTagIds;

    const joinPairs = joins.map((join: any) => ({
      itemId: join.get("itemId") as string,
      tagId: join.get("tagId") as string,
    }));
    const itemIds = joinPairs.map((pair: { itemId: string; tagId: string }) => pair.itemId).filter(Boolean);
    const visibleItemIds = await this.findVisibleItemIds(db, itemIds, allowedSpaceIds);
    if (visibleItemIds.size === 0) return visibleTagIds;

    for (const pair of joinPairs) {
      if (visibleItemIds.has(pair.itemId)) {
        visibleTagIds.add(pair.tagId);
      }
    }

    return visibleTagIds;
  }

  async getTagsForItem(payload: { itemId: string }): Promise<TagDocType[]> {
    const db = await getDb();
    const itemDoc = await this.getAccessibleItem(db, payload.itemId);
    if (!itemDoc) return [];
    const joins = await db.item_tags.find({ selector: { itemId: { $eq: payload.itemId } } }).exec();
    if (joins.length === 0) return [];
    const tagIds = joins.map((j) => j.get("tagId") as string);
    const tags = await db.tags.find({ selector: { id: { $in: tagIds } } }).exec();
    return tags.map((t) => t.toMutableJSON());
  }

  async searchTags(payload: {
    query: string;
    limit?: number;
    accessContext?: AccessContext;
  }): Promise<TagDocType[]> {
    const db = await getDb();
    const q = (payload.query ?? "").trim().toLowerCase();
    const limit = Math.max(1, Math.min(payload.limit ?? 50, 100));
    const allowedSpaceIds = await this.resolveAllowedSpaceIds(db, payload.accessContext);
    if (allowedSpaceIds.length === 0) return [];

    const allTags = (await db.tags.find({ selector: {} }).exec()).map((tag) =>
      tag.toMutableJSON() as TagDocType
    );
    if (allTags.length === 0) return [];

    const sortByRecency = (a: TagDocType, b: TagDocType) => (b.updatedAt || 0) - (a.updatedAt || 0);
    const startsWithScore = (tag: TagDocType) => {
      const lower = (tag.name || "").toLowerCase();
      if (!q) return 0;
      return lower.startsWith(q) ? 1 : 0;
    };

    let candidates = allTags;
    if (q) {
      candidates = candidates.filter((tag) => (tag.name || "").toLowerCase().includes(q));
      candidates.sort((a, b) => {
        const byPrefix = startsWithScore(b) - startsWithScore(a);
        if (byPrefix !== 0) return byPrefix;
        return sortByRecency(a, b);
      });
      candidates = candidates.slice(0, Math.max(limit * 8, 200));
      if (candidates.length === 0) return [];
      const visibleTagIds = await this.collectVisibleTagIds(
        db,
        candidates.map((tag) => tag.id),
        allowedSpaceIds
      );
      return candidates.filter((tag) => visibleTagIds.has(tag.id)).slice(0, limit);
    }

    candidates = [...candidates].sort(sortByRecency);
    const results: TagDocType[] = [];
    const batchSize = 120;
    for (let i = 0; i < candidates.length && results.length < limit; i += batchSize) {
      const batch = candidates.slice(i, i + batchSize);
      const visibleTagIds = await this.collectVisibleTagIds(
        db,
        batch.map((tag) => tag.id),
        allowedSpaceIds
      );
      for (const tag of batch) {
        if (visibleTagIds.has(tag.id)) {
          results.push(tag);
          if (results.length >= limit) break;
        }
      }
    }

    return results;
  }

  async addTagToItem(payload: {
    itemId: string;
    tagName: string;
    userId?: string;
  }): Promise<{ tags: TagDocType[] }> {
    const db = await getDb();
    const itemDoc = await this.getAccessibleItem(db, payload.itemId);
    if (!itemDoc) {
      throw new Error("ITEM_NOT_FOUND");
    }
    const name = this.normalizeName(payload.tagName);
    if (!name) return { tags: [] };
    const userId = payload.userId || "user1"; // Use default user ID instead of null

    // find or create tag by name + userId
    let tag = await db.tags
      .findOne({ selector: { name: { $eq: name }, userId: { $eq: userId } } })
      .exec();
    if (!tag) {
      const now = Date.now();
      const newTag: TagDocType = {
        id: uuidv4(),
        name,
        userId,
        isDirty: true,
        serverVersion: 0,
        createdAt: now,
        updatedAt: now,
      };
      await db.tags.insert(newTag as any);
      tag = await db.tags.findOne(newTag.id).exec();
    }
    if (!tag) return { tags: [] };

    const tagId = tag.get("id") as string;
    const joinId = `${payload.itemId}|${tagId}`;
    const existingJoin = await db.item_tags.findOne(joinId).exec();
    if (!existingJoin) {
      const now = Date.now();
      await db.item_tags.insert({
        id: joinId,
        itemId: payload.itemId,
        tagId,
        userId,
        createdAt: now,
        updatedAt: now,
        deletedAt: 0,
      } as any);
    }

    // Update the tag's updatedAt to track recent usage (LRU)
    try {
      await tag.patch({ updatedAt: Date.now() });
    } catch {}

    try {
      chrome.runtime.sendMessage({ type: "DB_CHANGE", scope: "items" });
    } catch {}

    const tags = await this.getTagsForItem({ itemId: payload.itemId });
    return { tags };
  }

  async removeTagFromItem(payload: {
    itemId: string;
    tagId: string;
  }): Promise<{ tags: TagDocType[] }> {
    const db = await getDb();
    const itemDoc = await this.getAccessibleItem(db, payload.itemId);
    if (!itemDoc) {
      throw new Error("ITEM_NOT_FOUND");
    }
    const joinId = `${payload.itemId}|${payload.tagId}`;
    const joinDoc = await db.item_tags.findOne(joinId).exec();
    if (joinDoc) {
      await joinDoc.remove();
    }
    try {
      chrome.runtime.sendMessage({ type: "DB_CHANGE", scope: "items" });
    } catch {}
    const tags = await this.getTagsForItem({ itemId: payload.itemId });
    return { tags };
  }

  private notifyTagsChanged(): void {
    try {
      chrome.runtime.sendMessage({ type: "DB_CHANGE", scope: "items" });
    } catch {}
  }

  /** All tags with a live (non-deleted) tab count, for the Tags manager. */
  async listAllTags(): Promise<Array<TagDocType & { tabCount: number }>> {
    const db = await getDb();
    const tagDocs = await db.tags.find({ selector: {} }).exec();
    const tags = tagDocs.map((doc: any) => doc.toMutableJSON() as TagDocType);
    if (tags.length === 0) return [];

    const joins = await db.item_tags.find({ selector: {} }).exec();
    const itemIdsByTag = new Map<string, Set<string>>();
    const allItemIds = new Set<string>();
    for (const join of joins) {
      const tagId = join.get("tagId") as string;
      const itemId = join.get("itemId") as string;
      if (!tagId || !itemId) continue;
      allItemIds.add(itemId);
      if (!itemIdsByTag.has(tagId)) itemIdsByTag.set(tagId, new Set());
      itemIdsByTag.get(tagId)!.add(itemId);
    }

    const liveItemIds = new Set<string>();
    const ids = Array.from(allItemIds);
    const chunkSize = 600;
    for (let i = 0; i < ids.length; i += chunkSize) {
      const docs = await db.items
        .find({ selector: { id: { $in: ids.slice(i, i + chunkSize) }, deletedAt: { $eq: 0 } } })
        .exec();
      for (const doc of docs) liveItemIds.add(doc.get("id") as string);
    }

    return tags.map((tag) => {
      const set = itemIdsByTag.get(tag.id);
      let tabCount = 0;
      if (set) for (const id of set) if (liveItemIds.has(id)) tabCount += 1;
      return { ...tag, tabCount };
    });
  }

  async createTag(payload: {
    name: string;
    color?: string | null;
    userId?: string;
  }): Promise<TagDocType | null> {
    const db = await getDb();
    const name = this.normalizeName(payload.name);
    if (!name) return null;
    const userId = payload.userId || "user1";
    const existing = await db.tags
      .findOne({ selector: { name: { $eq: name }, userId: { $eq: userId } } })
      .exec();
    if (existing) return existing.toMutableJSON();
    const now = Date.now();
    const newTag: TagDocType = {
      id: uuidv4(),
      name,
      userId,
      isDirty: true,
      serverVersion: 0,
      createdAt: now,
      updatedAt: now,
      color: payload.color ?? null,
      isFavorite: false,
    };
    await db.tags.insert(newTag as any);
    this.notifyTagsChanged();
    return newTag;
  }

  async renameTag(payload: { tagId: string; name: string }): Promise<{ success: boolean }> {
    const db = await getDb();
    const name = this.normalizeName(payload.name);
    if (!name) return { success: false };
    const doc = await db.tags.findOne(payload.tagId).exec();
    if (!doc) return { success: false };
    await doc.incrementalPatch({ name, updatedAt: Date.now(), isDirty: true });
    this.notifyTagsChanged();
    return { success: true };
  }

  async deleteTag(payload: { tagId: string }): Promise<{ success: boolean }> {
    const db = await getDb();
    const doc = await db.tags.findOne(payload.tagId).exec();
    if (!doc) return { success: false };
    const joins = await db.item_tags.find({ selector: { tagId: { $eq: payload.tagId } } }).exec();
    for (const join of joins) await join.remove();
    await doc.remove();
    this.notifyTagsChanged();
    return { success: true };
  }

  async setTagColor(payload: { tagId: string; color: string | null }): Promise<{ success: boolean }> {
    const db = await getDb();
    const doc = await db.tags.findOne(payload.tagId).exec();
    if (!doc) return { success: false };
    await doc.incrementalPatch({ color: payload.color ?? null, updatedAt: Date.now(), isDirty: true });
    this.notifyTagsChanged();
    return { success: true };
  }

  async setTagFavorite(payload: { tagId: string; isFavorite: boolean }): Promise<{ success: boolean }> {
    const db = await getDb();
    const doc = await db.tags.findOne(payload.tagId).exec();
    if (!doc) return { success: false };
    await doc.incrementalPatch({ isFavorite: !!payload.isFavorite, updatedAt: Date.now(), isDirty: true });
    this.notifyTagsChanged();
    return { success: true };
  }
}

export const tagsController = new TagsController();
