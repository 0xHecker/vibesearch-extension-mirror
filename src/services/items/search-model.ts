import type { ItemDocType } from "@src/schemas/item_schema";
import type {
  QueryDebugPayload,
  QueryTextExpression,
  RankQueryCursor,
  RankableItem,
} from "@src/search-core/contracts";
import type { ItemSearchAccessContext } from "@src/services/items/access";

export type LocalQuerySortBy = "relevance" | "createdAt" | "updatedAt" | "title" | "source";
export type LocalQuerySortOrder = "asc" | "desc";

export const MAX_VECTOR_TOPK = 4_000;
export const MAX_LEXICAL_SCORE_BUDGET = 8_000;
export const MAX_RANK_INPUT_ITEMS = 12_000;
export const MIN_PRUNE_CANDIDATES = 80;
export const MIN_SCORE_BUDGET = 600;
export const SCORE_BUDGET_MULTIPLIER = 8;
export const MAX_RANK_TEXT_CHARS = 6_000;
export const MS_PER_DAY = 24 * 60 * 60 * 1_000;
export const LEXICAL_SEARCH_TIMEOUT_MS = 4_000;
export const VECTOR_SEARCH_TIMEOUT_MS = 3_500;
export const VECTOR_QUERY_MIN_CHARS = 3;
export const SCOPED_CANDIDATE_PAGE_SIZE = 250;

export type LocalQueryText = {
  groups?: string[][];
  excludedTerms?: string[];
  expression?: QueryTextExpression;
};

export type LocalQueryPagination = {
  limit?: number;
  page?: number;
  afterCursor?: RankQueryCursor | null;
};

export type LocalQueryFilters = {
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

export type LocalQueryPayload = {
  /** Stable for the lifetime of one Search page. Queries supersede work only in this client. */
  searchClientId?: string;
  query?: string;
  text?: LocalQueryText;
  useKeyword?: boolean;
  useVector?: boolean;
  useFuzzy?: boolean;
  topK?: number;
  minScore?: number;
  pagination?: LocalQueryPagination;
  filters?: LocalQueryFilters;
  sort?: { by?: LocalQuerySortBy; order?: LocalQuerySortOrder };
  accessContext?: ItemSearchAccessContext;
  debug?: boolean;
};

export type LocalQueryDiagnostics = {
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

export type LocalQueryResponse = {
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
  diagnostics?: LocalQueryDiagnostics;
  debug?: QueryDebugPayload;
  /** Benign concurrency outcome: a newer search generation replaced this one. */
  superseded?: boolean;
};

export type CandidateLite = {
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

export type RankedLiteEntry = {
  item: Pick<RankableItem, "id" | "title" | "source" | "createdAt" | "updatedAt">;
  relevance: number;
};

export type VectorScoreResult = {
  index: number;
  score: number;
};

export type SearchTelemetry = {
  supersededCount: number;
  fallbackCount: number;
};
