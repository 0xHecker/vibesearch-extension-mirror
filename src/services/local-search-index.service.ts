import { Document, Charset } from "flexsearch";
import { getDb } from "@src/services/DatabaseService";
import type { ItemDocType } from "@src/schemas/item_schema";
import { normalizeSearchIndexText } from "@src/search-core/search-text";
import {
  forEachIdKeysetPage,
  throwIfOperationAborted,
} from "@src/services/rxdb-keyset-pagination";

type IndexedSearchDoc = {
  id: string;
  title: string;
  textContent: string;
  ocrText: string;
  url: string;
  author: string;
  tagsText: string;
  source: string;
  phoneticTitle: string;
  phoneticAuthor: string;
};

type SearchRequest = {
  query: string;
  queries?: string[];
  limit: number;
  keyword?: boolean;
  fuzzy?: boolean;
  /** Optional database-scoped IDs used when a saturated global lookup is incomplete. */
  allowedIds?: ReadonlySet<string>;
  /** Records which input term produced each hit for explicit Boolean evaluation. */
  trackTermMatches?: boolean;
  signal?: AbortSignal;
};

type SearchResult = {
  scores: Map<string, number>;
  saturated: boolean;
  terms: string[];
  termMatchMasksById: Map<string, number[]>;
};

type SearchVariant = {
  query: string;
  boost: number;
  suggest: boolean;
};

type SearchStats = {
  indexedCount: number;
  lastBuiltAt: number;
  usingWorker: boolean;
};

type IndexProcessStatusState = "processing" | "success" | "error";

const FIELD_WEIGHTS: Record<string, number> = {
  title: 6,
  tagsText: 4.5,
  textContent: 3,
  ocrText: 2.8,
  url: 2.5,
  author: 2.5,
  phoneticTitle: 2,
  phoneticAuthor: 1.5,
  source: 1,
};
const ENABLE_FLEXSEARCH_WORKER =
  import.meta.env.VITE_FLEXSEARCH_WORKER === "1";
// Guard only against a broken/non-advancing index implementation. Production
// searches use pages of at least 1,800 hits, so this still covers far more
// records than a browser extension can practically retain.
const MAX_SCOPED_SEARCH_PAGES = 1024;
const SEARCH_INDEX_BUILD_PAGE_SIZE = 250;
const MAX_REBUILD_PASSES = 2;
const MAX_BUILD_CATCH_UP_IDS = 5_000;

const normalizeForIndex = normalizeSearchIndexText;

const soundexToken = (input: string): string => {
  const token = normalizeForIndex(input).replace(/[^a-z]/g, "");
  if (!token) return "";

  const first = token[0];
  const mappings: Record<string, string> = {
    b: "1",
    f: "1",
    p: "1",
    v: "1",
    c: "2",
    g: "2",
    j: "2",
    k: "2",
    q: "2",
    s: "2",
    x: "2",
    z: "2",
    d: "3",
    t: "3",
    l: "4",
    m: "5",
    n: "5",
    r: "6",
  };

  let encoded = first.toUpperCase();
  let previous = mappings[first] ?? "";
  for (let i = 1; i < token.length; i += 1) {
    const current = mappings[token[i]] ?? "";
    if (current && current !== previous) {
      encoded += current;
    }
    previous = current;
    if (encoded.length >= 4) break;
  }

  return encoded.padEnd(4, "0").slice(0, 4);
};

const toPhoneticQuery = (query: string): string => {
  const tokens = normalizeForIndex(query).split(/\s+/).filter(Boolean);
  return tokens.map(soundexToken).filter(Boolean).join(" ");
};

const toIndexDoc = (item: ItemDocType, tagsText: string): IndexedSearchDoc => {
  const title = normalizeForIndex(item.title || "");
  const author = normalizeForIndex(item.authorUsername || "");
  const textContent = normalizeForIndex(item.textContent || "").slice(0, 8000);
  const ocrText = normalizeForIndex(item.ocrText || "").slice(0, 8000);
  const url = normalizeForIndex(item.url || "");

  return {
    id: item.id,
    title,
    textContent,
    ocrText,
    url,
    author,
    tagsText: normalizeForIndex(tagsText).slice(0, 2000),
    source: normalizeForIndex(item.source || ""),
    phoneticTitle: toPhoneticQuery(title),
    phoneticAuthor: toPhoneticQuery(author),
  };
};

const toIdString = (entry: unknown): string | null => {
  if (typeof entry === "string" || typeof entry === "number") return String(entry);
  if (entry && typeof entry === "object" && "id" in entry) {
    const idValue = (entry as { id?: unknown }).id;
    if (typeof idValue === "string" || typeof idValue === "number") return String(idValue);
  }
  return null;
};

const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value));

export class LocalSearchIndexService {
  private index: Document<IndexedSearchDoc, any> | null = null;
  private buildPromise: Promise<void> | null = null;
  private dirty = true;
  private indexedCount = 0;
  private usingWorker = true;
  private lastBuiltAt = 0;
  private lastItemSyncAt = 0;
  private incrementalTimer: ReturnType<typeof setTimeout> | null = null;
  private incrementalSyncInFlight = false;
  private incrementalSyncQueued = false;
  private pendingItemIds = new Set<string>();
  private contentGeneration = 0;
  private fullRebuildGeneration = 0;
  private pendingItemIdsOverflowed = false;

  private emitProcessStatus(
    state: IndexProcessStatusState,
    detail: string,
    retryAction?: "REBUILD_INDEX"
  ) {
    try {
      chrome.runtime.sendMessage({
        type: "PROCESS_STATUS",
        payload: {
          id: "search-index",
          label: "Search index",
          state,
          detail,
          retryAction,
          updatedAt: Date.now(),
        },
      });
    } catch {}
  }

  markDirty() {
    this.contentGeneration += 1;
    this.fullRebuildGeneration += 1;
    this.dirty = true;
  }

  scheduleItemSync(changedItemIds?: string[]) {
    this.contentGeneration += 1;
    if (this.dirty && this.pendingItemIdsOverflowed) return;
    if (changedItemIds && changedItemIds.length > 0) {
      for (const itemId of changedItemIds) {
        if (!itemId) continue;
        if (this.pendingItemIds.has(itemId)) continue;
        if (this.pendingItemIds.size >= MAX_BUILD_CATCH_UP_IDS) {
          this.pendingItemIdsOverflowed = true;
          // We can no longer prove an incremental catch-up is complete. Drop
          // the retained IDs immediately and let the existing keyset-paged
          // rebuild recover the full index on the next search.
          this.pendingItemIds.clear();
          this.fullRebuildGeneration += 1;
          this.dirty = true;
          if (this.incrementalTimer !== null) {
            clearTimeout(this.incrementalTimer);
            this.incrementalTimer = null;
          }
          break;
        }
        this.pendingItemIds.add(itemId);
      }
    }
    // A full rebuild supersedes every queued per-item update. This is especially
    // important for bulk imports, where holding thousands of IDs only creates
    // duplicate work and a temporary memory spike.
    if (this.dirty) return;

    if (this.incrementalSyncInFlight) {
      this.incrementalSyncQueued = true;
      return;
    }

    if (this.incrementalTimer !== null) return;
    this.incrementalTimer = setTimeout(() => {
      this.incrementalTimer = null;
      void this.runIncrementalSync();
    }, 220);
  }

  getStats(): SearchStats {
    return {
      indexedCount: this.indexedCount,
      lastBuiltAt: this.lastBuiltAt,
      usingWorker: this.usingWorker,
    };
  }

  private createIndex(worker: boolean): Document<IndexedSearchDoc, any> {
    return new Document<IndexedSearchDoc, any>({
      tokenize: "forward",
      encoder: Charset.LatinAdvanced,
      resolution: 6,
      // Cache recent query plans, not an unbounded browsing session. A few
      // hundred covers normal type-ahead while keeping long-lived memory flat.
      cache: 256,
      worker,
      document: {
        id: "id",
        index: [
          { field: "title", tokenize: "forward", resolution: 9 },
          { field: "textContent", tokenize: "forward", resolution: 4 },
          { field: "ocrText", tokenize: "forward", resolution: 5 },
          { field: "url", tokenize: "forward", resolution: 5 },
          { field: "author", tokenize: "forward", resolution: 6 },
          { field: "tagsText", tokenize: "forward", resolution: 7 },
          { field: "source", tokenize: "strict", resolution: 3 },
          { field: "phoneticTitle", tokenize: "strict", resolution: 4 },
          { field: "phoneticAuthor", tokenize: "strict", resolution: 4 },
        ],
      },
    });
  }

  private async addBatch(index: Document<IndexedSearchDoc, any>, docs: IndexedSearchDoc[]): Promise<void> {
    await Promise.all(docs.map((doc) => Promise.resolve((index as any).add(doc))));
  }

  private async buildIndexWithMode(worker: boolean): Promise<void> {
    const db = await getDb();
    const index = this.createIndex(worker);
    // Read, project, and index one deterministic primary-key page at a time.
    // Neither RxDocuments nor their full text/media JSON are retained for the
    // complete library, and tag joins are restricted to the active page.
    const indexedCount = await forEachIdKeysetPage({
      collection: db.items as any,
      selector: { deletedAt: { $eq: 0 } },
      pageSize: SEARCH_INDEX_BUILD_PAGE_SIZE,
      onPage: async (itemDocs: any[]) => {
        const itemIds = itemDocs.map((doc) => doc.primary as string).filter(Boolean);
        const tagsByItemId = await this.getTagsByItemIds(itemIds, db);
        const indexDocs = itemDocs.map((doc) => {
          const item = doc.toMutableJSON() as ItemDocType;
          return toIndexDoc(item, (tagsByItemId.get(item.id) || []).join(" "));
        });
        await this.addBatch(index, indexDocs);
      },
    });

    this.index = index;
    this.usingWorker = worker;
    this.indexedCount = indexedCount;
    this.lastBuiltAt = Date.now();
  }

  private async rebuild(): Promise<void> {
    this.emitProcessStatus("processing", "Rebuilding local search index...");
    for (let pass = 1; pass <= MAX_REBUILD_PASSES; pass += 1) {
      const buildContentGeneration = this.contentGeneration;
      const buildFullGeneration = this.fullRebuildGeneration;
      const buildStartedAt = Date.now();
      this.pendingItemIds.clear();
      this.pendingItemIdsOverflowed = false;
      const previousIndex = this.index;
      this.index = null;
      if (previousIndex && typeof (previousIndex as any).clear === "function") {
        // A rebuild can be as large as the live index. Clear the stale copy first
        // so large libraries do not temporarily retain two full text indexes.
        await Promise.resolve((previousIndex as any).clear());
      }
      if (ENABLE_FLEXSEARCH_WORKER) {
        try {
          await this.buildIndexWithMode(true);
        } catch (error) {
          console.warn("[LocalSearchIndex] Worker mode unavailable, falling back to in-thread mode.", error);
          await this.buildIndexWithMode(false);
        }
      } else {
        await this.buildIndexWithMode(false);
      }

      const catchUpIds = Array.from(this.pendingItemIds);
      this.pendingItemIds.clear();
      const contentChanged = buildContentGeneration !== this.contentGeneration;
      const needsAnotherFullBuild =
        buildFullGeneration !== this.fullRebuildGeneration ||
        this.pendingItemIdsOverflowed ||
        (contentChanged && catchUpIds.length === 0);

      if (needsAnotherFullBuild && pass < MAX_REBUILD_PASSES) {
        this.emitProcessStatus(
          "processing",
          "Library changed during indexing; refreshing the search index..."
        );
        continue;
      }

      this.dirty = false;
      this.lastItemSyncAt = buildStartedAt;
      for (let start = 0; start < catchUpIds.length; start += SEARCH_INDEX_BUILD_PAGE_SIZE) {
        await this.syncItemsIncremental(
          catchUpIds.slice(start, start + SEARCH_INDEX_BUILD_PAGE_SIZE)
        );
      }
      // A full/tag change or an overflow on the final pass cannot be repaired
      // by item-ID catch-up alone. Publish the bounded completed index now and
      // leave it dirty so the next search performs another bounded rebuild.
      this.dirty = needsAnotherFullBuild;
      this.emitProcessStatus("success", `Index ready (${this.indexedCount} records).`);
      return;
    }
  }

  async ensureReady(): Promise<void> {
    if (!this.dirty && this.index) return;
    if (this.buildPromise) {
      await this.buildPromise;
      return;
    }

    this.buildPromise = this.rebuild()
      .catch((error) => {
        console.error("[LocalSearchIndex] Failed to rebuild index:", error);
        this.emitProcessStatus(
          "error",
          "Search index rebuild failed. Retry to restore fast search.",
          "REBUILD_INDEX"
        );
        throw error;
      })
      .finally(() => {
        this.buildPromise = null;
      });

    await this.buildPromise;
  }

  private async getTagsByItemIds(
    itemIds: string[],
    database?: Awaited<ReturnType<typeof getDb>>
  ): Promise<Map<string, string[]>> {
    const map = new Map<string, string[]>();
    if (itemIds.length === 0) return map;

    const db = database || (await getDb());
    const joins = await db.item_tags.find({ selector: { itemId: { $in: itemIds } } }).exec();
    if (joins.length === 0) return map;

    const tagIds = Array.from(new Set(joins.map((join) => join.get("tagId") as string).filter(Boolean)));
    const tagDocs =
      tagIds.length > 0 ? await db.tags.find({ selector: { id: { $in: tagIds } } }).exec() : [];
    const tagNameById = new Map<string, string>();
    for (const tag of tagDocs) {
      tagNameById.set(tag.get("id") as string, (tag.get("name") as string) || "");
    }

    for (const join of joins) {
      const itemId = join.get("itemId") as string;
      const tagId = join.get("tagId") as string;
      const tagName = tagNameById.get(tagId);
      if (!tagName) continue;
      const list = map.get(itemId) || [];
      list.push(tagName);
      map.set(itemId, list);
    }

    return map;
  }

  private async syncItemsIncremental(changedItemIds?: string[]): Promise<number> {
    if (this.dirty || !this.index) return 0;

    const db = await getDb();
    const explicitIds = Array.from(new Set((changedItemIds || []).filter(Boolean)));
    let changedItems: ItemDocType[] = [];
    const removedIds = new Set<string>();

    if (explicitIds.length > 0) {
      const changedById = await db.items.findByIds(explicitIds).exec();
      changedItems = explicitIds
        .map((itemId) => {
          const doc = changedById.get(itemId);
          if (!doc) {
            removedIds.add(itemId);
            return null;
          }
          return doc.toMutableJSON() as ItemDocType;
        })
        .filter((item): item is ItemDocType => !!item);
    } else {
      const now = Date.now();
      const since = Math.max(0, this.lastItemSyncAt - 2000);
      const changedDocs = await db.items
        .find({
          selector: {
            $or: [{ updatedAt: { $gte: since } }, { deletedAt: { $gte: since } }],
          },
        })
        .exec();
      if (changedDocs.length === 0) {
        this.lastItemSyncAt = now;
        return 0;
      }

      changedItems = changedDocs.map((doc) => doc.toMutableJSON() as ItemDocType);
    }

    const activeIds = changedItems
      .filter((item) => (item.deletedAt || 0) === 0)
      .map((item) => item.id)
      .filter(Boolean);
    const tagsByItemId = await this.getTagsByItemIds(activeIds);

    for (const removedId of removedIds) {
      await Promise.resolve((this.index as any).remove(removedId));
    }

    for (const item of changedItems) {
      await Promise.resolve((this.index as any).remove(item.id));
      if ((item.deletedAt || 0) !== 0) {
        continue;
      }
      const indexDoc = toIndexDoc(item, (tagsByItemId.get(item.id) || []).join(" "));
      await Promise.resolve((this.index as any).add(indexDoc));
    }

    this.lastItemSyncAt = Date.now();
    return changedItems.length + removedIds.size;
  }

  private async runIncrementalSync(): Promise<void> {
    if (this.incrementalSyncInFlight) {
      this.incrementalSyncQueued = true;
      return;
    }

    this.incrementalSyncInFlight = true;
    try {
      this.emitProcessStatus("processing", "Applying index updates...");
      let totalSynced = 0;
      do {
        this.incrementalSyncQueued = false;
        const batchIds = Array.from(this.pendingItemIds);
        this.pendingItemIds.clear();
        totalSynced += await this.syncItemsIncremental(batchIds.length > 0 ? batchIds : undefined);
      } while (this.incrementalSyncQueued || this.pendingItemIds.size > 0);

      if (totalSynced > 0) {
        this.emitProcessStatus("success", `Indexed ${totalSynced} updated records.`);
      } else {
        this.emitProcessStatus("success", "Index already up to date.");
      }
    } catch (error) {
      console.error("[LocalSearchIndex] Incremental sync failed. Falling back to full rebuild.", error);
      this.markDirty();
      this.emitProcessStatus(
        "error",
        "Index updates failed. Retry to rebuild the index.",
        "REBUILD_INDEX"
      );
    } finally {
      this.incrementalSyncInFlight = false;
    }
  }

  private buildVariants(
    query: string,
    keyword: boolean,
    fuzzy: boolean
  ): SearchVariant[] {
    const normalized = normalizeForIndex(query);
    if (!normalized) return [];

    const byQuery = new Map<string, { boost: number; suggest: boolean }>();
    const addVariant = (variantQuery: string, boost: number, suggest: boolean) => {
      const clean = normalizeForIndex(variantQuery);
      if (!clean) return;
      const current = byQuery.get(clean);
      if (!current || boost > current.boost) {
        byQuery.set(clean, { boost, suggest });
        return;
      }
      current.suggest = current.suggest && suggest;
    };

    if (keyword) {
      // Keyword mode must not quietly turn into fuzzy OR matching.
      addVariant(normalized, 1, false);
    }

    if (fuzzy) {
      addVariant(normalized, keyword ? 0.9 : 1, true);

      const tokens = normalized.split(/\s+/).filter(Boolean);
      const prefix = tokens
        .map((token) => {
          if (token.length <= 3) return token;
          return token.slice(0, token.length - 1);
        })
        .join(" ")
        .trim();
      if (prefix && prefix !== normalized) {
        addVariant(prefix, keyword ? 0.42 : 0.92, true);
      }

      const phonetic = toPhoneticQuery(normalized);
      if (phonetic && phonetic !== normalized) {
        addVariant(phonetic, keyword ? 0.36 : 0.78, true);
      }
    }

    return Array.from(byQuery.entries())
      .map(([variantQuery, options]) => ({ query: variantQuery, ...options }))
      .sort((a, b) => b.boost - a.boost);
  }

  private accumulateScores(
    rawResults: unknown,
    scoreMap: Map<string, number>,
    variantBoost: number,
    includeOcrText: boolean,
    rankOffset: number,
    allowedIds?: ReadonlySet<string>,
    termMatchMasksById?: Map<string, number[]>,
    termMatchIndex = -1
  ) {
    if (!Array.isArray(rawResults)) return;

    for (const row of rawResults as Array<{ field?: string; result?: unknown[] } | unknown>) {
      if (!row || typeof row !== "object" || !("result" in row)) {
        continue;
      }
      const typed = row as { field?: string; result?: unknown[] };
      // OCR text is a keyword-only signal: only exact keyword variants may match
      // it. Fuzzy variants (prefix + phonetic expansion) skip it, otherwise
      // noisy image-extracted text pollutes fuzzy results.
      if (!includeOcrText && typed.field === "ocrText") continue;
      const results = Array.isArray(typed.result) ? typed.result : [];
      const weight = FIELD_WEIGHTS[typed.field || ""] || 1;
      for (let index = 0; index < results.length; index += 1) {
        const id = toIdString(results[index]);
        if (!id) continue;
        if (allowedIds && !allowedIds.has(id)) continue;
        if (termMatchMasksById && termMatchIndex >= 0) {
          const wordIndex = Math.floor(termMatchIndex / 32);
          const termBit = 1 << (termMatchIndex % 32);
          const words = termMatchMasksById.get(id) || [];
          words[wordIndex] = (words[wordIndex] || 0) | termBit;
          termMatchMasksById.set(id, words);
        }
        const score = (weight * variantBoost) / (rankOffset + index + 1);
        scoreMap.set(id, (scoreMap.get(id) || 0) + score);
      }
    }
  }

  private isResultPageSaturated(rawResults: unknown, pageSize: number): boolean {
    if (!Array.isArray(rawResults)) return false;
    return rawResults.some((row) => {
      if (!row || typeof row !== "object" || !("result" in row)) return false;
      const result = (row as { result?: unknown[] }).result;
      return Array.isArray(result) && result.length >= pageSize;
    });
  }

  private getResultPageSignature(rawResults: unknown): string {
    if (!Array.isArray(rawResults)) return "invalid";
    return rawResults
      .map((row) => {
        if (!row || typeof row !== "object" || !("result" in row)) return "invalid-row";
        const typed = row as { field?: string; result?: unknown[] };
        const results = Array.isArray(typed.result) ? typed.result : [];
        const middleIndex = Math.floor(results.length / 2);
        return [
          typed.field || "",
          results.length,
          toIdString(results[0]) || "",
          toIdString(results[middleIndex]) || "",
          toIdString(results[results.length - 1]) || "",
        ].join(":");
      })
      .join("|");
  }

  async searchWithStatus({
    query,
    queries,
    limit,
    keyword,
    fuzzy,
    allowedIds,
    trackTermMatches,
    signal,
  }: SearchRequest): Promise<SearchResult> {
    throwIfOperationAborted(signal);
    await this.ensureReady();
    throwIfOperationAborted(signal);
    if (!this.index) {
      return {
        scores: new Map(),
        saturated: false,
        terms: [],
        termMatchMasksById: new Map(),
      };
    }

    const safeLimit = clamp(limit, 20, 2500);
    const resultPageSize = safeLimit * 3;
    const includeKeyword = keyword !== false;
    const includeFuzzy = fuzzy === true;
    const queryInputs = Array.from(
      new Set(
        (queries?.length ? queries : [query])
          .map((value) => normalizeForIndex(value))
          .filter(Boolean)
      )
    );
    if (queryInputs.length === 0 || allowedIds?.size === 0) {
      return {
        scores: new Map(),
        saturated: false,
        terms: queryInputs,
        termMatchMasksById: new Map(),
      };
    }
    const scoreMap = new Map<string, number>();
    const termMatchMasksById = new Map<string, number[]>();
    let saturated = false;

    for (let queryIndex = 0; queryIndex < queryInputs.length; queryIndex += 1) {
      const queryInput = queryInputs[queryIndex];
      const termMatchIndex = trackTermMatches ? queryIndex : -1;
      const variants = this.buildVariants(queryInput, includeKeyword, includeFuzzy);
      for (const variant of variants) {
        let offset = 0;
        let pagesRead = 0;
        let previousPageSignature: string | null = null;

        while (pagesRead < MAX_SCOPED_SEARCH_PAGES) {
          throwIfOperationAborted(signal);
          const results = await Promise.resolve(
            (this.index as any).search(variant.query, {
              limit: resultPageSize,
              offset,
              suggest: variant.suggest,
            })
          );
          throwIfOperationAborted(signal);
          const pageSaturated = this.isResultPageSaturated(results, resultPageSize);
          const pageSignature = this.getResultPageSignature(results);
          if (pageSignature === previousPageSignature) {
            break;
          }
          previousPageSignature = pageSignature;
          pagesRead += 1;
          if (offset === 0 && pageSaturated) saturated = true;
          this.accumulateScores(
            results,
            scoreMap,
            variant.boost,
            !variant.suggest,
            offset,
            allowedIds,
            trackTermMatches ? termMatchMasksById : undefined,
            termMatchIndex
          );

          if (!allowedIds || !pageSaturated) {
            break;
          }
          offset += resultPageSize;
          // Let input, timers, and cancellation work run between large index
          // pages instead of monopolizing the offscreen document's event loop.
          await new Promise<void>((resolve) => setTimeout(resolve, 0));
          throwIfOperationAborted(signal);
        }
      }
    }

    return {
      scores: scoreMap,
      saturated,
      terms: trackTermMatches ? queryInputs : [],
      termMatchMasksById,
    };
  }

  async search(request: SearchRequest): Promise<Map<string, number>> {
    return (await this.searchWithStatus(request)).scores;
  }
}

export const localSearchIndexService = new LocalSearchIndexService();
