import type { SearchQuerySubmitMeta } from "@src/pages/search/components/SearchQueryBar";
import type { SearchProcessStatusItem } from "@src/pages/search/components/SearchProcessStatus";
import { resolveNamedFilterValues } from "@src/pages/search/filter-values";
import { shouldPreserveSearchResultsForError } from "@src/pages/search/query-error-state";
import { includePendingRevealItem } from "@src/pages/search/selection-state";
import type { FolderDocType } from "@src/schemas/folder_schema";
import type { ItemDocType } from "@src/schemas/item_schema";
import type {
  QueryAnalysis,
  QueryDebugPayload,
  QueryMode,
  QueryRankDebugScore,
  QueryScope,
  QuerySortBy,
  QuerySortOrder,
  RankQueryCursor,
} from "@src/search-core/contracts";
import {
  getQueryModeFeatures,
  resolveEffectiveQueryChannels,
} from "@src/search-core/contracts";
import { mergeItemsById } from "@src/search-core/item-patch";
import {
  getSearchScoreBudget,
  shouldUseCursorPagination,
} from "@src/search-core/pagination";
import { resolveSearchSpaceIds } from "@src/search-core/space-scope";
import type { SpaceListItem } from "@src/services/spaces/types";
import {
  startTransition,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type Dispatch,
  type MutableRefObject,
  type SetStateAction,
} from "react";
import { parseItemListResponse, parseSearchQueryResponse } from "./contracts";
import {
  DEFAULT_QUERY_LIMIT,
  MAX_VECTOR_TOPK,
  MIN_SCORE_BUDGET,
  QUERY_REQUEST_TIMEOUT_MS,
  SCORE_BUDGET_MULTIPLIER,
  SEARCH_PAGE_SIZE,
  VECTOR_QUERY_MIN_CHARS,
  defaultAnalysis,
  parseDomain,
  sameStringArray,
  unique,
  type SearchQueryDiagnostics,
  type SearchQueryPayload,
  type SearchResultMeta,
} from "./model";
import { sendRuntimeMessage } from "../runtime/message";
import { resolveSearchFolderFilterIds } from "@src/pages/search/filter-values";

type SearchExecutionOptions = {
  queryText: string;
  queryAnalysis: QueryAnalysis;
  querySubmitMeta: SearchQuerySubmitMeta | null;
  effectiveMode: QueryMode;
  requestedScope: QueryScope;
  hasActiveQuery: boolean;
  activeSpaceId: string;
  activeSpaceGroupId: string | null;
  activeSpaceGroupSpaceIds: string[];
  selectedFolderId: string;
  folders: FolderDocType[];
  spaces: SpaceListItem[];
  cursorAfter: RankQueryCursor | null;
  cursorPage: number;
  isDebugSearchEnabled: boolean;
  searchClientId: string;
  pendingRevealItem: MutableRefObject<ItemDocType | null>;
  refreshToken: number;
  persistRecentQuery: (query: string) => void;
  upsertProcessStatus: (status: SearchProcessStatusItem) => void;
  clearProcessStatus: (statusId: string) => void;
};

const INITIAL_RESULT_META: SearchResultMeta = {
  total: 0,
  totalIsExact: true,
  vectorHits: 0,
  lexicalHits: 0,
  vectorError: null,
  page: 1,
  limit: DEFAULT_QUERY_LIMIT,
  hasMore: false,
  nextCursor: null,
  mode: "keyword",
};

/** Owns local query RPCs, result state, metadata patching, and diagnostics. */
export function useSearchExecution({
  queryText,
  queryAnalysis,
  querySubmitMeta,
  effectiveMode,
  requestedScope,
  hasActiveQuery,
  activeSpaceId,
  activeSpaceGroupId,
  activeSpaceGroupSpaceIds,
  selectedFolderId,
  folders,
  spaces,
  cursorAfter,
  cursorPage,
  isDebugSearchEnabled,
  searchClientId,
  pendingRevealItem,
  refreshToken,
  persistRecentQuery,
  upsertProcessStatus,
  clearProcessStatus,
}: SearchExecutionOptions) {
  const [items, setItems] = useState<ItemDocType[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [resultMeta, setResultMeta] =
    useState<SearchResultMeta>(INITIAL_RESULT_META);
  const [resultDebug, setResultDebug] = useState<QueryDebugPayload | null>(
    null,
  );
  const [domainsCatalog, setDomainsCatalog] = useState<string[]>([]);
  const [authorsCatalog, setAuthorsCatalog] = useState<string[]>([]);
  const [availableFilters, setAvailableFilters] = useState<string[]>([]);
  const [staleSuppressedCount, setStaleSuppressedCount] = useState(0);

  const clearResultDebug = useCallback((): void => setResultDebug(null), []);
  const clearAvailableFilters = useCallback((): void => {
    setAvailableFilters((current) => (current.length === 0 ? current : []));
  }, []);

  const requestId = useRef(0);
  const querySignature = useRef<string | null>(null);
  const visibleItemIds = useRef<Set<string>>(new Set());
  const pendingMetadataItemIds = useRef<Set<string>>(new Set());
  const metadataPatchTimer = useRef<number | null>(null);
  const hasConstrainedQuery = useRef(false);
  const staleSuppressedCountRef = useRef(0);

  const debugScoresByItemId = useMemo<Record<string, QueryRankDebugScore>>(
    () =>
      resultDebug
        ? Object.fromEntries(
            resultDebug.perItem.map((entry) => [entry.itemId, entry]),
          )
        : {},
    [resultDebug],
  );
  const topDebugVectorHit = useMemo(
    () => resultDebug?.vectorTopHits[0] ?? null,
    [resultDebug],
  );

  useEffect(
    () => () => {
      if (metadataPatchTimer.current !== null) {
        window.clearTimeout(metadataPatchTimer.current);
      }
    },
    [],
  );

  useEffect(() => {
    visibleItemIds.current = new Set(items.map((item) => item.id));
  }, [items]);

  useEffect(() => {
    const analysisCurrent = queryAnalysis.input === queryText;
    hasConstrainedQuery.current =
      queryText.trim().length > 0 ||
      (analysisCurrent &&
        (queryAnalysis.freeText.trim().length > 0 ||
          queryAnalysis.pills.length > 0 ||
          queryAnalysis.textGroups.length > 0 ||
          queryAnalysis.excludedTerms.length > 0));
  }, [queryAnalysis, queryText]);

  useEffect(() => {
    if (!isDebugSearchEnabled) setResultDebug(null);
  }, [isDebugSearchEnabled]);

  const flushMetadataItemPatches = useCallback(async (): Promise<void> => {
    metadataPatchTimer.current = null;
    const itemIds = [...pendingMetadataItemIds.current];
    pendingMetadataItemIds.current.clear();
    if (itemIds.length === 0) return;

    try {
      const response = parseItemListResponse(
        await sendRuntimeMessage(
          {
            service: "items",
            type: "getByIds",
            target: "offscreen",
            payload: {
              itemIds,
              spaceIds: activeSpaceGroupId
                ? activeSpaceGroupSpaceIds
                : undefined,
              accessContext: {
                activeSpaceId,
                searchScope: activeSpaceGroupId ? "global" : requestedScope,
              },
            },
          },
          QUERY_REQUEST_TIMEOUT_MS,
        ),
      );
      if (!response.success) return;
      startTransition(() => {
        setItems((current) => mergeItemsById(current, response.payload));
      });
    } catch (error) {
      console.warn("Failed to patch enriched search items:", error);
    }
  }, [
    activeSpaceGroupId,
    activeSpaceGroupSpaceIds,
    activeSpaceId,
    requestedScope,
  ]);

  const queueMetadataItemPatches = useCallback(
    (changedItemIds: string[]): boolean => {
      let hasVisibleChange = false;
      for (const itemId of changedItemIds) {
        if (!visibleItemIds.current.has(itemId)) continue;
        pendingMetadataItemIds.current.add(itemId);
        hasVisibleChange = true;
      }
      if (!hasVisibleChange || metadataPatchTimer.current !== null) {
        return hasVisibleChange;
      }
      metadataPatchTimer.current = window.setTimeout(
        () => void flushMetadataItemPatches(),
        120,
      );
      return true;
    },
    [flushMetadataItemPatches],
  );

  const recordSuppressedResult = useCallback((): void => {
    staleSuppressedCountRef.current += 1;
    setStaleSuppressedCount(staleSuppressedCountRef.current);
  }, []);

  const executeQuery = useCallback(async (): Promise<void> => {
    const currentRequestId = ++requestId.current;
    const requestStartedAt = performance.now();
    const analysisCurrent = queryAnalysis.input === queryText;
    const directives = analysisCurrent ? queryAnalysis.directives : {};
    const filters = analysisCurrent
      ? queryAnalysis.filters
      : defaultAnalysis.filters;
    const freeText = analysisCurrent
      ? queryAnalysis.freeText.trim()
      : queryText.trim();
    const modeFeatures = resolveEffectiveQueryChannels({
      requested: getQueryModeFeatures(effectiveMode),
      query: freeText,
      vectorMinChars: VECTOR_QUERY_MIN_CHARS,
    });
    const useCursor = shouldUseCursorPagination(directives.page);
    const page = directives.page ?? cursorPage;
    const parsedFolderIds = resolveNamedFilterValues(
      filters.folderIds,
      folders,
    );
    const excludedFolderIds = resolveNamedFilterValues(
      filters.excludeFolderIds,
      folders,
    );
    const parsedSpaceIds = resolveNamedFilterValues(filters.spaceIds, spaces);
    const excludedSpaceIds = resolveNamedFilterValues(
      filters.excludeSpaceIds,
      spaces,
    );
    const scope = resolveExecutionScope({
      hasActiveQuery,
      activeSpaceId,
      activeSpaceGroupId,
      activeSpaceGroupSpaceIds,
      requestedScope,
      parsedSpaceIds,
    });
    const includedFolderIds = resolveSearchFolderFilterIds({
      hasActiveQuery,
      parsedFolderIds,
      selectedFolderId,
    });
    const limit =
      directives.limit ??
      (hasActiveQuery ? SEARCH_PAGE_SIZE : DEFAULT_QUERY_LIMIT);
    const sortBy: QuerySortBy =
      directives.sortBy || (freeText ? "relevance" : "createdAt");
    const sortOrder: QuerySortOrder = directives.sortOrder || "desc";

    const signature = JSON.stringify({
      freeText,
      mode: effectiveMode,
      page,
      limit,
      sortBy,
      sortOrder,
      scopedSpaceIds: scope.spaceIds,
      includedFolderIds,
      filters,
      cursorPage: useCursor ? cursorPage : null,
    });
    const isBackgroundRefresh = signature === querySignature.current;
    querySignature.current = signature;
    setError(null);
    if (!isBackgroundRefresh) {
      setIsLoading(true);
      upsertProcessStatus({
        id: "search-query",
        label: "Search query",
        state: "processing",
        detail: `Searching local data... mode:${effectiveMode}`,
        updatedAt: Date.now(),
      });
    }

    try {
      const response = parseSearchQueryResponse(
        await sendRuntimeMessage(
          {
            service: "items",
            type: "queryLocal",
            target: "offscreen",
            payload: {
              searchClientId,
              query: freeText,
              text: {
                groups: analysisCurrent ? queryAnalysis.textGroups : [],
                excludedTerms: analysisCurrent
                  ? queryAnalysis.excludedTerms
                  : [],
                expression: analysisCurrent
                  ? queryAnalysis.textExpression
                  : undefined,
              },
              useVector: modeFeatures.vector,
              useKeyword: modeFeatures.keyword,
              useFuzzy: modeFeatures.fuzzy,
              minScore: directives.minScore,
              topK: getSearchScoreBudget({
                page,
                limit,
                minimum: MIN_SCORE_BUDGET,
                maximum: MAX_VECTOR_TOPK,
                multiplier: SCORE_BUDGET_MULTIPLIER,
              }),
              pagination: {
                page,
                limit,
                afterCursor: useCursor ? cursorAfter : undefined,
              },
              filters: {
                spaceIds: scope.spaceIds,
                excludeSpaceIds: excludedSpaceIds.length
                  ? excludedSpaceIds
                  : undefined,
                folderIds: includedFolderIds.length
                  ? includedFolderIds
                  : undefined,
                excludeFolderIds: excludedFolderIds.length
                  ? excludedFolderIds
                  : undefined,
                sources: filters.sources.length ? filters.sources : undefined,
                excludeSources: filters.excludeSources.length
                  ? filters.excludeSources
                  : undefined,
                favoritesOnly: filters.favoritesOnly,
                tagNames: filters.tagNames,
                excludeTagNames: filters.excludeTagNames,
                domains: filters.domains,
                excludeDomains: filters.excludeDomains,
                authors: filters.authors,
                excludeAuthors: filters.excludeAuthors,
                hasAny: filters.hasAny,
                excludeHasAny: filters.excludeHasAny,
                dateFrom: filters.dateFrom,
                dateTo: filters.dateTo,
                createdFrom: filters.createdFrom,
                createdTo: filters.createdTo,
                updatedFrom: filters.updatedFrom,
                updatedTo: filters.updatedTo,
                likesMin: filters.likesMin,
                likesMax: filters.likesMax,
                upvotesMin: filters.upvotesMin,
                upvotesMax: filters.upvotesMax,
              },
              sort: { by: sortBy, order: sortOrder },
              accessContext: {
                activeSpaceId,
                searchScope: scope.accessScope,
              },
              debug: isDebugSearchEnabled,
            },
          },
          QUERY_REQUEST_TIMEOUT_MS,
        ),
      );
      if (!response.success || !response.payload) {
        throw new Error(response.error ?? "Failed to run local query.");
      }
      if (currentRequestId !== requestId.current) {
        recordSuppressedResult();
        return;
      }
      if (response.payload.superseded) return;

      const payload = response.payload;
      const nextItems = includePendingRevealItem(
        payload.items,
        pendingRevealItem.current,
        { activeSpaceId, activeSpaceGroupId, selectedFolderId },
      );
      setItems(nextItems);
      setResultDebug(isDebugSearchEnabled ? (payload.debug ?? null) : null);
      setResultMeta({
        total: payload.total,
        totalIsExact: payload.totalIsExact !== false,
        vectorHits: payload.vectorHits,
        lexicalHits: payload.lexicalHits,
        vectorError: payload.vectorError ?? null,
        page: payload.page,
        limit: payload.limit,
        hasMore: payload.hasMore,
        nextCursor: payload.nextCursor ?? null,
        mode: effectiveMode,
      });

      publishSuccessStatus({
        payload,
        querySubmitMeta,
        requestStartedAt,
        freeText,
        mode: effectiveMode,
        requestedScope,
        staleSuppressedCount: staleSuppressedCountRef.current,
        debugEnabled: isDebugSearchEnabled,
        upsertProcessStatus,
      });
      if (payload.vectorError) {
        upsertProcessStatus({
          id: "vector-query",
          label: "Vector query",
          state: "error",
          detail: payload.vectorError,
          retryAction: "RETRY_QUERY",
          updatedAt: Date.now(),
        });
      } else {
        clearProcessStatus("vector-query");
      }

      updateCatalogs(payload.items, {
        setDomainsCatalog,
        setAuthorsCatalog,
        setAvailableFilters,
      });
      persistRecentQuery(queryText);
    } catch (caught) {
      if (currentRequestId !== requestId.current) {
        recordSuppressedResult();
        return;
      }
      const message =
        caught instanceof Error ? caught.message : "Failed to run query.";
      setError(message);
      if (!shouldPreserveSearchResultsForError(message)) {
        setItems([]);
        setResultDebug(null);
        setResultMeta({
          ...INITIAL_RESULT_META,
          page,
          limit,
          mode: effectiveMode,
        });
      }
      upsertProcessStatus({
        id: "search-query",
        label: "Search query",
        state: "error",
        detail: message,
        retryAction: "RETRY_QUERY",
        updatedAt: Date.now(),
      });
    } finally {
      if (currentRequestId === requestId.current) setIsLoading(false);
    }
  }, [
    activeSpaceGroupId,
    activeSpaceGroupSpaceIds,
    activeSpaceId,
    clearProcessStatus,
    cursorAfter,
    cursorPage,
    effectiveMode,
    folders,
    hasActiveQuery,
    isDebugSearchEnabled,
    pendingRevealItem,
    persistRecentQuery,
    queryAnalysis,
    querySubmitMeta,
    queryText,
    recordSuppressedResult,
    requestedScope,
    searchClientId,
    selectedFolderId,
    spaces,
    upsertProcessStatus,
  ]);

  useEffect(() => {
    void executeQuery();
  }, [refreshToken]);

  return {
    items,
    setItems,
    isLoading,
    error,
    resultMeta,
    resultDebug,
    clearResultDebug,
    domainsCatalog,
    authorsCatalog,
    availableFilters,
    clearAvailableFilters,
    staleSuppressedCount,
    debugScoresByItemId,
    topDebugVectorHit,
    visibleItemIds,
    hasConstrainedQuery,
    queueMetadataItemPatches,
  };
}

type ExecutionScope = {
  spaceIds: string[];
  accessScope: QueryScope;
};

function resolveExecutionScope(options: {
  hasActiveQuery: boolean;
  activeSpaceId: string;
  activeSpaceGroupId: string | null;
  activeSpaceGroupSpaceIds: string[];
  requestedScope: QueryScope;
  parsedSpaceIds: string[];
}): ExecutionScope {
  if (!options.hasActiveQuery) {
    return {
      spaceIds: resolveSearchSpaceIds({
        activeSpaceId: options.activeSpaceId,
        activeSpaceGroupId: options.activeSpaceGroupId,
        activeSpaceGroupSpaceIds: options.activeSpaceGroupSpaceIds,
        requestedScope: "current",
        requestedSpaceIds: options.parsedSpaceIds,
      }),
      accessScope: options.activeSpaceGroupId ? "global" : "current",
    };
  }
  return {
    spaceIds: resolveSearchSpaceIds({
      activeSpaceId: options.activeSpaceId,
      activeSpaceGroupId: null,
      activeSpaceGroupSpaceIds: [],
      requestedScope: options.requestedScope,
      requestedSpaceIds: options.parsedSpaceIds,
    }),
    accessScope: options.requestedScope,
  };
}

type CatalogSetters = {
  setDomainsCatalog: Dispatch<SetStateAction<string[]>>;
  setAuthorsCatalog: Dispatch<SetStateAction<string[]>>;
  setAvailableFilters: Dispatch<SetStateAction<string[]>>;
};

function updateCatalogs(items: ItemDocType[], setters: CatalogSetters): void {
  const domains = unique(
    items
      .map((item) => parseDomain(item.url))
      .filter((domain): domain is string => Boolean(domain)),
  ).slice(0, 120);
  if (domains.length) {
    setters.setDomainsCatalog((current) => {
      const merged = unique([...domains, ...current]).slice(0, 240);
      return sameStringArray(current, merged) ? current : merged;
    });
  }

  const authors = unique(
    items
      .map((item) => (item.authorUsername ?? "").trim().toLowerCase())
      .filter(Boolean),
  ).slice(0, 180);
  if (authors.length) {
    setters.setAuthorsCatalog((current) => {
      const merged = unique([...authors, ...current]).slice(0, 280);
      return sameStringArray(current, merged) ? current : merged;
    });
  }

  const filters = unique([
    ...items.map((item) => `source:${item.source}`),
    ...(items.some((item) => item.isFavorite) ? ["is:favorite"] : []),
    ...(items.some((item) =>
      item.media?.some((media) => media.type === "image"),
    )
      ? ["has:image"]
      : []),
  ]);
  if (filters.length) {
    setters.setAvailableFilters((current) => {
      const merged = unique([...current, ...filters]);
      return sameStringArray(current, merged) ? current : merged;
    });
  }
}

type PublishSuccessOptions = {
  payload: SearchQueryPayload;
  querySubmitMeta: SearchQuerySubmitMeta | null;
  requestStartedAt: number;
  freeText: string;
  mode: QueryMode;
  requestedScope: QueryScope;
  staleSuppressedCount: number;
  debugEnabled: boolean;
  upsertProcessStatus: (status: SearchProcessStatusItem) => void;
};

function publishSuccessStatus(options: PublishSuccessOptions): void {
  const roundTripMs = Math.max(0, performance.now() - options.requestStartedAt);
  const diagnostics = options.payload.diagnostics;
  const bridgeMs = diagnostics
    ? Math.max(0, roundTripMs - diagnostics.totalMs)
    : roundTripMs;
  const submitWaitMs = Math.max(
    0,
    options.querySubmitMeta?.uiDebounceWaitMs ?? 0,
  );
  const details =
    diagnostics && options.debugEnabled
      ? diagnosticsText({
          diagnostics,
          submitWaitMs,
          bridgeMs,
          roundTripMs,
          staleSuppressedCount: options.staleSuppressedCount,
        })
      : "";

  options.upsertProcessStatus({
    id: "search-query",
    label: "Search query",
    state: "success",
    detail:
      options.payload.totalIsExact === false
        ? `Loaded ${options.payload.items.length} results; more are available${details}.`
        : `Loaded ${options.payload.items.length} of ${options.payload.total} results${details}.`,
    updatedAt: Date.now(),
  });

  if (options.debugEnabled && diagnostics) {
    console.groupCollapsed(
      `[SearchDebug][${diagnostics.queryHash}] "${options.freeText || "<empty>"}" (${options.mode})`,
    );
    console.log("scope", options.requestedScope);
    console.log("counts", {
      total: options.payload.total,
      shown: options.payload.items.length,
      vectorHits: options.payload.vectorHits,
      lexicalHits: options.payload.lexicalHits,
      staleSuppressed: options.staleSuppressedCount,
    });
    console.log("timings", {
      ...diagnostics,
      submitWaitMs,
      bridgeMs,
      roundTripMs,
    });
    if (options.payload.debug?.vectorTopHits.length) {
      console.table(options.payload.debug.vectorTopHits.slice(0, 8));
    }
    if (options.payload.debug?.vectorStats) {
      console.log("vectorStats", options.payload.debug.vectorStats);
    }
    if (options.payload.debug?.perItem.length) {
      console.table(options.payload.debug.perItem.slice(0, 12));
    }
    console.groupEnd();
  }
}

function diagnosticsText(options: {
  diagnostics: SearchQueryDiagnostics;
  submitWaitMs: number;
  bridgeMs: number;
  roundTripMs: number;
  staleSuppressedCount: number;
}): string {
  const value = options.diagnostics;
  const ms = (duration: number) => `${Math.max(0, Math.round(duration))}ms`;
  return ` • ${value.candidateCount.toLocaleString()} candidates • ranked ${value.rankInputCount.toLocaleString()} • budget ${value.scoreBudget.toLocaleString()} • ${value.supersededCount} superseded • ${value.fallbackCount} fallback • stale:${options.staleSuppressedCount} • timings: ${ms(options.submitWaitMs)} submit-wait, ${ms(options.bridgeMs)} bridge, ${ms(value.selectorMs)} selector, ${ms(value.filterMs)} filter, ${ms(value.lexicalMs)} lexical, ${ms(value.vectorEmbedMs)} vector-embed, ${ms(value.vectorScanMs)} vector-scan, ${ms(value.rankMs)} rank, ${ms(value.hydrateMs)} hydrate, ${ms(value.totalMs)} backend, ${ms(options.roundTripMs)} round-trip`;
}
