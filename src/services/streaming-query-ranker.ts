import type {
  QueryRankDebugScore,
  QuerySortBy,
  QuerySortOrder,
  QueryTextExpression,
  RankableItem,
  RankQueryCursor,
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

const MS_PER_DAY = 24 * 60 * 60 * 1000;
const RECENCY_TIE_BREAK_WEIGHT = 0.45;

/** Keeps each RxDB text hydration comfortably below a multi-megabyte burst. */
export const STREAMING_RANK_HYDRATION_BATCH_SIZE = 250;
/** Above this, structured-cloning the whole rank input is no longer allowed. */
export const MAX_SINGLE_RANK_REQUEST_ITEMS = 1000;

export const shouldStreamRankCandidates = (candidateCount: number): boolean =>
  candidateCount > MAX_SINGLE_RANK_REQUEST_ITEMS;

type RankedItemIdentity = Pick<
  RankableItem,
  "id" | "title" | "source" | "createdAt" | "updatedAt"
>;

type RankedEntry = {
  item: RankedItemIdentity;
  relevance: number;
  hasLexicalHit: boolean;
  hasVectorHit: boolean;
  lexicalScore: number;
  vectorScore: number;
  lexicalRank?: number;
  vectorRank?: number;
};

export type StreamingRankOptions = {
  expression?: QueryTextExpression;
  groups: string[][];
  excludedTerms: string[];
  flatPositiveTerms: string[];
  hasTextConstraint: boolean;
  useLexical: boolean;
  useVector: boolean;
  queryHash: string;
  sortBy: QuerySortBy;
  sortOrder: QuerySortOrder;
  page: number;
  limit: number;
  afterCursor?: RankQueryCursor | null;
  lexicalScores: ReadonlyMap<string, number>;
  lexicalMatchTerms?: string[];
  lexicalMatchMasksById?: ReadonlyMap<string, number[]>;
  vectorScoresByIndex: ReadonlyMap<number, number>;
  includeDebug?: boolean;
  /** Fixed per request so a long batched query gets the same recency score throughout. */
  nowMs?: number;
};

export type StreamingRankStats = {
  inputCount: number;
  peakBatchInputCount: number;
  peakRetainedEntryCount: number;
  peakResidentRankItemCount: number;
};

export type StreamingRankResult = RankQueryWorkerResult & {
  stats: StreamingRankStats;
};

export type StreamRankCandidatesOptions<Candidate> = {
  candidates: readonly Candidate[];
  batchSize: number;
  rank: StreamingRankOptions;
  hydrateBatch: (candidates: readonly Candidate[]) => Promise<RankableItem[]>;
  assertActive?: () => void;
  /** Yield periodically so a large negative-expression scan remains cancellable. */
  yieldEveryBatches?: number;
};

const normalizeText = (input: string): string =>
  input
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase();

const getItemSearchText = (item: RankableItem): string => {
  const mediaText = (item.mediaTypes || []).join(" ");
  return normalizeText(
    [item.title, item.textContent, item.ocrText, item.url, item.source, item.authorUsername, mediaText]
      .filter(Boolean)
      .join(" ")
  );
};

const recencyBoost = (updatedAt: number, createdAt: number, now: number): number => {
  const reference = Math.max(updatedAt || 0, createdAt || 0);
  if (!reference) return 0;
  const ageDays = Math.max(0, (now - reference) / MS_PER_DAY);
  if (ageDays <= 3) return 0.06;
  if (ageDays >= 180) return 0;
  return (1 - ageDays / 180) * 0.06;
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
  if (groups.length === 0) return { matches: true, matchedTermCount: 0 };
  for (const group of groups) {
    if (group.every((term) => !!term && itemText.includes(normalizeText(term)))) {
      return { matches: true, matchedTermCount: group.length };
    }
  }
  return { matches: false, matchedTermCount: 0 };
};

const cursorEntry = (cursor: RankQueryCursor): RankedEntry => ({
  item: {
    id: cursor.id,
    title: cursor.title || "",
    source: cursor.source,
    createdAt: cursor.createdAt || 0,
    updatedAt: cursor.updatedAt || 0,
  },
  relevance: Number.isFinite(cursor.relevance) ? cursor.relevance : 0,
  hasLexicalHit: false,
  hasVectorHit: false,
  lexicalScore: 0,
  vectorScore: 0,
});

const toCursor = (entry: RankedEntry, queryHash: string): RankQueryCursor => ({
  queryHash,
  id: entry.item.id,
  relevance: entry.relevance,
  createdAt: entry.item.createdAt || 0,
  updatedAt: entry.item.updatedAt || 0,
  title: entry.item.title || "",
  source: entry.item.source,
});

/**
 * Incremental equivalent of the query-ranker worker. It retains only the
 * requested page window and lightweight rank keys, never every hydrated item.
 */
export class StreamingQueryRanker {
  private readonly compare: (a: RankedEntry, b: RankedEntry) => number;
  private readonly cursor: RankedEntry | null;
  private readonly offset: number;
  private readonly windowSize: number;
  private readonly heap: RankedEntry[] = [];
  private readonly nowMs: number;
  private readonly maxLexicalScore: number;
  private readonly lexicalTermBits: Map<string, { wordIndex: number; bit: number }>;
  private readonly lexicalRankById: Map<string, number> | null;
  private readonly vectorRankByIndex: Map<number, number> | null;
  private readonly allowsPositiveFreeTextMatch: boolean;
  private total = 0;
  private afterCursorTotal = 0;
  private vectorHits = 0;
  private lexicalHits = 0;
  private inputCount = 0;
  private peakBatchInputCount = 0;

  constructor(private readonly options: StreamingRankOptions) {
    this.compare = (a, b) =>
      compareRankedEntries(a, b, this.options.sortBy, this.options.sortOrder);
    const hasAfterCursor =
      !!options.afterCursor && options.afterCursor.queryHash === options.queryHash;
    this.cursor = hasAfterCursor ? cursorEntry(options.afterCursor as RankQueryCursor) : null;
    this.offset = hasAfterCursor ? 0 : Math.max(0, (options.page - 1) * options.limit);
    this.windowSize = hasAfterCursor ? options.limit : this.offset + options.limit;
    this.nowMs = options.nowMs ?? Date.now();
    this.allowsPositiveFreeTextMatch =
      options.hasTextConstraint &&
      !!options.expression &&
      expressionCanMatchWithoutPositiveTerm(options.expression);
    this.maxLexicalScore = (() => {
      let max = 0;
      for (const score of options.lexicalScores.values()) {
        if (score > max) max = score;
      }
      return max;
    })();
    this.lexicalTermBits = new Map(
      (options.lexicalMatchTerms || []).map((term, index) => [
        term,
        { wordIndex: Math.floor(index / 32), bit: 1 << (index % 32) },
      ])
    );
    this.lexicalRankById = options.includeDebug
      ? new Map(
          Array.from(options.lexicalScores.entries())
            .sort((a, b) => b[1] - a[1])
            .map(([id], index) => [id, index + 1])
        )
      : null;
    this.vectorRankByIndex = options.includeDebug
      ? new Map(
          Array.from(options.vectorScoresByIndex.entries())
            .sort((a, b) => b[1] - a[1])
            .map(([index], rank) => [index, rank + 1])
        )
      : null;
  }

  addBatch(items: readonly RankableItem[]): void {
    this.peakBatchInputCount = Math.max(this.peakBatchInputCount, items.length);
    for (const item of items) {
      this.inputCount += 1;
      const entry = this.rankItem(item);
      if (!entry) continue;

      this.total += 1;
      if (entry.hasVectorHit) this.vectorHits += 1;
      if (entry.hasLexicalHit) this.lexicalHits += 1;
      if (
        this.cursor &&
        !isRankedEntryAfterCursor(entry, this.cursor, this.compare)
      ) {
        continue;
      }

      this.afterCursorTotal += 1;
      this.retain(entry);
    }
  }

  finish(): StreamingRankResult {
    const hasAfterCursor = this.cursor !== null;
    const sortedWindow = [...this.heap].sort(this.compare);
    const paged = sortedWindow.slice(this.offset, this.offset + this.options.limit);
    const hasMore = hasAfterCursor
      ? this.afterCursorTotal > this.options.limit
      : this.offset + this.options.limit < this.total;
    const nextCursor =
      hasMore && paged.length > 0
        ? toCursor(paged[paged.length - 1], this.options.queryHash)
        : null;
    const debugScores: QueryRankDebugScore[] | undefined = this.options.includeDebug
      ? paged.map((entry, index) => ({
          itemId: entry.item.id,
          rank: hasAfterCursor ? index + 1 : this.offset + index + 1,
          lexicalScore: entry.lexicalScore,
          vectorScore: entry.vectorScore,
          fusedScore: entry.relevance,
          lexicalRank: entry.lexicalRank,
          vectorRank: entry.vectorRank,
          matchedLexical: entry.hasLexicalHit,
          matchedVector: entry.hasVectorHit,
        }))
      : undefined;

    return {
      itemIds: paged.map((entry) => entry.item.id),
      total: this.total,
      vectorHits: this.vectorHits,
      lexicalHits: this.lexicalHits,
      hasMore,
      nextCursor,
      debugScores,
      stats: {
        inputCount: this.inputCount,
        peakBatchInputCount: this.peakBatchInputCount,
        peakRetainedEntryCount: this.heap.length,
        peakResidentRankItemCount: this.peakBatchInputCount + this.heap.length,
      },
    };
  }

  private rankItem(item: RankableItem): RankedEntry | null {
    const hasPositiveTextTerms = this.options.flatPositiveTerms.length > 0;
    const needsTextEvaluation =
      this.options.hasTextConstraint ||
      (this.options.useLexical && this.options.lexicalScores.size === 0);
    let boolMatch = { matches: true, matchedTermCount: 0 };

    if (needsTextEvaluation) {
      const itemText = getItemSearchText(item);
      const matchWords = this.options.lexicalMatchMasksById?.get(item.id) || [];
      const lexicalTermMatched = (normalizedTerm: string) => {
        const position = this.lexicalTermBits.get(normalizedTerm);
        return !!position && ((matchWords[position.wordIndex] || 0) & position.bit) !== 0;
      };
      boolMatch = this.options.expression
        ? {
            matches: evaluateTextExpression(
              itemText,
              this.options.expression,
              lexicalTermMatched
            ),
            matchedTermCount: this.options.flatPositiveTerms.reduce(
              (count, term) =>
                textTermMatches(itemText, term, lexicalTermMatched) ? count + 1 : count,
              0
            ),
          }
        : matchesBooleanTerms(itemText, this.options.groups, this.options.excludedTerms);
    }

    const lexicalScore = this.options.useLexical
      ? this.options.lexicalScores.get(item.id) || 0
      : 0;
    const hasLexicalHit = this.options.useLexical
      ? hasPositiveTextTerms
        ? lexicalScore > 0 || boolMatch.matchedTermCount > 0
        : boolMatch.matches
      : false;
    const vectorHit = this.bestVectorHit(item);
    const hasVectorHit = vectorHit.hasHit;

    if (this.options.hasTextConstraint) {
      if (!boolMatch.matches) return null;
      if (this.allowsPositiveFreeTextMatch) {
        // A branch such as `NOT beta` is a complete Boolean match even when the
        // item has no positive lexical/vector signal.
      } else if (this.options.useVector && this.options.useLexical && hasPositiveTextTerms) {
        if (!hasVectorHit && !hasLexicalHit) return null;
      } else if (this.options.useVector && !this.options.useLexical && hasPositiveTextTerms) {
        if (!hasVectorHit) return null;
      } else if (this.options.useLexical && !hasLexicalHit) {
        return null;
      }
    }
    if (
      !this.allowsPositiveFreeTextMatch &&
      !shouldKeepHybridRankHit(
        { hasLexicalHit, hasVectorHit },
        {
          useLexical: this.options.useLexical,
          useVector: this.options.useVector,
          hasPositiveTextTerms,
        }
      )
    ) {
      return null;
    }

    const relevance =
      computeBaseRelevance({
        useLexical: this.options.useLexical,
        useVector: this.options.useVector,
        hasLexicalHit,
        hasVectorHit,
        vectorScore: vectorHit.score,
        lexicalScore,
        maxLexicalScore: this.maxLexicalScore,
        matchedTermCount: boolMatch.matchedTermCount,
        positiveTermCount: this.options.flatPositiveTerms.length,
      }) +
      recencyBoost(item.updatedAt || 0, item.createdAt || 0, this.nowMs) *
        RECENCY_TIE_BREAK_WEIGHT;

    return {
      item: {
        id: item.id,
        title: item.title,
        source: item.source,
        createdAt: item.createdAt,
        updatedAt: item.updatedAt,
      },
      relevance,
      hasLexicalHit,
      hasVectorHit,
      lexicalScore,
      vectorScore: vectorHit.score,
      lexicalRank: this.options.useLexical
        ? this.lexicalRankById?.get(item.id)
        : undefined,
      vectorRank: this.options.useVector ? vectorHit.rank : undefined,
    };
  }

  private bestVectorHit(item: RankableItem): { score: number; rank?: number; hasHit: boolean } {
    const fallback =
      typeof item.vector_index === "number" &&
      Number.isInteger(item.vector_index) &&
      item.vector_index >= 0
        ? item.vector_index
        : -1;
    const indexes = (item.vector_indexes || []).filter(
      (index): index is number => Number.isInteger(index) && index >= 0
    );
    if (indexes.length === 0 && fallback >= 0) indexes.push(fallback);

    let score = 0;
    let rank: number | undefined;
    let found = false;
    for (const index of new Set(indexes)) {
      if (!this.options.vectorScoresByIndex.has(index)) continue;
      const candidateScore = this.options.vectorScoresByIndex.get(index) || 0;
      if (!found || candidateScore > score) {
        score = candidateScore;
        rank = this.vectorRankByIndex?.get(index);
        found = true;
      }
    }
    return { score, rank, hasHit: found && score >= VECTOR_HIT_FLOOR };
  }

  private retain(entry: RankedEntry): void {
    if (this.windowSize <= 0) return;
    if (this.heap.length < this.windowSize) {
      this.heap.push(entry);
      this.bubbleUp(this.heap.length - 1);
      return;
    }
    if (this.compare(entry, this.heap[0]) < 0) {
      this.heap[0] = entry;
      this.bubbleDown(0);
    }
  }

  private bubbleUp(index: number): void {
    let current = index;
    while (current > 0) {
      const parent = Math.floor((current - 1) / 2);
      if (this.compare(this.heap[current], this.heap[parent]) <= 0) break;
      [this.heap[current], this.heap[parent]] = [this.heap[parent], this.heap[current]];
      current = parent;
    }
  }

  private bubbleDown(index: number): void {
    let current = index;
    while (true) {
      const left = current * 2 + 1;
      const right = left + 1;
      let worst = current;
      if (left < this.heap.length && this.compare(this.heap[left], this.heap[worst]) > 0) {
        worst = left;
      }
      if (right < this.heap.length && this.compare(this.heap[right], this.heap[worst]) > 0) {
        worst = right;
      }
      if (worst === current) break;
      [this.heap[current], this.heap[worst]] = [this.heap[worst], this.heap[current]];
      current = worst;
    }
  }
}

export const streamRankCandidates = async <Candidate>(
  options: StreamRankCandidatesOptions<Candidate>
): Promise<StreamingRankResult> => {
  const batchSize = Math.max(1, Math.floor(options.batchSize));
  const yieldEvery = Math.max(1, Math.floor(options.yieldEveryBatches || 4));
  const ranker = new StreamingQueryRanker(options.rank);
  let batchNumber = 0;

  for (let start = 0; start < options.candidates.length; start += batchSize) {
    options.assertActive?.();
    const candidates = options.candidates.slice(start, start + batchSize);
    const items = await options.hydrateBatch(candidates);
    options.assertActive?.();
    ranker.addBatch(items);
    batchNumber += 1;
    if (batchNumber % yieldEvery === 0 && start + batchSize < options.candidates.length) {
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
      options.assertActive?.();
    }
  }

  return ranker.finish();
};
