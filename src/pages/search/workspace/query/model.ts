import type { SearchProcessStatusItem } from "@src/pages/search/components/SearchProcessStatus";
import type { FolderDocType } from "@src/schemas/folder_schema";
import type { ItemDocType } from "@src/schemas/item_schema";
import type { SpaceListItem as ServiceSpaceListItem } from "@src/services/spaces/types";
import type {
  QueryAnalysis,
  QueryDebugPayload,
  QueryMode,
  RankQueryCursor,
} from "@src/search-core/contracts";
import { DEFAULT_GRID_PAGE_LIMIT } from "@src/search-core/pagination";

/** Shared query, catalog, status, and workspace-domain values. */
export const SOURCE_OPTIONS: ItemDocType["source"][] = [
  "web",
  "twitter",
  "reddit",
  "note",
  "youtube",
  "instagram",
  "tiktok",
  "substack",
  "linkedin",
  "github",
  "article",
];

export const RECENT_QUERIES_KEY = "vibe-search-recent-queries";
export const MAX_VECTOR_TOPK = 4_000;
export const SCORE_BUDGET_MULTIPLIER = 8;
export const MIN_SCORE_BUDGET = 600;
export const QUERY_REFRESH_DEBOUNCE_IDLE_MS = 150;
export const QUERY_REFRESH_DEBOUNCE_PROCESSING_MS = 500;
export const QUERY_REFRESH_DEBOUNCE_LOW_PRIORITY_MS = 750;
export const SPACE_ACTIVITY_TOUCH_THROTTLE_MS = 12_000;
export const SPACE_ACCESS_POLL_MS = 20_000;
export const PROCESS_STATUS_MAX_ENTRIES = 80;
export const PROCESS_STATUS_SUCCESS_TTL_MS = 15 * 60 * 1_000;
export const PROCESS_STATUS_PROCESSING_TTL_MS = 45 * 60 * 1_000;
export const PROCESS_STATUS_PRUNE_INTERVAL_MS = 60 * 1_000;
export const QUERY_REQUEST_TIMEOUT_MS = 20_000;
export const VECTOR_QUERY_MIN_CHARS = 3;
export const SEARCH_PAGE_SIZE = 100;
export const SEARCH_DEBUG_STORAGE_KEY = "vibe.search.debug";
export const SEARCH_DEBUG_QUERY_PARAM = "debugSearch";
export const DEFAULT_QUERY_LIMIT = DEFAULT_GRID_PAGE_LIMIT;

export type SpaceListItem = ServiceSpaceListItem;

export type BrowserBookmarkImportResult = {
  spaceGroupId: string;
  spaceIds: string[];
  primarySpaceId: string | null;
  folderCount: number;
  bookmarkCount: number;
  updatedFolderCount: number;
  updatedBookmarkCount: number;
  removedBookmarkCount: number;
  metadataUrls: string[];
};

export type GitHubStarsImportResult = {
  spaceGroupId: string;
  spaceIds: string[];
  importedCount: number;
  updatedCount: number;
  removedCount: number;
};

export type SearchQueryDiagnostics = {
  queryHash: string;
  candidateCount: number;
  rankInputCount: number;
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

export type SearchQueryPayload = {
  items: ItemDocType[];
  total: number;
  totalIsExact?: boolean;
  vectorHits: number;
  lexicalHits: number;
  vectorError?: string | null;
  page: number;
  limit: number;
  hasMore: boolean;
  nextCursor?: RankQueryCursor | null;
  diagnostics?: SearchQueryDiagnostics;
  debug?: QueryDebugPayload;
  /** A newer search generation replaced this request; retain current results. */
  superseded?: boolean;
};

export type SearchResultMeta = {
  total: number;
  totalIsExact: boolean;
  vectorHits: number;
  lexicalHits: number;
  vectorError?: string | null;
  page: number;
  limit: number;
  hasMore: boolean;
  nextCursor?: RankQueryCursor | null;
  mode: QueryMode;
};

export const defaultAnalysis: QueryAnalysis = {
  requestId: 0,
  input: "",
  freeText: "",
  textGroups: [],
  excludedTerms: [],
  textExpression: undefined,
  tokens: [],
  pills: [],
  filters: {
    spaceIds: [],
    excludeSpaceIds: [],
    sources: [],
    excludeSources: [],
    folderIds: [],
    excludeFolderIds: [],
    tagNames: [],
    excludeTagNames: [],
    domains: [],
    excludeDomains: [],
    authors: [],
    excludeAuthors: [],
    hasAny: [],
    excludeHasAny: [],
    favoritesOnly: false,
  },
  directives: {},
  activeTokenStart: 0,
  activeTokenEnd: 0,
  activeTokenText: "",
  shouldOpenSuggestions: false,
  suggestions: [],
};

export function isProcessStatusFresh(
  row: SearchProcessStatusItem,
  now = Date.now(),
): boolean {
  if (row.state === "success") {
    return now - row.updatedAt <= PROCESS_STATUS_SUCCESS_TTL_MS;
  }
  if (row.state === "processing") {
    return now - row.updatedAt <= PROCESS_STATUS_PROCESSING_TTL_MS;
  }
  return true;
}

export function sortFolders(list: FolderDocType[]): FolderDocType[] {
  return [...list].sort((left, right) => {
    if (Boolean(left.isPinned) !== Boolean(right.isPinned)) {
      return left.isPinned ? -1 : 1;
    }
    const leftOrder = left.sortOrder ?? Number.MAX_SAFE_INTEGER;
    const rightOrder = right.sortOrder ?? Number.MAX_SAFE_INTEGER;
    if (leftOrder !== rightOrder) return leftOrder - rightOrder;
    return left.createdAt - right.createdAt;
  });
}

const RECOVERY_QUESTION_SUGGESTIONS = [
  "What was the name of your first pet?",
  "What city were you born in?",
  "What was the name of your first teacher?",
  "What is your favorite movie?",
  "What was the name of your primary school?",
  "What is your favorite food?",
  "What street did you grow up on?",
  "What is your favorite book?",
  "What was your childhood nickname?",
  "What is your favorite sports team?",
];

export function pickTwoRecoveryQuestions(): [string, string] {
  const shuffled = [...RECOVERY_QUESTION_SUGGESTIONS].sort(
    () => Math.random() - 0.5,
  );
  return [shuffled[0], shuffled[1]];
}

export function sortSpaces(list: SpaceListItem[]): SpaceListItem[] {
  return [...list].sort((left, right) => {
    if (Boolean(left.isPrivate) !== Boolean(right.isPrivate)) {
      return left.isPrivate ? 1 : -1;
    }
    const leftOrder = left.sortOrder ?? Number.MAX_SAFE_INTEGER;
    const rightOrder = right.sortOrder ?? Number.MAX_SAFE_INTEGER;
    if (leftOrder !== rightOrder) return leftOrder - rightOrder;
    return left.createdAt - right.createdAt;
  });
}

export function parseDomain(url: string): string | null {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return null;
  }
}

export function unique<Value>(list: Value[]): Value[] {
  return [...new Set(list)];
}

export function sameStringArray(left: string[], right: string[]): boolean {
  return (
    left.length === right.length &&
    left.every((value, index) => value === right[index])
  );
}
