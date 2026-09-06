import type { SearchQuerySubmitMeta } from "@src/pages/search/components/SearchQueryBar";
import { shouldUseCursorPagination } from "@src/search-core/pagination";
import { analyzeQuery } from "@src/search-core/query-language";
import type {
  QueryAnalysis,
  QueryAssistCatalogs,
  RankQueryCursor,
} from "@src/search-core/contracts";
import type { SearchResultMeta } from "./model";
import { useCallback, type Dispatch, type SetStateAction } from "react";

type SearchPaginationOptions = {
  queryText: string;
  queryAnalysis: QueryAnalysis;
  catalogs: QueryAssistCatalogs;
  resultMeta: SearchResultMeta;
  isLoading: boolean;
  cursorAfter: RankQueryCursor | null;
  cursorHistory: Array<RankQueryCursor | null>;
  setQueryText: Dispatch<SetStateAction<string>>;
  setQueryAnalysis: Dispatch<SetStateAction<QueryAnalysis>>;
  setQuerySubmitMeta: Dispatch<SetStateAction<SearchQuerySubmitMeta | null>>;
  setCursorAfter: Dispatch<SetStateAction<RankQueryCursor | null>>;
  setCursorPage: Dispatch<SetStateAction<number>>;
  setCursorHistory: Dispatch<SetStateAction<Array<RankQueryCursor | null>>>;
  refreshResults: () => void;
};

/** Owns both explicit page directives and ranked cursor navigation. */
export function useSearchPagination({
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
}: SearchPaginationOptions) {
  const usesCursor = shouldUseCursorPagination(queryAnalysis.directives.page);
  const previousDisabled =
    isLoading ||
    (usesCursor ? cursorHistory.length === 0 : resultMeta.page <= 1);
  const nextDisabled =
    isLoading || (usesCursor ? !resultMeta.nextCursor : !resultMeta.hasMore);

  const setPageDirective = useCallback(
    (page: number): void => {
      const nextQueryText = replacePageDirective(queryText, page);
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
      refreshResults();
    },
    [
      catalogs,
      queryText,
      refreshResults,
      setCursorAfter,
      setCursorHistory,
      setCursorPage,
      setQueryAnalysis,
      setQuerySubmitMeta,
      setQueryText,
    ],
  );

  const goToPreviousPage = useCallback((): void => {
    if (!usesCursor) {
      setPageDirective(resultMeta.page - 1);
      return;
    }
    if (cursorHistory.length === 0) return;
    setCursorHistory(cursorHistory.slice(0, -1));
    setCursorAfter(cursorHistory[cursorHistory.length - 1] ?? null);
    setCursorPage((value) => Math.max(1, value - 1));
    refreshResults();
    scrollToPageTop();
  }, [
    cursorHistory,
    refreshResults,
    resultMeta.page,
    setCursorAfter,
    setCursorHistory,
    setCursorPage,
    setPageDirective,
    usesCursor,
  ]);

  const goToNextPage = useCallback((): void => {
    if (!usesCursor) {
      setPageDirective(resultMeta.page + 1);
      return;
    }
    if (!resultMeta.nextCursor) return;
    setCursorHistory((history) => [...history, cursorAfter]);
    setCursorAfter(resultMeta.nextCursor);
    setCursorPage((value) => value + 1);
    refreshResults();
    scrollToPageTop();
  }, [
    cursorAfter,
    refreshResults,
    resultMeta.nextCursor,
    resultMeta.page,
    setCursorAfter,
    setCursorHistory,
    setCursorPage,
    setPageDirective,
    usesCursor,
  ]);

  return {
    previousDisabled,
    nextDisabled,
    goToPreviousPage,
    goToNextPage,
  };
}

function replacePageDirective(queryText: string, page: number): string {
  const safePage = Math.max(1, Math.floor(page));
  const token = `page:${safePage}`;
  if (/\bpage:\d+\b/i.test(queryText)) {
    return queryText.replace(/\bpage:\d+\b/i, token);
  }
  return `${queryText.trim()} ${token}`.trim();
}

function scrollToPageTop(): void {
  window.scrollTo({ top: 0, behavior: "smooth" });
}
