import { PUBLIC_SPACE_ID } from "@src/common/spaces";
import type { SearchQuerySubmitMeta } from "@src/pages/search/components/SearchQueryBar";
import {
  findItemElementByDataId,
  revalidateRevealItem,
} from "@src/pages/search/reveal-target";
import { resolveSearchResultSelectionContext } from "@src/pages/search/selection-state";
import type { ItemDocType } from "@src/schemas/item_schema";
import { analyzeQuery } from "@src/search-core/query-language";
import type {
  QueryAnalysis,
  QueryAssistCatalogs,
  RankQueryCursor,
} from "@src/search-core/contracts";
import {
  resolveToastErrorMessage,
  showErrorToast,
} from "@src/utils/toast-feedback";
import {
  useCallback,
  useEffect,
  useRef,
  type Dispatch,
  type MutableRefObject,
  type SetStateAction,
} from "react";
import { parseItemListResponse } from "./contracts";

export type RevealReturn = { query: string };

type SearchResultRevealOptions = {
  queryText: string;
  catalogs: QueryAssistCatalogs;
  items: ItemDocType[];
  folderCount: number;
  hasActiveQuery: boolean;
  isLoading: boolean;
  revealReturn: RevealReturn | null;
  pendingRevealItem: MutableRefObject<ItemDocType | null>;
  setRevealReturn: Dispatch<SetStateAction<RevealReturn | null>>;
  setItems: Dispatch<SetStateAction<ItemDocType[]>>;
  setActiveSpaceId: Dispatch<SetStateAction<string>>;
  setActiveSpaceGroupId: Dispatch<SetStateAction<string | null>>;
  setSelectedFolderId: Dispatch<SetStateAction<string>>;
  setQueryText: Dispatch<SetStateAction<string>>;
  setQueryAnalysis: Dispatch<SetStateAction<QueryAnalysis>>;
  setQuerySubmitMeta: Dispatch<SetStateAction<SearchQuerySubmitMeta | null>>;
  setCursorAfter: Dispatch<SetStateAction<RankQueryCursor | null>>;
  setCursorPage: Dispatch<SetStateAction<number>>;
  setCursorHistory: Dispatch<SetStateAction<Array<RankQueryCursor | null>>>;
  refreshResults: () => void;
};

/** Revalidates search results before revealing them in their browse location. */
export function useSearchResultReveal({
  queryText,
  catalogs,
  items,
  folderCount,
  hasActiveQuery,
  isLoading,
  revealReturn,
  pendingRevealItem,
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
}: SearchResultRevealOptions) {
  const revealRequest = useRef(0);

  const revealItem = useCallback(
    async (item: ItemDocType): Promise<void> => {
      const requestId = ++revealRequest.current;
      let currentItem: ItemDocType | null;
      try {
        currentItem = await revalidateRevealItem(item, loadCurrentItem);
      } catch (error) {
        if (requestId !== revealRequest.current) return;
        showErrorToast(
          resolveToastErrorMessage(
            error,
            "Could not refresh this result's location.",
          ),
        );
        return;
      }
      if (requestId !== revealRequest.current) return;
      if (!currentItem) {
        setItems((current) => current.filter((entry) => entry.id !== item.id));
        showErrorToast("This result moved to Bin or is no longer available.");
        refreshResults();
        return;
      }

      setRevealReturn(
        (current) =>
          current ?? (queryText.trim() ? { query: queryText } : null),
      );
      const selection = resolveSearchResultSelectionContext(currentItem);
      setActiveSpaceId(selection.activeSpaceId);
      setActiveSpaceGroupId(selection.activeSpaceGroupId);
      setSelectedFolderId(selection.selectedFolderId);
      applyQuery("", catalogs, {
        setQueryText,
        setQueryAnalysis,
        setQuerySubmitMeta,
        setCursorAfter,
        setCursorPage,
        setCursorHistory,
      });
      pendingRevealItem.current = currentItem;
      refreshResults();
    },
    [
      catalogs,
      pendingRevealItem,
      queryText,
      refreshResults,
      setActiveSpaceGroupId,
      setActiveSpaceId,
      setCursorAfter,
      setCursorHistory,
      setCursorPage,
      setItems,
      setQueryAnalysis,
      setQuerySubmitMeta,
      setQueryText,
      setRevealReturn,
      setSelectedFolderId,
    ],
  );

  const backToResults = useCallback((): void => {
    const previousQuery = revealReturn?.query ?? "";
    setRevealReturn(null);
    if (!previousQuery.trim()) return;
    applyQuery(previousQuery, catalogs, {
      setQueryText,
      setQueryAnalysis,
      setQuerySubmitMeta,
      setCursorAfter,
      setCursorPage,
      setCursorHistory,
    });
    refreshResults();
  }, [
    catalogs,
    refreshResults,
    revealReturn,
    setCursorAfter,
    setCursorHistory,
    setCursorPage,
    setQueryAnalysis,
    setQuerySubmitMeta,
    setQueryText,
    setRevealReturn,
  ]);

  useEffect(() => {
    const targetId = pendingRevealItem.current?.id;
    if (!targetId || hasActiveQuery || isLoading) return;
    const prefersReducedMotion = window.matchMedia(
      "(prefers-reduced-motion: reduce)",
    ).matches;
    const timer = window.setTimeout(() => {
      const node = findItemElementByDataId<HTMLElement>(document, targetId);
      if (!node) return;
      pendingRevealItem.current = null;
      node.scrollIntoView({
        behavior: prefersReducedMotion ? "auto" : "smooth",
        block: "center",
      });
      node.classList.add("search-reveal-flash");
      window.setTimeout(
        () => node.classList.remove("search-reveal-flash"),
        1300,
      );
    }, 220);
    return () => window.clearTimeout(timer);
  }, [folderCount, hasActiveQuery, isLoading, items, pendingRevealItem]);

  return { revealItem, backToResults };
}

async function loadCurrentItem(
  itemId: string,
): Promise<readonly ItemDocType[]> {
  const response = parseItemListResponse(
    await chrome.runtime.sendMessage({
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
    }),
  );
  if (!response.success) {
    throw new Error("Could not refresh this result's location.");
  }
  return response.payload;
}

type QueryStateSetters = {
  setQueryText: Dispatch<SetStateAction<string>>;
  setQueryAnalysis: Dispatch<SetStateAction<QueryAnalysis>>;
  setQuerySubmitMeta: Dispatch<SetStateAction<SearchQuerySubmitMeta | null>>;
  setCursorAfter: Dispatch<SetStateAction<RankQueryCursor | null>>;
  setCursorPage: Dispatch<SetStateAction<number>>;
  setCursorHistory: Dispatch<SetStateAction<Array<RankQueryCursor | null>>>;
};

function applyQuery(
  query: string,
  catalogs: QueryAssistCatalogs,
  setters: QueryStateSetters,
): void {
  const analysis = analyzeQuery({
    type: "ANALYZE_QUERY",
    requestId: Date.now(),
    input: query,
    cursor: query.length,
    catalogs,
    forceSuggestions: false,
  });
  setters.setQueryText(query);
  setters.setQueryAnalysis(analysis);
  setters.setQuerySubmitMeta(null);
  setters.setCursorAfter(null);
  setters.setCursorPage(1);
  setters.setCursorHistory([]);
}
