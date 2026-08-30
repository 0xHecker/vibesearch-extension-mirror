import { expect, test } from "bun:test";
import {
  cloudPullItemKeys,
  itemDedupeKey,
  planCloudPullMerge,
  type CloudPullChange,
} from "@src/services/cloud-pull-merge";

/** Mirrors what another extension install pushes: stamped as extension-authored. */
const change = (overrides: Partial<CloudPullChange> = {}): CloudPullChange => {
  const built: CloudPullChange = {
    collection: "items",
    id: "remote-1",
    doc: { id: "remote-1", url: "https://example.com/page", spaceId: "public" },
    updatedAt: 1_000,
    deletedAt: 0,
    ...overrides,
  };
  if (built.doc && built.doc.syncOrigin === undefined) {
    built.doc = { ...built.doc, syncOrigin: "extension" };
  }
  return built;
};

test("a remote deletion never removes anything from this device", () => {
  const plan = planCloudPullMerge(
    [
      change({ id: "gone-1", doc: null, deletedAt: 5_000 }),
      change({ id: "gone-2", deletedAt: 5_000 }),
    ],
    { ids: { items: new Set(["gone-1", "gone-2"]) } },
  );

  expect(plan.inserts).toEqual([]);
  expect(plan.skipped.map((entry) => entry.reason)).toEqual(["remote-delete", "remote-delete"]);
});

test("an id this device already holds is left untouched", () => {
  const remote = change({
    id: "shared-1",
    doc: { id: "shared-1", url: "https://example.com/page", spaceId: "public", title: "Remote title" },
  });

  const plan = planCloudPullMerge([remote], { ids: { items: new Set(["shared-1"]) } });

  expect(plan.inserts).toEqual([]);
  expect(plan.skipped[0]).toMatchObject({ reason: "already-local" });
});

test("the same page in the same space is not saved twice", () => {
  const local = cloudPullItemKeys([
    { url: "https://Example.com/page/", spaceId: "public" },
  ]);

  const plan = planCloudPullMerge(
    [
      // Same page, different id and different URL spelling.
      change({ id: "remote-dupe", doc: { url: "https://example.com/page", spaceId: "public" } }),
      // Same page but in another space is a legitimately separate row.
      change({ id: "remote-other-space", doc: { url: "https://example.com/page", spaceId: "work" } }),
    ],
    { ids: { items: new Set() }, itemKeys: local },
  );

  expect(plan.inserts.map((entry) => entry.id)).toEqual(["remote-other-space"]);
  expect(plan.skipped).toHaveLength(1);
  expect(plan.skipped[0].reason).toBe("duplicate-url");
  expect(plan.skipped[0].change.id).toBe("remote-dupe");
});

test("genuinely new rows from another device are inserted", () => {
  const plan = planCloudPullMerge(
    [
      change({ id: "new-item" }),
      change({ collection: "spaces", id: "new-space", doc: { id: "new-space", name: "Work" } }),
      change({ collection: "tags", id: "new-tag", doc: { id: "new-tag", name: "reading" } }),
    ],
    { ids: {} },
  );

  expect(plan.inserts.map((entry) => `${entry.collection}:${entry.id}`)).toEqual([
    "items:new-item",
    "spaces:new-space",
    "tags:new-tag",
  ]);
  expect(plan.skipped).toEqual([]);
});

test("one page cannot insert the same thing twice", () => {
  const plan = planCloudPullMerge(
    [
      change({ id: "repeat" }),
      change({ id: "repeat" }),
      change({ id: "other", doc: { url: "https://example.com/page", spaceId: "public" } }),
    ],
    { ids: {} },
  );

  expect(plan.inserts.map((entry) => entry.id)).toEqual(["repeat"]);
  expect(plan.skipped.map((entry) => entry.reason)).toEqual(["already-local", "duplicate-url"]);
});

test("unknown collections and malformed rows are ignored, not guessed at", () => {
  const plan = planCloudPullMerge(
    [
      change({ collection: "secrets" as never, id: "nope" }),
      change({ id: "   " }),
    ],
    { ids: {} },
  );

  expect(plan.inserts).toEqual([]);
  expect(plan.skipped.map((entry) => entry.reason)).toEqual(["unsupported-collection", "invalid"]);
});

test("dedupe keys ignore host case, trailing slash and fragments but respect the query", () => {
  const base = itemDedupeKey("https://example.com/page", "public");

  expect(itemDedupeKey("https://EXAMPLE.com/page/", "public")).toBe(base);
  expect(itemDedupeKey("https://example.com/page#section", "public")).toBe(base);
  expect(itemDedupeKey("https://example.com/page?id=2", "public")).not.toBe(base);
  expect(itemDedupeKey("https://example.com/page", "work")).not.toBe(base);
  expect(itemDedupeKey("not a url", "public")).toBeNull();
  expect(itemDedupeKey("file:///etc/passwd", "public")).toBeNull();
});

test("rows the web app created never reach this device", () => {
  const plan = planCloudPullMerge(
    [
      // No stamp: created in the web app or by any other client.
      change({ id: "from-web", doc: { id: "from-web", url: "https://example.com/web", spaceId: "public", syncOrigin: null } }),
      change({ id: "from-web-2", doc: { id: "from-web-2", url: "https://example.com/web2", spaceId: "public", syncOrigin: "web" } }),
      // Stamped by another extension install.
      change({ id: "from-extension", doc: { id: "from-extension", url: "https://example.com/ext", spaceId: "public" } }),
    ],
    { ids: {} },
  );

  expect(plan.inserts.map((entry) => entry.id)).toEqual(["from-extension"]);
  expect(plan.skipped.map((entry) => entry.reason)).toEqual(["foreign-origin", "foreign-origin"]);
});
