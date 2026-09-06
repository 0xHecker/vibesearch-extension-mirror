import type { SearchQuerySubmitMeta } from "@src/pages/search/components/SearchQueryBar";
import {
  setDefaultSearchMode,
  setDefaultSearchScope,
} from "@src/pages/search/search-preferences";
import { analyzeQuery } from "@src/search-core/query-language";
import type {
  QueryAnalysis,
  QueryAssistCatalogs,
  QueryMode,
  QueryScope,
  RankQueryCursor,
} from "@src/search-core/contracts";
import {
  useCallback,
  useMemo,
  type Dispatch,
  type SetStateAction,
} from "react";

/** Query-language fields controlled by the date menu. */
const DATE_FILTER_FIELDS = new Set(["date", "added", "created", "updated"]);
const FILTER_FIELDS = new Set([
  "space",
  "folder",
  "tag",
  "site",
  "domain",
  "has",
  "date",
  "added",
  "created",
  "updated",
  "author",
  "is",
  "likes",
  "upvotes",
]);

type QueryDirective = "mode" | "scope";

type SearchQueryControlsOptions = {
  queryText: string;
  queryAnalysis: QueryAnalysis;
  isAnalysisCurrent: boolean;
  catalogs: QueryAssistCatalogs;
  defaultMode: QueryMode;
  defaultScope: QueryScope;
  setQueryText: Dispatch<SetStateAction<string>>;
  setQueryAnalysis: Dispatch<SetStateAction<QueryAnalysis>>;
  setQuerySubmitMeta: Dispatch<SetStateAction<SearchQuerySubmitMeta | null>>;
  setCursorAfter: Dispatch<SetStateAction<RankQueryCursor | null>>;
  setCursorPage: Dispatch<SetStateAction<number>>;
  setCursorHistory: Dispatch<SetStateAction<Array<RankQueryCursor | null>>>;
  refreshResults: () => void;
};

/** Keeps typed query language and point-and-click search controls in one state. */
export function useSearchQueryControls({
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
}: SearchQueryControlsOptions) {
  const resetPagination = useCallback((): void => {
    setCursorAfter(null);
    setCursorPage(1);
    setCursorHistory([]);
  }, [setCursorAfter, setCursorHistory, setCursorPage]);

  const applyQueryText = useCallback(
    (nextText: string): void => {
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
      refreshResults();
    },
    [
      catalogs,
      refreshResults,
      resetPagination,
      setQueryAnalysis,
      setQuerySubmitMeta,
      setQueryText,
    ],
  );

  const setDirective = useCallback(
    (field: QueryDirective, value: string): void => {
      const pill = queryAnalysis.pills.find((entry) => entry.field === field);
      const token = `${field}:${value}`;
      if (!pill) {
        applyQueryText(`${queryText} ${token}`);
        return;
      }
      applyQueryText(
        `${queryText.slice(0, pill.start)}${token}${queryText.slice(pill.end)}`,
      );
    },
    [applyQueryText, queryAnalysis.pills, queryText],
  );

  const removeDirective = useCallback(
    (field: QueryDirective): void => {
      const pill = queryAnalysis.pills.find((entry) => entry.field === field);
      if (!pill) return;
      applyQueryText(
        `${queryText.slice(0, pill.start)}${queryText.slice(pill.end)}`,
      );
    },
    [applyQueryText, queryAnalysis.pills, queryText],
  );

  const applyScope = useCallback(
    (scope: QueryScope): void => {
      if (scope === defaultScope) {
        removeDirective("scope");
        return;
      }
      setDirective("scope", scope);
    },
    [defaultScope, removeDirective, setDirective],
  );

  const applyMode = useCallback(
    (mode: QueryMode): void => {
      if (mode === defaultMode) {
        removeDirective("mode");
        return;
      }
      setDirective("mode", mode);
    },
    [defaultMode, removeDirective, setDirective],
  );

  const setDefaultMode = useCallback(
    (mode: QueryMode): void => {
      setDefaultSearchMode(mode);
      removeDirective("mode");
    },
    [removeDirective],
  );

  const setDefaultScope = useCallback(
    (scope: QueryScope): void => {
      setDefaultSearchScope(scope);
      removeDirective("scope");
    },
    [removeDirective],
  );

  const toggleFilter = useCallback(
    (field: string, value: string): void => {
      const existing = queryAnalysis.pills.find(
        (pill) =>
          pill.field === field &&
          pill.value.toLowerCase() === value.toLowerCase(),
      );
      if (existing) {
        applyQueryText(
          `${queryText.slice(0, existing.start)}${queryText.slice(existing.end)}`,
        );
        return;
      }
      const cleanValue = value.replace(/"/g, "");
      const token = /\s/.test(cleanValue)
        ? `${field}:"${cleanValue}"`
        : `${field}:${cleanValue}`;
      applyQueryText(`${queryText} ${token}`);
    },
    [applyQueryText, queryAnalysis.pills, queryText],
  );

  const setDateFilter = useCallback(
    (value: string | null): void => {
      const datePills = queryAnalysis.pills
        .filter((pill) => DATE_FILTER_FIELDS.has(pill.field))
        .sort((left, right) => right.start - left.start);
      let text = removePills(queryText, datePills);
      if (value) text = `${text} date:${value}`;
      applyQueryText(text);
    },
    [applyQueryText, queryAnalysis.pills, queryText],
  );

  const activeDateValue = useMemo(() => {
    const pill = queryAnalysis.pills.find((entry) =>
      DATE_FILTER_FIELDS.has(entry.field),
    );
    return pill?.value ?? null;
  }, [queryAnalysis.pills]);

  const clearAllFilters = useCallback((): void => {
    const pills = queryAnalysis.pills
      .filter((pill) => FILTER_FIELDS.has(pill.field))
      .sort((left, right) => right.start - left.start);
    applyQueryText(removePills(queryText, pills));
  }, [applyQueryText, queryAnalysis.pills, queryText]);

  const addSpaceFilters = useCallback(
    (names: string[]): void => {
      const selectedNames = isAnalysisCurrent
        ? queryAnalysis.filters.spaceIds
        : [];
      const present = new Set(selectedNames.map((name) => name.toLowerCase()));
      const tokens = names
        .filter((name) => !present.has(name.toLowerCase()))
        .map((name) => queryToken("space", name));
      if (tokens.length === 0) return;
      applyQueryText(`${queryText} ${tokens.join(" ")}`);
    },
    [
      applyQueryText,
      isAnalysisCurrent,
      queryAnalysis.filters.spaceIds,
      queryText,
    ],
  );

  const preserveInputOrder = useMemo(
    () =>
      isAnalysisCurrent &&
      (queryAnalysis.textGroups.length > 0 ||
        queryAnalysis.directives.sortBy !== undefined),
    [
      isAnalysisCurrent,
      queryAnalysis.directives.sortBy,
      queryAnalysis.textGroups.length,
    ],
  );

  const clearQuery = useCallback(
    (): void => applyQueryText(""),
    [applyQueryText],
  );

  return {
    applyScope,
    applyMode,
    setDefaultMode,
    setDefaultScope,
    toggleFilter,
    setDateFilter,
    activeDateValue,
    clearAllFilters,
    addSpaceFilters,
    preserveInputOrder,
    clearQuery,
  };
}

type QueryPillRange = { start: number; end: number };

function removePills(text: string, pills: QueryPillRange[]): string {
  let next = text;
  for (const pill of pills) {
    next = `${next.slice(0, pill.start)}${next.slice(pill.end)}`;
  }
  return next;
}

function queryToken(field: string, value: string): string {
  const cleanValue = value.replace(/"/g, "");
  return /\s/.test(cleanValue)
    ? `${field}:"${cleanValue}"`
    : `${field}:${cleanValue}`;
}
