import { getDb } from "@src/services/DatabaseService";
import type { FolderDocType } from "@src/schemas/folder_schema";
import type { ItemDocType } from "@src/schemas/item_schema";
import type { SpaceDocType } from "@src/schemas/space_schema";
import type { SpaceGroupDocType } from "@src/schemas/space_group_schema";
import type { TagDocType } from "@src/schemas/tag_schema";
import type { ItemTagDocType } from "@src/schemas/item_tag_schema";
import {
  getCloudAuthCredentials,
  getCloudAuthToken,
  type CloudAuthCredentials,
} from "./cloud-auth";
import {
  CLOUD_SYNC_API_BASE_KEY,
  CLOUD_SYNC_TOKEN_KEY,
  DEFAULT_VIBESEARCH_API_BASE,
} from "./cloud-config";
import { forEachIdKeysetPage } from "./rxdb-keyset-pagination";
import {
  cloudPullItemKeys,
  planCloudPullMerge,
  type CloudPullChange,
} from "./cloud-pull-merge";

export {
  CLOUD_SYNC_API_BASE_KEY,
  CLOUD_SYNC_TOKEN_KEY,
  DEFAULT_VIBESEARCH_API_BASE,
} from "./cloud-config";

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

export type CloudSyncCollectionName = "items" | "folders" | "spaces" | "spaceGroups" | "tags" | "itemTags";

const CLOUD_SYNC_COLLECTIONS: readonly CloudSyncCollectionName[] = [
  "items",
  "folders",
  "spaces",
  "spaceGroups",
  "tags",
  "itemTags",
];

const isCloudSyncCollection = (value: unknown): value is CloudSyncCollectionName =>
  typeof value === "string" && CLOUD_SYNC_COLLECTIONS.includes(value as CloudSyncCollectionName);

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
  doc: Record<string, unknown> | null;
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
    | "missing-token"
    | "invalid-auth"
    | "http-error"
    | "network-error"
    | "invalid-response";
  error?: string;
};

export type CloudSyncServiceOptions = {
  fetcher?: typeof fetch;
  getCollectionResolver?: () => Promise<CloudSyncCollectionResolver>;
  getCredentials?: (forceRefresh?: boolean) => Promise<CloudAuthCredentials>;
};

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const clampTimestamp = (value: unknown, fallback: number): number => {
  if (!Number.isFinite(value)) return fallback;
  return Math.max(0, Math.min(Number.MAX_SAFE_INTEGER - 1, Math.floor(value as number)));
};

const queueKey = (ref: Pick<CloudSyncQueueRef, "collection" | "id">): string => `${ref.collection}:${ref.id}`;

const boundedPositiveInteger = (value: unknown, fallback: number, maximum: number): number => {
  const candidate = Number.isFinite(value) ? Math.floor(value as number) : fallback;
  return Math.max(1, Math.min(maximum, candidate));
};

type ParsedCloudSyncPushResult = {
  applied: number;
  conflicts: number;
  acknowledgements: Array<string | CloudSyncEntityRef>;
};

const parseEntityRefList = (value: unknown): CloudSyncEntityRef[] | null => {
  if (!Array.isArray(value)) return null;
  const refs: CloudSyncEntityRef[] = [];
  for (const entry of value) {
    if (!isObject(entry) || !isCloudSyncCollection(entry.collection) || typeof entry.id !== "string" || !entry.id) {
      return null;
    }
    refs.push({ collection: entry.collection, id: entry.id });
  }
  return refs;
};

const parseIdList = (value: unknown): string[] | null => {
  if (!Array.isArray(value) || value.some((id) => typeof id !== "string" || !id)) return null;
  return value as string[];
};

const parseCloudSyncPushResult = (
  value: unknown,
  changes: CloudSyncChange[],
): ParsedCloudSyncPushResult | null => {
  if (
    !isObject(value) ||
    !Number.isSafeInteger(value.checkpoint) ||
    (value.checkpoint as number) < 0 ||
    !Number.isSafeInteger(value.applied) ||
    (value.applied as number) < 0 ||
    !Number.isSafeInteger(value.conflicts) ||
    (value.conflicts as number) < 0
  ) return null;

  const applied = value.applied as number;
  const conflicts = value.conflicts as number;
  if (applied + conflicts !== changes.length) return null;

  const changeByKey = new Map(changes.map((change) => [queueKey(change), change]));
  const changeById = new Map(changes.map((change) => [change.id, change]));
  if (changeByKey.size !== changes.length || changeById.size !== changes.length) return null;

  const qualifiedKeys = (input: unknown): Set<string> | null | undefined => {
    if (input === undefined) return undefined;
    const refs = parseEntityRefList(input);
    if (!refs) return null;
    const keys = new Set<string>();
    for (const ref of refs) {
      const key = queueKey(ref);
      if (!changeByKey.has(key) || keys.has(key)) return null;
      keys.add(key);
    }
    return keys;
  };
  const legacyKeys = (input: unknown): Set<string> | null | undefined => {
    if (input === undefined) return undefined;
    const ids = parseIdList(input);
    if (!ids) return null;
    const keys = new Set<string>();
    for (const id of ids) {
      const change = changeById.get(id);
      if (!change) return null;
      const key = queueKey(change);
      if (keys.has(key)) return null;
      keys.add(key);
    }
    return keys;
  };

  const qualified = value.acceptedRefs !== undefined || value.conflictRefs !== undefined;
  const legacy = !qualified && (value.acceptedIds !== undefined || value.conflictIds !== undefined);
  let acceptedKeys = qualified
    ? qualifiedKeys(value.acceptedRefs)
    : legacy
      ? legacyKeys(value.acceptedIds)
      : undefined;
  let conflictKeys = qualified
    ? qualifiedKeys(value.conflictRefs)
    : legacy
      ? legacyKeys(value.conflictIds)
      : undefined;
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

const normalizeRef = (ref: CloudSyncQueueRef): CloudSyncQueueRef | null => {
  if (!ref || typeof ref.id !== "string" || !ref.id) return null;
  if (!isCloudSyncCollection(ref.collection)) return null;
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

export const mergeCloudSyncQueue = (
  existing: CloudSyncQueueRef[],
  incoming: CloudSyncQueueRef[]
): CloudSyncQueueRef[] => {
  const merged = new Map<string, CloudSyncQueueRef>();
  for (const raw of existing) {
    const ref = normalizeRef(raw);
    if (ref) merged.set(queueKey(ref), ref);
  }
  for (const raw of incoming) {
    const ref = normalizeRef(raw);
    if (!ref) continue;
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

const SOCIAL_CLOUD_SOURCES = new Set<ItemDocType["source"]>([
  "twitter",
  "instagram",
  "tiktok",
  "linkedin",
  "threads",
  "mastodon",
  "bluesky",
]);

const inferCloudItemType = (item: ItemDocType): string => {
  const media = item.media || [];
  if (item.source === "github") return "repo";
  if (item.source === "youtube" || item.source === "vimeo") return "video";
  if (item.source === "spotify" || item.source === "ytmusic" || item.source === "soundcloud") return "audio";
  if (SOCIAL_CLOUD_SOURCES.has(item.source)) return "social";
  if (item.source === "reddit") return "forum";
  if (item.source === "note") return "note";
  if (item.source === "article" || item.source === "substack") return "article";
  if (media.some((entry) => entry.type === "video")) return "video";
  if (media.some((entry) => entry.type === "audio")) return "audio";
  if (media.some((entry) => entry.type === "image") || item.displayImageUrl) return "image";
  return "link";
};

const deriveCloudFields = (item: ItemDocType): Record<string, unknown> => {
  const existing = isObject((item as any).fields) ? { ...((item as any).fields as Record<string, unknown>) } : {};
  if (!existing.description && item.textContent && inferCloudItemType(item) === "link") {
    existing.description = item.textContent;
  }
  if (item.source === "github") {
    if (!existing.owner && item.authorUsername) existing.owner = item.authorUsername;
    if (!existing.stars && Number.isFinite(item.likes)) existing.stars = item.likes;
  }
  if (item.source === "reddit") {
    if (!existing.author && item.authorUsername) existing.author = item.authorUsername;
    if (!existing.upvotes && Number.isFinite(item.upvotes)) existing.upvotes = item.upvotes;
  }
  if (SOCIAL_CLOUD_SOURCES.has(item.source)) {
    if (!existing.platform) existing.platform = item.source;
    if (!existing.author && item.authorUsername) existing.author = item.authorUsername;
    if (!existing.likes && Number.isFinite(item.likes)) existing.likes = item.likes;
  }
  return existing;
};

export const normalizeCloudDoc = (
  collection: CloudSyncCollectionName,
  doc: ItemDocType | FolderDocType | SpaceDocType | SpaceGroupDocType | TagDocType | ItemTagDocType,
  cloudUserId = "",
): Record<string, unknown> => {
  const stamped = (value: Record<string, unknown>): Record<string, unknown> => ({
    ...value,
    [CLOUD_SYNC_ORIGIN_FIELD]: CLOUD_SYNC_ORIGIN_EXTENSION,
  });
  return stamped(normalizeCloudDocFields(collection, doc, cloudUserId));
};

const normalizeCloudDocFields = (
  collection: CloudSyncCollectionName,
  doc: ItemDocType | FolderDocType | SpaceDocType | SpaceGroupDocType | TagDocType | ItemTagDocType,
  cloudUserId = "",
): Record<string, unknown> => {
  if (collection === "items") {
    const item = doc as ItemDocType;
    const itemType = typeof (item as any).type === "string" && (item as any).type ? (item as any).type : inferCloudItemType(item);
    return {
      ...item,
      userId: cloudUserId || item.userId || null,
      type: itemType,
      fields: deriveCloudFields(item),
    };
  }
  if (collection === "spaceGroups") {
    const group = doc as SpaceGroupDocType;
    return { ...group, parentGroupId: group.parentGroupId ?? null };
  }
  if (collection === "tags" || collection === "itemTags") {
    return {
      ...(doc as Record<string, unknown>),
      userId: cloudUserId || ((doc as any).userId as string | null | undefined) || null,
    };
  }
  if (collection === "folders") {
    return {
      ...(doc as Record<string, unknown>),
      userId: cloudUserId || ((doc as FolderDocType).userId as string | null | undefined) || null,
    };
  }
  return { ...(doc as Record<string, unknown>) };
};

const refsFromDocs = <T extends { id: string; updatedAt?: number; deletedAt?: number }>(
  collection: CloudSyncCollectionName,
  docs: T[] | undefined,
  now: number
): CloudSyncQueueRef[] =>
  (docs || [])
    .filter((doc) => typeof doc?.id === "string" && doc.id.length > 0)
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

/** Convert RxDB bulk/single change events into compact live refs or tombstones. */
export const cloudSyncRefsForRxChange = (
  collection: CloudSyncCollectionName,
  changeEvent: unknown,
  now = Date.now(),
): CloudSyncQueueRef[] => {
  const queuedAt = clampTimestamp(now, Date.now());
  const envelope = isObject(changeEvent) ? changeEvent : {};
  const events = Array.isArray(envelope.events) ? envelope.events : [envelope];
  const refs: CloudSyncQueueRef[] = [];

  for (const candidate of events) {
    if (!isObject(candidate)) continue;
    const documentData = isObject(candidate.documentData) ? candidate.documentData : null;
    const previousDocumentData = isObject(candidate.previousDocumentData)
      ? candidate.previousDocumentData
      : null;
    const deleted = candidate.operation === "DELETE" || documentData?._deleted === true;
    const source = deleted ? previousDocumentData ?? documentData : documentData ?? previousDocumentData;
    const rawId = source?.id ?? candidate.documentId;
    const id = typeof rawId === "string" && rawId.trim() ? rawId : "";
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
    if (typeof acknowledgement === "string") acknowledgedIds.add(acknowledgement);
    else acknowledgedRefs.add(queueKey(acknowledgement));
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

const storageAvailable = (): boolean => typeof chrome !== "undefined" && Boolean(chrome.storage?.local);

const storageGet = async <T>(key: string, fallback: T): Promise<T> => {
  if (!storageAvailable()) return fallback;
  const row = await chrome.storage.local.get(key);
  return (row?.[key] as T | undefined) ?? fallback;
};

const storageSet = async (key: string, value: unknown): Promise<void> => {
  if (!storageAvailable()) return;
  await chrome.storage.local.set({ [key]: value });
};

const storageRemove = async (key: string): Promise<void> => {
  if (!storageAvailable()) return;
  if (typeof chrome.storage.local.remove === "function") {
    await chrome.storage.local.remove(key);
    return;
  }
  await chrome.storage.local.set({ [key]: [] });
};

const readQueue = async (): Promise<CloudSyncQueueRef[]> => {
  const raw = await storageGet<unknown[]>(CLOUD_SYNC_QUEUE_KEY, []);
  return Array.isArray(raw) ? mergeCloudSyncQueue(raw as CloudSyncQueueRef[], []) : [];
};

/**
 * Queue mutations only need to preserve the already-normalized durable order.
 * Re-normalizing and sorting the entire remaining outbox after every ten-row
 * acknowledgement turns a large drain quadratic. Keep a strict shape guard,
 * while reserving full dedupe/normalization for queue hydration and enqueue.
 */
const readQueueForMutation = async (): Promise<CloudSyncQueueRef[]> => {
  const raw = await storageGet<unknown[]>(CLOUD_SYNC_QUEUE_KEY, []);
  if (!Array.isArray(raw)) return [];
  return raw.filter((value): value is CloudSyncQueueRef =>
    isObject(value) &&
    isCloudSyncCollection(value.collection) &&
    typeof value.id === "string" &&
    value.id.length > 0 &&
    Number.isFinite(value.updatedAt) &&
    Number.isFinite(value.deletedAt) &&
    Number.isFinite(value.queuedAt)
  );
};

const writeQueue = async (queue: CloudSyncQueueRef[]): Promise<void> => {
  await storageSet(CLOUD_SYNC_QUEUE_KEY, queue);
};

// Chrome storage has atomic writes but no compare-and-swap. Keep only the
// read-modify-write sections serial so concurrent local edits cannot overwrite
// each other's outbox entries while network work remains fully asynchronous.
let queueMutationTail: Promise<void> = Promise.resolve();

const withQueueMutationLock = async <T>(operation: () => Promise<T>): Promise<T> => {
  let release!: () => void;
  const previous = queueMutationTail;
  queueMutationTail = new Promise<void>((resolve) => {
    release = resolve;
  });
  await previous;
  try {
    return await operation();
  } finally {
    release();
  }
};

const getClientId = async (): Promise<string> => {
  const existing = (await storageGet<string>(CLOUD_SYNC_CLIENT_ID_KEY, "")).trim();
  if (existing) return existing;
  const id = typeof crypto?.randomUUID === "function" ? crypto.randomUUID() : `client-${Date.now()}-${Math.random()}`;
  await storageSet(CLOUD_SYNC_CLIENT_ID_KEY, id);
  return id;
};

const getApiBase = async (): Promise<string> => {
  const configured = (await storageGet<string>(CLOUD_SYNC_API_BASE_KEY, "")).trim().replace(/\/+$/, "");
  return configured || DEFAULT_VIBESEARCH_API_BASE;
};

const getToken = (): Promise<string> => getCloudAuthToken();

export const isCloudPullEnabled = async (): Promise<boolean> =>
  (await storageGet<boolean>(CLOUD_PULL_ENABLED_KEY, false)) === true;

export const setCloudPullEnabled = async (enabled: boolean): Promise<void> => {
  await storageSet(CLOUD_PULL_ENABLED_KEY, enabled === true);
};

const readPullState = async (userId = ""): Promise<CloudSyncPullState> => {
  const raw = await storageGet<unknown>(CLOUD_SYNC_PULL_STATE_KEY, null);
  if (!isObject(raw)) return { checkpoint: 0, ...(userId ? { userId } : {}) };
  const storedUserId = typeof raw.userId === "string" ? raw.userId : "";
  // A different account — or a checkpoint written before accounts were recorded
  // — must start from scratch instead of inheriting a foreign sequence number.
  if (userId && storedUserId !== userId) return { checkpoint: 0, userId };
  const checkpoint = Number.isSafeInteger(raw.checkpoint) && Number(raw.checkpoint) >= 0
    ? Number(raw.checkpoint)
    : 0;
  const cursor = typeof raw.bootstrapCursor === "string" && raw.bootstrapCursor.trim()
    ? raw.bootstrapCursor.trim()
    : undefined;
  return {
    checkpoint,
    ...(cursor ? { bootstrapCursor: cursor } : {}),
    ...(storedUserId ? { userId: storedUserId } : {}),
  };
};

/** Forget the read position, e.g. on disconnect or a local data reset. */
export const clearCloudPullState = async (): Promise<void> => {
  await storageSet(CLOUD_SYNC_PULL_STATE_KEY, { checkpoint: 0 });
};

const writePullState = async (state: CloudSyncPullState): Promise<void> => {
  await storageSet(CLOUD_SYNC_PULL_STATE_KEY, state);
};

/**
 * Trim a server document to what the local schema actually accepts.
 *
 * The cloud carries fields this device has no column for, and RxDB rejects a
 * whole insert over one stray key. Reading `properties` at runtime means schema
 * drift never turns into a failed sync. A row missing a required field is
 * skipped rather than repaired with invented values.
 */
export const localizePulledDoc = (
  doc: Record<string, unknown>,
  schema?: CloudSyncLocalCollection["schema"],
): Record<string, unknown> | null => {
  const properties = schema?.jsonSchema?.properties;
  const localized: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(doc)) {
    if (!properties || key in properties) localized[key] = value;
  }
  // Local bookkeeping the server never sends: a pulled row is already in sync.
  if ((!properties || "isDirty" in properties) && localized.isDirty === undefined) {
    localized.isDirty = false;
  }
  // Vector slots are offsets into THIS device's vector store. Carrying another
  // device's offset over would point the row at a local neighbour's embedding
  // and silently corrupt semantic search, so a pulled row enters the normal
  // embedding queue exactly like a restored or imported one does.
  for (const [key, value] of Object.entries(PULLED_DEVICE_LOCAL_FIELDS)) {
    if (!properties || key in properties) localized[key] = value;
  }
  for (const key of schema?.jsonSchema?.required ?? []) {
    if (localized[key] === undefined) return null;
  }
  return localized;
};

/**
 * Fields whose values only mean something on the device that wrote them. Kept
 * in step with the other cross-device ingestion paths (share restore, backup
 * restore, bookmark and star imports).
 */
const PULLED_DEVICE_LOCAL_FIELDS: Record<string, unknown> = {
  vector_index: -1,
  vector_indexes: [],
  isEmbedded: false,
  isDirty: false,
};

const collectionForRef = (db: any, collection: CloudSyncCollectionName) => {
  if (collection === "spaceGroups") return db.space_groups;
  if (collection === "itemTags") return db.item_tags;
  return db[collection];
};

type CloudSyncLocalRecord = Record<string, unknown>;

export type CloudSyncLocalDocument = {
  primary?: string;
  get?(field: string): unknown;
  toMutableJSON(): CloudSyncLocalRecord;
};

export type CloudSyncLocalCollection = {
  findByIds(ids: string[]): { exec(): Promise<Map<string, CloudSyncLocalDocument>> };
  find?(query: {
    selector: Record<string, unknown>;
    sort?: Array<{ id: "asc" }>;
    limit?: number;
  }): { exec(): Promise<CloudSyncLocalDocument[]> };
  /** Used by a pull to add rows this device has never seen. */
  bulkInsert?(docs: Record<string, unknown>[]): Promise<{ error?: unknown[] } | unknown>;
  /** Read at runtime so an incoming doc is trimmed to what this schema accepts. */
  schema?: { jsonSchema?: { properties?: Record<string, unknown>; required?: string[] } };
};

export type CloudSyncCollectionResolver = (collection: CloudSyncCollectionName) => CloudSyncLocalCollection;

const buildCloudSyncChanges = async (
  refs: CloudSyncQueueRef[],
  resolveCollection: CloudSyncCollectionResolver,
  cloudUserId: string,
): Promise<CloudSyncChange[]> => {
  const refsByCollection = new Map<CloudSyncCollectionName, CloudSyncQueueRef[]>();
  for (const ref of refs) {
    if (ref.deletedAt > 0) continue;
    const grouped = refsByCollection.get(ref.collection) ?? [];
    grouped.push(ref);
    refsByCollection.set(ref.collection, grouped);
  }

  const documentsByKey = new Map<string, CloudSyncLocalRecord>();
  await Promise.all(
    Array.from(refsByCollection.entries()).map(async ([collection, collectionRefs]) => {
      const ids = Array.from(new Set(collectionRefs.map((ref) => ref.id)));
      const found = await resolveCollection(collection).findByIds(ids).exec();
      for (const [id, document] of found) {
        documentsByKey.set(`${collection}:${id}`, document.toMutableJSON());
      }
    }),
  );

  const changes: CloudSyncChange[] = [];
  for (const ref of refs) {
    if (ref.deletedAt > 0) {
      changes.push({
        collection: ref.collection,
        id: ref.id,
        doc: null,
        updatedAt: ref.updatedAt,
        deletedAt: ref.deletedAt,
      });
      continue;
    }
    const doc = documentsByKey.get(queueKey(ref));
    if (!doc) continue;
    changes.push({
      collection: ref.collection,
      id: ref.id,
      doc: normalizeCloudDoc(ref.collection, doc as never, cloudUserId),
      updatedAt: clampTimestamp(doc.updatedAt, ref.updatedAt),
      deletedAt: clampTimestamp(doc.deletedAt, 0),
    });
  }
  return changes;
};

const removeQueueRefs = async (refs: CloudSyncQueueRef[]): Promise<CloudSyncQueueRef[]> => {
  return withQueueMutationLock(async () => {
    const current = await readQueueForMutation();
    const next = removeAcknowledgedQueueRefs(current, refs);
    await writeQueue(next);
    return next;
  });
};

const notifyCloudSyncQueueUpdated = (): void => {
  try {
    const result = chrome.runtime.sendMessage({ target: "background", type: "CLOUD_SYNC_QUEUED" });
    if (result && typeof (result as Promise<unknown>).catch === "function") {
      void (result as Promise<unknown>).catch(() => {});
    }
  } catch {
    // The service is also used in tests and contexts without extension runtime messaging.
  }
};

let drainInFlight: Promise<CloudSyncDrainResult> | null = null;
let drainController: AbortController | null = null;
let drainGeneration = 0;
const CLOUD_SYNC_REQUEST_TIMEOUT_MS = 30_000;
const CLOUD_SYNC_MAX_RESPONSE_BYTES = 1024 * 1024;

const readBoundedCloudSyncJson = async (
  response: Response,
  signal: AbortSignal,
): Promise<unknown> => {
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > CLOUD_SYNC_MAX_RESPONSE_BYTES) {
    await response.body?.cancel().catch(() => {});
    throw new Error("CLOUD_SYNC_RESPONSE_TOO_LARGE");
  }
  if (!response.body) {
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.byteLength > CLOUD_SYNC_MAX_RESPONSE_BYTES) {
      throw new Error("CLOUD_SYNC_RESPONSE_TOO_LARGE");
    }
    try {
      return JSON.parse(new TextDecoder().decode(bytes));
    } catch {
      return null;
    }
  }

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let byteSize = 0;
  const cancel = () => void reader.cancel().catch(() => {});
  signal.addEventListener("abort", cancel, { once: true });
  try {
    while (true) {
      if (signal.aborted) throw new DOMException("Aborted", "AbortError");
      const { done, value } = await reader.read();
      if (signal.aborted) throw new DOMException("Aborted", "AbortError");
      if (done) break;
      if (!value?.byteLength) continue;
      byteSize += value.byteLength;
      if (byteSize > CLOUD_SYNC_MAX_RESPONSE_BYTES) {
        await reader.cancel().catch(() => {});
        throw new Error("CLOUD_SYNC_RESPONSE_TOO_LARGE");
      }
      chunks.push(value);
    }
  } finally {
    signal.removeEventListener("abort", cancel);
    reader.releaseLock();
  }
  const bytes = new Uint8Array(byteSize);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    return null;
  }
};

/**
 * Every spelling of one URL that `itemDedupeKey` treats as the same page.
 *
 * `url` is stored verbatim, so an exact-match lookup would miss the local row
 * that differs only by a trailing slash, a fragment, or host case. Listing the
 * handful of equivalent spellings keeps the dedupe check honest without needing
 * a normalized column to query.
 */
export const equivalentUrlSpellings = (rawUrl: string): string[] => {
  const spellings = new Set<string>([rawUrl]);
  try {
    const parsed = new URL(rawUrl);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return [...spellings];
    parsed.hash = "";
    parsed.hostname = parsed.hostname.toLowerCase();
    const withSlash = parsed.toString();
    spellings.add(withSlash);
    const trimmedPath = parsed.pathname.length > 1 ? parsed.pathname.replace(/\/+$/, "") : parsed.pathname;
    spellings.add(`${parsed.protocol}//${parsed.host}${trimmedPath}${parsed.search}`);
    spellings.add(`${parsed.protocol}//${parsed.host}${trimmedPath}/${parsed.search}`);
  } catch {
    // A URL the local store could only hold verbatim.
  }
  return [...spellings];
};

/** Validate a pull page before it is allowed to touch the local database. */
export const normalizePulledPage = (value: unknown): {
  changes: CloudPullChange[];
  checkpoint: number;
  hasMore: boolean;
  bootstrap?: { complete: boolean; cursor?: string };
} | null => {
  if (!isObject(value) || !Array.isArray(value.changes)) return null;
  if (!Number.isSafeInteger(value.checkpoint) || Number(value.checkpoint) < 0) return null;
  if (typeof value.hasMore !== "boolean") return null;

  const changes: CloudPullChange[] = [];
  for (const raw of value.changes) {
    if (!isObject(raw) || !isCloudSyncCollection(raw.collection)) continue;
    if (typeof raw.id !== "string" || !raw.id.trim()) continue;
    changes.push({
      collection: raw.collection,
      id: raw.id,
      doc: isObject(raw.doc) ? raw.doc : null,
      updatedAt: clampTimestamp(raw.updatedAt, 0),
      deletedAt: clampTimestamp(raw.deletedAt, 0),
    });
  }

  const bootstrap = isObject(value.bootstrap)
    ? {
        complete: value.bootstrap.complete === true,
        ...(typeof value.bootstrap.cursor === "string" && value.bootstrap.cursor
          ? { cursor: value.bootstrap.cursor }
          : {}),
      }
    : undefined;

  return {
    changes,
    checkpoint: Number(value.checkpoint),
    hasMore: value.hasMore,
    ...(bootstrap ? { bootstrap } : {}),
  };
};

/**
 * Apply one validated page.
 *
 * The local index is built from just this page's ids and URLs rather than the
 * whole library, so a pull costs the same whether the device holds ten items or
 * fifty thousand.
 */
const applyPulledChanges = async (
  changes: CloudPullChange[],
  resolveCollection: CloudSyncCollectionResolver,
): Promise<{ inserted: number; skipped: number; rejected: number }> => {
  if (changes.length === 0) return { inserted: 0, skipped: 0, rejected: 0 };

  const byCollection = new Map<CloudSyncCollectionName, CloudPullChange[]>();
  for (const change of changes) {
    const grouped = byCollection.get(change.collection) ?? [];
    grouped.push(change);
    byCollection.set(change.collection, grouped);
  }

  // What does this device already hold, among exactly these rows?
  const ids: Partial<Record<CloudSyncCollectionName, Set<string>>> = {};
  await Promise.all(
    Array.from(byCollection.entries()).map(async ([collection, group]) => {
      const found = await resolveCollection(collection)
        .findByIds(Array.from(new Set(group.map((change) => change.id))))
        .exec();
      ids[collection] = new Set(found.keys());
    }),
  );

  // And which of the incoming pages are already saved under a different id?
  // The lookup has to cover every spelling that normalizes to the same key,
  // otherwise itemDedupeKey's normalization is dead in the real path and
  // "https://host/page/" gets saved a second time as "https://host/page".
  const incomingUrls = Array.from(new Set(
    (byCollection.get("items") ?? []).flatMap((change) =>
      typeof change.doc?.url === "string" ? equivalentUrlSpellings(change.doc.url) : []),
  ));
  let itemKeys = new Set<string>();
  if (incomingUrls.length > 0) {
    const items = resolveCollection("items");
    const existing = await items.find?.({
      // A binned row must not block re-adding the page, matching how the rest of
      // the app queries live items.
      selector: { url: { $in: incomingUrls }, deletedAt: { $eq: 0 } },
    }).exec();
    itemKeys = cloudPullItemKeys((existing ?? []).map((document) => document.toMutableJSON()));
  }

  const plan = planCloudPullMerge(changes, { ids, itemKeys });
  let inserted = 0;
  let rejected = 0;
  for (const [collection, group] of groupInserts(plan.inserts)) {
    const target = resolveCollection(collection);
    const docs = group
      .map((change) => localizePulledDoc(change.doc as Record<string, unknown>, target.schema))
      .filter((doc): doc is Record<string, unknown> => doc !== null);
    rejected += group.length - docs.length;
    if (docs.length === 0 || !target.bulkInsert) {
      rejected += docs.length;
      continue;
    }
    // RxDB bulk writes report per-row outcomes instead of throwing, so a
    // conflict must not be counted as an insert (the checkpoint would advance
    // past a row that was never written).
    const outcome = await target.bulkInsert(docs);
    const failures = Array.isArray((outcome as { error?: unknown[] })?.error)
      ? (outcome as { error: unknown[] }).error.length
      : 0;
    inserted += Math.max(0, docs.length - failures);
    rejected += failures;
  }

  return {
    inserted,
    skipped: Math.max(0, changes.length - inserted - rejected),
    rejected,
  };
};

const groupInserts = (inserts: CloudPullChange[]): Map<CloudSyncCollectionName, CloudPullChange[]> => {
  // Parents before children: a folder's space must exist before the folder does.
  const order: CloudSyncCollectionName[] = ["spaceGroups", "spaces", "folders", "tags", "items", "itemTags"];
  const grouped = new Map<CloudSyncCollectionName, CloudPullChange[]>();
  for (const collection of order) {
    const group = inserts.filter((change) => change.collection === collection);
    if (group.length > 0) grouped.set(collection, group);
  }
  return grouped;
};

export class CloudSyncService {
  constructor(private readonly options: CloudSyncServiceOptions = {}) {}

  private async getCollectionResolver(): Promise<CloudSyncCollectionResolver> {
    if (this.options.getCollectionResolver) return this.options.getCollectionResolver();
    const db = await getDb();
    return (collection) => collectionForRef(db, collection);
  }

  private request(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
    // Bound like archive-preview: a detached fetch reference throws
    // "Illegal invocation" in window contexts.
    return (this.options.fetcher ?? fetch.bind(globalThis))(input, init);
  }

  async enqueueDocs(docs: CloudSyncDocBatch): Promise<{ queued: number; added: number }> {
    const refs = cloudSyncRefsForDocs(docs).map(normalizeRef).filter((ref): ref is CloudSyncQueueRef => ref !== null);
    return this.enqueueRefs(refs);
  }

  async enqueueRxChange(
    collection: CloudSyncCollectionName,
    changeEvent: unknown,
  ): Promise<{ queued: number; added: number }> {
    return this.enqueueRefs(cloudSyncRefsForRxChange(collection, changeEvent));
  }

  private async enqueueRefs(
    refs: CloudSyncQueueRef[],
    notify = true,
  ): Promise<{ queued: number; added: number }> {
    if (refs.length === 0) {
      const queue = await readQueue();
      return { queued: queue.length, added: 0 };
    }
    const result = await withQueueMutationLock(async () => {
      const current = await readQueue();
      const next = mergeCloudSyncQueue(current, refs);
      await writeQueue(next);
      return { queued: next.length, added: refs.length };
    });
    if (notify) notifyCloudSyncQueueUpdated();
    return result;
  }

  /**
   * Explicitly backfill every local syncable collection, then drain a bounded
   * first run. Remaining work stays in the durable queue and the background
   * continuation alarm resumes it. Authentication is refreshed before any
   * local document is read so a disconnected account cannot accidentally
   * stage a full-library upload.
   */
  /**
   * Read this account's changes from other devices and add what is missing.
   *
   * Additive by construction (see `planCloudPullMerge`): nothing local is
   * overwritten or deleted, so a pull needs no conflict resolution. The
   * checkpoint only advances after a page has been applied, so an interrupted
   * run re-reads that page instead of skipping it.
   */
  async pull(payload: { maxPages?: number } = {}): Promise<CloudSyncPullResult> {
    const maxPages = Math.max(1, Math.min(
      CLOUD_SYNC_PULL_MAX_PAGES,
      Math.floor(payload.maxPages ?? 4),
    ));
    // Backup is one-way out of this extension unless the user turned the return
    // direction on, so the default costs no network call at all.
    const enabled = await isCloudPullEnabled();
    const credentials = enabled
      ? await (this.options.getCredentials ?? getCloudAuthCredentials)()
      : { token: "", userId: "" };
    // The read position belongs to one account: sequence numbers are per user,
    // so another account's checkpoint would silently skip its whole library.
    let state = await readPullState(credentials.userId);
    const result: CloudSyncPullResult = {
      inserted: 0,
      skipped: 0,
      rejected: 0,
      pages: 0,
      checkpoint: state.checkpoint,
      hasMore: false,
    };
    if (!enabled) return { ...result, reason: "disabled" };
    if (!credentials.token) return { ...result, reason: "missing-token" };
    const [apiBase, clientId] = await Promise.all([getApiBase(), getClientId()]);
    const resolveCollection = await this.getCollectionResolver();

    while (result.pages < maxPages) {
      const query = new URLSearchParams({
        since: String(state.checkpoint),
        limit: String(CLOUD_SYNC_PULL_PAGE_SIZE),
        clientId,
      });
      if (state.bootstrapCursor) query.set("cursor", state.bootstrapCursor);

      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), CLOUD_SYNC_REQUEST_TIMEOUT_MS);
      let body: unknown;
      try {
        const response = await this.request(`${apiBase}/v1/sync/pull?${query}`, {
          method: "GET",
          headers: { authorization: `Bearer ${credentials.token}`, accept: "application/json" },
          credentials: "omit",
          cache: "no-store",
          signal: controller.signal,
        });
        if (response.status === 401 || response.status === 403) {
          await response.body?.cancel().catch(() => {});
          return { ...result, reason: "invalid-auth" };
        }
        if (!response.ok) {
          await response.body?.cancel().catch(() => {});
          return { ...result, reason: "http-error", error: `${response.status} ${response.statusText}`.trim() };
        }
        body = await readBoundedCloudSyncJson(response, controller.signal);
      } catch (cause) {
        return {
          ...result,
          reason: "network-error",
          error: cause instanceof Error ? cause.message : "pull failed",
        };
      } finally {
        clearTimeout(timeout);
      }

      const page = normalizePulledPage(body);
      if (!page) return { ...result, reason: "invalid-response" };

      const applied = await applyPulledChanges(page.changes, resolveCollection);
      result.inserted += applied.inserted;
      result.skipped += applied.skipped;
      result.rejected += applied.rejected;
      result.pages += 1;

      // Only now is it safe to forget this page.
      state = {
        // Never move backwards: a repeated checkpoint must not rewind this
        // device's read position.
        checkpoint: Math.max(state.checkpoint, page.checkpoint),
        ...(page.bootstrap && !page.bootstrap.complete && page.bootstrap.cursor
          ? { bootstrapCursor: page.bootstrap.cursor }
          : {}),
        ...(credentials.userId ? { userId: credentials.userId } : {}),
      };
      await writePullState(state);
      result.checkpoint = state.checkpoint;
      result.hasMore = page.hasMore;
      if (!page.hasMore) break;
    }

    if (result.pages === 0) return { ...result, reason: "empty" };
    return result;
  }

  /**
   * Whether each item is backed up, per this device's own records.
   *
   * The queue is the source of truth: an item leaves it only when the server has
   * acknowledged it. So "queued" means waiting, absence means acknowledged, and
   * without a session nothing is backed up at all. No extra bookkeeping to drift
   * out of step with reality.
   */
  async itemSyncState(itemIds: string[]): Promise<Record<string, CloudSyncItemState>> {
    const ids = Array.from(new Set(itemIds.filter((id) => typeof id === "string" && id.trim())));
    const state: Record<string, CloudSyncItemState> = {};
    if (ids.length === 0) return state;

    const credentials = await (this.options.getCredentials ?? getCloudAuthCredentials)();
    if (!credentials.token) {
      for (const id of ids) state[id] = "not-connected";
      return state;
    }

    const queued = new Set(
      (await readQueue())
        .filter((ref) => ref.collection === "items")
        .map((ref) => ref.id),
    );
    for (const id of ids) state[id] = queued.has(id) ? "pending" : "synced";
    return state;
  }

  async syncAll(payload: CloudSyncAllOptions = {}): Promise<CloudSyncAllResult> {
    const credentials = this.options.getCredentials
      ? await this.options.getCredentials(true)
      : await getCloudAuthCredentials(true);
    if (!credentials.token || !credentials.userId) {
      throw new Error("CLOUD_SYNC_AUTH_REQUIRED");
    }

    const resolveCollection = await this.getCollectionResolver();
    const pageSize = boundedPositiveInteger(payload.pageSize, 250, 1_000);
    const refs: CloudSyncQueueRef[] = [];
    let scanned = 0;

    for (const collection of CLOUD_SYNC_COLLECTIONS) {
      const localCollection = resolveCollection(collection);
      if (typeof localCollection.find !== "function") {
        throw new Error(`CLOUD_SYNC_SCAN_UNAVAILABLE:${collection}`);
      }
      scanned += await forEachIdKeysetPage({
        collection: localCollection as Required<Pick<CloudSyncLocalCollection, "find">>,
        selector: {},
        pageSize,
        onPage: (documents) => {
          const queuedAt = Date.now();
          for (const document of documents) {
            const row = document.toMutableJSON();
            const rawId = typeof row.id === "string"
              ? row.id
              : typeof document.primary === "string"
                ? document.primary
                : document.get?.("id");
            const id = typeof rawId === "string" && rawId.trim() ? rawId : "";
            if (!id) continue;
            const normalized = normalizeRef({
              collection,
              id,
              updatedAt: clampTimestamp(row.updatedAt, queuedAt),
              deletedAt: clampTimestamp(row.deletedAt, 0),
              queuedAt,
            });
            if (normalized) refs.push(normalized);
          }
        },
      });
    }

    const queued = await this.enqueueRefs(refs, false);
    const push = await this.drain({
      maxBatches: payload.maxBatches,
      expectedUserId: credentials.userId,
    });
    return {
      scanned,
      enqueued: refs.length,
      queued: queued.queued,
      push,
    };
  }

  async status(): Promise<{ queued: number; hasToken: boolean; apiBase: string }> {
    const [queue, token, apiBase] = await Promise.all([readQueue(), getToken(), getApiBase()]);
    return { queued: queue.length, hasToken: Boolean(token), apiBase };
  }

  async drain(payload?: CloudSyncBatchOptions): Promise<CloudSyncDrainResult> {
    if (drainInFlight) {
      if (!payload?.expectedUserId) return drainInFlight;
      await drainInFlight;
      return this.drain(payload);
    }
    const generation = drainGeneration;
    const controller = new AbortController();
    drainController = controller;
    drainInFlight = this.drainInternal(payload, controller.signal, generation).finally(() => {
      drainInFlight = null;
      if (drainController === controller) drainController = null;
    });
    return drainInFlight;
  }

  async cancelAndClear(): Promise<void> {
    drainGeneration += 1;
    drainController?.abort();
    await drainInFlight?.catch(() => {});
    await withQueueMutationLock(() => storageRemove(CLOUD_SYNC_QUEUE_KEY));
    // The read position describes a library that no longer exists here; keeping
    // it would make every already-pulled row invisible to a future pull.
    await clearCloudPullState();
  }

  /** Ensure one local item reaches the API before a dependent archive upload. */
  async pushItem(itemIdRaw: string): Promise<CloudSyncPushItemResult> {
    const itemId = typeof itemIdRaw === "string" && itemIdRaw.trim() ? itemIdRaw : "";
    if (!itemId) return { ready: false, reason: "missing-local-item" };
    const resolveCollection = await this.getCollectionResolver();
    const found = await resolveCollection("items").findByIds([itemId]).exec();
    const document = found.get(itemId);
    if (!document) return { ready: false, reason: "missing-local-item" };

    await this.enqueueDocs({ items: [document.toMutableJSON() as ItemDocType] });
    const push = await this.drain({
      batchSize: 10,
      maxBatches: 1,
      priorityRefs: [{ collection: "items", id: itemId }],
    });
    const pending = (await readQueue()).some((ref) => ref.collection === "items" && ref.id === itemId);
    return pending
      ? { ready: false, reason: "still-queued", push }
      : { ready: true, push };
  }

  private async drainInternal(
    payload: CloudSyncBatchOptions | undefined,
    signal: AbortSignal,
    generation: number,
  ): Promise<CloudSyncDrainResult> {
    const credentials = this.options.getCredentials
      ? await this.options.getCredentials()
      : await getCloudAuthCredentials();
    const token = credentials.token;
    let queue = await readQueue();
    const initialQueued = queue.length;
    if (queue.length === 0) {
      return { pushed: 0, skipped: 0, conflicts: 0, batches: 0, queued: 0, remaining: 0, reason: "empty" };
    }
    if (!token) {
      return {
        pushed: 0,
        skipped: 0,
        conflicts: 0,
        batches: 0,
        queued: initialQueued,
        remaining: initialQueued,
        reason: "missing-token",
      };
    }
    if (!credentials.userId) {
      return {
        pushed: 0,
        skipped: 0,
        conflicts: 0,
        batches: 0,
        queued: initialQueued,
        remaining: initialQueued,
        reason: "invalid-auth",
        error: "Cloud account identity is unavailable.",
      };
    }
    if (payload?.expectedUserId && credentials.userId !== payload.expectedUserId) {
      return {
        pushed: 0,
        skipped: 0,
        conflicts: 0,
        batches: 0,
        queued: initialQueued,
        remaining: initialQueued,
        reason: "invalid-auth",
        error: "Cloud account changed during sync.",
      };
    }

    const batchSize = boundedPositiveInteger(
      payload?.batchSize,
      CLOUD_SYNC_PUSH_BATCH_SIZE,
      CLOUD_SYNC_PUSH_BATCH_MAX,
    );
    const maxBatches = Number.isFinite(payload?.maxBatches)
      ? Math.max(1, Math.floor(payload?.maxBatches as number))
      : 25;
    const apiBase = await getApiBase();
    const clientId = await getClientId();
    const resolveCollection = await this.getCollectionResolver();
    let pushed = 0;
    let skipped = 0;
    let conflicts = 0;
    let batches = 0;

    const cancelled = (): CloudSyncDrainResult => ({
      pushed,
      skipped,
      conflicts,
      batches,
      queued: initialQueued,
      remaining: queue.length,
      reason: "cancelled",
    });

    while (queue.length > 0 && batches < maxBatches) {
      if (signal.aborted || generation !== drainGeneration) return cancelled();
      const refs = selectCloudSyncBatch(queue, batchSize, payload?.priorityRefs);
      const changes = await buildCloudSyncChanges(refs, resolveCollection, credentials.userId);
      if (signal.aborted || generation !== drainGeneration) return cancelled();
      const missingRefs = refs.filter((ref) => !changes.some((change) => change.collection === ref.collection && change.id === ref.id));
      if (missingRefs.length > 0) {
        skipped += missingRefs.length;
        queue = await removeQueueRefs(missingRefs);
      }
      if (changes.length === 0) {
        continue;
      }

      let response: Response;
      let responseBody: unknown = null;
      const requestController = new AbortController();
      let requestTimedOut = false;
      const forwardAbort = () => requestController.abort();
      signal.addEventListener("abort", forwardAbort, { once: true });
      const requestTimeout = setTimeout(() => {
        requestTimedOut = true;
        requestController.abort();
      }, CLOUD_SYNC_REQUEST_TIMEOUT_MS);
      try {
        response = await this.request(`${apiBase}/v1/sync/push`, {
          method: "POST",
          headers: {
            authorization: `Bearer ${token}`,
            "content-type": "application/json",
          },
          body: JSON.stringify({ clientId, changes }),
          signal: requestController.signal,
        });
        if (response.ok) {
          responseBody = await readBoundedCloudSyncJson(response, requestController.signal);
        } else {
          await response.body?.cancel().catch(() => {});
        }
      } catch (error) {
        if (signal.aborted || generation !== drainGeneration) return cancelled();
        return {
          pushed,
          skipped,
          conflicts,
          batches,
          queued: initialQueued,
          remaining: (await readQueue()).length,
          reason: "network-error",
          error: requestTimedOut
            ? "CLOUD_SYNC_REQUEST_TIMEOUT"
            : error instanceof Error ? error.message : "Cloud sync failed.",
        };
      } finally {
        clearTimeout(requestTimeout);
        signal.removeEventListener("abort", forwardAbort);
      }

      if (signal.aborted || generation !== drainGeneration) return cancelled();

      if (!response.ok) {
        return {
          pushed,
          skipped,
          conflicts,
          batches,
          queued: initialQueued,
          remaining: (await readQueue()).length,
          reason: "http-error",
          error: `${response.status} ${response.statusText}`.trim(),
        };
      }

      const result = parseCloudSyncPushResult(responseBody, changes);
      batches += 1;
      if (!result) {
        return {
          pushed,
          skipped,
          conflicts,
          batches,
          queued: initialQueued,
          remaining: (await readQueue()).length,
          reason: "invalid-response",
          error: "Cloud sync push returned an invalid acknowledgement.",
        };
      }

      const acknowledgedRefs = selectAcknowledgedQueueRefs(refs, result.acknowledgements);
      if (acknowledgedRefs.length === 0) {
        return {
          pushed,
          skipped,
          conflicts,
          batches,
          queued: initialQueued,
          remaining: (await readQueue()).length,
          reason: "invalid-response",
          error: "Cloud sync push did not acknowledge any requested changes.",
        };
      }

      pushed += result.applied;
      conflicts += result.conflicts;
      queue = await removeQueueRefs(acknowledgedRefs);
    }

    // A queued ref whose local document cannot be read is dropped from the queue
    // so the drain cannot spin on it forever. Reporting that as success is what
    // made a whole library look like it synced while nothing left the device: the
    // loop emptied the queue, uploaded nothing, and returned no reason at all, so
    // the caller showed "complete". Say it plainly instead. A later syncAll
    // rebuilds the queue from whatever is still stored locally, so this stays
    // recoverable rather than terminal.
    if (pushed === 0 && skipped > 0) {
      return {
        pushed,
        skipped,
        conflicts,
        batches,
        queued: initialQueued,
        remaining: queue.length,
        reason: "unresolved",
        error: `${skipped} queued record${skipped === 1 ? "" : "s"} could not be read from this device's local library, so nothing was uploaded.`,
      };
    }

    return {
      pushed,
      skipped,
      conflicts,
      batches,
      queued: initialQueued,
      remaining: queue.length,
    };
  }
}

export const cloudSyncService = new CloudSyncService();
