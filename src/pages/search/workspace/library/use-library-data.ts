import {
  DEFAULT_BIN_PAGE_SIZE,
  toBinEntryCursor,
  type BinEntry,
  type BinEntryCursor,
} from "@src/common/bin";
import { PUBLIC_SPACE_ID } from "@src/common/spaces";
import { buildFolderLoadKey } from "@src/pages/search/selection-state";
import type { FolderDocType } from "@src/schemas/folder_schema";
import type { SpaceGroupDocType } from "@src/schemas/space_group_schema";
import type { QueryScope } from "@src/search-core/contracts";
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type Dispatch,
  type SetStateAction,
} from "react";
import {
  parseBinPage,
  parseFolderList,
  parseSpaceGroupList,
  parseSpaceList,
  parseTagSummaries,
} from "./contracts";
import { sortFolders, sortSpaces, type SpaceListItem } from "../query/model";

export type FolderLoadContext = {
  activeSpaceId?: string;
  searchScope?: QueryScope;
  spaceIds?: string[];
};

type LibraryDataOptions = {
  activeSpaceId: string;
  requestedScope: QueryScope;
  setActiveSpaceId: Dispatch<SetStateAction<string>>;
  setActiveSpaceGroupId: Dispatch<SetStateAction<string | null>>;
};

/** Owns list loading and pagination for the user's local library. */
export function useLibraryData({
  activeSpaceId,
  requestedScope,
  setActiveSpaceId,
  setActiveSpaceGroupId,
}: LibraryDataOptions) {
  const [spaces, setSpaces] = useState<SpaceListItem[]>([]);
  const [spaceGroups, setSpaceGroups] = useState<SpaceGroupDocType[]>([]);
  const [folders, setFolders] = useState<FolderDocType[]>([]);
  const [loadedFolderKey, setLoadedFolderKey] = useState<string | null>(null);
  const [tagsCatalog, setTagsCatalog] = useState<
    Array<{ id: string; name: string }>
  >([]);
  const [binEntries, setBinEntries] = useState<BinEntry[]>([]);
  const [binTotal, setBinTotal] = useState(0);
  const [binHasMore, setBinHasMore] = useState(false);
  const [binPageLoading, setBinPageLoading] = useState(false);
  const [binPageCursor, setBinPageCursor] = useState<BinEntryCursor | null>(
    null,
  );
  const [binCursorHistory, setBinCursorHistory] = useState<
    Array<BinEntryCursor | null>
  >([]);

  const binLoadRequest = useRef(0);
  const folderLoadRequest = useRef(0);
  const tagReloadTimer = useRef<number | null>(null);

  useEffect(
    () => () => {
      if (tagReloadTimer.current !== null) {
        window.clearTimeout(tagReloadTimer.current);
      }
    },
    [],
  );

  const loadSpaces = useCallback(async (): Promise<SpaceListItem[]> => {
    try {
      const response = await chrome.runtime.sendMessage({
        service: "spaces",
        type: "listSpaces",
        target: "offscreen",
      });
      if (!response?.success) return [];
      const rows = sortSpaces(parseSpaceList(response.payload));
      setSpaces(rows);
      if (rows.length === 0) return [];
      setActiveSpaceId((current) =>
        rows.some((space) => space.id === current) ? current : PUBLIC_SPACE_ID,
      );
      return rows;
    } catch (error) {
      console.error("Failed to load spaces:", error);
      return [];
    }
  }, [setActiveSpaceId]);

  const loadSpaceGroups = useCallback(async (): Promise<
    SpaceGroupDocType[]
  > => {
    try {
      const response = await chrome.runtime.sendMessage({
        service: "spaceGroups",
        type: "listSpaceGroups",
        target: "offscreen",
      });
      if (!response?.success) return [];
      const rows = parseSpaceGroupList(response.payload).sort(
        (left, right) =>
          left.sortOrder - right.sortOrder || left.createdAt - right.createdAt,
      );
      setSpaceGroups(rows);
      setActiveSpaceGroupId((current) =>
        rows.some((group) => group.id === current) ? current : null,
      );
      return rows;
    } catch (error) {
      console.error("Failed to load space groups:", error);
      return [];
    }
  }, [setActiveSpaceGroupId]);

  const loadBinPage = useCallback(
    async (after: BinEntryCursor | null): Promise<boolean> => {
      const requestId = ++binLoadRequest.current;
      setBinPageLoading(true);
      try {
        const response = await chrome.runtime.sendMessage({
          service: "bin",
          type: "listContents",
          target: "offscreen",
          payload: { limit: DEFAULT_BIN_PAGE_SIZE, after },
        });
        if (!response?.success || requestId !== binLoadRequest.current) {
          return false;
        }
        const page = parseBinPage(response.payload, DEFAULT_BIN_PAGE_SIZE);
        setBinEntries(page.entries.slice(0, DEFAULT_BIN_PAGE_SIZE));
        setBinTotal(page.total);
        setBinHasMore(page.hasMore);
        return true;
      } catch (error) {
        console.error("Failed to load bin contents:", error);
        return false;
      } finally {
        if (requestId === binLoadRequest.current) setBinPageLoading(false);
      }
    },
    [],
  );

  const loadBinContents = useCallback(async (): Promise<void> => {
    if (await loadBinPage(null)) {
      setBinPageCursor(null);
      setBinCursorHistory([]);
    }
  }, [loadBinPage]);

  const loadNextBinPage = useCallback(async (): Promise<void> => {
    if (binPageLoading || !binHasMore || binEntries.length === 0) return;
    const nextCursor = toBinEntryCursor(binEntries[binEntries.length - 1]);
    if (!(await loadBinPage(nextCursor))) return;
    setBinCursorHistory((history) => [...history, binPageCursor]);
    setBinPageCursor(nextCursor);
  }, [binEntries, binHasMore, binPageCursor, binPageLoading, loadBinPage]);

  const loadPreviousBinPage = useCallback(async (): Promise<void> => {
    if (binPageLoading || binCursorHistory.length === 0) return;
    const previousCursor = binCursorHistory[binCursorHistory.length - 1];
    if (!(await loadBinPage(previousCursor))) return;
    setBinCursorHistory((history) => history.slice(0, -1));
    setBinPageCursor(previousCursor);
  }, [binCursorHistory, binPageLoading, loadBinPage]);

  const loadFolders = useCallback(
    async (context?: FolderLoadContext): Promise<void> => {
      const contextSpaceId = context?.activeSpaceId ?? activeSpaceId;
      const contextScope = context?.searchScope ?? requestedScope;
      const resolvedScope = context?.spaceIds?.length ? "global" : contextScope;
      const loadKey = buildFolderLoadKey({
        activeSpaceId: contextSpaceId,
        searchScope: resolvedScope,
        spaceIds: context?.spaceIds,
      });
      const requestId = ++folderLoadRequest.current;
      try {
        const response = await chrome.runtime.sendMessage({
          service: "dbManager",
          type: "getAllFolders",
          target: "offscreen",
          payload: {
            accessContext: {
              activeSpaceId: contextSpaceId,
              searchScope: resolvedScope,
            },
            spaceIds: context?.spaceIds,
          },
        });
        if (!response?.success || requestId !== folderLoadRequest.current) {
          return;
        }
        const rows = sortFolders(parseFolderList(response.payload)).map(
          (folder) => ({
            ...folder,
            spaceId: folder.spaceId || PUBLIC_SPACE_ID,
          }),
        );
        setFolders(rows);
        setLoadedFolderKey(loadKey);
      } catch (error) {
        console.error("Failed to load folders:", error);
      }
    },
    [activeSpaceId, requestedScope],
  );

  const loadTags = useCallback(async (): Promise<void> => {
    try {
      const response = await chrome.runtime.sendMessage({
        service: "tags",
        type: "searchTags",
        target: "offscreen",
        payload: {
          query: "",
          limit: 200,
          accessContext: { activeSpaceId, searchScope: requestedScope },
        },
      });
      if (response?.success) {
        setTagsCatalog(parseTagSummaries(response.payload));
      }
    } catch (error) {
      console.error("Failed to load tags:", error);
    }
  }, [activeSpaceId, requestedScope]);

  const scheduleTagReload = useCallback((): void => {
    if (tagReloadTimer.current !== null) {
      window.clearTimeout(tagReloadTimer.current);
    }
    tagReloadTimer.current = window.setTimeout(() => {
      tagReloadTimer.current = null;
      void loadTags();
    }, 150);
  }, [loadTags]);

  return {
    spaces,
    setSpaces,
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
  };
}
