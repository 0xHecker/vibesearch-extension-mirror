import { PUBLIC_SPACE_ID } from "@src/common/spaces";
import { GITHUB_TOKEN_STORAGE_KEY } from "@src/pages/search/components/settings/sections/TokensSection";
import type { SpaceGroupDocType } from "@src/schemas/space_group_schema";
import type { SpaceListItem } from "@src/services/spaces/types";
import {
  showErrorToast,
  showLoadingToast,
  showSuccessToast,
} from "@src/utils/toast-feedback";
import { useBeforeUnloadGuard } from "@src/utils/useBeforeUnloadGuard";
import {
  useCallback,
  useState,
  type Dispatch,
  type SetStateAction,
} from "react";
import { z } from "zod";
import {
  parseBrowserBookmarkImportResult,
  parseGitHubStarsImportResult,
} from "./contracts";
import type { FolderLoadContext } from "../library/use-library-data";

type LibraryImportOptions = {
  loadSpaces: () => Promise<SpaceListItem[]>;
  loadSpaceGroups: () => Promise<SpaceGroupDocType[]>;
  loadFolders: (context?: FolderLoadContext) => Promise<void>;
  setActiveSpaceGroupId: Dispatch<SetStateAction<string | null>>;
  setSelectedFolderId: Dispatch<SetStateAction<string>>;
  refresh: () => void;
};

/** Owns long-running external library imports and their transient credentials. */
export function useLibraryImportDialogs({
  loadSpaces,
  loadSpaceGroups,
  loadFolders,
  setActiveSpaceGroupId,
  setSelectedFolderId,
  refresh,
}: LibraryImportOptions) {
  const [browserBookmarksDialogOpen, setBrowserBookmarksDialogOpen] =
    useState(false);
  const [browserBookmarksImporting, setBrowserBookmarksImporting] =
    useState(false);
  const [browserBookmarksError, setBrowserBookmarksError] = useState<
    string | null
  >(null);
  const [githubStarsDialogOpen, setGithubStarsDialogOpen] = useState(false);
  const [githubStarsToken, setGithubStarsToken] = useState("");
  const [githubStarsImporting, setGithubStarsImporting] = useState(false);
  const [githubStarsError, setGithubStarsError] = useState<string | null>(null);

  useBeforeUnloadGuard(browserBookmarksImporting || githubStarsImporting);

  const openBrowserBookmarksImport = useCallback((): void => {
    setBrowserBookmarksError(null);
    setBrowserBookmarksDialogOpen(true);
  }, []);

  const openGitHubStarsImport = useCallback(async (): Promise<void> => {
    setGithubStarsError(null);
    try {
      const storedValues = await chrome.storage.local.get(
        GITHUB_TOKEN_STORAGE_KEY,
      );
      const storedToken = z
        .string()
        .safeParse(storedValues[GITHUB_TOKEN_STORAGE_KEY]);
      if (storedToken.success && storedToken.data) {
        setGithubStarsToken(storedToken.data);
      }
    } catch (error) {
      console.warn("Could not read the saved GitHub token:", error);
    }
    setGithubStarsDialogOpen(true);
  }, []);

  const resetGitHubStarsImport = useCallback((): void => {
    setGithubStarsError(null);
    setGithubStarsToken("");
  }, []);

  const importBrowserBookmarks = useCallback(async (): Promise<void> => {
    setBrowserBookmarksError(null);
    setBrowserBookmarksImporting(true);
    const toastId = showLoadingToast(
      "Importing bookmarks — keep this tab open…",
    );
    try {
      const response = await chrome.runtime.sendMessage({
        target: "background",
        type: "IMPORT_BROWSER_BOOKMARKS",
      });
      if (!response?.success) {
        throw new Error(
          response?.error || "Could not import browser bookmarks.",
        );
      }

      const result = parseBrowserBookmarkImportResult(response.payload);
      const nextSpaces = await loadSpaces();
      await loadSpaceGroups();
      if (!nextSpaces.some((space) => result.spaceIds.includes(space.id))) {
        throw new Error(
          "Browser Bookmark spaces were not visible after import. Please retry.",
        );
      }
      await loadFolders({
        activeSpaceId: PUBLIC_SPACE_ID,
        searchScope: "global",
        spaceIds: result.spaceIds,
      });
      setActiveSpaceGroupId(result.spaceGroupId);
      setSelectedFolderId("all");
      window.setTimeout(refresh, 0);
      setBrowserBookmarksDialogOpen(false);
      showSuccessToast(
        `${result.bookmarkCount.toLocaleString()} bookmarks imported across ${result.spaceIds.length.toLocaleString()} spaces.`,
        { id: toastId },
      );
    } catch (error) {
      const message =
        error instanceof Error
          ? error.message
          : "Could not import browser bookmarks.";
      setBrowserBookmarksError(message);
      showErrorToast(message, { id: toastId });
    } finally {
      setBrowserBookmarksImporting(false);
    }
  }, [
    loadFolders,
    loadSpaceGroups,
    loadSpaces,
    refresh,
    setActiveSpaceGroupId,
    setSelectedFolderId,
  ]);

  const importGitHubStars = useCallback(async (): Promise<void> => {
    setGithubStarsError(null);
    setGithubStarsImporting(true);
    const toastId = showLoadingToast(
      "Importing GitHub stars — keep this tab open…",
    );
    try {
      const response = await chrome.runtime.sendMessage({
        target: "background",
        type: "IMPORT_GITHUB_STARS",
        payload: { accessToken: githubStarsToken },
      });
      if (!response?.success) {
        throw new Error(response?.error || "Could not import GitHub stars.");
      }

      const result = parseGitHubStarsImportResult(response.payload);
      await Promise.all([loadSpaces(), loadSpaceGroups()]);
      await loadFolders({
        activeSpaceId: PUBLIC_SPACE_ID,
        searchScope: "global",
        spaceIds: result.spaceIds,
      });
      setActiveSpaceGroupId(result.spaceGroupId);
      setSelectedFolderId("all");
      setGithubStarsToken("");
      setGithubStarsDialogOpen(false);
      refresh();
      showSuccessToast(
        `${result.importedCount.toLocaleString()} GitHub stars imported across ${result.spaceIds.length.toLocaleString()} spaces.`,
        { id: toastId },
      );
    } catch (error) {
      const message =
        error instanceof Error
          ? error.message
          : "Could not import GitHub stars.";
      setGithubStarsError(message);
      showErrorToast(message, { id: toastId });
    } finally {
      setGithubStarsImporting(false);
    }
  }, [
    githubStarsToken,
    loadFolders,
    loadSpaceGroups,
    loadSpaces,
    refresh,
    setActiveSpaceGroupId,
    setSelectedFolderId,
  ]);

  return {
    browserBookmarksDialogOpen,
    setBrowserBookmarksDialogOpen,
    browserBookmarksImporting,
    browserBookmarksError,
    clearBrowserBookmarksError: () => setBrowserBookmarksError(null),
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
  };
}
