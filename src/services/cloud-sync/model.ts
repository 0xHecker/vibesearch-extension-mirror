import {
  jsonFiniteNumber,
  jsonObject,
  jsonString,
  parseJsonObject,
  type JsonObject,
  type JsonValue,
} from "@src/common/json-value";
import type { FolderDocType } from "@src/schemas/folder_schema";
import type { ItemDocType } from "@src/schemas/item_schema";
import type { ItemTagDocType } from "@src/schemas/item_tag_schema";
import type { SpaceDocType } from "@src/schemas/space_schema";
import type { SpaceGroupDocType } from "@src/schemas/space_group_schema";
import type { TagDocType } from "@src/schemas/tag_schema";
import { z } from "zod";

export const CLOUD_SYNC_QUEUE_KEY = "vibesearch:cloudSyncQueue:v1";
export const CLOUD_SYNC_CLIENT_ID_KEY = "vibesearch:cloudSyncClientId";

export const CLOUD_SYNC_PUSH_BATCH_SIZE = 10;
export const CLOUD_SYNC_PUSH_BATCH_MAX = 10;
/** Where this device stopped reading the server's change log. */
export const CLOUD_SYNC_PULL_STATE_KEY = "vibesearch:cloudSyncPullState:v1";
/**
 * Whether this device accepts rows from the account's other devices. Off by
 * default: backup leaves this extension one-way unless the user asks for the
 * return direction. Even when on, a pull only ever adds rows it has never seen.
 */
export const CLOUD_PULL_ENABLED_KEY = "vibesearch:cloudPullEnabled:v1";
/**
 * Stamped on every document this extension pushes, and required on every
 * document it accepts back. The cloud library is shared with the web app, and
 * the web app's rows must never flow into a local library — so "authored by an
 * extension" travels with the document itself. The marker is stripped again
 * before a local insert, so no local schema has to know about it.
 */
export const CLOUD_SYNC_ORIGIN_FIELD = "syncOrigin";
export const CLOUD_SYNC_ORIGIN_EXTENSION = "extension";
export const CLOUD_SYNC_PULL_PAGE_SIZE = 250;
export const CLOUD_SYNC_PULL_MAX_PAGES = 8;

const cloudSyncCollectionSchema = z.enum([
  "items",
  "folders",
  "spaces",
  "spaceGroups",
  "tags",
  "itemTags",
]);

export type CloudSyncCollectionName = z.infer<typeof cloudSyncCollectionSchema>;

export const CLOUD_SYNC_COLLECTIONS = cloudSyncCollectionSchema.options;

export const isCloudSyncCollection = (
  value: JsonValue | undefined,
): value is CloudSyncCollectionName => cloudSyncCollectionSchema.safeParse(value).success;

export type CloudSyncQueueRef = {
  collection: CloudSyncCollectionName;
  id: string;
  updatedAt: number;
  deletedAt: number;
  queuedAt: number;
  attempts?: number;
};

export type CloudSyncEntityRef = Pick<CloudSyncQueueRef, "collection" | "id">;

export type CloudSyncChange = {
  collection: CloudSyncCollectionName;
  id: string;
  doc: JsonObject | null;
  updatedAt: number;
  deletedAt: number;
};

export type CloudSyncDocBatch = {
  spaceGroups?: SpaceGroupDocType[];
  spaces?: SpaceDocType[];
  folders?: FolderDocType[];
  items?: ItemDocType[];
  tags?: TagDocType[];
  itemTags?: ItemTagDocType[];
  deletes?: Array<Pick<CloudSyncQueueRef, "collection" | "id"> & Partial<Pick<CloudSyncQueueRef, "updatedAt" | "deletedAt">>>;
};

export type CloudSyncDrainResult = {
  pushed: number;
  skipped: number;
  conflicts: number;
  batches: number;
  queued: number;
  remaining: number;
  reason?: "empty" | "missing-token" | "invalid-auth" | "http-error" | "network-error" | "invalid-response" | "cancelled" | "unresolved";
  error?: string;
};

export type CloudSyncBatchOptions = {
  batchSize?: number;
  maxBatches?: number;
  priorityRefs?: Array<Pick<CloudSyncQueueRef, "collection" | "id">>;
  /** Guard a full-library scan against an account switch before its drain. */
  expectedUserId?: string;
};

export type CloudSyncAllOptions = Pick<CloudSyncBatchOptions, "maxBatches"> & {
  pageSize?: number;
};

export type CloudSyncAllResult = {
  scanned: number;
  enqueued: number;
  queued: number;
  push: CloudSyncDrainResult;
};

export type CloudSyncPushItemResult = {
  ready: boolean;
  reason?: "missing-local-item" | "still-queued";
  push?: CloudSyncDrainResult;
};

/** What this device knows about one item's backup state. */
export type CloudSyncItemState = "synced" | "pending" | "not-connected";


/** Where this device stopped reading the server log, and any bootstrap replay. */
export type CloudSyncPullState = {
  checkpoint: number;
  /** Set while the server is rebuilding a snapshot for a compacted cursor. */
  bootstrapCursor?: string;
  /**
   * The account this checkpoint belongs to. Sequence numbers are per user, so
   * reusing another account's checkpoint would silently skip its whole library:
   * "seq > 5000" matches nothing in a store that starts at 1.
   */
  userId?: string;
};

export type CloudSyncPullResult = {
  /** Rows from other devices that this device did not have. */
  inserted: number;
  /** Rows deliberately left alone (already local, duplicate URL, remote delete). */
  skipped: number;
  /** Rows that should have been written but the store refused. */
  rejected: number;
  pages: number;
  checkpoint: number;
  /** More pages are waiting; the next run continues from the checkpoint. */
  hasMore: boolean;
  reason?:
    | "empty"
    | "disabled"
    | "cancelled"
    | "missing-token"
    | "invalid-auth"
    | "http-error"
    | "network-error"
    | "invalid-response";
  error?: string;
};

export const isObject = (
  value: JsonValue | undefined,
): value is JsonObject => jsonObject(value) !== undefined;

export const clampTimestamp = (
  value: JsonValue | undefined,
  fallback: number,
): number => {
  const parsed = jsonFiniteNumber(value);
  if (parsed === undefined) return fallback;
  return Math.max(0, Math.min(Number.MAX_SAFE_INTEGER - 1, Math.floor(parsed)));
};

export const queueKey = (ref: Pick<CloudSyncQueueRef, "collection" | "id">): string => `${ref.collection}:${ref.id}`;

export const boundedPositiveInteger = (
  value: number | undefined,
  fallback: number,
  maximum: number,
): number => {
  const candidate = Number.isFinite(value) ? Math.floor(value ?? fallback) : fallback;
  return Math.max(1, Math.min(maximum, candidate));
};

type ParsedCloudSyncPushResult = {
  applied: number;
  conflicts: number;
  acknowledgements: Array<string | CloudSyncEntityRef>;
};

const cloudSyncEntityRefSchema = z.object({
  collection: cloudSyncCollectionSchema,
  id: z.string().min(1),
});

const cloudSyncPushResultSchema = z.object({
  checkpoint: z.number().int().nonnegative(),
  applied: z.number().int().nonnegative(),
  conflicts: z.number().int().nonnegative(),
  acceptedRefs: z.array(cloudSyncEntityRefSchema).optional(),
  conflictRefs: z.array(cloudSyncEntityRefSchema).optional(),
  acceptedIds: z.array(z.string().min(1)).optional(),
  conflictIds: z.array(z.string().min(1)).optional(),
});

function keysForEntityRefs(
  refs: CloudSyncEntityRef[],
  changesByKey: Map<string, CloudSyncChange>,
): Set<string> | null {
  const keys = new Set<string>();
  for (const ref of refs) {
    const key = queueKey(ref);
    if (!changesByKey.has(key) || keys.has(key)) return null;
    keys.add(key);
  }
  return keys;
}

function keysForLegacyIds(
  ids: string[],
  changesById: Map<string, CloudSyncChange>,
): Set<string> | null {
  const keys = new Set<string>();
  for (const id of ids) {
    const change = changesById.get(id);
    if (!change) return null;
    const key = queueKey(change);
    if (keys.has(key)) return null;
    keys.add(key);
  }
  return keys;
}

export const parseCloudSyncPushResult = (
  value: JsonValue,
  changes: CloudSyncChange[],
): ParsedCloudSyncPushResult | null => {
  const parsed = cloudSyncPushResultSchema.safeParse(value);
  if (!parsed.success) return null;
  const response = parsed.data;
  const { applied, conflicts } = response;
  if (applied + conflicts !== changes.length) return null;

  const changeByKey = new Map(changes.map((change) => [queueKey(change), change]));
  const changeById = new Map(changes.map((change) => [change.id, change]));
  if (changeByKey.size !== changes.length || changeById.size !== changes.length) return null;

  const qualified = response.acceptedRefs !== undefined || response.conflictRefs !== undefined;
  const legacy = !qualified && (
    response.acceptedIds !== undefined || response.conflictIds !== undefined
  );
  let acceptedKeys: Set<string> | null | undefined;
  let conflictKeys: Set<string> | null | undefined;
  if (qualified) {
    acceptedKeys = response.acceptedRefs
      ? keysForEntityRefs(response.acceptedRefs, changeByKey)
      : undefined;
    conflictKeys = response.conflictRefs
      ? keysForEntityRefs(response.conflictRefs, changeByKey)
      : undefined;
  } else if (legacy) {
    acceptedKeys = response.acceptedIds
      ? keysForLegacyIds(response.acceptedIds, changeById)
      : undefined;
    conflictKeys = response.conflictIds
      ? keysForLegacyIds(response.conflictIds, changeById)
      : undefined;
  }
  if (acceptedKeys === null || conflictKeys === null) return null;

  const allKeys = new Set(changeByKey.keys());
  if (!acceptedKeys && !conflictKeys) {
    if (applied !== changes.length || conflicts !== 0) return null;
    acceptedKeys = allKeys;
    conflictKeys = new Set();
  } else {
    acceptedKeys ??= new Set([...allKeys].filter((key) => !conflictKeys?.has(key)));
    conflictKeys ??= new Set([...allKeys].filter((key) => !acceptedKeys?.has(key)));
  }

  if (acceptedKeys.size !== applied || conflictKeys.size !== conflicts) return null;
  for (const key of acceptedKeys) {
    if (conflictKeys.has(key)) return null;
  }
  if (acceptedKeys.size + conflictKeys.size !== changes.length) return null;

  return {
    applied,
    conflicts,
    acknowledgements: changes.map(({ collection, id }) => ({ collection, id })),
  };
};

const cloudSyncQueueRefSchema = z.object({
  collection: cloudSyncCollectionSchema,
  id: z.string().min(1),
  updatedAt: z.number().finite(),
  deletedAt: z.number().finite(),
  queuedAt: z.number().finite(),
  attempts: z.number().finite().optional(),
});

export const normalizeRef = (ref: CloudSyncQueueRef): CloudSyncQueueRef => {
  const now = Date.now();
  const updatedAt = clampTimestamp(ref.updatedAt, now);
  const deletedAt = clampTimestamp(ref.deletedAt, 0);
  return {
    collection: ref.collection,
    id: ref.id,
    updatedAt,
    deletedAt,
    queuedAt: clampTimestamp(ref.queuedAt, now),
    attempts: Math.max(0, Math.floor(ref.attempts ?? 0)),
  };
};

export function parseCloudSyncQueue(value: JsonValue | undefined): CloudSyncQueueRef[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => {
    const parsed = cloudSyncQueueRefSchema.safeParse(entry);
    return parsed.success ? [normalizeRef(parsed.data)] : [];
  });
}

export const mergeCloudSyncQueue = (
  existing: CloudSyncQueueRef[],
  incoming: CloudSyncQueueRef[]
): CloudSyncQueueRef[] => {
  const merged = new Map<string, CloudSyncQueueRef>();
  for (const raw of existing) {
    const ref = normalizeRef(raw);
    merged.set(queueKey(ref), ref);
  }
  for (const raw of incoming) {
    const ref = normalizeRef(raw);
    const key = queueKey(ref);
    const prev = merged.get(key);
    const wins = !prev ||
      ref.updatedAt > prev.updatedAt ||
      (ref.updatedAt === prev.updatedAt && ref.deletedAt >= prev.deletedAt);
    if (wins) {
      merged.set(key, { ...ref, attempts: prev && ref.updatedAt === prev.updatedAt ? prev.attempts : 0 });
    }
  }
  return Array.from(merged.values()).sort((a, b) => a.queuedAt - b.queuedAt || a.updatedAt - b.updatedAt);
};

const SOCIAL_CLOUD_SOURCES = new Set([
  "twitter",
  "instagram",
  "tiktok",
  "linkedin",
  "threads",
  "mastodon",
  "bluesky",
]);

const inferCloudItemType = (item: JsonObject): string => {
  const source = jsonString(item.source) ?? "web";
  const media = Array.isArray(item.media)
    ? item.media.flatMap((entry) => {
        const parsed = jsonObject(entry);
        return parsed ? [parsed] : [];
      })
    : [];
  if (source === "github") return "repo";
  if (source === "youtube" || source === "vimeo") return "video";
  if (source === "spotify" || source === "ytmusic" || source === "soundcloud") return "audio";
  if (SOCIAL_CLOUD_SOURCES.has(source)) return "social";
  if (source === "reddit") return "forum";
  if (source === "note") return "note";
  if (source === "article" || source === "substack") return "article";
  if (media.some((entry) => jsonString(entry.type) === "video")) return "video";
  if (media.some((entry) => jsonString(entry.type) === "audio")) return "audio";
  if (media.some((entry) => jsonString(entry.type) === "image") || item.displayImageUrl) return "image";
  return "link";
};

const deriveCloudFields = (item: JsonObject): JsonObject => {
  const existing: JsonObject = { ...jsonObject(item.fields) };
  const textContent = jsonString(item.textContent);
  const source = jsonString(item.source);
  const author = jsonString(item.authorUsername);
  const likes = jsonFiniteNumber(item.likes);
  const upvotes = jsonFiniteNumber(item.upvotes);
  if (!existing.description && textContent && inferCloudItemType(item) === "link") {
    existing.description = textContent;
  }
  if (source === "github") {
    if (!existing.owner && author) existing.owner = author;
    if (!existing.stars && likes !== undefined) existing.stars = likes;
  }
  if (source === "reddit") {
    if (!existing.author && author) existing.author = author;
    if (!existing.upvotes && upvotes !== undefined) existing.upvotes = upvotes;
  }
  if (source && SOCIAL_CLOUD_SOURCES.has(source)) {
    if (!existing.platform) existing.platform = source;
    if (!existing.author && author) existing.author = author;
    if (!existing.likes && likes !== undefined) existing.likes = likes;
  }
  return existing;
};

type CloudSyncDocument =
  | ItemDocType
  | FolderDocType
  | SpaceDocType
  | SpaceGroupDocType
  | TagDocType
  | ItemTagDocType
  | JsonObject;

export const normalizeCloudDoc = (
  collection: CloudSyncCollectionName,
  doc: CloudSyncDocument,
  cloudUserId = "",
): JsonObject => {
  const value = parseJsonObject(doc);
  return {
    ...normalizeCloudDocFields(collection, value, cloudUserId),
    [CLOUD_SYNC_ORIGIN_FIELD]: CLOUD_SYNC_ORIGIN_EXTENSION,
  };
};

const normalizeCloudDocFields = (
  collection: CloudSyncCollectionName,
  doc: JsonObject,
  cloudUserId = "",
): JsonObject => {
  if (collection === "items") {
    return {
      ...doc,
      userId: cloudUserId || jsonString(doc.userId) || null,
      type: jsonString(doc.type) || inferCloudItemType(doc),
      fields: deriveCloudFields(doc),
    };
  }
  if (collection === "spaceGroups") {
    return { ...doc, parentGroupId: doc.parentGroupId ?? null };
  }
  if (collection === "tags" || collection === "itemTags" || collection === "folders") {
    return {
      ...doc,
      userId: cloudUserId || jsonString(doc.userId) || null,
    };
  }
  return { ...doc };
};

const refsFromDocs = <T extends { id: string; updatedAt?: number; deletedAt?: number }>(
  collection: CloudSyncCollectionName,
  docs: T[] | undefined,
  now: number
): CloudSyncQueueRef[] =>
  (docs || [])
    .filter((doc) => doc.id.length > 0)
    .map((doc) => ({
      collection,
      id: doc.id,
      updatedAt: clampTimestamp(doc.updatedAt, now),
      deletedAt: clampTimestamp(doc.deletedAt, 0),
      queuedAt: now,
    }));

export const cloudSyncRefsForDocs = (docs: CloudSyncDocBatch, now = Date.now()): CloudSyncQueueRef[] => [
  ...refsFromDocs("spaceGroups", docs.spaceGroups, now),
  ...refsFromDocs("spaces", docs.spaces, now),
  ...refsFromDocs("folders", docs.folders, now),
  ...refsFromDocs("items", docs.items, now),
  ...refsFromDocs("tags", docs.tags, now),
  ...refsFromDocs("itemTags", docs.itemTags, now),
  ...(docs.deletes || []).map((entry) => ({
    collection: entry.collection,
    id: entry.id,
    updatedAt: clampTimestamp(entry.updatedAt, now),
    deletedAt: clampTimestamp(entry.deletedAt, now),
    queuedAt: now,
  })),
];

const rxChangeRecordSchema = z.object({
  operation: z.string().optional(),
  documentId: z.string().optional(),
  documentData: z.record(z.string(), z.json()).nullish(),
  previousDocumentData: z.record(z.string(), z.json()).nullish(),
}).passthrough();

const rxChangeBatchSchema = z.object({
  events: z.array(rxChangeRecordSchema),
});

/** Convert RxDB bulk/single change events into compact live refs or tombstones. */
export const cloudSyncRefsForRxChange = (
  collection: CloudSyncCollectionName,
  changeEvent: JsonValue,
  now = Date.now(),
): CloudSyncQueueRef[] => {
  const queuedAt = clampTimestamp(now, Date.now());
  const batch = rxChangeBatchSchema.safeParse(changeEvent);
  let events: z.infer<typeof rxChangeRecordSchema>[] = [];
  if (batch.success) {
    events = batch.data.events;
  } else {
    const single = rxChangeRecordSchema.safeParse(changeEvent);
    if (single.success) events = [single.data];
  }
  const refs: CloudSyncQueueRef[] = [];

  for (const candidate of events) {
    const documentData = candidate.documentData ?? null;
    const previousDocumentData = candidate.previousDocumentData ?? null;
    const deleted = candidate.operation === "DELETE" || documentData?._deleted === true;
    const source = deleted ? previousDocumentData ?? documentData : documentData ?? previousDocumentData;
    const rawId = source?.id ?? candidate.documentId;
    const parsedId = jsonString(rawId);
    const id = parsedId?.trim() ? parsedId : "";
    if (!id) continue;

    if (deleted) {
      const previousUpdatedAt = clampTimestamp(source?.updatedAt, 0);
      const deletedAt = Math.max(queuedAt, Math.min(Number.MAX_SAFE_INTEGER - 1, previousUpdatedAt + 1));
      refs.push({ collection, id, updatedAt: deletedAt, deletedAt, queuedAt });
      continue;
    }

    const deletedAt = clampTimestamp(source?.deletedAt, 0);
    const updatedAt = Math.max(clampTimestamp(source?.updatedAt, queuedAt), deletedAt);
    refs.push({ collection, id, updatedAt, deletedAt, queuedAt });
  }

  return refs;
};

export const selectAcknowledgedQueueRefs = (
  refs: CloudSyncQueueRef[],
  acknowledgements: Array<string | CloudSyncEntityRef>
): CloudSyncQueueRef[] => {
  const acknowledgedIds = new Set<string>();
  const acknowledgedRefs = new Set<string>();
  for (const acknowledgement of acknowledgements) {
    const id = z.string().safeParse(acknowledgement);
    if (id.success) {
      acknowledgedIds.add(id.data);
      continue;
    }
    acknowledgedRefs.add(queueKey(cloudSyncEntityRefSchema.parse(acknowledgement)));
  }
  return refs.filter((ref) => acknowledgedIds.has(ref.id) || acknowledgedRefs.has(queueKey(ref)));
};

/** Put explicitly requested refs first without disturbing FIFO order otherwise. */
export const selectCloudSyncBatch = (
  queue: CloudSyncQueueRef[],
  batchSize: number,
  priorityRefs: Array<Pick<CloudSyncQueueRef, "collection" | "id">> = [],
): CloudSyncQueueRef[] => {
  const size = boundedPositiveInteger(batchSize, CLOUD_SYNC_PUSH_BATCH_SIZE, CLOUD_SYNC_PUSH_BATCH_MAX);
  const priority = new Set(priorityRefs.map((ref) => queueKey(ref)));
  const selected: CloudSyncQueueRef[] = [];
  const selectedKeys = new Set<string>();
  const selectedIds = new Set<string>();
  const append = (ref: CloudSyncQueueRef): boolean => {
    const key = queueKey(ref);
    if (selectedKeys.has(key) || selectedIds.has(ref.id)) return false;
    selected.push(ref);
    selectedKeys.add(key);
    selectedIds.add(ref.id);
    return true;
  };
  if (priority.size > 0) {
    for (const ref of queue) {
      if (!priority.has(queueKey(ref))) continue;
      append(ref);
      if (selected.length >= size) return selected;
    }
  }
  for (const ref of queue) {
    append(ref);
    if (selected.length >= size) break;
  }
  return selected;
};

/**
 * Remove only the version that was actually sent. A local change can be queued
 * while a request is in flight, so key-only acknowledgement would otherwise
 * drop that newer mutation when the older request succeeds.
 */
export const removeAcknowledgedQueueRefs = (
  current: CloudSyncQueueRef[],
  acknowledged: CloudSyncQueueRef[]
): CloudSyncQueueRef[] => {
  const sentByKey = new Map(acknowledged.map((ref) => [queueKey(ref), ref]));
  return current.filter((ref) => {
    const sent = sentByKey.get(queueKey(ref));
    return !sent || sent.updatedAt !== ref.updatedAt || sent.deletedAt !== ref.deletedAt;
  });
};
