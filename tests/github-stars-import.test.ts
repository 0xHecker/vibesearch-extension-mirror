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
    for (const row of rows) this.rows.set(String(row.id), cloneRow(row));
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
});
