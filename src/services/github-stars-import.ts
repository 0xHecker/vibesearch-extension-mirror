import { getDb } from "@src/services/DatabaseService";
import { localSearchIndexService } from "@src/services/local-search-index.service";
import type { FolderDocType } from "@src/schemas/folder_schema";
import type { ItemDocType } from "@src/schemas/item_schema";
import type { SpaceDocType } from "@src/schemas/space_schema";
import type { SpaceGroupDocType } from "@src/schemas/space_group_schema";
import { MAX_BOOKMARKS_PER_SPACE } from "@src/services/browser-bookmark-import";
import { cloudSyncService, type CloudSyncDocBatch } from "@src/services/cloud-sync";

export const GITHUB_STARS_SPACE_GROUP_ID = "space_group_github_stars";
export const GITHUB_STARS_SPACE_GROUP_NAME = "GitHub Stars";

const IMPORT_BATCH_SIZE = 200;

export type GitHubStar = {
  id: string;
  fullName: string;
  url: string;
  description?: string;
  language?: string;
  topics?: string[];
  ownerLogin?: string;
  ownerAvatarUrl?: string;
  stargazerCount?: number;
  starredAt?: number;
  folderName?: string;
};

export type GitHubStarsImportPlan = {
  spaceGroup: SpaceGroupDocType;
  spaces: SpaceDocType[];
  folders: FolderDocType[];
  items: ItemDocType[];
};

export type GitHubStarsImportResult = {
  spaceGroupId: string;
  spaceIds: string[];
  importedCount: number;
  updatedCount: number;
  removedCount: number;
  metadataUrls: string[];
};

const chunk = <T,>(values: T[], size: number): T[][] => {
  const result: T[][] = [];
  for (let start = 0; start < values.length; start += size) result.push(values.slice(start, start + size));
  return result;
};

const yieldToEventLoop = () =>
  new Promise<void>((resolve) => {
    const timer = typeof window !== "undefined" ? window.setTimeout : setTimeout;
    timer(resolve, 0);
  });

const stableHash = (value: string): string => {
  let first = 0x811c9dc5;
  let second = 0x9e3779b9;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    first = Math.imul(first ^ code, 0x01000193);
    second = Math.imul(second ^ code, 0x85ebca6b);
  }
  return `${(first >>> 0).toString(36)}${(second >>> 0).toString(36)}`;
};

const stableId = (kind: "space" | "folder" | "item", sourceId: string) =>
  `github-star-${kind}-${stableHash(sourceId)}`;

const cleanName = (value: string | undefined, fallback: string) =>
  (value || "").trim().replace(/\s+/g, " ").slice(0, 80) || fallback;

const slugify = (value: string, fallback: string) => {
  const slug = value
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, "")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
  return slug || fallback;
};

const normalizeTimestamp = (value: number | undefined, fallback: number) =>
  Number.isFinite(value) ? Math.max(0, Math.floor(value as number)) : fallback;

export const buildGitHubStarsImportPlan = (
  stars: GitHubStar[],
  options?: { now?: number }
): GitHubStarsImportPlan => {
  const now = options?.now ?? Date.now();
  const validStars = stars.filter((star) => star.id && star.url && star.fullName);
  const grouped = new Map<string, GitHubStar[]>();
  for (const star of validStars) {
    const folderName = cleanName(star.folderName, "Starred repositories");
    const current = grouped.get(folderName) || [];
    current.push(star);
    grouped.set(folderName, current);
  }

  const spaceGroup: SpaceGroupDocType = {
    id: GITHUB_STARS_SPACE_GROUP_ID,
    name: GITHUB_STARS_SPACE_GROUP_NAME,
    sortOrder: now,
    isCollapsed: false,
    createdAt: now,
    updatedAt: now,
  };
  const spaces: SpaceDocType[] = [];
  const folders: FolderDocType[] = [];
  const items: ItemDocType[] = [];

  for (const [folderName, entries] of grouped) {
    const parts = chunk(entries, MAX_BOOKMARKS_PER_SPACE);
    for (let partIndex = 0; partIndex < parts.length; partIndex += 1) {
      const part = parts[partIndex];
      const suffix = parts.length > 1 ? ` (${partIndex + 1})` : "";
      const spaceName = `${folderName}${suffix}`.slice(0, 80);
      const spaceId = stableId("space", `${folderName}:${partIndex}`);
      const folderId = stableId("folder", `${folderName}:${partIndex}`);
      spaces.push({
        id: spaceId,
        name: spaceName,
        slug: slugify(spaceName, `github-stars-${partIndex + 1}`),
        spaceGroupId: GITHUB_STARS_SPACE_GROUP_ID,
        isPrivate: false,
        autoLockMs: 5 * 60 * 1000,
        sortOrder: spaces.length,
        isArchived: false,
        deletedAt: 0,
        purgeAt: 0,
        createdAt: now,
        updatedAt: now,
      });
      folders.push({
        id: folderId,
        name: spaceName,
        userId: "",
        spaceId,
        parentId: null,
        type: "folder",
        sortOrder: 0,
        isLocked: false,
        isPinned: false,
        isCollapsed: part.length > 300,
        deletedAt: 0,
        purgeAt: 0,
        isDirty: false,
        serverVersion: 0,
        createdAt: now,
        updatedAt: now,
      });
      for (let index = 0; index < part.length; index += 1) {
        const star = part[index];
        const starredAt = normalizeTimestamp(star.starredAt, now);
        const textContent = [star.description, star.language, ...(star.topics || [])]
          .filter((value): value is string => typeof value === "string" && value.trim().length > 0)
          .join("\n")
          .slice(0, 20_000);
        items.push({
          id: stableId("item", star.id),
          userId: "",
          title: star.fullName.slice(0, 500),
          textContent,
          ocrText: "",
          ocrStatus: "skipped",
          ocrModelVersion: "",
          ocrUpdatedAt: 0,
          url: star.url,
          source: "github",
          folderId,
          spaceId,
          isFavorite: false,
          authorUsername: star.ownerLogin,
          likes: Number.isFinite(star.stargazerCount) ? star.stargazerCount : undefined,
          iconUrl: star.ownerAvatarUrl,
          media: [],
          parentId: null,
          chunkOrder: index,
          vector_index: -1,
          vector_indexes: [],
          isEmbedded: false,
          isMetaFetched: false,
          isDirty: false,
          serverVersion: 0,
          createdAt: starredAt,
          updatedAt: starredAt,
          deletedAt: 0,
        });
      }
    }
  }
  return { spaceGroup, spaces, folders, items };
};

const notifyDbChange = (scope: "spaces" | "space_groups" | "folders" | "items") => {
  try {
    chrome.runtime.sendMessage({ type: "DB_CHANGE", scope });
  } catch {}
};

const spaceMatches = (existing: SpaceDocType, candidate: SpaceDocType): boolean =>
  existing.name === candidate.name &&
  existing.slug === candidate.slug &&
  existing.spaceGroupId === candidate.spaceGroupId &&
  existing.isPrivate === candidate.isPrivate &&
  existing.autoLockMs === candidate.autoLockMs &&
  existing.sortOrder === candidate.sortOrder &&
  existing.isArchived === false &&
  existing.deletedAt === 0 &&
  existing.purgeAt === 0;

const folderMatches = (existing: FolderDocType, candidate: FolderDocType): boolean =>
  existing.name === candidate.name &&
  existing.spaceId === candidate.spaceId &&
  existing.parentId === candidate.parentId &&
  existing.sortOrder === candidate.sortOrder &&
  existing.type === candidate.type;

const updateFolder = (existing: FolderDocType | undefined, candidate: FolderDocType, now: number) => {
  if (!existing) return candidate;
  if (folderMatches(existing, candidate)) return null;
  return {
    ...existing,
    name: candidate.name,
    spaceId: candidate.spaceId,
    parentId: candidate.parentId,
    type: candidate.type,
    sortOrder: candidate.sortOrder,
    isDirty: false,
    updatedAt: now,
  } satisfies FolderDocType;
};

const updateItem = (existing: ItemDocType | undefined, candidate: ItemDocType, now: number) => {
  if (!existing) return candidate;
  const contentChanged =
    existing.title !== candidate.title ||
    existing.textContent !== candidate.textContent ||
    existing.url !== candidate.url ||
    existing.folderId !== candidate.folderId ||
    existing.spaceId !== candidate.spaceId ||
    existing.chunkOrder !== candidate.chunkOrder ||
    existing.authorUsername !== candidate.authorUsername ||
    existing.likes !== candidate.likes ||
    existing.iconUrl !== candidate.iconUrl ||
    existing.source !== candidate.source ||
    existing.deletedAt !== 0;
  if (!contentChanged) return null;
  return {
    ...existing,
    title: candidate.title,
    textContent: candidate.textContent,
    url: candidate.url,
    source: "github" as const,
    folderId: candidate.folderId,
    spaceId: candidate.spaceId,
    chunkOrder: candidate.chunkOrder,
    authorUsername: candidate.authorUsername,
    likes: candidate.likes,
    iconUrl: candidate.iconUrl,
    isEmbedded: contentChanged ? false : existing.isEmbedded,
    vector_index: contentChanged ? -1 : existing.vector_index,
    vector_indexes: contentChanged ? [] : existing.vector_indexes,
    isMetaFetched: false,
    isDirty: false,
    deletedAt: 0,
    updatedAt: now,
  } satisfies ItemDocType;
};

type GitHubStarsImportDb = Awaited<ReturnType<typeof getDb>>;

type GitHubStarsCloudSync = Pick<typeof cloudSyncService, "enqueueDocs">;

export type GitHubStarsImportServiceOptions = {
  getDb?: () => Promise<GitHubStarsImportDb>;
  cloudSync?: GitHubStarsCloudSync;
  markSearchDirty?: () => void;
  now?: () => number;
  yieldToEventLoop?: () => Promise<void>;
  notifyDbChange?: (scope: "spaces" | "space_groups" | "folders" | "items") => void;
};

export class GitHubStarsImportService {
  constructor(private readonly options: GitHubStarsImportServiceOptions = {}) {}

  async importStars(payload: { stars?: GitHubStar[] }): Promise<GitHubStarsImportResult> {
    const db = await (this.options.getDb ?? getDb)();
    const now = this.options.now?.() ?? Date.now();
    const sync = this.options.cloudSync ?? cloudSyncService;
    const yieldNow = this.options.yieldToEventLoop ?? yieldToEventLoop;
    const publishDbChange = this.options.notifyDbChange ?? notifyDbChange;
    const plan = buildGitHubStarsImportPlan(Array.isArray(payload.stars) ? payload.stars : [], { now });

    const previousGroup = await db.space_groups.findOne(GITHUB_STARS_SPACE_GROUP_ID).exec();
    const existingGroup = previousGroup?.toMutableJSON() as SpaceGroupDocType | undefined;
    const groupUpdate = !existingGroup
      ? plan.spaceGroup
      : existingGroup.name === GITHUB_STARS_SPACE_GROUP_NAME
        ? null
        : { ...existingGroup, name: GITHUB_STARS_SPACE_GROUP_NAME, updatedAt: now };
    if (groupUpdate) await db.space_groups.bulkUpsert([groupUpdate]);

    const existingSpaceDocs = await db.spaces
      .find({ selector: { spaceGroupId: { $eq: GITHUB_STARS_SPACE_GROUP_ID } } })
      .exec();
    const existingSpaces = new Map(
      existingSpaceDocs.map((doc) => [doc.get("id") as string, doc.toMutableJSON() as SpaceDocType])
    );
    const plannedSpaceIds = new Set(plan.spaces.map((space) => space.id));
    const spaceUpdates = plan.spaces
      .map((space) => {
        const existing = existingSpaces.get(space.id);
        if (!existing) return space;
        if (spaceMatches(existing, space)) return null;
        return {
          ...existing,
          name: space.name,
          slug: space.slug,
          spaceGroupId: space.spaceGroupId,
          isPrivate: space.isPrivate,
          autoLockMs: space.autoLockMs,
          sortOrder: space.sortOrder,
          isArchived: false,
          deletedAt: 0,
          purgeAt: 0,
          updatedAt: now,
        } satisfies SpaceDocType;
      })
      .filter((space): space is SpaceDocType => space !== null);
    const archivedSpaces = Array.from(existingSpaces.values())
      .filter((space) => !plannedSpaceIds.has(space.id) && !space.isArchived)
      .map((space) => ({ ...space, isArchived: true, updatedAt: now }));
    const changedSpaces = [...spaceUpdates, ...archivedSpaces];
    for (const batch of chunk(changedSpaces, IMPORT_BATCH_SIZE)) {
      await db.spaces.bulkUpsert(batch);
      await yieldNow();
    }

    const relevantSpaceIds = Array.from(new Set([...existingSpaces.keys(), ...plannedSpaceIds]));
    const [folderDocs, itemDocs] = relevantSpaceIds.length
      ? await Promise.all([
          db.folders.find({ selector: { spaceId: { $in: relevantSpaceIds } } }).exec(),
          db.items.find({ selector: { spaceId: { $in: relevantSpaceIds } } }).exec(),
        ])
      : [[], []];
    const existingItems = new Map(
      itemDocs.map((doc) => [doc.get("id") as string, doc.toMutableJSON() as ItemDocType])
    );
    const existingFolders = new Map(
      folderDocs.map((doc) => [doc.get("id") as string, doc.toMutableJSON() as FolderDocType])
    );

    const changedFolders: FolderDocType[] = [];
    for (const folderBatch of chunk(plan.folders, IMPORT_BATCH_SIZE)) {
      const updates = folderBatch
        .map((folder) => updateFolder(existingFolders.get(folder.id), folder, now))
        .filter((folder): folder is FolderDocType => folder !== null);
      if (updates.length > 0) {
        await db.folders.bulkUpsert(updates);
        changedFolders.push(...updates);
      }
      await yieldNow();
    }

    const changedItems: ItemDocType[] = [];
    const metadataUrls = new Set<string>();
    for (const batch of chunk(plan.items, IMPORT_BATCH_SIZE)) {
      const updates = batch
        .map((item) => updateItem(existingItems.get(item.id), item, now))
        .filter((item): item is ItemDocType => item !== null);
      if (updates.length > 0) {
        await db.items.bulkUpsert(updates);
        changedItems.push(...updates);
        for (const updated of updates) metadataUrls.add(updated.url);
      }
      await yieldNow();
    }

    const plannedItemIds = new Set(plan.items.map((item) => item.id));
    const removedItems = Array.from(existingItems.values())
      .filter((item) => !plannedItemIds.has(item.id) && item.deletedAt === 0)
      .map((item) => ({ ...item, deletedAt: now, updatedAt: now, isDirty: false }));
    for (const batch of chunk(removedItems, IMPORT_BATCH_SIZE)) {
      await db.items.bulkUpsert(batch);
      await yieldNow();
    }

    const plannedFolderIds = new Set(plan.folders.map((folder) => folder.id));
    const removedFolderIds = folderDocs
      .map((doc) => doc.get("id") as string)
      .filter((id) => !plannedFolderIds.has(id));
    for (const batch of chunk(removedFolderIds, IMPORT_BATCH_SIZE)) {
      await db.folders.bulkRemove(batch);
      await yieldNow();
    }

    const cloudChanges: CloudSyncDocBatch = {
      spaceGroups: groupUpdate ? [groupUpdate] : [],
      spaces: changedSpaces,
      folders: changedFolders,
      items: [...changedItems, ...removedItems],
      deletes: removedFolderIds.map((id) => ({ collection: "folders", id, updatedAt: now, deletedAt: now })),
    };
    const changedCount =
      cloudChanges.spaceGroups!.length +
      cloudChanges.spaces!.length +
      cloudChanges.folders!.length +
      cloudChanges.items!.length +
      cloudChanges.deletes!.length;
    if (changedCount > 0) await sync.enqueueDocs(cloudChanges);

    if (changedItems.length > 0 || removedItems.length > 0) {
      (this.options.markSearchDirty ?? (() => localSearchIndexService.markDirty()))();
    }

    if (groupUpdate) publishDbChange("space_groups");
    if (changedSpaces.length > 0) publishDbChange("spaces");
    if (changedFolders.length > 0 || removedFolderIds.length > 0) publishDbChange("folders");
    if (changedItems.length > 0 || removedItems.length > 0) publishDbChange("items");
    return {
      spaceGroupId: GITHUB_STARS_SPACE_GROUP_ID,
      spaceIds: plan.spaces.map((space) => space.id),
      importedCount: plan.items.length,
      updatedCount: changedItems.length,
      removedCount: removedItems.length,
      metadataUrls: Array.from(metadataUrls),
    };
  }
}

export const githubStarsImportService = new GitHubStarsImportService();
