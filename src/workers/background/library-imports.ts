import { scheduleForProcessing } from "@src/services/metadata-pipeline";
import type { BrowserBookmarkImportResult } from "@src/services/browser-bookmark-import";
import {
  BROWSER_BOOKMARK_RESYNC_ALARM_NAME,
  BrowserBookmarkResyncScheduler,
} from "@src/services/browser-bookmark-resync";
import type {
  GitHubStar,
  GitHubStarsImportResult,
} from "@src/services/github-stars-import";
import { collectGitHubStarsPages } from "@src/services/github-stars-api";
import { sendProcessStatus } from "@src/workers/background/process-status";
import {
  runBackgroundDataJob,
  sendForwardedToOffscreen,
} from "@src/workers/background/runtime";

const BROWSER_BOOKMARK_AUTO_SYNC_ENABLED_KEY =
  "vibesearch:browserBookmarkAutoSyncEnabled:v1";

type ImportOptions = {
  silent?: boolean;
  afterInFlight?: boolean;
};

type LibraryImportDependencies = {
  scheduleMenuRefresh: () => void;
  triggerCloudSync: () => Promise<void>;
};

export type LibraryImportCoordinator = {
  importBrowserBookmarks: (
    options?: ImportOptions,
  ) => Promise<BrowserBookmarkImportResult>;
  importGitHubStars: (accessToken: string) => Promise<GitHubStarsImportResult>;
  onBrowserBookmarkImportBegan: () => Promise<void>;
  onBrowserBookmarkImportEnded: () => Promise<void>;
  onBrowserBookmarkResyncAlarm: () => Promise<void>;
  requestBrowserBookmarkResync: () => void;
  resetBrowserBookmarkImportState: () => Promise<void>;
};

const fetchGitHubStars = async (accessToken: string): Promise<GitHubStar[]> => {
  const token = accessToken.trim();
  if (!token) throw new Error("GITHUB_TOKEN_REQUIRED");

  const headers = {
    Accept: "application/vnd.github+json",
    Authorization: `Bearer ${token}`,
    "X-GitHub-Api-Version": "2022-11-28",
  };
  return collectGitHubStarsPages(async (page, pageSize) => {
    const url = new URL("https://api.github.com/user/starred");
    url.searchParams.set("per_page", String(pageSize));
    url.searchParams.set("page", String(page));
    url.searchParams.set("sort", "created");
    url.searchParams.set("direction", "desc");
    const response = await fetch(url, { headers });
    if (!response.ok) {
      const detail = await response.text().catch(() => "");
      throw new Error(
        `GitHub stars request failed: ${response.status} ${detail.slice(0, 200)}`,
      );
    }
    return response.json();
  });
};

export const createLibraryImportCoordinator = (
  dependencies: LibraryImportDependencies,
): LibraryImportCoordinator => {
  let browserImportInFlight: Promise<BrowserBookmarkImportResult> | null = null;
  let githubImportInFlight: Promise<GitHubStarsImportResult> | null = null;
  let browserAutoSyncEnabled: boolean | null = null;
  let browserAutoSyncEnabledLoad: Promise<boolean> | null = null;

  const markBrowserAutoSyncEnabled = async (): Promise<void> => {
    try {
      await chrome.storage.local.set({
        [BROWSER_BOOKMARK_AUTO_SYNC_ENABLED_KEY]: true,
      });
      browserAutoSyncEnabled = true;
    } catch (error) {
      console.warn(
        "[browserBookmarks] could not persist automatic sync preference",
        error,
      );
    }
  };

  const isBrowserAutoSyncEnabled = async (): Promise<boolean> => {
    if (browserAutoSyncEnabled !== null) return browserAutoSyncEnabled;
    if (browserAutoSyncEnabledLoad) return browserAutoSyncEnabledLoad;

    const load = (async () => {
      try {
        const stored = await chrome.storage.local.get(
          BROWSER_BOOKMARK_AUTO_SYNC_ENABLED_KEY,
        );
        const explicitValue = stored[BROWSER_BOOKMARK_AUTO_SYNC_ENABLED_KEY];
        if (explicitValue === true || explicitValue === false)
          return explicitValue;

        // Existing installations with browser imports are upgraded once.
        // Fresh profiles stay opt-in until an explicit import from the app.
        const imported = await sendForwardedToOffscreen<boolean>({
          service: "browserBookmarks",
          type: "hasImported",
        });
        await chrome.storage.local.set({
          [BROWSER_BOOKMARK_AUTO_SYNC_ENABLED_KEY]: imported,
        });
        return imported;
      } catch (error) {
        console.warn(
          "[browserBookmarks] automatic sync availability check failed",
          error,
        );
        return false;
      }
    })();
    browserAutoSyncEnabledLoad = load;
    try {
      const enabled = await load;
      browserAutoSyncEnabled = enabled;
      return enabled;
    } finally {
      if (browserAutoSyncEnabledLoad === load)
        browserAutoSyncEnabledLoad = null;
    }
  };

  const importBrowserBookmarks = async (
    options: ImportOptions = {},
  ): Promise<BrowserBookmarkImportResult> => {
    if (browserImportInFlight) {
      if (!options.afterInFlight) return browserImportInFlight;
      try {
        await browserImportInFlight;
      } catch {
        // Always read a fresh tree after an overlapping failed import. This
        // preserves browser mutations that landed while that import ran.
      }
      return importBrowserBookmarks({ ...options, afterInFlight: false });
    }

    const run = (async () => {
      if (!chrome.bookmarks?.getTree) {
        throw new Error(
          "Browser bookmark access is not available in this browser.",
        );
      }

      if (!options.silent) {
        sendProcessStatus(
          "browser-bookmarks",
          "Browser bookmarks",
          "processing",
          "Reading your bookmark folders...",
        );
      }
      const tree = await chrome.bookmarks.getTree();
      if (!options.silent) {
        sendProcessStatus(
          "browser-bookmarks",
          "Browser bookmarks",
          "processing",
          "Preserving folders and importing bookmarks...",
        );
      }
      const result =
        await sendForwardedToOffscreen<BrowserBookmarkImportResult>({
          service: "browserBookmarks",
          type: "importTree",
          payload: { tree },
        });
      const metadataUrls = result.metadataUrls;
      if (metadataUrls.length > 0) {
        if (!options.silent) {
          sendProcessStatus(
            "browser-bookmarks",
            "Browser bookmarks",
            "processing",
            `Queueing metadata for ${metadataUrls.length.toLocaleString()} bookmarks...`,
          );
        }
        scheduleForProcessing(metadataUrls, false);
      }
      await markBrowserAutoSyncEnabled();
      dependencies.scheduleMenuRefresh();
      if (
        result.updatedFolderCount === 0 &&
        result.updatedBookmarkCount === 0 &&
        result.removedBookmarkCount === 0
      ) {
        void dependencies.triggerCloudSync();
      }
      if (!options.silent) {
        sendProcessStatus(
          "browser-bookmarks",
          "Browser bookmarks",
          "success",
          `Imported ${result.bookmarkCount.toLocaleString()} bookmarks across ${result.spaceIds.length.toLocaleString()} spaces; metadata queued for ${metadataUrls.length.toLocaleString()}.`,
        );
      }
      return result;
    })();

    browserImportInFlight = run;
    try {
      return await run;
    } catch (error) {
      const detail =
        error instanceof Error
          ? error.message
          : "Browser bookmark import failed.";
      if (!options.silent) {
        sendProcessStatus(
          "browser-bookmarks",
          "Browser bookmarks",
          "error",
          detail,
        );
      }
      throw error;
    } finally {
      browserImportInFlight = null;
    }
  };

  const resyncScheduler = new BrowserBookmarkResyncScheduler({
    isEnabled: isBrowserAutoSyncEnabled,
    runSync: async () => {
      await runBackgroundDataJob(() =>
        importBrowserBookmarks({ silent: true, afterInFlight: true }),
      );
    },
    createFallbackAlarm: async (when) => {
      await chrome.alarms.create(BROWSER_BOOKMARK_RESYNC_ALARM_NAME, { when });
    },
    clearFallbackAlarm: async () => {
      await chrome.alarms.clear(BROWSER_BOOKMARK_RESYNC_ALARM_NAME);
    },
    onError: (error) => {
      console.warn("[browserBookmarks] automatic resync failed", error);
    },
  });

  const importGitHubStars = async (
    accessToken: string,
  ): Promise<GitHubStarsImportResult> => {
    if (githubImportInFlight) return githubImportInFlight;

    const run = (async () => {
      sendProcessStatus(
        "github-stars",
        "GitHub stars",
        "processing",
        "Reading starred repositories...",
      );
      const stars = await fetchGitHubStars(accessToken);
      sendProcessStatus(
        "github-stars",
        "GitHub stars",
        "processing",
        "Importing starred repositories...",
      );
      const result = await sendForwardedToOffscreen<GitHubStarsImportResult>({
        service: "githubStars",
        type: "importStars",
        payload: { stars },
      });
      if (result.metadataUrls.length > 0) {
        sendProcessStatus(
          "github-stars",
          "GitHub stars",
          "processing",
          `Queueing metadata for ${result.metadataUrls.length.toLocaleString()} starred repositories...`,
        );
        scheduleForProcessing(result.metadataUrls, false);
      }
      dependencies.scheduleMenuRefresh();
      sendProcessStatus(
        "github-stars",
        "GitHub stars",
        "success",
        `Imported ${result.importedCount.toLocaleString()} starred repositories across ${result.spaceIds.length.toLocaleString()} spaces; metadata queued for ${result.metadataUrls.length.toLocaleString()}.`,
      );
      return result;
    })();

    githubImportInFlight = run;
    try {
      return await run;
    } catch (error) {
      const detail =
        error instanceof Error ? error.message : "GitHub stars import failed.";
      sendProcessStatus("github-stars", "GitHub stars", "error", detail);
      throw error;
    } finally {
      githubImportInFlight = null;
    }
  };

  return {
    importBrowserBookmarks,
    importGitHubStars,
    onBrowserBookmarkImportBegan: () => resyncScheduler.onImportBegan(),
    onBrowserBookmarkImportEnded: () => resyncScheduler.onImportEnded(),
    onBrowserBookmarkResyncAlarm: () => resyncScheduler.onFallbackAlarm(),
    requestBrowserBookmarkResync: () => {
      void resyncScheduler.request();
    },
    resetBrowserBookmarkImportState: async () => {
      browserAutoSyncEnabled = false;
      browserAutoSyncEnabledLoad = null;
      await chrome.storage.local.set({
        [BROWSER_BOOKMARK_AUTO_SYNC_ENABLED_KEY]: false,
      });
      await resyncScheduler.reset();
    },
  };
};
