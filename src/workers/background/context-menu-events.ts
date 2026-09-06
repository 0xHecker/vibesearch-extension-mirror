import { PUBLIC_SPACE_ID } from "@src/common/spaces";
import {
  MENU_EXTRACT_TEXT_ID,
  MENU_IMPORT_SHARED_ID,
  MENU_OPEN_SEARCH_ID,
  MENU_SAVE_IMAGE_ID,
  MENU_SAVE_LINK_ID,
  MENU_SAVE_PAGE_ID,
  MENU_SAVE_SELECTION_ID,
  MENU_SAVE_SNAPSHOT_ID,
  MENU_SAVE_VIDEO_ID,
  MENU_SHOT_REGION_ID,
  MENU_SHOT_VISIBLE_ID,
} from "@src/workers/background/context-menus";
import {
  collectContext,
  parseTargetFromMenuId,
} from "@src/workers/background/import-context";
import {
  ImportCancelledError,
  type ImportClickContext,
  type ImportTarget,
} from "@src/workers/background/import-types";
import { pickSharedUrl } from "@src/workers/background/import-utils";
import {
  rememberFailedImportAttempt,
  toTabSnapshot,
} from "@src/workers/background/import-storage";
import {
  runArchiveSnapshotAction,
  runTargetAction,
} from "@src/workers/background/import-actions";
import { sendProcessStatus } from "@src/workers/background/process-status";
import { runBackgroundDataJob } from "@src/workers/background/runtime";
import { importSharedLink } from "@src/workers/background/share-import";

export const registerContextMenuEvents = (): void => {
  chrome.contextMenus.onClicked.addListener((info, tab) => {
    let attemptedTarget: ImportTarget | null = null;
    let attemptedContext: ImportClickContext | null = null;
    const attemptedTabSnapshot = toTabSnapshot(tab);
    void (async () => {
      const menuId = String(info.menuItemId);
      if (menuId === MENU_OPEN_SEARCH_ID) {
        await chrome.tabs.create({
          url: chrome.runtime.getURL("src/pages/search/index.html"),
        });
        return;
      }
      const context = collectContext(info, tab);
      attemptedContext = context;

      if (menuId === MENU_IMPORT_SHARED_ID) {
        const sharedUrl = pickSharedUrl(context);
        if (!sharedUrl) throw new Error("No VibeSearch shared link found.");
        await runBackgroundDataJob(() =>
          importSharedLink(sharedUrl, PUBLIC_SPACE_ID),
        );
        return;
      }

      // Full-page offline archive (self-contained, highest-fidelity snapshot).
      if (menuId === MENU_SAVE_SNAPSHOT_ID) {
        await runArchiveSnapshotAction(context, tab);
        return;
      }

      // Content-aware primary actions (instant save to Public/auto-folder)
      if (
        menuId === MENU_SAVE_IMAGE_ID ||
        menuId === MENU_SAVE_VIDEO_ID ||
        menuId === MENU_SAVE_LINK_ID ||
        menuId === MENU_SAVE_SELECTION_ID ||
        menuId === MENU_SAVE_PAGE_ID
      ) {
        attemptedTarget = { mode: "save", spaceId: PUBLIC_SPACE_ID };
        await runTargetAction(attemptedTarget, context, tab);
        return;
      }

      if (menuId === MENU_EXTRACT_TEXT_ID) {
        attemptedTarget = { mode: "extract", spaceId: PUBLIC_SPACE_ID };
        await runTargetAction(attemptedTarget, context, tab);
        return;
      }

      // Screenshot actions
      if (menuId === MENU_SHOT_VISIBLE_ID) {
        attemptedTarget = { mode: "shot", spaceId: PUBLIC_SPACE_ID };
        await runTargetAction(attemptedTarget, context, tab);
        return;
      }
      if (menuId === MENU_SHOT_REGION_ID) {
        attemptedTarget = {
          mode: "shot",
          spaceId: PUBLIC_SPACE_ID,
          screenshotMode: "region",
        };
        await runTargetAction(attemptedTarget, context, tab);
        return;
      }

      // Targeting submenu (Save to…)
      const target = parseTargetFromMenuId(menuId);
      if (target) {
        attemptedTarget = target;
        await runTargetAction(target, context, tab);
      }
    })().catch((error) => {
      const detail = error instanceof Error ? error.message : "Import failed.";
      const statusId = `import-error-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      if (error instanceof ImportCancelledError) {
        sendProcessStatus(statusId, "Import", "success", detail);
        return;
      }
      if (attemptedTarget && attemptedContext) {
        rememberFailedImportAttempt(statusId, {
          target: attemptedTarget,
          context: attemptedContext,
          tab: attemptedTabSnapshot,
          createdAt: Date.now(),
        });
        sendProcessStatus(statusId, "Import", "error", detail, "RETRY_IMPORT");
        return;
      }
      sendProcessStatus(statusId, "Import", "error", detail);
    });
  });
};
