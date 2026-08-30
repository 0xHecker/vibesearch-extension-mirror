import { describe, expect, test } from "bun:test";
import {
  GITHUB_STARS_SPACE_GROUP_ID,
  GitHubStarsImportService,
  buildGitHubStarsImportPlan,
  type GitHubStar,
} from "../src/services/github-stars-import";
import type { CloudSyncDocBatch } from "../src/services/cloud-sync";

const NOW = 1_764_000_000_000;

type StoredRow = Record<string, unknown>;

const cloneRow = <T extends StoredRow>(row: T): T => ({ ...row });

class FakeCollection {
  readonly rows = new Map<string, StoredRow>();
  readonly upsertBatches: StoredRow[][] = [];
  readonly removedBatches: string[][] = [];
  nextBulkUpsertResult: { success: StoredRow[]; error: unknown[] } | null = null;

  findOne(id: string) {
    return {
      exec: async () => {
        const row = this.rows.get(id);
        return row ? { toMutableJSON: () => cloneRow(row) } : null;
      },
    };
  }

  find(query: { selector?: Record<string, unknown> }) {
    const selector = query.selector ?? {};
    return {
      exec: async () =>
        Array.from(this.rows.values())
          .filter((row) => {
            const spaceGroupId = selector.spaceGroupId as { $eq?: unknown } | undefined;
            if (spaceGroupId && row.spaceGroupId !== spaceGroupId.$eq) return false;
            const spaceId = selector.spaceId as { $in?: unknown } | undefined;
            if (spaceId && (!Array.isArray(spaceId.$in) || !spaceId.$in.includes(row.spaceId))) return false;
            const id = selector.id as { $in?: unknown } | undefined;
            if (id && (!Array.isArray(id.$in) || !id.$in.includes(row.id))) return false;
            return true;
          })
          .map((row) => ({
            get: (key: string) => row[key],
            toMutableJSON: () => cloneRow(row),
          })),
    };
  }

  async bulkUpsert(rows: StoredRow[]) {
    this.upsertBatches.push(rows.map(cloneRow));
    if (this.nextBulkUpsertResult) {
      const result = this.nextBulkUpsertResult;
      this.nextBulkUpsertResult = null;
      return result;
    }
    for (const row of rows) this.rows.set(String(row.id), cloneRow(row));
    return { success: rows.map(cloneRow), error: [] };
  }

  async bulkRemove(ids: string[]) {
    this.removedBatches.push([...ids]);
    for (const id of ids) this.rows.delete(id);
  }

  resetWriteHistory() {
    this.upsertBatches.length = 0;
    this.removedBatches.length = 0;
  }
}

const createFakeGitHubDb = () => {
  const space_groups = new FakeCollection();
  const spaces = new FakeCollection();
  const folders = new FakeCollection();
  const items = new FakeCollection();
  return { space_groups, spaces, folders, items };
};

const createStars = (count: number): GitHubStar[] =>
  Array.from({ length: count }, (_, index) => ({
    id: `repo-${index}`,
    fullName: `owner/repo-${index}`,
    url: `https://github.com/owner/repo-${index}`,
    description: `Repository ${index}`,
    ownerLogin: "owner",
    stargazerCount: index,
    starredAt: NOW + index,
  }));

describe("buildGitHubStarsImportPlan", () => {
  test("keeps GitHub stars in one searchable space group", () => {
    const plan = buildGitHubStarsImportPlan([
      {
        id: "repo-1",
        fullName: "owner/repo",
        url: "https://github.com/owner/repo",
        description: "Useful project",
        language: "TypeScript",
        topics: ["search"],
        ownerLogin: "owner",
        stargazerCount: 42,
      },
    ], { now: 1_764_000_000_000 });

    expect(plan.spaceGroup.id).toBe(GITHUB_STARS_SPACE_GROUP_ID);
    expect(plan.spaces).toHaveLength(1);
    expect(plan.spaces[0].spaceGroupId).toBe(GITHUB_STARS_SPACE_GROUP_ID);
    expect(plan.items[0]).toMatchObject({
      source: "github",
      title: "owner/repo",
      authorUsername: "owner",
      likes: 42,
      isMetaFetched: false,
    });
    expect(plan.items[0].textContent).toContain("Useful project");
  });

  test("splits more than 500 stars into sibling spaces under GitHub Stars", () => {
    const plan = buildGitHubStarsImportPlan(
      Array.from({ length: 801 }, (_, index) => ({
        id: `repo-${index}`,
        fullName: `owner/repo-${index}`,
        url: `https://github.com/owner/repo-${index}`,
      })),
      { now: 1_764_000_000_000 }
    );

    expect(plan.spaces).toHaveLength(2);
    expect(plan.spaces.map((space) => space.spaceGroupId)).toEqual([
      GITHUB_STARS_SPACE_GROUP_ID,
      GITHUB_STARS_SPACE_GROUP_ID,
    ]);
    expect(plan.folders.map((folder) => folder.isCollapsed)).toEqual([true, true]);
    expect(plan.items.filter((item) => item.spaceId === plan.spaces[0].id)).toHaveLength(500);
    expect(plan.items.filter((item) => item.spaceId === plan.spaces[1].id)).toHaveLength(301);
  });

  test("keeps stable item and space identities across syncs so imports merge", () => {
    const stars = [
      { id: "repo-1", fullName: "owner/first", url: "https://github.com/owner/first" },
      { id: "repo-2", fullName: "owner/second", url: "https://github.com/owner/second" },
    ];
    const first = buildGitHubStarsImportPlan(stars, { now: 1_764_000_000_000 });
    const second = buildGitHubStarsImportPlan([...stars].reverse(), { now: 1_765_000_000_000 });

    expect(second.items.map((item) => item.id).sort()).toEqual(first.items.map((item) => item.id).sort());
    expect(second.spaces.map((space) => space.id)).toEqual(first.spaces.map((space) => space.id));
    expect(second.folders.map((folder) => folder.id)).toEqual(first.folders.map((folder) => folder.id));
  });

  test("reconciles 10,000 GitHub stars without requeueing already fetched records", async () => {
    const db = createFakeGitHubDb();
    const enqueued: CloudSyncDocBatch[] = [];
    let now = NOW + 100_000;
    const service = new GitHubStarsImportService({
      getDb: async () => db as never,
      cloudSync: {
        enqueueDocs: async (batch) => {
          enqueued.push(batch);
          return { queued: 0, added: 0 };
        },
      } as never,
      markSearchDirty: () => {},
      now: () => now,
      yieldToEventLoop: async () => {},
      notifyDbChange: () => {},
    });
    const stars = createStars(10_000);

    const initial = await service.importStars({ stars });
    expect(initial.updatedCount).toBe(10_000);
    expect(initial.metadataUrls).toHaveLength(10_000);
    expect(enqueued).toHaveLength(1);
    expect(enqueued[0].items).toHaveLength(10_000);
    expect(db.items.upsertBatches).toHaveLength(50);
    expect(Math.max(...db.items.upsertBatches.map((batch) => batch.length))).toBeLessThanOrEqual(200);

    for (const row of db.items.rows.values()) row.isMetaFetched = true;
    enqueued.length = 0;
    db.space_groups.resetWriteHistory();
    db.spaces.resetWriteHistory();
    db.folders.resetWriteHistory();
    db.items.resetWriteHistory();
    now += 1_000;

    const unchanged = await service.importStars({ stars });
    expect(unchanged).toMatchObject({ updatedCount: 0, removedCount: 0, metadataUrls: [] });
    expect(enqueued).toHaveLength(0);
    expect(db.space_groups.upsertBatches).toHaveLength(0);
    expect(db.spaces.upsertBatches).toHaveLength(0);
    expect(db.folders.upsertBatches).toHaveLength(0);
    expect(db.items.upsertBatches).toHaveLength(0);

    const changedStars = structuredClone(stars);
    changedStars[125].description = "Updated repository description";
    now += 1_000;
    const changed = await service.importStars({ stars: changedStars });
    expect(changed).toMatchObject({ updatedCount: 1, metadataUrls: [changedStars[125].url] });
    expect(enqueued).toHaveLength(1);
    expect(enqueued[0].items).toHaveLength(1);

    enqueued.length = 0;
    const deletedStars = changedStars.slice(0, -1);
    now += 1_000;
    const deleted = await service.importStars({ stars: deletedStars });
    expect(deleted).toMatchObject({ updatedCount: 0, removedCount: 1 });
    expect(enqueued).toHaveLength(1);
    expect(enqueued[0].items).toHaveLength(1);
    expect(enqueued[0].items![0]).toMatchObject({ deletedAt: now, updatedAt: now });
  });

  test("reconciliation preserves user-owned records inside the managed stars group", async () => {
    const db = createFakeGitHubDb();
    let now = NOW + 100_000;
    const service = new GitHubStarsImportService({
      getDb: async () => db as never,
      cloudSync: {
        enqueueDocs: async () => ({ queued: 0, added: 0 }),
      } as never,
      markSearchDirty: () => {},
      now: () => now,
      yieldToEventLoop: async () => {},
      notifyDbChange: () => {},
    });
    const initial = await service.importStars({ stars: createStars(1) });
    const importedSpaceId = initial.spaceIds[0];
    const importedFolder = Array.from(db.folders.rows.values())[0];
    const importedItem = Array.from(db.items.rows.values())[0];

    db.spaces.rows.set("user-stars-space", {
      ...db.spaces.rows.get(importedSpaceId)!,
      id: "user-stars-space",
      name: "My projects",
      slug: "my-projects",
    });
    db.folders.rows.set("user-stars-folder", {
      ...importedFolder,
      id: "user-stars-folder",
      name: "My folder",
      spaceId: importedSpaceId,
      parentId: importedFolder.id,
    });
    db.items.rows.set("user-stars-item", {
      ...importedItem,
      id: "user-stars-item",
      title: "Keep me",
      url: "https://example.com/user-star",
      folderId: importedFolder.id,
      deletedAt: 0,
    });
    db.items.rows.set("user-stars-space-item", {
      ...importedItem,
      id: "user-stars-space-item",
      title: "Keep my space",
      url: "https://example.com/user-stars-space",
      spaceId: "user-stars-space",
      folderId: "user-stars-folder",
      deletedAt: 0,
    });

    now += 1_000;
    const result = await service.importStars({ stars: [] });

    expect(result.removedCount).toBe(1);
    expect(db.items.rows.get(String(importedItem.id))?.deletedAt).toBe(now);
    expect(db.items.rows.get("user-stars-item")?.deletedAt).toBe(0);
    expect(db.items.rows.get("user-stars-space-item")?.deletedAt).toBe(0);
    expect(db.folders.rows.has(String(importedFolder.id))).toBe(true);
    expect(db.folders.rows.has("user-stars-folder")).toBe(true);
    expect(db.spaces.rows.get(importedSpaceId)?.isArchived).toBe(false);
    expect(db.spaces.rows.get("user-stars-space")?.isArchived).toBe(false);
  });

  test("reimport preserves a relocated managed star and all of its local edits", async () => {
    const db = createFakeGitHubDb();
    const enqueued: CloudSyncDocBatch[] = [];
    let now = NOW + 100_000;
    const service = new GitHubStarsImportService({
      getDb: async () => db as never,
      cloudSync: {
        enqueueDocs: async (batch) => {
          enqueued.push(batch);
          return { queued: 0, added: 0 };
        },
      } as never,
      markSearchDirty: () => {},
      now: () => now,
      yieldToEventLoop: async () => {},
      notifyDbChange: () => {},
    });
    const initialStars = createStars(1);
    await service.importStars({ stars: initialStars });
    const imported = Array.from(db.items.rows.values())[0];
    const relocated = {
      ...imported,
      title: "My annotated repository",
      textContent: "Local repository notes",
      folderId: "user-stars-folder",
      spaceId: "user-stars-space",
      isFavorite: true,
      media: [{ type: "image", url: "https://example.com/local-star.png" }],
      updatedAt: now + 1,
    };
    db.items.rows.set(String(imported.id), cloneRow(relocated));
    db.spaces.rows.set("user-stars-space", {
      id: "user-stars-space",
      name: "My projects",
      slug: "my-projects",
      spaceGroupId: "",
      isPrivate: false,
      isArchived: false,
      deletedAt: 0,
    });
    db.folders.rows.set("user-stars-folder", {
      id: "user-stars-folder",
      name: "My repositories",
      spaceId: "user-stars-space",
      parentId: null,
      deletedAt: 0,
    });
    enqueued.length = 0;
    db.items.resetWriteHistory();

    const changedStars = structuredClone(initialStars);
    changedStars[0].description = "Source description changed";
    changedStars[0].stargazerCount = 9_999;
    now += 1_000;
    const result = await service.importStars({ stars: changedStars });

    expect(result.updatedCount).toBe(0);
    expect(result.metadataUrls).toEqual([]);
    expect(db.items.rows.get(String(imported.id))).toEqual(relocated);
    expect(db.items.upsertBatches).toHaveLength(0);
    expect(enqueued).toHaveLength(0);
  });

  test("reimport keeps a binned managed star in the Bin while it is still starred on GitHub", async () => {
    const db = createFakeGitHubDb();
    const enqueued: CloudSyncDocBatch[] = [];
    let now = NOW + 100_000;
    const service = new GitHubStarsImportService({
      getDb: async () => db as never,
      cloudSync: {
        enqueueDocs: async (batch) => {
          enqueued.push(batch);
          return { queued: 0, added: 0 };
        },
      } as never,
      markSearchDirty: () => {},
      now: () => now,
      yieldToEventLoop: async () => {},
      notifyDbChange: () => {},
    });
    const initialStars = createStars(1);
    await service.importStars({ stars: initialStars });
    const imported = Array.from(db.items.rows.values())[0];
    const binnedAt = now + 5;
    db.items.rows.set(String(imported.id), {
      ...cloneRow(imported),
      deletedAt: binnedAt,
      updatedAt: binnedAt,
    });
    enqueued.length = 0;
    db.items.resetWriteHistory();

    now = binnedAt + 1_000;
    const result = await service.importStars({ stars: structuredClone(initialStars) });

    expect(result.updatedCount).toBe(0);
    const row = db.items.rows.get(String(imported.id));
    expect(row?.deletedAt).toBe(binnedAt);
    expect(db.items.upsertBatches).toHaveLength(0);
    expect(enqueued).toHaveLength(0);
  });

  test("rejects a managed stars import when RxDB rejects an item batch", async () => {
    const db = createFakeGitHubDb();
    const enqueued: CloudSyncDocBatch[] = [];
    const writeError = {
      status: 500,
      documentId: "github-star-item-rejected",
      isError: true,
      message: "storage write rejected",
    };
    db.items.nextBulkUpsertResult = { success: [], error: [writeError] };
    let searchDirtyCalls = 0;
    const notifications: string[] = [];
    const service = new GitHubStarsImportService({
      getDb: async () => db as never,
      cloudSync: {
        enqueueDocs: async (batch) => {
          enqueued.push(batch);
          return { queued: 0, added: 0 };
        },
      } as never,
      markSearchDirty: () => {
        searchDirtyCalls += 1;
      },
      now: () => NOW,
      yieldToEventLoop: async () => {},
      notifyDbChange: (scope) => notifications.push(scope),
    });

    const importError = await service.importStars({ stars: createStars(1) }).then(
      () => null,
      (error: unknown) => error
    );

    expect(importError).toBeInstanceOf(AggregateError);
    expect(importError).toMatchObject({
      message: "RXDB_BULK_WRITE_FAILED:github-stars.items:1",
      errors: [writeError],
    });
    expect(db.items.rows.size).toBe(0);
    expect(enqueued).toHaveLength(0);
    expect(searchDirtyCalls).toBe(0);
    expect(notifications).toEqual([]);
  });

  test("retains structure when user content lands at the final stars cleanup boundary", async () => {
    const db = createFakeGitHubDb();
    let now = NOW + 100_000;
    let armed = false;
    let injected = false;
    let concurrentItem: StoredRow | null = null;
    let staleManagedItemId: string | null = null;
    const service = new GitHubStarsImportService({
      getDb: async () => db as never,
      cloudSync: {
        enqueueDocs: async () => ({ queued: 0, added: 0 }),
      } as never,
      markSearchDirty: () => {},
      now: () => now,
      yieldToEventLoop: async () => {
        if (!armed || injected || !concurrentItem) return;
        if (!staleManagedItemId || db.items.rows.get(staleManagedItemId)?.deletedAt !== now) return;
        db.items.rows.set(String(concurrentItem.id), cloneRow(concurrentItem));
        injected = true;
      },
      notifyDbChange: () => {},
    });
    const initialStars = createStars(501);
    const initialPlan = buildGitHubStarsImportPlan(initialStars, { now });
    await service.importStars({ stars: initialStars });

    const staleSpace = initialPlan.spaces[1];
    const staleFolder = initialPlan.folders.find((folder) => folder.spaceId === staleSpace.id)!;
    const staleItem = initialPlan.items.find((item) => item.spaceId === staleSpace.id)!;
    staleManagedItemId = staleItem.id;
    concurrentItem = {
      ...staleItem,
      id: "user-save-during-github-sync",
      title: "Saved while syncing",
      url: "https://example.com/concurrent-user-star",
      folderId: staleFolder.id,
      spaceId: staleSpace.id,
      deletedAt: 0,
    };
    armed = true;
    now += 1_000;

    await service.importStars({ stars: initialStars.slice(0, 500) });

    expect(injected).toBe(true);
    expect(db.items.rows.get("user-save-during-github-sync")?.deletedAt).toBe(0);
    expect(db.folders.rows.has(staleFolder.id)).toBe(true);
    expect(db.spaces.rows.get(staleSpace.id)?.isArchived).toBe(false);
  });

  test("does not silently resurrect a managed destination space from Bin", async () => {
    const db = createFakeGitHubDb();
    const service = new GitHubStarsImportService({
      getDb: async () => db as never,
      cloudSync: { enqueueDocs: async () => ({ queued: 0, added: 0 }) } as never,
      markSearchDirty: () => {},
      now: () => NOW,
      yieldToEventLoop: async () => {},
      notifyDbChange: () => {},
    });
    const stars = createStars(1);
    const initial = await service.importStars({ stars });
    const space = db.spaces.rows.get(initial.spaceIds[0])!;
    space.deletedAt = NOW + 1;
    space.purgeAt = NOW + 2;
    db.items.resetWriteHistory();

    await expect(service.importStars({ stars })).rejects.toThrow(
      "DESTINATION_SPACE_NOT_LIVE"
    );
    expect(space.deletedAt).toBe(NOW + 1);
    expect(db.items.upsertBatches).toHaveLength(0);
  });
});
