import { normalizeSpaceName, slugifySpaceName } from "@src/common/spaces";
import { UNGROUPED_SPACE_GROUP_ID } from "@src/schemas/space_schema";
import type { SpaceDocType } from "@src/schemas/space_schema";
import type { SpaceGroupDocType } from "@src/schemas/space_group_schema";
import { getDb } from "@src/services/DatabaseService";
import { appendUnorderedIds } from "@src/utils/ordered-ids";
import { spacesController } from "@src/services/controllers/spaces.controller";

const buildId = (prefix: string) => `${prefix}_${crypto.randomUUID()}`;

export type SpaceGroupListItem = SpaceGroupDocType;

export type SpaceGroupsControllerOptions = {
  getDb?: typeof getDb;
  moveSpaceToBin?: typeof spacesController.moveToBin;
};

export class SpaceGroupsController {

  constructor(private readonly options: SpaceGroupsControllerOptions = {}) {}

  private getDatabase(): ReturnType<typeof getDb> {
    return (this.options.getDb ?? getDb)();
  }

  private moveSpaceToBin(payload: { id: string }): ReturnType<typeof spacesController.moveToBin> {
    return this.options.moveSpaceToBin
      ? this.options.moveSpaceToBin(payload)
      : spacesController.moveToBin(payload);
  }

  private collectSpaceGroupTreeIds(groups: SpaceGroupDocType[], rootId: string): Set<string> {
    const ids = new Set<string>([rootId]);
    let changed = true;
    while (changed) {
      changed = false;
      for (const group of groups) {
        const parentId = group.parentGroupId || null;
        if (parentId && ids.has(parentId) && !ids.has(group.id)) {
          ids.add(group.id);
          changed = true;
        }
      }
    }
    return ids;
  }

  async listSpaceGroups(): Promise<SpaceGroupListItem[]> {
    const db = await this.getDatabase();
    const docs = await db.space_groups.find().exec();
    return docs
      .map((doc) => doc.toMutableJSON())
      .sort((left, right) => left.sortOrder - right.sortOrder || left.createdAt - right.createdAt);
  }

  async createSpaceGroup(payload: { name: string }): Promise<SpaceGroupDocType> {
    const db = await this.getDatabase();
    const name = normalizeSpaceName(payload.name || "");
    if (!name) throw new Error("SPACE_GROUP_NAME_REQUIRED");

    const existing = await this.listSpaceGroups();
    if (existing.some((group) => group.name.toLowerCase() === name.toLowerCase())) {
      throw new Error("SPACE_GROUP_NAME_EXISTS");
    }

    const now = Date.now();
    const group: SpaceGroupDocType = {
      id: buildId("space_group"),
      name,
      sortOrder: existing.reduce((max, value) => Math.max(max, value.sortOrder), -1) + 1,
      isCollapsed: false,
      createdAt: now,
      updatedAt: now,
    };
    await db.space_groups.insert(group);
    this.notifyChanged();
    return group;
  }

  async renameSpaceGroup(payload: { id: string; name: string }): Promise<{ success: boolean }> {
    const db = await this.getDatabase();
    const doc = await db.space_groups.findOne(payload.id).exec();
    if (!doc) return { success: false };
    const name = normalizeSpaceName(payload.name || "");
    if (!name) throw new Error("SPACE_GROUP_NAME_REQUIRED");

    const existing = await this.listSpaceGroups();
    if (existing.some((group) => group.id !== payload.id && group.name.toLowerCase() === name.toLowerCase())) {
      throw new Error("SPACE_GROUP_NAME_EXISTS");
    }
    await doc.patch({ name, updatedAt: Date.now() });
    this.notifyChanged();
    return { success: true };
  }

  async setCollapsed(payload: { id: string; value: boolean }): Promise<{ success: boolean }> {
    const db = await this.getDatabase();
    const doc = await db.space_groups.findOne(payload.id).exec();
    if (!doc) return { success: false };
    await doc.patch({ isCollapsed: payload.value, updatedAt: Date.now() });
    return { success: true };
  }

  async resolveDropSpace(payload: { spaceGroupId: string }): Promise<SpaceDocType> {
    const db = await this.getDatabase();
    const group = await db.space_groups.findOne(payload.spaceGroupId).exec();
    if (!group) throw new Error("SPACE_GROUP_NOT_FOUND");

    const spaces = await db.spaces
      .find({
        selector: {
          spaceGroupId: { $eq: payload.spaceGroupId },
          isArchived: { $eq: false },
          deletedAt: { $eq: 0 },
        },
      })
      .exec();
    const firstSpace = spaces
      .map((doc) => doc.toMutableJSON())
      .filter((space) => space.deletedAt === 0 && space.isArchived === false)
      .sort((left, right) => left.sortOrder - right.sortOrder || left.createdAt - right.createdAt)[0];
    if (firstSpace) return firstSpace;

    const now = Date.now();
    const groupName = group.toMutableJSON().name;
    const space: SpaceDocType = {
      id: buildId("space"),
      name: `${groupName} inbox`.slice(0, 80),
      slug: slugifySpaceName(`${groupName} inbox`) || `space-${now}`,
      spaceGroupId: payload.spaceGroupId,
      isPrivate: false,
      autoLockMs: 5 * 60 * 1000,
      sortOrder: 0,
      deletedAt: 0,
      purgeAt: 0,
      isArchived: false,
      createdAt: now,
      updatedAt: now,
    };
    await db.spaces.insert(space);
    this.notifyChanged();
    return space;
  }

  private notifyChanged(): void {
    try {
      chrome.runtime.sendMessage({ type: "DB_CHANGE", scope: "space_groups" });
    } catch {}
  }

  async deleteSpaceGroup(payload: {
    id: string;
    mode?: "moveToUngrouped" | "deleteContents";
  }): Promise<{ success: boolean; affectedSpaces: number }> {
    const db = await this.getDatabase();
    const id = (payload.id || "").trim();
    const mode = payload.mode || "deleteContents";
    if (!id) return { success: false, affectedSpaces: 0 };
    const groupDoc = await db.space_groups.findOne(id).exec();
    if (!groupDoc) return { success: false, affectedSpaces: 0 };

    const groupDocs = await db.space_groups.find().exec();
    const groups = groupDocs.map((doc) => doc.toMutableJSON());
    const targetGroupIds = this.collectSpaceGroupTreeIds(groups, id);
    const children = await db.spaces
      .find({ selector: { spaceGroupId: { $in: Array.from(targetGroupIds) } } })
      .exec();
    const affectedSpaces = children.length;
    const now = Date.now();

    if (mode === "deleteContents") {
      for (const child of children) {
        const spaceId = child.primary;
        try {
          await this.moveSpaceToBin({ id: spaceId });
          await child.patch({ spaceGroupId: UNGROUPED_SPACE_GROUP_ID, updatedAt: now });
        } catch (childError) {
          console.error("[SpaceGroups] failed to move group child to bin", childError);
        }
      }
    } else {
      for (const child of children) {
        await child.patch({ spaceGroupId: UNGROUPED_SPACE_GROUP_ID, updatedAt: now });
      }
      try {
        chrome.runtime.sendMessage({ type: "DB_CHANGE", scope: "spaces" });
      } catch {}
    }

    for (const doc of groupDocs) {
      if (targetGroupIds.has(doc.primary)) {
        await doc.remove();
      }
    }
    try {
      chrome.runtime.sendMessage({ type: "DB_CHANGE", scope: "spaces" });
    } catch {}
    this.notifyChanged();
    return { success: true, affectedSpaces };
  }

  async reorderSpaceGroups(payload: { orderedIds: string[] }): Promise<{ success: boolean }> {
    const db = await this.getDatabase();
    const docs = await db.space_groups.find().exec();
    const allIds = docs.map((doc) => doc.primary);
    const provided = (payload.orderedIds || []).filter((id) => id && allIds.includes(id));
    const finalOrder = appendUnorderedIds(provided, allIds);
    const now = Date.now();
    for (let i = 0; i < finalOrder.length; i += 1) {
      const id = finalOrder[i];
      const doc = await db.space_groups.findOne(id).exec();
      if (!doc) continue;
      const currentOrder = doc.toMutableJSON().sortOrder;
      if (currentOrder !== i) {
        await doc.patch({ sortOrder: i, updatedAt: now });
      }
    }
    this.notifyChanged();
    return { success: true };
  }
}

export const spaceGroupsController = new SpaceGroupsController();
