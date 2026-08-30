import { cn } from "@src/lib/utils";
import { startTransition, useCallback, useEffect, useMemo, useRef, useState, type DragEvent } from "react";
import { Tabs } from "@src/components/icons/tabs";
import SidePanel from "@src/components/ui/SidePanel";
import { TabGroups } from "@src/components/TabGroups/TabGroups";
import { OrganizeDndProvider } from "@src/components/dnd/OrganizeDndProvider";
import { SelectionProvider } from "@src/components/TabGroups/SelectionContext";
import { BulkActionsBar } from "@src/components/TabGroups/BulkActionsBar";
import { ChevronRight } from "@src/components/icons/chevron-right";
import { FolderDocType } from "@src/schemas/folder_schema";
import { ItemDocType } from "@src/schemas/item_schema";
import { SpaceDocType } from "@src/schemas/space_schema";
import { SpaceGroupDocType } from "@src/schemas/space_group_schema";
import {
  SearchQueryBar,
  type SearchQuerySubmitMeta,
} from "@src/pages/search/components/SearchQueryBar";
import {
  SearchProcessStatus,
  SearchProcessStatusItem,
  SearchProcessRetryAction,
} from "@src/pages/search/components/SearchProcessStatus";
import { Button } from "@src/components/ui/button";
import { Input } from "@src/components/ui/input";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@src/components/ui/dialog";
import { analyzeQuery } from "@src/search-core/query-language";
import {
  getQueryModeFeatures,
  resolveEffectiveQueryChannels,
} from "@src/search-core/contracts";
import { resolveSearchSpaceIds } from "@src/search-core/space-scope";
import {
  DEFAULT_GRID_PAGE_LIMIT,
  getSearchScoreBudget,
  MAX_GRID_QUERY_LIMIT,
  shouldUseCursorPagination,
} from "@src/search-core/pagination";
import { mergeItemsById } from "@src/search-core/item-patch";
import type {
  QueryDebugPayload,
  QueryRankDebugScore,
  QueryAnalysis,
  QueryAssistCatalogs,
  QueryMode,
  QueryScope,
  QuerySortBy,
  QuerySortOrder,
  RankQueryCursor,
} from "@src/search-core/contracts";
import { ArchiveRestore, ArrowLeft, Bookmark, ChevronDown, ChevronRight as ChevronRightIcon, Eye, EyeOff, GitFork, Lock, Plus, RefreshCw, Settings, Share2, Shield, Globe2, XIcon } from "lucide-react";
import { Toaster } from "sonner";
import {
  PRIVATE_PASSWORD_MIN_LENGTH,
  PRIVATE_SPACE_ID,
  PUBLIC_SPACE_ID,
} from "@src/common/spaces";
import { Sidebar, type SidebarHandlers, type SidebarSpace } from "@src/pages/search/components/Sidebar/Sidebar";
import {
  DEFAULT_BIN_PAGE_SIZE,
  toBinEntryCursor,
  type BinContentsPage,
  type BinEntry,
  type BinEntryCursor,
} from "@src/common/bin";
import { ShareDialog } from "@src/pages/search/components/share/ShareDialog";
import { ImportSharedDialog } from "@src/pages/search/components/share/ImportSharedDialog";
import { SettingsModal } from "@src/pages/search/components/settings/SettingsModal";
import { isSearchHistoryEnabled } from "@src/pages/search/components/settings/sections/SearchHistorySection";
import {
  setDefaultSearchMode,
  setDefaultSearchScope,
  useDefaultSearchMode,
  useDefaultSearchScope,
} from "@src/pages/search/search-preferences";
import {
  buildFolderLoadKey,
  buildSearchSelectionSearch,
  includePendingRevealItem,
  resolveFolderSelectionContext,
  resolveSearchResultSelectionContext,
} from "@src/pages/search/selection-state";
import {
  resolveNamedFilterValues,
  resolveSearchFolderFilterIds,
} from "@src/pages/search/filter-values";
import {
  findItemElementByDataId,
  revalidateRevealItem,
} from "@src/pages/search/reveal-target";
import { getOrCreateSearchClientId } from "@src/pages/search/search-client-id";
import { shouldPreserveSearchResultsForError } from "@src/pages/search/query-error-state";
import { SearchResults } from "@src/pages/search/components/SearchResults";
import { SearchControlsBar } from "@src/pages/search/components/SearchControls";
import { GITHUB_TOKEN_STORAGE_KEY } from "@src/pages/search/components/settings/sections/TokensSection";
import type { MixedShareSelection } from "@src/services/share-snapshot";
import {
  resolveToastErrorMessage,
  showErrorToast,
  showLoadingToast,
  showSuccessToast,
} from "@src/utils/toast-feedback";
import { useBeforeUnloadGuard } from "@src/utils/useBeforeUnloadGuard";

const SOURCE_OPTIONS: ItemDocType["source"][] = [
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

const RECENT_QUERIES_KEY = "vibe-search-recent-queries";
const MAX_VECTOR_TOPK = 4000;
const SCORE_BUDGET_MULTIPLIER = 8;
const MIN_SCORE_BUDGET = 600;
const QUERY_REFRESH_DEBOUNCE_IDLE_MS = 150;
const QUERY_REFRESH_DEBOUNCE_PROCESSING_MS = 500;
const QUERY_REFRESH_DEBOUNCE_LOW_PRIORITY_MS = 750;
const SPACE_ACTIVITY_TOUCH_THROTTLE_MS = 12_000;
const SPACE_ACCESS_POLL_MS = 20_000;
const PROCESS_STATUS_MAX_ENTRIES = 80;
const PROCESS_STATUS_SUCCESS_TTL_MS = 15 * 60 * 1000;
const PROCESS_STATUS_PROCESSING_TTL_MS = 45 * 60 * 1000;
const PROCESS_STATUS_PRUNE_INTERVAL_MS = 60 * 1000;
const QUERY_REQUEST_TIMEOUT_MS = 20_000;
const VECTOR_QUERY_MIN_CHARS = 3;
/** Flat search shows up to this many per page; crossing it reveals the pager. */
const SEARCH_PAGE_SIZE = 100;
const SEARCH_DEBUG_STORAGE_KEY = "vibe.search.debug";
const SEARCH_DEBUG_QUERY_PARAM = "debugSearch";
const DEFAULT_QUERY_LIMIT = DEFAULT_GRID_PAGE_LIMIT;

const isProcessStatusFresh = (row: SearchProcessStatusItem, now = Date.now()): boolean => {
  if (row.state === "success") return now - row.updatedAt <= PROCESS_STATUS_SUCCESS_TTL_MS;
  if (row.state === "processing") return now - row.updatedAt <= PROCESS_STATUS_PROCESSING_TTL_MS;
  return true;
};

type SpaceListItem = Pick<
  SpaceDocType,
  "id" | "name" | "slug" | "spaceGroupId" | "isPrivate" | "sortOrder" | "isArchived" | "createdAt" | "updatedAt" | "deletedAt" | "purgeAt"
> & {
  access: {
    isUnlocked: boolean;
    requiresPassword: boolean;
    hasRecovery: boolean;
    recoveryQuestions: string[];
    autoLockMs: number;
    remainingMs?: number;
    lastActivityAt?: number;
  };
};

type BrowserBookmarkImportResult = {
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

type GitHubStarsImportResult = {
  spaceGroupId: string;
  spaceIds: string[];
  importedCount: number;
  updatedCount: number;
  removedCount: number;
};

type SearchQueryDiagnostics = {
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

type SearchQueryPayload = {
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
  /** Benign: a newer search generation replaced this one; keep current results. */
  superseded?: boolean;
};

const defaultAnalysis: QueryAnalysis = {
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

const sortFolders = (list: FolderDocType[]) =>
  [...list].sort((a, b) => {
    if (!!a.isPinned !== !!b.isPinned) return a.isPinned ? -1 : 1;
    const ao = a.sortOrder ?? Number.MAX_SAFE_INTEGER;
    const bo = b.sortOrder ?? Number.MAX_SAFE_INTEGER;
    if (ao !== bo) return ao - bo;
    return a.createdAt - b.createdAt;
  });

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

const pickTwoRecoveryQuestions = (): [string, string] => {
  const shuffled = [...RECOVERY_QUESTION_SUGGESTIONS].sort(() => Math.random() - 0.5);
  return [shuffled[0], shuffled[1]];
};

const sortSpaces = (list: SpaceListItem[]) =>
  [...list].sort((a, b) => {
    if (!!a.isPrivate !== !!b.isPrivate) return a.isPrivate ? 1 : -1;
    const ao = a.sortOrder ?? Number.MAX_SAFE_INTEGER;
    const bo = b.sortOrder ?? Number.MAX_SAFE_INTEGER;
    if (ao !== bo) return ao - bo;
    return a.createdAt - b.createdAt;
  });

const parseDomain = (url: string): string | null => {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return null;
  }
};

const unique = <T,>(list: T[]) => Array.from(new Set(list));
const sameStringArray = (left: string[], right: string[]) =>
  left.length === right.length && left.every((value, index) => value === right[index]);

const SearchInner = () => {
  const [theme] = useState("light");
  const [isOpen, setIsOpen] = useState(true);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [binNonce, setBinNonce] = useState(0);
  const [isShareDialogOpen, setIsShareDialogOpen] = useState(false);
  const [isImportSharedDialogOpen, setIsImportSharedDialogOpen] = useState(false);
  const [shareDialogSelection, setShareDialogSelection] = useState<MixedShareSelection>({
    folderIds: new Set(),
    itemIds: new Set(),
    spaceIds: new Set(),
    spaceGroupIds: new Set(),
  });
  const [spaces, setSpaces] = useState<SpaceListItem[]>([]);
  const [spaceGroups, setSpaceGroups] = useState<SpaceGroupDocType[]>([]);
  const [activeSpaceGroupId, setActiveSpaceGroupId] = useState<string | null>(() => {
    try {
      const param = new URLSearchParams(window.location.search).get("group");
      return param && param.trim() ? param.trim() : null;
    } catch {
      return null;
    }
  });
  const [activeSpaceId, setActiveSpaceId] = useState<string>(() => {
    try {
      const param = new URLSearchParams(window.location.search).get("space");
      return param && param.trim() ? param.trim() : PUBLIC_SPACE_ID;
    } catch {
      return PUBLIC_SPACE_ID;
    }
  });
  const [unlockDialogOpen, setUnlockDialogOpen] = useState(false);
  const [unlockPassword, setUnlockPassword] = useState("");
  const [unlockConfirmPassword, setUnlockConfirmPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [unlockQuestion1, setUnlockQuestion1] = useState("");
  const [unlockQuestion2, setUnlockQuestion2] = useState("");
  const [unlockAnswer1, setUnlockAnswer1] = useState("");
  const [unlockAnswer2, setUnlockAnswer2] = useState("");
  const [unlockDialogError, setUnlockDialogError] = useState<string | null>(null);
  const [unlockDialogLoading, setUnlockDialogLoading] = useState(false);
  const [unlockDialogMode, setUnlockDialogMode] = useState<"unlock" | "setup" | "recovery">("unlock");
  const [changePasswordDialogOpen, setChangePasswordDialogOpen] = useState(false);
  const [changePasswordCurrent, setChangePasswordCurrent] = useState("");
  const [changePasswordNext, setChangePasswordNext] = useState("");
  const [changePasswordConfirm, setChangePasswordConfirm] = useState("");
  const [changePasswordError, setChangePasswordError] = useState<string | null>(null);
  const [changePasswordLoading, setChangePasswordLoading] = useState(false);
  const [createSpaceDialogOpen, setCreateSpaceDialogOpen] = useState(false);
  const [createSpaceName, setCreateSpaceName] = useState("");
  const [createSpaceError, setCreateSpaceError] = useState<string | null>(null);
  const [createSpaceLoading, setCreateSpaceLoading] = useState(false);
  const [createSpaceGroupDialogOpen, setCreateSpaceGroupDialogOpen] = useState(false);
  const [createSpaceGroupName, setCreateSpaceGroupName] = useState("");
  const [createSpaceGroupError, setCreateSpaceGroupError] = useState<string | null>(null);
  const [createSpaceGroupLoading, setCreateSpaceGroupLoading] = useState(false);
  const [browserBookmarksDialogOpen, setBrowserBookmarksDialogOpen] = useState(false);
  const [browserBookmarksImporting, setBrowserBookmarksImporting] = useState(false);
  const [browserBookmarksError, setBrowserBookmarksError] = useState<string | null>(null);
  const [githubStarsDialogOpen, setGithubStarsDialogOpen] = useState(false);
  const [githubStarsToken, setGithubStarsToken] = useState("");
  const [githubStarsImporting, setGithubStarsImporting] = useState(false);
  const [githubStarsError, setGithubStarsError] = useState<string | null>(null);

  // Warn before a reload/close interrupts an in-progress bulk import. The write
  // itself runs in the offscreen document and survives a reload, but reloading
  // drops this page's progress UI and closing the tab can interrupt in-flight
  // writes and the background metadata pass.
  useBeforeUnloadGuard(browserBookmarksImporting || githubStarsImporting);
  const [folders, setFolders] = useState<FolderDocType[]>([]);
  const [binEntries, setBinEntries] = useState<BinEntry[]>([]);
  const [binTotal, setBinTotal] = useState(0);
  const [binHasMore, setBinHasMore] = useState(false);
  const [binPageLoading, setBinPageLoading] = useState(false);
  const [binPageCursor, setBinPageCursor] = useState<BinEntryCursor | null>(null);
  const [binCursorHistory, setBinCursorHistory] = useState<Array<BinEntryCursor | null>>([]);
  const [items, setItems] = useState<ItemDocType[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [refreshToken, setRefreshToken] = useState(0);

  const isDevBuild = (import.meta as any)?.env?.DEV === true;
  const [isDebugSearchEnabled, setIsDebugSearchEnabled] = useState(() => {
    if (!isDevBuild) return false;
    try {
      const params = new URLSearchParams(window.location.search);
      const fromQuery = params.get(SEARCH_DEBUG_QUERY_PARAM) === "1";
      const fromStorage = localStorage.getItem(SEARCH_DEBUG_STORAGE_KEY) === "1";
      return fromQuery || fromStorage;
    } catch {
      return false;
    }
  });

  const [queryText, setQueryText] = useState("");
  const defaultMode = useDefaultSearchMode();
  const defaultScope = useDefaultSearchScope();
  // Set when the user reveals a result in its space; powers the "Back to
  // results" pill that restores the search they jumped away from.
  const [revealReturn, setRevealReturn] = useState<{ query: string } | null>(null);
  const pendingRevealItemRef = useRef<ItemDocType | null>(null);
  const [queryAnalysis, setQueryAnalysis] = useState<QueryAnalysis>(defaultAnalysis);
  const [querySubmitMeta, setQuerySubmitMeta] = useState<SearchQuerySubmitMeta | null>(null);
  const [resultDebug, setResultDebug] = useState<QueryDebugPayload | null>(null);
  const [selectedFolderId, setSelectedFolderId] = useState<string>(() => {
    try {
      const param = new URLSearchParams(window.location.search).get("folder");
      return param && param.trim() ? param.trim() : "all";
    } catch {
      return "all";
    }
  });
  const pendingUrlFolderIdRef = useRef<string | null>(selectedFolderId !== "all" ? selectedFolderId : null);
  const [loadedFolderKey, setLoadedFolderKey] = useState<string | null>(null);
  const [resultMeta, setResultMeta] = useState<{
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
  }>({
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
  });

  const [tagsCatalog, setTagsCatalog] = useState<Array<{ id: string; name: string }>>([]);
  const [domainsCatalog, setDomainsCatalog] = useState<string[]>([]);
  const [authorsCatalog, setAuthorsCatalog] = useState<string[]>([]);
  const [availableFilters, setAvailableFilters] = useState<string[]>([]);
  const [recentQueries, setRecentQueries] = useState<string[]>([]);
  const [processStatusById, setProcessStatusById] = useState<
    Record<string, SearchProcessStatusItem>
  >({});
  const [retryingProcessId, setRetryingProcessId] = useState<string | null>(null);

  const requestIdRef = useRef(0);
  const revealRequestIdRef = useRef(0);
  const binLoadRequestRef = useRef(0);
  const searchClientIdRef = useRef<string | null>(null);
  const searchClientId = getOrCreateSearchClientId(searchClientIdRef);
  const folderLoadRequestRef = useRef(0);
  const refreshTimerRef = useRef<number | null>(null);
  const createSpaceGroupIdRef = useRef<string | null | undefined>(undefined);
  const tagReloadTimerRef = useRef<number | null>(null);
  const activityTouchRef = useRef<number>(0);
  const accessPollTimerRef = useRef<number | null>(null);
  // Signature of the last-run query. A re-run with the same signature is a
  // background data refresh (metadata/embeddings streaming in), which must not
  // flip the status row to "processing" (that caused the constant blinking).
  const querySignatureRef = useRef<string | null>(null);
  const previousActiveSpaceRef = useRef<string>(PUBLIC_SPACE_ID);
  const visibleItemIdsRef = useRef<Set<string>>(new Set());
  const pendingMetadataItemIdsRef = useRef<Set<string>>(new Set());
  const metadataPatchTimerRef = useRef<number | null>(null);
  const hasConstrainedQueryRef = useRef(false);
  const staleSuppressedCountRef = useRef(0);
  const [staleSuppressedCount, setStaleSuppressedCount] = useState(0);
  const [cursorAfter, setCursorAfter] = useState<RankQueryCursor | null>(null);
  const [cursorPage, setCursorPage] = useState(1);
  const [cursorHistory, setCursorHistory] = useState<Array<RankQueryCursor | null>>([]);

  useEffect(() => {
    return () => {
      if (metadataPatchTimerRef.current !== null) {
        window.clearTimeout(metadataPatchTimerRef.current);
      }
    };
  }, []);

  const processStatuses = useMemo(
    () => Object.values(processStatusById).sort((a, b) => b.updatedAt - a.updatedAt),
    [processStatusById]
  );
  const debugScoresByItemId = useMemo<Record<string, QueryRankDebugScore>>(() => {
    if (!resultDebug) return {};
    return Object.fromEntries(resultDebug.perItem.map((entry) => [entry.itemId, entry]));
  }, [resultDebug]);
  const topDebugVectorHit = useMemo(
    () => (resultDebug?.vectorTopHits && resultDebug.vectorTopHits.length > 0
      ? resultDebug.vectorTopHits[0]
      : null),
    [resultDebug]
  );
  const hasBackgroundProcessing = useMemo(
    () => processStatuses.some((status) => status.state === "processing" && status.id !== "search-query"),
    [processStatuses]
  );

  const upsertProcessStatus = useCallback((status: SearchProcessStatusItem) => {
    setProcessStatusById((prev) => {
      const next = {
        ...prev,
        [status.id]: status,
      };
      const now = Date.now();
      const entries = Object.values(next)
        .filter((row) => isProcessStatusFresh(row, now))
        .sort((a, b) => b.updatedAt - a.updatedAt)
        .slice(0, PROCESS_STATUS_MAX_ENTRIES);
      return Object.fromEntries(entries.map((row) => [row.id, row]));
    });
  }, []);

  const pruneProcessStatuses = useCallback(() => {
    setProcessStatusById((prev) => {
      const now = Date.now();
      const entries = Object.values(prev).filter((row) => isProcessStatusFresh(row, now));
      if (entries.length === Object.keys(prev).length) return prev;
      return Object.fromEntries(entries.map((row) => [row.id, row]));
    });
  }, []);

  useEffect(() => {
    const timer = window.setInterval(pruneProcessStatuses, PROCESS_STATUS_PRUNE_INTERVAL_MS);
    return () => window.clearInterval(timer);
  }, [pruneProcessStatuses]);

  const clearProcessStatus = useCallback((statusId: string) => {
    setProcessStatusById((prev) => {
      if (!(statusId in prev)) return prev;
      const next = { ...prev };
      delete next[statusId];
      return next;
    });
  }, []);

  const activeSpace = useMemo(
    () => spaces.find((space) => space.id === activeSpaceId) || null,
    [activeSpaceId, spaces]
  );
  const activeSpaceGroup = useMemo(
    () => spaceGroups.find((group) => group.id === activeSpaceGroupId) || null,
    [activeSpaceGroupId, spaceGroups]
  );
  const activeSpaceGroupSpaceIds = useMemo(
    () => activeSpaceGroupId ? spaces.filter((space) => space.spaceGroupId === activeSpaceGroupId).map((space) => space.id) : [],
    [activeSpaceGroupId, spaces]
  );
  const spacesByGroupId = useMemo(() => {
    const grouped = new Map<string, SpaceListItem[]>();
    for (const space of spaces) {
      if (!space.spaceGroupId) continue;
      const rows = grouped.get(space.spaceGroupId) || [];
      rows.push(space);
      grouped.set(space.spaceGroupId, rows);
    }
    for (const rows of grouped.values()) rows.sort((left, right) => left.sortOrder - right.sortOrder);
    return grouped;
  }, [spaces]);
  const ungroupedSpaces = useMemo(
    () => spaces.filter((space) => !space.spaceGroupId),
    [spaces]
  );
  const privateSpace = useMemo(
    () => spaces.find((space) => space.id === PRIVATE_SPACE_ID) || null,
    [spaces]
  );
  const isPrivateSpaceActive = activeSpace?.id === PRIVATE_SPACE_ID;
  const isPrivateUnlocked = privateSpace?.access.isUnlocked === true;
  const activeSpaceFolders = useMemo(
    () => {
      const allowedSpaceIds = activeSpaceGroupId ? new Set(activeSpaceGroupSpaceIds) : new Set([activeSpaceId]);
      return folders.filter((folder) => allowedSpaceIds.has(folder.spaceId));
    },
    [activeSpaceGroupId, activeSpaceGroupSpaceIds, activeSpaceId, folders]
  );

  const catalogs = useMemo<QueryAssistCatalogs>(
    () => ({
      sources: SOURCE_OPTIONS,
      spaces: spaces.map((space) => ({
        id: space.id,
        name: space.name,
        isPrivate: space.isPrivate,
      })),
      folders: activeSpaceFolders.map((folder) => ({ id: folder.id, name: folder.name })),
      tags: tagsCatalog,
      domains: domainsCatalog,
      authors: authorsCatalog,
      recentQueries,
    }),
    [activeSpaceFolders, authorsCatalog, domainsCatalog, recentQueries, spaces, tagsCatalog]
  );

  const visibleFolderIdsFromResults = useMemo(
    () => new Set(items.map((item) => item.folderId)),
    [items]
  );
  const isAnalysisCurrent = queryAnalysis.input === queryText;
  const hasActiveQuery = queryText.trim().length > 0;
  const typedScope = isAnalysisCurrent ? queryAnalysis.directives.scope ?? null : null;
  const typedMode = isAnalysisCurrent ? queryAnalysis.directives.mode ?? null : null;
  // Single source of truth = the query language. Chips reflect the effective
  // value (typed `scope:` / `mode:` directive, else the saved default) and write
  // back into the query text, so typing QL and clicking the UI stay in sync.
  const effectiveMode: QueryMode = typedMode ?? defaultMode;
  const effectiveScope: QueryScope = typedScope ?? defaultScope;
  // Browsing (no query) shows the space you're standing in; searching resolves
  // the scope (Everywhere by default) and ignores sidebar boundaries.
  const requestedScope: QueryScope = hasActiveQuery ? effectiveScope : "current";
  const currentFolderLoadKey = useMemo(
    () =>
      buildFolderLoadKey({
        activeSpaceId,
        searchScope: activeSpaceGroupId ? "global" : requestedScope,
        spaceIds: activeSpaceGroupId ? activeSpaceGroupSpaceIds : undefined,
      }),
    [activeSpaceGroupId, activeSpaceGroupSpaceIds, activeSpaceId, requestedScope]
  );
  const hasLoadedCurrentFolders = loadedFolderKey === currentFolderLoadKey;
  const requestedScopeLabel = useMemo(() => {
    switch (effectiveScope) {
      case "current":
        return activeSpace?.name || "This space";
      case "private":
        return "Private";
      case "public":
        return "Public";
      default:
        return "Everywhere";
    }
  }, [activeSpace?.name, effectiveScope]);

  // Quick-filter pills reflect the active space/scope; reset so stale types don't linger.
  useEffect(() => {
    setAvailableFilters([]);
  }, [activeSpaceGroupId, activeSpaceId, requestedScope]);

  const visibleFolders = useMemo(() => {
    const shouldUseResultDrivenFolders =
      selectedFolderId === "all" && requestedScope !== "current";
    const sourceFolders = shouldUseResultDrivenFolders
      ? folders.filter((folder) => visibleFolderIdsFromResults.has(folder.id))
      : activeSpaceFolders;

    if (selectedFolderId === "all") return sourceFolders;
    return sourceFolders.filter((folder) => folder.id === selectedFolderId);
  }, [
    activeSpaceFolders,
    folders,
    requestedScope,
    selectedFolderId,
    visibleFolderIdsFromResults,
  ]);

  const handleResultCopy = useCallback(() => {}, []);

  // Reveal-in-space: jump the browse context to where a result lives, drop the
  // query, and remember the search so it can be restored.
  const handleRevealItem = useCallback(
    async (item: ItemDocType) => {
      const revealRequestId = ++revealRequestIdRef.current;
      let currentItem: ItemDocType | null;
      try {
        currentItem = await revalidateRevealItem(item, async (itemId) => {
          const response = await chrome.runtime.sendMessage({
            service: "items",
            type: "getByIds",
            target: "offscreen",
            payload: {
              itemIds: [itemId],
              accessContext: {
                activeSpaceId: PUBLIC_SPACE_ID,
                searchScope: "global",
              },
            },
          });
          if (!response?.success) {
            throw new Error(response?.error || "Could not refresh this result's location.");
          }
          return Array.isArray(response.payload) ? response.payload : [];
        });
      } catch (revealError) {
        if (revealRequestId !== revealRequestIdRef.current) return;
        showErrorToast(
          resolveToastErrorMessage(revealError, "Could not refresh this result's location.")
        );
        return;
      }
      if (revealRequestId !== revealRequestIdRef.current) return;
      if (!currentItem) {
        setItems((current) => current.filter((entry) => entry.id !== item.id));
        showErrorToast("This result moved to Bin or is no longer available.");
        setRefreshToken((value) => value + 1);
        return;
      }

      setRevealReturn((current) => current ?? (queryText.trim() ? { query: queryText } : null));
      const selection = resolveSearchResultSelectionContext(currentItem);
      setActiveSpaceId(selection.activeSpaceId);
      setActiveSpaceGroupId(selection.activeSpaceGroupId);
      setSelectedFolderId(selection.selectedFolderId);
      const cleared = analyzeQuery({
        type: "ANALYZE_QUERY",
        requestId: Date.now(),
        input: "",
        cursor: 0,
        catalogs,
        forceSuggestions: false,
      });
      setQueryText("");
      setQueryAnalysis(cleared);
      setQuerySubmitMeta(null);
      setCursorAfter(null);
      setCursorPage(1);
      setCursorHistory([]);
      pendingRevealItemRef.current = currentItem;
      setRefreshToken((value) => value + 1);
    },
    [catalogs, queryText]
  );

  const handleBackToResults = useCallback(() => {
    const previous = revealReturn?.query ?? "";
    setRevealReturn(null);
    if (!previous.trim()) return;
    const analysis = analyzeQuery({
      type: "ANALYZE_QUERY",
      requestId: Date.now(),
      input: previous,
      cursor: previous.length,
      catalogs,
      forceSuggestions: false,
    });
    setQueryText(previous);
    setQueryAnalysis(analysis);
    setQuerySubmitMeta(null);
    setCursorAfter(null);
    setCursorPage(1);
    setCursorHistory([]);
    setRefreshToken((value) => value + 1);
  }, [catalogs, revealReturn]);

  const resetPagination = useCallback(() => {
    setCursorAfter(null);
    setCursorPage(1);
    setCursorHistory([]);
  }, []);

  // Everything is one state: the query language. The chips read the effective
  // value and write directives/filters back into the query text, so controlling
  // search by UI or by typing QL is the same thing — always in sync.
  const applyQueryText = useCallback(
    (nextText: string) => {
      const text = nextText.replace(/\s{2,}/g, " ").trim();
      const analysis = analyzeQuery({
        type: "ANALYZE_QUERY",
        requestId: Date.now(),
        input: text,
        cursor: text.length,
        catalogs,
        forceSuggestions: false,
      });
      setQueryText(text);
      setQueryAnalysis(analysis);
      setQuerySubmitMeta(null);
      resetPagination();
      setRefreshToken((value) => value + 1);
    },
    [catalogs, resetPagination]
  );

  // Single-value directive (scope:/mode:) — replace if present, else append.
  const setDirective = useCallback(
    (field: "mode" | "scope", value: string) => {
      const pill = queryAnalysis.pills.find((entry) => entry.field === field);
      const token = `${field}:${value}`;
      if (pill) {
        applyQueryText(`${queryText.slice(0, pill.start)}${token}${queryText.slice(pill.end)}`);
      } else {
        applyQueryText(`${queryText} ${token}`);
      }
    },
    [applyQueryText, queryAnalysis, queryText]
  );

  const removeDirective = useCallback(
    (field: "mode" | "scope") => {
      const pill = queryAnalysis.pills.find((entry) => entry.field === field);
      if (!pill) return;
      applyQueryText(`${queryText.slice(0, pill.start)}${queryText.slice(pill.end)}`);
    },
    [applyQueryText, queryAnalysis, queryText]
  );

  // Selecting the saved default keeps the text clean (no redundant pill);
  // anything else writes the directive into the query.
  const applyScope = useCallback(
    (scope: QueryScope) => {
      if (scope === defaultScope) removeDirective("scope");
      else setDirective("scope", scope);
    },
    [defaultScope, removeDirective, setDirective]
  );

  const applyMode = useCallback(
    (mode: QueryMode) => {
      if (mode === defaultMode) removeDirective("mode");
      else setDirective("mode", mode);
    },
    [defaultMode, removeDirective, setDirective]
  );

  const handleSetDefaultMode = useCallback(
    (mode: QueryMode) => {
      setDefaultSearchMode(mode);
      removeDirective("mode");
    },
    [removeDirective]
  );

  const handleSetDefaultScope = useCallback(
    (scope: QueryScope) => {
      setDefaultSearchScope(scope);
      removeDirective("scope");
    },
    [removeDirective]
  );

  const toggleFilterToken = useCallback(
    (field: string, value: string) => {
      const existing = queryAnalysis.pills.find(
        (pill) => pill.field === field && pill.value.toLowerCase() === value.toLowerCase()
      );
      if (existing) {
        applyQueryText(`${queryText.slice(0, existing.start)}${queryText.slice(existing.end)}`);
        return;
      }
      const safe = value.replace(/"/g, "");
      const token = /\s/.test(safe) ? `${field}:"${safe}"` : `${field}:${safe}`;
      applyQueryText(`${queryText} ${token}`);
    },
    [applyQueryText, queryAnalysis, queryText]
  );

  const dateFilterFields = useMemo(() => new Set(["date", "added", "created", "updated"]), []);

  const setDateFilter = useCallback(
    (value: string | null) => {
      const datePills = queryAnalysis.pills
        .filter((pill) => dateFilterFields.has(pill.field))
        .sort((a, b) => b.start - a.start);
      let text = queryText;
      for (const pill of datePills) text = `${text.slice(0, pill.start)}${text.slice(pill.end)}`;
      if (value) text = `${text} date:${value}`;
      applyQueryText(text);
    },
    [applyQueryText, dateFilterFields, queryAnalysis, queryText]
  );

  const activeDateValue = useMemo(() => {
    const pill = queryAnalysis.pills.find((entry) => dateFilterFields.has(entry.field));
    return pill ? pill.value : null;
  }, [dateFilterFields, queryAnalysis.pills]);

  const clearAllFilters = useCallback(() => {
    const filterFields = new Set([
      "space", "folder", "tag", "site", "domain", "has",
      "date", "added", "created", "updated", "author", "is", "likes", "upvotes",
    ]);
    const pills = queryAnalysis.pills
      .filter((pill) => filterFields.has(pill.field))
      .sort((a, b) => b.start - a.start);
    let text = queryText;
    for (const pill of pills) text = `${text.slice(0, pill.start)}${text.slice(pill.end)}`;
    applyQueryText(text);
  }, [applyQueryText, queryAnalysis, queryText]);

  // Add several space: filters at once (used by "select a whole collection").
  const addSpaceFilters = useCallback(
    (names: string[]) => {
      const present = new Set(
        (isAnalysisCurrent ? queryAnalysis.filters.spaceIds : []).map((name) => name.toLowerCase())
      );
      const tokens = names
        .filter((name) => !present.has(name.toLowerCase()))
        .map((name) => (/\s/.test(name) ? `space:"${name.replace(/"/g, "")}"` : `space:${name}`));
      if (tokens.length === 0) return;
      applyQueryText(`${queryText} ${tokens.join(" ")}`);
    },
    [applyQueryText, isAnalysisCurrent, queryAnalysis, queryText]
  );

  // Once the revealed item's space has rendered in browse mode, scroll to it
  // and flash an accent ring. Honours reduced-motion.
  useEffect(() => {
    const targetId = pendingRevealItemRef.current?.id;
    if (!targetId || hasActiveQuery || isLoading) return;
    const prefersReduced =
      typeof window !== "undefined" &&
      !!window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    const timer = window.setTimeout(() => {
      const node = findItemElementByDataId<HTMLElement>(document, targetId);
      if (!node) return;
      pendingRevealItemRef.current = null;
      node.scrollIntoView({ behavior: prefersReduced ? "auto" : "smooth", block: "center" });
      node.classList.add("search-reveal-flash");
      window.setTimeout(() => node.classList.remove("search-reveal-flash"), 1300);
    }, 220);
    return () => window.clearTimeout(timer);
  }, [folders, hasActiveQuery, isLoading, items]);

  const preserveInputOrder = useMemo(() => {
    if (!isAnalysisCurrent) return false;
    return queryAnalysis.textGroups.length > 0 || !!queryAnalysis.directives.sortBy;
  }, [isAnalysisCurrent, queryAnalysis.directives.sortBy, queryAnalysis.textGroups.length]);

  useEffect(() => {
    if (selectedFolderId === "all") return;
    const selectedFolder = folders.find((folder) => folder.id === selectedFolderId);
    if (selectedFolder) {
      pendingUrlFolderIdRef.current = null;
      const selectedSpaceId = selectedFolder.spaceId || PUBLIC_SPACE_ID;
      const isInActiveContext = activeSpaceGroupId
        ? activeSpaceGroupSpaceIds.includes(selectedSpaceId)
        : activeSpaceId === selectedSpaceId;
      if (!isInActiveContext && spaces.some((space) => space.id === selectedSpaceId)) {
        setActiveSpaceId(selectedSpaceId);
        setActiveSpaceGroupId(null);
      }
      return;
    }
    if (!hasLoadedCurrentFolders) return;
    if (activeSpaceId === PRIVATE_SPACE_ID && (!privateSpace || !privateSpace.access.isUnlocked)) return;
    pendingUrlFolderIdRef.current = null;
    setSelectedFolderId("all");
  }, [
    activeSpaceGroupId,
    activeSpaceGroupSpaceIds,
    activeSpaceId,
    folders,
    hasLoadedCurrentFolders,
    privateSpace,
    selectedFolderId,
    spaces,
  ]);

  useEffect(() => {
    setCursorAfter(null);
    setCursorPage(1);
    setCursorHistory([]);
  }, [queryText, selectedFolderId, activeSpaceGroupId, activeSpaceId]);

  useEffect(() => {
    try {
      const raw = localStorage.getItem(RECENT_QUERIES_KEY);
      if (!raw) return;
      const parsed = JSON.parse(raw) as string[];
      if (Array.isArray(parsed)) {
        setRecentQueries(parsed.filter(Boolean).slice(0, 20));
      }
    } catch {}
  }, []);

  useEffect(() => {
    if (!isDevBuild) return;
    try {
      localStorage.setItem(SEARCH_DEBUG_STORAGE_KEY, isDebugSearchEnabled ? "1" : "0");
    } catch {}
  }, [isDebugSearchEnabled, isDevBuild]);

  useEffect(() => {
    if (isDebugSearchEnabled) return;
    setResultDebug(null);
  }, [isDebugSearchEnabled]);

  const loadSpaces = useCallback(async (): Promise<SpaceListItem[]> => {
    try {
      const response = await chrome.runtime.sendMessage({
        service: "spaces",
        type: "listSpaces",
        target: "offscreen",
      });
      if (!response?.success) return [];
      const rows = sortSpaces((response.payload as SpaceListItem[]) || []);
      setSpaces(rows);
      if (rows.length === 0) return [];
      setActiveSpaceId((current) =>
        rows.some((space) => space.id === current) ? current : PUBLIC_SPACE_ID
      );
      return rows;
    } catch (loadError) {
      console.error("Failed to load spaces:", loadError);
      return [];
    }
  }, []);

  const loadSpaceGroups = useCallback(async (): Promise<SpaceGroupDocType[]> => {
    try {
      const response = await chrome.runtime.sendMessage({
        service: "spaceGroups",
        type: "listSpaceGroups",
        target: "offscreen",
      });
      if (!response?.success) return [];
      const rows = ((response.payload as SpaceGroupDocType[]) || []).sort(
        (left, right) => left.sortOrder - right.sortOrder || left.createdAt - right.createdAt
      );
      setSpaceGroups(rows);
      setActiveSpaceGroupId((current) =>
        rows.some((group) => group.id === current) ? current : null
      );
      return rows;
    } catch (loadError) {
      console.error("Failed to load space groups:", loadError);
      return [];
    }
  }, []);

  const loadBinPage = useCallback(async (after: BinEntryCursor | null): Promise<boolean> => {
    const requestId = ++binLoadRequestRef.current;
    setBinPageLoading(true);
    try {
      const response = await chrome.runtime.sendMessage({
        service: "bin",
        type: "listContents",
        target: "offscreen",
        payload: {
          limit: DEFAULT_BIN_PAGE_SIZE,
          after,
        },
      });
      if (!response?.success) return false;
      if (requestId !== binLoadRequestRef.current) return false;

      // Accept the old array response during a rolling extension reload, then
      // switch to the bounded page contract once the offscreen page updates.
      const payload = response.payload as BinContentsPage | BinEntry[] | undefined;
      const page: BinContentsPage = Array.isArray(payload)
        ? {
            entries: payload.slice(0, DEFAULT_BIN_PAGE_SIZE),
            total: payload.length,
            hasMore: false,
            nextCursor: null,
          }
        : payload || { entries: [], total: 0, hasMore: false, nextCursor: null };
      setBinEntries(page.entries.slice(0, DEFAULT_BIN_PAGE_SIZE));
      setBinTotal(page.total);
      setBinHasMore(page.hasMore);
      return true;
    } catch (loadError) {
      console.error("Failed to load bin contents:", loadError);
      return false;
    } finally {
      if (requestId === binLoadRequestRef.current) setBinPageLoading(false);
    }
  }, []);

  const loadBinContents = useCallback(async (): Promise<void> => {
    const loaded = await loadBinPage(null);
    if (loaded) {
      setBinPageCursor(null);
      setBinCursorHistory([]);
    }
  }, [loadBinPage]);

  const loadNextBinPage = useCallback(async () => {
    if (binPageLoading || !binHasMore || binEntries.length === 0) return;
    const lastEntry = binEntries[binEntries.length - 1];
    const nextCursor = toBinEntryCursor(lastEntry);
    if (!(await loadBinPage(nextCursor))) return;
    setBinCursorHistory((history) => [...history, binPageCursor]);
    setBinPageCursor(nextCursor);
  }, [binEntries, binHasMore, binPageCursor, binPageLoading, loadBinPage]);

  const loadPreviousBinPage = useCallback(async () => {
    if (binPageLoading || binCursorHistory.length === 0) return;
    const previousCursor = binCursorHistory[binCursorHistory.length - 1];
    if (!(await loadBinPage(previousCursor))) return;
    setBinCursorHistory((history) => history.slice(0, -1));
    setBinPageCursor(previousCursor);
  }, [binCursorHistory, binPageLoading, loadBinPage]);

  const loadFolders = useCallback(async (context?: {
    activeSpaceId?: string;
    searchScope?: "current" | "global" | "private" | "public";
    spaceIds?: string[];
  }) => {
    const contextActiveSpaceId = context?.activeSpaceId ?? activeSpaceId;
    const contextSearchScope = context?.searchScope ?? requestedScope;
    const resolvedSearchScope = context?.spaceIds?.length ? "global" : contextSearchScope;
    const loadKey = buildFolderLoadKey({
      activeSpaceId: contextActiveSpaceId,
      searchScope: resolvedSearchScope,
      spaceIds: context?.spaceIds,
    });
    const requestId = ++folderLoadRequestRef.current;
    try {
      const foldersResponse = await chrome.runtime.sendMessage({
        service: "dbManager",
        type: "getAllFolders",
        target: "offscreen",
        payload: {
          accessContext: {
            activeSpaceId: contextActiveSpaceId,
            searchScope: resolvedSearchScope,
          },
          spaceIds: context?.spaceIds,
        },
      });

      if (foldersResponse?.success) {
        if (requestId !== folderLoadRequestRef.current) return;
        const next = sortFolders((foldersResponse.payload as FolderDocType[]) || []).map((folder) => ({
          ...folder,
          spaceId: folder.spaceId || PUBLIC_SPACE_ID,
        }));
        setFolders(next);
        setLoadedFolderKey(loadKey);
      }
    } catch (loadError) {
      console.error("Failed to load folders:", loadError);
    }
  }, [activeSpaceId, isPrivateUnlocked, requestedScope]);

  const loadTags = useCallback(async () => {
    try {
      const tagsResponse = await chrome.runtime.sendMessage({
        service: "tags",
        type: "searchTags",
        target: "offscreen",
        payload: {
          query: "",
          limit: 200,
          accessContext: {
            activeSpaceId,
            searchScope: requestedScope,
          },
        },
      });

      if (tagsResponse?.success) {
        const rows = (tagsResponse.payload as Array<{ id: string; name: string }>) || [];
        setTagsCatalog(rows.map((row) => ({ id: row.id, name: row.name })));
      }
    } catch (loadError) {
      console.error("Failed to load tags:", loadError);
    }
  }, [activeSpaceId, isPrivateUnlocked, requestedScope]);

  const scheduleTagReload = useCallback(() => {
    if (tagReloadTimerRef.current !== null) {
      window.clearTimeout(tagReloadTimerRef.current);
    }
    tagReloadTimerRef.current = window.setTimeout(() => {
      tagReloadTimerRef.current = null;
      loadTags();
    }, 150);
  }, [loadTags]);

  const lockPrivateSpace = useCallback(
    async (detail: string) => {
      let locked = false;
      let lastError: unknown = null;
      for (let attempt = 0; attempt < 3; attempt += 1) {
        try {
          await chrome.runtime.sendMessage({
            service: "spaces",
            type: "lockSpace",
            target: "offscreen",
            payload: { spaceId: PRIVATE_SPACE_ID },
          });
          locked = true;
          break;
        } catch (lockError) {
          lastError = lockError;
          await new Promise((resolve) => {
            window.setTimeout(resolve, 120 * (attempt + 1));
          });
        }
      }

      if (!locked && lastError) {
        console.error("Failed to lock private space:", lastError);
      }

      try {
        await loadSpaces();
      } catch {}

      upsertProcessStatus({
        id: "private-space",
        label: "Private space",
        state: locked ? "success" : "error",
        detail: locked ? detail : "Could not lock private space immediately. It will auto-lock on timeout.",
        retryAction: locked ? undefined : "LOCK_PRIVATE_SPACE",
        updatedAt: Date.now(),
      });
    },
    [loadSpaces, upsertProcessStatus]
  );

  const resetUnlockDialogState = useCallback(() => {
    setUnlockPassword("");
    setUnlockConfirmPassword("");
    setUnlockQuestion1("");
    setUnlockQuestion2("");
    setUnlockAnswer1("");
    setUnlockAnswer2("");
    setUnlockDialogError(null);
    setUnlockDialogLoading(false);
  }, []);

  const shuffleRecoveryQuestions = useCallback(() => {
    const [question1, question2] = pickTwoRecoveryQuestions();
    setUnlockQuestion1(question1);
    setUnlockQuestion2(question2);
    setUnlockAnswer1("");
    setUnlockAnswer2("");
  }, []);

  // Pre-fill two easy suggested questions when the setup dialog opens so users
  // aren't staring at empty fields. Only seeds when both are blank, so it never
  // overwrites anything the user typed (they can clear and write their own).
  useEffect(() => {
    if (
      unlockDialogOpen &&
      unlockDialogMode === "setup" &&
      !unlockQuestion1 &&
      !unlockQuestion2
    ) {
      const [question1, question2] = pickTwoRecoveryQuestions();
      setUnlockQuestion1(question1);
      setUnlockQuestion2(question2);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [unlockDialogOpen, unlockDialogMode]);

  const handleSelectSpace = useCallback(
    async (space: SpaceListItem) => {
      if (space.isPrivate && !space.access.isUnlocked) {
        setActiveSpaceGroupId(null);
        setSelectedFolderId("all");
        setUnlockDialogMode(space.access.requiresPassword ? "setup" : "unlock");
        resetUnlockDialogState();
        setUnlockDialogOpen(true);
        return;
      }

      setActiveSpaceId(space.id);
      setActiveSpaceGroupId(null);
      setSelectedFolderId("all");
      setRefreshToken((value) => value + 1);
    },
    [resetUnlockDialogState]
  );

  const handleSelectSpaceGroup = useCallback((group: SpaceGroupDocType) => {
    setActiveSpaceGroupId(group.id);
    setSelectedFolderId("all");
    setRefreshToken((value) => value + 1);
  }, []);

  const toggleSpaceGroupCollapsed = useCallback(async (group: SpaceGroupDocType) => {
    const nextCollapsed = !group.isCollapsed;
    setSpaceGroups((current) =>
      current.map((entry) =>
        entry.id === group.id ? { ...entry, isCollapsed: nextCollapsed } : entry
      )
    );
    try {
      const response = await chrome.runtime.sendMessage({
        service: "spaceGroups",
        type: "setCollapsed",
        target: "offscreen",
        payload: { id: group.id, value: nextCollapsed },
      });
      if (!response?.success) throw new Error(response?.error || "Could not update space group.");
    } catch (toggleError) {
      setSpaceGroups((current) =>
        current.map((entry) =>
          entry.id === group.id ? { ...entry, isCollapsed: group.isCollapsed } : entry
        )
      );
      showErrorToast(toggleError instanceof Error ? toggleError.message : "Could not update space group.");
    }
  }, []);

  const getDraggedFolderId = (event: DragEvent<HTMLElement>): string =>
    event.dataTransfer.getData("application/x-vibesearch-tab-group").trim();

  const allowFolderDrop = (event: DragEvent<HTMLElement>) => {
    if (Array.from(event.dataTransfer.types).includes("application/x-vibesearch-tab-group")) {
      event.preventDefault();
      event.dataTransfer.dropEffect = "move";
    }
  };

  const moveDraggedFolderToSpace = useCallback(async (event: DragEvent<HTMLElement>, spaceId: string) => {
    event.preventDefault();
    const folderId = getDraggedFolderId(event);
    if (!folderId) return;
    try {
      const response = await chrome.runtime.sendMessage({
        service: "folders",
        type: "moveToSpace",
        target: "offscreen",
        payload: { folderId, targetSpaceId: spaceId },
      });
      if (!response?.success) throw new Error(response?.error || "Could not move tab group.");
      showSuccessToast("Tab group moved.");
    } catch (moveError) {
      showErrorToast(moveError instanceof Error ? moveError.message : "Could not move tab group.");
    }
  }, []);

  const moveDraggedFolderToSpaceGroup = useCallback(async (event: DragEvent<HTMLElement>, spaceGroupId: string) => {
    event.preventDefault();
    const folderId = getDraggedFolderId(event);
    if (!folderId) return;
    try {
      const targetResponse = await chrome.runtime.sendMessage({
        service: "spaceGroups",
        type: "resolveDropSpace",
        target: "offscreen",
        payload: { spaceGroupId },
      });
      const targetSpaceId = targetResponse?.payload?.id as string | undefined;
      if (!targetResponse?.success || !targetSpaceId) throw new Error(targetResponse?.error || "Could not resolve space group.");
      const response = await chrome.runtime.sendMessage({
        service: "folders",
        type: "moveToSpace",
        target: "offscreen",
        payload: { folderId, targetSpaceId },
      });
      if (!response?.success) throw new Error(response?.error || "Could not move tab group.");
      showSuccessToast("Tab group moved.");
    } catch (moveError) {
      showErrorToast(moveError instanceof Error ? moveError.message : "Could not move tab group.");
    }
  }, []);

  const submitPrivateAccess = useCallback(async () => {
    setUnlockDialogError(null);
    setUnlockDialogLoading(true);
    const actionLabel =
      unlockDialogMode === "setup"
        ? "Configuring private space..."
        : unlockDialogMode === "recovery"
          ? "Recovering private space..."
          : "Unlocking private space...";
    const toastId = showLoadingToast(actionLabel);
    try {
      if (unlockDialogMode === "setup") {
        if (unlockPassword.length < PRIVATE_PASSWORD_MIN_LENGTH) {
          throw new Error(`Use at least ${PRIVATE_PASSWORD_MIN_LENGTH} characters.`);
        }
        if (unlockPassword !== unlockConfirmPassword) {
          throw new Error("Passwords do not match.");
        }
        if (unlockQuestion1.trim().length < 4 || unlockQuestion2.trim().length < 4) {
          throw new Error("Add two clear recovery questions.");
        }
        if (unlockAnswer1.trim().length < 2 || unlockAnswer2.trim().length < 2) {
          throw new Error("Add answers for both recovery questions.");
        }
        const questions = [
          { question: unlockQuestion1, answer: unlockAnswer1 },
          { question: unlockQuestion2, answer: unlockAnswer2 },
        ];
        const response = await chrome.runtime.sendMessage({
          service: "spaces",
          type: "setPrivatePassword",
          target: "offscreen",
          payload: {
            spaceId: PRIVATE_SPACE_ID,
            password: unlockPassword,
            recoveryQuestions: questions,
          },
        });
        if (!response?.success) {
          throw new Error(response?.error || "Failed to configure private space password.");
        }
      } else if (unlockDialogMode === "recovery") {
        if (unlockPassword.length < PRIVATE_PASSWORD_MIN_LENGTH) {
          throw new Error(`Use at least ${PRIVATE_PASSWORD_MIN_LENGTH} characters.`);
        }
        if (unlockPassword !== unlockConfirmPassword) {
          throw new Error("Passwords do not match.");
        }
        if (!unlockAnswer1.trim() || !unlockAnswer2.trim()) {
          throw new Error("Answer both recovery questions.");
        }
        const response = await chrome.runtime.sendMessage({
          service: "spaces",
          type: "recoverPrivatePassword",
          target: "offscreen",
          payload: {
            spaceId: PRIVATE_SPACE_ID,
            answer1: unlockAnswer1,
            answer2: unlockAnswer2,
            newPassword: unlockPassword,
          },
        });
        if (!response?.success) {
          throw new Error(response?.error || "Recovery failed.");
        }
      } else {
        const response = await chrome.runtime.sendMessage({
          service: "spaces",
          type: "unlockSpace",
          target: "offscreen",
          payload: { spaceId: PRIVATE_SPACE_ID, password: unlockPassword },
        });
        if (!response?.success) {
          throw new Error(response?.error || "Failed to unlock private space.");
        }
      }

      await loadSpaces();
      const shouldPreservePrivateFolder =
        activeSpaceId === PRIVATE_SPACE_ID && selectedFolderId !== "all";
      setActiveSpaceId(PRIVATE_SPACE_ID);
      if (!shouldPreservePrivateFolder) {
        setSelectedFolderId("all");
      }
      setUnlockDialogOpen(false);
      resetUnlockDialogState();
      setRefreshToken((value) => value + 1);
      upsertProcessStatus({
        id: "private-space",
        label: "Private space",
        state: "success",
        detail:
          unlockDialogMode === "setup"
            ? "Private space is configured and unlocked."
            : unlockDialogMode === "recovery"
              ? "Private space recovered and unlocked."
            : "Private space unlocked.",
        updatedAt: Date.now(),
      });
      showSuccessToast("Private space ready.", { id: toastId });
    } catch (unlockError) {
      const message = unlockError instanceof Error ? unlockError.message : "Unable to unlock private space.";
      setUnlockDialogError(message);
      upsertProcessStatus({
        id: "private-space",
        label: "Private space",
        state: "error",
        detail: message,
        updatedAt: Date.now(),
      });
      showErrorToast(message, { id: toastId });
    } finally {
      setUnlockDialogLoading(false);
    }
  }, [
    loadSpaces,
    resetUnlockDialogState,
    unlockDialogMode,
    unlockQuestion1,
    unlockQuestion2,
    unlockAnswer1,
    unlockAnswer2,
    unlockPassword,
    unlockConfirmPassword,
    activeSpaceId,
    selectedFolderId,
    upsertProcessStatus,
  ]);

  const submitPasswordChange = useCallback(async () => {
    if (changePasswordNext.length < PRIVATE_PASSWORD_MIN_LENGTH) {
      setChangePasswordError(`Use at least ${PRIVATE_PASSWORD_MIN_LENGTH} characters.`);
      return;
    }
    if (changePasswordNext !== changePasswordConfirm) {
      setChangePasswordError("Passwords do not match.");
      return;
    }

    setChangePasswordError(null);
    setChangePasswordLoading(true);
    const toastId = showLoadingToast("Updating private password...");
    try {
      const response = await chrome.runtime.sendMessage({
        service: "spaces",
        type: "changePrivatePassword",
        target: "offscreen",
        payload: {
          spaceId: PRIVATE_SPACE_ID,
          currentPassword: changePasswordCurrent,
          newPassword: changePasswordNext,
        },
      });
      if (!response?.success) {
        throw new Error(response?.error || "Failed to change password.");
      }

      await loadSpaces();
      setChangePasswordDialogOpen(false);
      setChangePasswordCurrent("");
      setChangePasswordNext("");
      setChangePasswordConfirm("");
      upsertProcessStatus({
        id: "private-space",
        label: "Private space",
        state: "success",
        detail: "Private space password updated.",
        updatedAt: Date.now(),
      });
      showSuccessToast("Private password updated.", { id: toastId });
    } catch (changeError) {
      const message =
        changeError instanceof Error ? changeError.message : "Failed to change private password.";
      setChangePasswordError(message);
      showErrorToast(message, { id: toastId });
    } finally {
      setChangePasswordLoading(false);
    }
  }, [changePasswordConfirm, changePasswordCurrent, changePasswordNext, loadSpaces, upsertProcessStatus]);

  const submitCreateSpace = useCallback(async () => {
    const name = createSpaceName.trim();
    if (!name) {
      setCreateSpaceError("Space name is required.");
      return;
    }

    setCreateSpaceError(null);
    setCreateSpaceLoading(true);
    const toastId = showLoadingToast("Creating space...");
    try {
      const targetSpaceGroupId =
      createSpaceGroupIdRef.current === undefined
        ? activeSpaceGroupId
        : createSpaceGroupIdRef.current;
      createSpaceGroupIdRef.current = undefined;
      const response = await chrome.runtime.sendMessage({
        service: "spaces",
        type: "createSpace",
        target: "offscreen",
        payload: { name, spaceGroupId: targetSpaceGroupId || undefined },
      });
      if (!response?.success) {
        throw new Error(response?.error || "Failed to create space.");
      }
      const created = response.payload as SpaceListItem;
      await loadSpaces();
      setActiveSpaceId(created.id);
      setActiveSpaceGroupId(null);
      setSelectedFolderId("all");
      setCreateSpaceName("");
      setCreateSpaceDialogOpen(false);
      showSuccessToast(`Space "${created.name}" created.`, { id: toastId });
    } catch (createError) {
      const message = createError instanceof Error ? createError.message : "Failed to create space.";
      setCreateSpaceError(message);
      showErrorToast(message, { id: toastId });
    } finally {
      setCreateSpaceLoading(false);
    }
  }, [activeSpaceGroupId, createSpaceName, loadSpaces]);

  const submitCreateSpaceGroup = useCallback(async () => {
    const name = createSpaceGroupName.trim();
    if (!name) {
      setCreateSpaceGroupError("Space group name is required.");
      return;
    }
    setCreateSpaceGroupError(null);
    setCreateSpaceGroupLoading(true);
    const toastId = showLoadingToast("Creating space group...");
    try {
      const response = await chrome.runtime.sendMessage({
        service: "spaceGroups",
        type: "createSpaceGroup",
        target: "offscreen",
        payload: { name },
      });
      if (!response?.success) throw new Error(response?.error || "Failed to create space group.");
      const created = response.payload as SpaceGroupDocType;
      await loadSpaceGroups();
      setActiveSpaceGroupId(created.id);
      setRefreshToken((value) => value + 1);
      setCreateSpaceGroupName("");
      setCreateSpaceGroupDialogOpen(false);
      showSuccessToast(`Space group "${created.name}" created.`, { id: toastId });
    } catch (createError) {
      const message = createError instanceof Error ? createError.message : "Failed to create space group.";
      setCreateSpaceGroupError(message);
      showErrorToast(message, { id: toastId });
    } finally {
      setCreateSpaceGroupLoading(false);
    }
  }, [createSpaceGroupName, loadSpaceGroups]);

  const importBrowserBookmarks = useCallback(async () => {
    setBrowserBookmarksError(null);
    setBrowserBookmarksImporting(true);
    const toastId = showLoadingToast("Importing bookmarks — keep this tab open…");
    try {
      const response = await chrome.runtime.sendMessage({
        target: "background",
        type: "IMPORT_BROWSER_BOOKMARKS",
      });
      if (!response?.success) {
        throw new Error(response?.error || "Could not import browser bookmarks.");
      }

      const result = response.payload as BrowserBookmarkImportResult;
      const nextSpaces = await loadSpaces();
      await loadSpaceGroups();
      if (!nextSpaces.some((space) => result.spaceIds.includes(space.id))) {
        throw new Error("Browser Bookmark spaces were not visible after import. Please retry.");
      }
      await loadFolders({ activeSpaceId: PUBLIC_SPACE_ID, searchScope: "global", spaceIds: result.spaceIds });
      setActiveSpaceGroupId(result.spaceGroupId);
      setSelectedFolderId("all");
      // Let React commit the new active space before the query fires; otherwise
      // the backend can receive the old/public space and show a false 0-result state.
      window.setTimeout(() => {
        setRefreshToken((value) => value + 1);
      }, 0);
      setBrowserBookmarksDialogOpen(false);
      showSuccessToast(
        `${result.bookmarkCount.toLocaleString()} bookmarks imported across ${result.spaceIds.length.toLocaleString()} spaces.`,
        { id: toastId }
      );
    } catch (importError) {
      const message = importError instanceof Error ? importError.message : "Could not import browser bookmarks.";
      setBrowserBookmarksError(message);
      showErrorToast(message, { id: toastId });
    } finally {
      setBrowserBookmarksImporting(false);
    }
  }, [loadFolders, loadSpaceGroups, loadSpaces]);

  const importGitHubStars = useCallback(async () => {
    setGithubStarsError(null);
    setGithubStarsImporting(true);
    const toastId = showLoadingToast("Importing GitHub stars — keep this tab open…");
    try {
      const response = await chrome.runtime.sendMessage({
        target: "background",
        type: "IMPORT_GITHUB_STARS",
        payload: { accessToken: githubStarsToken },
      });
      if (!response?.success) throw new Error(response?.error || "Could not import GitHub stars.");

      const result = response.payload as GitHubStarsImportResult;
      await Promise.all([loadSpaces(), loadSpaceGroups()]);
      await loadFolders({ activeSpaceId: PUBLIC_SPACE_ID, searchScope: "global", spaceIds: result.spaceIds });
      setActiveSpaceGroupId(result.spaceGroupId);
      setSelectedFolderId("all");
      setGithubStarsToken("");
      setGithubStarsDialogOpen(false);
      setRefreshToken((value) => value + 1);
      showSuccessToast(
        `${result.importedCount.toLocaleString()} GitHub stars imported across ${result.spaceIds.length.toLocaleString()} spaces.`,
        { id: toastId }
      );
    } catch (importError) {
      const message = importError instanceof Error ? importError.message : "Could not import GitHub stars.";
      setGithubStarsError(message);
      showErrorToast(message, { id: toastId });
    } finally {
      setGithubStarsImporting(false);
    }
  }, [githubStarsToken, loadFolders, loadSpaceGroups, loadSpaces]);

  const touchPrivateSpaceActivity = useCallback(async () => {
    if (activeSpaceId !== PRIVATE_SPACE_ID || !isPrivateUnlocked) {
      return;
    }
    const now = Date.now();
    if (now - activityTouchRef.current < SPACE_ACTIVITY_TOUCH_THROTTLE_MS) {
      return;
    }
    activityTouchRef.current = now;
    try {
      await chrome.runtime.sendMessage({
        service: "spaces",
        type: "touchSpaceActivity",
        target: "offscreen",
        payload: { spaceId: PRIVATE_SPACE_ID },
      });
    } catch (touchError) {
      console.error("Failed to touch private space session:", touchError);
    }
  }, [activeSpaceId, isPrivateUnlocked]);

  useEffect(() => {
    if (activeSpaceId !== PRIVATE_SPACE_ID || !isPrivateUnlocked) {
      return;
    }
    const onActivity = () => {
      void touchPrivateSpaceActivity();
    };
    const events: Array<keyof WindowEventMap> = [
      "pointerdown",
      "keydown",
      "wheel",
      "scroll",
      "focus",
    ];
    for (const eventName of events) {
      window.addEventListener(eventName, onActivity, { passive: true });
    }
    return () => {
      for (const eventName of events) {
        window.removeEventListener(eventName, onActivity);
      }
    };
  }, [activeSpaceId, isPrivateUnlocked, touchPrivateSpaceActivity]);

  useEffect(() => {
    const pollAccess = async () => {
      const rows = await loadSpaces();
      const privateRow = rows.find((space) => space.id === PRIVATE_SPACE_ID);
      if (activeSpaceId === PRIVATE_SPACE_ID && privateRow && !privateRow.access.isUnlocked) {
        if (!unlockDialogOpen) {
          setUnlockDialogMode(privateRow.access.requiresPassword ? "setup" : "unlock");
          resetUnlockDialogState();
          setUnlockDialogOpen(true);
        }
        upsertProcessStatus({
          id: "private-space",
          label: "Private space",
          state: "success",
          detail: "Private space is locked. Unlock it to keep browsing this private folder.",
          updatedAt: Date.now(),
        });
      }
    };

    void pollAccess();
    accessPollTimerRef.current = window.setInterval(() => {
      void pollAccess();
    }, SPACE_ACCESS_POLL_MS);

    return () => {
      if (accessPollTimerRef.current !== null) {
        window.clearInterval(accessPollTimerRef.current);
        accessPollTimerRef.current = null;
      }
    };
  }, [activeSpaceId, loadSpaces, resetUnlockDialogState, unlockDialogOpen, upsertProcessStatus]);

  const scheduleQueryRefresh = useCallback(
    (priority: "high" | "low" = "high") => {
      const delay =
        priority === "low"
          ? QUERY_REFRESH_DEBOUNCE_LOW_PRIORITY_MS
          : hasBackgroundProcessing
            ? QUERY_REFRESH_DEBOUNCE_PROCESSING_MS
            : QUERY_REFRESH_DEBOUNCE_IDLE_MS;
      if (refreshTimerRef.current !== null) {
        window.clearTimeout(refreshTimerRef.current);
      }
      refreshTimerRef.current = window.setTimeout(() => {
        refreshTimerRef.current = null;
        setRefreshToken((value) => value + 1);
      }, delay);
    },
    [hasBackgroundProcessing]
  );

  useEffect(() => {
    const previous = previousActiveSpaceRef.current;
    previousActiveSpaceRef.current = activeSpaceId;
    if (previous !== PRIVATE_SPACE_ID || activeSpaceId === PRIVATE_SPACE_ID || !isPrivateUnlocked) {
      return;
    }
    void lockPrivateSpace("Private space locked when you left it.");
  }, [activeSpaceId, isPrivateUnlocked, lockPrivateSpace]);

  // Re-query items when the active space changes (folders reload via loadFolders
  // effect, but the query needs an explicit trigger to pick up the new space).
  const didMountSpaceRef = useRef(false);
  useEffect(() => {
    if (!didMountSpaceRef.current) {
      didMountSpaceRef.current = true;
      return;
    }
    scheduleQueryRefresh("high");
  }, [activeSpaceId, scheduleQueryRefresh]);

  useEffect(() => {
    visibleItemIdsRef.current = new Set(items.map((item) => item.id));
  }, [items]);

  useEffect(() => {
    const queryTextHasValue = queryText.trim().length > 0;
    const hasConstrainedQuery =
      queryTextHasValue ||
      (isAnalysisCurrent &&
        (queryAnalysis.freeText.trim().length > 0 ||
          queryAnalysis.pills.length > 0 ||
          queryAnalysis.textGroups.length > 0 ||
          queryAnalysis.excludedTerms.length > 0));
    hasConstrainedQueryRef.current = hasConstrainedQuery;
  }, [
    isAnalysisCurrent,
    queryText,
    queryAnalysis.excludedTerms.length,
    queryAnalysis.freeText,
    queryAnalysis.pills.length,
    queryAnalysis.textGroups.length,
  ]);

  const clearSearchHistory = useCallback(() => {
    setRecentQueries([]);
    try {
      localStorage.removeItem(RECENT_QUERIES_KEY);
    } catch {}
  }, []);

  const deleteRecentQuery = useCallback((query: string) => {
    setRecentQueries((prev) => {
      const next = prev.filter((q) => q !== query);
      try {
        localStorage.setItem(RECENT_QUERIES_KEY, JSON.stringify(next));
      } catch {}
      return next;
    });
  }, []);

  // Cmd/Ctrl+, opens Settings (standard shortcut). Modifier combo is safe to
  // handle globally; it is never normal text input.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && !event.altKey && !event.shiftKey && event.key === ",") {
        event.preventDefault();
        setSettingsOpen(true);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // Keep the URL in sync with the active selection so a reload lands in the
  // same place. replaceState avoids polluting history or triggering navigation.
  useEffect(() => {
    try {
      const qs = buildSearchSelectionSearch({
        currentSearch: window.location.search,
        activeSpaceId,
        activeSpaceGroupId,
        selectedFolderId,
      });
      window.history.replaceState(
        window.history.state,
        "",
        `${window.location.pathname}${qs ? `?${qs}` : ""}${window.location.hash}`
      );
    } catch {
      /* ignore */
    }
  }, [activeSpaceId, activeSpaceGroupId, selectedFolderId]);

  // Once groups load, drop a restored group id that no longer exists so the
  // page doesn't get stuck on an empty scope after a reload.
  const didValidateUrlSelectionRef = useRef(false);
  useEffect(() => {
    if (didValidateUrlSelectionRef.current) return;
    if (spaces.length === 0 && spaceGroups.length === 0) return;
    didValidateUrlSelectionRef.current = true;
    if (activeSpaceGroupId && !spaceGroups.some((group) => group.id === activeSpaceGroupId)) {
      setActiveSpaceGroupId(null);
    }
  }, [spaces.length, spaceGroups, activeSpaceGroupId]);

  // ---- Scroll restoration across reloads (keyed by the active selection) ----
  const scrollKeyRef = useRef("");
  scrollKeyRef.current = `vibesearch:scroll:${activeSpaceId}|${activeSpaceGroupId ?? ""}|${selectedFolderId}`;
  const scrollRestoredRef = useRef(false);

  useEffect(() => {
    if ("scrollRestoration" in window.history) window.history.scrollRestoration = "manual";
    let raf = 0;
    const save = () => {
      try {
        sessionStorage.setItem(scrollKeyRef.current, String(Math.round(window.scrollY)));
      } catch {}
    };
    const onScroll = () => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(save);
    };
    window.addEventListener("scroll", onScroll, { passive: true });
    window.addEventListener("pagehide", save);
    return () => {
      window.removeEventListener("scroll", onScroll);
      window.removeEventListener("pagehide", save);
      cancelAnimationFrame(raf);
    };
  }, []);

  // Restore the saved scroll position once results for the restored selection
  // have rendered (so the document is tall enough to scroll to).
  useEffect(() => {
    if (scrollRestoredRef.current || items.length === 0) return;
    scrollRestoredRef.current = true;
    let saved = 0;
    try {
      saved = Number(sessionStorage.getItem(scrollKeyRef.current) ?? 0);
    } catch {}
    if (!saved || Number.isNaN(saved)) return;
    requestAnimationFrame(() =>
      requestAnimationFrame(() => window.scrollTo({ top: saved, behavior: "auto" }))
    );
  }, [items]);

  const persistRecentQuery = (query: string) => {
    const clean = query.trim();
    if (!clean) return;
    if (!isSearchHistoryEnabled()) return;
    setRecentQueries((prev) => {
      const next = [clean, ...prev.filter((row) => row !== clean)].slice(0, 20);
      if (sameStringArray(prev, next)) {
        return prev;
      }
      try {
        localStorage.setItem(RECENT_QUERIES_KEY, JSON.stringify(next));
      } catch {}
      return next;
    });
  };

  const handleSubmitQuery = useCallback(
    (nextQuery: string, analysis: QueryAnalysis, meta: SearchQuerySubmitMeta) => {
      setQueryText(nextQuery);
      setQueryAnalysis(analysis);
      setQuerySubmitMeta(meta);
      setCursorAfter(null);
      setCursorPage(1);
      setCursorHistory([]);
      setRefreshToken((value) => value + 1);
    },
    []
  );

  const triggerRetryAction = useCallback(
    async (status: SearchProcessStatusItem) => {
      const action = status.retryAction as SearchProcessRetryAction | undefined;
      if (!action) return;
      const retryToastId = showLoadingToast(`Retrying ${status.label.toLowerCase()}...`, "quick");

      setRetryingProcessId(status.id);
      upsertProcessStatus({
        ...status,
        state: "processing",
        detail: "Retry requested...",
        updatedAt: Date.now(),
      });

      try {
        if (action === "RETRY_QUERY") {
          setRefreshToken((value) => value + 1);
          showSuccessToast("Retrying query...", { id: retryToastId, tempo: "quick" });
          return;
        }

        if (action === "TRIGGER_EMBEDDING") {
          await chrome.runtime.sendMessage({
            type: "TRIGGER_EMBEDDING",
            target: "background",
          });
          showSuccessToast("Embedding refresh queued.", { id: retryToastId, tempo: "quick" });
          return;
        }

        if (action === "TRIGGER_OCR") {
          await chrome.runtime.sendMessage({
            type: "TRIGGER_OCR",
            target: "background",
          });
          showSuccessToast("Image OCR queued.", { id: retryToastId, tempo: "quick" });
          return;
        }

        if (action === "REBUILD_INDEX") {
          await chrome.runtime.sendMessage({
            service: "items",
            type: "markSearchIndexDirty",
            target: "offscreen",
          });
          setRefreshToken((value) => value + 1);
          showSuccessToast("Search index rebuild queued.", { id: retryToastId, tempo: "quick" });
          return;
        }

        if (action === "REBUILD_VECTORS") {
          await chrome.runtime.sendMessage({
            service: "sync",
            type: "rebuildAndCompact",
            target: "offscreen",
            payload: { reembedMissing: true },
          });
          showSuccessToast("Vector rebuild started.", { id: retryToastId, tempo: "quick" });
          return;
        }

        if (action === "LOCK_PRIVATE_SPACE") {
          await lockPrivateSpace("Private space locked.");
          showSuccessToast("Private space lock requested.", { id: retryToastId, tempo: "quick" });
          return;
        }

        if (action === "RETRY_IMPORT") {
          const retryResponse = await chrome.runtime.sendMessage({
            target: "background",
            type: "IMPORT_RETRY_FAILED",
            payload: { statusId: status.id },
          });
          if (!retryResponse?.success) {
            throw new Error(retryResponse?.error || "Import retry failed.");
          }
          clearProcessStatus(status.id);
          showSuccessToast("Import retry queued.", { id: retryToastId, tempo: "quick" });
        }
      } catch (retryError) {
        const retryMessage = resolveToastErrorMessage(retryError, "Retry request failed.");
        upsertProcessStatus({
          ...status,
          state: "error",
          detail: retryMessage,
          updatedAt: Date.now(),
        });
        showErrorToast(retryMessage, { id: retryToastId });
      } finally {
        setRetryingProcessId(null);
      }
    },
    [clearProcessStatus, lockPrivateSpace, upsertProcessStatus]
  );

  const resolveFolderFilterValues = (values: string[]): string[] => {
    return resolveNamedFilterValues(values, folders);
  };

  const resolveSpaceFilterValues = (values: string[]): string[] => {
    return resolveNamedFilterValues(values, spaces);
  };

  const sendMessageWithTimeout = useCallback(
    async <T,>(message: unknown, timeoutMs: number): Promise<T> => {
      let timeoutId: number | null = null;
      const timeoutPromise = new Promise<T>((_, reject) => {
        timeoutId = window.setTimeout(() => {
          reject(new Error(`Search request timed out after ${timeoutMs}ms.`));
        }, timeoutMs);
      });

      try {
        return await Promise.race([
          chrome.runtime.sendMessage(message) as Promise<T>,
          timeoutPromise,
        ]);
      } finally {
        if (timeoutId !== null) {
          window.clearTimeout(timeoutId);
        }
      }
    },
    []
  );

  const flushMetadataItemPatches = useCallback(async () => {
    metadataPatchTimerRef.current = null;
    const itemIds = Array.from(pendingMetadataItemIdsRef.current);
    pendingMetadataItemIdsRef.current.clear();
    if (itemIds.length === 0) return;

    try {
      const response = await sendMessageWithTimeout<{
        success?: boolean;
        payload?: ItemDocType[];
      }>({
        service: "items",
        type: "getByIds",
        target: "offscreen",
        payload: {
          itemIds,
          spaceIds: activeSpaceGroupId ? activeSpaceGroupSpaceIds : undefined,
          accessContext: {
            activeSpaceId,
            searchScope: activeSpaceGroupId ? "global" : requestedScope,
          },
        },
      }, QUERY_REQUEST_TIMEOUT_MS);
      if (!response?.success || !Array.isArray(response.payload)) return;

      startTransition(() => {
        setItems((current) => mergeItemsById(current, response.payload || []));
      });
    } catch (patchError) {
      console.warn("Failed to patch enriched search items:", patchError);
    }
  }, [
    activeSpaceGroupId,
    activeSpaceGroupSpaceIds,
    activeSpaceId,
    requestedScope,
    sendMessageWithTimeout,
  ]);

  const queueMetadataItemPatches = useCallback(
    (changedItemIds: string[]): boolean => {
      let hasVisibleChange = false;
      for (const itemId of changedItemIds) {
        if (!visibleItemIdsRef.current.has(itemId)) continue;
        pendingMetadataItemIdsRef.current.add(itemId);
        hasVisibleChange = true;
      }
      if (!hasVisibleChange || metadataPatchTimerRef.current !== null) return hasVisibleChange;

      metadataPatchTimerRef.current = window.setTimeout(() => {
        void flushMetadataItemPatches();
      }, 120);
      return true;
    },
    [flushMetadataItemPatches]
  );

  const executeQuery = useCallback(async () => {
    const requestId = ++requestIdRef.current;
    const requestStartedAt = performance.now();
    const analysisCurrent = queryAnalysis.input === queryText;
    const effectiveDirectives = analysisCurrent ? queryAnalysis.directives : {};
    const effectiveFilters = analysisCurrent ? queryAnalysis.filters : defaultAnalysis.filters;
    const freeText = analysisCurrent ? queryAnalysis.freeText.trim() : queryText.trim();
    const mode = effectiveMode;
    const modeFeatures = resolveEffectiveQueryChannels({
      requested: getQueryModeFeatures(mode),
      query: freeText,
      vectorMinChars: VECTOR_QUERY_MIN_CHARS,
    });
    const useLexicalSearch = modeFeatures.keyword || modeFeatures.fuzzy;
    const canUseVector = modeFeatures.vector;
    const useCursorPagination = shouldUseCursorPagination(effectiveDirectives.page);
    const page = effectiveDirectives.page ?? cursorPage;

    const parsedFolderIds = resolveFolderFilterValues(effectiveFilters.folderIds);
    const parsedExcludeFolderIds = resolveFolderFilterValues(effectiveFilters.excludeFolderIds);
    const parsedSpaceIds = resolveSpaceFilterValues(effectiveFilters.spaceIds);
    const parsedExcludeSpaceIds = resolveSpaceFilterValues(effectiveFilters.excludeSpaceIds);
    // Browsing stays inside the space/collection you're navigating; searching is
    // decoupled from the sidebar and honours the scope chip choice.
    let scopedSpaceIds: string[];
    let accessScope: QueryScope;
    if (!hasActiveQuery) {
      scopedSpaceIds = resolveSearchSpaceIds({
        activeSpaceId,
        activeSpaceGroupId,
        activeSpaceGroupSpaceIds,
        requestedScope: "current",
        requestedSpaceIds: parsedSpaceIds,
      });
      accessScope = activeSpaceGroupId ? "global" : "current";
    } else {
      scopedSpaceIds = resolveSearchSpaceIds({
        activeSpaceId,
        activeSpaceGroupId: null,
        activeSpaceGroupSpaceIds: [],
        requestedScope,
        requestedSpaceIds: parsedSpaceIds,
      });
      accessScope = requestedScope;
    }

    const includeFolderIds = resolveSearchFolderFilterIds({
      hasActiveQuery,
      parsedFolderIds,
      selectedFolderId,
    });

    const limit = effectiveDirectives.limit ?? (hasActiveQuery ? SEARCH_PAGE_SIZE : DEFAULT_QUERY_LIMIT);

    const sortBy: QuerySortBy =
      effectiveDirectives.sortBy || (freeText.length > 0 ? "relevance" : "createdAt");
    const sortOrder: QuerySortOrder = effectiveDirectives.sortOrder || "desc";

    const querySignature = JSON.stringify({
      freeText,
      mode,
      page,
      limit,
      sortBy,
      sortOrder,
      scopedSpaceIds,
      includeFolderIds,
      filters: effectiveFilters,
      cursorPage: useCursorPagination ? cursorPage : null,
    });
    // A re-run with an identical signature is a background data refresh (e.g.
    // metadata streaming in on a constrained/vector query). Don't flip the row
    // to "processing" for those — that was the constant blinking. User-initiated
    // queries (new text/filter/space/page) have a different signature and still
    // show the searching indicator.
    const isBackgroundRefresh = querySignature === querySignatureRef.current;
    querySignatureRef.current = querySignature;

    setError(null);
    if (!isBackgroundRefresh) {
      setIsLoading(true);
      upsertProcessStatus({
        id: "search-query",
        label: "Search query",
        state: "processing",
        detail: `Searching local data... mode:${mode}`,
        updatedAt: Date.now(),
      });
    }

    try {
      const runQueryPage = async (pageToLoad: number, afterCursorToUse?: RankQueryCursor | null) => {
        const response = await sendMessageWithTimeout<any>({
          service: "items",
          type: "queryLocal",
          target: "offscreen",
          payload: {
            searchClientId,
            query: freeText,
            text: {
              groups: analysisCurrent ? queryAnalysis.textGroups : [],
              excludedTerms: analysisCurrent ? queryAnalysis.excludedTerms : [],
              expression: analysisCurrent ? queryAnalysis.textExpression : undefined,
            },
            useVector: canUseVector,
            useKeyword: useLexicalSearch && modeFeatures.keyword,
            useFuzzy: useLexicalSearch && modeFeatures.fuzzy,
            minScore: effectiveDirectives.minScore,
            topK: getSearchScoreBudget({
              page: pageToLoad,
              limit,
              minimum: MIN_SCORE_BUDGET,
              maximum: MAX_VECTOR_TOPK,
              multiplier: SCORE_BUDGET_MULTIPLIER,
            }),
            pagination: {
              page: pageToLoad,
              limit,
              afterCursor: useCursorPagination ? afterCursorToUse : undefined,
            },
            filters: {
              spaceIds: scopedSpaceIds,
              excludeSpaceIds:
                parsedExcludeSpaceIds.length > 0 ? parsedExcludeSpaceIds : undefined,
              folderIds: includeFolderIds.length > 0 ? includeFolderIds : undefined,
              excludeFolderIds: parsedExcludeFolderIds.length > 0 ? parsedExcludeFolderIds : undefined,
              sources: effectiveFilters.sources.length > 0 ? effectiveFilters.sources : undefined,
              excludeSources:
                effectiveFilters.excludeSources.length > 0 ? effectiveFilters.excludeSources : undefined,
              favoritesOnly: effectiveFilters.favoritesOnly,
              tagNames: effectiveFilters.tagNames,
              excludeTagNames: effectiveFilters.excludeTagNames,
              domains: effectiveFilters.domains,
              excludeDomains: effectiveFilters.excludeDomains,
              authors: effectiveFilters.authors,
              excludeAuthors: effectiveFilters.excludeAuthors,
              hasAny: effectiveFilters.hasAny,
              excludeHasAny: effectiveFilters.excludeHasAny,
              dateFrom: effectiveFilters.dateFrom,
              dateTo: effectiveFilters.dateTo,
              createdFrom: effectiveFilters.createdFrom,
              createdTo: effectiveFilters.createdTo,
              updatedFrom: effectiveFilters.updatedFrom,
              updatedTo: effectiveFilters.updatedTo,
              likesMin: effectiveFilters.likesMin,
              likesMax: effectiveFilters.likesMax,
              upvotesMin: effectiveFilters.upvotesMin,
              upvotesMax: effectiveFilters.upvotesMax,
            },
            sort: {
              by: sortBy,
              order: sortOrder,
            },
            accessContext: {
              activeSpaceId,
              searchScope: accessScope,
            },
            debug: isDebugSearchEnabled,
          },
        }, QUERY_REQUEST_TIMEOUT_MS);

        if (!response?.success) {
          throw new Error(response?.error || "Failed to run local query.");
        }

        return response.payload as SearchQueryPayload;
      };

      let payload = await runQueryPage(page, cursorAfter);

      if (requestId !== requestIdRef.current) {
        staleSuppressedCountRef.current += 1;
        setStaleSuppressedCount(staleSuppressedCountRef.current);
        return;
      }

      // A newer search generation replaced this one in the controller. Benign:
      // keep the currently rendered results instead of flashing empty state.
      if (payload?.superseded) {
        return;
      }

      const pageItems = payload.items || [];
      const nextItems = includePendingRevealItem(pageItems, pendingRevealItemRef.current, {
        activeSpaceId,
        activeSpaceGroupId,
        selectedFolderId,
      });
      setItems(nextItems);
      setResultDebug(isDebugSearchEnabled ? payload.debug || null : null);
      setResultMeta({
        total: payload.total || 0,
        totalIsExact: payload.totalIsExact !== false,
        vectorHits: payload.vectorHits || 0,
        lexicalHits: payload.lexicalHits || 0,
        vectorError: payload.vectorError || null,
        page: payload.page || page,
        limit: payload.limit || limit,
        hasMore: payload.hasMore === true,
        nextCursor: payload.nextCursor || null,
        mode,
      });

      const diagnostics = payload.diagnostics;
      const roundTripMs = Math.max(0, performance.now() - requestStartedAt);
      const bridgeMs = diagnostics
        ? Math.max(0, roundTripMs - diagnostics.totalMs)
        : roundTripMs;
      const uiSubmitWaitMs = Math.max(0, querySubmitMeta?.uiDebounceWaitMs || 0);
      const formatMs = (value: number) => `${Math.max(0, Math.round(value))}ms`;
      const diagnosticsDetail =
        diagnostics && isDebugSearchEnabled
          ? ` • ${diagnostics.candidateCount.toLocaleString()} candidates • ranked ${diagnostics.rankInputCount.toLocaleString()} • budget ${diagnostics.scoreBudget.toLocaleString()} • ${diagnostics.supersededCount} superseded • ${diagnostics.fallbackCount} fallback • stale:${staleSuppressedCountRef.current} • timings: ${formatMs(uiSubmitWaitMs)} submit-wait, ${formatMs(bridgeMs)} bridge, ${formatMs(diagnostics.selectorMs)} selector, ${formatMs(diagnostics.filterMs)} filter, ${formatMs(diagnostics.lexicalMs)} lexical, ${formatMs(diagnostics.vectorEmbedMs)} vector-embed, ${formatMs(diagnostics.vectorScanMs)} vector-scan, ${formatMs(diagnostics.rankMs)} rank, ${formatMs(diagnostics.hydrateMs)} hydrate, ${formatMs(diagnostics.totalMs)} backend, ${formatMs(roundTripMs)} round-trip`
          : "";

      upsertProcessStatus({
        id: "search-query",
        label: "Search query",
        state: "success",
        detail:
          payload.totalIsExact === false
            ? `Loaded ${(payload.items || []).length} results; more are available${diagnosticsDetail}.`
            : `Loaded ${(payload.items || []).length} of ${payload.total || 0} results${diagnosticsDetail}.`,
        updatedAt: Date.now(),
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

      const nextDomains = unique(
        (payload.items || [])
          .map((item) => parseDomain(item.url || ""))
          .filter((domain): domain is string => !!domain)
      ).slice(0, 120);
      if (nextDomains.length > 0) {
        setDomainsCatalog((prev) => {
          const merged = unique([...nextDomains, ...prev]).slice(0, 240);
          return sameStringArray(prev, merged) ? prev : merged;
        });
      }
      const nextAuthors = unique(
        (payload.items || [])
          .map((item) => (item.authorUsername || "").trim().toLowerCase())
          .filter(Boolean)
      ).slice(0, 180);
      if (nextAuthors.length > 0) {
        setAuthorsCatalog((prev) => {
          const merged = unique([...nextAuthors, ...prev]).slice(0, 280);
          return sameStringArray(prev, merged) ? prev : merged;
        });
      }

      const resultItems = payload.items || [];
      const nextFilterTokens = unique([
        ...resultItems.map((item) => `source:${item.source}`),
        ...(resultItems.some((item) => item.isFavorite) ? ["is:favorite"] : []),
        ...(resultItems.some((item) => item.media?.some((m) => m.type === "image"))
          ? ["has:image"]
          : []),
      ]);
      if (nextFilterTokens.length > 0) {
        setAvailableFilters((prev) => {
          const merged = unique([...prev, ...nextFilterTokens]);
          return sameStringArray(prev, merged) ? prev : merged;
        });
      }

      if (isDebugSearchEnabled && diagnostics) {
        console.groupCollapsed(
          `[SearchDebug][${diagnostics.queryHash}] "${freeText || "<empty>"}" (${mode})`
        );
        console.log("scope", requestedScope);
        console.log("counts", {
          total: payload.total || 0,
          shown: (payload.items || []).length,
          vectorHits: payload.vectorHits || 0,
          lexicalHits: payload.lexicalHits || 0,
          staleSuppressed: staleSuppressedCountRef.current,
        });
        console.log("timings", {
          uiSubmitWaitMs,
          bridgeMs,
          selectorMs: diagnostics.selectorMs,
          filterMs: diagnostics.filterMs,
          lexicalMs: diagnostics.lexicalMs,
          vectorEmbedMs: diagnostics.vectorEmbedMs,
          vectorScanMs: diagnostics.vectorScanMs,
          vectorMs: diagnostics.vectorMs,
          rankMs: diagnostics.rankMs,
          hydrateMs: diagnostics.hydrateMs,
          backendTotalMs: diagnostics.totalMs,
          roundTripMs,
        });
        if (payload.debug?.vectorTopHits?.length) {
          console.table(payload.debug.vectorTopHits.slice(0, 8));
        }
        if (payload.debug?.vectorStats) {
          console.log("vectorStats", payload.debug.vectorStats);
        }
        if (payload.debug?.perItem?.length) {
          console.table(payload.debug.perItem.slice(0, 12));
        }
        console.groupEnd();
      }

      persistRecentQuery(queryText);
    } catch (queryError) {
      if (requestId !== requestIdRef.current) {
        staleSuppressedCountRef.current += 1;
        setStaleSuppressedCount(staleSuppressedCountRef.current);
        return;
      }
      const message = queryError instanceof Error ? queryError.message : "Failed to run query.";
      setError(message);
      if (!shouldPreserveSearchResultsForError(message)) {
        setItems([]);
        setResultDebug(null);
        setResultMeta({
          total: 0,
          totalIsExact: true,
          vectorHits: 0,
          lexicalHits: 0,
          vectorError: null,
          page,
          limit,
          hasMore: false,
          nextCursor: null,
          mode,
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
      if (requestId === requestIdRef.current) {
        setIsLoading(false);
      }
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
    queryAnalysis,
    querySubmitMeta,
    queryText,
    requestedScope,
    searchClientId,
    selectedFolderId,
    sendMessageWithTimeout,
    spaces,
    upsertProcessStatus,
  ]);

  const showEmptySearchState = !isLoading && !error && resultMeta.total === 0;

  useEffect(() => {
    void loadFolders({
      activeSpaceId,
      searchScope: activeSpaceGroupId ? "global" : requestedScope,
      spaceIds: activeSpaceGroupId ? activeSpaceGroupSpaceIds : undefined,
    });
  }, [activeSpaceGroupId, activeSpaceGroupSpaceIds, activeSpaceId, isPrivateUnlocked, loadFolders, requestedScope]);

  useEffect(() => {
    loadTags();
  }, [loadTags]);

  useEffect(() => {
    void loadSpaces();
    void loadSpaceGroups();
    void loadBinContents();
  }, [loadBinContents, loadSpaceGroups, loadSpaces]);

  useEffect(() => {
    chrome.storage.local.get("sidePanelOpen", (result) => {
      if (result.sidePanelOpen !== undefined) {
        setIsOpen(result.sidePanelOpen);
      }
    });

    const onMessage = (msg: any) => {
      if (msg?.type === "PROCESS_STATUS" && msg.payload) {
        const payload = msg.payload as Partial<SearchProcessStatusItem>;
        if (
          typeof payload.id === "string" &&
          typeof payload.label === "string" &&
          typeof payload.detail === "string" &&
          typeof payload.updatedAt === "number" &&
          (payload.state === "processing" || payload.state === "success" || payload.state === "error")
        ) {
          upsertProcessStatus({
            id: payload.id,
            label: payload.label,
            state: payload.state,
            detail: payload.detail,
            updatedAt: payload.updatedAt,
            retryAction: payload.retryAction as SearchProcessRetryAction | undefined,
          });
        }
        return;
      }

      if (msg?.type !== "DB_CHANGE") return;

      if (msg.scope === "tags") {
        scheduleTagReload();
        return;
      }

      if (msg.scope === "folders") {
        void loadFolders({
          activeSpaceId,
          searchScope: activeSpaceGroupId ? "global" : requestedScope,
          spaceIds: activeSpaceGroupId ? activeSpaceGroupSpaceIds : undefined,
        });
        void loadBinContents();
      }

      if (msg.scope === "space_groups") {
        void loadSpaceGroups();
        return;
      }

      if (msg.scope === "spaces") {
        void loadSpaces();
        void loadSpaceGroups();
        void loadBinContents();
        void loadFolders({
          activeSpaceId,
          searchScope: activeSpaceGroupId ? "global" : requestedScope,
          spaceIds: activeSpaceGroupId ? activeSpaceGroupSpaceIds : undefined,
        });
        scheduleQueryRefresh("high");
        return;
      }

      if (msg.scope === "items" || msg.scope === "folders") {
        // Metadata enrichment can emit continuously while a large library is
        // being indexed. It does not change bin membership, so do not rescan
        // the full bin on every title/OCR/media patch; opening the bin always
        // refreshes page one.
        if (msg.scope === "items" && msg.itemChangeKind !== "metadata") {
          void loadBinContents();
        }
        scheduleTagReload();
        if (msg.scope === "items" && Array.isArray(msg.changedItemIds) && msg.changedItemIds.length > 0) {
          const changedIds: string[] = msg.changedItemIds.filter(
            (id: unknown): id is string => typeof id === "string"
          );
          if (msg.itemChangeKind === "metadata") {
            queueMetadataItemPatches(changedIds);
            if (!hasConstrainedQueryRef.current) return;
            scheduleQueryRefresh("low");
            return;
          }
          const hasVisibleImpact = changedIds.some((id) => visibleItemIdsRef.current.has(id));
          if (!hasVisibleImpact && hasConstrainedQueryRef.current) {
            scheduleQueryRefresh("low");
            return;
          }
        }
        scheduleQueryRefresh("high");
      }
    };

    chrome.runtime.onMessage.addListener(onMessage);
    return () => {
      chrome.runtime.onMessage.removeListener(onMessage);
      if (refreshTimerRef.current !== null) {
        window.clearTimeout(refreshTimerRef.current);
        refreshTimerRef.current = null;
      }
      if (tagReloadTimerRef.current !== null) {
        window.clearTimeout(tagReloadTimerRef.current);
        tagReloadTimerRef.current = null;
      }
    };
  }, [
    activeSpaceGroupId,
    activeSpaceGroupSpaceIds,
    activeSpaceId,
    loadFolders,
    loadSpaceGroups,
    loadSpaces,
    queueMetadataItemPatches,
    requestedScope,
    scheduleQueryRefresh,
    scheduleTagReload,
    upsertProcessStatus,
  ]);

  useEffect(() => {
    void executeQuery();
  }, [refreshToken]);

  const togglePanel = () => {
    const newState = !isOpen;
    setIsOpen(newState);
    chrome.storage.local.set({ sidePanelOpen: newState });
  };

  const setPageDirective = (nextPage: number) => {
    const safePage = Math.max(1, Math.floor(nextPage));
    const nextQueryText = (() => {
      const token = `page:${safePage}`;
      if (/\bpage:\d+\b/i.test(queryText)) {
        return queryText.replace(/\bpage:\d+\b/i, token);
      }
      return `${queryText.trim()} ${token}`.trim();
    })();
    const nextAnalysis = analyzeQuery({
      type: "ANALYZE_QUERY",
      requestId: Date.now(),
      input: nextQueryText,
      cursor: nextQueryText.length,
      forceSuggestions: false,
      catalogs,
    });
    setQueryText(nextQueryText);
    setQueryAnalysis(nextAnalysis);
    setQuerySubmitMeta({
      requestId: nextAnalysis.requestId,
      submittedAt: Date.now(),
      uiDebounceWaitMs: 0,
    });
    setCursorAfter(null);
    setCursorPage(1);
    setCursorHistory([]);
    setRefreshToken((value) => value + 1);
  };

  const useCursorPagination = shouldUseCursorPagination(queryAnalysis.directives.page);
  const prevDisabled = isLoading || (useCursorPagination ? cursorHistory.length === 0 : resultMeta.page <= 1);
  const nextDisabled = isLoading || (useCursorPagination ? !resultMeta.nextCursor : !resultMeta.hasMore);
  const resultModeFeatures = getQueryModeFeatures(resultMeta.mode);

  const goPrevPage = () => {
    if (!useCursorPagination) {
      setPageDirective(resultMeta.page - 1);
      return;
    }
    if (cursorHistory.length === 0) return;
    const previousCursor = cursorHistory[cursorHistory.length - 1] ?? null;
    setCursorHistory(cursorHistory.slice(0, -1));
    setCursorAfter(previousCursor);
    setCursorPage((value) => Math.max(1, value - 1));
    setRefreshToken((value) => value + 1);
    window.scrollTo({ top: 0, behavior: "smooth" });
  };

  const goNextPage = () => {
    if (!useCursorPagination) {
      setPageDirective(resultMeta.page + 1);
      return;
    }
    if (!resultMeta.nextCursor) return;
    setCursorHistory((previous) => [...previous, cursorAfter]);
    setCursorAfter(resultMeta.nextCursor);
    setCursorPage((value) => value + 1);
    setRefreshToken((value) => value + 1);
    window.scrollTo({ top: 0, behavior: "smooth" });
  };

  const [nowTick, setNowTick] = useState<number>(() => Date.now());
  useEffect(() => {
    if (binEntries.length === 0) return;
    const timer = window.setInterval(() => setNowTick(Date.now()), 60_000);
    return () => window.clearInterval(timer);
  }, [binEntries.length]);

  const sidebarSpaces = useMemo<SidebarSpace[]>(
    () => spaces.map((space) => ({ ...space, deletedAt: (space as any).deletedAt ?? 0, purgeAt: (space as any).purgeAt ?? 0 })),
    [spaces]
  );
  const refreshSidebarFolders = useCallback(() => {
    void loadFolders({
      activeSpaceId,
      searchScope: activeSpaceGroupId ? "global" : requestedScope,
      spaceIds: activeSpaceGroupId ? activeSpaceGroupSpaceIds : undefined,
    });
  }, [activeSpaceGroupId, activeSpaceGroupSpaceIds, activeSpaceId, loadFolders, requestedScope]);

  const sidebarHandlers = useMemo<SidebarHandlers>(() => ({
    selectSpace: (space) => {
      void handleSelectSpace(space as SpaceListItem);
    },
    selectSpaceGroup: (group) => handleSelectSpaceGroup(group),
    selectFolder: (folderId) => {
      // Selecting a tab group narrows the browse view to that folder, so the
      // items must be re-queried for it (the browse query only loads a limited
      // page across the scope). Bump refreshToken to re-run executeQuery, the
      // same trigger the space / space-group handlers use. Without this the
      // folder shows whatever was already loaded — often nothing — until a
      // full page reload re-runs the query.
      pendingUrlFolderIdRef.current = null;
      if (folderId !== "all") {
        const context = resolveFolderSelectionContext(folderId, folders, spaces);
        if (context) {
          setActiveSpaceId(context.activeSpaceId);
          setActiveSpaceGroupId(null);
        }
      }
      setSelectedFolderId(folderId);
      setRefreshToken((value) => value + 1);
    },
    toggleSpaceGroupCollapse: (group) => { void toggleSpaceGroupCollapsed(group); },
    toggleFolderCollapse: async (folder) => {
      try {
        const response = await chrome.runtime.sendMessage({
          service: "folders",
          type: "setCollapsed",
          target: "offscreen",
          payload: { id: folder.id, value: !folder.isCollapsed },
        });
        if (!response?.success) return;
        setFolders((current) => current.map((entry) =>
          entry.id === folder.id ? { ...entry, isCollapsed: !folder.isCollapsed } : entry
        ));
      } catch (toggleError) {
        console.error("Failed to toggle folder collapse", toggleError);
      }
    },
    pinFolder: async (folder, value) => {
      try {
        const response = await chrome.runtime.sendMessage({
          service: "folders",
          type: "setPinned",
          target: "offscreen",
          payload: { id: folder.id, value },
        });
        if (!response?.success) return;
        setFolders((current) => current.map((entry) =>
          entry.id === folder.id ? { ...entry, isPinned: value, updatedAt: Date.now() } : entry
        ));
      } catch (pinError) {
        console.error("Failed to toggle folder pin", pinError);
      }
    },
    reorderFolders: async (orderedIds, spaceId, parentId) => {
      try {
        await chrome.runtime.sendMessage({
          service: "folders",
          type: "reorder",
          target: "offscreen",
          payload: { orderedIds, spaceId, parentId },
        });
      } catch (reorderError) {
        console.error("Failed to reorder folders", reorderError);
      }
      refreshSidebarFolders();
    },
    moveFolderToParent: async (folderId, parentId) => {
      try {
        const response = await chrome.runtime.sendMessage({
          service: "folders",
          type: "moveToParent",
          target: "offscreen",
          payload: { folderId, parentId },
        });
        if (!response?.success) {
          showErrorToast(response?.error || "Could not move tab group.");
          return;
        }
        showSuccessToast("Tab group moved.");
      } catch (moveError) {
        showErrorToast(moveError instanceof Error ? moveError.message : "Could not move tab group.");
      }
      refreshSidebarFolders();
    },
    moveFolderToSpace: async (folderId, spaceId) => {
      try {
        const response = await chrome.runtime.sendMessage({
          service: "folders",
          type: "moveToSpace",
          target: "offscreen",
          payload: { folderId, targetSpaceId: spaceId },
        });
        if (!response?.success) throw new Error(response?.error || "Could not move tab group.");
        showSuccessToast("Tab group moved.");
      } catch (moveError) {
        showErrorToast(moveError instanceof Error ? moveError.message : "Could not move tab group.");
      }
      refreshSidebarFolders();
    },
    moveFolderToSpaceGroup: async (folderId, spaceGroupId) => {
      try {
        const targetResponse = await chrome.runtime.sendMessage({
          service: "spaceGroups",
          type: "resolveDropSpace",
          target: "offscreen",
          payload: { spaceGroupId },
        });
        const targetSpaceId = targetResponse?.payload?.id as string | undefined;
        if (!targetResponse?.success || !targetSpaceId) throw new Error(targetResponse?.error || "Could not resolve space group.");
        const response = await chrome.runtime.sendMessage({
          service: "folders",
          type: "moveToSpace",
          target: "offscreen",
          payload: { folderId, targetSpaceId },
        });
        if (!response?.success) throw new Error(response?.error || "Could not move tab group.");
        showSuccessToast("Tab group moved.");
      } catch (moveError) {
        showErrorToast(moveError instanceof Error ? moveError.message : "Could not move tab group.");
      }
      refreshSidebarFolders();
    },
    renameFolder: async (id, name) => {
      try {
        const response = await chrome.runtime.sendMessage({
          service: "folders",
          type: "rename",
          target: "offscreen",
          payload: { id, name },
        });
        if (!response?.success) return;
        setFolders((current) => current.map((entry) =>
          entry.id === id ? { ...entry, name, updatedAt: Date.now() } : entry
        ));
      } catch (renameError) {
        showErrorToast(renameError instanceof Error ? renameError.message : "Rename failed.");
      }
    },
    createFolder: async (name, spaceId, parentId) => {
      try {
        const response = await chrome.runtime.sendMessage({
          service: "folders",
          type: "create",
          target: "offscreen",
          payload: { name, spaceId, parentId },
        });
        if (!response?.success) {
          showErrorToast(response?.error || "Could not create tab group.");
          return;
        }
        showSuccessToast("Tab group created.");
      } catch (createError) {
        showErrorToast(createError instanceof Error ? createError.message : "Could not create tab group.");
      }
      refreshSidebarFolders();
    },
    deleteFolder: async (id, alsoDeleteItems) => {
      try {
        const response = await chrome.runtime.sendMessage({
          service: "folders",
          type: "delete",
          target: "offscreen",
          payload: { id, alsoDeleteItems },
        });
        if (!response?.success) {
          showErrorToast(response?.error || "Could not delete tab group.");
          return;
        }
        showSuccessToast("Tab group moved to Bin.");
      } catch (deleteError) {
        showErrorToast(deleteError instanceof Error ? deleteError.message : "Could not delete tab group.");
      }
      refreshSidebarFolders();
    },
    getFolderItemCount: async (ids) => {
      try {
        const response = await sendMessageWithTimeout<{
          success?: boolean;
          payload?: Record<string, number>;
        }>({
          service: "folders",
          type: "countItemsInTree",
          target: "offscreen",
          payload: { ids },
        }, QUERY_REQUEST_TIMEOUT_MS);
        return response?.payload || {};
      } catch {
        return {};
      }
    },
    renameSpace: async (id, name) => {
      try {
        const response = await chrome.runtime.sendMessage({
          service: "spaces",
          type: "renameSpace",
          target: "offscreen",
          payload: { id, name },
        });
        if (!response?.success) {
          showErrorToast(response?.error || "Could not rename space.");
          return;
        }
        showSuccessToast("Space renamed.");
      } catch (renameError) {
        showErrorToast(renameError instanceof Error ? renameError.message : "Could not rename space.");
      }
      void loadSpaces();
    },
    moveSpaceToGroup: async (id, groupId) => {
      try {
        const response = await chrome.runtime.sendMessage({
          service: "spaces",
          type: "moveToSpaceGroup",
          target: "offscreen",
          payload: { spaceId: id, spaceGroupId: groupId },
        });
        if (!response?.success) {
          showErrorToast(response?.error || "Could not move space.");
          return;
        }
        showSuccessToast("Space moved.");
      } catch (moveError) {
        showErrorToast(moveError instanceof Error ? moveError.message : "Could not move space.");
      }
      void loadSpaces();
    },
    lockSpace: (space) => {
      if (space.id !== PRIVATE_SPACE_ID) return;
      void lockPrivateSpace("Private space locked.");
    },
    reorderSpaces: async (orderedIds, groupId) => {
      try {
        await chrome.runtime.sendMessage({
          service: "spaces",
          type: "reorderSpaces",
          target: "offscreen",
          payload: { orderedIds, spaceGroupId: groupId },
        });
      } catch (reorderError) {
        console.error("Failed to reorder spaces", reorderError);
      }
      void loadSpaces();
    },
    moveSpaceToBin: async (id) => {
      try {
        const response = await chrome.runtime.sendMessage({
          service: "spaces",
          type: "moveToBin",
          target: "offscreen",
          payload: { id },
        });
        if (!response?.success) {
          showErrorToast(response?.error || "Could not move space to bin.");
          return;
        }
        showSuccessToast("Space moved to bin. Restore from Bin within 30 days.");
        if (activeSpaceId === id) {
          setActiveSpaceId(PUBLIC_SPACE_ID);
          setActiveSpaceGroupId(null);
        }
      } catch (binError) {
        showErrorToast(binError instanceof Error ? binError.message : "Could not move space to bin.");
      }
      void loadSpaces();
      void loadBinContents();
    },
    restoreSpaceFromBin: async (id) => {
      try {
        const response = await chrome.runtime.sendMessage({
          service: "spaces",
          type: "restoreFromBin",
          target: "offscreen",
          payload: { id },
        });
        if (!response?.success) {
          showErrorToast(response?.error || "Could not restore space.");
          return;
        }
        const result = response.payload as { message?: string; relocated?: boolean } | undefined;
        showSuccessToast(result?.message || "Space restored.", {
          tempo: result?.relocated ? "long" : "default",
        });
      } catch (restoreError) {
        showErrorToast(restoreError instanceof Error ? restoreError.message : "Could not restore space.");
      }
      void loadSpaces();
      void loadBinContents();
    },
    deleteSpaceForever: async (id, expectedDeletedAt) => {
      try {
        const response = await chrome.runtime.sendMessage({
          service: "spaces",
          type: "deleteSpaceForever",
          target: "offscreen",
          payload: { id, expectedDeletedAt },
        });
        if (!response?.success) {
          showErrorToast(response?.error || "Could not delete space.");
          return;
        }
        showSuccessToast("Space permanently deleted.");
      } catch (deleteError) {
        showErrorToast(deleteError instanceof Error ? deleteError.message : "Could not delete space.");
      }
      void loadSpaces();
      void loadBinContents();
    },
    restoreFolderFromBin: async (id) => {
      try {
        const response = await chrome.runtime.sendMessage({
          service: "folders",
          type: "restoreFromBin",
          target: "offscreen",
          payload: { id },
        });
        if (!response?.success) {
          showErrorToast(response?.error || "Could not restore folder.");
          return;
        }
        const result = response.payload as { message?: string; relocated?: boolean } | undefined;
        showSuccessToast(result?.message || "Folder restored.", {
          tempo: result?.relocated ? "long" : "default",
        });
      } catch (restoreError) {
        showErrorToast(restoreError instanceof Error ? restoreError.message : "Could not restore folder.");
      }
      refreshSidebarFolders();
      void loadBinContents();
      scheduleQueryRefresh("high");
    },
    deleteFolderForever: async (id, expectedDeletedAt) => {
      try {
        const response = await chrome.runtime.sendMessage({
          service: "folders",
          type: "deleteForever",
          target: "offscreen",
          payload: { id, expectedDeletedAt },
        });
        if (!response?.success) {
          showErrorToast(response?.error || "Could not delete folder.");
          return;
        }
        showSuccessToast("Folder permanently deleted.");
      } catch (deleteError) {
        showErrorToast(deleteError instanceof Error ? deleteError.message : "Could not delete folder.");
      }
      refreshSidebarFolders();
      void loadBinContents();
      scheduleQueryRefresh("high");
    },
    restoreItemFromBin: async (id) => {
      try {
        const response = await chrome.runtime.sendMessage({
          service: "items",
          type: "restoreFromBin",
          target: "offscreen",
          payload: { id },
        });
        if (!response?.success) {
          showErrorToast(response?.error || "Could not restore saved tab.");
          return;
        }
        const result = response.payload as { message?: string; relocated?: boolean } | undefined;
        showSuccessToast(result?.message || "Saved tab restored.", {
          tempo: result?.relocated ? "long" : "default",
        });
      } catch (restoreError) {
        showErrorToast(restoreError instanceof Error ? restoreError.message : "Could not restore saved tab.");
      }
      void loadBinContents();
      scheduleQueryRefresh("high");
    },
    deleteItemForever: async (id, expectedDeletedAt) => {
      try {
        const response = await chrome.runtime.sendMessage({
          service: "items",
          type: "deleteForever",
          target: "offscreen",
          payload: { id, expectedDeletedAt },
        });
        if (!response?.success) {
          showErrorToast(response?.error || "Could not delete saved tab.");
          return;
        }
        showSuccessToast("Saved tab permanently deleted.");
      } catch (deleteError) {
        showErrorToast(deleteError instanceof Error ? deleteError.message : "Could not delete saved tab.");
      }
      void loadBinContents();
      scheduleQueryRefresh("high");
    },
    reorderSpaceGroups: async (orderedIds) => {
      try {
        await chrome.runtime.sendMessage({
          service: "spaceGroups",
          type: "reorderSpaceGroups",
          target: "offscreen",
          payload: { orderedIds },
        });
      } catch (reorderError) {
        console.error("Failed to reorder space groups", reorderError);
      }
      void loadSpaceGroups();
    },
    renameSpaceGroup: async (id, name) => {
      try {
        const response = await chrome.runtime.sendMessage({
          service: "spaceGroups",
          type: "renameSpaceGroup",
          target: "offscreen",
          payload: { id, name },
        });
        if (!response?.success) {
          showErrorToast(response?.error || "Could not rename space group.");
          return;
        }
        showSuccessToast("Space group renamed.");
      } catch (renameError) {
        showErrorToast(renameError instanceof Error ? renameError.message : "Could not rename space group.");
      }
      void loadSpaceGroups();
    },
    deleteSpaceGroup: async (id, mode) => {
      try {
        const response = await chrome.runtime.sendMessage({
          service: "spaceGroups",
          type: "deleteSpaceGroup",
          target: "offscreen",
          payload: { id, mode },
        });
        if (!response?.success) {
          showErrorToast(response?.error || "Could not delete space group.");
          return;
        }
        showSuccessToast(
          mode === "deleteContents"
            ? "Space group moved to bin. Restore spaces from Bin within 30 days."
            : "Space group deleted. Spaces moved to Ungrouped."
        );
      } catch (deleteError) {
        showErrorToast(deleteError instanceof Error ? deleteError.message : "Could not delete space group.");
      }
      void loadSpaceGroups();
      void loadSpaces();
      void loadBinContents();
    },
    newSpace: (groupId) => {
      setCreateSpaceError(null);
      setCreateSpaceName("");
      createSpaceGroupIdRef.current = groupId ?? null;
      setCreateSpaceDialogOpen(true);
    },
    newSpaceGroup: () => {
      setCreateSpaceGroupError(null);
      setCreateSpaceGroupName("");
      setCreateSpaceGroupDialogOpen(true);
    },
    importBrowserBookmarks: () => {
      setBrowserBookmarksError(null);
      setBrowserBookmarksDialogOpen(true);
    },
    importGitHubStars: () => {
      setGithubStarsError(null);
      void chrome.storage.local.get(GITHUB_TOKEN_STORAGE_KEY).then((result) => {
        const stored = typeof result?.[GITHUB_TOKEN_STORAGE_KEY] === "string" ? result[GITHUB_TOKEN_STORAGE_KEY] : "";
        if (stored) setGithubStarsToken(stored);
      });
      setGithubStarsDialogOpen(true);
    },
    importSharedLink: () => {
      setIsImportSharedDialogOpen(true);
    },
    openChangeSpacePassword: (space) => {
      if (space.id !== PRIVATE_SPACE_ID) return;
      setChangePasswordCurrent("");
      setChangePasswordNext("");
      setChangePasswordConfirm("");
      setChangePasswordError(null);
      setChangePasswordDialogOpen(true);
    },
    unlockSpace: (space) => {
      if (space.isPrivate && !space.access.isUnlocked) {
        setUnlockDialogMode(space.access.requiresPassword ? "setup" : "unlock");
        resetUnlockDialogState();
        setUnlockDialogOpen(true);
      }
    },
    shareFolder: (folder) => {
      setShareDialogSelection({
        folderIds: new Set([folder.id]),
        itemIds: new Set(),
        spaceIds: new Set(),
        spaceGroupIds: new Set(),
      });
      setIsShareDialogOpen(true);
    },
    shareSpace: (space) => {
      setShareDialogSelection({
        folderIds: new Set(),
        itemIds: new Set(),
        spaceIds: new Set([space.id]),
        spaceGroupIds: new Set(),
      });
      setIsShareDialogOpen(true);
    },
    shareSpaceGroup: (group) => {
      setShareDialogSelection({
        folderIds: new Set(),
        itemIds: new Set(),
        spaceIds: new Set(),
        spaceGroupIds: new Set([group.id]),
      });
      setIsShareDialogOpen(true);
    },
  }), [
    setShareDialogSelection,
    setIsShareDialogOpen,
    setIsImportSharedDialogOpen,
    activeSpaceGroupId,
    activeSpaceGroupSpaceIds,
    activeSpaceId,
    folders,
    handleSelectSpace,
    handleSelectSpaceGroup,
    loadBinContents,
    loadFolders,
    loadSpaceGroups,
    loadSpaces,
    lockPrivateSpace,
    refreshSidebarFolders,
    requestedScope,
    resetUnlockDialogState,
    sendMessageWithTimeout,
    spaces,
    setBrowserBookmarksDialogOpen,
    setBrowserBookmarksError,
    setChangePasswordConfirm,
    setChangePasswordCurrent,
    setChangePasswordDialogOpen,
    setChangePasswordError,
    setChangePasswordNext,
    setCreateSpaceDialogOpen,
    setCreateSpaceError,
    setCreateSpaceName,
    setCreateSpaceGroupDialogOpen,
    setCreateSpaceGroupError,
    setCreateSpaceGroupName,
    setGithubStarsDialogOpen,
    setGithubStarsError,
    setUnlockDialogMode,
    setUnlockDialogOpen,
    resetUnlockDialogState,
  ]);

  return (
    <OrganizeDndProvider>
    <div
      id="search-results"
      data-theme={theme}
      className={cn(
        "min-h-dvh bg-background-page relative transition-[padding] duration-400 ease-in-out",
        isOpen && "md:pl-[272px]"
      )}
    >
      <div>
      <ShareDialog
        open={isShareDialogOpen}
        onOpenChange={setIsShareDialogOpen}
        selection={shareDialogSelection}
      />
      <ImportSharedDialog
        open={isImportSharedDialogOpen}
        onOpenChange={setIsImportSharedDialogOpen}
        onAfterImport={() => {
          void loadSpaces();
          void loadSpaceGroups();
          refreshSidebarFolders();
          setRefreshToken((value) => value + 1);
        }}
      />
      <div
        className={cn(
          "fixed top-28 h-[70%] z-50 transition-transform duration-400 ease-in-out peer/sidepanel",
          {
            "left-4": isOpen,
            "-translate-x-[calc(100%+8px)] left-0": !isOpen,
          }
        )}
      >
        <SidePanel className="rounded-xl shadow-sm shadow-foreground-muted/60">
          <Sidebar
            spaces={sidebarSpaces}
            spaceGroups={spaceGroups}
            folders={activeSpaceFolders}
            activeSpaceId={activeSpaceId}
            activeSpaceGroupId={activeSpaceGroupId}
            selectedFolderId={selectedFolderId}
            binEntries={binEntries}
            binTotal={binTotal}
            binHasMore={binHasMore}
            binPage={binCursorHistory.length + 1}
            binPageLoading={binPageLoading}
            onNextBinPage={loadNextBinPage}
            onPreviousBinPage={loadPreviousBinPage}
            onOpenBin={loadBinContents}
            now={nowTick}
            openBinNonce={binNonce}
            handlers={sidebarHandlers}
          />
        </SidePanel>
      </div>
      <div
        className={cn("peer/bar", {
          "left-[calc(1rem+240px)] fixed top-30 h-[40%] w-8": isOpen,
        })}
      />
      <button
        onClick={togglePanel}
        className={cn(
          "fixed top-34 p-1 z-50 shadow-sm shadow-foreground-muted/60 rounded-semi bg-background-page-secondary transition-all duration-400 ease-in-out group cursor-pointer hover:bg-background-highlight focus-visible:ring-2 focus-visible:ring-border-neutral/80 focus-visible:ring-offset-1",
          {
            "left-[calc(1rem+240px+8px)]": isOpen,
            "left-2": !isOpen,
            "opacity-100": !isOpen,
            "opacity-0 hover:opacity-100 peer-hover/sidepanel:opacity-100 peer-hover/bar:opacity-100":
              isOpen,
          }
        )}
      >
        <ChevronRight
          className={cn("h-5 w-5 transition-all duration-300 text-foreground-tertiary group-hover:text-foreground-secondary", {
            "rotate-180": isOpen,
          })}
        />
      </button>

      {/* Bottom-left Settings launcher */}
      <button
        type="button"
        onClick={() => setSettingsOpen(true)}
        aria-label="Open settings"
        title="Settings"
        className="group fixed bottom-5 left-5 z-40 grid size-10 place-items-center rounded-full border border-border-neutral-faded bg-background-neutral text-foreground-secondary shadow-lg shadow-black/10 backdrop-blur transition-[transform,color,box-shadow] duration-150 hover:text-foreground-neutral focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-border-neutral/80 focus-visible:ring-offset-1 cursor-pointer"
      >
        <Settings className="size-[18px] transition-transform duration-300 group-hover:rotate-45" />
      </button>

      <SettingsModal
        open={settingsOpen}
        onOpenChange={setSettingsOpen}
        onImportBrowserBookmarks={sidebarHandlers.importBrowserBookmarks}
        onImportGitHubStars={sidebarHandlers.importGitHubStars}
        onImportSharedLink={sidebarHandlers.importSharedLink}
        onDataChanged={() => {
          void loadSpaces();
          void loadSpaceGroups();
          void loadBinContents();
          refreshSidebarFolders();
          setRefreshToken((value) => value + 1);
        }}
        recentQueryCount={recentQueries.length}
        onClearSearchHistory={clearSearchHistory}
        onOpenBin={() => setBinNonce((n) => n + 1)}
      />

      <div className="mt-3">
        <SearchQueryBar
          committedValue={queryText}
          onSubmit={handleSubmitQuery}
          catalogs={catalogs}
          availableFilters={availableFilters}
          placeholder="Search anything…"
          onDeleteRecentQuery={deleteRecentQuery}
          onClearRecentQueries={clearSearchHistory}
        />
        <div className="w-full max-w-5xl mx-auto mt-4 px-1">
          <div className="flex items-center justify-between gap-3 text-[11px] text-foreground-tertiary">
            <div className="flex items-center gap-2">
              <span className="inline-flex items-center gap-1 rounded-full border border-border-neutral-faded px-2 py-1 text-foreground-secondary">
                {isPrivateSpaceActive ? <Shield size={12} /> : <Globe2 size={12} />}
                {activeSpace?.name || "Public"}
              </span>
              {isPrivateSpaceActive && isPrivateUnlocked && (
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="h-6 rounded-full px-2 text-[11px]"
                  onClick={() => {
                    setChangePasswordDialogOpen(true);
                    setChangePasswordCurrent("");
                    setChangePasswordNext("");
                    setChangePasswordConfirm("");
                    setChangePasswordError(null);
                  }}
                >
                  Change password
                </Button>
              )}
              {isDevBuild && (
                <Button
                  type="button"
                  variant={isDebugSearchEnabled ? "secondary" : "ghost"}
                  size="sm"
                  className="h-6 rounded-full px-2 text-[11px]"
                  onClick={() => setIsDebugSearchEnabled((prev) => !prev)}
                >
                  {isDebugSearchEnabled ? "Debug on" : "Debug off"}
                </Button>
              )}
            </div>
            <SearchProcessStatus
              statuses={processStatuses}
              retryingId={retryingProcessId}
              onRetry={triggerRetryAction}
            />
          </div>
          <div className="mt-2.5">
            <SearchControlsBar
              scope={effectiveScope}
              scopeLabel={requestedScopeLabel}
              spaceName={activeSpace?.name}
              scopeIsDefault={effectiveScope === defaultScope}
              onScopeChange={applyScope}
              onSetDefaultScope={handleSetDefaultScope}
              mode={effectiveMode}
              modeIsDefault={effectiveMode === defaultMode}
              onModeChange={applyMode}
              onSetDefaultMode={handleSetDefaultMode}
              spaces={spaces}
              collections={spaceGroups}
              tags={tagsCatalog}
              domains={domainsCatalog}
              selectedSpaceNames={queryAnalysis.filters.spaceIds}
              selectedTags={queryAnalysis.filters.tagNames}
              selectedSites={queryAnalysis.filters.domains}
              selectedMedia={queryAnalysis.filters.hasAny}
              activeDate={activeDateValue}
              onToggleSpace={(name) => toggleFilterToken("space", name)}
              onSelectSpaces={addSpaceFilters}
              onToggleTag={(name) => toggleFilterToken("tag", name)}
              onToggleSite={(domain) => toggleFilterToken("site", domain)}
              onToggleMedia={(value) => toggleFilterToken("has", value)}
              onSetDate={setDateFilter}
              onClearFilters={clearAllFilters}
            />
          </div>
        </div>
      </div>

      <div className="w-full max-w-5xl mx-auto mt-3 px-1">
        <div className="mt-2 flex items-center justify-between gap-3 text-xs text-foreground-secondary">
          <div className="flex min-w-0 items-center">
            {isLoading ? (
              <span className="text-foreground-tertiary">Searching local data…</span>
            ) : (
              <>
                <span className="shrink-0 font-medium tabular-nums text-foreground-neutral">
                  {resultMeta.total.toLocaleString()}
                  {resultMeta.totalIsExact ? "" : "+"} result
                  {resultMeta.total === 1 && resultMeta.totalIsExact ? "" : "s"}
                </span>
                <span className="truncate text-foreground-tertiary">
                  {` · Page ${resultMeta.page}`}
                  {resultMeta.hasMore ? " · more available" : ""}
                  {isDebugSearchEnabled
                    ? ` · ${requestedScope} · ${resultMeta.mode} · ${resultMeta.lexicalHits} lexical${
                        resultModeFeatures.vector ? ` · ${resultMeta.vectorHits} vector` : ""
                      }${topDebugVectorHit ? ` · top ${topDebugVectorHit.score.toFixed(3)}` : ""} · stale ${staleSuppressedCount}`
                    : ""}
                </span>
                {resultMeta.vectorError ? (
                  <span className="shrink-0 text-foreground-danger" title={resultMeta.vectorError}>
                    {" · vector error"}
                  </span>
                ) : null}
                {error ? (
                  <span className="shrink-0 text-foreground-danger" title={error}>
                    {" · error"}
                  </span>
                ) : null}
              </>
            )}
          </div>
          <div className="flex items-center gap-2 shrink-0">
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={prevDisabled}
              onClick={goPrevPage}
              className="h-7 px-2 text-xs"
            >
              Prev
            </Button>
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={nextDisabled}
              onClick={goNextPage}
              className="h-7 px-2 text-xs"
            >
              Next
            </Button>
          </div>
        </div>
      </div>

      <Dialog
        open={unlockDialogOpen}
        onOpenChange={(open) => {
          if (unlockDialogLoading) return;
          setUnlockDialogOpen(open);
          if (!open) {
            setUnlockDialogMode(privateSpace?.access.requiresPassword ? "setup" : "unlock");
            resetUnlockDialogState();
          }
        }}
      >
        <DialogContent className="flex w-full max-w-lg flex-col gap-5 rounded-2xl p-6 sm:max-w-lg">
          <DialogHeader>
            <div className="mb-1.5 flex size-12 items-center justify-center rounded-xl bg-foreground-neutral text-background-neutral shadow-sm">
              <Lock size={20} />
            </div>
            <DialogTitle className="font-sans-bold text-xl tracking-[-0.01em] text-foreground-neutral">
              {unlockDialogMode === "setup"
                ? "Lock your private space"
                : unlockDialogMode === "recovery"
                  ? "Reset your password"
                  : "Private space"}
            </DialogTitle>
            <DialogDescription className="text-sm leading-relaxed text-foreground-secondary">
              {unlockDialogMode === "setup"
                ? "Set a password to keep these folders and tabs hidden on this device."
                : unlockDialogMode === "recovery"
                  ? "Answer your recovery questions to set a new password."
                  : "Enter your password to view private folders and tabs."}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4 py-1">
            {(unlockDialogMode === "unlock" || unlockDialogMode === "setup") && (
              <div className="space-y-1.5">
                <label
                  htmlFor="private-password"
                  className="text-[13px] font-medium text-foreground-neutral"
                >
                  {unlockDialogMode === "setup" ? "Create a password" : "Password"}
                </label>
                <div className="relative">
                  <Input
                    id="private-password"
                    type={showPassword ? "text" : "password"}
                    value={unlockPassword}
                    onChange={(event) => setUnlockPassword(event.target.value)}
                    placeholder={
                      unlockDialogMode === "setup"
                        ? "At least 8 characters"
                        : "Enter your password"
                    }
                    autoFocus
                    className="pr-10"
                    onKeyDown={(event) => {
                      if (event.key === "Enter") {
                        void submitPrivateAccess();
                      }
                    }}
                  />
                  <button
                    type="button"
                    onClick={() => setShowPassword((value) => !value)}
                    aria-label={showPassword ? "Hide password" : "Show password"}
                    className="absolute right-1 top-1/2 grid size-8 -translate-y-1/2 place-items-center rounded-md text-foreground-tertiary outline-none transition-colors hover:text-foreground-neutral"
                  >
                    {showPassword ? <EyeOff size={16} /> : <Eye size={16} />}
                  </button>
                </div>
              </div>
            )}
            {(unlockDialogMode === "setup" || unlockDialogMode === "recovery") && (
              <div className="space-y-1.5">
                <label
                  htmlFor="private-confirm"
                  className="text-[13px] font-medium text-foreground-neutral"
                >
                  {unlockDialogMode === "setup" ? "Confirm password" : "Confirm new password"}
                </label>
                <Input
                  id="private-confirm"
                  type={showPassword ? "text" : "password"}
                  value={unlockConfirmPassword}
                  onChange={(event) => setUnlockConfirmPassword(event.target.value)}
                  placeholder="Re-enter password"
                  onKeyDown={(event) => {
                    if (event.key === "Enter") {
                      void submitPrivateAccess();
                    }
                  }}
                />
              </div>
            )}
            {unlockDialogMode === "setup" && (
              <div className="space-y-3 border-t border-border-neutral-faded pt-4">
                <div>
                  <p className="text-[11px] font-semibold uppercase tracking-[0.08em] text-foreground-tertiary">
                    Recovery questions
                  </p>
                  <p className="mt-0.5 text-xs text-foreground-secondary">
                    The only way back in if you forget your password.
                  </p>
                </div>
                <div className="flex gap-3">
                  <span className="mt-2 grid size-6 shrink-0 place-items-center rounded-full bg-foreground-neutral text-[11px] font-semibold text-background-neutral">
                    1
                  </span>
                  <div className="flex-1 space-y-2">
                    <Input
                      value={unlockQuestion1}
                      onChange={(event) => setUnlockQuestion1(event.target.value)}
                      placeholder="Security question"
                    />
                    <Input
                      value={unlockAnswer1}
                      onChange={(event) => setUnlockAnswer1(event.target.value)}
                      placeholder="Answer"
                    />
                  </div>
                </div>
                <div className="flex gap-3">
                  <span className="mt-2 grid size-6 shrink-0 place-items-center rounded-full bg-foreground-neutral text-[11px] font-semibold text-background-neutral">
                    2
                  </span>
                  <div className="flex-1 space-y-2">
                    <Input
                      value={unlockQuestion2}
                      onChange={(event) => setUnlockQuestion2(event.target.value)}
                      placeholder="Security question"
                    />
                    <Input
                      value={unlockAnswer2}
                      onChange={(event) => setUnlockAnswer2(event.target.value)}
                      placeholder="Answer"
                    />
                  </div>
                </div>
                <button
                  type="button"
                  onClick={shuffleRecoveryQuestions}
                  className="mx-auto flex w-fit items-center gap-1.5 rounded-md border border-border-neutral-faded px-2.5 py-1.5 text-xs font-medium text-foreground-secondary outline-none transition-colors hover:bg-background-neutral-faded hover:text-foreground-neutral"
                >
                  <RefreshCw size={12} />
                  Shuffle questions
                </button>
              </div>
            )}
            {unlockDialogMode === "recovery" && (
              <>
                <div className="rounded-lg border border-border-neutral-faded bg-background-neutral/60 px-3 py-2">
                  <p className="text-[11px] uppercase tracking-[0.08em] text-foreground-tertiary">
                    Recovery question 1
                  </p>
                  <p className="mt-0.5 text-sm text-foreground-secondary">
                    {privateSpace?.access.recoveryQuestions[0] || "Question unavailable"}
                  </p>
                </div>
                <Input
                  value={unlockAnswer1}
                  onChange={(event) => setUnlockAnswer1(event.target.value)}
                  placeholder="Answer 1"
                  autoFocus
                />
                <div className="rounded-lg border border-border-neutral-faded bg-background-neutral/60 px-3 py-2">
                  <p className="text-[11px] uppercase tracking-[0.08em] text-foreground-tertiary">
                    Recovery question 2
                  </p>
                  <p className="mt-0.5 text-sm text-foreground-secondary">
                    {privateSpace?.access.recoveryQuestions[1] || "Question unavailable"}
                  </p>
                </div>
                <Input
                  value={unlockAnswer2}
                  onChange={(event) => setUnlockAnswer2(event.target.value)}
                  placeholder="Answer 2"
                />
                <Input
                  type="password"
                  value={unlockPassword}
                  onChange={(event) => setUnlockPassword(event.target.value)}
                  placeholder="New password"
                  onKeyDown={(event) => {
                    if (event.key === "Enter") {
                      void submitPrivateAccess();
                    }
                  }}
                />
              </>
            )}
            {unlockDialogError && (
              <p className="text-xs text-foreground-danger">{unlockDialogError}</p>
            )}
          </div>
          <DialogFooter className="sm:justify-between">
            <div className="flex items-center gap-2">
              {unlockDialogMode === "unlock" && privateSpace?.access.hasRecovery && (
                <Button
                  type="button"
                  variant="ghost"
                  onClick={() => {
                    setUnlockDialogMode("recovery");
                    setUnlockDialogError(null);
                    setUnlockPassword("");
                    setUnlockConfirmPassword("");
                    setUnlockAnswer1("");
                    setUnlockAnswer2("");
                  }}
                  disabled={unlockDialogLoading}
                >
                  Forgot password?
                </Button>
              )}
              {unlockDialogMode === "recovery" && (
                <Button
                  type="button"
                  variant="ghost"
                  onClick={() => {
                    setUnlockDialogMode("unlock");
                    setUnlockDialogError(null);
                    setUnlockPassword("");
                    setUnlockConfirmPassword("");
                    setUnlockAnswer1("");
                    setUnlockAnswer2("");
                  }}
                  disabled={unlockDialogLoading}
                >
                  Use password instead
                </Button>
              )}
            </div>
            <div className="flex items-center gap-2">
            <Button
              type="button"
              variant="outline"
              onClick={() => setUnlockDialogOpen(false)}
              disabled={unlockDialogLoading}
            >
              Cancel
            </Button>
            <Button
              type="button"
              onClick={() => {
                void submitPrivateAccess();
              }}
              disabled={unlockDialogLoading}
            >
              {unlockDialogLoading
                ? "Please wait..."
                : unlockDialogMode === "setup"
                  ? "Save and unlock"
                  : unlockDialogMode === "recovery"
                    ? "Recover and unlock"
                    : "Unlock"}
            </Button>
            </div>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog
        open={changePasswordDialogOpen}
        onOpenChange={(open) => {
          if (changePasswordLoading) return;
          setChangePasswordDialogOpen(open);
          if (!open) {
            setChangePasswordCurrent("");
            setChangePasswordNext("");
            setChangePasswordConfirm("");
            setChangePasswordError(null);
          }
        }}
      >
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Change private password</DialogTitle>
            <DialogDescription>
              Update your private space password. Recovery questions stay unchanged.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3 py-1">
            <Input
              type="password"
              value={changePasswordCurrent}
              onChange={(event) => setChangePasswordCurrent(event.target.value)}
              placeholder="Current password"
              autoFocus
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  void submitPasswordChange();
                }
              }}
            />
            <Input
              type="password"
              value={changePasswordNext}
              onChange={(event) => setChangePasswordNext(event.target.value)}
              placeholder="New password"
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  void submitPasswordChange();
                }
              }}
            />
            <Input
              type="password"
              value={changePasswordConfirm}
              onChange={(event) => setChangePasswordConfirm(event.target.value)}
              placeholder="Confirm new password"
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  void submitPasswordChange();
                }
              }}
            />
            {changePasswordError && (
              <p className="text-xs text-foreground-danger">{changePasswordError}</p>
            )}
          </div>
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => setChangePasswordDialogOpen(false)}
              disabled={changePasswordLoading}
            >
              Cancel
            </Button>
            <Button
              type="button"
              onClick={() => {
                void submitPasswordChange();
              }}
              disabled={changePasswordLoading}
            >
              {changePasswordLoading ? "Updating..." : "Update password"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog
        open={createSpaceDialogOpen}
        onOpenChange={(open) => {
          if (createSpaceLoading) return;
          setCreateSpaceDialogOpen(open);
          if (!open) {
            setCreateSpaceError(null);
            setCreateSpaceName("");
          }
        }}
      >
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Create a new space</DialogTitle>
            <DialogDescription>
              Spaces keep your folders separate without adding search clutter.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-2 py-1">
            <Input
              value={createSpaceName}
              onChange={(event) => setCreateSpaceName(event.target.value)}
              placeholder="Space name"
              autoFocus
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  void submitCreateSpace();
                }
              }}
            />
            {createSpaceError && <p className="text-xs text-foreground-danger">{createSpaceError}</p>}
          </div>
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => setCreateSpaceDialogOpen(false)}
              disabled={createSpaceLoading}
            >
              Cancel
            </Button>
            <Button
              type="button"
              onClick={() => {
                void submitCreateSpace();
              }}
              disabled={createSpaceLoading}
            >
              {createSpaceLoading ? "Creating..." : "Create space"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog
        open={createSpaceGroupDialogOpen}
        onOpenChange={(open) => {
          if (createSpaceGroupLoading) return;
          setCreateSpaceGroupDialogOpen(open);
          if (!open) {
            setCreateSpaceGroupError(null);
            setCreateSpaceGroupName("");
          }
        }}
      >
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Create a space group</DialogTitle>
            <DialogDescription>Groups keep related spaces together and searchable as one scope.</DialogDescription>
          </DialogHeader>
          <div className="space-y-2 py-1">
            <Input
              value={createSpaceGroupName}
              onChange={(event) => setCreateSpaceGroupName(event.target.value)}
              placeholder="Space group name"
              autoFocus
              onKeyDown={(event) => {
                if (event.key === "Enter") void submitCreateSpaceGroup();
              }}
            />
            {createSpaceGroupError && <p className="text-xs text-foreground-danger">{createSpaceGroupError}</p>}
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setCreateSpaceGroupDialogOpen(false)} disabled={createSpaceGroupLoading}>
              Cancel
            </Button>
            <Button type="button" onClick={() => void submitCreateSpaceGroup()} disabled={createSpaceGroupLoading}>
              {createSpaceGroupLoading ? "Creating..." : "Create group"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog
        open={browserBookmarksDialogOpen}
        onOpenChange={(open) => {
          if (browserBookmarksImporting) return;
          setBrowserBookmarksDialogOpen(open);
          if (!open) setBrowserBookmarksError(null);
        }}
      >
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle className="text-balance">Import browser bookmarks</DialogTitle>
            <DialogDescription className="text-pretty">
              Top-level bookmark folders become separate spaces under <strong>Browser Bookmarks</strong>.
              Large folders split at 500 bookmarks so browsing stays responsive.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-2 py-1 text-sm text-foreground-secondary">
            <p>
              Re-running the import updates the same browser bookmarks instead of creating duplicates.
            </p>
            <p>
              Metadata is queued in the background after import; semantic embeddings wait until fetched metadata changes searchable text.
            </p>
            {browserBookmarksError && <p className="text-xs text-foreground-danger">{browserBookmarksError}</p>}
          </div>
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => setBrowserBookmarksDialogOpen(false)}
              disabled={browserBookmarksImporting}
              className="h-10"
            >
              Cancel
            </Button>
            <Button
              type="button"
              onClick={() => {
                void importBrowserBookmarks();
              }}
              disabled={browserBookmarksImporting}
              className="h-10"
              static={browserBookmarksImporting}
            >
              {browserBookmarksImporting ? "Importing..." : "Import bookmarks"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog
        open={githubStarsDialogOpen}
        onOpenChange={(open) => {
          if (githubStarsImporting) return;
          setGithubStarsDialogOpen(open);
          if (!open) {
            setGithubStarsError(null);
            setGithubStarsToken("");
          }
        }}
      >
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle className="text-balance">Import GitHub stars</DialogTitle>
            <DialogDescription className="text-pretty">
              Uses GitHub&apos;s supported starred-repositories API. Your token is used for this sync only and is not stored.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-2 py-1">
            <Input
              type="password"
              autoComplete="off"
              value={githubStarsToken}
              onChange={(event) => setGithubStarsToken(event.target.value)}
              placeholder="GitHub token with Starring: read"
              disabled={githubStarsImporting}
            />
            {githubStarsError && <p className="text-xs text-foreground-danger">{githubStarsError}</p>}
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setGithubStarsDialogOpen(false)} disabled={githubStarsImporting}>
              Cancel
            </Button>
            <Button
              type="button"
              onClick={() => void importGitHubStars()}
              disabled={githubStarsImporting || !githubStarsToken.trim()}
              static={githubStarsImporting}
            >
              {githubStarsImporting ? "Syncing..." : "Import stars"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {showEmptySearchState ? (
        <div className="w-full max-w-5xl mx-auto mt-10 rounded-xl border border-border-neutral-faded bg-background-page-secondary/80 px-6 py-8 text-center">
          <p className="text-base font-semibold text-foreground-neutral">No matching results</p>
          <p className="mt-1 text-sm text-foreground-secondary">
            Try a broader query, change scope, or remove a few filters.
          </p>
          {queryText.trim().length > 0 && (
            <div className="mt-4 flex justify-center">
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => {
                  const clearedAnalysis = analyzeQuery({
                    type: "ANALYZE_QUERY",
                    requestId: Date.now(),
                    input: "",
                    cursor: 0,
                    catalogs,
                    forceSuggestions: false,
                  });
                  setQueryText("");
                  setQueryAnalysis(clearedAnalysis);
                  setQuerySubmitMeta(null);
                  setResultDebug(null);
                  setCursorAfter(null);
                  setCursorPage(1);
                  setCursorHistory([]);
                  setRefreshToken((value) => value + 1);
                }}
              >
                Clear query
              </Button>
            </div>
          )}
        </div>
      ) : hasActiveQuery ? (
        <SearchResults
          items={items}
          spaces={spaces}
          folders={folders}
          collections={spaceGroups}
          onReveal={handleRevealItem}
          onCopy={handleResultCopy}
          debugScoresByItemId={isDebugSearchEnabled ? debugScoresByItemId : undefined}
          showDebugScores={isDebugSearchEnabled}
          page={resultMeta.page}
          canPrev={!prevDisabled}
          canNext={!nextDisabled}
          onPrev={goPrevPage}
          onNext={goNextPage}
        />
      ) : (
        <TabGroups
          folders={visibleFolders}
          items={items}
          spaces={spaces}
          preserveInputOrder={preserveInputOrder}
          revealItemId={pendingRevealItemRef.current?.id}
          debugScoresByItemId={isDebugSearchEnabled ? debugScoresByItemId : undefined}
          showDebugScores={isDebugSearchEnabled}
          onShareSelectedItems={(itemIds) => {
            setShareDialogSelection({
              folderIds: new Set(),
              itemIds: new Set(itemIds),
              spaceIds: new Set(),
              spaceGroupIds: new Set(),
            });
            setIsShareDialogOpen(true);
          }}
          onShareFolder={(folderId) => {
            setShareDialogSelection({
              folderIds: new Set([folderId]),
              itemIds: new Set(),
              spaceIds: new Set(),
              spaceGroupIds: new Set(),
            });
            setIsShareDialogOpen(true);
          }}
        />
      )}
      <BulkActionsBar
        items={items}
        folders={visibleFolders}
        spaces={spaces}
        activeSpaceId={activeSpaceId}
        onShareSelectedItems={(itemIds) => {
          setShareDialogSelection({
            folderIds: new Set(),
            itemIds: new Set(itemIds),
            spaceIds: new Set(),
            spaceGroupIds: new Set(),
          });
          setIsShareDialogOpen(true);
        }}
      />
      {revealReturn && !hasActiveQuery && (
        <div className="fixed bottom-5 left-1/2 z-50 -translate-x-1/2">
          <div className="flex items-center gap-0.5 rounded-full border border-border-neutral-faded bg-background-neutral/95 px-1.5 py-1 shadow-lg shadow-black/10 backdrop-blur">
            <button
              type="button"
              onClick={handleBackToResults}
              className="inline-flex items-center gap-1.5 rounded-full px-3 py-1 text-sm font-medium text-foreground-secondary transition-colors hover:bg-background-neutral-faded hover:text-foreground-neutral"
            >
              <ArrowLeft size={14} />
              Back to results
            </button>
            <button
              type="button"
              onClick={() => setRevealReturn(null)}
              aria-label="Dismiss"
              className="grid size-7 place-items-center rounded-full text-foreground-tertiary transition-colors hover:bg-background-neutral-faded hover:text-foreground-neutral"
            >
              <XIcon size={14} />
            </button>
          </div>
        </div>
      )}
      <Toaster
        position="bottom-right"
        duration={2800}
        offset="16px"
        gap={8}
        closeButton
        className="vibe-toaster"
        icons={{ close: <XIcon size={14} strokeWidth={2.25} /> }}
        toastOptions={{
          style: {
            background: "var(--background-neutral)",
            color: "var(--foreground-neutral)",
            border: "1px solid var(--border-neutral-faded)",
            borderRadius: "10px",
            boxShadow: "var(--shadow-modal)",
            fontFamily: "var(--font-sans)",
            fontSize: "13px",
            lineHeight: "1.4",
            padding: "10px 14px",
            width: "320px",
          },
        }}
      />
      </div>
    </div>
    </OrganizeDndProvider>
  );
};

const Search = () => (
  <SelectionProvider>
    <SearchInner />
  </SelectionProvider>
);

export default Search;
