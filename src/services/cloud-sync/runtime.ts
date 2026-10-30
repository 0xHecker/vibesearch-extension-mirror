import {
  jsonBoolean,
  jsonString,
  parseJsonObject,
  type JsonObject,
  type JsonValue,
} from "@src/common/json-value";
import { getCloudAuthToken } from "@src/services/cloud-auth";
import { runtimeOffscreenStorage } from "@src/services/offscreen-storage-bridge";
import {
  CLOUD_SYNC_API_BASE_KEY,
  resolveVibeSearchApiBase,
} from "@src/services/cloud-config";
import {
  CLOUD_PULL_ENABLED_KEY,
  CLOUD_SYNC_CLIENT_ID_KEY,
  CLOUD_SYNC_PULL_STATE_KEY,
  CLOUD_SYNC_QUEUE_KEY,
  type CloudSyncChange,
  type CloudSyncCollectionName,
  type CloudSyncPullState,
  type CloudSyncQueueRef,
  clampTimestamp,
  normalizeCloudDoc,
  parseCloudSyncQueue,
  queueKey,
  removeAcknowledgedQueueRefs,
} from "@src/services/cloud-sync/model";
import type { MyDatabase } from "@src/services/DatabaseService";
import {
  countRxQuerySubscribers,
  uncacheRxQuery,
  type MangoQuerySelector,
  type MangoQuerySortPart,
  type RxCollection,
  type RxDocument,
} from "rxdb";
import { z } from "zod";

const storageAvailable = (): boolean => typeof chrome !== "undefined" && Boolean(chrome.storage?.local);

const jsonValueSchema: z.ZodType<JsonValue> = z.json();

const storageReadRow = (key: string): Promise<Record<string, unknown>> => storageAvailable()
  ? chrome.storage.local.get(key)
  : runtimeOffscreenStorage.get(key);

const storageGet = async (key: string): Promise<JsonValue | undefined> => {
  const row = await storageReadRow(key);
  const parsed = jsonValueSchema.safeParse(row?.[key]);
  return parsed.success ? parsed.data : undefined;
};

const storageSet = async (key: string, value: JsonValue): Promise<void> => {
  if (storageAvailable()) await chrome.storage.local.set({ [key]: value });
  else await runtimeOffscreenStorage.set(key, value);
};

export const storageRemove = async (key: string): Promise<void> => {
  if (!storageAvailable()) return runtimeOffscreenStorage.remove(key);
  if (chrome.storage.local.remove) {
    await chrome.storage.local.remove(key);
    return;
  }
  await chrome.storage.local.set({ [key]: [] });
};

export const readQueue = async (): Promise<CloudSyncQueueRef[]> => {
  return parseCloudSyncQueue(await storageGet(CLOUD_SYNC_QUEUE_KEY));
};

/**
 * Queue mutations only need to preserve the already-normalized durable order.
 * Re-normalizing and sorting the entire remaining outbox after every ten-row
 * acknowledgement turns a large drain quadratic. Keep a strict shape guard,
 * while reserving full dedupe/normalization for queue hydration and enqueue.
 */
const readQueueForMutation = async (): Promise<CloudSyncQueueRef[]> => {
  const row = await storageReadRow(CLOUD_SYNC_QUEUE_KEY);
  const stored = row?.[CLOUD_SYNC_QUEUE_KEY];
  if (!Array.isArray(stored)) return [];
  // SAFETY: The drain validates this outbox through `readQueue` before its first
  // mutation, and every in-process writer stores only CloudSyncQueueRef arrays.
  return stored as CloudSyncQueueRef[];
};

export const writeQueue = async (queue: CloudSyncQueueRef[]): Promise<void> => {
  await storageSet(CLOUD_SYNC_QUEUE_KEY, queue);
};

// Chrome storage has atomic writes but no compare-and-swap. Keep only the
// read-modify-write sections serial so concurrent local edits cannot overwrite
// each other's outbox entries while network work remains fully asynchronous.
let queueMutationTail: Promise<void> = Promise.resolve();

export const withQueueMutationLock = async <T>(operation: () => Promise<T>): Promise<T> => {
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

/** Validate durable storage once before the fast acknowledgement path begins. */
export const hydrateQueueForDrain = (): Promise<CloudSyncQueueRef[]> =>
  withQueueMutationLock(readQueue);

export const getClientId = async (): Promise<string> => {
  const existing = jsonString(await storageGet(CLOUD_SYNC_CLIENT_ID_KEY))?.trim() ?? "";
  if (existing) return existing;
  const id = crypto.randomUUID();
  await storageSet(CLOUD_SYNC_CLIENT_ID_KEY, id);
  return id;
};

export const getApiBase = async (): Promise<string> => {
  const configured = (jsonString(await storageGet(CLOUD_SYNC_API_BASE_KEY)) ?? "")
    .trim()
    .replace(/\/+$/, "");
  return resolveVibeSearchApiBase(configured);
};

export const getToken = (): Promise<string> => getCloudAuthToken();

export const isCloudPullEnabled = async (): Promise<boolean> =>
  jsonBoolean(await storageGet(CLOUD_PULL_ENABLED_KEY)) === true;

export const setCloudPullEnabled = async (enabled: boolean): Promise<void> => {
  await storageSet(CLOUD_PULL_ENABLED_KEY, enabled === true);
};

const cloudSyncPullStateSchema = z.object({
  checkpoint: z.number().int().nonnegative(),
  bootstrapCursor: z.string().optional(),
  userId: z.string().optional(),
});

export const readPullState = async (userId = ""): Promise<CloudSyncPullState> => {
  const fallback: CloudSyncPullState = { checkpoint: 0 };
  if (userId) fallback.userId = userId;
  const parsed = cloudSyncPullStateSchema.safeParse(await storageGet(CLOUD_SYNC_PULL_STATE_KEY));
  if (!parsed.success) return fallback;
  const raw = parsed.data;
  const storedUserId = raw.userId ?? "";
  // A different account — or a checkpoint written before accounts were recorded
  // — must start from scratch instead of inheriting a foreign sequence number.
  if (userId && storedUserId !== userId) return { checkpoint: 0, userId };
  const state: CloudSyncPullState = { checkpoint: raw.checkpoint };
  const cursor = raw.bootstrapCursor?.trim();
  if (cursor) state.bootstrapCursor = cursor;
  if (storedUserId) state.userId = storedUserId;
  return state;
};

/** Forget the read position, e.g. on disconnect or a local data reset. */
export const clearCloudPullState = async (): Promise<void> => {
  await storageSet(CLOUD_SYNC_PULL_STATE_KEY, { checkpoint: 0 });
};

export const writePullState = async (state: CloudSyncPullState): Promise<void> => {
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
  doc: JsonObject,
  schema?: CloudSyncLocalCollection["schema"],
): JsonObject | null => {
  const properties = schema?.jsonSchema?.properties;
  const localized: JsonObject = {};
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
const PULLED_DEVICE_LOCAL_FIELDS = {
  vector_index: -1,
  vector_indexes: [],
  isEmbedded: false,
  isDirty: false,
} satisfies JsonObject;

type CloudSyncLocalRecord = JsonObject;

export type CloudSyncLocalDocument = {
  primary?: string;
  toMutableJSON(): CloudSyncLocalRecord;
};

export type CloudSyncBulkInsertFailure = {
  status?: number;
};

export type CloudSyncBulkInsertResult = {
  error?: CloudSyncBulkInsertFailure[];
};

export type CloudSyncLocalCollection = {
  findByIds(ids: string[]): { exec(): Promise<Map<string, CloudSyncLocalDocument>> };
  find?(query: {
    selector: MangoQuerySelector<JsonObject>;
    sort?: Array<{ id: "asc" }>;
    limit?: number;
  }): { exec(): Promise<CloudSyncLocalDocument[]> };
  /** Used by a pull to add rows this device has never seen. */
  bulkInsert?(docs: JsonObject[]): Promise<CloudSyncBulkInsertResult>;
  /** Read at runtime so an incoming doc is trimmed to what this schema accepts. */
  schema?: { jsonSchema?: { properties?: JsonObject; required?: string[] } };
};

export type CloudSyncCollectionResolver = (collection: CloudSyncCollectionName) => CloudSyncLocalCollection;

function adaptCloudSyncDocument<DocumentType>(
  document: RxDocument<DocumentType>,
): CloudSyncLocalDocument {
  return {
    primary: document.primary,
    toMutableJSON: () => parseJsonObject(document.toMutableJSON()),
  };
}

function adaptCloudSyncCollection<DocumentType extends { id: string }>(
  collection: RxCollection<DocumentType>,
): CloudSyncLocalCollection {
  const propertyNames = Object.keys(collection.schema.jsonSchema.properties);
  const properties = Object.fromEntries(propertyNames.map((name) => [name, null]));
  return {
    schema: {
      jsonSchema: {
        properties,
        required: [...(collection.schema.jsonSchema.required ?? [])],
      },
    },
    findByIds: (ids) => ({
      exec: async () => {
        const found = await collection.findByIds(ids).exec();
        const documents = new Map<string, CloudSyncLocalDocument>();
        for (const [id, document] of found) {
          documents.set(id, adaptCloudSyncDocument(document));
        }
        return documents;
      },
    }),
    find: (query) => {
      // SAFETY: Cloud-sync selectors target fields admitted by this collection's
      // runtime schema; the adapter preserves that document-specific contract.
      const selector = query.selector as MangoQuerySelector<DocumentType>;
      // SAFETY: Every syncable document has the string `id` primary key used by
      // keyset scans, so the shared ascending sort is valid for each collection.
      const sort = query.sort as MangoQuerySortPart<DocumentType>[] | undefined;
      const rxQuery = collection.find({
        selector,
        sort,
        limit: query.limit,
      });
      return {
        exec: async () => {
          try {
            return (await rxQuery.exec()).map(adaptCloudSyncDocument);
          } finally {
            if (countRxQuerySubscribers(rxQuery) === 0) {
              uncacheRxQuery(collection._queryCache, rxQuery);
            }
          }
        },
      };
    },
    bulkInsert: async (documents) => {
      // SAFETY: `localizePulledDoc` filters keys and verifies required fields
      // against this exact runtime schema before documents reach the adapter.
      const typedDocuments = documents as DocumentType[];
      const outcome = await collection.bulkInsert(typedDocuments);
      return {
        error: outcome.error.map((failure) => ({ status: failure.status })),
      };
    },
  };
}

export function createCloudSyncCollectionResolver(
  db: MyDatabase,
): CloudSyncCollectionResolver {
  return (collection) => {
    if (collection === "items") return adaptCloudSyncCollection(db.items);
    if (collection === "folders") return adaptCloudSyncCollection(db.folders);
    if (collection === "spaces") return adaptCloudSyncCollection(db.spaces);
    if (collection === "spaceGroups") return adaptCloudSyncCollection(db.space_groups);
    if (collection === "tags") return adaptCloudSyncCollection(db.tags);
    return adaptCloudSyncCollection(db.item_tags);
  };
}

export const buildCloudSyncChanges = async (
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
      doc: normalizeCloudDoc(ref.collection, doc, cloudUserId),
      updatedAt: clampTimestamp(doc.updatedAt, ref.updatedAt),
      deletedAt: clampTimestamp(doc.deletedAt, 0),
    });
  }
  return changes;
};

export const removeQueueRefs = async (refs: CloudSyncQueueRef[], canRemove: () => boolean = () => true): Promise<CloudSyncQueueRef[]> => {
  return withQueueMutationLock(async () => {
    const current = await readQueueForMutation();
    if (!canRemove()) return current;
    const next = removeAcknowledgedQueueRefs(current, refs);
    // The guarded storage write starts here; later cancellation cannot undo it.
    await writeQueue(next);
    return next;
  });
};

export const notifyCloudSyncQueueUpdated = (): void => {
  try {
    const result = chrome.runtime.sendMessage({ target: "background", type: "CLOUD_SYNC_QUEUED" });
    void Promise.resolve(result).catch(() => {});
  } catch {
    // The service is also used in tests and contexts without extension runtime messaging.
  }
};
