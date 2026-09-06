import { jsonString, type JsonObject, type JsonValue } from "@src/common/json-value";

/**
 * Deciding what a pull from the cloud is allowed to do to this device.
 *
 * Sync is additive here, on purpose. Another device's library is a source of
 * things this device has not seen yet — never an authority over what it already
 * holds. So the rules are:
 *
 *   0. Only documents an extension authored are considered at all. The cloud
 *      library is shared with the web app, and web rows must never appear in a
 *      local library.
 *   1. A remote deletion never removes a local row. Absence elsewhere is not a
 *      decision made here.
 *   2. An id this device already has is left exactly as it is. Remote fields
 *      never overwrite local ones.
 *   3. An item whose URL already exists in the same space is a duplicate of
 *      something local, so it is skipped rather than added twice.
 *   4. Anything left is genuinely new and is inserted.
 *
 * With those four rules a pull cannot lose or mangle local data, which means it
 * needs no conflict resolution and no undo.
 */

export type CloudPullCollection =
  | "items"
  | "folders"
  | "spaces"
  | "spaceGroups"
  | "tags"
  | "itemTags";

export type CloudPullChange = {
  collection: CloudPullCollection;
  id: string;
  doc: JsonObject | null;
  updatedAt: number;
  deletedAt: number;
};

export type CloudPullSkipReason =
  | "foreign-origin"
  | "remote-delete"
  | "already-local"
  | "duplicate-url"
  | "unsupported-collection"
  | "invalid";

export type CloudPullDecision =
  | { action: "insert"; change: CloudPullChange }
  | { action: "skip"; change: CloudPullChange; reason: CloudPullSkipReason };

export type CloudPullLocalIndex = {
  /** Every id this device already holds, per collection. */
  ids: Partial<Record<CloudPullCollection, ReadonlySet<string>>>;
  /** Item de-duplication keys (see `itemDedupeKey`) already present locally. */
  itemKeys?: ReadonlySet<string>;
};

export type CloudPullPlan = {
  inserts: CloudPullChange[];
  skipped: Array<{ change: CloudPullChange; reason: CloudPullSkipReason }>;
};

/** Must match the stamp `normalizeCloudDoc` writes on every pushed document. */
export const CLOUD_PULL_ORIGIN_FIELD = "syncOrigin";
export const CLOUD_PULL_ORIGIN_EXTENSION = "extension";

const SUPPORTED: ReadonlySet<string> = new Set<CloudPullCollection>([
  "items",
  "folders",
  "spaces",
  "spaceGroups",
  "tags",
  "itemTags",
]);

/**
 * Stable identity for "the same page saved in the same space", so two devices
 * that saved one URL independently do not end up with two rows.
 *
 * Host case and a trailing slash are noise; the query string is not (many sites
 * put the real target there). The fragment never identifies a different page.
 */
export const itemDedupeKey = (
  url: JsonValue | undefined,
  spaceId: JsonValue | undefined,
): string | null => {
  const parsedUrl = jsonString(url)?.trim();
  if (!parsedUrl) return null;
  let normalized: string;
  try {
    const parsed = new URL(parsedUrl);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
    parsed.hash = "";
    parsed.hostname = parsed.hostname.toLowerCase();
    const path = parsed.pathname.length > 1 ? parsed.pathname.replace(/\/+$/, "") : parsed.pathname;
    normalized = `${parsed.protocol}//${parsed.host}${path}${parsed.search}`;
  } catch {
    return null;
  }
  const space = jsonString(spaceId)?.trim() ?? "";
  return `${space}\n${normalized}`;
};

/** Plan one page of remote changes against what this device already holds. */
export const planCloudPullMerge = (
  changes: readonly CloudPullChange[],
  local: CloudPullLocalIndex,
): CloudPullPlan => {
  const plan: CloudPullPlan = { inserts: [], skipped: [] };
  // Ids and dedupe keys accepted earlier in this same page also count as local,
  // so one page cannot insert the same thing twice.
  const seenIds = new Map<CloudPullCollection, Set<string>>();
  const seenItemKeys = new Set<string>(local.itemKeys ?? []);

  const skip = (change: CloudPullChange, reason: CloudPullSkipReason) => {
    plan.skipped.push({ change, reason });
  };

  for (const change of changes) {
    if (!change || !SUPPORTED.has(change.collection)) {
      skip(change, "unsupported-collection");
      continue;
    }
    if (!change.id.trim()) {
      skip(change, "invalid");
      continue;
    }
    // Rule 1: a remote tombstone is not permission to delete here.
    if (change.deletedAt > 0 || change.doc === null) {
      skip(change, "remote-delete");
      continue;
    }

    // Rule 0: only rows another extension wrote. Anything created in the web app
    // (or by any client that does not stamp itself) stays in the cloud.
    if (change.doc[CLOUD_PULL_ORIGIN_FIELD] !== CLOUD_PULL_ORIGIN_EXTENSION) {
      skip(change, "foreign-origin");
      continue;
    }

    // Rule 2: this device's own copy wins, always.
    const known = local.ids[change.collection];
    const alreadyAccepted = seenIds.get(change.collection);
    if (known?.has(change.id) || alreadyAccepted?.has(change.id)) {
      skip(change, "already-local");
      continue;
    }

    // Rule 3: the same page in the same space is one row, not two.
    if (change.collection === "items") {
      const key = itemDedupeKey(change.doc.url, change.doc.spaceId);
      if (key && seenItemKeys.has(key)) {
        skip(change, "duplicate-url");
        continue;
      }
      if (key) seenItemKeys.add(key);
    }

    // Rule 4: genuinely new.
    plan.inserts.push(change);
    if (!alreadyAccepted) seenIds.set(change.collection, new Set([change.id]));
    else alreadyAccepted.add(change.id);
  }

  return plan;
};

/** Build the dedupe key set for the local items this device holds. */
export const cloudPullItemKeys = (
  items: readonly { url?: JsonValue; spaceId?: JsonValue }[],
): Set<string> => {
  const keys = new Set<string>();
  for (const item of items) {
    const key = itemDedupeKey(item?.url, item?.spaceId);
    if (key) keys.add(key);
  }
  return keys;
};
