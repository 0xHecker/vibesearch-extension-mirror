import type { ItemDocType } from "@src/schemas/item_schema";

export const QUERY_MODE_COMPONENTS = ["keyword", "fuzzy", "vector"] as const;
export type QueryModeComponent = (typeof QUERY_MODE_COMPONENTS)[number];

export const QUERY_MODES = [
  "keyword",
  "fuzzy",
  "vector",
  "keyword+fuzzy",
  "keyword+vector",
  "fuzzy+vector",
  "keyword+fuzzy+vector",
] as const;
export type QueryMode = (typeof QUERY_MODES)[number];

export type QueryModeFeatures = {
  keyword: boolean;
  fuzzy: boolean;
  vector: boolean;
};

type QueryModeDefinition = QueryModeFeatures & {
  description: string;
};

export const QUERY_MODE_DEFINITIONS: Record<QueryMode, QueryModeDefinition> = {
  keyword: {
    keyword: true,
    fuzzy: false,
    vector: false,
    description: "Exact keyword search with field weighting.",
  },
  fuzzy: {
    keyword: false,
    fuzzy: true,
    vector: false,
    description: "Fuzzy-only lexical search (typo/prefix/phonetic).",
  },
  vector: {
    keyword: false,
    fuzzy: false,
    vector: true,
    description: "Semantic vector search only.",
  },
  "keyword+fuzzy": {
    keyword: true,
    fuzzy: true,
    vector: false,
    description: "Keyword plus fuzzy lexical search.",
  },
  "keyword+vector": {
    keyword: true,
    fuzzy: false,
    vector: true,
    description: "Keyword plus vector semantic search.",
  },
  "fuzzy+vector": {
    keyword: false,
    fuzzy: true,
    vector: true,
    description: "Fuzzy lexical plus vector semantic search.",
  },
  "keyword+fuzzy+vector": {
    keyword: true,
    fuzzy: true,
    vector: true,
    description: "Keyword, fuzzy, and vector search combined.",
  },
};

const QUERY_MODE_SET: Set<QueryMode> = new Set(QUERY_MODES);
const QUERY_MODE_COMPONENT_SET: Set<QueryModeComponent> = new Set(QUERY_MODE_COMPONENTS);
const QUERY_MODE_ALIASES: Record<string, QueryMode> = {
  hybrid: "keyword+vector",
  lexical: "keyword",
  semantic: "vector",
  all: "keyword+fuzzy+vector",
};

const addModeComponents = (mode: QueryMode, target: Set<QueryModeComponent>) => {
  const features = QUERY_MODE_DEFINITIONS[mode];
  if (features.keyword) target.add("keyword");
  if (features.fuzzy) target.add("fuzzy");
  if (features.vector) target.add("vector");
};

const composeQueryMode = (parts: Set<QueryModeComponent>): QueryMode => {
  const normalized = QUERY_MODE_COMPONENTS.filter((part) => parts.has(part)).join("+");
  if (QUERY_MODE_SET.has(normalized as QueryMode)) {
    return normalized as QueryMode;
  }
  return "keyword";
};

export const parseQueryMode = (raw: string): QueryMode | null => {
  const value = raw.trim().toLowerCase();
  if (!value) return null;

  if (QUERY_MODE_SET.has(value as QueryMode)) {
    return value as QueryMode;
  }

  const directAlias = QUERY_MODE_ALIASES[value];
  if (directAlias) {
    return directAlias;
  }

  const tokens = value.split(/[+,\s|/]+/).filter(Boolean);
  if (tokens.length === 0) return null;

  const parts = new Set<QueryModeComponent>();
  for (const token of tokens) {
    const alias = QUERY_MODE_ALIASES[token];
    if (alias) {
      addModeComponents(alias, parts);
      continue;
    }
    if (!QUERY_MODE_COMPONENT_SET.has(token as QueryModeComponent)) {
      return null;
    }
    parts.add(token as QueryModeComponent);
  }

  if (parts.size === 0) return null;
  return composeQueryMode(parts);
};

export const getQueryModeFeatures = (mode: QueryMode): QueryModeFeatures =>
  QUERY_MODE_DEFINITIONS[mode];

/**
 * Resolve requested channels for a concrete query. Semantic embedding has a
 * minimum useful input length; a vector-only query below that threshold must
 * fall back to exact lexical matching instead of becoming an unconstrained
 * browse request with every channel disabled.
 */
export const resolveEffectiveQueryChannels = (input: {
  requested: QueryModeFeatures;
  query: string;
  vectorMinChars: number;
}): QueryModeFeatures => {
  const queryLength = input.query.trim().length;
  const vector = input.requested.vector && queryLength >= input.vectorMinChars;
  const fuzzy = input.requested.fuzzy;
  const needsKeywordFallback =
    queryLength > 0 && !input.requested.keyword && !fuzzy && !vector;

  return {
    keyword: input.requested.keyword || needsKeywordFallback,
    fuzzy,
    vector,
  };
};

export type QueryScope = "current" | "global" | "private" | "public";
export type QuerySortBy = "relevance" | "createdAt" | "updatedAt" | "title" | "source";
export type QuerySortOrder = "asc" | "desc";

export type QueryTextExpression =
  | {
      type: "TERM";
      value: string;
    }
  | {
      type: "NOT";
      child: QueryTextExpression;
    }
  | {
      type: "AND" | "OR";
      children: QueryTextExpression[];
    };

export type QueryPillKind = "filter" | "directive";

export type QueryField =
  | "space"
  | "source"
  | "site"
  | "domain"
  | "tag"
  | "folder"
  | "author"
  | "is"
  | "has"
  | "date"
  | "added"
  | "created"
  | "updated"
  | "likes"
  | "upvotes"
  | "sort"
  | "scope"
  | "mode"
  | "limit"
  | "page"
  | "minscore"
  | "score";

export type QueryPill = {
  id: string;
  kind: QueryPillKind;
  field: QueryField;
  value: string;
  label: string;
  raw: string;
  negated: boolean;
  start: number;
  end: number;
};

export type QuerySuggestionCategory =
  | "Refine"
  | "Sort"
  | "Modes"
  | "Recent"
  | "Helpers"
  | "Sources"
  | "Spaces"
  | "Folders"
  | "Tags"
  | "Domains"
  | "Dates";

export type QuerySuggestion = {
  id: string;
  category: QuerySuggestionCategory;
  label: string;
  description?: string;
  insertText: string;
  start: number;
  end: number;
};

export type QueryFilters = {
  spaceIds: string[];
  excludeSpaceIds: string[];
  sources: ItemDocType["source"][];
  excludeSources: ItemDocType["source"][];
  folderIds: string[];
  excludeFolderIds: string[];
  tagNames: string[];
  excludeTagNames: string[];
  domains: string[];
  excludeDomains: string[];
  authors: string[];
  excludeAuthors: string[];
  hasAny: Array<"image" | "video" | "media" | "embed">;
  excludeHasAny: Array<"image" | "video" | "media" | "embed">;
  favoritesOnly: boolean;
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

export type QueryDirectives = {
  mode?: QueryMode;
  scope?: QueryScope;
  sortBy?: QuerySortBy;
  sortOrder?: QuerySortOrder;
  limit?: number;
  page?: number;
  /** Vector similarity cutoff (0–1); results scoring below are dropped. */
  minScore?: number;
};

export type QueryToken = {
  text: string;
  normalized: string;
  start: number;
  end: number;
};

export type QueryAnalysis = {
  requestId: number;
  input: string;
  freeText: string;
  textGroups: string[][];
  excludedTerms: string[];
  textExpression?: QueryTextExpression;
  tokens: QueryToken[];
  pills: QueryPill[];
  filters: QueryFilters;
  directives: QueryDirectives;
  activeTokenStart: number;
  activeTokenEnd: number;
  activeTokenText: string;
  shouldOpenSuggestions: boolean;
  suggestions: QuerySuggestion[];
};

export type QueryAssistCatalogs = {
  sources: ItemDocType["source"][];
  spaces: Array<{ id: string; name: string; isPrivate?: boolean }>;
  folders: Array<{ id: string; name: string }>;
  tags: Array<{ id: string; name: string }>;
  domains: string[];
  authors: string[];
  recentQueries: string[];
};

export type SetQueryAssistCatalogsRequest = {
  type: "SET_CATALOGS";
  catalogs: QueryAssistCatalogs;
};

export type AnalyzeQueryRequest = {
  type: "ANALYZE_QUERY";
  requestId: number;
  input: string;
  cursor: number;
  forceSuggestions?: boolean;
};

export type AnalyzeQueryInput = AnalyzeQueryRequest & {
  catalogs: QueryAssistCatalogs;
};

export type AnalyzeQueryWorkerMessage = SetQueryAssistCatalogsRequest | AnalyzeQueryRequest;

export type AnalyzeQueryResponse = {
  type: "ANALYZE_QUERY_RESULT";
  payload: QueryAnalysis;
};

export type QueryRankDebugScore = {
  itemId: string;
  rank: number;
  lexicalScore: number;
  vectorScore: number;
  fusedScore: number;
  lexicalRank?: number;
  vectorRank?: number;
  matchedLexical: boolean;
  matchedVector: boolean;
};

export type QueryVectorTopHitDebug = {
  index: number;
  score: number;
  itemId?: string;
  title?: string;
};

export type QueryVectorStatsDebug = {
  candidateCount: number;
  rawHitCount: number;
  keptHitCount: number;
  topScore: number | null;
  minAcceptedScore: number | null;
  mode: "vector" | "hybrid";
};

export type QueryDebugPayload = {
  queryHash: string;
  perItem: QueryRankDebugScore[];
  vectorTopHits: QueryVectorTopHitDebug[];
  vectorStats?: QueryVectorStatsDebug;
};

export type RankQueryWorkerPayload = {
  items: RankableItem[];
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
  lexicalScores: Array<[string, number]>;
  /** Normalized positive query terms; array position maps into bitset words. */
  lexicalMatchTerms?: string[];
  /** Per-item 32-bit words identifying which lexical query terms matched. */
  lexicalMatchMasksById?: Array<[string, number[]]>;
  vectorScoresByIndex: Array<[number, number]>;
  includeDebug?: boolean;
};

export type RankableItem = {
  id: string;
  title: string;
  textContent: string;
  ocrText: string;
  url: string;
  source: ItemDocType["source"];
  authorUsername?: string;
  mediaTypes: Array<"image" | "video">;
  vector_index?: number;
  vector_indexes?: number[];
  createdAt: number;
  updatedAt: number;
};

export type RankQueryCursor = {
  queryHash: string;
  id: string;
  relevance: number;
  createdAt: number;
  updatedAt: number;
  title: string;
  source: ItemDocType["source"];
};

export type RankQueryWorkerResult = {
  itemIds: string[];
  total: number;
  vectorHits: number;
  lexicalHits: number;
  hasMore: boolean;
  nextCursor?: RankQueryCursor | null;
  debugScores?: QueryRankDebugScore[];
};

export type RankQueryWorkerRequest = {
  type: "RANK_QUERY";
  requestId: number;
  payload: RankQueryWorkerPayload;
};

export type RankQueryWorkerResponse = {
  type: "RANK_QUERY_RESULT";
  requestId: number;
  payload: RankQueryWorkerResult;
};
