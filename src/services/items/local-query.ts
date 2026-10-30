import type { ItemDocType } from "@src/schemas/item_schema";
import type {
  QueryDebugPayload,
  QueryTextExpression,
  RankQueryCursor,
  RankableItem,
} from "@src/search-core/contracts";
import { resolveEffectiveQueryChannels } from "@src/search-core/contracts";
import { canNarrowExpressionToPositiveMatches } from "@src/search-core/expression-analysis";
import { MAX_GRID_QUERY_LIMIT, splitLookaheadPage } from "@src/search-core/pagination";
import type { MyDatabase } from "@src/services/DatabaseService";
import { applyItemQueryFilters } from "@src/services/items/query-filters";
import { buildItemQuerySelector } from "@src/services/items/query-selector";
import { legacyBrowserEnabled } from "@src/services/extension-policy";
import {
  type CandidateDocument,
  type QueryHashInput,
  type RankLocallyArgs,
  type RankLocallyResult,
  type VectorSelection,
} from "@src/services/items/search-ranker";
import {
  LEXICAL_SEARCH_TIMEOUT_MS,
  MAX_LEXICAL_SCORE_BUDGET,
  MAX_RANK_INPUT_ITEMS,
  MAX_VECTOR_TOPK,
  MIN_PRUNE_CANDIDATES,
  MIN_SCORE_BUDGET,
  SCORE_BUDGET_MULTIPLIER,
  SCOPED_CANDIDATE_PAGE_SIZE,
  VECTOR_QUERY_MIN_CHARS,
  VECTOR_SEARCH_TIMEOUT_MS,
  type CandidateLite,
  type LocalQueryPayload,
  type LocalQueryResponse,
  type LocalQuerySortBy,
  type LocalQuerySortOrder,
  type SearchTelemetry,
  type VectorScoreResult,
} from "@src/services/items/search-model";
import { localSearchIndexService } from "@src/services/local-search-index.service";
import {
  queryRankerService,
  RANK_REQUEST_SUPERSEDED,
  RankWorkerCapacityError,
  SupersededRankRequestError,
} from "@src/services/query-ranker.service";
import { forEachIdKeysetPage } from "@src/services/rxdb-keyset-pagination";
import {
  shouldStreamRankCandidates,
  streamRankCandidates,
  STREAMING_RANK_HYDRATION_BATCH_SIZE,
} from "@src/services/streaming-query-ranker";
import type { VectorQueryLease } from "@src/services/vector-store.service";
import type { RxDocument } from "rxdb";

type ItemDocumentMap = Map<string, RxDocument<ItemDocType>>;

export type ItemLocalQueryRuntime = {
  getDatabase(): Promise<MyDatabase>;
  tokenizeQuery(query: string): string[];
  resolveVectorQueryText(payload: LocalQueryPayload): string;
  collectPositiveExpressionTerms(expression: QueryTextExpression): string[];
  resolveAllowedSpaceIds(db: MyDatabase, payload: LocalQueryPayload): Promise<string[]>;
  assertSearchGeneration(generation: number): void;
  buildQueryHash(payload: QueryHashInput): string;
  startLexicalSearchPhase(generation: number): AbortController;
  finishLexicalSearchPhase(generation: number, controller: AbortController): void;
  withTimeout<T>(
    promise: Promise<T>,
    timeoutMs: number,
    message: string,
    onTimeout?: () => void,
  ): Promise<T>;
  getSearchClientId(generation: number): string;
  toCandidateLite(document: CandidateDocument): CandidateLite;
  startVectorSearchPhase(generation: number): AbortController;
  finishVectorSearchPhase(generation: number, controller: AbortController): void;
  selectVectorResults(results: VectorScoreResult[], minScore?: number): VectorSelection;
  compareByField(
    left: Pick<RankableItem, "id" | "title" | "source" | "createdAt" | "updatedAt">,
    right: Pick<RankableItem, "id" | "title" | "source" | "createdAt" | "updatedAt">,
    sortBy: Exclude<LocalQuerySortBy, "relevance">,
    sortOrder: LocalQuerySortOrder,
  ): number;
  toRankableItem(item: CandidateLite, textContent: string, ocrText: string): RankableItem;
  rankLocally(args: RankLocallyArgs): RankLocallyResult;
  rankTelemetry: SearchTelemetry;
};

export async function runLocalQueryWithVectorLease(
  runtime: ItemLocalQueryRuntime,
  payload: LocalQueryPayload,
  searchGeneration: number,
  searchSignal: AbortSignal,
  vectorQueryLease: VectorQueryLease | null,
): Promise<LocalQueryResponse> {

    const now = () => globalThis.performance?.now() ?? Date.now();
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

    const db = await runtime.getDatabase();
    const query = (payload.query || "").trim();
    const fallbackTerms = runtime.tokenizeQuery(query);
    const expression = payload.text?.expression;
    const groups =
      payload.text?.groups?.map((group) => group.map((term) => term.trim()).filter(Boolean)).filter((group) => group.length > 0) ||
      [];
    const excludedTerms =
      payload.text?.excludedTerms?.map((term) => term.trim()).filter(Boolean) || [];
    const normalizedGroups = groups.length > 0 ? groups : fallbackTerms.length > 0 ? [fallbackTerms] : [];
    const expressionPositiveTerms = expression
      ? Array.from(new Set(runtime.collectPositiveExpressionTerms(expression)))
      : [];
    const flatPositiveTerms = Array.from(
      new Set(expression ? expressionPositiveTerms : normalizedGroups.flat())
    );
    const includeDebug = payload.debug === true;
    const vectorQuery = runtime.resolveVectorQueryText(payload);
    const effectiveChannels = resolveEffectiveQueryChannels({
      requested: {
        keyword: payload.useKeyword !== false,
        fuzzy: payload.useFuzzy === true,
        vector: payload.useVector === true,
      },
      query: vectorQuery,
      vectorMinChars: VECTOR_QUERY_MIN_CHARS,
      vectorAvailable: await legacyBrowserEnabled(),
    });
    const useKeyword = effectiveChannels.keyword;
    const useFuzzy = effectiveChannels.fuzzy;
    const useLexical = useKeyword || useFuzzy;
    const useVector = effectiveChannels.vector;
    const filters = payload.filters || {};
    const baseAllowedSpaceIds = await runtime.resolveAllowedSpaceIds(db, payload);
    const includeSpaceFilters = Array.from(new Set((filters.spaceIds || []).filter(Boolean)));
    const excludeSpaceFilters = new Set((filters.excludeSpaceIds || []).filter(Boolean));
    let allowedSpaceIds = includeSpaceFilters.length
      ? baseAllowedSpaceIds.filter((spaceId) => includeSpaceFilters.includes(spaceId))
      : baseAllowedSpaceIds;
    if (excludeSpaceFilters.size > 0) {
      allowedSpaceIds = allowedSpaceIds.filter((spaceId) => !excludeSpaceFilters.has(spaceId));
    }
    allowedSpaceIds = Array.from(new Set(allowedSpaceIds));
    runtime.assertSearchGeneration(searchGeneration);

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
    const queryHash = runtime.buildQueryHash({
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
      runtime.assertSearchGeneration(searchGeneration);
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
          supersededCount: runtime.rankTelemetry.supersededCount,
          fallbackCount: runtime.rankTelemetry.fallbackCount,
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

    const selector = buildItemQuerySelector(allowedSpaceIds, filters);

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
      const lexicalAbortController = runtime.startLexicalSearchPhase(searchGeneration);
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
        const initialSearch = await runtime.withTimeout(
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
            await runtime.withTimeout(
              forEachIdKeysetPage({
                collection: db.items,
                selector,
                pageSize: SCOPED_CANDIDATE_PAGE_SIZE,
                signal: lexicalAbortController.signal,
                onPage: (scopedDocs) => {
                  for (const doc of scopedDocs) {
                    const candidate = runtime.toCandidateLite(doc);
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
          const scopedSearch = await runtime.withTimeout(
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
        runtime.finishLexicalSearchPhase(searchGeneration, lexicalAbortController);
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
      const fieldSortBy = sortBy;
      const offset = Math.max(0, (page - 1) * limit);
      const selectorStartedAt = now();
      const pageDocsWithLookahead = await db.items
        .find({
          selector,
          sort: [{ [fieldSortBy]: sortOrder }],
          skip: offset,
          limit: limit + 1,
        })
        .exec();
      selectorMs = now() - selectorStartedAt;
      const hydrateStartedAt = now();
      const pageResult = splitLookaheadPage(pageDocsWithLookahead, limit, offset);
      const pageDocs = pageResult.items;
      const items = pageDocs.map((doc) => doc.toMutableJSON());
      hydrateMs = now() - hydrateStartedAt;
      const lastItem = items[items.length - 1];
      runtime.assertSearchGeneration(searchGeneration);
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
          supersededCount: runtime.rankTelemetry.supersededCount,
          fallbackCount: runtime.rankTelemetry.fallbackCount,
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
        collection: db.items,
        selector,
        pageSize: SCOPED_CANDIDATE_PAGE_SIZE,
        signal: searchSignal,
        onPage: (docs) => {
          for (const doc of docs) {
            const candidate = runtime.toCandidateLite(doc);
            if (!candidate.id) continue;
            candidates.push(candidate);
          }
        },
      });
    }
    selectorMs += now() - selectorStartedAt;

    const hydrateFromDocMap = async (itemIds: string[]): Promise<ItemDocType[]> => {
      if (itemIds.length === 0) return [];
      runtime.assertSearchGeneration(searchGeneration);
      // Hydrate only the requested ids (the final page or a sort page) instead
      // of reading from a retained full-document map.
      const byId = await db.items.findByIds(itemIds).exec();
      runtime.assertSearchGeneration(searchGeneration);
      const itemById = new Map<string, ItemDocType>();
      for (const id of itemIds) {
        const doc = byId.get(id);
        if (!doc) continue;
        itemById.set(id, doc.toMutableJSON());
      }
      return itemIds.flatMap((id) => {
        const item = itemById.get(id);
        return item ? [item] : [];
      });
    };

    const filterStartedAt = now();
    candidates = await applyItemQueryFilters(db, candidates, filters);
    filterMs = now() - filterStartedAt;

    if (candidates.length === 0) {
      runtime.assertSearchGeneration(searchGeneration);
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
          supersededCount: runtime.rankTelemetry.supersededCount,
          fallbackCount: runtime.rankTelemetry.fallbackCount,
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
        const vectorAbortController = runtime.startVectorSearchPhase(searchGeneration);
        const timeoutMessage = `Vector search timed out after ${VECTOR_SEARCH_TIMEOUT_MS}ms.`;
        try {
          const requestedTopK = Math.max(
            1,
            Math.min(
              vectorTopKLimit,
              candidateIndices.length
            )
          );
          const vectorSearch = await runtime.withTimeout(
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
          const vectorPrune = runtime.selectVectorResults(rawVectorResults, payload.minScore);
          vectorTopScore = Number.isFinite(vectorPrune.topScore) ? vectorPrune.topScore : null;
          vectorMinAcceptedScore = Number.isFinite(vectorPrune.minAcceptedScore)
            ? vectorPrune.minAcceptedScore
            : null;
          const prunedVectorResults = vectorPrune.pruned;
          vectorScoresByIndex = new Map(
            prunedVectorResults.map((result) => [result.index, result.score])
          );
          if (includeDebug) {
            const candidateByVectorIndex = new Map<number, CandidateLite>();
            for (const candidate of candidates) {
              for (const index of candidate.vectorIndexes) {
                candidateByVectorIndex.set(index, candidate);
              }
            }
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
          runtime.finishVectorSearchPhase(searchGeneration, vectorAbortController);
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
      const fieldSortBy = sortBy;
      candidates.sort((a, b) => runtime.compareByField(a, b, fieldSortBy, sortOrder));
      const total = candidates.length;
      let pageBase = candidates;
      if (afterCursor) {
        const cursor = afterCursor;
        pageBase = candidates.filter((entry) =>
          runtime.compareByField(
            entry,
            {
              id: cursor.id,
              title: cursor.title || "",
              source: cursor.source,
              createdAt: cursor.createdAt || 0,
              updatedAt: cursor.updatedAt || 0,
            },
            fieldSortBy,
            sortOrder,
          ) > 0,
        );
      }
      const offset = afterCursor ? 0 : Math.max(0, (page - 1) * limit);
      const pagedSlice = pageBase.slice(offset, offset + limit);
      const pagedIds = pagedSlice.map((entry) => entry.id);
      const hydrateStartedAt = now();
      const items = await hydrateFromDocMap(pagedIds);
      hydrateMs = now() - hydrateStartedAt;
      const hasMore = afterCursor ? pageBase.length > limit : offset + limit < total;
      const lastItem = pagedSlice.at(-1);
      const nextCursor: RankQueryCursor | null = hasMore && lastItem
        ? {
            queryHash,
            id: lastItem.id,
            relevance: 0,
            createdAt: lastItem.createdAt || 0,
            updatedAt: lastItem.updatedAt || 0,
            title: lastItem.title || "",
            source: lastItem.source,
          }
        : null;
      runtime.assertSearchGeneration(searchGeneration);
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
          supersededCount: runtime.rankTelemetry.supersededCount,
          fallbackCount: runtime.rankTelemetry.fallbackCount,
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
          assertActive: () => runtime.assertSearchGeneration(searchGeneration),
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
            let textDocs: ItemDocumentMap | null = null;
            if (needsTextForRanking && batch.length > 0) {
              const textHydrateStartedAt = now();
              runtime.assertSearchGeneration(searchGeneration);
              textDocs = await db.items.findByIds(batch.map((item) => item.id)).exec();
              runtime.assertSearchGeneration(searchGeneration);
              hydrateMs += now() - textHydrateStartedAt;
            }
            return batch.map((item) => {
              const doc = textDocs?.get(item.id);
              return runtime.toRankableItem(
                item,
                needsTextForRanking
                  ? doc?.get("textContent") || ""
                  : "",
                needsTextForRanking
                  ? doc?.get("ocrText") || ""
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
          runtime.rankTelemetry.supersededCount += 1;
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
        runtime.assertSearchGeneration(searchGeneration);
        const textDocs = await db.items.findByIds(itemsForRanking.map((item) => item.id)).exec();
        runtime.assertSearchGeneration(searchGeneration);
        for (const [id, doc] of textDocs) {
          rankingTextById.set(id, {
            textContent: doc.get("textContent") || "",
            ocrText: doc.get("ocrText") || "",
          });
        }
        hydrateMs += now() - textHydrateStartedAt;
      }
      const rankableItems = itemsForRanking.map((item) => {
        const text = rankingTextById.get(item.id);
        return runtime.toRankableItem(
          item,
          needsTextForRanking ? text?.textContent || "" : "",
          needsTextForRanking ? text?.ocrText || "" : ""
        );
      });
      rankRetainedPeakCount = rankableItems.length;
      rankHydrationBatchSize = rankableItems.length;

      const rankStartedAt = now();
      try {
        runtime.assertSearchGeneration(searchGeneration);
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
        }, runtime.getSearchClientId(searchGeneration), searchSignal);
        acceptRankResult(rankResult);
      } catch (error) {
        if (
          error instanceof SupersededRankRequestError ||
          error instanceof Error &&
          (error.message === RANK_REQUEST_SUPERSEDED || error.name === RANK_REQUEST_SUPERSEDED)
        ) {
          runtime.rankTelemetry.supersededCount += 1;
          throw error;
        }
        // Overload is intentionally not converted into main-thread ranking:
        // doing so would bypass the worker/queue caps precisely when many tabs
        // are already competing for memory and CPU.
        if (error instanceof RankWorkerCapacityError) {
          throw error;
        }
        console.warn("[ItemsController] Query rank worker failed, using local fallback.", error);
        runtime.rankTelemetry.fallbackCount += 1;
        acceptRankResult(runtime.rankLocally({
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

    runtime.assertSearchGeneration(searchGeneration);
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
        supersededCount: runtime.rankTelemetry.supersededCount,
        fallbackCount: runtime.rankTelemetry.fallbackCount,
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
                  candidateCount: new Set(
                    candidates.flatMap((item) => item.vectorIndexes).filter((index) => index >= 0),
                  ).size,
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
