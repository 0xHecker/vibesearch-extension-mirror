import { getDb } from "@src/services/DatabaseService";
import { ItemDocType } from "@src/schemas/item_schema";
import { FolderDocType } from "@src/schemas/folder_schema";
import {
  cloneOpfsMediaEntriesForItem,
  inferMediaType,
  isGifUrl,
  categorizeMedia,
  getMediaCounts,
  canAddMedia,
  MEDIA_LIMITS,
  opfsFileIdentitiesEqual,
  readOpfsFileIdentity,
  withOpfsMutationLock,
  type OpfsFileIdentity,
  type MediaCategory,
} from "@src/services/media-storage";
import {
  deleteUnreferencedOpfsFiles,
  deleteUnreferencedOpfsItemDirectories,
} from "@src/services/opfs-media-lifecycle";
import type {
  QueryDebugPayload,
  QueryTextExpression,
  RankQueryCursor,
  RankableItem,
} from "@src/search-core/contracts";
import { resolveEffectiveQueryChannels } from "@src/search-core/contracts";
import { v4 as uuidv4 } from "uuid";
import { databaseManager } from "@src/services/db-manager";
import { appendOcrTextToTextContent } from "@src/services/ocr-text";
import { isYouTubeShortsUrl } from "@src/utils/media-embed";
import {
  vectorStoreService,
  type VectorQueryLease,
} from "@src/services/vector-store.service";
import { localSearchIndexService } from "@src/services/local-search-index.service";
import { hasVectorReference } from "@src/search-core/embedding-state";
import { appendUnorderedIds } from "@src/utils/ordered-ids";
import { isMetadataFetchableUrl } from "@src/utils/metadata-url";
import {
  computeBaseRelevance,
  shouldKeepHybridRankHit,
  VECTOR_HIT_FLOOR,
} from "@src/search-core/hybrid-ranking";
import { MAX_GRID_QUERY_LIMIT, splitLookaheadPage } from "@src/search-core/pagination";
import { PRIVATE_SPACE_ID, PUBLIC_SPACE_ID } from "@src/common/spaces";
import { spaceSessionService } from "@src/services/space-session.service";
import {
  createRestoreTabGroup,
  resolveRestoreSpace,
  restoreFallbackMessage,
} from "@src/services/bin-restore-location";
import {
  queryRankerService,
  RANK_REQUEST_SUPERSEDED,
  RankWorkerCapacityError,
  SupersededRankRequestError,
} from "@src/services/query-ranker.service";
import { normalizeSearchIndexText } from "@src/search-core/search-text";
import {
  forEachIdKeysetPage,
  readIdKeysetPage,
} from "@src/services/rxdb-keyset-pagination";
import {
  streamRankCandidates,
  shouldStreamRankCandidates,
  STREAMING_RANK_HYDRATION_BATCH_SIZE,
} from "@src/services/streaming-query-ranker";
import {
  canNarrowExpressionToPositiveMatches,
  expressionCanMatchWithoutPositiveTerm,
} from "@src/search-core/expression-analysis";
import {
  compareRankedEntries,
  compareRankField,
  isRankedEntryAfterCursor,
} from "@src/search-core/rank-order";
import { resolveIncludedTagIds } from "@src/search-core/tag-filter";
import {
  withBinMutationLock,
  withEntityMutationLock,
  withSpaceMutationLocks,
} from "@src/services/entity-mutation-lock";
import { nextBinMutationTimestamp } from "@src/common/bin";
import {
  requireLiveFolderDestination,
  requireLiveSpaceDestination,
  withLiveFolderDestination,
} from "@src/services/live-destination";

type LocalQuerySortBy = "relevance" | "createdAt" | "updatedAt" | "title" | "source";
type LocalQuerySortOrder = "asc" | "desc";
const MAX_VECTOR_TOPK = 4000;
const MAX_LEXICAL_SCORE_BUDGET = 8000;
const MAX_RANK_INPUT_ITEMS = 12000;
const MIN_PRUNE_CANDIDATES = 80;
const MIN_SCORE_BUDGET = 600;
const SCORE_BUDGET_MULTIPLIER = 8;
const MAX_RANK_TEXT_CHARS = 6000;
const MS_PER_DAY = 24 * 60 * 60 * 1000;
const LEXICAL_SEARCH_TIMEOUT_MS = 4000;
const VECTOR_SEARCH_TIMEOUT_MS = 3500;
const VECTOR_QUERY_MIN_CHARS = 3;
const SCOPED_CANDIDATE_PAGE_SIZE = 250;

type ItemMediaEntry = NonNullable<ItemDocType["media"]>[number];

type ItemsControllerOptions = {
  readOpfsFileIdentity?: typeof readOpfsFileIdentity;
  cloneOpfsMediaEntriesForItem?: typeof cloneOpfsMediaEntriesForItem;
  deleteUnreferencedOpfsItemDirectories?: typeof deleteUnreferencedOpfsItemDirectories;
};

const mediaEntryKey = (entry: ItemMediaEntry): string | null => {
  const value = entry.embedUrl || entry.s3Url || entry.opfsPath || entry.originalUrl;
  if (typeof value !== "string" || value.trim().length === 0) return null;
  return `${entry.type}:${value.trim()}`;
};

const mergeFetchedMedia = (
  currentMedia: ItemDocType["media"],
  fetchedMedia: ItemDocType["media"]
): ItemDocType["media"] => {
  if (!fetchedMedia || fetchedMedia.length === 0) return currentMedia;
  if (!currentMedia || currentMedia.length === 0) return fetchedMedia;

  const existing: ItemMediaEntry[] = [];
  const acceptedFetched: ItemMediaEntry[] = [];
  const seen = new Set<string>();
  const counts = getMediaCounts(
    currentMedia.map((entry) => ({
      type: entry.type,
      originalUrl: entry.originalUrl || entry.s3Url || "",
    }))
  );

  const remember = (entry: ItemMediaEntry) => {
    const key = mediaEntryKey(entry);
    if (key && seen.has(key)) return;
    if (key) seen.add(key);
    existing.push(entry);
  };

  for (const entry of currentMedia) remember(entry);

  for (const entry of fetchedMedia) {
    const key = mediaEntryKey(entry);
    if (key && seen.has(key)) continue;
    const category = categorizeMedia({
      type: entry.type,
      originalUrl: entry.originalUrl || entry.s3Url || "",
    });
    if (counts[category] >= MEDIA_LIMITS[category]) continue;
    counts[category] += 1;
    if (key) seen.add(key);
    acceptedFetched.push(entry);
  }

  const storedExisting = existing.filter(
    (entry) => entry.storageType === "opfs" || entry.storageType === "s3"
  );
  const hotlinkExisting = existing.filter(
    (entry) => entry.storageType === "hotlink"
  );

  return [...storedExisting, ...acceptedFetched, ...hotlinkExisting];
};

const hasStoredMedia = (media: ItemDocType["media"]): boolean =>
  (media || []).some((entry) => entry.storageType === "opfs" || entry.storageType === "s3");

const canonicalizeMediaSnapshot = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(canonicalizeMediaSnapshot);
  if (!value || typeof value !== "object") return value;
  return Object.keys(value as Record<string, unknown>)
    .sort()
    .reduce<Record<string, unknown>>((out, key) => {
      const next = (value as Record<string, unknown>)[key];
      if (next !== undefined) out[key] = canonicalizeMediaSnapshot(next);
      return out;
    }, {});
};

const mediaSnapshotsEqual = (
  left: ItemDocType["media"],
  right: ItemDocType["media"]
): boolean =>
  JSON.stringify(canonicalizeMediaSnapshot(left || [])) ===
  JSON.stringify(canonicalizeMediaSnapshot(right || []));

type LocalQueryPayload = {
  /** Stable for the lifetime of one Search page. Queries only supersede work in the same client. */
  searchClientId?: string;
  query?: string;
  text?: {
    groups?: string[][];
    excludedTerms?: string[];
    expression?: QueryTextExpression;
  };
  useKeyword?: boolean;
  useVector?: boolean;
  useFuzzy?: boolean;
  topK?: number;
  minScore?: number;
  pagination?: {
    limit?: number;
    page?: number;
    afterCursor?: RankQueryCursor | null;
  };
  filters?: {
    spaceIds?: string[];
    excludeSpaceIds?: string[];
    folderIds?: string[];
    excludeFolderIds?: string[];
    sources?: ItemDocType["source"][];
    excludeSources?: ItemDocType["source"][];
    favoritesOnly?: boolean;
    tagIds?: string[];
    tagNames?: string[];
    excludeTagNames?: string[];
    domains?: string[];
    excludeDomains?: string[];
    authors?: string[];
    excludeAuthors?: string[];
    hasAny?: Array<"image" | "video" | "media" | "embed">;
    excludeHasAny?: Array<"image" | "video" | "media" | "embed">;
    dateFrom?: number;
    dateTo?: number;
    createdFrom?: number;
    createdTo?: number;
    updatedFrom?: number;
    updatedTo?: number;
    likesMin?: number;
    likesMax?: number;
    upvotesMin?: number;
    upvotesMax?: number;
  };
  sort?: {
    by?: LocalQuerySortBy;
    order?: LocalQuerySortOrder;
  };
  accessContext?: {
    activeSpaceId?: string;
    searchScope?: "current" | "global" | "private" | "public";
  };
  debug?: boolean;
};

type LocalQueryResponse = {
  items: ItemDocType[];
  total: number;
  totalIsExact: boolean;
  vectorHits: number;
  lexicalHits: number;
  vectorError?: string | null;
  sortBy: LocalQuerySortBy;
  sortOrder: LocalQuerySortOrder;
  page: number;
  limit: number;
  hasMore: boolean;
  nextCursor?: RankQueryCursor | null;
  diagnostics?: {
    queryHash: string;
    candidateCount: number;
    rankInputCount: number;
    rankRetainedPeakCount?: number;
    rankHydrationBatchSize?: number;
    usedSimpleSortPath: boolean;
    scoreBudget: number;
    supersededCount: number;
    fallbackCount: number;
    selectorMs: number;
    filterMs: number;
    lexicalMs: number;
    vectorMs: number;
    vectorEmbedMs: number;
    vectorScanMs: number;
    rankMs: number;
    hydrateMs: number;
    totalMs: number;
  };
  debug?: QueryDebugPayload;
};

type CandidateLite = {
  id: string;
  spaceId: string;
  folderId: string;
  source: ItemDocType["source"];
  isFavorite: boolean;
  authorUsername: string;
  url: string;
  domain: string | null;
  mediaTypes: Array<"image" | "video">;
  hasMedia: boolean;
  hasEmbed: boolean;
  vectorIndex: number;
  vectorIndexes: number[];
  title: string;
  createdAt: number;
  updatedAt: number;
};

type RankedLiteEntry = {
  item: Pick<RankableItem, "id" | "title" | "source" | "createdAt" | "updatedAt">;
  relevance: number;
};

type VectorScoreResult = {
  index: number;
  score: number;
};

type SearchRequestContext = {
  clientId: string;
  generation: number;
  queryAbortController: AbortController;
  lexicalAbortController: AbortController | null;
  vectorAbortController: AbortController | null;
};

const DEFAULT_SEARCH_CLIENT_ID = "__legacy_search_client__";
const MAX_SEARCH_CLIENT_ID_LENGTH = 128;

export class ItemsController {
  [key: string]: any;
  constructor(private readonly options: ItemsControllerOptions = {}) {}
  private rankTelemetry = {
    supersededCount: 0,
    fallbackCount: 0,
  };
  private searchGeneration = 0;
  private searchContextsByClient = new Map<string, SearchRequestContext>();
  private searchContextsByGeneration = new Map<number, SearchRequestContext>();
  // Retained as mirrors for legacy tests/callers which exercise the default
  // lane directly. Real Search pages use their own entries in the maps above.
  private activeQueryAbortController: AbortController | null = null;
  private activeLexicalSearchAbortController: AbortController | null = null;
  private activeVectorSearchAbortController: AbortController | null = null;
  private vectorStore = vectorStoreService;

  private normalizeSearchClientId(clientId?: string): string {
    const normalized = typeof clientId === "string" ? clientId.trim() : "";
    return normalized
      ? normalized.slice(0, MAX_SEARCH_CLIENT_ID_LENGTH)
      : DEFAULT_SEARCH_CLIENT_ID;
  }

  private abortSearchContext(context: SearchRequestContext): void {
    const reason = new Error(RANK_REQUEST_SUPERSEDED);
    context.queryAbortController.abort(reason);
    context.lexicalAbortController?.abort(reason);
    context.vectorAbortController?.abort(reason);
  }

  private beginSearchGeneration(clientId?: string): number {
    const normalizedClientId = this.normalizeSearchClientId(clientId);
    const previous = this.searchContextsByClient.get(normalizedClientId);
    if (previous) {
      this.abortSearchContext(previous);
      this.searchContextsByGeneration.delete(previous.generation);
    }

    const generation = ++this.searchGeneration;
    const context: SearchRequestContext = {
      clientId: normalizedClientId,
      generation,
      queryAbortController: new AbortController(),
      lexicalAbortController: null,
      vectorAbortController: null,
    };
    this.searchContextsByClient.set(normalizedClientId, context);
    this.searchContextsByGeneration.set(generation, context);

    if (normalizedClientId === DEFAULT_SEARCH_CLIENT_ID) {
      this.activeQueryAbortController = context.queryAbortController;
      this.activeLexicalSearchAbortController = null;
      this.activeVectorSearchAbortController = null;
    }
    return generation;
  }

  private getSearchContext(generation: number): SearchRequestContext {
    const context = this.searchContextsByGeneration.get(generation);
    if (
      !context ||
      this.searchContextsByClient.get(context.clientId) !== context ||
      context.queryAbortController.signal.aborted
    ) {
      throw new SupersededRankRequestError();
    }
    return context;
  }

  private assertSearchGeneration(generation: number): void {
    this.getSearchContext(generation);
  }

  private getSearchSignal(generation: number): AbortSignal {
    return this.getSearchContext(generation).queryAbortController.signal;
  }

  private getSearchClientId(generation: number): string {
    return this.getSearchContext(generation).clientId;
  }

  private startLexicalSearchPhase(generation: number): AbortController {
    const context = this.getSearchContext(generation);
    context.lexicalAbortController?.abort(new Error(RANK_REQUEST_SUPERSEDED));
    const controller = new AbortController();
    context.lexicalAbortController = controller;
    if (context.clientId === DEFAULT_SEARCH_CLIENT_ID) {
      this.activeLexicalSearchAbortController = controller;
    }
    return controller;
  }

  private finishLexicalSearchPhase(generation: number, controller: AbortController): void {
    const context = this.searchContextsByGeneration.get(generation);
    if (!context || context.lexicalAbortController !== controller) return;
    context.lexicalAbortController = null;
    if (
      context.clientId === DEFAULT_SEARCH_CLIENT_ID &&
      this.activeLexicalSearchAbortController === controller
    ) {
      this.activeLexicalSearchAbortController = null;
    }
  }

  private startVectorSearchPhase(generation: number): AbortController {
    const context = this.getSearchContext(generation);

    // The generation check and assignment are synchronous. Aborting here as
    // well makes replacement safe even if another current phase was installed
    // by a future call path.
    context.vectorAbortController?.abort(new Error(RANK_REQUEST_SUPERSEDED));
    const controller = new AbortController();
    context.vectorAbortController = controller;
    if (context.clientId === DEFAULT_SEARCH_CLIENT_ID) {
      this.activeVectorSearchAbortController = controller;
    }
    return controller;
  }

  private finishVectorSearchPhase(generation: number, controller: AbortController): void {
    const context = this.searchContextsByGeneration.get(generation);
    if (!context || context.vectorAbortController !== controller) return;
    context.vectorAbortController = null;
    if (
      context.clientId === DEFAULT_SEARCH_CLIENT_ID &&
      this.activeVectorSearchAbortController === controller
    ) {
      this.activeVectorSearchAbortController = null;
    }
  }

  private finishSearchGeneration(generation: number): void {
    const context = this.searchContextsByGeneration.get(generation);
    if (!context || this.searchContextsByClient.get(context.clientId) !== context) return;

    this.searchContextsByGeneration.delete(generation);
    this.searchContextsByClient.delete(context.clientId);
    context.lexicalAbortController = null;
    context.vectorAbortController = null;

    if (context.clientId === DEFAULT_SEARCH_CLIENT_ID) {
      if (this.activeQueryAbortController === context.queryAbortController) {
        this.activeQueryAbortController = null;
      }
      this.activeLexicalSearchAbortController = null;
      this.activeVectorSearchAbortController = null;
    }
  }

  private normalizeUserId(userId: string | null | undefined): string {
    return typeof userId === "string" ? userId : "";
  }

  private assertSpaceUnlocked(spaceId: string): void {
    if (spaceId === PRIVATE_SPACE_ID && !spaceSessionService.isUnlocked(PRIVATE_SPACE_ID)) {
      throw new Error("PRIVATE_SPACE_LOCKED");
    }
  }

  private sanitize<T extends Record<string, any>>(obj: T): T {
    const copy: Record<string, any> = {};
    Object.keys(obj).forEach((k) => {
      const v = (obj as any)[k];
      if (v !== undefined) copy[k] = v;
    });
    return copy as T;
  }

  private async removeDeletedItemTombstone(db: any, id: string): Promise<void> {
    if (!db.deleted_items?.findOne) return;
    const tombstone = await db.deleted_items.findOne(id).exec();
    if (tombstone) await tombstone.remove();
  }

  markSearchIndexDirty() {
    localSearchIndexService.markDirty();
  }

  scheduleSearchIndexSync(changedItemIds?: string[]) {
    localSearchIndexService.scheduleItemSync(changedItemIds);
  }

  private triggerBackgroundProcessing(type: "TRIGGER_EMBEDDING" | "TRIGGER_OCR") {
    try {
      chrome.runtime.sendMessage({
        type,
        target: "background",
      }).catch?.(() => {});
    } catch {}
  }

  private tokenizeQuery(query: string): string[] {
    return query
      .split(/\s+/)
      .map((part) => part.trim())
      .filter(Boolean);
  }

  private resolveVectorQueryText(payload: LocalQueryPayload): string {
    const query = (payload.query || "").trim();
    const expressionTerms = payload.text?.expression
      ? this.collectPositiveExpressionTerms(payload.text.expression)
      : [];
    const groupedTerms = (payload.text?.groups || [])
      .flat()
      .map((term) => term.trim())
      .filter(Boolean);
    const positiveTerms = expressionTerms.length > 0
      ? expressionTerms
      : groupedTerms.length > 0
        ? groupedTerms
        : this.tokenizeQuery(query);
    return Array.from(new Set(positiveTerms)).join(" ") || query;
  }

  private normalizeText(input: string): string {
    return input
      .normalize("NFKD")
      .replace(/[\u0300-\u036f]/g, "")
      .toLowerCase();
  }

  private stableHash(input: string): string {
    let hash = 2166136261;
    for (let i = 0; i < input.length; i++) {
      hash ^= input.charCodeAt(i);
      hash = Math.imul(hash, 16777619);
    }
    return (hash >>> 0).toString(36);
  }

  private async withTimeout<T>(
    promise: Promise<T>,
    timeoutMs: number,
    message: string,
    onTimeout?: () => void
  ): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | null = null;
    const timeoutPromise = new Promise<T>((_, reject) => {
      timer = setTimeout(() => {
        onTimeout?.();
        reject(new Error(message));
      }, timeoutMs);
    });

    try {
      return await Promise.race([promise, timeoutPromise]);
    } finally {
      if (timer !== null) {
        clearTimeout(timer);
      }
    }
  }

  private buildQueryHash(payload: {
    query: string;
    expression?: QueryTextExpression;
    groups: string[][];
    excludedTerms: string[];
    filters: LocalQueryPayload["filters"];
    accessContext?: LocalQueryPayload["accessContext"];
    sortBy: LocalQuerySortBy;
    sortOrder: LocalQuerySortOrder;
    useKeyword: boolean;
    useVector: boolean;
    useFuzzy: boolean;
  }): string {
    const normalizedPayload = {
      query: payload.query,
      expression: payload.expression || null,
      groups: payload.groups,
      excludedTerms: payload.excludedTerms,
      filters: payload.filters || {},
      accessContext: payload.accessContext || {},
      sortBy: payload.sortBy,
      sortOrder: payload.sortOrder,
      useKeyword: payload.useKeyword,
      useVector: payload.useVector,
      useFuzzy: payload.useFuzzy,
    };
    return this.stableHash(JSON.stringify(normalizedPayload));
  }

  private getItemSearchText(item: ItemDocType | RankableItem): string {
    const mediaText =
      "mediaTypes" in item
        ? (item.mediaTypes || []).join(" ")
        : (item.media || []).map((entry) => entry.type).join(" ");
    return this.normalizeText(
      [item.title, item.textContent, item.ocrText, item.url, item.source, item.authorUsername, mediaText]
        .filter(Boolean)
        .join(" ")
    );
  }

  private recencyBoost(updatedAt: number, createdAt: number, now: number): number {
    const reference = Math.max(updatedAt || 0, createdAt || 0);
    if (!reference) return 0;
    const ageDays = Math.max(0, (now - reference) / MS_PER_DAY);
    if (ageDays <= 3) return 0.06;
    if (ageDays >= 180) return 0;
    return (1 - ageDays / 180) * 0.06;
  }

  private toRankableItem(item: CandidateLite, textContent: string, ocrText: string): RankableItem {
    return {
      id: item.id,
      title: item.title || "",
      textContent: (textContent || "").slice(0, MAX_RANK_TEXT_CHARS),
      ocrText: (ocrText || "").slice(0, MAX_RANK_TEXT_CHARS),
      url: item.url || "",
      source: item.source,
      authorUsername: item.authorUsername,
      mediaTypes: item.mediaTypes,
      vector_index: item.vectorIndex,
      vector_indexes: item.vectorIndexes,
      createdAt: item.createdAt || 0,
      updatedAt: item.updatedAt || 0,
    };
  }

  private sanitizeVectorIndexes(raw: unknown, fallback: number): number[] {
    const indexes = Array.isArray(raw) ? raw : [];
    const normalized = indexes
      .filter((index): index is number => Number.isInteger(index) && index >= 0);
    if (normalized.length === 0 && fallback >= 0) normalized.push(fallback);
    return Array.from(new Set(normalized));
  }

  private toCandidateLite(doc: any): CandidateLite {
    const media = (doc.get("media") as ItemDocType["media"] | undefined) || [];
    const mediaTypes = Array.from(
      new Set(
        media
          .map((entry) => entry.type)
          .filter((type): type is "image" | "video" => type === "image" || type === "video")
      )
    );
    const url = (doc.get("url") as string | undefined) || "";
    // Compaction can remap vector indexes before the changed item has been
    // re-embedded. Only rows explicitly marked current may contribute vector
    // candidates; dirty/unembedded rows would otherwise rank on stale content.
    const hasCurrentEmbedding = doc.get("isEmbedded") === true && doc.get("isDirty") !== true;
    const vectorIndexRaw = hasCurrentEmbedding ? doc.get("vector_index") : undefined;
    const vectorIndex =
      typeof vectorIndexRaw === "number" && Number.isInteger(vectorIndexRaw) && vectorIndexRaw >= 0
        ? vectorIndexRaw
        : -1;
    const vectorIndexes = hasCurrentEmbedding
      ? this.sanitizeVectorIndexes(doc.get("vector_indexes"), vectorIndex)
      : [];

    return {
      id: (doc.get("id") as string) || "",
      spaceId: (doc.get("spaceId") as string) || PUBLIC_SPACE_ID,
      folderId: (doc.get("folderId") as string) || "",
      source: ((doc.get("source") as ItemDocType["source"] | undefined) || "web") as ItemDocType["source"],
      isFavorite: !!doc.get("isFavorite"),
      authorUsername: ((doc.get("authorUsername") as string | undefined) || "").toLowerCase(),
      url,
      domain: this.parseHostname(url),
      mediaTypes,
      hasMedia: media.length > 0,
      hasEmbed: media.some((entry) => entry.embedType === "iframe" || !!entry.embedUrl),
      vectorIndex,
      vectorIndexes,
      title: (doc.get("title") as string | undefined) || "",
      createdAt: (doc.get("createdAt") as number | undefined) || 0,
      updatedAt: (doc.get("updatedAt") as number | undefined) || 0,
    };
  }

  private async hydrateItemsByIds(db: any, itemIds: string[]): Promise<ItemDocType[]> {
    if (itemIds.length === 0) return [];
    const docsById = await db.items.findByIds(itemIds).exec();
    return itemIds
      .map((id) => {
        const doc = docsById.get(id);
        if (!doc) return null;
        return doc.toMutableJSON() as ItemDocType;
      })
      .filter((item): item is ItemDocType => !!item);
  }

  private matchesBooleanTerms(
    itemText: string,
    groups: string[][],
    excludedTerms: string[]
  ): { matches: boolean; matchedTermCount: number } {
    for (const excluded of excludedTerms) {
      if (excluded && itemText.includes(this.normalizeText(excluded))) {
        return { matches: false, matchedTermCount: 0 };
      }
    }

    if (groups.length === 0) {
      return { matches: true, matchedTermCount: 0 };
    }

    for (const group of groups) {
      let groupMatch = true;
      for (const term of group) {
        if (!term || !itemText.includes(this.normalizeText(term))) {
          groupMatch = false;
          break;
        }
      }
      if (groupMatch) {
        return { matches: true, matchedTermCount: group.length };
      }
    }

    return { matches: false, matchedTermCount: 0 };
  }

  private textTermMatches(
    itemText: string,
    rawTerm: string,
    lexicalTermMatched?: (normalizedTerm: string) => boolean
  ): boolean {
    const exactValue = this.normalizeText(rawTerm).trim();
    if (!exactValue) return false;
    if (itemText.includes(exactValue)) return true;
    return lexicalTermMatched?.(normalizeSearchIndexText(rawTerm)) === true;
  }

  private evaluateTextExpression(
    itemText: string,
    node: QueryTextExpression,
    lexicalTermMatched?: (normalizedTerm: string) => boolean
  ): boolean {
    if (node.type === "TERM") {
      if (!node.value?.trim()) return true;
      return this.textTermMatches(itemText, node.value, lexicalTermMatched);
    }

    if (node.type === "NOT") {
      return !this.evaluateTextExpression(itemText, node.child, lexicalTermMatched);
    }

    if (node.type === "AND") {
      return node.children.every((child) =>
        this.evaluateTextExpression(itemText, child, lexicalTermMatched)
      );
    }

    return node.children.some((child) =>
      this.evaluateTextExpression(itemText, child, lexicalTermMatched)
    );
  }

  private collectPositiveExpressionTerms(
    node: QueryTextExpression,
    isNegated = false,
    result: string[] = []
  ): string[] {
    if (node.type === "TERM") {
      if (!isNegated && node.value.trim()) {
        result.push(node.value.trim());
      }
      return result;
    }

    if (node.type === "NOT") {
      return this.collectPositiveExpressionTerms(node.child, !isNegated, result);
    }

    for (const child of node.children) {
      this.collectPositiveExpressionTerms(child, isNegated, result);
    }
    return result;
  }

  private toRankCursor(entry: RankedLiteEntry, queryHash: string): RankQueryCursor {
    return {
      queryHash,
      id: entry.item.id,
      relevance: entry.relevance,
      createdAt: entry.item.createdAt || 0,
      updatedAt: entry.item.updatedAt || 0,
      title: entry.item.title || "",
      source: entry.item.source,
    };
  }

  private selectVectorResults(results: VectorScoreResult[], minScore?: number): {
    pruned: VectorScoreResult[];
    topScore: number;
    minAcceptedScore: number;
  } {
    const threshold =
      typeof minScore === "number" && Number.isFinite(minScore) ? minScore : null;
    // Results arrive sorted by score (desc), so filtering preserves order.
    const filtered =
      threshold !== null ? results.filter((result) => result.score >= threshold) : results;
    if (filtered.length === 0) {
      return {
        pruned: [],
        topScore: Number.NEGATIVE_INFINITY,
        minAcceptedScore: Number.POSITIVE_INFINITY,
      };
    }

    return {
      pruned: filtered,
      topScore: filtered[0]?.score ?? Number.NEGATIVE_INFINITY,
      minAcceptedScore: filtered[filtered.length - 1]?.score ?? Number.POSITIVE_INFINITY,
    };
  }

  private rankLocally(args: {
    items: RankableItem[];
    expression?: QueryTextExpression;
    groups: string[][];
    excludedTerms: string[];
    flatPositiveTerms: string[];
    hasTextConstraint: boolean;
    useLexical: boolean;
    useVector: boolean;
    sortBy: LocalQuerySortBy;
    sortOrder: LocalQuerySortOrder;
    page: number;
    limit: number;
    queryHash: string;
    afterCursor?: RankQueryCursor | null;
    lexicalScores: Map<string, number>;
    lexicalMatchTerms?: string[];
    lexicalMatchMasksById?: Map<string, number[]>;
    vectorScoresByIndex: Map<number, number>;
    includeDebug?: boolean;
  }): {
    itemIds: string[];
    total: number;
    vectorHits: number;
    lexicalHits: number;
    hasMore: boolean;
    nextCursor?: RankQueryCursor | null;
    debugScores?: QueryDebugPayload["perItem"];
  } {
    const RECENCY_TIE_BREAK_WEIGHT = 0.45;
    const hasPositiveTextTerms = args.flatPositiveTerms.length > 0;
    const allowsPositiveFreeTextMatch =
      args.hasTextConstraint &&
      !!args.expression &&
      expressionCanMatchWithoutPositiveTerm(args.expression);
    const hasLexicalScores = args.lexicalScores.size > 0;
    const needsTextEvaluation = args.hasTextConstraint || (args.useLexical && !hasLexicalScores);
    const lexicalTermBits = new Map<string, { wordIndex: number; bit: number }>(
      (args.lexicalMatchTerms || []).map((term, index) => [
        term,
        { wordIndex: Math.floor(index / 32), bit: 1 << (index % 32) },
      ])
    );
    const itemTextCache = new Map<string, string>();
    const now = Date.now();
    const maxLexicalScore = (() => {
      let max = 0;
      for (const score of args.lexicalScores.values()) {
        if (score > max) max = score;
      }
      return max;
    })();
    const lexicalRankById = args.includeDebug
      ? new Map<string, number>(
          Array.from(args.lexicalScores.entries())
            .sort((a, b) => b[1] - a[1])
            .map(([id], index) => [id, index + 1])
        )
      : null;
    const vectorRankByIndex = args.includeDebug
      ? new Map<number, number>(
          Array.from(args.vectorScoresByIndex.entries())
            .sort((a, b) => b[1] - a[1])
            .map(([index], rank) => [index, rank + 1])
        )
      : null;
    const getBestVectorHit = (item: RankableItem): { score: number; rank?: number; hasHit: boolean } => {
      const fallback =
        typeof item.vector_index === "number" && Number.isInteger(item.vector_index) ? item.vector_index : -1;
      const indexes = this.sanitizeVectorIndexes(item.vector_indexes, fallback);
      let bestScore = 0;
      let bestRank: number | undefined;
      let found = false;
      for (const index of indexes) {
        if (!args.vectorScoresByIndex.has(index)) continue;
        const score = args.vectorScoresByIndex.get(index) || 0;
        if (!found || score > bestScore) {
          bestScore = score;
          bestRank = vectorRankByIndex?.get(index);
          found = true;
        }
      }
      return { score: bestScore, rank: bestRank, hasHit: found && bestScore >= VECTOR_HIT_FLOOR };
    };

    const ranked = args.items.map((item) => {
      let itemText = "";
      let boolMatch: { matches: boolean; matchedTermCount: number } = {
        matches: true,
        matchedTermCount: 0,
      };

      if (needsTextEvaluation) {
        itemText = itemTextCache.get(item.id) || this.getItemSearchText(item);
        itemTextCache.set(item.id, itemText);
        const lexicalMatchWords = args.lexicalMatchMasksById?.get(item.id) || [];
        const lexicalTermMatched = (normalizedTerm: string) => {
          const termPosition = lexicalTermBits.get(normalizedTerm);
          return !!termPosition &&
            ((lexicalMatchWords[termPosition.wordIndex] || 0) & termPosition.bit) !== 0;
        };

        boolMatch = args.expression
          ? {
              matches: this.evaluateTextExpression(
                itemText,
                args.expression,
                lexicalTermMatched
              ),
              matchedTermCount: args.flatPositiveTerms.reduce((count, term) => {
                return this.textTermMatches(itemText, term, lexicalTermMatched)
                  ? count + 1
                  : count;
              }, 0),
            }
          : this.matchesBooleanTerms(itemText, args.groups, args.excludedTerms);
      }

      const lexicalScore = args.useLexical ? args.lexicalScores.get(item.id) || 0 : 0;
      const hasLexicalHit = args.useLexical
        ? hasPositiveTextTerms
          ? lexicalScore > 0 || boolMatch.matchedTermCount > 0
          : boolMatch.matches
        : false;

      const vectorHit = getBestVectorHit(item);
      const vectorScore = vectorHit.score;
      const hasVectorHit = vectorHit.hasHit;
      const lexicalRank = args.useLexical ? lexicalRankById?.get(item.id) : undefined;
      const vectorRank = args.useVector ? vectorHit.rank : undefined;

      const baseRelevance = computeBaseRelevance({
        useLexical: args.useLexical,
        useVector: args.useVector,
        hasLexicalHit,
        hasVectorHit,
        vectorScore,
        lexicalScore,
        maxLexicalScore,
        matchedTermCount: boolMatch.matchedTermCount,
        positiveTermCount: args.flatPositiveTerms.length,
      });
      const recencyTieBreak =
        this.recencyBoost(item.updatedAt || 0, item.createdAt || 0, now) *
        RECENCY_TIE_BREAK_WEIGHT;
      const relevance = baseRelevance + recencyTieBreak;

      return {
        item,
        boolMatch,
        hasLexicalHit,
        relevance,
        hasVectorHit,
        lexicalScore,
        vectorScore,
        lexicalRank,
        vectorRank,
      };
    });

    let filtered = ranked;
    if (args.hasTextConstraint) {
      filtered = ranked.filter((entry) => {
        if (!entry.boolMatch.matches) return false;
        if (allowsPositiveFreeTextMatch) return true;
        if (args.useVector && args.useLexical) {
          if (hasPositiveTextTerms) {
            return entry.hasVectorHit || entry.hasLexicalHit;
          }
          return true;
        }
        if (args.useVector && !args.useLexical) {
          return hasPositiveTextTerms ? entry.hasVectorHit : true;
        }
        if (args.useLexical) {
          return entry.hasLexicalHit;
        }
        return true;
      });
    }
    filtered = filtered.filter((entry) =>
      allowsPositiveFreeTextMatch && entry.boolMatch.matches
        ? true
        : shouldKeepHybridRankHit(entry, {
            useLexical: args.useLexical,
            useVector: args.useVector,
            hasPositiveTextTerms,
          })
    );

    const compareEntries = (
      a: { item: RankableItem; relevance: number },
      b: { item: RankableItem; relevance: number }
    ) => compareRankedEntries(a, b, args.sortBy, args.sortOrder);

    filtered.sort(compareEntries);

    const hasAfterCursor = !!args.afterCursor && args.afterCursor?.queryHash === args.queryHash;
    const pageBase = hasAfterCursor
      ? (() => {
          const cursor = args.afterCursor as RankQueryCursor;
          const cursorComparable = {
            item: {
              id: cursor.id,
              title: cursor.title || "",
              textContent: "",
              ocrText: "",
              url: "",
              source: cursor.source,
              authorUsername: "",
              mediaTypes: [],
              vector_index: -1,
              vector_indexes: [],
              createdAt: cursor.createdAt || 0,
              updatedAt: cursor.updatedAt || 0,
            } as RankableItem,
            relevance: Number.isFinite(cursor.relevance) ? cursor.relevance : 0,
            boolMatch: { matches: true, matchedTermCount: 0 },
            hasLexicalHit: false,
            hasVectorHit: false,
          };
          return filtered.filter((entry) =>
            isRankedEntryAfterCursor(entry, cursorComparable, compareEntries)
          );
        })()
      : filtered;

    const total = filtered.length;
    const pageBaseTotal = pageBase.length;
    const offset = hasAfterCursor ? 0 : Math.max(0, (args.page - 1) * args.limit);
    const paged = pageBase.slice(offset, offset + args.limit);
    const hasMore = hasAfterCursor ? pageBaseTotal > args.limit : offset + args.limit < total;
    const nextCursor =
      hasMore && paged.length > 0
        ? this.toRankCursor({
            item: paged[paged.length - 1].item,
            relevance: paged[paged.length - 1].relevance,
          }, args.queryHash)
        : null;

    let vectorHits = 0;
    let lexicalHits = 0;
    for (const entry of filtered) {
      if (entry.hasVectorHit) vectorHits += 1;
      if (entry.hasLexicalHit) lexicalHits += 1;
    }

    const debugScores =
      args.includeDebug === true
        ? paged.map((entry, index) => ({
            itemId: entry.item.id,
            rank: hasAfterCursor ? index + 1 : offset + index + 1,
            lexicalScore: entry.lexicalScore || 0,
            vectorScore: entry.vectorScore || 0,
            fusedScore: entry.relevance,
            lexicalRank: entry.lexicalRank,
            vectorRank: entry.vectorRank,
            matchedLexical: entry.hasLexicalHit,
            matchedVector: entry.hasVectorHit,
          }))
        : undefined;

    return {
      itemIds: paged.map((entry) => entry.item.id),
      total,
      vectorHits,
      lexicalHits,
      hasMore,
      nextCursor,
      debugScores,
    };
  }

  private compareByField(
    a: Pick<RankableItem, "id" | "title" | "source" | "createdAt" | "updatedAt">,
    b: Pick<RankableItem, "id" | "title" | "source" | "createdAt" | "updatedAt">,
    sortBy: Exclude<LocalQuerySortBy, "relevance">,
    sortOrder: LocalQuerySortOrder
  ): number {
    const compare = compareRankField(a, b, sortBy, sortOrder);
    if (compare !== 0) return compare;
    return a.id.localeCompare(b.id);
  }

  async saveFetchedMetadata(payload: {
    metaMap: Record<string, Partial<ItemDocType>>;
    forceRefresh?: boolean;
    forceRefreshUrls?: string[];
  }): Promise<{ updated: number }> {
    const db = await getDb();
    const { metaMap } = payload;
    const forceRefreshUrls = new Set(payload.forceRefreshUrls || []);
    const shouldForceRefreshItem = (url: string) =>
      payload.forceRefresh === true &&
      (payload.forceRefreshUrls === undefined || forceRefreshUrls.has(url));
    const urls = Object.keys(metaMap);
    if (urls.length === 0) return { updated: 0 };

    const itemsToUpdate = await db.items.find({ selector: { url: { $in: urls } } }).exec();

    for (const item of itemsToUpdate) {
      const MAX_TRIES = 5;
      let attempt = 0;

      while (attempt < MAX_TRIES) {
        attempt += 1;
        const fresh = await db.items.findOne(item.primary).exec();
        if (!fresh) break;

        const meta = metaMap[fresh.get("url") as string];
        const current = fresh.toMutableJSON() as ItemDocType;
        const forceRefresh = shouldForceRefreshItem(current.url);
        const wasMetadataPending = current.isMetaFetched !== true;

        const patchData: Partial<ItemDocType> = {};
        if (!meta) {
          patchData.isMetaFetched = true;
        } else {
          const m = this.sanitize(meta);
          let embeddingRelevantChanged = false;

          if (m.title !== undefined && m.title !== current.title) {
            patchData.title = m.title as ItemDocType["title"];
            embeddingRelevantChanged = true;
          }

          if (m.textContent !== undefined) {
            const nextTextContent = appendOcrTextToTextContent(
              m.textContent as ItemDocType["textContent"],
              current.ocrText
            );
            if (nextTextContent !== current.textContent) {
              patchData.textContent = nextTextContent;
              embeddingRelevantChanged = true;
            }
          }

          if (m.iconUrl !== undefined) patchData.iconUrl = m.iconUrl as ItemDocType["iconUrl"];
          if (
            m.displayImageUrl !== undefined &&
            !hasStoredMedia(current.media) &&
            (forceRefresh || !current.displayImageUrl || isYouTubeShortsUrl(current.url))
          ) {
            patchData.displayImageUrl = m.displayImageUrl as ItemDocType["displayImageUrl"];
          }
          if (m.source && m.source !== current.source) {
            // `source` is a hard filter, not part of the embedding text
            // (see composeEmbeddingTexts), so changing it does not require a
            // re-embed.
            patchData.source = m.source as ItemDocType["source"];
          }
          if (m.authorUsername !== undefined && m.authorUsername !== current.authorUsername) {
            // `authorUsername` IS part of the embedding text, so a change must
            // re-embed the item to keep its vector in sync with the content.
            patchData.authorUsername = m.authorUsername as ItemDocType["authorUsername"];
            embeddingRelevantChanged = true;
          }
          if (typeof m.updatedAt === "number" && m.updatedAt > 0) {
            patchData.updatedAt = m.updatedAt;
          }
          if (m.media !== undefined) {
            patchData.media = mergeFetchedMedia(current.media, m.media as ItemDocType["media"]);
          }

          if (embeddingRelevantChanged) {
            patchData.isDirty = true;
          }

          patchData.isMetaFetched = true;
        }

        if (wasMetadataPending && current.isEmbedded) {
          if (hasVectorReference(current)) {
            patchData.isDirty = true;
          } else {
            patchData.vector_index = -1;
            patchData.vector_indexes = [];
            patchData.isEmbedded = false;
            patchData.isDirty = false;
          }
        }

        try {
          await fresh.patch(patchData);
          break;
        } catch (e: any) {
          // 409 conflict -> retry with next revision; otherwise rethrow
          const status = e?.status ?? e?.rxdb?.status ?? e?.parameters?.writeError?.status;
          if (status !== 409) throw e;
          continue;
        }
      }
    }

    // Trigger embedding for newly updated items
    this.triggerBackgroundProcessing("TRIGGER_EMBEDDING");

    return { updated: itemsToUpdate.length };
  }

  async getPendingMetadataUrls(payload?: { limit?: number }): Promise<{ urls: string[] }> {
    const db = await getDb();
    const limit = Math.max(1, Math.min(1000, Math.floor(Number(payload?.limit) || 500)));
    const docs = await db.items
      .find({ selector: { isMetaFetched: false, deletedAt: { $eq: 0 } }, limit })
      .exec();
    const urls = Array.from(
      new Set(
        docs
          .map((doc) => (doc.get("url") as string | undefined) || "")
          .filter((url) => isMetadataFetchableUrl(url))
      )
    );
    return { urls };
  }

  private normalizeUrl(input: string): string | null {
    if (!input) return null;
    const tryMake = (raw: string) => {
      try {
        const u = new URL(raw);
        if (u.protocol === "http:" || u.protocol === "https:") return u.toString();
        return null;
      } catch {
        return null;
      }
    };
    // already absolute?
    const first = tryMake(input);
    if (first) return first;
    return tryMake(`https://${input}`);
  }

  private parseHostname(input: string): string | null {
    try {
      return new URL(input).hostname.toLowerCase();
    } catch {
      return null;
    }
  }

  private async resolveAllowedSpaceIds(
    db: any,
    payload: LocalQueryPayload
  ): Promise<string[]> {
    const activeSpaceId = payload.accessContext?.activeSpaceId || PUBLIC_SPACE_ID;
    const requestedScope = payload.accessContext?.searchScope || "current";
    const privateUnlocked = spaceSessionService.isUnlocked(PRIVATE_SPACE_ID);

    const spaceDocs = await db.spaces
      .find({ selector: { isArchived: { $eq: false }, deletedAt: { $eq: 0 } } })
      .exec();
    const spaces = spaceDocs.map((doc: any) => doc.toMutableJSON() as any);
    const allSpaceIds = spaces.map((space: any) => space.id as string);
    const nonPrivateSpaceIds = spaces
      .filter((space: any) => !space.isPrivate)
      .map((space: any) => space.id as string);
    const hasActiveSpace = spaces.some((space: any) => space.id === activeSpaceId);
    const safeActiveSpaceId = hasActiveSpace ? activeSpaceId : PUBLIC_SPACE_ID;
    const fallbackPublic = nonPrivateSpaceIds.length > 0 ? nonPrivateSpaceIds : [PUBLIC_SPACE_ID];
    const fallbackAll = allSpaceIds.length > 0 ? allSpaceIds : fallbackPublic;

    if (requestedScope === "global") {
      return privateUnlocked ? fallbackAll : fallbackPublic;
    }

    if (requestedScope === "public") {
      return fallbackPublic;
    }

    if (requestedScope === "private") {
      return privateUnlocked ? [PRIVATE_SPACE_ID] : [];
    }

    if (safeActiveSpaceId === PRIVATE_SPACE_ID) {
      return privateUnlocked ? [PRIVATE_SPACE_ID] : [];
    }
    return [safeActiveSpaceId];
  }

  private folderMirrorKey(folder: Pick<FolderDocType, "name" | "type" | "isPinned" | "isLocked" | "isCollapsed">): string {
    return [
      (folder.name || "").trim().toLowerCase(),
      folder.type || "folder",
      folder.isPinned ? "1" : "0",
      folder.isLocked ? "1" : "0",
      folder.isCollapsed ? "1" : "0",
    ].join("::");
  }

  async moveToSpace(payload: {
    itemIds: string[];
    targetSpaceId: string;
  }): Promise<{ updated: number; createdFolders: number }> {
    const db = await getDb();
    const itemIds = Array.from(new Set((payload.itemIds || []).filter(Boolean)));
    const targetSpaceId = (payload.targetSpaceId || "").trim();
    if (itemIds.length === 0 || !targetSpaceId) {
      return { updated: 0, createdFolders: 0 };
    }

    const initialItemDocsById = await db.items.findByIds(itemIds).exec();
    const initialSourceSpaceIds = itemIds
      .map((id) => initialItemDocsById.get(id))
      .filter((doc): doc is any => !!doc)
      .map((doc) => (doc.get("spaceId") as string | undefined) || PUBLIC_SPACE_ID);

    return withSpaceMutationLocks(
      db,
      [targetSpaceId, ...initialSourceSpaceIds],
      async () => {
    await requireLiveSpaceDestination(db, targetSpaceId);
    this.assertSpaceUnlocked(targetSpaceId);
    const itemDocsById = await db.items.findByIds(itemIds).exec();
    const sourceItems = itemIds
      .map((id) => itemDocsById.get(id))
      .filter((doc): doc is any => !!doc)
      .map((doc) => doc.toMutableJSON() as ItemDocType)
      .filter((item) => (item.deletedAt || 0) === 0);
    if (sourceItems.length === 0) {
      return { updated: 0, createdFolders: 0 };
    }

    for (const item of sourceItems) {
      if (!initialSourceSpaceIds.includes(item.spaceId || PUBLIC_SPACE_ID)) {
        throw new Error("SOURCE_ITEM_CHANGED");
      }
      this.assertSpaceUnlocked(item.spaceId || PUBLIC_SPACE_ID);
    }

    const sourceFolderIds = Array.from(new Set(sourceItems.map((item) => item.folderId).filter(Boolean)));
    const sourceFolderDocs = await db.folders.findByIds(sourceFolderIds).exec();
    const sourceFoldersById = new Map<string, FolderDocType>();
    for (const [folderId, folderDoc] of sourceFolderDocs.entries()) {
      const folder = folderDoc.toMutableJSON() as FolderDocType;
      await requireLiveFolderDestination(
        db,
        folderId,
        folder.spaceId || PUBLIC_SPACE_ID
      );
      this.assertSpaceUnlocked(folder.spaceId || PUBLIC_SPACE_ID);
      sourceFoldersById.set(folderId, folder);
    }

    const targetFolderDocs = await db.folders.find({ selector: { spaceId: { $eq: targetSpaceId } } }).exec();
    const targetFolderByMirrorKey = new Map<string, string>();
    let maxSortOrder = 0;
    for (const doc of targetFolderDocs) {
      const folder = doc.toMutableJSON() as FolderDocType;
      if (folder.deletedAt !== 0) continue;
      const sortOrder = folder.sortOrder ?? 0;
      if (sortOrder > maxSortOrder) maxSortOrder = sortOrder;
      const key = this.folderMirrorKey(folder);
      if (!targetFolderByMirrorKey.has(key)) {
        targetFolderByMirrorKey.set(key, folder.id);
      }
    }

    const now = Date.now();
    const sourceToTargetFolderId = new Map<string, string>();
    const foldersToInsert: FolderDocType[] = [];
    let createdFolders = 0;

    for (const sourceFolderId of sourceFolderIds) {
      const sourceFolder = sourceFoldersById.get(sourceFolderId);
      if (!sourceFolder) continue;

      if ((sourceFolder.spaceId || PUBLIC_SPACE_ID) === targetSpaceId) {
        sourceToTargetFolderId.set(sourceFolderId, sourceFolderId);
        continue;
      }

      const mirrorKey = this.folderMirrorKey(sourceFolder);
      const existingTargetFolderId = targetFolderByMirrorKey.get(mirrorKey);
      if (existingTargetFolderId) {
        sourceToTargetFolderId.set(sourceFolderId, existingTargetFolderId);
        continue;
      }

      maxSortOrder += 1;
      const clonedFolder: FolderDocType = {
        id: uuidv4(),
        name: sourceFolder.name,
        userId: this.normalizeUserId(sourceFolder.userId),
        spaceId: targetSpaceId,
        parentId: null,
        type: sourceFolder.type || "folder",
        sortOrder: maxSortOrder,
        isLocked: !!sourceFolder.isLocked,
        isPinned: !!sourceFolder.isPinned,
        isCollapsed: !!sourceFolder.isCollapsed,
        deletedAt: 0,
        purgeAt: 0,
        isDirty: false,
        serverVersion: 0,
        createdAt: sourceFolder.createdAt || now,
        updatedAt: now,
      };
      foldersToInsert.push(clonedFolder);
      createdFolders += 1;
      sourceToTargetFolderId.set(sourceFolderId, clonedFolder.id);
      targetFolderByMirrorKey.set(mirrorKey, clonedFolder.id);
    }

    if (foldersToInsert.length > 0) {
      const insertResult = await db.folders.bulkInsert(foldersToInsert);
      if (insertResult.error.length > 0) {
        throw new Error(`Failed to create ${insertResult.error.length} destination folders.`);
      }
    }

    const targetFolderIds = Array.from(new Set(Array.from(sourceToTargetFolderId.values())));
    const existingTargetItems =
      targetFolderIds.length > 0
        ? await db.items
            .find({
              selector: {
                folderId: { $in: targetFolderIds },
                deletedAt: { $eq: 0 },
              },
            })
            .exec()
        : [];
    const maxChunkOrderByFolderId = new Map<string, number>();
    for (const doc of existingTargetItems) {
      const folderId = (doc.get("folderId") as string | undefined) || "";
      const chunkOrder = (doc.get("chunkOrder") as number | undefined) ?? -1;
      const current = maxChunkOrderByFolderId.get(folderId) ?? -1;
      if (chunkOrder > current) {
        maxChunkOrderByFolderId.set(folderId, chunkOrder);
      }
    }

    const itemsBySourceFolder = new Map<string, ItemDocType[]>();
    for (const item of sourceItems) {
      const list = itemsBySourceFolder.get(item.folderId) || [];
      list.push(item);
      itemsBySourceFolder.set(item.folderId, list);
    }

    const itemUpdates: ItemDocType[] = [];
    for (const [sourceFolderId, folderItems] of itemsBySourceFolder.entries()) {
      const targetFolderId = sourceToTargetFolderId.get(sourceFolderId);
      if (!targetFolderId) continue;

      const ordered = [...folderItems].sort((a, b) => {
        const ao = a.chunkOrder ?? Number.MAX_SAFE_INTEGER;
        const bo = b.chunkOrder ?? Number.MAX_SAFE_INTEGER;
        if (ao !== bo) return ao - bo;
        return a.createdAt - b.createdAt;
      });

      let nextOrder = (maxChunkOrderByFolderId.get(targetFolderId) ?? -1) + 1;
      for (const item of ordered) {
        if (
          (item.spaceId || PUBLIC_SPACE_ID) === targetSpaceId &&
          item.folderId === targetFolderId
        ) {
          continue;
        }
        itemUpdates.push({
          ...item,
          userId: this.normalizeUserId(item.userId),
          folderId: targetFolderId,
          spaceId: targetSpaceId,
          chunkOrder: nextOrder,
          updatedAt: now,
        });
        nextOrder += 1;
      }
      maxChunkOrderByFolderId.set(targetFolderId, nextOrder - 1);
    }

    let updatedItems = 0;
    for (const update of itemUpdates) {
      await withEntityMutationLock(db, "item", update.id, async () => {
        const freshDoc = await db.items.findOne(update.id).exec();
        if (!freshDoc || freshDoc.get("deletedAt") !== 0) return;
        await freshDoc.incrementalPatch({
          folderId: update.folderId,
          spaceId: update.spaceId,
          chunkOrder: update.chunkOrder,
          updatedAt: update.updatedAt,
        });
        updatedItems += 1;
      });
    }

    if (createdFolders > 0) {
      try {
        chrome.runtime.sendMessage({ type: "DB_CHANGE", scope: "folders" });
      } catch {}
    }
    if (updatedItems > 0) {
      try {
        chrome.runtime.sendMessage({ type: "DB_CHANGE", scope: "items" });
      } catch {}
    }

        return {
          updated: updatedItems,
          createdFolders,
        };
      }
    );
  }

  async copyToSpace(payload: {
    itemIds: string[];
    targetSpaceId: string;
  }): Promise<{ copied: number; createdFolders: number }> {
    const db = await getDb();
    const itemIds = Array.from(new Set((payload.itemIds || []).filter(Boolean)));
    const targetSpaceId = (payload.targetSpaceId || "").trim();
    if (itemIds.length === 0 || !targetSpaceId) {
      return { copied: 0, createdFolders: 0 };
    }

    const initialItemDocsById = await db.items.findByIds(itemIds).exec();
    const initialSourceSpaceIds = itemIds
      .map((id) => initialItemDocsById.get(id))
      .filter((doc): doc is any => !!doc)
      .map((doc) => (doc.get("spaceId") as string | undefined) || PUBLIC_SPACE_ID);

    return withSpaceMutationLocks(
      db,
      [targetSpaceId, ...initialSourceSpaceIds],
      async () => {
    await requireLiveSpaceDestination(db, targetSpaceId);
    this.assertSpaceUnlocked(targetSpaceId);
    const itemDocsById = await db.items.findByIds(itemIds).exec();
    const sourceItems = itemIds
      .map((id) => itemDocsById.get(id))
      .filter((doc): doc is any => !!doc)
      .map((doc) => doc.toMutableJSON() as ItemDocType)
      .filter((item) => (item.deletedAt || 0) === 0);
    if (sourceItems.length === 0) {
      return { copied: 0, createdFolders: 0 };
    }

    for (const item of sourceItems) {
      if (!initialSourceSpaceIds.includes(item.spaceId || PUBLIC_SPACE_ID)) {
        throw new Error("SOURCE_ITEM_CHANGED");
      }
      this.assertSpaceUnlocked(item.spaceId || PUBLIC_SPACE_ID);
    }

    const sourceFolderIds = Array.from(new Set(sourceItems.map((item) => item.folderId).filter(Boolean)));
    const sourceFolderDocs = await db.folders.findByIds(sourceFolderIds).exec();
    const sourceFoldersById = new Map<string, FolderDocType>();
    for (const [folderId, folderDoc] of sourceFolderDocs.entries()) {
      const folder = folderDoc.toMutableJSON() as FolderDocType;
      await requireLiveFolderDestination(
        db,
        folderId,
        folder.spaceId || PUBLIC_SPACE_ID
      );
      this.assertSpaceUnlocked(folder.spaceId || PUBLIC_SPACE_ID);
      sourceFoldersById.set(folderId, folder);
    }

    const targetFolderDocs = await db.folders.find({ selector: { spaceId: { $eq: targetSpaceId } } }).exec();
    const targetFolderByMirrorKey = new Map<string, string>();
    let maxSortOrder = 0;
    for (const doc of targetFolderDocs) {
      const folder = doc.toMutableJSON() as FolderDocType;
      if (folder.deletedAt !== 0) continue;
      const sortOrder = folder.sortOrder ?? 0;
      if (sortOrder > maxSortOrder) maxSortOrder = sortOrder;
      const key = this.folderMirrorKey(folder);
      if (!targetFolderByMirrorKey.has(key)) {
        targetFolderByMirrorKey.set(key, folder.id);
      }
    }

    const now = Date.now();
    const sourceToTargetFolderId = new Map<string, string>();
    const foldersToInsert: FolderDocType[] = [];
    let createdFolders = 0;

    for (const sourceFolderId of sourceFolderIds) {
      const sourceFolder = sourceFoldersById.get(sourceFolderId);
      if (!sourceFolder) continue;

      if ((sourceFolder.spaceId || PUBLIC_SPACE_ID) === targetSpaceId) {
        sourceToTargetFolderId.set(sourceFolderId, sourceFolderId);
        continue;
      }

      const mirrorKey = this.folderMirrorKey(sourceFolder);
      const existingTargetFolderId = targetFolderByMirrorKey.get(mirrorKey);
      if (existingTargetFolderId) {
        sourceToTargetFolderId.set(sourceFolderId, existingTargetFolderId);
        continue;
      }

      maxSortOrder += 1;
      const clonedFolder: FolderDocType = {
        id: uuidv4(),
        name: sourceFolder.name,
        userId: this.normalizeUserId(sourceFolder.userId),
        spaceId: targetSpaceId,
        parentId: null,
        type: sourceFolder.type || "folder",
        sortOrder: maxSortOrder,
        isLocked: !!sourceFolder.isLocked,
        isPinned: !!sourceFolder.isPinned,
        isCollapsed: !!sourceFolder.isCollapsed,
        deletedAt: 0,
        purgeAt: 0,
        isDirty: false,
        serverVersion: 0,
        createdAt: sourceFolder.createdAt || now,
        updatedAt: now,
      };
      foldersToInsert.push(clonedFolder);
      createdFolders += 1;
      sourceToTargetFolderId.set(sourceFolderId, clonedFolder.id);
      targetFolderByMirrorKey.set(mirrorKey, clonedFolder.id);
    }

    if (foldersToInsert.length > 0) {
      const insertResult = await db.folders.bulkInsert(foldersToInsert);
      if (insertResult.error.length > 0) {
        throw new Error(`Failed to create ${insertResult.error.length} destination folders.`);
      }
    }

    const targetFolderIds = Array.from(new Set(Array.from(sourceToTargetFolderId.values())));
    const existingTargetItems =
      targetFolderIds.length > 0
        ? await db.items
            .find({
              selector: {
                folderId: { $in: targetFolderIds },
                deletedAt: { $eq: 0 },
              },
            })
            .exec()
        : [];
    const maxChunkOrderByFolderId = new Map<string, number>();
    for (const doc of existingTargetItems) {
      const folderId = (doc.get("folderId") as string | undefined) || "";
      const chunkOrder = (doc.get("chunkOrder") as number | undefined) ?? -1;
      const current = maxChunkOrderByFolderId.get(folderId) ?? -1;
      if (chunkOrder > current) {
        maxChunkOrderByFolderId.set(folderId, chunkOrder);
      }
    }

    const itemsBySourceFolder = new Map<string, ItemDocType[]>();
    for (const item of sourceItems) {
      const list = itemsBySourceFolder.get(item.folderId) || [];
      list.push(item);
      itemsBySourceFolder.set(item.folderId, list);
    }

    const itemClones: ItemDocType[] = [];
    const cloneIds: string[] = [];
    try {
      await withOpfsMutationLock(async () => {
        for (const [sourceFolderId, folderItems] of itemsBySourceFolder.entries()) {
          const targetFolderId = sourceToTargetFolderId.get(sourceFolderId);
          if (!targetFolderId) continue;

          const ordered = [...folderItems].sort((a, b) => {
            const ao = a.chunkOrder ?? Number.MAX_SAFE_INTEGER;
            const bo = b.chunkOrder ?? Number.MAX_SAFE_INTEGER;
            if (ao !== bo) return ao - bo;
            return a.createdAt - b.createdAt;
          });

          let nextOrder = (maxChunkOrderByFolderId.get(targetFolderId) ?? -1) + 1;
          for (const item of ordered) {
            const cloneId = uuidv4();
            cloneIds.push(cloneId);
            const cloneMedia =
              this.options.cloneOpfsMediaEntriesForItem || cloneOpfsMediaEntriesForItem;
            const clonedMedia = await cloneMedia(item.media, cloneId);
            itemClones.push({
              ...item,
              id: cloneId,
              userId: this.normalizeUserId(item.userId),
              folderId: targetFolderId,
              spaceId: targetSpaceId,
              chunkOrder: nextOrder,
              media: clonedMedia.media,
              displayImageUrl:
                clonedMedia.pathMap.get(item.displayImageUrl || "") || item.displayImageUrl,
              vector_index: -1,
              vector_indexes: [],
              isEmbedded: false,
              isDirty: true,
              serverVersion: 0,
              createdAt: now,
              updatedAt: now,
            });
            nextOrder += 1;
          }
          maxChunkOrderByFolderId.set(targetFolderId, nextOrder - 1);
        }

        if (itemClones.length > 0) {
          const insertResult = await db.items.bulkInsert(itemClones);
          if (insertResult.error.length > 0) {
            throw new Error(`Failed to copy ${insertResult.error.length} items.`);
          }
        }
      });
    } catch (error) {
      await deleteUnreferencedOpfsItemDirectories(db, cloneIds).catch(() => {});
      throw error;
    }

    if (createdFolders > 0) {
      try {
        chrome.runtime.sendMessage({ type: "DB_CHANGE", scope: "folders" });
      } catch {}
    }
    if (itemClones.length > 0) {
      try {
        chrome.runtime.sendMessage({ type: "DB_CHANGE", scope: "items" });
      } catch {}
    }

        return {
          copied: itemClones.length,
          createdFolders,
        };
      }
    );
  }

  async queryLocal(payload: LocalQueryPayload): Promise<LocalQueryResponse> {
    // Search requests race while the user types. Stop an older cooperative
    // lexical/vector scan immediately instead of letting it retain index pages,
    // vectors, and CPU in the offscreen document until completion.
    const searchGeneration = this.beginSearchGeneration(payload.searchClientId);
    const searchSignal = this.getSearchSignal(searchGeneration);

    let vectorQueryLease: VectorQueryLease | null = null;
    try {
      const requestedChannels = resolveEffectiveQueryChannels({
        requested: {
          keyword: payload.useKeyword !== false,
          fuzzy: payload.useFuzzy === true,
          vector: payload.useVector === true,
        },
        query: this.resolveVectorQueryText(payload),
        vectorMinChars: VECTOR_QUERY_MIN_CHARS,
      });
      if (requestedChannels.vector) {
        vectorQueryLease = await this.vectorStore.acquireQueryLease(searchSignal);
        this.assertSearchGeneration(searchGeneration);
      }
      return await this.queryLocalWithVectorLease(
        payload,
        searchGeneration,
        searchSignal,
        vectorQueryLease
      );
    } finally {
      vectorQueryLease?.release();
      this.finishSearchGeneration(searchGeneration);
    }
  }

  private async queryLocalWithVectorLease(
    payload: LocalQueryPayload,
    searchGeneration: number,
    searchSignal: AbortSignal,
    vectorQueryLease: VectorQueryLease | null
  ): Promise<LocalQueryResponse> {

    const now = () =>
      typeof performance !== "undefined" && typeof performance.now === "function"
        ? performance.now()
        : Date.now();
    const startedAt = now();
    let selectorMs = 0;
    let filterMs = 0;
    let lexicalMs = 0;
    let vectorMs = 0;
    let vectorEmbedMs = 0;
    let vectorScanMs = 0;
    let rankMs = 0;
    let hydrateMs = 0;
    let rankInputCount = 0;
    let usedSimpleSortPath = false;

    const db = await getDb();
    const query = (payload.query || "").trim();
    const fallbackTerms = this.tokenizeQuery(query);
    const expression = payload.text?.expression;
    const groups =
      payload.text?.groups?.map((group) => group.map((term) => term.trim()).filter(Boolean)).filter((group) => group.length > 0) ||
      [];
    const excludedTerms =
      payload.text?.excludedTerms?.map((term) => term.trim()).filter(Boolean) || [];
    const normalizedGroups = groups.length > 0 ? groups : fallbackTerms.length > 0 ? [fallbackTerms] : [];
    const expressionPositiveTerms = expression
      ? Array.from(new Set(this.collectPositiveExpressionTerms(expression)))
      : [];
    const flatPositiveTerms = Array.from(
      new Set(expression ? expressionPositiveTerms : normalizedGroups.flat())
    );
    const includeDebug = payload.debug === true;
    const vectorQuery = this.resolveVectorQueryText(payload);
    const effectiveChannels = resolveEffectiveQueryChannels({
      requested: {
        keyword: payload.useKeyword !== false,
        fuzzy: payload.useFuzzy === true,
        vector: payload.useVector === true,
      },
      query: vectorQuery,
      vectorMinChars: VECTOR_QUERY_MIN_CHARS,
    });
    const useKeyword = effectiveChannels.keyword;
    const useFuzzy = effectiveChannels.fuzzy;
    const useLexical = useKeyword || useFuzzy;
    const useVector = effectiveChannels.vector;
    const filters = payload.filters || {};
    const baseAllowedSpaceIds = await this.resolveAllowedSpaceIds(db, payload);
    const includeSpaceFilters = Array.from(new Set((filters.spaceIds || []).filter(Boolean)));
    const excludeSpaceFilters = new Set((filters.excludeSpaceIds || []).filter(Boolean));
    let allowedSpaceIds = includeSpaceFilters.length
      ? baseAllowedSpaceIds.filter((spaceId) => includeSpaceFilters.includes(spaceId))
      : baseAllowedSpaceIds;
    if (excludeSpaceFilters.size > 0) {
      allowedSpaceIds = allowedSpaceIds.filter((spaceId) => !excludeSpaceFilters.has(spaceId));
    }
    allowedSpaceIds = Array.from(new Set(allowedSpaceIds));
    this.assertSearchGeneration(searchGeneration);

    const sortBy: LocalQuerySortBy =
      payload.sort?.by || (flatPositiveTerms.length > 0 || query.length > 0 ? "relevance" : "createdAt");
    const sortOrder: LocalQuerySortOrder =
      payload.sort?.order || (sortBy === "title" || sortBy === "source" ? "asc" : "desc");
    const page = Math.max(1, payload.pagination?.page || 1);
    const rawAfterCursor = payload.pagination?.afterCursor || null;
    const limit = Math.max(
      1,
      Math.min(payload.pagination?.limit || payload.topK || 100, MAX_GRID_QUERY_LIMIT)
    );
    const scoreBudget = Math.max(
      MIN_SCORE_BUDGET,
      payload.topK || MIN_SCORE_BUDGET,
      limit * SCORE_BUDGET_MULTIPLIER
    );
    const lexicalScoreLimit = Math.min(MAX_LEXICAL_SCORE_BUDGET, scoreBudget);
    const vectorTopKLimit = Math.min(MAX_VECTOR_TOPK, scoreBudget);
    const queryHash = this.buildQueryHash({
      query: query,
      expression,
      groups: normalizedGroups,
      excludedTerms,
      filters,
      accessContext: payload.accessContext,
      sortBy,
      sortOrder,
      useKeyword,
      useVector,
      useFuzzy,
    });
    const afterCursor =
      rawAfterCursor && rawAfterCursor.queryHash === queryHash ? rawAfterCursor : null;

    if (allowedSpaceIds.length === 0) {
      this.assertSearchGeneration(searchGeneration);
      return {
        items: [],
        total: 0,
        totalIsExact: true,
        vectorHits: 0,
        lexicalHits: 0,
        vectorError: null,
        sortBy,
        sortOrder,
        page,
        limit,
        hasMore: false,
        nextCursor: null,
        diagnostics: {
          queryHash,
          candidateCount: 0,
          rankInputCount: 0,
          usedSimpleSortPath: false,
          scoreBudget,
          supersededCount: this.rankTelemetry.supersededCount,
          fallbackCount: this.rankTelemetry.fallbackCount,
          selectorMs,
          filterMs,
          lexicalMs,
          vectorMs,
          vectorEmbedMs,
          vectorScanMs,
          rankMs,
          hydrateMs,
          totalMs: now() - startedAt,
        },
      };
    }

    const selector: Record<string, any> = { deletedAt: { $eq: 0 } };
    selector.spaceId = { $in: allowedSpaceIds };
    if (filters.folderIds && filters.folderIds.length > 0) {
      selector.folderId = { $in: filters.folderIds.filter(Boolean) };
    }
    if (filters.sources && filters.sources.length > 0) {
      selector.source = { $in: filters.sources };
    }
    if (filters.favoritesOnly === true) {
      selector.isFavorite = { $eq: true };
    }
    const createdFrom =
      typeof filters.createdFrom === "number" ? filters.createdFrom : filters.dateFrom;
    const createdTo = typeof filters.createdTo === "number" ? filters.createdTo : filters.dateTo;
    if (typeof createdFrom === "number" || typeof createdTo === "number") {
      const createdAt: Record<string, number> = {};
      if (typeof createdFrom === "number") {
        createdAt.$gte = createdFrom;
      }
      if (typeof createdTo === "number") {
        createdAt.$lte = createdTo;
      }
      selector.createdAt = createdAt;
    }
    if (typeof filters.updatedFrom === "number" || typeof filters.updatedTo === "number") {
      const updatedAt: Record<string, number> = {};
      if (typeof filters.updatedFrom === "number") {
        updatedAt.$gte = filters.updatedFrom;
      }
      if (typeof filters.updatedTo === "number") {
        updatedAt.$lte = filters.updatedTo;
      }
      selector.updatedAt = updatedAt;
    }
    if (typeof filters.likesMin === "number" || typeof filters.likesMax === "number") {
      const likes: Record<string, number> = {};
      if (typeof filters.likesMin === "number") likes.$gte = filters.likesMin;
      if (typeof filters.likesMax === "number") likes.$lte = filters.likesMax;
      selector.likes = likes;
    }
    if (typeof filters.upvotesMin === "number" || typeof filters.upvotesMax === "number") {
      const upvotes: Record<string, number> = {};
      if (typeof filters.upvotesMin === "number") upvotes.$gte = filters.upvotesMin;
      if (typeof filters.upvotesMax === "number") upvotes.$lte = filters.upvotesMax;
      selector.upvotes = upvotes;
    }

    const hasExplicitTextConstraint = !!expression || excludedTerms.length > 0;
    const hasImplicitTextConstraint = normalizedGroups.length > 0 || query.length > 0;
    const lexicalQuery = useLexical ? vectorQuery : "";
    const lexicalQueries = flatPositiveTerms.length > 0 ? flatPositiveTerms : [lexicalQuery];

    let lexicalScores = new Map<string, number>();
    let lexicalMatchTerms: string[] = [];
    let lexicalMatchMasksById = new Map<string, number[]>();
    let preloadedScopedCandidates: CandidateLite[] | null = null;
    let preloadedScopedCandidatesComplete = false;
    if (useLexical && lexicalQuery) {
      const lexicalStartedAt = now();
      const lexicalAbortController = this.startLexicalSearchPhase(searchGeneration);
      try {
        const searchRequest = {
          query: lexicalQuery,
          queries: lexicalQueries,
          limit: lexicalScoreLimit,
          keyword: useKeyword,
          fuzzy: useFuzzy,
          trackTermMatches: !!expression,
          signal: lexicalAbortController.signal,
        };
        const initialTimeoutMessage =
          `Lexical search timed out after ${LEXICAL_SEARCH_TIMEOUT_MS}ms.`;
        const initialSearch = await this.withTimeout(
          localSearchIndexService.searchWithStatus(searchRequest),
          LEXICAL_SEARCH_TIMEOUT_MS,
          initialTimeoutMessage,
          () => lexicalAbortController.abort(new Error(initialTimeoutMessage))
        );
        lexicalScores = initialSearch.scores;
        lexicalMatchTerms = initialSearch.terms;
        lexicalMatchMasksById = initialSearch.termMatchMasksById;

        if (initialSearch.saturated) {
          // FlexSearch's limit is global. When it fills, valid hits from a
          // selected space/folder can sit beyond the cut and must not be
          // discarded before the database scope is applied. Project the
          // scoped rows once, then page the index until that bounded ID set is
          // complete enough for ranking.
          // Release the capped global maps before materializing the scoped ID
          // set and its replacement score map; large result sets must not
          // overlap at peak memory.
          initialSearch.scores.clear();
          initialSearch.termMatchMasksById.clear();
          lexicalScores = new Map();
          lexicalMatchTerms = [];
          lexicalMatchMasksById = new Map();
          const scopeStartedAt = now();
          preloadedScopedCandidates = [];
          const allowedIds = new Set<string>();
          const scopeTimeoutMessage =
            `Scoped candidate loading timed out after ${LEXICAL_SEARCH_TIMEOUT_MS}ms.`;
          try {
            await this.withTimeout(
              forEachIdKeysetPage({
                collection: db.items as any,
                selector,
                pageSize: SCOPED_CANDIDATE_PAGE_SIZE,
                signal: lexicalAbortController.signal,
                onPage: (scopedDocs: any[]) => {
                  for (const doc of scopedDocs) {
                    const candidate = this.toCandidateLite(doc);
                    if (!candidate.id) continue;
                    preloadedScopedCandidates?.push(candidate);
                    allowedIds.add(candidate.id);
                  }
                },
              }),
              LEXICAL_SEARCH_TIMEOUT_MS,
              scopeTimeoutMessage,
              () => lexicalAbortController.abort(new Error(scopeTimeoutMessage))
            );
            preloadedScopedCandidatesComplete = true;
          } finally {
            selectorMs += now() - scopeStartedAt;
          }

          const scopedTimeoutMessage =
            `Scoped lexical search timed out after ${LEXICAL_SEARCH_TIMEOUT_MS}ms.`;
          const scopedSearch = await this.withTimeout(
            localSearchIndexService.searchWithStatus({ ...searchRequest, allowedIds }),
            LEXICAL_SEARCH_TIMEOUT_MS,
            scopedTimeoutMessage,
            () => lexicalAbortController.abort(new Error(scopedTimeoutMessage))
          );
          lexicalScores = scopedSearch.scores;
          lexicalMatchTerms = scopedSearch.terms;
          lexicalMatchMasksById = scopedSearch.termMatchMasksById;
        }
      } catch (error) {
        if (!preloadedScopedCandidatesComplete) {
          preloadedScopedCandidates = null;
        }
        if (error instanceof Error && error.message === RANK_REQUEST_SUPERSEDED) {
          throw new SupersededRankRequestError();
        }
        console.error("FlexSearch query failed in queryLocal:", error);
      } finally {
        this.finishLexicalSearchPhase(searchGeneration, lexicalAbortController);
        lexicalMs = now() - lexicalStartedAt;
      }
    }

    const useLexicalFirstSelector =
      useLexical &&
      !useVector &&
      lexicalQuery.length > 0 &&
      lexicalScores.size > 0 &&
      canNarrowExpressionToPositiveMatches(expression);
    if (useLexicalFirstSelector) {
      selector.id = { $in: Array.from(lexicalScores.keys()) };
    }

    // The default “open this space” view must not hydrate the entire library
    // before it can show the first page. Keep it in Dexie/RxDB when no filter
    // needs the in-memory ranker.
    const hasInMemoryOnlyFilters =
      (filters.excludeFolderIds?.length || 0) > 0 ||
      (filters.excludeSources?.length || 0) > 0 ||
      (filters.authors?.length || 0) > 0 ||
      (filters.excludeAuthors?.length || 0) > 0 ||
      (filters.domains?.length || 0) > 0 ||
      (filters.excludeDomains?.length || 0) > 0 ||
      (filters.hasAny?.length || 0) > 0 ||
      (filters.excludeHasAny?.length || 0) > 0 ||
      (filters.tagIds?.length || 0) > 0 ||
      (filters.tagNames?.length || 0) > 0 ||
      (filters.excludeTagNames?.length || 0) > 0;
    const canUseDatabasePagePath =
      !hasExplicitTextConstraint &&
      !hasImplicitTextConstraint &&
      !useVector &&
      !hasInMemoryOnlyFilters &&
      sortBy !== "relevance";
    if (canUseDatabasePagePath) {
      usedSimpleSortPath = true;
      const fieldSortBy = sortBy as Exclude<LocalQuerySortBy, "relevance">;
      const offset = Math.max(0, (page - 1) * limit);
      const selectorStartedAt = now();
      const pageDocsWithLookahead = await db.items
        .find({
          selector,
          sort: [{ [fieldSortBy]: sortOrder }],
          skip: offset,
          limit: limit + 1,
        } as any)
        .exec();
      selectorMs = now() - selectorStartedAt;
      const hydrateStartedAt = now();
      const pageResult = splitLookaheadPage(pageDocsWithLookahead, limit, offset);
      const pageDocs = pageResult.items;
      const items = pageDocs.map((doc) => doc.toMutableJSON() as ItemDocType);
      hydrateMs = now() - hydrateStartedAt;
      const lastItem = items[items.length - 1];
      this.assertSearchGeneration(searchGeneration);
      return {
        items,
        total: pageResult.total,
        totalIsExact: pageResult.totalIsExact,
        vectorHits: 0,
        lexicalHits: 0,
        vectorError: null,
        sortBy,
        sortOrder,
        page,
        limit,
        hasMore: pageResult.hasMore,
        nextCursor:
          pageResult.hasMore && lastItem
            ? {
                queryHash,
                id: lastItem.id,
                relevance: 0,
                createdAt: lastItem.createdAt || 0,
                updatedAt: lastItem.updatedAt || 0,
                title: lastItem.title || "",
                source: lastItem.source,
              }
            : null,
        diagnostics: {
          queryHash,
          candidateCount: pageResult.total,
          rankInputCount: 0,
          usedSimpleSortPath,
          scoreBudget,
          supersededCount: this.rankTelemetry.supersededCount,
          fallbackCount: this.rankTelemetry.fallbackCount,
          selectorMs,
          filterMs,
          lexicalMs,
          vectorMs,
          vectorEmbedMs,
          vectorScanMs,
          rankMs,
          hydrateMs,
          totalMs: now() - startedAt,
        },
      };
    }

    const selectorStartedAt = now();
    let candidates: CandidateLite[] = [];
    if (preloadedScopedCandidates) {
      candidates = useLexicalFirstSelector
        ? preloadedScopedCandidates.filter((candidate) => lexicalScores.has(candidate.id))
        : preloadedScopedCandidates;
    } else {
      // Project in-scope items to lightweight candidates and release the heavy
      // RxDocuments immediately. Retaining every in-scope document (with its
      // full text) for the whole query is what made large libraries memory-heavy;
      // the ranker only needs the lite projection, plus the text of the bounded
      // ranking set for text queries (fetched on demand below).
      await forEachIdKeysetPage({
        collection: db.items as any,
        selector,
        pageSize: SCOPED_CANDIDATE_PAGE_SIZE,
        signal: searchSignal,
        onPage: (docs: any[]) => {
          for (const doc of docs) {
            const candidate = this.toCandidateLite(doc);
            if (!candidate.id) continue;
            candidates.push(candidate);
          }
        },
      });
    }
    selectorMs += now() - selectorStartedAt;

    const hydrateFromDocMap = async (itemIds: string[]): Promise<ItemDocType[]> => {
      if (itemIds.length === 0) return [];
      this.assertSearchGeneration(searchGeneration);
      // Hydrate only the requested ids (the final page or a sort page) instead
      // of reading from a retained full-document map.
      const byId = await db.items.findByIds(itemIds).exec();
      this.assertSearchGeneration(searchGeneration);
      const itemById = new Map<string, ItemDocType>();
      for (const id of itemIds) {
        const doc = byId.get(id);
        if (!doc) continue;
        itemById.set(id, doc.toMutableJSON() as ItemDocType);
      }
      return itemIds
        .map((id) => itemById.get(id) || null)
        .filter((item): item is ItemDocType => !!item);
    };

    const filterStartedAt = now();
    if (filters.excludeFolderIds && filters.excludeFolderIds.length > 0) {
      const excluded = new Set(filters.excludeFolderIds.filter(Boolean));
      candidates = candidates.filter((item) => !excluded.has(item.folderId));
    }

    if (filters.excludeSources && filters.excludeSources.length > 0) {
      const excluded = new Set(filters.excludeSources);
      candidates = candidates.filter((item) => !excluded.has(item.source));
    }

    if (filters.authors && filters.authors.length > 0) {
      const includedAuthors = new Set(filters.authors.map((author) => author.toLowerCase()));
      candidates = candidates.filter(
        (item) => item.authorUsername.length > 0 && includedAuthors.has(item.authorUsername)
      );
    }

    if (filters.excludeAuthors && filters.excludeAuthors.length > 0) {
      const excludedAuthors = new Set(filters.excludeAuthors.map((author) => author.toLowerCase()));
      candidates = candidates.filter(
        (item) => item.authorUsername.length === 0 || !excludedAuthors.has(item.authorUsername)
      );
    }

    if (filters.domains && filters.domains.length > 0) {
      const includedDomains = new Set(filters.domains.map((domain) => domain.toLowerCase()));
      candidates = candidates.filter((item) => !!item.domain && includedDomains.has(item.domain));
    }

    if (filters.excludeDomains && filters.excludeDomains.length > 0) {
      const excludedDomains = new Set(filters.excludeDomains.map((domain) => domain.toLowerCase()));
      candidates = candidates.filter((item) => !item.domain || !excludedDomains.has(item.domain));
    }

    if (filters.hasAny && filters.hasAny.length > 0) {
      const required = new Set(filters.hasAny);
      candidates = candidates.filter((item) => {
        if (required.has("media") && !item.hasMedia) return false;
        if (required.has("image") && !item.mediaTypes.includes("image")) return false;
        if (required.has("video") && !item.mediaTypes.includes("video")) return false;
        if (required.has("embed") && !item.hasEmbed) return false;
        return true;
      });
    }

    if (filters.excludeHasAny && filters.excludeHasAny.length > 0) {
      const excluded = new Set(filters.excludeHasAny);
      candidates = candidates.filter((item) => {
        if (excluded.has("media") && item.hasMedia) return false;
        if (excluded.has("image") && item.mediaTypes.includes("image")) return false;
        if (excluded.has("video") && item.mediaTypes.includes("video")) return false;
        if (excluded.has("embed") && item.hasEmbed) return false;
        return true;
      });
    }

    const requestedTagIds = (filters.tagIds || []).filter(Boolean);
    const requestedTagNames = (filters.tagNames || []).map((name) => name.toLowerCase()).filter(Boolean);
    const excludedTagNames = (filters.excludeTagNames || [])
      .map((name) => name.toLowerCase())
      .filter(Boolean);

    let tagIds = requestedTagIds;
    let hasUnresolvedIncludedTag = false;
    const needsTagNameLookup = requestedTagNames.length > 0 || excludedTagNames.length > 0;
    let allTags: any[] = [];
    if (needsTagNameLookup) {
      allTags = await db.tags.find().exec();
    }

    if (requestedTagNames.length > 0) {
      const resolution = resolveIncludedTagIds({
        requestedIds: tagIds,
        requestedNames: requestedTagNames,
        tags: allTags.map((tag) => ({
          id: (tag.get("id") as string | undefined) || "",
          name: (tag.get("name") as string | undefined) || "",
        })),
      });
      tagIds = resolution.tagIds;
      hasUnresolvedIncludedTag = resolution.hasUnresolvedName;
    }

    let excludedTagIds: string[] = [];
    if (excludedTagNames.length > 0) {
      const excludedSet = new Set(excludedTagNames);
      excludedTagIds = allTags
        .filter((tag) => excludedSet.has((tag.get("name") as string).toLowerCase()))
        .map((tag) => tag.get("id") as string);
    }

    if (hasUnresolvedIncludedTag) {
      candidates = [];
    } else if (tagIds.length > 0) {
      const uniqueTagIds = Array.from(new Set(tagIds));
      const joins = await db.item_tags.find({ selector: { tagId: { $in: uniqueTagIds } } }).exec();
      const tagsByItemId = new Map<string, Set<string>>();

      for (const join of joins) {
        const itemId = join.get("itemId") as string;
        const tagId = join.get("tagId") as string;
        const set = tagsByItemId.get(itemId) || new Set<string>();
        set.add(tagId);
        tagsByItemId.set(itemId, set);
      }

      candidates = candidates.filter((item) => {
        const itemTagSet = tagsByItemId.get(item.id);
        if (!itemTagSet) return false;
        return uniqueTagIds.every((tagId) => itemTagSet.has(tagId));
      });
    }

    if (excludedTagIds.length > 0) {
      const excludedSet = new Set(excludedTagIds);
      const joins = await db.item_tags
        .find({ selector: { tagId: { $in: Array.from(excludedSet) } } })
        .exec();
      const excludedItemIds = new Set(joins.map((join) => join.get("itemId") as string));
      candidates = candidates.filter((item) => !excludedItemIds.has(item.id));
    }
    filterMs = now() - filterStartedAt;

    if (candidates.length === 0) {
      this.assertSearchGeneration(searchGeneration);
      return {
        items: [],
        total: 0,
        totalIsExact: true,
        vectorHits: 0,
        lexicalHits: 0,
        vectorError: null,
        sortBy,
        sortOrder,
        page,
        limit,
        hasMore: false,
        nextCursor: null,
        diagnostics: {
          queryHash,
          candidateCount: 0,
          rankInputCount: 0,
          usedSimpleSortPath: false,
          scoreBudget,
          supersededCount: this.rankTelemetry.supersededCount,
          fallbackCount: this.rankTelemetry.fallbackCount,
          selectorMs,
          filterMs,
          lexicalMs,
          vectorMs,
          vectorEmbedMs,
          vectorScanMs,
          rankMs,
          hydrateMs,
          totalMs: now() - startedAt,
        },
      };
    }

    const candidateIdSet = new Set(candidates.map((item) => item.id));

    if (lexicalScores.size > 0) {
      const filteredLexicalScores = new Map<string, number>();
      const filteredLexicalMatchMasks = new Map<string, number[]>();
      for (const [id, score] of lexicalScores.entries()) {
        if (candidateIdSet.has(id)) {
          filteredLexicalScores.set(id, score);
          const matchMask = lexicalMatchMasksById.get(id);
          if (matchMask) filteredLexicalMatchMasks.set(id, matchMask);
        }
      }
      lexicalScores = filteredLexicalScores;
      lexicalMatchMasksById = filteredLexicalMatchMasks;
    }

    const effectiveHasTextConstraint =
      hasExplicitTextConstraint ||
      (!useVector && useLexical && hasImplicitTextConstraint && lexicalScores.size === 0);

    let vectorError: string | null = null;
    let vectorScoresByIndex = new Map<number, number>();
    let vectorTopHits: QueryDebugPayload["vectorTopHits"] = [];
    let vectorTopScore: number | null = null;
    let vectorMinAcceptedScore: number | null = null;
    let rawVectorHitCount = 0;

    if (useVector) {
      const vectorStartedAt = now();
      const allCandidateIndices = Array.from(
        new Set(candidates.flatMap((item) => item.vectorIndexes).filter((index) => index >= 0))
      );
      const candidateIndices = allCandidateIndices;

      if (candidateIndices.length > 0) {
        const vectorAbortController = this.startVectorSearchPhase(searchGeneration);
        const timeoutMessage = `Vector search timed out after ${VECTOR_SEARCH_TIMEOUT_MS}ms.`;
        try {
          const requestedTopK = Math.max(
            1,
            Math.min(
              vectorTopKLimit,
              candidateIndices.length
            )
          );
          const vectorSearch = await this.withTimeout(
            vectorQueryLease!.search({
              query: vectorQuery,
              topK: requestedTopK,
              candidateIndices,
              signal: vectorAbortController.signal,
            }),
            VECTOR_SEARCH_TIMEOUT_MS,
            timeoutMessage,
            () => vectorAbortController.abort(new Error(timeoutMessage))
          );
          vectorEmbedMs = vectorSearch.timings.embeddingMs;
          vectorScanMs = vectorSearch.timings.scanMs;
          const rawVectorResults = vectorSearch.results;
          rawVectorHitCount = rawVectorResults.length;
          const vectorPrune = this.selectVectorResults(rawVectorResults, payload.minScore);
          vectorTopScore = Number.isFinite(vectorPrune.topScore) ? vectorPrune.topScore : null;
          vectorMinAcceptedScore = Number.isFinite(vectorPrune.minAcceptedScore)
            ? vectorPrune.minAcceptedScore
            : null;
          const prunedVectorResults = vectorPrune.pruned;
          vectorScoresByIndex = new Map(
            prunedVectorResults.map((result) => [result.index, result.score])
          );
          if (includeDebug) {
            const candidateByVectorIndex = new Map<number, CandidateLite>(
              candidates.flatMap((item) => item.vectorIndexes.map((index) => [index, item] as [number, CandidateLite]))
            );
            vectorTopHits = prunedVectorResults.slice(0, 12).map((entry) => {
              const candidate = candidateByVectorIndex.get(entry.index);
              return {
                index: entry.index,
                score: entry.score,
                itemId: candidate?.id,
                title: candidate?.title || "",
              };
            });
          }
        } catch (error) {
          if (error instanceof Error && error.message === RANK_REQUEST_SUPERSEDED) {
            throw new SupersededRankRequestError();
          }
          vectorError = error instanceof Error ? error.message : "Vector search failed";
          console.error("Vector search failed in queryLocal:", error);
        } finally {
          this.finishVectorSearchPhase(searchGeneration, vectorAbortController);
        }
      }
      vectorMs = now() - vectorStartedAt;
    }
    // Candidate rows and their vector indexes are now paired with the vector
    // file read from the same maintenance generation. Ranking no longer needs
    // to delay compaction.
    vectorQueryLease?.release();

    const canUseSimpleFieldSortPath =
      !effectiveHasTextConstraint && !useVector && sortBy !== "relevance";
    if (canUseSimpleFieldSortPath) {
      usedSimpleSortPath = true;
      const fieldSortBy = sortBy as Exclude<LocalQuerySortBy, "relevance">;
      candidates.sort((a, b) => this.compareByField(a, b, fieldSortBy, sortOrder));
      const total = candidates.length;
      const hasAfterCursor = !!afterCursor;
      const pageBase = hasAfterCursor
        ? candidates.filter((entry) => {
            const cursor = afterCursor as RankQueryCursor;
            return (
              this.compareByField(
                entry,
                {
                  id: cursor.id,
                  title: cursor.title || "",
                  source: cursor.source,
                  createdAt: cursor.createdAt || 0,
                  updatedAt: cursor.updatedAt || 0,
                },
                fieldSortBy,
                sortOrder
              ) > 0
            );
          })
        : candidates;
      const offset = hasAfterCursor ? 0 : Math.max(0, (page - 1) * limit);
      const pagedSlice = pageBase.slice(offset, offset + limit);
      const pagedIds = pagedSlice.map((entry) => entry.id);
      const hydrateStartedAt = now();
      const items = await hydrateFromDocMap(pagedIds);
      hydrateMs = now() - hydrateStartedAt;
      const hasMore = hasAfterCursor ? pageBase.length > limit : offset + limit < total;
      const nextCursor =
        hasMore && pagedSlice.length > 0
          ? ({
              queryHash,
              id: pagedSlice[pagedSlice.length - 1].id,
              relevance: 0,
              createdAt: pagedSlice[pagedSlice.length - 1].createdAt || 0,
              updatedAt: pagedSlice[pagedSlice.length - 1].updatedAt || 0,
              title: pagedSlice[pagedSlice.length - 1].title || "",
              source: pagedSlice[pagedSlice.length - 1].source,
            } as RankQueryCursor)
          : null;
      this.assertSearchGeneration(searchGeneration);
      return {
        items,
        total,
        totalIsExact: true,
        vectorHits: 0,
        lexicalHits: 0,
        vectorError,
        sortBy,
        sortOrder,
        page,
        limit,
        hasMore,
        nextCursor,
        diagnostics: {
          queryHash,
          candidateCount: candidates.length,
          rankInputCount: 0,
          usedSimpleSortPath,
          scoreBudget,
          supersededCount: this.rankTelemetry.supersededCount,
          fallbackCount: this.rankTelemetry.fallbackCount,
          selectorMs,
          filterMs,
          lexicalMs,
          vectorMs,
          vectorEmbedMs,
          vectorScanMs,
          rankMs,
          hydrateMs,
          totalMs: now() - startedAt,
        },
      };
    }

    let itemsForRanking = candidates;
    const canPruneRankInput =
      candidates.length > MAX_RANK_INPUT_ITEMS &&
      ((effectiveHasTextConstraint && !expression && excludedTerms.length === 0) ||
        (useVector && !hasExplicitTextConstraint));
    if (canPruneRankInput && (lexicalScores.size > 0 || vectorScoresByIndex.size > 0)) {
      const candidateIds = new Set<string>();
      for (const [id] of lexicalScores.entries()) {
        candidateIds.add(id);
      }

      if (vectorScoresByIndex.size > 0) {
        const idByVectorIndex = new Map<number, string>();
        for (const item of candidates) {
          for (const index of item.vectorIndexes) {
            idByVectorIndex.set(index, item.id);
          }
        }
        for (const [vectorIndex] of vectorScoresByIndex.entries()) {
          const id = idByVectorIndex.get(vectorIndex);
          if (id) candidateIds.add(id);
        }
      }

      if (candidateIds.size >= Math.min(Math.max(limit * 2, MIN_PRUNE_CANDIDATES), candidates.length)) {
        itemsForRanking = candidates.filter((item) => candidateIds.has(item.id));
      }
    }

    const needsTextForRanking =
      effectiveHasTextConstraint || (useLexical && lexicalScores.size === 0);
    rankInputCount = itemsForRanking.length;

    let rankedItemIds: string[] = [];
    let rankTotal = 0;
    let rankVectorHits = 0;
    let rankLexicalHits = 0;
    let rankHasMore = false;
    let rankNextCursor: RankQueryCursor | null = null;
    let rankDebugScores: QueryDebugPayload["perItem"] | undefined;
    let rankRetainedPeakCount = 0;
    let rankHydrationBatchSize = 0;

    const acceptRankResult = (result: {
      itemIds: string[];
      total: number;
      vectorHits: number;
      lexicalHits: number;
      hasMore: boolean;
      nextCursor?: RankQueryCursor | null;
      debugScores?: QueryDebugPayload["perItem"];
    }) => {
      rankedItemIds = result.itemIds;
      rankTotal = result.total;
      rankVectorHits = result.vectorHits;
      rankLexicalHits = result.lexicalHits;
      rankHasMore = result.hasMore;
      rankNextCursor = result.nextCursor || null;
      rankDebugScores = result.debugScores;
    };

    if (shouldStreamRankCandidates(itemsForRanking.length)) {
      // Negative-only/AST searches cannot be safely pruned to lexical hits: a
      // query such as `NOT foo` may need to inspect the entire library. Hydrate
      // those rows in small batches and retain only the requested rank window.
      const rankStartedAt = now();
      try {
        const streamed = await streamRankCandidates({
          candidates: itemsForRanking,
          batchSize: STREAMING_RANK_HYDRATION_BATCH_SIZE,
          assertActive: () => this.assertSearchGeneration(searchGeneration),
          rank: {
            expression,
            groups: normalizedGroups,
            excludedTerms,
            flatPositiveTerms,
            hasTextConstraint: effectiveHasTextConstraint,
            useLexical,
            useVector,
            sortBy,
            sortOrder,
            page,
            limit,
            queryHash,
            afterCursor,
            lexicalScores,
            lexicalMatchTerms,
            lexicalMatchMasksById,
            vectorScoresByIndex,
            includeDebug,
          },
          hydrateBatch: async (batch) => {
            let textDocs: Map<string, any> | null = null;
            if (needsTextForRanking && batch.length > 0) {
              const textHydrateStartedAt = now();
              this.assertSearchGeneration(searchGeneration);
              textDocs = await db.items.findByIds(batch.map((item) => item.id)).exec();
              this.assertSearchGeneration(searchGeneration);
              hydrateMs += now() - textHydrateStartedAt;
            }
            return batch.map((item) => {
              const doc = textDocs?.get(item.id);
              return this.toRankableItem(
                item,
                needsTextForRanking
                  ? (doc?.get("textContent") as string | undefined) || ""
                  : "",
                needsTextForRanking
                  ? (doc?.get("ocrText") as string | undefined) || ""
                  : ""
              );
            });
          },
        });
        acceptRankResult(streamed);
        rankRetainedPeakCount = streamed.stats.peakResidentRankItemCount;
        rankHydrationBatchSize = streamed.stats.peakBatchInputCount;
      } catch (error) {
        if (
          error instanceof SupersededRankRequestError ||
          error instanceof Error &&
          (error.message === RANK_REQUEST_SUPERSEDED || error.name === RANK_REQUEST_SUPERSEDED)
        ) {
          this.rankTelemetry.supersededCount += 1;
        }
        throw error;
      } finally {
        rankMs = now() - rankStartedAt;
      }
    } else {
      // Keep the worker path for small result sets. It isolates ranking CPU and
      // its structured-clone cost is bounded by shouldStreamRankCandidates().
      const rankingTextById = new Map<string, { textContent: string; ocrText: string }>();
      if (needsTextForRanking && itemsForRanking.length > 0) {
        const textHydrateStartedAt = now();
        this.assertSearchGeneration(searchGeneration);
        const textDocs = await db.items.findByIds(itemsForRanking.map((item) => item.id)).exec();
        this.assertSearchGeneration(searchGeneration);
        for (const [id, doc] of textDocs) {
          rankingTextById.set(id, {
            textContent: (doc.get("textContent") as string | undefined) || "",
            ocrText: (doc.get("ocrText") as string | undefined) || "",
          });
        }
        hydrateMs += now() - textHydrateStartedAt;
      }
      const rankableItems = itemsForRanking.map((item) => {
        const text = rankingTextById.get(item.id);
        return this.toRankableItem(
          item,
          needsTextForRanking ? text?.textContent || "" : "",
          needsTextForRanking ? text?.ocrText || "" : ""
        );
      });
      rankRetainedPeakCount = rankableItems.length;
      rankHydrationBatchSize = rankableItems.length;

      const rankStartedAt = now();
      try {
        this.assertSearchGeneration(searchGeneration);
        const rankResult = await queryRankerService.rank({
          items: rankableItems,
          expression,
          groups: normalizedGroups,
          excludedTerms,
          flatPositiveTerms,
          hasTextConstraint: effectiveHasTextConstraint,
          useLexical,
          useVector,
          sortBy,
          sortOrder,
          page,
          limit,
          queryHash,
          afterCursor,
          lexicalScores: Array.from(lexicalScores.entries()),
          lexicalMatchTerms,
          lexicalMatchMasksById: Array.from(lexicalMatchMasksById.entries()),
          vectorScoresByIndex: Array.from(vectorScoresByIndex.entries()),
          includeDebug,
        }, this.getSearchClientId(searchGeneration), searchSignal);
        acceptRankResult(rankResult);
      } catch (error) {
        if (
          error instanceof SupersededRankRequestError ||
          error instanceof Error &&
          (error.message === RANK_REQUEST_SUPERSEDED || error.name === RANK_REQUEST_SUPERSEDED)
        ) {
          this.rankTelemetry.supersededCount += 1;
          throw error;
        }
        // Overload is intentionally not converted into main-thread ranking:
        // doing so would bypass the worker/queue caps precisely when many tabs
        // are already competing for memory and CPU.
        if (error instanceof RankWorkerCapacityError) {
          throw error;
        }
        console.warn("[ItemsController] Query rank worker failed, using local fallback.", error);
        this.rankTelemetry.fallbackCount += 1;
        acceptRankResult(this.rankLocally({
          items: rankableItems,
          expression,
          groups: normalizedGroups,
          excludedTerms,
          flatPositiveTerms,
          hasTextConstraint: effectiveHasTextConstraint,
          useLexical,
          useVector,
          sortBy,
          sortOrder,
          page,
          limit,
          queryHash,
          afterCursor,
          lexicalScores,
          lexicalMatchTerms,
          lexicalMatchMasksById,
          vectorScoresByIndex,
          includeDebug,
        }));
      } finally {
        rankMs = now() - rankStartedAt;
      }
    }

    const hydrateStartedAt = now();
    const rankedItems = await hydrateFromDocMap(rankedItemIds);
    hydrateMs += now() - hydrateStartedAt;

    this.assertSearchGeneration(searchGeneration);
    return {
      items: rankedItems,
      total: rankTotal,
      totalIsExact: true,
      vectorHits: rankVectorHits,
      lexicalHits: rankLexicalHits,
      vectorError,
      sortBy,
      sortOrder,
      page,
      limit,
      hasMore: rankHasMore,
      nextCursor: rankNextCursor,
      diagnostics: {
        queryHash,
        candidateCount: candidates.length,
        rankInputCount,
        rankRetainedPeakCount,
        rankHydrationBatchSize,
        usedSimpleSortPath,
        scoreBudget,
        supersededCount: this.rankTelemetry.supersededCount,
        fallbackCount: this.rankTelemetry.fallbackCount,
        selectorMs,
        filterMs,
        lexicalMs,
        vectorMs,
        vectorEmbedMs,
        vectorScanMs,
        rankMs,
        hydrateMs,
        totalMs: now() - startedAt,
      },
      debug: includeDebug
        ? {
            queryHash,
            perItem: rankDebugScores || [],
            vectorTopHits,
            vectorStats: useVector
              ? {
                  candidateCount: Array.from(
                    new Set(candidates.flatMap((item) => item.vectorIndexes).filter((index) => index >= 0))
                  ).length,
                  rawHitCount: rawVectorHitCount,
                  keptHitCount: vectorScoresByIndex.size,
                  topScore: vectorTopScore,
                  minAcceptedScore: vectorMinAcceptedScore,
                  mode: useLexical ? "hybrid" : "vector",
                }
              : undefined,
          }
        : undefined,
    };
  }

  async getByIds(payload: {
    itemIds?: string[];
    spaceIds?: string[];
    accessContext?: LocalQueryPayload["accessContext"];
  }): Promise<ItemDocType[]> {
    const itemIds = Array.from(new Set((payload.itemIds || []).filter(Boolean))).slice(
      0,
      MAX_GRID_QUERY_LIMIT
    );
    if (itemIds.length === 0) return [];

    const db = await getDb();
    const baseAllowedSpaceIds = await this.resolveAllowedSpaceIds(db, {
      accessContext: payload.accessContext,
    });
    const requestedSpaceIds = new Set((payload.spaceIds || []).filter(Boolean));
    const allowedSpaceIds =
      requestedSpaceIds.size > 0
        ? baseAllowedSpaceIds.filter((spaceId) => requestedSpaceIds.has(spaceId))
        : baseAllowedSpaceIds;
    if (allowedSpaceIds.length === 0) return [];

    const allowedSpaceIdSet = new Set(allowedSpaceIds);
    const docsById = await db.items.findByIds(itemIds).exec();
    return itemIds
      .map((itemId) => docsById.get(itemId))
      .filter(Boolean)
      .map((doc) => doc!.toMutableJSON() as ItemDocType)
      .filter((item) => (item.deletedAt || 0) === 0 && allowedSpaceIdSet.has(item.spaceId));
  }

  async addToFolder(payload: {
    id?: string;
    folderId: string;
    url: string;
    title?: string;
    userId?: string | null;
    iconUrl?: string;
    displayImageUrl?: string;
    textContent?: string;
    source?: ItemDocType["source"];
    authorUsername?: string;
    likes?: number;
    upvotes?: number;
    media?: ItemDocType["media"];
    ocrText?: string;
    ocrStatus?: ItemDocType["ocrStatus"];
    ocrConfidence?: number | null;
    ocrLineCount?: number;
    ocrModelVersion?: string;
    ocrSourceHash?: string;
    isMetaFetched?: boolean;
    isDirty?: boolean;
    shouldFetchMetadata?: boolean;
    deferBackgroundProcessing?: boolean;
    allowLockedPrivateWrite?: boolean;
    parentId?: string | null;
    chunkOrder?: number;
    createdAt?: number;
    updatedAt?: number;
  }): Promise<ItemDocType> {
    const db = await getDb();
    const now = Date.now();
    const createdAt = payload.createdAt ?? now;
    const updatedAt = payload.updatedAt ?? createdAt;
    const normalizedUrl = this.normalizeUrl(payload.url);
    if (!normalizedUrl) {
      throw new Error("INVALID_URL");
    }
    return withLiveFolderDestination(db, payload.folderId, async ({ spaceId: folderSpaceId }) => {
      const bypassLockCheck =
        payload.allowLockedPrivateWrite === true && folderSpaceId === PRIVATE_SPACE_ID;
      if (!bypassLockCheck) this.assertSpaceUnlocked(folderSpaceId);

    // Cap a single tab group at 500 tabs so groups stay performant. Pagination
    // handles display; this prevents unbounded manual growth.
    const MAX_TABS_PER_FOLDER = 500;
    const existingCount = await db.items
      .count({ selector: { folderId: { $eq: payload.folderId }, deletedAt: { $eq: 0 } } })
      .exec();
    if (existingCount >= MAX_TABS_PER_FOLDER) {
      throw new Error(`Tab group is full — max ${MAX_TABS_PER_FOLDER} tabs per group.`);
    }

    const shouldFetchMetadata =
      payload.shouldFetchMetadata !== false && isMetadataFetchableUrl(normalizedUrl);
    const initialIsMetaFetched = shouldFetchMetadata
      ? payload.isMetaFetched ?? false
      : true;

    const base: ItemDocType = {
      id: payload.id || uuidv4(),
      userId: this.normalizeUserId(payload.userId),
      title: (payload.title || normalizedUrl).slice(0, 80),
      textContent: payload.textContent ?? "",
      url: normalizedUrl,
      source: payload.source ?? "web",
      folderId: payload.folderId,
      spaceId: folderSpaceId,
      isFavorite: false,
      authorUsername: payload.authorUsername,
      likes: payload.likes,
      upvotes: payload.upvotes,
      media: payload.media,
      displayImageUrl: payload.displayImageUrl,
      parentId: payload.parentId ?? null,
      chunkOrder: payload.chunkOrder ?? createdAt,
      vector_index: -1,
      vector_indexes: [],
      ocrText: payload.ocrText,
      ocrStatus: payload.ocrStatus ?? "pending",
      ocrConfidence: payload.ocrConfidence,
      ocrLineCount: payload.ocrLineCount,
      ocrModelVersion: payload.ocrModelVersion ?? "",
      ocrSourceHash: payload.ocrSourceHash,
      ocrUpdatedAt: payload.ocrStatus ? updatedAt : 0,
      isEmbedded: false,
      isMetaFetched: initialIsMetaFetched,
      isDirty: payload.isDirty ?? true,
      serverVersion: 0,
      createdAt,
      updatedAt,
      deletedAt: 0,
    };
    const item = this.sanitize({
      ...base,
      iconUrl: payload.iconUrl,
    });
    await db.items.insert(item as any);
    try {
      chrome.runtime.sendMessage({ type: "DB_CHANGE", scope: "items" });
    } catch {}
    if (!payload.deferBackgroundProcessing) {
      try {
        if (shouldFetchMetadata) {
          chrome.runtime.sendMessage({
            type: "FETCH_METADATA",
            payload: { urls: [normalizedUrl], revalidate: false },
            target: "background",
          });
        }
      } catch {}

      this.triggerBackgroundProcessing("TRIGGER_EMBEDDING");
      if ((item.media || []).some((entry) => entry?.type === "image")) {
        this.triggerBackgroundProcessing("TRIGGER_OCR");
      }
      if ((item.media || []).some((entry) => typeof entry?.opfsPath === "string" && entry.opfsPath)) {
        try {
          chrome.runtime.sendMessage({
            type: "PROMOTE_OPFS_MEDIA",
            target: "background",
          });
        } catch {}
      }
    }
      return item as ItemDocType;
    });
  }

  async addMany(payload: { items: ItemDocType[] }): Promise<{ inserted: number }> {
    const db = await getDb();
    if (!payload.items?.length) return { inserted: 0 };

    const folderIds = Array.from(new Set(payload.items.map((item) => item.folderId).filter(Boolean)));
    const folderDocs =
      folderIds.length > 0
        ? await db.folders.find({ selector: { id: { $in: folderIds } } }).exec()
        : [];
    const folderSpaceById = new Map<string, string>();
    for (const folderDoc of folderDocs) {
      folderSpaceById.set(
        folderDoc.get("id") as string,
        (folderDoc.get("spaceId") as string | undefined) || PUBLIC_SPACE_ID
      );
    }
    if (folderSpaceById.size !== folderIds.length) {
      throw new Error("DESTINATION_FOLDER_NOT_FOUND");
    }
    return withSpaceMutationLocks(db, folderSpaceById.values(), async () => {
      for (const [folderId, spaceId] of folderSpaceById) {
        await requireLiveFolderDestination(db, folderId, spaceId);
      }

    const toInsert = payload.items.map((item) => {
      const targetSpaceId = folderSpaceById.get(item.folderId);
      if (!targetSpaceId) throw new Error("DESTINATION_FOLDER_NOT_FOUND");
      this.assertSpaceUnlocked(targetSpaceId);
      return {
        ...item,
        userId: this.normalizeUserId(item.userId),
        spaceId: targetSpaceId,
        isMetaFetched: isMetadataFetchableUrl(item.url) ? item.isMetaFetched === true : true,
      };
    });

    const result = await db.items.bulkInsert(toInsert);
    if (result.error.length > 0) {
      throw new Error(`Failed to insert ${result.error.length} items.`);
    }
    try {
      chrome.runtime.sendMessage({ type: "DB_CHANGE", scope: "items" });
    } catch {}

    // Trigger metadata fetch for all newly inserted URLs
    const urlsToFetch = toInsert
      .filter((item) => item.isMetaFetched !== true && isMetadataFetchableUrl(item.url))
      .map((item) => item.url)
      .filter((url): url is string => !!url);
    if (urlsToFetch.length > 0) {
      try {
        chrome.runtime.sendMessage({
          type: "FETCH_METADATA",
          payload: { urls: urlsToFetch, revalidate: false },
          target: "background",
        });
      } catch {}
    }

    // Trigger embedding immediately for new items
    this.triggerBackgroundProcessing("TRIGGER_EMBEDDING");

      return { inserted: toInsert.length };
    });
  }

  async refetchMetadata(itemIds: string[]): Promise<void> {
    const db = await getDb();
    const itemsToRefetch = await db.items.findByIds(itemIds).exec();
    const items = Array.from(itemsToRefetch.values()).filter((doc) => {
      const spaceId = (doc.get("spaceId") as string | undefined) || PUBLIC_SPACE_ID;
      return spaceId !== PRIVATE_SPACE_ID || spaceSessionService.isUnlocked(PRIVATE_SPACE_ID);
    });
    if (items.length === 0) return;

    const urls = items.map((i) => i.url).filter((url) => isMetadataFetchableUrl(url));
    if (urls.length === 0) return;
    chrome.runtime.sendMessage({
      type: "FETCH_METADATA",
      payload: { urls, revalidate: true },
      target: "background",
    });
  }

  async moveToFolder(payload: {
    itemIds: string[];
    targetFolderId: string;
  }): Promise<{ updated: number }> {
    const db = await getDb();
    const targetFolderId = (payload.targetFolderId || "").trim();
    const itemIds = Array.from(new Set((payload.itemIds || []).filter(Boolean)));

    if (!targetFolderId || itemIds.length === 0) {
      return { updated: 0 };
    }
    const targetFolderDoc = await db.folders.findOne(targetFolderId).exec();
    if (!targetFolderDoc) {
      throw new Error("TARGET_FOLDER_NOT_FOUND");
    }
    const targetSpaceId = (targetFolderDoc.get("spaceId") as string | undefined) || PUBLIC_SPACE_ID;
    const initialItemDocs = await db.items.findByIds(itemIds).exec();
    const initialSourceSpaceIds = itemIds
      .map((id) => initialItemDocs.get(id))
      .filter((doc): doc is any => !!doc)
      .map((doc) => (doc.get("spaceId") as string | undefined) || PUBLIC_SPACE_ID);

    return withSpaceMutationLocks(
      db,
      [targetSpaceId, ...initialSourceSpaceIds],
      async () => {
    await requireLiveFolderDestination(db, targetFolderId, targetSpaceId);
    this.assertSpaceUnlocked(targetSpaceId);

    const targetDocs = await db.items
      .find({ selector: { folderId: { $eq: targetFolderId }, deletedAt: { $eq: 0 } } })
      .exec();

    const maxTargetOrder = targetDocs.reduce((max, doc) => {
      const chunkOrder = (doc.get("chunkOrder") as number | undefined) ?? -1;
      return Math.max(max, chunkOrder);
    }, -1);

    let nextTargetOrder = maxTargetOrder + 1;
    let updated = 0;
    const affectedSourceFolders = new Set<string>();
    const validatedSourceFolders = new Set<string>([targetFolderId]);

    for (const id of itemIds) {
      const doc = await db.items.findOne(id).exec();
      if (!doc) continue;

      const current = doc.toMutableJSON() as ItemDocType;
      if (current.deletedAt !== 0) continue;
      if (!initialSourceSpaceIds.includes(current.spaceId || PUBLIC_SPACE_ID)) {
        throw new Error("SOURCE_ITEM_CHANGED");
      }
      this.assertSpaceUnlocked(current.spaceId || PUBLIC_SPACE_ID);
      if (!validatedSourceFolders.has(current.folderId)) {
        await requireLiveFolderDestination(
          db,
          current.folderId,
          current.spaceId || PUBLIC_SPACE_ID
        );
        validatedSourceFolders.add(current.folderId);
      }
      if (current.folderId !== targetFolderId) {
        affectedSourceFolders.add(current.folderId);
      }

      const desiredOrder = current.folderId === targetFolderId ? current.chunkOrder : nextTargetOrder;
      if (
        current.folderId !== targetFolderId ||
        current.chunkOrder !== desiredOrder ||
        current.spaceId !== targetSpaceId
      ) {
        await doc.patch({
          folderId: targetFolderId,
          spaceId: targetSpaceId,
          chunkOrder: desiredOrder,
          updatedAt: Date.now(),
        });
        updated++;
      }

      if (current.folderId !== targetFolderId) {
        nextTargetOrder += 1;
      }
    }

    // Normalize source folder ordering after moving items out.
    for (const sourceFolderId of affectedSourceFolders) {
      const sourceDocs = await db.items
        .find({ selector: { folderId: { $eq: sourceFolderId }, deletedAt: { $eq: 0 } } })
        .exec();
      const ordered = sourceDocs
        .map((doc) => doc.toMutableJSON() as ItemDocType)
        .sort((a, b) => {
          const ao = a.chunkOrder ?? Number.MAX_SAFE_INTEGER;
          const bo = b.chunkOrder ?? Number.MAX_SAFE_INTEGER;
          if (ao !== bo) return ao - bo;
          return b.createdAt - a.createdAt;
        });

      for (let i = 0; i < ordered.length; i++) {
        const item = ordered[i];
        if (item.chunkOrder === i) continue;
        const doc = await db.items.findOne(item.id).exec();
        if (!doc) continue;
        await doc.patch({ chunkOrder: i, updatedAt: Date.now() });
        updated++;
      }
    }

    if (updated > 0) {
      try {
        chrome.runtime.sendMessage({ type: "DB_CHANGE", scope: "items" });
      } catch {}
    }

        return { updated };
      }
    );
  }

  async reorder(payload: {
    folders: { folderId: string; orderedIds: string[] }[];
  }): Promise<{ updated: number }> {
    const db = await getDb();
    const entries = (payload.folders || []).filter((entry) => entry.folderId);
    if (entries.length === 0) return { updated: 0 };
    const initialFolders = await Promise.all(
      entries.map((entry) => db.folders.findOne(entry.folderId).exec())
    );
    const folderSpaceById = new Map<string, string>();
    for (let index = 0; index < entries.length; index += 1) {
      const folderDoc = initialFolders[index];
      if (!folderDoc) throw new Error("DESTINATION_FOLDER_NOT_FOUND");
      folderSpaceById.set(
        entries[index].folderId,
        (folderDoc.get("spaceId") as string | undefined) || PUBLIC_SPACE_ID
      );
    }

    return withSpaceMutationLocks(db, folderSpaceById.values(), async () => {
      let updated = 0;
      for (const { folderId, orderedIds } of entries) {
        const folderSpaceId = folderSpaceById.get(folderId);
        if (!folderSpaceId) throw new Error("DESTINATION_FOLDER_NOT_FOUND");
        await requireLiveFolderDestination(db, folderId, folderSpaceId);
        this.assertSpaceUnlocked(folderSpaceId);
        const docs = await db.items
          .find({ selector: { folderId: { $eq: folderId }, deletedAt: { $eq: 0 } } })
          .exec();
        const allIds = docs.map((doc) => doc.primary);
        const allIdSet = new Set(allIds);
        const providedIds = orderedIds.filter((id) => allIdSet.has(id));
        const finalOrder = appendUnorderedIds(providedIds, allIds);

        for (let index = 0; index < finalOrder.length; index += 1) {
          const doc = await db.items.findOne(finalOrder[index]).exec();
          if (!doc) continue;
          const current = doc.toMutableJSON() as ItemDocType;
          const needsPatch =
            current.folderId !== folderId ||
            current.chunkOrder !== index ||
            current.spaceId !== folderSpaceId;
          if (!needsPatch) continue;
          await doc.patch({
            folderId,
            spaceId: folderSpaceId,
            chunkOrder: index,
            updatedAt: Date.now(),
          });
          updated += 1;
        }
      }

      if (updated > 0) {
        try {
          chrome.runtime.sendMessage({ type: "DB_CHANGE", scope: "items" });
        } catch {}
      }
      return { updated };
    });
  }

  async delete(payload: {
    id: string;
    scope?: "current" | "all";
  }): Promise<{ success: boolean; error?: string }> {
    const db = await getDb();
    const doc = await db.items.findOne(payload.id).exec();
    if (!doc) {
      return { success: false, error: "NOT_FOUND" };
    }

    const item = doc.toMutableJSON();
    this.assertSpaceUnlocked((item.spaceId as string | undefined) || PUBLIC_SPACE_ID);
    const idsToDelete = new Set<string>([payload.id]);

    if (payload.scope === "all") {
      const siblings = await db.items
        .find({ selector: { url: { $eq: item.url }, deletedAt: { $eq: 0 } } })
        .exec();
      for (const sibling of siblings) {
        const siblingSpaceId = (sibling.get("spaceId") as string | undefined) || PUBLIC_SPACE_ID;
        if (siblingSpaceId === PRIVATE_SPACE_ID && !spaceSessionService.isUnlocked(PRIVATE_SPACE_ID)) {
          continue;
        }
        idsToDelete.add(sibling.primary);
      }
    }

    for (const id of idsToDelete) {
      await databaseManager.deleteItem({ id });
    }

    try {
      chrome.runtime.sendMessage({ type: "DB_CHANGE", scope: "items" });
    } catch {}

    return { success: true };
  }

  async restoreFromBin(payload: {
    id: string;
  }): Promise<{ success: boolean; error?: string; relocated?: boolean; message?: string }> {
    const db = await getDb();
    const id = (payload.id || "").trim();
    if (!id) return { success: false, error: "NOT_FOUND" };
    return withBinMutationLock(db, () =>
      withEntityMutationLock(db, "item", id, async () => {
        const doc = await db.items.findOne(id).exec();
        if (!doc) return { success: false, error: "NOT_FOUND" };

        const item = doc.toMutableJSON() as ItemDocType;
        this.assertSpaceUnlocked((item.spaceId as string | undefined) || PUBLIC_SPACE_ID);
        if ((item.deletedAt || 0) === 0) return { success: true };

        const restoreSpace = await resolveRestoreSpace(db, item.spaceId || PUBLIC_SPACE_ID);
        let targetFolderId = item.folderId;
        let relocated = restoreSpace.relocated || !item.folderId;
        if (!relocated && item.folderId && db.folders?.findOne) {
          const folderDoc = await db.folders.findOne(item.folderId).exec();
          const folderDeletedAt = (folderDoc?.get("deletedAt") as number | undefined) || 0;
          relocated = !folderDoc || folderDeletedAt > 0;
        }

        if (relocated) {
          const fallbackFolder = await createRestoreTabGroup(db, {
            spaceId: restoreSpace.space.id,
            userId: item.userId,
          });
          targetFolderId = fallbackFolder.id;
        }

        const updatedAt = nextBinMutationTimestamp(
          Date.now(),
          item.updatedAt,
          item.deletedAt
        );
        await doc.patch({
          folderId: targetFolderId,
          spaceId: restoreSpace.space.id,
          deletedAt: 0,
          updatedAt,
          isDirty: true,
        });
        await this.removeDeletedItemTombstone(db, id);

        if (restoreSpace.created) {
          try {
            chrome.runtime.sendMessage({ type: "DB_CHANGE", scope: "spaces" });
          } catch {}
        }
        if (relocated) {
          try {
            chrome.runtime.sendMessage({ type: "DB_CHANGE", scope: "folders" });
          } catch {}
        }
        try {
          chrome.runtime.sendMessage({ type: "DB_CHANGE", scope: "items" });
        } catch {}

        return {
          success: true,
          relocated,
          message: relocated ? restoreFallbackMessage(restoreSpace.space.name) : undefined,
        };
      })
    );
  }

  async deleteForever(payload: {
    id: string;
    expectedDeletedAt: number;
  }): Promise<{ success: boolean; error?: string }> {
    const db = await getDb();
    const id = (payload.id || "").trim();
    if (!id) return { success: false, error: "NOT_FOUND" };
    return withBinMutationLock(db, () =>
      withEntityMutationLock(db, "item", id, async () => {
        const doc = await db.items.findOne(id).exec();
        if (!doc) return { success: false, error: "NOT_FOUND" };
        const item = doc.toMutableJSON() as ItemDocType;
        this.assertSpaceUnlocked((item.spaceId as string | undefined) || PUBLIC_SPACE_ID);
        if (!(item.deletedAt > 0)) throw new Error("ITEM_NOT_IN_BIN");
        if (item.deletedAt !== payload.expectedDeletedAt) {
          throw new Error("ITEM_BIN_ENTRY_CHANGED");
        }

        await doc.remove();
        await this.removeDeletedItemTombstone(db, id);
        const deleteDirectories =
          this.options.deleteUnreferencedOpfsItemDirectories ||
          deleteUnreferencedOpfsItemDirectories;
        await deleteDirectories(db, [id]);

        try {
          chrome.runtime.sendMessage({ type: "DB_CHANGE", scope: "items" });
        } catch {}

        return { success: true };
      })
    );
  }

  async updateMedia(payload: {
    id: string;
    media: ItemDocType["media"];
    /** The media state the editor based this full-array replacement on. */
    expectedMedia?: ItemDocType["media"];
    preserveOcr?: boolean;
  }): Promise<{ success: boolean; error?: string }> {
    const db = await getDb();
    const id = (payload.id || "").trim();
    if (!id) return { success: false, error: "NOT_FOUND" };
    if (payload.expectedMedia === undefined) {
      return { success: false, error: "EXPECTED_MEDIA_REQUIRED" };
    }

    const incomingMedia = payload.media || [];
    const hasImageMedia = incomingMedia.some((m) => m?.type === "image");
    const shouldResetOcr = hasImageMedia && payload.preserveOcr !== true;
    const nextMedia = shouldResetOcr
      ? incomingMedia.map((m) => {
          if (m?.type !== "image") return m;
          const { ocr, ...rest } = m as any;
          return {
            ...rest,
            ocr: {
              status: "pending" as const,
              lineCount: 0,
              extractedAt: Date.now(),
              engine: "paddleocr",
            },
          };
        })
      : incomingMedia;

    const counts = getMediaCounts(
      nextMedia.map((m) => ({
        type: m.type,
        originalUrl: m.originalUrl || m.s3Url || "",
      }))
    );
    if (counts.image > MEDIA_LIMITS.image)
      return { success: false, error: `Too many images (max ${MEDIA_LIMITS.image})` };
    if (counts.gif > MEDIA_LIMITS.gif)
      return { success: false, error: `Too many GIFs (max ${MEDIA_LIMITS.gif})` };
    if (counts.video > MEDIA_LIMITS.video)
      return { success: false, error: `Too many videos (max ${MEDIA_LIMITS.video})` };

    let removedOpfsPaths: string[] = [];
    const result = await withEntityMutationLock(db, "item", id, async () => {
      const MAX_TRIES = 5;
      for (let attempt = 0; attempt < MAX_TRIES; attempt += 1) {
        const fresh = await db.items.findOne(id).exec();
        if (!fresh) return { success: false, error: "NOT_FOUND" };

        const current = fresh.toMutableJSON() as ItemDocType;
        this.assertSpaceUnlocked(
          (current.spaceId as string | undefined) || PUBLIC_SPACE_ID
        );
        if (current.deletedAt > 0) return { success: false, error: "ITEM_NOT_LIVE" };
        if (!mediaSnapshotsEqual(current.media, payload.expectedMedia)) {
          return { success: false, error: "MEDIA_CHANGED" };
        }

        const patchData: Record<string, any> = {
          media: nextMedia,
          updatedAt: nextBinMutationTimestamp(
            Date.now(),
            current.updatedAt,
            current.deletedAt
          ),
          isDirty: true,
        };
        if (shouldResetOcr) {
          patchData.ocrText = "";
          patchData.ocrStatus = "pending";
          patchData.ocrError = "";
          patchData.ocrModelVersion = "";
          patchData.ocrSourceHash = "";
          patchData.ocrUpdatedAt = 0;
          patchData.ocrConfidence = null;
          patchData.ocrLineCount = 0;
        }
        const nextDisplayImageUrl =
          nextMedia.find((m) => m.type === "image")?.s3Url ||
          nextMedia.find((m) => m.type === "image")?.originalUrl;
        if (nextDisplayImageUrl) patchData.displayImageUrl = nextDisplayImageUrl;

        try {
          await fresh.patch(patchData);
          const retainedPaths = new Set(
            nextMedia.flatMap((entry) =>
              typeof entry?.opfsPath === "string" && entry.opfsPath
                ? [entry.opfsPath]
                : []
            )
          );
          removedOpfsPaths = Array.from(
            new Set(
              (current.media || []).flatMap((entry) =>
                typeof entry?.opfsPath === "string" &&
                entry.opfsPath &&
                !retainedPaths.has(entry.opfsPath)
                  ? [entry.opfsPath]
                  : []
              )
            )
          );
          return { success: true };
        } catch (error: any) {
          const status =
            error?.status ??
            error?.rxdb?.status ??
            error?.parameters?.writeError?.status;
          if (status !== 409) throw error;
        }
      }

      return { success: false, error: "CONFLICT" };
    });

    if (!result.success) return result;

    await deleteUnreferencedOpfsFiles(
      db,
      removedOpfsPaths.map((opfsPath) => ({ opfsPath }))
    ).catch(() => {});

    try {
      chrome.runtime.sendMessage({ type: "DB_CHANGE", scope: "items" });
    } catch {}
    this.triggerBackgroundProcessing("TRIGGER_EMBEDDING");

    if (hasImageMedia && !payload.preserveOcr) {
      this.triggerBackgroundProcessing("TRIGGER_OCR");
    }

    if (nextMedia.some((m) => typeof m?.opfsPath === "string" && m.opfsPath)) {
      chrome.runtime.sendMessage({
        type: "PROMOTE_OPFS_MEDIA",
        target: "background",
      }).catch?.(() => {});
    }

    return { success: true };
  }

  async removeMedia(payload: {
    id: string;
    index: number;
  }): Promise<{ success: boolean; error?: string }> {
    const db = await getDb();
    const id = (payload.id || "").trim();
    if (!id) return { success: false, error: "NOT_FOUND" };
    if (!Number.isInteger(payload.index) || payload.index < 0) {
      return { success: false, error: "INVALID_INDEX" };
    }

    let removedOpfsPath = "";
    const result = await withEntityMutationLock(db, "item", id, async () => {
      const MAX_TRIES = 5;
      for (let attempt = 0; attempt < MAX_TRIES; attempt += 1) {
        const fresh = await db.items.findOne(id).exec();
        if (!fresh) return { success: false, error: "NOT_FOUND" };

        const current = fresh.toMutableJSON() as ItemDocType;
        this.assertSpaceUnlocked(
          (current.spaceId as string | undefined) || PUBLIC_SPACE_ID
        );
        if (current.deletedAt > 0) return { success: false, error: "ITEM_NOT_LIVE" };

        const media = current.media || [];
        if (payload.index >= media.length) {
          return { success: false, error: "INVALID_INDEX" };
        }
        const removed = media[payload.index];
        const nextMedia = media.filter((_, index) => index !== payload.index);
        const nextDisplayImageUrl =
          nextMedia.find((entry) => entry.type === "image")?.s3Url ||
          nextMedia.find((entry) => entry.type === "image")?.originalUrl;
        const patchData: Record<string, any> = {
          media: nextMedia,
          updatedAt: nextBinMutationTimestamp(
            Date.now(),
            current.updatedAt,
            current.deletedAt
          ),
          isDirty: true,
        };
        if (nextDisplayImageUrl) patchData.displayImageUrl = nextDisplayImageUrl;

        try {
          await fresh.patch(patchData);
          removedOpfsPath =
            typeof removed?.opfsPath === "string" &&
            removed.opfsPath &&
            !nextMedia.some((entry) => entry.opfsPath === removed.opfsPath)
              ? removed.opfsPath
              : "";
          return { success: true };
        } catch (error: any) {
          const status =
            error?.status ??
            error?.rxdb?.status ??
            error?.parameters?.writeError?.status;
          if (status !== 409) throw error;
        }
      }

      return { success: false, error: "CONFLICT" };
    });

    if (!result.success) return result;
    if (removedOpfsPath) {
      await deleteUnreferencedOpfsFiles(db, [{ opfsPath: removedOpfsPath }]).catch(
        () => {}
      );
    }

    try {
      chrome.runtime.sendMessage({ type: "DB_CHANGE", scope: "items" });
    } catch {}

    return { success: true };
  }

  async addMedia(payload: {
    id: string;
    url: string;
    type?: "image" | "video";
    altText?: string;
  }): Promise<{ success: boolean; error?: string }> {
    const db = await getDb();
    const id = (payload.id || "").trim();
    if (!id) return { success: false, error: "NOT_FOUND" };

    const trimmedUrl = payload.url.trim();
    if (!trimmedUrl) return { success: false, error: "URL_REQUIRED" };

    const type = payload.type || inferMediaType(trimmedUrl);
    const category: MediaCategory = type === "video" ? "video" : isGifUrl(trimmedUrl) ? "gif" : "image";

    const result = await withEntityMutationLock(db, "item", id, async () => {
      const MAX_TRIES = 5;
      for (let attempt = 0; attempt < MAX_TRIES; attempt += 1) {
        const fresh = await db.items.findOne(id).exec();
        if (!fresh) return { success: false, error: "NOT_FOUND" };

        const current = fresh.toMutableJSON() as ItemDocType;
        this.assertSpaceUnlocked(
          (current.spaceId as string | undefined) || PUBLIC_SPACE_ID
        );
        if (current.deletedAt > 0) return { success: false, error: "ITEM_NOT_LIVE" };

        const existingMedia = current.media || [];
        if (
          !canAddMedia(
            existingMedia.map((entry) => ({
              type: entry.type,
              originalUrl: entry.originalUrl,
            })),
            category
          )
        ) {
          return {
            success: false,
            error: `Limit reached for ${category}s (max ${MEDIA_LIMITS[category]})`,
          };
        }

        const newEntry: NonNullable<ItemDocType["media"]>[number] = {
          type,
          originalUrl: trimmedUrl,
          storageType: "hotlink",
          altText: payload.altText,
        };
        const nextMedia = [...existingMedia, newEntry];
        const nextDisplayImageUrl =
          nextMedia.find((entry) => entry.type === "image")?.s3Url ||
          nextMedia.find((entry) => entry.type === "image")?.originalUrl ||
          current.displayImageUrl;
        const patchData: Record<string, any> = {
          media: nextMedia,
          updatedAt: nextBinMutationTimestamp(
            Date.now(),
            current.updatedAt,
            current.deletedAt
          ),
          isDirty: true,
        };
        if (nextDisplayImageUrl) patchData.displayImageUrl = nextDisplayImageUrl;

        try {
          await fresh.patch(patchData);
          return { success: true };
        } catch (error: any) {
          const status =
            error?.status ??
            error?.rxdb?.status ??
            error?.parameters?.writeError?.status;
          if (status !== 409) throw error;
        }
      }

      return { success: false, error: "CONFLICT" };
    });

    if (!result.success) return result;

    try {
      chrome.runtime.sendMessage({ type: "DB_CHANGE", scope: "items" });
    } catch {}

    return { success: true };
  }

  async replaceMedia(payload: {
    id: string;
    index: number;
    url: string;
    type?: "image" | "video";
  }): Promise<{ success: boolean; error?: string }> {
    const db = await getDb();
    const id = (payload.id || "").trim();
    if (!id) return { success: false, error: "NOT_FOUND" };
    if (!Number.isInteger(payload.index) || payload.index < 0) {
      return { success: false, error: "INVALID_INDEX" };
    }

    const trimmedUrl = payload.url.trim();
    if (!trimmedUrl) return { success: false, error: "URL_REQUIRED" };

    const type = payload.type || inferMediaType(trimmedUrl);
    let removedOpfsPath = "";
    const result = await withEntityMutationLock(db, "item", id, async () => {
      const MAX_TRIES = 5;
      for (let attempt = 0; attempt < MAX_TRIES; attempt += 1) {
        const fresh = await db.items.findOne(id).exec();
        if (!fresh) return { success: false, error: "NOT_FOUND" };

        const current = fresh.toMutableJSON() as ItemDocType;
        this.assertSpaceUnlocked(
          (current.spaceId as string | undefined) || PUBLIC_SPACE_ID
        );
        if (current.deletedAt > 0) return { success: false, error: "ITEM_NOT_LIVE" };

        const media = current.media || [];
        if (payload.index >= media.length) {
          return { success: false, error: "INVALID_INDEX" };
        }
        const old = media[payload.index];
        const newEntry: NonNullable<ItemDocType["media"]>[number] = {
          type,
          originalUrl: trimmedUrl,
          storageType: "hotlink",
          altText: old?.altText,
        };
        const nextMedia = media.map((entry, index) =>
          index === payload.index ? newEntry : entry
        );
        const nextDisplayImageUrl =
          nextMedia.find((entry) => entry.type === "image")?.s3Url ||
          nextMedia.find((entry) => entry.type === "image")?.originalUrl;
        const patchData: Record<string, any> = {
          media: nextMedia,
          updatedAt: nextBinMutationTimestamp(
            Date.now(),
            current.updatedAt,
            current.deletedAt
          ),
          isDirty: true,
        };
        if (nextDisplayImageUrl) patchData.displayImageUrl = nextDisplayImageUrl;

        try {
          await fresh.patch(patchData);
          removedOpfsPath =
            typeof old?.opfsPath === "string" &&
            old.opfsPath &&
            !nextMedia.some((entry) => entry.opfsPath === old.opfsPath)
              ? old.opfsPath
              : "";
          return { success: true };
        } catch (error: any) {
          const status =
            error?.status ??
            error?.rxdb?.status ??
            error?.parameters?.writeError?.status;
          if (status !== 409) throw error;
        }
      }

      return { success: false, error: "CONFLICT" };
    });

    if (!result.success) return result;
    if (removedOpfsPath) {
      await deleteUnreferencedOpfsFiles(db, [{ opfsPath: removedOpfsPath }]).catch(
        () => {}
      );
    }

    try {
      chrome.runtime.sendMessage({ type: "DB_CHANGE", scope: "items" });
    } catch {}

    return { success: true };
  }

  async listItemsWithOpfsMedia(payload?: {
    afterId?: string;
    limit?: number;
  }): Promise<{
    items: { id: string; media: NonNullable<ItemDocType["media"]> }[];
    nextCursor: string | null;
    hasMore: boolean;
    scannedCount: number;
  }> {
    const db = await getDb();
    const requestedLimit = payload?.limit;
    const limit = Number.isFinite(requestedLimit)
      ? Math.max(1, Math.min(100, Math.floor(requestedLimit as number)))
      : 50;
    const page = await readIdKeysetPage({
      collection: db.items as any,
      selector: { deletedAt: { $eq: 0 } },
      pageSize: limit,
      afterId: (payload?.afterId || "").trim(),
    });

    const out: { id: string; media: NonNullable<ItemDocType["media"]> }[] = [];
    for (const doc of page.documents as any[]) {
      const media = (doc.get("media") as ItemDocType["media"] | undefined) || [];
      if (media.some((m) => typeof m?.opfsPath === "string" && m.opfsPath.length > 0)) {
        const spaceId = (doc.get("spaceId") as string | undefined) || PUBLIC_SPACE_ID;
        if (spaceId === PRIVATE_SPACE_ID && !spaceSessionService.isUnlocked(PRIVATE_SPACE_ID)) {
          continue;
        }
        out.push({ id: doc.primary, media });
      }
    }
    return {
      items: out,
      nextCursor: page.nextCursor,
      hasMore: page.hasMore,
      scannedCount: page.documents.length,
    };
  }

  /**
   * Commit completed OPFS uploads without replacing the caller's stale media
   * snapshot. Each promotion is applied only while the latest item still owns
   * the path and the bounded file identity still matches the uploaded bytes.
   */
  async applyOpfsMediaPromotions(payload: {
    id: string;
    promotions: {
      opfsPath: string;
      s3Url: string;
      sourceIdentity: OpfsFileIdentity;
    }[];
  }): Promise<{ success: boolean; promotedOpfsPaths: string[]; error?: string }> {
    const db = await getDb();
    const id = (payload?.id || "").trim();
    if (!id) return { success: false, promotedOpfsPaths: [], error: "NOT_FOUND" };

    const promotions = new Map<
      string,
      { s3Url: string; sourceIdentity: OpfsFileIdentity }
    >();
    for (const promotion of payload?.promotions || []) {
      const opfsPath =
        typeof promotion?.opfsPath === "string" ? promotion.opfsPath : "";
      const s3Url = typeof promotion?.s3Url === "string" ? promotion.s3Url.trim() : "";
      const sourceIdentity = promotion?.sourceIdentity;
      if (
        opfsPath &&
        s3Url &&
        Number.isFinite(sourceIdentity?.size) &&
        Number.isFinite(sourceIdentity?.lastModified) &&
        typeof sourceIdentity?.sampleSha256 === "string" &&
        sourceIdentity.sampleSha256.length > 0
      ) {
        promotions.set(opfsPath, { s3Url, sourceIdentity });
      }
    }
    if (promotions.size === 0) {
      return { success: true, promotedOpfsPaths: [] };
    }

    return withEntityMutationLock(db, "item", id, () => withOpfsMutationLock(async () => {
      const MAX_TRIES = 5;
      for (let attempt = 0; attempt < MAX_TRIES; attempt += 1) {
        const fresh = await db.items.findOne(id).exec();
        if (!fresh) {
          return { success: false, promotedOpfsPaths: [], error: "NOT_FOUND" };
        }

        const current = fresh.toMutableJSON() as ItemDocType;
        this.assertSpaceUnlocked(
          (current.spaceId as string | undefined) || PUBLIC_SPACE_ID
        );
        if (current.deletedAt > 0) {
          return { success: false, promotedOpfsPaths: [], error: "ITEM_NOT_LIVE" };
        }

        const verifiedPromotions = new Map<string, string>();
        const currentPaths = new Set(
          (current.media || []).flatMap((entry) =>
            typeof entry?.opfsPath === "string" && entry.opfsPath
              ? [entry.opfsPath]
              : []
          )
        );
        for (const opfsPath of currentPaths) {
          const promotion = promotions.get(opfsPath);
          if (!promotion) continue;
          const readIdentity =
            this.options.readOpfsFileIdentity || readOpfsFileIdentity;
          const currentIdentity = await readIdentity(opfsPath);
          if (opfsFileIdentitiesEqual(currentIdentity, promotion.sourceIdentity)) {
            verifiedPromotions.set(opfsPath, promotion.s3Url);
          }
        }

        const appliedPaths = new Set<string>();
        const nextMedia = (current.media || []).map((entry) => {
          const opfsPath = typeof entry?.opfsPath === "string" ? entry.opfsPath : "";
          const s3Url = verifiedPromotions.get(opfsPath);
          if (!s3Url) return entry;

          appliedPaths.add(opfsPath);
          const { opfsPath: _localPath, ...rest } = entry;
          return {
            ...rest,
            s3Url,
            storageType: "s3" as const,
          };
        });

        if (appliedPaths.size === 0) {
          return { success: true, promotedOpfsPaths: [] };
        }

        const nextDisplayImageUrl =
          nextMedia.find((entry) => entry.type === "image")?.s3Url ||
          nextMedia.find((entry) => entry.type === "image")?.originalUrl;
        const patchData: Partial<ItemDocType> = {
          media: nextMedia,
          updatedAt: nextBinMutationTimestamp(
            Date.now(),
            current.updatedAt,
            current.deletedAt
          ),
          isDirty: true,
        };
        if (nextDisplayImageUrl) patchData.displayImageUrl = nextDisplayImageUrl;

        try {
          await fresh.patch(patchData);
          const promotedOpfsPaths = Array.from(appliedPaths);
          try {
            chrome.runtime.sendMessage({ type: "DB_CHANGE", scope: "items" });
          } catch {}
          return { success: true, promotedOpfsPaths };
        } catch (error: any) {
          const status =
            error?.status ??
            error?.rxdb?.status ??
            error?.parameters?.writeError?.status;
          if (status !== 409) throw error;
        }
      }

      return {
        success: false,
        promotedOpfsPaths: [],
        error: "CONFLICT",
      };
    }));
  }

  async deleteUnreferencedOpfsMedia(payload: {
    files: { opfsPath: string; sourceIdentity: OpfsFileIdentity }[];
  }): Promise<{ deletedOpfsPaths: string[] }> {
    const db = await getDb();
    const files = (payload?.files || []).filter(
      (file) =>
        typeof file?.opfsPath === "string" &&
        file.opfsPath.length > 0 &&
        Number.isFinite(file.sourceIdentity?.size) &&
        Number.isFinite(file.sourceIdentity?.lastModified) &&
        typeof file.sourceIdentity?.sampleSha256 === "string" &&
        file.sourceIdentity.sampleSha256.length > 0
    );
    const deletedOpfsPaths = await deleteUnreferencedOpfsFiles(
      db,
      files.map((file) => ({
        opfsPath: file.opfsPath,
        expectedIdentity: file.sourceIdentity,
      }))
    );
    return { deletedOpfsPaths };
  }

  async update(payload: {
    id: string;
    title?: string;
    url?: string;
    textContent?: string;
    source?: ItemDocType["source"];
    isFavorite?: boolean;
    authorUsername?: string;
    likes?: number;
    upvotes?: number;
  }): Promise<{ success: boolean; error?: string }> {
    const db = await getDb();
    const doc = await db.items.findOne(payload.id).exec();
    if (!doc) {
      return { success: false, error: "NOT_FOUND" };
    }

    const current = doc.toMutableJSON() as ItemDocType;
    this.assertSpaceUnlocked((current.spaceId as string | undefined) || PUBLIC_SPACE_ID);

    const patchData: Partial<ItemDocType> = {};
    let embeddingRelevantChanged = false;

    if (payload.title !== undefined && payload.title !== current.title) {
      const next = payload.title.trim().slice(0, 500);
      if (next.length > 0) {
        patchData.title = next;
        embeddingRelevantChanged = true;
      }
    }

    if (payload.url !== undefined && payload.url !== current.url) {
      const next = payload.url.trim();
      if (next.length > 0) {
        try {
          new URL(next);
          patchData.url = next;
        } catch {
          return { success: false, error: "INVALID_URL" };
        }
      }
    }

    if (payload.textContent !== undefined && payload.textContent !== current.textContent) {
      patchData.textContent = payload.textContent;
      embeddingRelevantChanged = true;
    }

    if (payload.source !== undefined && payload.source !== current.source) {
      patchData.source = payload.source;
      embeddingRelevantChanged = true;
    }

    if (payload.isFavorite !== undefined && payload.isFavorite !== current.isFavorite) {
      patchData.isFavorite = payload.isFavorite;
    }

    if (payload.authorUsername !== undefined && payload.authorUsername !== current.authorUsername) {
      patchData.authorUsername = payload.authorUsername.trim() || undefined;
    }

    if (payload.likes !== undefined && payload.likes !== current.likes) {
      patchData.likes = Math.max(0, Math.floor(payload.likes));
    }

    if (payload.upvotes !== undefined && payload.upvotes !== current.upvotes) {
      patchData.upvotes = Math.max(0, Math.floor(payload.upvotes));
    }

    if (Object.keys(patchData).length === 0) {
      return { success: true };
    }

    if (embeddingRelevantChanged) {
      patchData.isDirty = true;
    }
    patchData.updatedAt = Date.now();

    const MAX_TRIES = 5;
    let attempt = 0;
    while (attempt < MAX_TRIES) {
      attempt += 1;
      const fresh = await db.items.findOne(payload.id).exec();
      if (!fresh) break;
      try {
        await fresh.patch(patchData);
        break;
      } catch (e: any) {
        const status = e?.status ?? e?.rxdb?.status ?? e?.parameters?.writeError?.status;
        if (status !== 409) throw e;
        continue;
      }
    }

    try {
      chrome.runtime.sendMessage({ type: "DB_CHANGE", scope: "items" });
    } catch {}

    if (embeddingRelevantChanged) {
      this.triggerBackgroundProcessing("TRIGGER_EMBEDDING");
    }

    return { success: true };
  }
}

export const itemsController = new ItemsController();
