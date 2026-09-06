import { PUBLIC_SPACE_ID } from "@src/common/spaces";
import type { ItemDocType } from "@src/schemas/item_schema";
import type {
  QueryDebugPayload,
  QueryTextExpression,
  RankQueryCursor,
  RankableItem,
} from "@src/search-core/contracts";
import { expressionCanMatchWithoutPositiveTerm } from "@src/search-core/expression-analysis";
import {
  computeBaseRelevance,
  shouldKeepHybridRankHit,
  VECTOR_HIT_FLOOR,
} from "@src/search-core/hybrid-ranking";
import {
  compareRankedEntries,
  compareRankField,
  isRankedEntryAfterCursor,
} from "@src/search-core/rank-order";
import { normalizeSearchIndexText } from "@src/search-core/search-text";
import type { MyDatabase } from "@src/services/DatabaseService";
import { parseHttpHostname } from "@src/services/items/access";
import {
  MAX_RANK_TEXT_CHARS,
  MS_PER_DAY,
  type CandidateLite,
  type LocalQueryFilters,
  type LocalQueryPayload,
  type LocalQuerySortBy,
  type LocalQuerySortOrder,
  type RankedLiteEntry,
  type VectorScoreResult,
} from "@src/services/items/search-model";
export type CandidateDocument = {
  get<Key extends keyof ItemDocType>(key: Key): ItemDocType[Key];
};

export type QueryHashInput = {
  query: string;
  expression?: QueryTextExpression;
  groups: string[][];
  excludedTerms: string[];
  filters: LocalQueryFilters;
  accessContext?: LocalQueryPayload["accessContext"];
  sortBy: LocalQuerySortBy;
  sortOrder: LocalQuerySortOrder;
  useKeyword: boolean;
  useVector: boolean;
  useFuzzy: boolean;
};

export type BooleanTermMatch = {
  matches: boolean;
  matchedTermCount: number;
};

export type VectorSelection = {
  pruned: VectorScoreResult[];
  topScore: number;
  minAcceptedScore: number;
};

export type RankLocallyArgs = {
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
};

export type RankLocallyResult = {
  itemIds: string[];
  total: number;
  vectorHits: number;
  lexicalHits: number;
  hasMore: boolean;
  nextCursor?: RankQueryCursor | null;
  debugScores?: QueryDebugPayload["perItem"];
};

type VectorHit = {
  score: number;
  rank?: number;
  hasHit: boolean;
};

type TermBit = {
  wordIndex: number;
  bit: number;
};

type RankedSearchItem = {
  item: RankableItem;
  boolMatch: BooleanTermMatch;
  hasLexicalHit: boolean;
  relevance: number;
  hasVectorHit: boolean;
  lexicalScore: number;
  vectorScore: number;
  lexicalRank?: number;
  vectorRank?: number;
};

type RankedComparable = Pick<RankedSearchItem, "item" | "relevance">;

export class ItemSearchRanker {
  tokenizeQuery(query: string): string[] {
    return query.split(/\s+/).map((part) => part.trim()).filter(Boolean);
  }

  resolveVectorQueryText(payload: LocalQueryPayload): string {
    const query = (payload.query || "").trim();
    const expressionTerms = payload.text?.expression
      ? this.collectPositiveExpressionTerms(payload.text.expression)
      : [];
    const groupedTerms = (payload.text?.groups || [])
      .flat()
      .map((term) => term.trim())
      .filter(Boolean);
    let positiveTerms = this.tokenizeQuery(query);
    if (groupedTerms.length > 0) positiveTerms = groupedTerms;
    if (expressionTerms.length > 0) positiveTerms = expressionTerms;
    return Array.from(new Set(positiveTerms)).join(" ") || query;
  }

  normalizeText(input: string): string {
    return input.normalize("NFKD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
  }

  private stableHash(input: string): string {
    let hash = 2_166_136_261;
    for (let index = 0; index < input.length; index += 1) {
      hash ^= input.charCodeAt(index);
      hash = Math.imul(hash, 16_777_619);
    }
    return (hash >>> 0).toString(36);
  }

  buildQueryHash(payload: QueryHashInput): string {
    return this.stableHash(JSON.stringify({
      query: payload.query,
      expression: payload.expression || null,
      groups: payload.groups,
      excludedTerms: payload.excludedTerms,
      filters: payload.filters,
      accessContext: payload.accessContext || {},
      sortBy: payload.sortBy,
      sortOrder: payload.sortOrder,
      useKeyword: payload.useKeyword,
      useVector: payload.useVector,
      useFuzzy: payload.useFuzzy,
    }));
  }

  private getItemSearchText(item: ItemDocType | RankableItem): string {
    const mediaText = "mediaTypes" in item
      ? item.mediaTypes.join(" ")
      : (item.media || []).map((entry) => entry.type).join(" ");
    return this.normalizeText([
      item.title,
      item.textContent,
      item.ocrText,
      item.url,
      item.source,
      item.authorUsername,
      mediaText,
    ].filter(Boolean).join(" "));
  }

  private recencyBoost(updatedAt: number, createdAt: number, now: number): number {
    const reference = Math.max(updatedAt || 0, createdAt || 0);
    if (!reference) return 0;
    const ageDays = Math.max(0, (now - reference) / MS_PER_DAY);
    if (ageDays <= 3) return 0.06;
    if (ageDays >= 180) return 0;
    return (1 - ageDays / 180) * 0.06;
  }

  toRankableItem(item: CandidateLite, textContent: string, ocrText: string): RankableItem {
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

  sanitizeVectorIndexes(raw: ItemDocType["vector_indexes"], fallback: number): number[] {
    const indexes = raw || [];
    const normalized = indexes.filter(
      (index) => Number.isInteger(index) && index >= 0,
    );
    if (normalized.length === 0 && fallback >= 0) normalized.push(fallback);
    return Array.from(new Set(normalized));
  }

  toCandidateLite(document: CandidateDocument): CandidateLite {
    const media = document.get("media") || [];
    const mediaTypes = Array.from(new Set(media.flatMap((entry) => {
      return entry.type === "image" || entry.type === "video" ? [entry.type] : [];
    })));
    const url = document.get("url") || "";
    const hasCurrentEmbedding =
      document.get("isEmbedded") === true && document.get("isDirty") !== true;
    const storedVectorIndex = document.get("vector_index");
    const vectorIndex = hasCurrentEmbedding &&
      storedVectorIndex !== undefined &&
      Number.isInteger(storedVectorIndex) &&
      storedVectorIndex >= 0
      ? storedVectorIndex
      : -1;
    const vectorIndexes = hasCurrentEmbedding
      ? this.sanitizeVectorIndexes(document.get("vector_indexes"), vectorIndex)
      : [];

    return {
      id: document.get("id") || "",
      spaceId: document.get("spaceId") || PUBLIC_SPACE_ID,
      folderId: document.get("folderId") || "",
      source: document.get("source") || "web",
      isFavorite: document.get("isFavorite") === true,
      authorUsername: (document.get("authorUsername") || "").toLowerCase(),
      url,
      domain: parseHttpHostname(url),
      mediaTypes,
      hasMedia: media.length > 0,
      hasEmbed: media.some((entry) => entry.embedType === "iframe" || Boolean(entry.embedUrl)),
      vectorIndex,
      vectorIndexes,
      title: document.get("title") || "",
      createdAt: document.get("createdAt") || 0,
      updatedAt: document.get("updatedAt") || 0,
    };
  }

  async hydrateItemsByIds(db: MyDatabase, itemIds: string[]): Promise<ItemDocType[]> {
    if (itemIds.length === 0) return [];
    const documents = await db.items.findByIds(itemIds).exec();
    return itemIds.flatMap((itemId) => {
      const document = documents.get(itemId);
      return document ? [document.toMutableJSON()] : [];
    });
  }

  private matchesBooleanTerms(
    itemText: string,
    groups: string[][],
    excludedTerms: string[],
  ): BooleanTermMatch {
    for (const excluded of excludedTerms) {
      if (excluded && itemText.includes(this.normalizeText(excluded))) {
        return { matches: false, matchedTermCount: 0 };
      }
    }
    if (groups.length === 0) return { matches: true, matchedTermCount: 0 };
    for (const group of groups) {
      const matches = group.every(
        (term) => Boolean(term) && itemText.includes(this.normalizeText(term)),
      );
      if (matches) return { matches: true, matchedTermCount: group.length };
    }
    return { matches: false, matchedTermCount: 0 };
  }

  private textTermMatches(
    itemText: string,
    rawTerm: string,
    lexicalTermMatched?: (normalizedTerm: string) => boolean,
  ): boolean {
    const exactValue = this.normalizeText(rawTerm).trim();
    if (!exactValue) return false;
    if (itemText.includes(exactValue)) return true;
    return lexicalTermMatched?.(normalizeSearchIndexText(rawTerm)) === true;
  }

  private evaluateTextExpression(
    itemText: string,
    node: QueryTextExpression,
    lexicalTermMatched?: (normalizedTerm: string) => boolean,
  ): boolean {
    if (node.type === "TERM") {
      if (!node.value.trim()) return true;
      return this.textTermMatches(itemText, node.value, lexicalTermMatched);
    }
    if (node.type === "NOT") {
      return !this.evaluateTextExpression(itemText, node.child, lexicalTermMatched);
    }
    if (node.type === "AND") {
      return node.children.every((child) =>
        this.evaluateTextExpression(itemText, child, lexicalTermMatched),
      );
    }
    return node.children.some((child) =>
      this.evaluateTextExpression(itemText, child, lexicalTermMatched),
    );
  }

  collectPositiveExpressionTerms(
    node: QueryTextExpression,
    isNegated = false,
    result: string[] = [],
  ): string[] {
    if (node.type === "TERM") {
      if (!isNegated && node.value.trim()) result.push(node.value.trim());
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

  selectVectorResults(results: VectorScoreResult[], minScore?: number): VectorSelection {
    const threshold = minScore !== undefined && Number.isFinite(minScore) ? minScore : null;
    const filtered = threshold === null
      ? results
      : results.filter((result) => result.score >= threshold);
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
      minAcceptedScore: filtered.at(-1)?.score ?? Number.POSITIVE_INFINITY,
    };
  }

  private bestVectorHit(
    item: RankableItem,
    scoresByIndex: ReadonlyMap<number, number>,
    rankByIndex: ReadonlyMap<number, number> | null,
  ): VectorHit {
    const fallback = item.vector_index !== undefined && Number.isInteger(item.vector_index)
      ? item.vector_index
      : -1;
    const indexes = this.sanitizeVectorIndexes(item.vector_indexes, fallback);
    let score = 0;
    let rank: number | undefined;
    let found = false;
    for (const index of indexes) {
      const candidateScore = scoresByIndex.get(index);
      if (candidateScore === undefined) continue;
      if (!found || candidateScore > score) {
        score = candidateScore;
        rank = rankByIndex?.get(index);
        found = true;
      }
    }
    return { score, rank, hasHit: found && score >= VECTOR_HIT_FLOOR };
  }

  private rankItems(args: RankLocallyArgs): RankedSearchItem[] {
    const hasPositiveTextTerms = args.flatPositiveTerms.length > 0;
    const allowsPositiveFreeTextMatch = args.hasTextConstraint && args.expression
      ? expressionCanMatchWithoutPositiveTerm(args.expression)
      : false;
    const needsTextEvaluation = args.hasTextConstraint ||
      (args.useLexical && args.lexicalScores.size === 0);
    const lexicalTermBits = new Map<string, TermBit>(
      (args.lexicalMatchTerms || []).map((term, index) => [
        term,
        { wordIndex: Math.floor(index / 32), bit: 1 << (index % 32) },
      ]),
    );
    const textByItemId = new Map<string, string>();
    const maxLexicalScore = Math.max(0, ...args.lexicalScores.values());
    const lexicalRankById = args.includeDebug
      ? new Map(
          [...args.lexicalScores.entries()]
            .sort((left, right) => right[1] - left[1])
            .map(([id], index) => [id, index + 1]),
        )
      : null;
    const vectorRankByIndex = args.includeDebug
      ? new Map(
          [...args.vectorScoresByIndex.entries()]
            .sort((left, right) => right[1] - left[1])
            .map(([index], rank) => [index, rank + 1]),
        )
      : null;
    const now = Date.now();

    return args.items.map((item) => {
      let itemText = "";
      let boolMatch: BooleanTermMatch = { matches: true, matchedTermCount: 0 };
      if (needsTextEvaluation) {
        itemText = textByItemId.get(item.id) || this.getItemSearchText(item);
        textByItemId.set(item.id, itemText);
        const matchWords = args.lexicalMatchMasksById?.get(item.id) || [];
        const lexicalTermMatched = (normalizedTerm: string): boolean => {
          const position = lexicalTermBits.get(normalizedTerm);
          if (!position) return false;
          return ((matchWords[position.wordIndex] || 0) & position.bit) !== 0;
        };
        if (args.expression) {
          boolMatch = {
            matches: this.evaluateTextExpression(itemText, args.expression, lexicalTermMatched),
            matchedTermCount: args.flatPositiveTerms.reduce((count, term) => {
              return this.textTermMatches(itemText, term, lexicalTermMatched)
                ? count + 1
                : count;
            }, 0),
          };
        } else {
          boolMatch = this.matchesBooleanTerms(itemText, args.groups, args.excludedTerms);
        }
      }

      const lexicalScore = args.useLexical ? args.lexicalScores.get(item.id) || 0 : 0;
      let hasLexicalHit = false;
      if (args.useLexical) {
        hasLexicalHit = hasPositiveTextTerms
          ? lexicalScore > 0 || boolMatch.matchedTermCount > 0
          : boolMatch.matches;
      }
      const vectorHit = this.bestVectorHit(
        item,
        args.vectorScoresByIndex,
        vectorRankByIndex,
      );
      const baseRelevance = computeBaseRelevance({
        useLexical: args.useLexical,
        useVector: args.useVector,
        hasLexicalHit,
        hasVectorHit: vectorHit.hasHit,
        vectorScore: vectorHit.score,
        lexicalScore,
        maxLexicalScore,
        matchedTermCount: boolMatch.matchedTermCount,
        positiveTermCount: args.flatPositiveTerms.length,
      });
      const recency = this.recencyBoost(item.updatedAt, item.createdAt, now) * 0.45;
      return {
        item,
        boolMatch,
        hasLexicalHit,
        relevance: baseRelevance + recency,
        hasVectorHit: vectorHit.hasHit,
        lexicalScore,
        vectorScore: vectorHit.score,
        lexicalRank: args.useLexical ? lexicalRankById?.get(item.id) : undefined,
        vectorRank: args.useVector ? vectorHit.rank : undefined,
      };
    }).filter((entry) => {
      if (args.hasTextConstraint && !entry.boolMatch.matches) return false;
      if (allowsPositiveFreeTextMatch && entry.boolMatch.matches) return true;
      if (args.hasTextConstraint) {
        if (args.useVector && args.useLexical && hasPositiveTextTerms) {
          return entry.hasVectorHit || entry.hasLexicalHit;
        }
        if (args.useVector && !args.useLexical && hasPositiveTextTerms) {
          return entry.hasVectorHit;
        }
        if (args.useLexical && !entry.hasLexicalHit) return false;
      }
      return shouldKeepHybridRankHit(entry, {
        useLexical: args.useLexical,
        useVector: args.useVector,
        hasPositiveTextTerms,
      });
    });
  }

  rankLocally(args: RankLocallyArgs): RankLocallyResult {
    const ranked = this.rankItems(args);
    const compareEntries = (left: RankedComparable, right: RankedComparable): number =>
      compareRankedEntries(left, right, args.sortBy, args.sortOrder);
    ranked.sort(compareEntries);

    const cursor = args.afterCursor?.queryHash === args.queryHash
      ? args.afterCursor
      : null;
    let pageBase = ranked;
    if (cursor) {
      const cursorItem: RankableItem = {
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
      };
      const cursorEntry: RankedComparable = {
        item: cursorItem,
        relevance: Number.isFinite(cursor.relevance) ? cursor.relevance : 0,
      };
      pageBase = ranked.filter((entry) =>
        isRankedEntryAfterCursor(entry, cursorEntry, compareEntries),
      );
    }

    const offset = cursor ? 0 : Math.max(0, (args.page - 1) * args.limit);
    const page = pageBase.slice(offset, offset + args.limit);
    const hasMore = cursor
      ? pageBase.length > args.limit
      : offset + args.limit < ranked.length;
    const last = page.at(-1);
    const nextCursor = hasMore && last
      ? this.toRankCursor({ item: last.item, relevance: last.relevance }, args.queryHash)
      : null;
    let vectorHits = 0;
    let lexicalHits = 0;
    for (const entry of ranked) {
      if (entry.hasVectorHit) vectorHits += 1;
      if (entry.hasLexicalHit) lexicalHits += 1;
    }
    const debugScores = args.includeDebug
      ? page.map((entry, index) => ({
          itemId: entry.item.id,
          rank: cursor ? index + 1 : offset + index + 1,
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
      itemIds: page.map((entry) => entry.item.id),
      total: ranked.length,
      vectorHits,
      lexicalHits,
      hasMore,
      nextCursor,
      debugScores,
    };
  }

  compareByField(
    left: Pick<RankableItem, "id" | "title" | "source" | "createdAt" | "updatedAt">,
    right: Pick<RankableItem, "id" | "title" | "source" | "createdAt" | "updatedAt">,
    sortBy: Exclude<LocalQuerySortBy, "relevance">,
    sortOrder: LocalQuerySortOrder,
  ): number {
    const comparison = compareRankField(left, right, sortBy, sortOrder);
    return comparison || left.id.localeCompare(right.id);
  }
}
