import { selectQuickSaveFolderTarget } from "@src/common/import-lru";
import { PUBLIC_SPACE_ID } from "@src/common/spaces";
import type { FolderDocType } from "@src/schemas/folder_schema";
import type { ImportTargetSpace } from "@src/services/db-manager";
import type {
  ImportClickContext,
  ImportMode,
  ImportTarget,
} from "@src/workers/background/import-types";
import { autoFolderName, trimText } from "@src/workers/background/import-utils";
import {
  buildLruEntryFromFolder,
  fetchSpaceName,
  loadLiveImportSpaces,
  pruneLruFolders,
  recordLruFolder,
  resolveFreshLiveImportFolder,
} from "@src/workers/background/import-storage";
import { sendForwardedToOffscreen } from "@src/workers/background/runtime";

const IMPORT_CONTEXTS: NonNullable<
  chrome.contextMenus.CreateProperties["contexts"]
> = [
  chrome.contextMenus.ContextType.PAGE,
  chrome.contextMenus.ContextType.FRAME,
  chrome.contextMenus.ContextType.SELECTION,
  chrome.contextMenus.ContextType.LINK,
  chrome.contextMenus.ContextType.IMAGE,
  chrome.contextMenus.ContextType.VIDEO,
  chrome.contextMenus.ContextType.AUDIO,
];
const MENU_ROOT_ID = "vs:root";
export const MENU_OPEN_SEARCH_ID = "vs:open:search";
export const MENU_IMPORT_SHARED_ID = "vs:import:shared";
export const MENU_SAVE_IMAGE_ID = "vs:save:image";
export const MENU_SAVE_VIDEO_ID = "vs:save:video";
export const MENU_SAVE_LINK_ID = "vs:save:link";
export const MENU_SAVE_SELECTION_ID = "vs:save:selection";
export const MENU_SAVE_PAGE_ID = "vs:save:page";
export const MENU_SAVE_SNAPSHOT_ID = "vs:save:snapshot";
export const MENU_EXTRACT_TEXT_ID = "vs:extract:text";
export const MENU_SHOT_VISIBLE_ID = "vs:shot:visible";
export const MENU_SHOT_REGION_ID = "vs:shot:region";
const MENU_SAVE_TARGETS_ID = "vs:targets:save";
const MENU_EXTRACT_TARGETS_ID = "vs:targets:extract";
const MENU_REFRESH_DEBOUNCE_MS = 180;
const MENU_REFRESH_LOW_PRIORITY_DEBOUNCE_MS = 900;
const MENU_REFRESH_MIN_INTERVAL_MS = 2500;

export const resolveTargetFolder = async (
  target: { spaceId: string; folderId?: string; newFolderName?: string },
  context: ImportClickContext,
  mode: ImportMode,
) => {
  const folderId = (target.folderId || "").trim();
  if (folderId) return folderId;
  const created = await sendForwardedToOffscreen<FolderDocType>({
    service: "folders",
    type: "create",
    payload: {
      name:
        (target.newFolderName || "").trim() || autoFolderName(context, mode),
      userId: "",
      spaceId: target.spaceId || PUBLIC_SPACE_ID,
      allowLockedPrivateWrite: true,
    },
  });
  if (!created?.id) throw new Error("Could not create destination folder.");
  return created.id;
};

export const recordFolderToLru = async (
  folderId: string,
  fallbackSpaceId: string,
  fallbackName?: string,
): Promise<void> => {
  if (!folderId) return;
  try {
    const folder = await sendForwardedToOffscreen<FolderDocType | null>({
      service: "folders",
      type: "getById",
      payload: { id: folderId, skipLockCheck: true },
    });
    if (!folder?.id) return;
    const spaceName = await fetchSpaceName(folder.spaceId);
    await recordLruFolder(
      buildLruEntryFromFolder(
        {
          id: folder.id,
          spaceId: folder.spaceId,
          name: folder.name || fallbackName || "Folder",
        },
        spaceName,
      ),
    );
  } catch (error) {
    void error;
  }
};

export const resolveQuickSaveTarget = async (
  target: ImportTarget,
  context: ImportClickContext,
  mode: ImportMode,
): Promise<{ folderId: string; spaceId: string }> => {
  const requestedFolder = target.folderId
    ? await resolveFreshLiveImportFolder(target.folderId)
    : null;
  const lru = requestedFolder ? [] : await pruneLruFolders();
  const selectedFolder = selectQuickSaveFolderTarget(requestedFolder, lru);
  if (selectedFolder) {
    return {
      folderId: selectedFolder.folderId,
      spaceId: selectedFolder.spaceId,
    };
  }

  const requestedSpaceId = target.spaceId || PUBLIC_SPACE_ID;
  let fallbackSpaceId = PUBLIC_SPACE_ID;
  try {
    const liveSpaces = await loadLiveImportSpaces();
    if (liveSpaces.some((space) => space.id === requestedSpaceId)) {
      fallbackSpaceId = requestedSpaceId;
    }
  } catch {
    // Public is created during database initialization and is the safest retry.
  }
  const folderId = await resolveTargetFolder(
    {
      spaceId: fallbackSpaceId,
      folderId: undefined,
      newFolderName: autoFolderName(context, mode),
    },
    context,
    mode,
  );
  return { folderId, spaceId: fallbackSpaceId };
};

let menuRefreshTimer: ReturnType<typeof setTimeout> | null = null;
let menuRefreshRunning = false;
let menuRefreshQueued = false;
let lastMenuRefreshAt = 0;

export const loadImportTargets = async (): Promise<ImportTargetSpace[]> => {
  try {
    const payload = await sendForwardedToOffscreen<ImportTargetSpace[]>({
      service: "dbManager",
      type: "getImportTargets",
      payload: { maxSpaces: 0, maxFoldersPerSpace: 0, maxItemsPerFolder: 0 },
    });
    return Array.isArray(payload) ? payload : [];
  } catch {
    return [];
  }
};
export const refreshContextMenus = async () => {
  if (menuRefreshRunning) {
    menuRefreshQueued = true;
    return;
  }
  menuRefreshRunning = true;
  menuRefreshQueued = false;
  try {
    await new Promise<void>((resolve) =>
      chrome.contextMenus.removeAll(() => resolve()),
    );
    const add = (options: chrome.contextMenus.CreateProperties) =>
      new Promise<void>((resolve) => {
        chrome.contextMenus.create(options, () => {
          if (chrome.runtime.lastError) {
            console.warn(
              "[ContextMenu] create failed:",
              chrome.runtime.lastError.message,
              options.id,
            );
          }
          resolve();
        });
      });

    await add({
      id: MENU_ROOT_ID,
      title: "VibeSearch",
      contexts: IMPORT_CONTEXTS,
    });

    // Content-aware primary actions
    await add({
      id: MENU_SAVE_IMAGE_ID,
      parentId: MENU_ROOT_ID,
      title: "Save image",
      contexts: [chrome.contextMenus.ContextType.IMAGE],
    });
    await add({
      id: MENU_EXTRACT_TEXT_ID,
      parentId: MENU_ROOT_ID,
      title: "Extract text from image",
      contexts: [chrome.contextMenus.ContextType.IMAGE],
    });
    await add({
      id: MENU_SAVE_VIDEO_ID,
      parentId: MENU_ROOT_ID,
      title: "Save video",
      contexts: [chrome.contextMenus.ContextType.VIDEO],
    });
    await add({
      id: MENU_SAVE_LINK_ID,
      parentId: MENU_ROOT_ID,
      title: "Save link",
      contexts: [chrome.contextMenus.ContextType.LINK],
    });
    await add({
      id: MENU_SAVE_SELECTION_ID,
      parentId: MENU_ROOT_ID,
      title: "Save quote",
      contexts: [chrome.contextMenus.ContextType.SELECTION],
    });
    await add({
      id: MENU_SAVE_PAGE_ID,
      parentId: MENU_ROOT_ID,
      title: "Save this page",
      contexts: [
        chrome.contextMenus.ContextType.PAGE,
        chrome.contextMenus.ContextType.FRAME,
      ],
    });
    await add({
      id: MENU_SAVE_SNAPSHOT_ID,
      parentId: MENU_ROOT_ID,
      title: "Archive full-page snapshot",
      contexts: [
        chrome.contextMenus.ContextType.PAGE,
        chrome.contextMenus.ContextType.FRAME,
      ],
    });
    await add({
      id: MENU_IMPORT_SHARED_ID,
      parentId: MENU_ROOT_ID,
      title: "Import shared VibeSearch link",
      contexts: IMPORT_CONTEXTS,
    });

    // Screenshot submenu
    await add({
      id: `${MENU_ROOT_ID}:sep:shot`,
      parentId: MENU_ROOT_ID,
      type: "separator",
      contexts: IMPORT_CONTEXTS,
    });
    await add({
      id: MENU_SHOT_VISIBLE_ID,
      parentId: MENU_ROOT_ID,
      title: "Screenshot visible area",
      contexts: IMPORT_CONTEXTS,
    });
    await add({
      id: MENU_SHOT_REGION_ID,
      parentId: MENU_ROOT_ID,
      title: "Screenshot a region",
      contexts: IMPORT_CONTEXTS,
    });

    // Save to… submenu (spaces/folders)
    await add({
      id: `${MENU_ROOT_ID}:sep:targets`,
      parentId: MENU_ROOT_ID,
      type: "separator",
      contexts: IMPORT_CONTEXTS,
    });
    await add({
      id: MENU_SAVE_TARGETS_ID,
      parentId: MENU_ROOT_ID,
      title: "Save this link to…",
      contexts: IMPORT_CONTEXTS,
    });

    const root = MENU_SAVE_TARGETS_ID;

    const lruFolders = await pruneLruFolders();
    if (lruFolders.length > 0) {
      for (const entry of lruFolders) {
        await add({
          id: `vs:save:lru:folder:${entry.folderId}`,
          parentId: root,
          title: trimText(`${entry.folderName} · ${entry.spaceName}`, 60),
          contexts: IMPORT_CONTEXTS,
        });
      }
      await add({
        id: `${MENU_ROOT_ID}:sep:lru`,
        parentId: root,
        type: "separator",
        contexts: IMPORT_CONTEXTS,
      });
    }

    const spaces = await loadImportTargets();
    for (const space of spaces) {
      const spaceNodeId = `vs:node:save:space:${space.id}`;
      await add({
        id: spaceNodeId,
        parentId: root,
        title: trimText(
          space.isPrivate && !space.isUnlocked
            ? `${space.name} (locked)`
            : space.name,
          60,
        ),
        contexts: IMPORT_CONTEXTS,
        enabled: true,
      });
      if (!space.isUnlocked) {
        await add({
          id: `vs:save:space:${space.id}`,
          parentId: spaceNodeId,
          title: "Save in this locked space (new folder)",
          contexts: IMPORT_CONTEXTS,
        });
        continue;
      }
      await add({
        id: `vs:save:space:${space.id}`,
        parentId: spaceNodeId,
        title: "Save in this space (new folder)",
        contexts: IMPORT_CONTEXTS,
      });
      for (const folder of space.folders) {
        await add({
          id: `vs:save:folder:${folder.id}`,
          parentId: spaceNodeId,
          title: trimText(folder.name || "Untitled folder", 60),
          contexts: IMPORT_CONTEXTS,
        });
      }
    }

    await add({
      id: `${MENU_ROOT_ID}:sep:extract`,
      parentId: MENU_ROOT_ID,
      type: "separator",
      contexts: [chrome.contextMenus.ContextType.IMAGE],
    });
    await add({
      id: MENU_EXTRACT_TARGETS_ID,
      parentId: MENU_ROOT_ID,
      title: "Extract text to…",
      contexts: [chrome.contextMenus.ContextType.IMAGE],
    });
    for (const space of spaces) {
      const spaceNodeId = `vs:node:extract:space:${space.id}`;
      await add({
        id: spaceNodeId,
        parentId: MENU_EXTRACT_TARGETS_ID,
        title: trimText(
          space.isPrivate && !space.isUnlocked
            ? `${space.name} (locked)`
            : space.name,
          60,
        ),
        contexts: [chrome.contextMenus.ContextType.IMAGE],
        enabled: true,
      });
      if (!space.isUnlocked) {
        await add({
          id: `vs:extract:space:${space.id}`,
          parentId: spaceNodeId,
          title: "Extract into this locked space (new folder)",
          contexts: [chrome.contextMenus.ContextType.IMAGE],
        });
        continue;
      }
      await add({
        id: `vs:extract:space:${space.id}`,
        parentId: spaceNodeId,
        title: "Extract into this space (new folder)",
        contexts: [chrome.contextMenus.ContextType.IMAGE],
      });
      for (const folder of space.folders) {
        await add({
          id: `vs:extract:folder:${folder.id}`,
          parentId: spaceNodeId,
          title: trimText(folder.name || "Untitled folder", 60),
          contexts: [chrome.contextMenus.ContextType.IMAGE],
        });
      }
    }

    await add({
      id: `${MENU_ROOT_ID}:sep:2`,
      parentId: MENU_ROOT_ID,
      type: "separator",
      contexts: IMPORT_CONTEXTS,
    });
    await add({
      id: MENU_OPEN_SEARCH_ID,
      parentId: MENU_ROOT_ID,
      title: "Open VibeSearch",
      contexts: IMPORT_CONTEXTS,
    });
  } catch (error) {
    console.error("[Background] Failed to refresh context menus:", error);
  } finally {
    menuRefreshRunning = false;
    lastMenuRefreshAt = Date.now();
    if (menuRefreshQueued) void refreshContextMenus();
  }
};
export const scheduleContextMenuRefresh = (
  priority: "high" | "low" = "low",
) => {
  if (menuRefreshTimer) clearTimeout(menuRefreshTimer);
  const now = Date.now();
  const elapsed = now - lastMenuRefreshAt;
  const minGapDelay = Math.max(0, MENU_REFRESH_MIN_INTERVAL_MS - elapsed);
  const baseDelay =
    priority === "high"
      ? MENU_REFRESH_DEBOUNCE_MS
      : MENU_REFRESH_LOW_PRIORITY_DEBOUNCE_MS;
  const delay =
    priority === "high" ? baseDelay : Math.max(baseDelay, minGapDelay);
  menuRefreshTimer = setTimeout(() => {
    menuRefreshTimer = null;
    void refreshContextMenus();
  }, delay);
};
