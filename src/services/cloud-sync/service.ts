import {
  jsonObject,
  jsonString,
  type JsonValue,
} from "@src/common/json-value";
import {
  getCloudAuthCredentials,
  type CloudAuthCredentials,
} from "@src/services/cloud-auth";
import { getDb } from "@src/services/DatabaseService";
import {
  cloudPullItemKeys,
  planCloudPullMerge,
  type CloudPullChange,
} from "@src/services/cloud-pull-merge";
import { forEachIdKeysetPage } from "@src/services/rxdb-keyset-pagination";
import {
  CLOUD_SYNC_COLLECTIONS,
  CLOUD_SYNC_QUEUE_KEY,
  CLOUD_SYNC_PULL_MAX_PAGES,
  CLOUD_SYNC_PULL_PAGE_SIZE,
  CLOUD_SYNC_PUSH_BATCH_MAX,
  CLOUD_SYNC_PUSH_BATCH_SIZE,
  type CloudSyncAllOptions,
  type CloudSyncAllResult,
  type CloudSyncBatchOptions,
  type CloudSyncCollectionName,
  type CloudSyncDocBatch,
  type CloudSyncDrainResult,
  type CloudSyncItemState,
  type CloudSyncPullResult,
  type CloudSyncPushItemResult,
  type CloudSyncQueueRef,
  boundedPositiveInteger,
  clampTimestamp,
  cloudSyncRefsForDocs,
  cloudSyncRefsForRxChange,
  mergeCloudSyncQueue,
  normalizeRef,
  parseCloudSyncPushResult,
  selectAcknowledgedQueueRefs,
  selectCloudSyncBatch,
} from "@src/services/cloud-sync/model";
import {
  type CloudSyncCollectionResolver,
  buildCloudSyncChanges,
  clearCloudPullState,
  createCloudSyncCollectionResolver,
  getApiBase,
  getClientId,
  getToken,
  hydrateQueueForDrain,
  isCloudPullEnabled,
  localizePulledDoc,
  notifyCloudSyncQueueUpdated,
  readPullState,
  readQueue,
  removeQueueRefs,
  storageRemove,
  withQueueMutationLock,
  writePullState,
  writeQueue,
} from "@src/services/cloud-sync/runtime";
import { z } from "zod";
import { requireLegacyCloud } from "@src/services/extension-policy";

export type CloudSyncServiceOptions = {
  fetcher?: typeof fetch;
  getCollectionResolver?: () => Promise<CloudSyncCollectionResolver>;
  getCredentials?: (forceRefresh?: boolean) => Promise<CloudAuthCredentials>;
};

let drainInFlight: Promise<CloudSyncDrainResult> | null = null;
let drainController: AbortController | null = null;
let drainGeneration = 0;
const CLOUD_SYNC_REQUEST_TIMEOUT_MS = 30_000;
const CLOUD_SYNC_MAX_RESPONSE_BYTES = 1024 * 1024;
const cloudSyncJsonSchema: z.ZodType<JsonValue> = z.json();

function decodeCloudSyncJson(bytes: Uint8Array): JsonValue {
  try {
    const parsed = cloudSyncJsonSchema.safeParse(
      JSON.parse(new TextDecoder().decode(bytes)),
    );
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

function cloudSyncErrorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : "Cloud sync failed.";
}

const readBoundedCloudSyncJson = async (
  response: Response,
  signal: AbortSignal,
): Promise<JsonValue> => {
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
    return decodeCloudSyncJson(bytes);
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
  return decodeCloudSyncJson(bytes);
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

const cloudSyncCollectionSchema = z.enum(CLOUD_SYNC_COLLECTIONS);
const pulledPageSchema = z.object({
  changes: z.array(z.json()),
  checkpoint: z.number().int().nonnegative(),
  hasMore: z.boolean(),
  bootstrap: z.object({
    complete: z.boolean(),
    cursor: z.string().optional(),
  }).optional(),
});

export type CloudSyncPullPage = {
  changes: CloudPullChange[];
  checkpoint: number;
  hasMore: boolean;
  bootstrap?: { complete: boolean; cursor?: string };
};

/** Validate a pull page before it is allowed to touch the local database. */
export const normalizePulledPage = (value: JsonValue): CloudSyncPullPage | null => {
  const parsed = pulledPageSchema.safeParse(value);
  if (!parsed.success) return null;

  const changes: CloudPullChange[] = [];
  for (const entry of parsed.data.changes) {
    const raw = jsonObject(entry);
    if (!raw) continue;
    const collection = cloudSyncCollectionSchema.safeParse(raw.collection);
    const id = jsonString(raw.id);
    if (!collection.success || !id?.trim()) continue;
    changes.push({
      collection: collection.data,
      id,
      doc: jsonObject(raw.doc) ?? null,
      updatedAt: clampTimestamp(raw.updatedAt, 0),
      deletedAt: clampTimestamp(raw.deletedAt, 0),
    });
  }

  const page: CloudSyncPullPage = {
    changes,
    checkpoint: parsed.data.checkpoint,
    hasMore: parsed.data.hasMore,
  };
  if (parsed.data.bootstrap) {
    page.bootstrap = { complete: parsed.data.bootstrap.complete };
    if (parsed.data.bootstrap.cursor) {
      page.bootstrap.cursor = parsed.data.bootstrap.cursor;
    }
  }
  return page;
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
  isCurrent: () => boolean,
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
    (byCollection.get("items") ?? []).flatMap((change) => {
      const url = jsonString(change.doc?.url);
      return url ? equivalentUrlSpellings(url) : [];
    }),
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
      .flatMap((change) => {
        if (!change.doc) return [];
        const localized = localizePulledDoc(change.doc, target.schema);
        return localized ? [localized] : [];
      });
    rejected += group.length - docs.length;
    if (docs.length === 0 || !target.bulkInsert) {
      rejected += docs.length;
      continue;
    }
    // RxDB bulk writes report per-row outcomes instead of throwing, so a
    // conflict must not be counted as an insert (the checkpoint would advance
    // past a row that was never written).
    if (!isCurrent()) throw new DOMException("Cloud connection retired", "AbortError");
    const outcome = await target.bulkInsert(docs);
    const failures = outcome.error?.length ?? 0;
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
    return createCloudSyncCollectionResolver(db);
  }

  private async request(input: RequestInfo | URL, init?: RequestInit, canRequest?: () => boolean): Promise<Response> {
    await requireLegacyCloud();
    if (canRequest?.() === false) throw new DOMException("Cloud sync cancelled", "AbortError");
    // Bound like archive-preview: a detached fetch reference throws
    // "Illegal invocation" in window contexts.
    return (this.options.fetcher ?? fetch.bind(globalThis))(input, init);
  }

  async enqueueDocs(docs: CloudSyncDocBatch): Promise<{ queued: number; added: number }> {
    const refs = cloudSyncRefsForDocs(docs).map(normalizeRef);
    return this.enqueueRefs(refs);
  }

  async enqueueRxChange(
    collection: CloudSyncCollectionName,
    changeEvent: JsonValue,
  ): Promise<{ queued: number; added: number }> {
    return this.enqueueRefs(cloudSyncRefsForRxChange(collection, changeEvent));
  }

  private async enqueueRefs(
    refs: CloudSyncQueueRef[],
    notify = true,
  ): Promise<{ queued: number; added: number }> {
    await requireLegacyCloud();
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
    await requireLegacyCloud();
    const maxPages = Math.max(1, Math.min(
      CLOUD_SYNC_PULL_MAX_PAGES,
      Math.floor(payload.maxPages ?? 4),
    ));
    // Backup is one-way out of this extension unless the user turned the return
    // direction on, so the default costs no network call at all.
    const enabled = await isCloudPullEnabled();
    const credentials: CloudAuthCredentials = enabled
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
    const isCurrent = () => credentials.isCurrent?.() !== false;
    const [apiBase, clientId] = await Promise.all([getApiBase(), getClientId()]);
    const resolveCollection = await this.getCollectionResolver();

    while (result.pages < maxPages) {
      if (!isCurrent()) return { ...result, reason: "cancelled" };
      const query = new URLSearchParams({
        since: String(state.checkpoint),
        limit: String(CLOUD_SYNC_PULL_PAGE_SIZE),
        clientId,
      });
      if (state.bootstrapCursor) query.set("cursor", state.bootstrapCursor);

      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), CLOUD_SYNC_REQUEST_TIMEOUT_MS);
      let body: JsonValue = null;
      try {
        const response = await this.request(`${apiBase}/v1/sync/pull?${query}`, {
          method: "GET",
          headers: { authorization: `Bearer ${credentials.token}`, accept: "application/json" },
          credentials: "omit",
          cache: "no-store",
          signal: controller.signal,
        }, isCurrent);
        if (!isCurrent()) { await response.body?.cancel().catch(() => {}); return { ...result, reason: "cancelled" }; }
        if (response.status === 401 || response.status === 403) {
          await response.body?.cancel().catch(() => {});
          if (!isCurrent()) return { ...result, reason: "cancelled" };
          await credentials.reject?.();
          return { ...result, reason: "invalid-auth" };
        }
        if (!response.ok) {
          await response.body?.cancel().catch(() => {});
          return { ...result, reason: "http-error", error: `${response.status} ${response.statusText}`.trim() };
        }
        body = await readBoundedCloudSyncJson(response, controller.signal);
      } catch (cause) {
        if (!isCurrent()) return { ...result, reason: "cancelled" };
        return {
          ...result,
          reason: "network-error",
          error: cause instanceof Error ? cause.message : "pull failed",
        };
      } finally {
        clearTimeout(timeout);
      }

      if (!isCurrent()) return { ...result, reason: "cancelled" };

      const page = normalizePulledPage(body);
      if (!page) return { ...result, reason: "invalid-response" };

      let applied: Awaited<ReturnType<typeof applyPulledChanges>>;
      try { applied = await applyPulledChanges(page.changes, resolveCollection, isCurrent); }
      catch (error) { if (!isCurrent()) return { ...result, reason: "cancelled" }; throw error; }
      result.inserted += applied.inserted;
      result.skipped += applied.skipped;
      result.rejected += applied.rejected;
      result.pages += 1;

      // Only now is it safe to forget this page.
      state = {
        // Never move backwards: a repeated checkpoint must not rewind this
        // device's read position.
        checkpoint: Math.max(state.checkpoint, page.checkpoint),
      };
      if (page.bootstrap && !page.bootstrap.complete && page.bootstrap.cursor) {
        state.bootstrapCursor = page.bootstrap.cursor;
      }
      if (credentials.userId) state.userId = credentials.userId;
      if (!isCurrent()) return { ...result, reason: "cancelled" };
      await writePullState(state);
      if (!isCurrent()) return { ...result, reason: "cancelled" };
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
    const ids = Array.from(new Set(itemIds.filter((id) => id.trim())));
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
    await requireLegacyCloud();
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
      if (!localCollection.find) {
        throw new Error(`CLOUD_SYNC_SCAN_UNAVAILABLE:${collection}`);
      }
      const scanCollection = { find: localCollection.find };
      scanned += await forEachIdKeysetPage({
        collection: scanCollection,
        selector: {},
        pageSize,
        onPage: (documents) => {
          const queuedAt = Date.now();
          for (const document of documents) {
            const row = document.toMutableJSON();
            const rawId = jsonString(row.id) ?? document.primary;
            const id = jsonString(rawId)?.trim() ?? "";
            if (!id) continue;
            const normalized = normalizeRef({
              collection,
              id,
              updatedAt: clampTimestamp(row.updatedAt, queuedAt),
              deletedAt: clampTimestamp(row.deletedAt, 0),
              queuedAt,
            });
            refs.push(normalized);
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
    await requireLegacyCloud();
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
    await requireLegacyCloud();
    const itemId = itemIdRaw.trim();
    if (!itemId) return { ready: false, reason: "missing-local-item" };
    const resolveCollection = await this.getCollectionResolver();
    const found = await resolveCollection("items").findByIds([itemId]).exec();
    const document = found.get(itemId);
    if (!document) return { ready: false, reason: "missing-local-item" };

    const row = document.toMutableJSON();
    const queuedAt = Date.now();
    await this.enqueueRefs([{
      collection: "items",
      id: itemId,
      updatedAt: clampTimestamp(row.updatedAt, queuedAt),
      deletedAt: clampTimestamp(row.deletedAt, 0),
      queuedAt,
    }]);
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
    await requireLegacyCloud();
    const credentials = this.options.getCredentials
      ? await this.options.getCredentials()
      : await getCloudAuthCredentials();
    const token = credentials.token;
    let queue = await hydrateQueueForDrain();
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
    const maxBatches = boundedPositiveInteger(
      payload?.maxBatches,
      25,
      Number.MAX_SAFE_INTEGER,
    );
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
    const isCurrent = () => !signal.aborted && generation === drainGeneration && credentials.isCurrent?.() !== false;

    while (queue.length > 0 && batches < maxBatches) {
      if (!isCurrent()) return cancelled();
      const refs = selectCloudSyncBatch(queue, batchSize, payload?.priorityRefs);
      const changes = await buildCloudSyncChanges(refs, resolveCollection, credentials.userId);
      if (!isCurrent()) return cancelled();
      const missingRefs = refs.filter((ref) => !changes.some((change) => change.collection === ref.collection && change.id === ref.id));
      if (missingRefs.length > 0) {
        skipped += missingRefs.length;
        queue = await removeQueueRefs(missingRefs, isCurrent);
        if (!isCurrent()) return cancelled();
      }
      if (changes.length === 0) {
        continue;
      }

      let response: Response;
      let responseBody: JsonValue = null;
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
        }, isCurrent);
        if (response.ok) {
          responseBody = await readBoundedCloudSyncJson(response, requestController.signal);
        } else {
          await response.body?.cancel().catch(() => {});
        }
      } catch (error) {
        if (!isCurrent()) return cancelled();
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
            : cloudSyncErrorMessage(error),
        };
      } finally {
        clearTimeout(requestTimeout);
        signal.removeEventListener("abort", forwardAbort);
      }

      if (!isCurrent()) return cancelled();

      if (!response.ok) {
        if (response.status === 401 || response.status === 403) await credentials.reject?.();
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
      queue = await removeQueueRefs(acknowledgedRefs, isCurrent);
      if (!isCurrent()) return cancelled();
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
