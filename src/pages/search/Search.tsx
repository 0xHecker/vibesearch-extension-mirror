import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ItemDocType } from "@src/schemas/item_schema";
import type { SearchQuerySubmitMeta } from "@src/pages/search/components/SearchQueryBar";
import { getQueryModeFeatures } from "@src/search-core/contracts";
import type {
  QueryAnalysis,
  QueryAssistCatalogs,
  QueryMode,
  QueryScope,
  RankQueryCursor,
} from "@src/search-core/contracts";
import { PRIVATE_SPACE_ID } from "@src/common/spaces";
import { isSearchHistoryEnabled } from "@src/pages/search/components/settings/sections/SearchHistorySection";
import {
  useDefaultSearchMode,
  useDefaultSearchScope,
} from "@src/pages/search/search-preferences";
import { buildFolderLoadKey } from "@src/pages/search/selection-state";
import { getOrCreateSearchClientId } from "@src/pages/search/search-client-id";
import type { MixedShareSelection } from "@src/services/share-snapshot";
import { useLibraryData } from "@src/pages/search/workspace/library/use-library-data";
import { useProcessStatuses } from "@src/pages/search/workspace/status/use-process-statuses";
import { usePrivateSpaceDialogs } from "@src/pages/search/workspace/spaces/use-private-space-dialogs";
import { useSpaceCreationDialogs } from "@src/pages/search/workspace/spaces/use-space-creation-dialogs";
import { useLibraryImportDialogs } from "@src/pages/search/workspace/imports/use-library-import-dialogs";
import { useSidebarHandlers } from "@src/pages/search/workspace/navigation/use-sidebar-handlers";
import { useSearchExecution } from "@src/pages/search/workspace/query/use-search-execution";
import { useSearchRuntimeEvents } from "@src/pages/search/workspace/runtime/use-search-runtime-events";
import { useSearchQueryControls } from "@src/pages/search/workspace/query/use-search-query-controls";
import { useProcessStatusRetry } from "@src/pages/search/workspace/status/use-process-status-retry";
import { useQueryRefreshScheduler } from "@src/pages/search/workspace/query/use-query-refresh-scheduler";
import { usePrivateSpaceSession } from "@src/pages/search/workspace/spaces/use-private-space-session";
import { useSearchPagePersistence } from "@src/pages/search/workspace/persistence/use-search-page-persistence";
import { useSearchPagination } from "@src/pages/search/workspace/query/use-search-pagination";
import { useSpaceNavigation } from "@src/pages/search/workspace/navigation/use-space-navigation";
import { useSearchResultReveal } from "@src/pages/search/workspace/query/use-search-result-reveal";
import { SearchWorkspaceView } from "@src/pages/search/workspace/view/search-workspace-view";
import {
  readInitialDebugMode,
  readInitialFolderId,
  readInitialSpaceGroupId,
  readInitialSpaceId,
} from "@src/pages/search/workspace/persistence/search-route-state";
import {
  clearRecentQueries,
  readRecentQueries,
  writeRecentQueries,
} from "@src/pages/search/workspace/persistence/recent-query-storage";
import {
  SEARCH_DEBUG_STORAGE_KEY,
  SOURCE_OPTIONS,
  defaultAnalysis,
  sameStringArray,
} from "@src/pages/search/workspace/query/model";

const SearchInner = () => {
  const [isOpen, setIsOpen] = useState(true);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [binNonce, setBinNonce] = useState(0);
  const [isShareDialogOpen, setIsShareDialogOpen] = useState(false);
  const [isImportSharedDialogOpen, setIsImportSharedDialogOpen] =
    useState(false);
  const [shareDialogSelection, setShareDialogSelection] =
    useState<MixedShareSelection>({
      folderIds: new Set(),
      itemIds: new Set(),
      spaceIds: new Set(),
      spaceGroupIds: new Set(),
    });
  const openShare = useCallback((selection: MixedShareSelection): void => {
    setShareDialogSelection(selection);
    setIsShareDialogOpen(true);
  }, []);
  const openSharedImport = useCallback(
    (): void => setIsImportSharedDialogOpen(true),
    [],
  );
  const [activeSpaceGroupId, setActiveSpaceGroupId] = useState<string | null>(
    readInitialSpaceGroupId,
  );
  const [activeSpaceId, setActiveSpaceId] = useState(readInitialSpaceId);
  const [refreshToken, setRefreshToken] = useState(0);
  const refreshResults = useCallback(
    () => setRefreshToken((value) => value + 1),
    [],
  );

  const isDevBuild = import.meta.env.DEV === true;
  const [isDebugSearchEnabled, setIsDebugSearchEnabled] = useState(() =>
    readInitialDebugMode(isDevBuild),
  );

  const [queryText, setQueryText] = useState("");
  const defaultMode = useDefaultSearchMode();
  const defaultScope = useDefaultSearchScope();
  // Set when the user reveals a result in its space; powers the "Back to
  // results" pill that restores the search they jumped away from.
  const [revealReturn, setRevealReturn] = useState<{ query: string } | null>(
    null,
  );
  const pendingRevealItemRef = useRef<ItemDocType | null>(null);
  const [queryAnalysis, setQueryAnalysis] =
    useState<QueryAnalysis>(defaultAnalysis);
  const [querySubmitMeta, setQuerySubmitMeta] =
    useState<SearchQuerySubmitMeta | null>(null);
  const [selectedFolderId, setSelectedFolderId] = useState(readInitialFolderId);
  const pendingUrlFolderIdRef = useRef<string | null>(
    selectedFolderId !== "all" ? selectedFolderId : null,
  );
  const [recentQueries, setRecentQueries] = useState<string[]>([]);
  const {
    statuses: processStatuses,
    hasBackgroundProcessing,
    upsert: upsertProcessStatus,
    clear: clearProcessStatus,
    retryingId: retryingProcessId,
    setRetryingId: setRetryingProcessId,
  } = useProcessStatuses();

  const persistRecentQuery = useCallback((query: string): void => {
    const clean = query.trim();
    if (!clean || !isSearchHistoryEnabled()) return;

    setRecentQueries((current) => {
      const next = [clean, ...current.filter((row) => row !== clean)].slice(
        0,
        20,
      );
      if (sameStringArray(current, next)) return current;
      writeRecentQueries(next);
      return next;
    });
  }, []);

  const searchClientIdRef = useRef<string | null>(null);
  const searchClientId = getOrCreateSearchClientId(searchClientIdRef);
  const [cursorAfter, setCursorAfter] = useState<RankQueryCursor | null>(null);
  const [cursorPage, setCursorPage] = useState(1);
  const [cursorHistory, setCursorHistory] = useState<
    Array<RankQueryCursor | null>
  >([]);

  const isAnalysisCurrent = queryAnalysis.input === queryText;
  const hasActiveQuery = queryText.trim().length > 0;
  const typedScope = isAnalysisCurrent
    ? (queryAnalysis.directives.scope ?? null)
    : null;
  const typedMode = isAnalysisCurrent
    ? (queryAnalysis.directives.mode ?? null)
    : null;
  const effectiveMode: QueryMode = typedMode ?? defaultMode;
  const effectiveScope: QueryScope = typedScope ?? defaultScope;
  const requestedScope: QueryScope = hasActiveQuery
    ? effectiveScope
    : "current";
  const {
    spaces,
    spaceGroups,
    setSpaceGroups,
    folders,
    setFolders,
    loadedFolderKey,
    tagsCatalog,
    binEntries,
    binTotal,
    binHasMore,
    binPageLoading,
    binCursorHistory,
    loadSpaces,
    loadSpaceGroups,
    loadBinContents,
    loadNextBinPage,
    loadPreviousBinPage,
    loadFolders,
    loadTags,
    scheduleTagReload,
  } = useLibraryData({
    activeSpaceId,
    requestedScope,
    setActiveSpaceId,
    setActiveSpaceGroupId,
  });
  const {
    unlockDialogOpen,
    setUnlockDialogOpen,
    unlockPassword,
    setUnlockPassword,
    unlockConfirmPassword,
    setUnlockConfirmPassword,
    showPassword,
    setShowPassword,
    unlockQuestion1,
    setUnlockQuestion1,
    unlockQuestion2,
    setUnlockQuestion2,
    unlockAnswer1,
    setUnlockAnswer1,
    unlockAnswer2,
    setUnlockAnswer2,
    unlockDialogError,
    unlockDialogLoading,
    unlockDialogMode,
    setUnlockDialogMode,
    resetUnlockDialogState,
    clearUnlockCredentials,
    shuffleRecoveryQuestions,
    openPrivateAccess,
    submitPrivateAccess,
    lockPrivateSpace,
    changePasswordDialogOpen,
    setChangePasswordDialogOpen,
    changePasswordCurrent,
    setChangePasswordCurrent,
    changePasswordNext,
    setChangePasswordNext,
    changePasswordConfirm,
    setChangePasswordConfirm,
    changePasswordError,
    changePasswordLoading,
    resetPasswordChange,
    openPasswordChange,
    submitPasswordChange,
  } = usePrivateSpaceDialogs({
    activeSpaceId,
    selectedFolderId,
    loadSpaces,
    setActiveSpaceId,
    setSelectedFolderId,
    refresh: refreshResults,
    upsertProcessStatus,
  });
  const triggerRetryAction = useProcessStatusRetry({
    refreshResults,
    lockPrivateSpace,
    clearProcessStatus,
    upsertProcessStatus,
    setRetryingProcessId,
  });
  const {
    createSpaceDialogOpen,
    setCreateSpaceDialogOpen,
    createSpaceName,
    setCreateSpaceName,
    createSpaceError,
    createSpaceLoading,
    resetCreateSpace,
    openCreateSpace,
    submitCreateSpace,
    createSpaceGroupDialogOpen,
    setCreateSpaceGroupDialogOpen,
    createSpaceGroupName,
    setCreateSpaceGroupName,
    createSpaceGroupError,
    createSpaceGroupLoading,
    resetCreateSpaceGroup,
    openCreateSpaceGroup,
    submitCreateSpaceGroup,
  } = useSpaceCreationDialogs({
    activeSpaceGroupId,
    loadSpaces,
    loadSpaceGroups,
    setActiveSpaceId,
    setActiveSpaceGroupId,
    setSelectedFolderId,
    refresh: refreshResults,
  });
  const {
    browserBookmarksDialogOpen,
    setBrowserBookmarksDialogOpen,
    browserBookmarksImporting,
    browserBookmarksError,
    clearBrowserBookmarksError,
    openBrowserBookmarksImport,
    importBrowserBookmarks,
    githubStarsDialogOpen,
    setGithubStarsDialogOpen,
    githubStarsToken,
    setGithubStarsToken,
    githubStarsImporting,
    githubStarsError,
    resetGitHubStarsImport,
    openGitHubStarsImport,
    importGitHubStars,
  } = useLibraryImportDialogs({
    loadSpaces,
    loadSpaceGroups,
    loadFolders,
    setActiveSpaceGroupId,
    setSelectedFolderId,
    refresh: refreshResults,
  });

  const activeSpace = useMemo(
    () => spaces.find((space) => space.id === activeSpaceId) || null,
    [activeSpaceId, spaces],
  );
  const activeSpaceGroupSpaceIds = useMemo(
    () =>
      activeSpaceGroupId
        ? spaces
            .filter((space) => space.spaceGroupId === activeSpaceGroupId)
            .map((space) => space.id)
        : [],
    [activeSpaceGroupId, spaces],
  );
  const privateSpace = useMemo(
    () => spaces.find((space) => space.id === PRIVATE_SPACE_ID) || null,
    [spaces],
  );
  const isPrivateSpaceActive = activeSpace?.id === PRIVATE_SPACE_ID;
  const isPrivateUnlocked = privateSpace?.access.isUnlocked === true;
  usePrivateSpaceSession({
    activeSpaceId,
    isPrivateUnlocked,
    unlockDialogOpen,
    loadSpaces,
    openPrivateAccess,
    lockPrivateSpace,
    upsertProcessStatus,
  });
  const activeSpaceFolders = useMemo(() => {
    const allowedSpaceIds = activeSpaceGroupId
      ? new Set(activeSpaceGroupSpaceIds)
      : new Set([activeSpaceId]);
    return folders.filter((folder) => allowedSpaceIds.has(folder.spaceId));
  }, [activeSpaceGroupId, activeSpaceGroupSpaceIds, activeSpaceId, folders]);

  const {
    items,
    setItems,
    isLoading,
    error,
    resultMeta,
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
  } = useSearchExecution({
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
    pendingRevealItem: pendingRevealItemRef,
    refreshToken,
    persistRecentQuery,
    upsertProcessStatus,
    clearProcessStatus,
  });
  useSearchPagePersistence({
    activeSpaceId,
    activeSpaceGroupId,
    selectedFolderId,
    spaceCount: spaces.length,
    spaceGroups,
    itemCount: items.length,
    setActiveSpaceGroupId,
    setSettingsOpen,
  });

  const catalogs = useMemo<QueryAssistCatalogs>(
    () => ({
      sources: SOURCE_OPTIONS,
      spaces: spaces.map((space) => ({
        id: space.id,
        name: space.name,
        isPrivate: space.isPrivate,
      })),
      folders: activeSpaceFolders.map((folder) => ({
        id: folder.id,
        name: folder.name,
      })),
      tags: tagsCatalog,
      domains: domainsCatalog,
      authors: authorsCatalog,
      recentQueries,
    }),
    [
      activeSpaceFolders,
      authorsCatalog,
      domainsCatalog,
      recentQueries,
      spaces,
      tagsCatalog,
    ],
  );

  const visibleFolderIdsFromResults = useMemo(
    () => new Set(items.map((item) => item.folderId)),
    [items],
  );
  const currentFolderLoadKey = useMemo(
    () =>
      buildFolderLoadKey({
        activeSpaceId,
        searchScope: activeSpaceGroupId ? "global" : requestedScope,
        spaceIds: activeSpaceGroupId ? activeSpaceGroupSpaceIds : undefined,
      }),
    [
      activeSpaceGroupId,
      activeSpaceGroupSpaceIds,
      activeSpaceId,
      requestedScope,
    ],
  );
  const hasLoadedCurrentFolders = loadedFolderKey === currentFolderLoadKey;
  const {
    selectSpace: handleSelectSpace,
    selectSpaceGroup: handleSelectSpaceGroup,
    toggleSpaceGroup: toggleSpaceGroupCollapsed,
  } = useSpaceNavigation({
    activeSpaceId,
    activeSpaceGroupId,
    activeSpaceGroupSpaceIds,
    selectedFolderId,
    folders,
    spaces,
    privateSpace,
    hasLoadedCurrentFolders,
    pendingUrlFolderId: pendingUrlFolderIdRef,
    setActiveSpaceId,
    setActiveSpaceGroupId,
    setSelectedFolderId,
    setSpaceGroups,
    openPrivateAccess,
    refreshResults,
  });
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
    clearAvailableFilters();
  }, [
    activeSpaceGroupId,
    activeSpaceId,
    clearAvailableFilters,
    requestedScope,
  ]);

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

  const { revealItem: handleRevealItem, backToResults: handleBackToResults } =
    useSearchResultReveal({
      queryText,
      catalogs,
      items,
      folderCount: folders.length,
      hasActiveQuery,
      isLoading,
      revealReturn,
      pendingRevealItem: pendingRevealItemRef,
      setRevealReturn,
      setItems,
      setActiveSpaceId,
      setActiveSpaceGroupId,
      setSelectedFolderId,
      setQueryText,
      setQueryAnalysis,
      setQuerySubmitMeta,
      setCursorAfter,
      setCursorPage,
      setCursorHistory,
      refreshResults,
    });

  const {
    applyScope,
    applyMode,
    setDefaultMode: handleSetDefaultMode,
    setDefaultScope: handleSetDefaultScope,
    toggleFilter: toggleFilterToken,
    setDateFilter,
    activeDateValue,
    clearAllFilters,
    addSpaceFilters,
    preserveInputOrder,
    clearQuery: clearQueryText,
  } = useSearchQueryControls({
    queryText,
    queryAnalysis,
    isAnalysisCurrent,
    catalogs,
    defaultMode,
    defaultScope,
    setQueryText,
    setQueryAnalysis,
    setQuerySubmitMeta,
    setCursorAfter,
    setCursorPage,
    setCursorHistory,
    refreshResults,
  });
  const clearQuery = useCallback((): void => {
    clearQueryText();
    clearResultDebug();
  }, [clearQueryText, clearResultDebug]);

  useEffect(() => {
    setCursorAfter(null);
    setCursorPage(1);
    setCursorHistory([]);
  }, [queryText, selectedFolderId, activeSpaceGroupId, activeSpaceId]);

  useEffect(() => {
    setRecentQueries(readRecentQueries());
  }, []);

  useEffect(() => {
    if (!isDevBuild) return;
    try {
      localStorage.setItem(
        SEARCH_DEBUG_STORAGE_KEY,
        isDebugSearchEnabled ? "1" : "0",
      );
    } catch {}
  }, [isDebugSearchEnabled, isDevBuild]);

  const scheduleQueryRefresh = useQueryRefreshScheduler({
    hasBackgroundProcessing,
    refreshResults,
  });

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

  const clearSearchHistory = useCallback(() => {
    setRecentQueries([]);
    clearRecentQueries();
  }, []);

  const deleteRecentQuery = useCallback((query: string) => {
    setRecentQueries((prev) => {
      const next = prev.filter((q) => q !== query);
      writeRecentQueries(next);
      return next;
    });
  }, []);

  const handleSubmitQuery = useCallback(
    (
      nextQuery: string,
      analysis: QueryAnalysis,
      meta: SearchQuerySubmitMeta,
    ) => {
      setQueryText(nextQuery);
      setQueryAnalysis(analysis);
      setQuerySubmitMeta(meta);
      setCursorAfter(null);
      setCursorPage(1);
      setCursorHistory([]);
      setRefreshToken((value) => value + 1);
    },
    [],
  );

  const showEmptySearchState = !isLoading && !error && resultMeta.total === 0;

  useEffect(() => {
    void loadFolders({
      activeSpaceId,
      searchScope: activeSpaceGroupId ? "global" : requestedScope,
      spaceIds: activeSpaceGroupId ? activeSpaceGroupSpaceIds : undefined,
    });
  }, [
    activeSpaceGroupId,
    activeSpaceGroupSpaceIds,
    activeSpaceId,
    isPrivateUnlocked,
    loadFolders,
    requestedScope,
  ]);

  useEffect(() => {
    loadTags();
  }, [loadTags]);

  useEffect(() => {
    void loadSpaces();
    void loadSpaceGroups();
    void loadBinContents();
  }, [loadBinContents, loadSpaceGroups, loadSpaces]);

  useSearchRuntimeEvents({
    activeSpaceId,
    activeSpaceGroupId,
    activeSpaceGroupSpaceIds,
    requestedScope,
    visibleItemIds,
    hasConstrainedQuery,
    setPanelOpen: setIsOpen,
    loadFolders,
    loadSpaces,
    loadSpaceGroups,
    loadBinContents,
    scheduleTagReload,
    scheduleQueryRefresh,
    queueMetadataItemPatches,
    upsertProcessStatus,
  });

  const togglePanel = () => {
    const newState = !isOpen;
    setIsOpen(newState);
    chrome.storage.local.set({ sidePanelOpen: newState });
  };

  const {
    previousDisabled: prevDisabled,
    nextDisabled,
    goToPreviousPage: goPrevPage,
    goToNextPage: goNextPage,
  } = useSearchPagination({
    queryText,
    queryAnalysis,
    catalogs,
    resultMeta,
    isLoading,
    cursorAfter,
    cursorHistory,
    setQueryText,
    setQueryAnalysis,
    setQuerySubmitMeta,
    setCursorAfter,
    setCursorPage,
    setCursorHistory,
    refreshResults,
  });
  const resultModeFeatures = getQueryModeFeatures(resultMeta.mode);

  const [nowTick, setNowTick] = useState<number>(() => Date.now());
  useEffect(() => {
    if (binEntries.length === 0) return;
    const timer = window.setInterval(() => setNowTick(Date.now()), 60_000);
    return () => window.clearInterval(timer);
  }, [binEntries.length]);

  const { handlers: sidebarHandlers, refreshFolders: refreshSidebarFolders } =
    useSidebarHandlers({
      activeSpaceId,
      activeSpaceGroupId,
      activeSpaceGroupSpaceIds,
      requestedScope,
      folders,
      spaces,
      pendingUrlFolderId: pendingUrlFolderIdRef,
      setActiveSpaceId,
      setActiveSpaceGroupId,
      setSelectedFolderId,
      setFolders,
      selectSpace: handleSelectSpace,
      selectSpaceGroup: handleSelectSpaceGroup,
      toggleSpaceGroup: (group) => void toggleSpaceGroupCollapsed(group),
      loadFolders,
      loadSpaces,
      loadSpaceGroups,
      loadBinContents,
      lockPrivateSpace,
      scheduleQueryRefresh,
      refresh: refreshResults,
      openCreateSpace,
      openCreateSpaceGroup,
      openBrowserBookmarksImport,
      openGitHubStarsImport,
      openSharedImport,
      openPasswordChange,
      openPrivateAccess,
      openShare,
    });

  const refreshWorkspace = useCallback((): void => {
    void loadSpaces();
    void loadSpaceGroups();
    void loadBinContents();
    refreshSidebarFolders();
    refreshResults();
  }, [
    loadBinContents,
    loadSpaceGroups,
    loadSpaces,
    refreshResults,
    refreshSidebarFolders,
  ]);
  const openBin = useCallback(
    (): void => setBinNonce((value) => value + 1),
    [],
  );
  const toggleDebug = useCallback(
    (): void => setIsDebugSearchEnabled((enabled) => !enabled),
    [],
  );
  return (
    <SearchWorkspaceView
      sharing={{
        shareDialog: {
          open: isShareDialogOpen,
          onOpenChange: setIsShareDialogOpen,
          selection: shareDialogSelection,
        },
        importDialog: {
          open: isImportSharedDialogOpen,
          onOpenChange: setIsImportSharedDialogOpen,
          onAfterImport: refreshWorkspace,
        },
      }}
      navigation={{
        panelOpen: isOpen,
        onTogglePanel: togglePanel,
        sidebar: {
          spaces,
          spaceGroups,
          folders: activeSpaceFolders,
          activeSpaceId,
          activeSpaceGroupId,
          selectedFolderId,
          binEntries,
          binTotal,
          binHasMore,
          binPage: binCursorHistory.length + 1,
          binPageLoading,
          onNextBinPage: loadNextBinPage,
          onPreviousBinPage: loadPreviousBinPage,
          onOpenBin: loadBinContents,
          now: nowTick,
          openBinNonce: binNonce,
          handlers: sidebarHandlers,
        },
      }}
      settings={{
        open: settingsOpen,
        onOpenChange: setSettingsOpen,
        onImportBrowserBookmarks: sidebarHandlers.importBrowserBookmarks,
        onImportGitHubStars: sidebarHandlers.importGitHubStars,
        onImportSharedLink: sidebarHandlers.importSharedLink,
        onDataChanged: refreshWorkspace,
        recentQueryCount: recentQueries.length,
        onClearSearchHistory: clearSearchHistory,
        onOpenBin: openBin,
      }}
      query={{
        bar: {
          committedValue: queryText,
          onSubmit: handleSubmitQuery,
          catalogs,
          availableFilters,
          placeholder: "Search anything…",
          onDeleteRecentQuery: deleteRecentQuery,
          onClearRecentQueries: clearSearchHistory,
        },
        context: {
          activeSpaceName: activeSpace?.name || "Public",
          isPrivateSpaceActive,
          isPrivateUnlocked,
          onChangePassword: openPasswordChange,
          debugAvailable: isDevBuild,
          debugEnabled: isDebugSearchEnabled,
          onToggleDebug: toggleDebug,
        },
        processStatus: {
          statuses: processStatuses,
          retryingId: retryingProcessId,
          onRetry: triggerRetryAction,
        },
        controls: {
          scope: effectiveScope,
          scopeLabel: requestedScopeLabel,
          spaceName: activeSpace?.name,
          scopeIsDefault: effectiveScope === defaultScope,
          onScopeChange: applyScope,
          onSetDefaultScope: handleSetDefaultScope,
          mode: effectiveMode,
          modeIsDefault: effectiveMode === defaultMode,
          onModeChange: applyMode,
          onSetDefaultMode: handleSetDefaultMode,
          spaces,
          collections: spaceGroups,
          tags: tagsCatalog,
          domains: domainsCatalog,
          selectedSpaceNames: queryAnalysis.filters.spaceIds,
          selectedTags: queryAnalysis.filters.tagNames,
          selectedSites: queryAnalysis.filters.domains,
          selectedMedia: queryAnalysis.filters.hasAny,
          activeDate: activeDateValue,
          onToggleSpace: (name) => toggleFilterToken("space", name),
          onSelectSpaces: addSpaceFilters,
          onToggleTag: (name) => toggleFilterToken("tag", name),
          onToggleSite: (domain) => toggleFilterToken("site", domain),
          onToggleMedia: (value) => toggleFilterToken("has", value),
          onSetDate: setDateFilter,
          onClearFilters: clearAllFilters,
        },
      }}
      summary={{
        loading: isLoading,
        resultMeta,
        error,
        debugEnabled: isDebugSearchEnabled,
        requestedScope,
        showsVectorStats: resultModeFeatures.vector,
        topVectorScore: topDebugVectorHit?.score ?? null,
        staleSuppressedCount,
        previousDisabled: prevDisabled,
        nextDisabled,
        onPreviousPage: goPrevPage,
        onNextPage: goNextPage,
      }}
      dialogs={{
        privateAccess: {
          open: unlockDialogOpen,
          loading: unlockDialogLoading,
          mode: unlockDialogMode,
          error: unlockDialogError,
          showPassword,
          requiresPassword: privateSpace?.access.requiresPassword ?? false,
          hasRecovery: privateSpace?.access.hasRecovery ?? false,
          recoveryQuestions: privateSpace?.access.recoveryQuestions ?? [],
          password: unlockPassword,
          confirmPassword: unlockConfirmPassword,
          question1: unlockQuestion1,
          question2: unlockQuestion2,
          answer1: unlockAnswer1,
          answer2: unlockAnswer2,
          onOpenChange: setUnlockDialogOpen,
          onModeChange: setUnlockDialogMode,
          onPasswordChange: setUnlockPassword,
          onConfirmPasswordChange: setUnlockConfirmPassword,
          onQuestion1Change: setUnlockQuestion1,
          onQuestion2Change: setUnlockQuestion2,
          onAnswer1Change: setUnlockAnswer1,
          onAnswer2Change: setUnlockAnswer2,
          onShowPasswordChange: setShowPassword,
          onReset: resetUnlockDialogState,
          onClearCredentials: clearUnlockCredentials,
          onShuffleQuestions: shuffleRecoveryQuestions,
          onSubmit: submitPrivateAccess,
        },
        changePassword: {
          open: changePasswordDialogOpen,
          loading: changePasswordLoading,
          error: changePasswordError,
          currentPassword: changePasswordCurrent,
          nextPassword: changePasswordNext,
          confirmPassword: changePasswordConfirm,
          onOpenChange: setChangePasswordDialogOpen,
          onCurrentPasswordChange: setChangePasswordCurrent,
          onNextPasswordChange: setChangePasswordNext,
          onConfirmPasswordChange: setChangePasswordConfirm,
          onReset: resetPasswordChange,
          onSubmit: submitPasswordChange,
        },
        createSpace: {
          open: createSpaceDialogOpen,
          loading: createSpaceLoading,
          name: createSpaceName,
          error: createSpaceError,
          onOpenChange: setCreateSpaceDialogOpen,
          onNameChange: setCreateSpaceName,
          onReset: resetCreateSpace,
          onSubmit: submitCreateSpace,
        },
        createSpaceGroup: {
          open: createSpaceGroupDialogOpen,
          loading: createSpaceGroupLoading,
          name: createSpaceGroupName,
          error: createSpaceGroupError,
          onOpenChange: setCreateSpaceGroupDialogOpen,
          onNameChange: setCreateSpaceGroupName,
          onReset: resetCreateSpaceGroup,
          onSubmit: submitCreateSpaceGroup,
        },
        browserBookmarks: {
          open: browserBookmarksDialogOpen,
          importing: browserBookmarksImporting,
          error: browserBookmarksError,
          onOpenChange: setBrowserBookmarksDialogOpen,
          onClearError: clearBrowserBookmarksError,
          onImport: importBrowserBookmarks,
        },
        githubStars: {
          open: githubStarsDialogOpen,
          importing: githubStarsImporting,
          token: githubStarsToken,
          error: githubStarsError,
          onOpenChange: setGithubStarsDialogOpen,
          onTokenChange: setGithubStarsToken,
          onReset: resetGitHubStarsImport,
          onImport: importGitHubStars,
        },
      }}
      content={{
        showEmptyState: showEmptySearchState,
        queryHasText: queryText.trim().length > 0,
        onClearQuery: clearQuery,
        hasActiveQuery,
        searchResults: {
          items,
          spaces,
          folders,
          collections: spaceGroups,
          onReveal: handleRevealItem,
          debugScoresByItemId: isDebugSearchEnabled
            ? debugScoresByItemId
            : undefined,
          showDebugScores: isDebugSearchEnabled,
          page: resultMeta.page,
          canPrev: !prevDisabled,
          canNext: !nextDisabled,
          onPrev: goPrevPage,
          onNext: goNextPage,
        },
        tabGroups: {
          folders: visibleFolders,
          items,
          spaces,
          preserveInputOrder,
          revealItemId: pendingRevealItemRef.current?.id,
          debugScoresByItemId: isDebugSearchEnabled
            ? debugScoresByItemId
            : undefined,
          showDebugScores: isDebugSearchEnabled,
        },
        bulkActions: {
          items,
          folders: visibleFolders,
          spaces,
          activeSpaceId,
        },
        onShare: openShare,
        showReturnToResults: Boolean(revealReturn) && !hasActiveQuery,
        onReturnToResults: handleBackToResults,
        onDismissReturn: () => setRevealReturn(null),
      }}
    />
  );
};

export default SearchInner;
