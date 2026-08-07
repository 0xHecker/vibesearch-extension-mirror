/// <reference lib="webworker" />
import type {
  QueryRankDebugScore,
  RankableItem,
  QueryTextExpression,
  RankQueryCursor,
  RankQueryWorkerRequest,
  RankQueryWorkerResponse,
  RankQueryWorkerResult,
} from "@src/search-core/contracts";
import {
  computeBaseRelevance,
  shouldKeepHybridRankHit,
  VECTOR_HIT_FLOOR,
} from "@src/search-core/hybrid-ranking";
import { normalizeSearchIndexText } from "@src/search-core/search-text";
import { expressionCanMatchWithoutPositiveTerm } from "@src/search-core/expression-analysis";
import {
  compareRankedEntries,
  isRankedEntryAfterCursor,
} from "@src/search-core/rank-order";

const normalizeText = (input: string): string =>
  input
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase();

const MS_PER_DAY = 24 * 60 * 60 * 1000;
const recencyBoost = (updatedAt: number, createdAt: number, now: number): number => {
  const reference = Math.max(updatedAt || 0, createdAt || 0);
  if (!reference) return 0;
  const ageDays = Math.max(0, (now - reference) / MS_PER_DAY);
  if (ageDays <= 3) return 0.06;
  if (ageDays >= 180) return 0;
  return (1 - ageDays / 180) * 0.06;
};

const getItemSearchText = (item: RankableItem): string => {
  const mediaText = (item.mediaTypes || []).join(" ");
  return normalizeText(
    [item.title, item.textContent, item.ocrText, item.url, item.source, item.authorUsername, mediaText]
      .filter(Boolean)
      .join(" ")
  );
};

const textTermMatches = (
  itemText: string,
  rawTerm: string,
  lexicalTermMatched?: (normalizedTerm: string) => boolean
): boolean => {
  const exactValue = normalizeText(rawTerm).trim();
  if (!exactValue) return false;
  if (itemText.includes(exactValue)) return true;
  return lexicalTermMatched?.(normalizeSearchIndexText(rawTerm)) === true;
};

const evaluateTextExpression = (
  itemText: string,
  node: QueryTextExpression,
  lexicalTermMatched?: (normalizedTerm: string) => boolean
): boolean => {
  if (node.type === "TERM") {
    if (!node.value?.trim()) return true;
    return textTermMatches(itemText, node.value, lexicalTermMatched);
  }

  if (node.type === "NOT") {
    return !evaluateTextExpression(itemText, node.child, lexicalTermMatched);
  }

  if (node.type === "AND") {
    return node.children.every((child) =>
      evaluateTextExpression(itemText, child, lexicalTermMatched)
    );
  }

  return node.children.some((child) =>
    evaluateTextExpression(itemText, child, lexicalTermMatched)
  );
};

const matchesBooleanTerms = (
  itemText: string,
  groups: string[][],
  excludedTerms: string[]
): { matches: boolean; matchedTermCount: number } => {
  for (const excluded of excludedTerms) {
    if (excluded && itemText.includes(normalizeText(excluded))) {
      return { matches: false, matchedTermCount: 0 };
    }
  }

  if (groups.length === 0) {
    return { matches: true, matchedTermCount: 0 };
  }

  for (const group of groups) {
    let groupMatch = true;
    for (const term of group) {
      if (!term || !itemText.includes(normalizeText(term))) {
        groupMatch = false;
        break;
      }
    }
    if (groupMatch) {
      return { matches: true, matchedTermCount: group.length };
    }
  }

  return { matches: false, matchedTermCount: 0 };
};

type RankedEntry = {
  item: RankableItem;
  boolMatch: { matches: boolean; matchedTermCount: number };
  hasLexicalHit: boolean;
  relevance: number;
  hasVectorHit: boolean;
  lexicalScore: number;
  vectorScore: number;
  lexicalRank?: number;
  vectorRank?: number;
};

const selectTopWindow = (
  entries: RankedEntry[],
  windowSize: number,
  compare: (a: RankedEntry, b: RankedEntry) => number
): RankedEntry[] => {
  if (windowSize >= entries.length) {
    return [...entries];
  }

  const heap: RankedEntry[] = [];

  const isWorse = (left: RankedEntry, right: RankedEntry): boolean => compare(left, right) > 0;
  const swap = (i: number, j: number) => {
    const tmp = heap[i];
    heap[i] = heap[j];
    heap[j] = tmp;
  };
  const bubbleUp = (index: number) => {
    let i = index;
    while (i > 0) {
      const parent = Math.floor((i - 1) / 2);
      if (!isWorse(heap[i], heap[parent])) break;
      swap(i, parent);
      i = parent;
    }
  };
  const bubbleDown = (index: number) => {
    let i = index;
    while (true) {
      const left = i * 2 + 1;
      const right = left + 1;
      let worst = i;

      if (left < heap.length && isWorse(heap[left], heap[worst])) {
        worst = left;
      }
      if (right < heap.length && isWorse(heap[right], heap[worst])) {
        worst = right;
      }
      if (worst === i) break;
      swap(i, worst);
      i = worst;
    }
  };

  for (const entry of entries) {
    if (heap.length < windowSize) {
      heap.push(entry);
      bubbleUp(heap.length - 1);
      continue;
    }

    if (compare(entry, heap[0]) < 0) {
      heap[0] = entry;
      bubbleDown(0);
    }
  }

  return heap;
};

const toCursor = (entry: RankedEntry, queryHash: string): RankQueryCursor => ({
  queryHash,
  id: entry.item.id,
  relevance: entry.relevance,
  createdAt: entry.item.createdAt || 0,
  updatedAt: entry.item.updatedAt || 0,
  title: entry.item.title || "",
  source: entry.item.source,
});

const fromCursor = (cursor: RankQueryCursor): RankedEntry => ({
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
  },
  boolMatch: { matches: true, matchedTermCount: 0 },
  hasLexicalHit: false,
  relevance: Number.isFinite(cursor.relevance) ? cursor.relevance : 0,
  hasVectorHit: false,
  lexicalScore: 0,
  vectorScore: 0,
  lexicalRank: undefined,
  vectorRank: undefined,
});

const rank = (request: RankQueryWorkerRequest): RankQueryWorkerResult => {
  const RECENCY_TIE_BREAK_WEIGHT = 0.45;
  const { payload } = request;
  const lexicalScores = new Map(payload.lexicalScores);
  const lexicalMatchMasksById = new Map(payload.lexicalMatchMasksById || []);
  const lexicalTermBits = new Map<string, { wordIndex: number; bit: number }>(
    (payload.lexicalMatchTerms || []).map((term, index) => [
      term,
      { wordIndex: Math.floor(index / 32), bit: 1 << (index % 32) },
    ])
  );
  const vectorScoresByIndex = new Map(payload.vectorScoresByIndex);
  const now = Date.now();

  const itemTextCache = new Map<string, string>();
  let maxLexicalScore = 0;
  for (const score of lexicalScores.values()) {
    if (score > maxLexicalScore) maxLexicalScore = score;
  }

  const hasPositiveTextTerms = payload.flatPositiveTerms.length > 0;
  const allowsPositiveFreeTextMatch =
    payload.hasTextConstraint &&
    !!payload.expression &&
    expressionCanMatchWithoutPositiveTerm(payload.expression);
  const hasLexicalScores = lexicalScores.size > 0;
  const needsTextEvaluation = payload.hasTextConstraint || (payload.useLexical && !hasLexicalScores);
  // Ranks are only used to populate the debug payload. Computing them sorts the
  // full lexical and vector score maps, so skip that work unless debug is on.
  const lexicalRankById = payload.includeDebug
    ? new Map<string, number>(
        Array.from(lexicalScores.entries())
          .sort((a, b) => b[1] - a[1])
          .map(([id], index) => [id, index + 1])
      )
    : null;
  const vectorRankByIndex = payload.includeDebug
    ? new Map<number, number>(
        Array.from(vectorScoresByIndex.entries())
          .sort((a, b) => b[1] - a[1])
          .map(([index], rank) => [index, rank + 1])
      )
    : null;
  const getVectorIndexes = (item: RankableItem): number[] => {
    const fallback =
      typeof item.vector_index === "number" && Number.isInteger(item.vector_index) && item.vector_index >= 0
        ? item.vector_index
        : -1;
    const indexes = Array.isArray(item.vector_indexes) ? item.vector_indexes : [];
    const normalized = indexes.filter((index): index is number => Number.isInteger(index) && index >= 0);
    if (normalized.length === 0 && fallback >= 0) normalized.push(fallback);
    return Array.from(new Set(normalized));
  };
  const getBestVectorHit = (item: RankableItem): { score: number; rank?: number; hasHit: boolean } => {
    let bestScore = 0;
    let bestRank: number | undefined;
    let found = false;
    for (const index of getVectorIndexes(item)) {
      if (!vectorScoresByIndex.has(index)) continue;
      const score = vectorScoresByIndex.get(index) || 0;
      if (!found || score > bestScore) {
        bestScore = score;
        bestRank = vectorRankByIndex?.get(index);
        found = true;
      }
    }
    // Treat near-orthogonal neighbours as misses so they neither rank on vector
    // signal nor pass the hybrid keep filter on vector alone.
    return { score: bestScore, rank: bestRank, hasHit: found && bestScore >= VECTOR_HIT_FLOOR };
  };

  const ranked: RankedEntry[] = payload.items.map((item) => {
    let itemText = "";
    let boolMatch: { matches: boolean; matchedTermCount: number } = {
      matches: true,
      matchedTermCount: 0,
    };

    if (needsTextEvaluation) {
      itemText = itemTextCache.get(item.id) || getItemSearchText(item);
      itemTextCache.set(item.id, itemText);
      const lexicalMatchWords = lexicalMatchMasksById.get(item.id) || [];
      const lexicalTermMatched = (normalizedTerm: string) => {
        const termPosition = lexicalTermBits.get(normalizedTerm);
        return !!termPosition &&
          ((lexicalMatchWords[termPosition.wordIndex] || 0) & termPosition.bit) !== 0;
      };

      boolMatch = payload.expression
        ? {
            matches: evaluateTextExpression(
              itemText,
              payload.expression,
              lexicalTermMatched
            ),
            matchedTermCount: payload.flatPositiveTerms.reduce((count, term) => {
              return textTermMatches(itemText, term, lexicalTermMatched)
                ? count + 1
                : count;
            }, 0),
          }
        : matchesBooleanTerms(itemText, payload.groups, payload.excludedTerms);
    }

    const lexicalScore = payload.useLexical ? lexicalScores.get(item.id) || 0 : 0;
    const hasLexicalHit = payload.useLexical
      ? hasPositiveTextTerms
        ? lexicalScore > 0 || boolMatch.matchedTermCount > 0
        : boolMatch.matches
      : false;

    const vectorHit = getBestVectorHit(item);
    const vectorScore = vectorHit.score;
    const hasVectorHit = vectorHit.hasHit;
    const lexicalRank = payload.useLexical ? lexicalRankById?.get(item.id) : undefined;
    const vectorRank = payload.useVector ? vectorHit.rank : undefined;

    const baseRelevance = computeBaseRelevance({
      useLexical: payload.useLexical,
      useVector: payload.useVector,
      hasLexicalHit,
      hasVectorHit,
      vectorScore,
      lexicalScore,
      maxLexicalScore,
      matchedTermCount: boolMatch.matchedTermCount,
      positiveTermCount: payload.flatPositiveTerms.length,
    });
    const relevance =
      baseRelevance +
      recencyBoost(item.updatedAt || 0, item.createdAt || 0, now) * RECENCY_TIE_BREAK_WEIGHT;

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
  if (payload.hasTextConstraint) {
    filtered = ranked.filter((entry) => {
      if (!entry.boolMatch.matches) return false;
      if (allowsPositiveFreeTextMatch) return true;
      if (payload.useVector && payload.useLexical) {
        if (hasPositiveTextTerms) {
          return entry.hasVectorHit || entry.hasLexicalHit;
        }
        return true;
      }
      if (payload.useVector && !payload.useLexical) {
        return hasPositiveTextTerms ? entry.hasVectorHit : true;
      }
      if (payload.useLexical) {
        return entry.hasLexicalHit;
      }
      return true;
    });
  }
  filtered = filtered.filter((entry) =>
    allowsPositiveFreeTextMatch && entry.boolMatch.matches
      ? true
      : shouldKeepHybridRankHit(entry, {
          useLexical: payload.useLexical,
          useVector: payload.useVector,
          hasPositiveTextTerms,
        })
  );

  let vectorHits = 0;
  let lexicalHits = 0;
  for (const entry of filtered) {
    if (entry.hasVectorHit) vectorHits += 1;
    if (entry.hasLexicalHit) lexicalHits += 1;
  }

  const total = filtered.length;
  const compare = (a: RankedEntry, b: RankedEntry) =>
    compareRankedEntries(a, b, payload.sortBy, payload.sortOrder);

  const hasAfterCursor = !!payload.afterCursor && payload.afterCursor?.queryHash === payload.queryHash;
  const pageBase = hasAfterCursor
    ? (() => {
        const cursorEntry = fromCursor(payload.afterCursor as RankQueryCursor);
        return filtered.filter((entry) =>
          isRankedEntryAfterCursor(entry, cursorEntry, compare)
        );
      })()
    : filtered;
  const pageBaseTotal = pageBase.length;
  const offset = hasAfterCursor ? 0 : Math.max(0, (payload.page - 1) * payload.limit);
  const windowSize = hasAfterCursor
    ? Math.min(pageBaseTotal, payload.limit)
    : Math.min(pageBaseTotal, offset + payload.limit);

  let sortedWindow: RankedEntry[] = [];
  if (windowSize > 0) {
    if (windowSize < pageBaseTotal) {
      sortedWindow = selectTopWindow(pageBase, windowSize, compare);
    } else {
      sortedWindow = [...pageBase];
    }
    sortedWindow.sort(compare);
  }

  const paged = sortedWindow.slice(offset, offset + payload.limit);
  const hasMore = hasAfterCursor
    ? pageBaseTotal > payload.limit
    : offset + payload.limit < total;
  const nextCursor =
    hasMore && paged.length > 0 ? toCursor(paged[paged.length - 1], payload.queryHash) : null;
  const debugScores: QueryRankDebugScore[] | undefined =
    payload.includeDebug === true
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
};

self.onmessage = (event: MessageEvent<RankQueryWorkerRequest>) => {
  const message = event.data;
  if (!message || message.type !== "RANK_QUERY") {
    return;
  }

  const payload = rank(message);
  const response: RankQueryWorkerResponse = {
    type: "RANK_QUERY_RESULT",
    requestId: message.requestId,
    payload,
  };
  self.postMessage(response);
};

export {};
