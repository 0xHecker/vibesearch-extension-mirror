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

export {
  CLOUD_SYNC_API_BASE_KEY,
  CLOUD_SYNC_TOKEN_KEY,
  DEFAULT_VIBESEARCH_API_BASE,
} from "./cloud-config";

export const CLOUD_SYNC_QUEUE_KEY = "vibesearch:cloudSyncQueue:v1";
export const CLOUD_SYNC_CLIENT_ID_KEY = "vibesearch:cloudSyncClientId";

export const CLOUD_SYNC_PUSH_BATCH_SIZE = 10;
export const CLOUD_SYNC_PUSH_BATCH_MAX = 10;

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
  reason?: "empty" | "missing-token" | "invalid-auth" | "http-error" | "network-error" | "invalid-response";
  error?: string;
};

export type CloudSyncBatchOptions = {
  batchSize?: number;
  maxBatches?: number;
  priorityRefs?: Array<Pick<CloudSyncQueueRef, "collection" | "id">>;
};

export type CloudSyncPushItemResult = {
  ready: boolean;
  reason?: "missing-local-item" | "still-queued";
  push?: CloudSyncDrainResult;
};

export type CloudSyncServiceOptions = {
  fetcher?: typeof fetch;
  getCollectionResolver?: () => Promise<CloudSyncCollectionResolver>;
  getCredentials?: () => Promise<CloudAuthCredentials>;
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

const parsePushCount = (value: unknown, fallback: number, maximum: number): number | null => {
  if (value === undefined) return fallback;
  if (!Number.isFinite(value) || (value as number) < 0) return null;
  return Math.min(maximum, Math.floor(value as number));
};

const parseCloudSyncPushResult = (
  value: unknown,
  changes: CloudSyncChange[],
): ParsedCloudSyncPushResult | null => {
  if (!isObject(value)) return null;
  const applied = parsePushCount(value.applied, changes.length, changes.length);
  const conflicts = parsePushCount(value.conflicts, 0, changes.length);
  if (applied === null || conflicts === null) return null;
  const qualified = "acceptedRefs" in value || "conflictRefs" in value;
  if (qualified) {
    const accepted = parseEntityRefList(value.acceptedRefs ?? []);
    const conflicted = parseEntityRefList(value.conflictRefs ?? []);
    if (!accepted || !conflicted) return null;
    return { applied, conflicts, acknowledgements: [...accepted, ...conflicted] };
  }
  const legacy = "acceptedIds" in value || "conflictIds" in value;
  if (legacy) {
    const accepted = parseIdList(value.acceptedIds ?? []);
    const conflicted = parseIdList(value.conflictIds ?? []);
    if (!accepted || !conflicted) return null;
    return { applied, conflicts, acknowledgements: [...accepted, ...conflicted] };
  }
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
    if (!prev || ref.updatedAt >= prev.updatedAt || ref.deletedAt > prev.deletedAt) {
      merged.set(key, { ...ref, attempts: prev && ref.updatedAt === prev.updatedAt ? prev.attempts : 0 });
    }
  }
  return Array.from(merged.values()).sort((a, b) => a.queuedAt - b.queuedAt || a.updatedAt - b.updatedAt);
};

const inferCloudItemType = (item: ItemDocType): string => {
  const media = item.media || [];
  if (item.source === "github") return "repo";
  if (item.source === "youtube") return "video";
  if (item.source === "twitter" || item.source === "instagram" || item.source === "tiktok" || item.source === "linkedin") {
    return "social";
  }
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
  if (item.source === "twitter" || item.source === "instagram" || item.source === "tiktok" || item.source === "linkedin") {
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

const readQueue = async (): Promise<CloudSyncQueueRef[]> => {
  const raw = await storageGet<unknown[]>(CLOUD_SYNC_QUEUE_KEY, []);
  return Array.isArray(raw) ? mergeCloudSyncQueue(raw as CloudSyncQueueRef[], []) : [];
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

const collectionForRef = (db: any, collection: CloudSyncCollectionName) => {
  if (collection === "spaceGroups") return db.space_groups;
  if (collection === "itemTags") return db.item_tags;
  return db[collection];
};

type CloudSyncLocalRecord = Record<string, unknown>;

export type CloudSyncLocalCollection = {
  findByIds(ids: string[]): { exec(): Promise<Map<string, { toMutableJSON(): CloudSyncLocalRecord }>> };
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

const removeQueueRefs = async (refs: CloudSyncQueueRef[]): Promise<void> => {
  await withQueueMutationLock(async () => {
    const current = await readQueue();
    await writeQueue(removeAcknowledgedQueueRefs(current, refs));
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

export class CloudSyncService {
  constructor(private readonly options: CloudSyncServiceOptions = {}) {}

  private async getCollectionResolver(): Promise<CloudSyncCollectionResolver> {
    if (this.options.getCollectionResolver) return this.options.getCollectionResolver();
    const db = await getDb();
    return (collection) => collectionForRef(db, collection);
  }

  private request(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
    return (this.options.fetcher ?? fetch)(input, init);
  }

  async enqueueDocs(docs: CloudSyncDocBatch): Promise<{ queued: number; added: number }> {
    const refs = cloudSyncRefsForDocs(docs).map(normalizeRef).filter((ref): ref is CloudSyncQueueRef => ref !== null);
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
    notifyCloudSyncQueueUpdated();
    return result;
  }

  async status(): Promise<{ queued: number; hasToken: boolean; apiBase: string }> {
    const [queue, token, apiBase] = await Promise.all([readQueue(), getToken(), getApiBase()]);
    return { queued: queue.length, hasToken: Boolean(token), apiBase };
  }

  async drain(payload?: CloudSyncBatchOptions): Promise<CloudSyncDrainResult> {
    if (drainInFlight) return drainInFlight;
    drainInFlight = this.drainInternal(payload).finally(() => {
      drainInFlight = null;
    });
    return drainInFlight;
  }

  /** Ensure one local item reaches the API before a dependent archive upload. */
  async pushItem(itemIdRaw: string): Promise<CloudSyncPushItemResult> {
    const itemId = typeof itemIdRaw === "string" ? itemIdRaw.trim() : "";
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

  private async drainInternal(payload?: CloudSyncBatchOptions): Promise<CloudSyncDrainResult> {
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

    while (queue.length > 0 && batches < maxBatches) {
      const refs = selectCloudSyncBatch(queue, batchSize, payload?.priorityRefs);
      const changes = await buildCloudSyncChanges(refs, resolveCollection, credentials.userId);
      const missingRefs = refs.filter((ref) => !changes.some((change) => change.collection === ref.collection && change.id === ref.id));
      if (missingRefs.length > 0) {
        skipped += missingRefs.length;
        await removeQueueRefs(missingRefs);
      }
      if (changes.length === 0) {
        queue = await readQueue();
        continue;
      }

      let response: Response;
      try {
        response = await this.request(`${apiBase}/v1/sync/push`, {
          method: "POST",
          headers: {
            authorization: `Bearer ${token}`,
            "content-type": "application/json",
          },
          body: JSON.stringify({ clientId, changes }),
        });
      } catch (error) {
        return {
          pushed,
          skipped,
          conflicts,
          batches,
          queued: initialQueued,
          remaining: (await readQueue()).length,
          reason: "network-error",
          error: error instanceof Error ? error.message : "Cloud sync failed.",
        };
      }

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

      const result = parseCloudSyncPushResult(await response.json().catch(() => null), changes);
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
      await removeQueueRefs(acknowledgedRefs);
      queue = await readQueue();
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
