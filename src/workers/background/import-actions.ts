import { PUBLIC_SPACE_ID } from "@src/common/spaces";
import { legacyBrowserEnabled } from "@src/services/extension-policy";
import { saveLocalContext, saveLocalScreenshot } from "./local-companion";
import type { FolderDocType } from "@src/schemas/folder_schema";
import type { ItemDocType } from "@src/schemas/item_schema";
import { scheduleForProcessing } from "@src/services/metadata-pipeline";
import { inferSource } from "@src/utils/infer-source";
import { capturePageArchiveForItem } from "@src/workers/background/archive-orchestrator";
import {
  loadImportTargets,
  recordFolderToLru,
  resolveQuickSaveTarget,
  scheduleContextMenuRefresh,
} from "@src/workers/background/context-menus";
import {
  buildExtractedImageTextContent,
  captureScreenshotMedia,
  isMetadataFetchablePageUrl,
  prepareImportContent,
  resolveLiveArchiveUrl,
  resolveSavePrimaryUrlOrFallback,
  toItemPayload,
} from "@src/workers/background/import-content";
import {
  createTitle,
  screenshotText,
} from "@src/workers/background/import-context";
import {
  ImportCancelledError,
  type ImportClickContext,
  type ImportDraft,
  type ImportTarget,
  type PreparedImportContent,
} from "@src/workers/background/import-types";
import {
  autoFolderName,
  normalizeHttpUrl,
  pickHostLabel,
  uniqueList,
} from "@src/workers/background/import-utils";
import {
  getImportSettings,
  loadDrafts,
  pruneLruFolders,
  resolveQuickSaveFolder,
  saveDrafts,
} from "@src/workers/background/import-storage";
import {
  type DestinationPickerSpace,
  showBrandedToast,
  showDestinationPickerToast,
} from "@src/workers/background/import-ui";
import {
  createImportJob,
  sendProcessStatus,
} from "@src/workers/background/process-status";
import { triggerOpfsPromotion } from "@src/workers/background/opfs-media-maintenance";
import { forwardProcessingTriggerToOffscreen } from "@src/workers/background/processing-triggers";
import {
  runBackgroundDataJob,
  sendForwardedToOffscreen,
} from "@src/workers/background/runtime";

const createDraftFromAction = async (
  target: ImportTarget,
  context: ImportClickContext,
  tab: chrome.tabs.Tab | undefined,
  job: { id: string; label: string },
) => {
  const prepared = await prepareImportContent(target, context, tab, job);
  const draft: ImportDraft = {
    id: crypto.randomUUID(),
    itemId: prepared.itemId,
    mode: target.mode,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    primaryUrl: prepared.primaryUrl,
    title: prepared.title,
    textContent: prepared.textContent,
    source: prepared.source,
    tags: prepared.tags,
    iconUrl: prepared.iconUrl,
    displayImageUrl: prepared.displayImageUrl,
    media: prepared.media,
    ocrText: prepared.ocrText,
    ocrStatus: prepared.ocrStatus,
    ocrConfidence: prepared.ocrConfidence,
    ocrLineCount: prepared.ocrLineCount,
    ocrModelVersion: prepared.ocrModelVersion,
    ocrSourceHash: prepared.ocrSourceHash,
    shouldFetchMetadata: prepared.shouldFetchMetadata,
    isMetaFetched: prepared.isMetaFetched,
    archiveUrl: prepared.archiveUrl,
    liveArchiveUrl: prepared.liveArchiveUrl,
    context,
    target: {
      spaceId: target.spaceId || PUBLIC_SPACE_ID,
      folderId: target.folderId,
      parentId: target.itemId || null,
      newFolderName: target.folderId
        ? undefined
        : autoFolderName(context, target.mode),
    },
  };
  const drafts = await loadDrafts();
  await saveDrafts([draft, ...drafts.filter((entry) => entry.id !== draft.id)]);
  if (draft.itemId && draft.archiveUrl) {
    void capturePageArchiveForItem({
      itemId: draft.itemId,
      archiveUrl: draft.archiveUrl,
      liveArchiveUrl: draft.liveArchiveUrl,
      tab,
    }).catch((error) => {
      console.warn("[archive] draft capture could not be queued", error);
      sendProcessStatus(
        `archive-${draft.itemId}`,
        "Offline preview",
        "error",
        "Could not queue this preview.",
      );
    });
  }
  return draft;
};

export const openDraftEditor = async (draftId: string) => {
  const url = new URL(chrome.runtime.getURL("src/pages/popup/index.html"));
  url.searchParams.set("mode", "import");
  url.searchParams.set("draftId", draftId);
  await chrome.windows.create({
    url: url.toString(),
    type: "popup",
    width: 500,
    height: 760,
    focused: true,
  });
};

const runImportActionImpl = async (
  target: ImportTarget,
  context: ImportClickContext,
  tab?: chrome.tabs.Tab,
) => {
  const job = createImportJob(target.mode, context);
  sendProcessStatus(job.id, job.label, "processing", "Queued...");
  const settings = await getImportSettings();

  if (settings.reviewBeforeSave) {
    sendProcessStatus(job.id, job.label, "processing", "Preparing draft...");
    const draft = await createDraftFromAction(target, context, tab, job);
    await openDraftEditor(draft.id);
    sendProcessStatus(
      job.id,
      job.label,
      "success",
      "Draft ready. Review and save.",
    );
    return;
  }

  sendProcessStatus(job.id, job.label, "processing", "Preparing import...");

  const prepared = await prepareImportContent(target, context, tab, job);

  // Save immediately to the resolved destination so the quick-save stays one
  // click — no action required. When the user didn't pick an explicit folder we
  // additionally surface a destination picker that *re-files* the saved item if
  // they choose to; taking no action just leaves it where it landed.
  sendProcessStatus(
    job.id,
    job.label,
    "processing",
    "Resolving destination...",
  );
  const { folderId, spaceId } = await resolveQuickSaveTarget(
    target,
    context,
    target.mode,
  );

  sendProcessStatus(job.id, job.label, "processing", "Saving...");
  const inserted = await sendForwardedToOffscreen<ItemDocType>({
    service: "items",
    type: "addToFolder",
    payload: toItemPayload({
      id: prepared.itemId,
      context,
      mode: target.mode,
      primaryUrl: prepared.primaryUrl,
      folderId,
      parentId: target.itemId || null,
      title: prepared.title,
      textContent: prepared.textContent,
      source: prepared.source,
      iconUrl: prepared.iconUrl,
      media: prepared.media,
      displayImageUrl: prepared.displayImageUrl,
      ocrText: prepared.ocrText,
      ocrStatus: prepared.ocrStatus,
      ocrConfidence: prepared.ocrConfidence,
      ocrLineCount: prepared.ocrLineCount,
      ocrModelVersion: prepared.ocrModelVersion,
      ocrSourceHash: prepared.ocrSourceHash,
      shouldFetchMetadata: prepared.shouldFetchMetadata,
      isMetaFetched: prepared.isMetaFetched,
      deferBackgroundProcessing: false,
    }),
  });

  if (prepared.archiveUrl) {
    void capturePageArchiveForItem({
      itemId: inserted.id,
      archiveUrl: prepared.archiveUrl,
      liveArchiveUrl: prepared.liveArchiveUrl,
      tab,
    }).catch((error) => {
      console.warn("[archive] page capture could not be queued", error);
      sendProcessStatus(
        `archive-${inserted.id}`,
        "Offline preview",
        "error",
        "Could not queue this preview.",
      );
    });
  }

  // Saved images (right-click → save image, image links, etc.) are OCR'd like
  // screenshots so their text becomes searchable; OCR then re-embeds them. The
  // explicit per-item trigger is reliable even in a large library.
  if (
    prepared.ocrStatus !== "done" &&
    (prepared.media || []).some((entry) => entry?.type === "image")
  ) {
    void forwardProcessingTriggerToOffscreen("TRIGGER_OCR", {
      itemId: inserted.id,
    }).catch((error) =>
      console.warn("[Import] Failed to start OCR for saved image.", error),
    );
  }

  await recordFolderToLru(
    folderId,
    spaceId,
    autoFolderName(context, target.mode),
  );
  sendProcessStatus(job.id, job.label, "success", "Imported.");
  scheduleContextMenuRefresh("low");

  const savedActions = [
    {
      label: "Undo",
      action: "UNDO_SAVE",
      payload: { primaryUrl: prepared.primaryUrl, itemId: inserted.id },
    },
    { label: "Open", action: "OPEN_SEARCH" },
  ];

  // The "Save … to…" submenu already chose the destination — just confirm.
  if (target.folderId) {
    await showBrandedToast(tab, "Saved", savedActions, 4000);
    return;
  }

  // Quick-save: offer to re-file into any space/folder. Doing nothing keeps the
  // item in its auto-picked destination; picking one moves the already-saved item.
  const spaces = await buildDestinationPickerSpaces();
  if (spaces.length === 0) {
    await showBrandedToast(tab, "Saved", savedActions, 4000);
    return;
  }
  await showDestinationPickerToast(
    tab,
    "Saved — move to…?",
    spaces,
    "MOVE_SAVED_ITEM",
    {
      itemId: inserted.id,
      primaryUrl: prepared.primaryUrl,
    },
  );
};

export const runImportAction = async (
  target: ImportTarget,
  context: ImportClickContext,
  tab?: chrome.tabs.Tab,
) => {
  if (!await legacyBrowserEnabled()) {
    const saved = await saveLocalContext(context, tab);
    await showBrandedToast(tab, saved.state === "saved" ? "Saved to your local library." : "Capture preserved in your local queue.");
    return;
  }
  return runBackgroundDataJob(() => runImportActionImpl(target, context, tab));
};

// Re-file an already-saved item into a folder chosen from the post-save picker.
// The item was saved immediately, so this is an optional correction — it never
// blocks the original one-click save.
export const moveSavedItemToFolder = async (
  itemId: string,
  folderId: string,
  tab?: chrome.tabs.Tab,
): Promise<void> => {
  if (!itemId || !folderId) return;
  try {
    const moved = await sendForwardedToOffscreen<{ updated: number }>({
      service: "items",
      type: "moveToFolder",
      payload: { itemIds: [itemId], targetFolderId: folderId },
    });
    scheduleContextMenuRefresh("low");
    await showBrandedToast(
      tab,
      moved?.updated ? "Moved" : "Already there",
      [{ label: "Open", action: "OPEN_SEARCH" }],
      3000,
    );
  } catch (error) {
    const detail =
      error instanceof Error ? error.message : "Could not move the saved item.";
    await showBrandedToast(tab, detail);
  }
};

export const scheduleScreenshotPostImportWork = (
  itemId: string,
  pageUrl: string,
): void => {
  void (async () => {
    // OCR starts before network work so a screenshot remains useful offline.
    try {
      await forwardProcessingTriggerToOffscreen("TRIGGER_OCR", { itemId });
    } catch (error) {
      console.warn("[Screenshot] Failed to start OCR.", error);
    }

    await triggerOpfsPromotion();
    if (isMetadataFetchablePageUrl(pageUrl)) {
      scheduleForProcessing([pageUrl]);
    }
  })();
};

const runExtractTextActionImpl = async (
  target: ImportTarget,
  context: ImportClickContext,
  tab?: chrome.tabs.Tab,
) => {
  const job = createImportJob("extract", context);
  sendProcessStatus(
    job.id,
    job.label,
    "processing",
    "Resolving destination...",
  );

  const { folderId, spaceId } = await resolveQuickSaveTarget(
    target,
    context,
    "extract",
  );

  const prepared = await buildExtractedImageTextContent(context, tab, job);
  sendProcessStatus(
    job.id,
    job.label,
    "processing",
    "Saving extracted text...",
  );
  const inserted = await sendForwardedToOffscreen<ItemDocType>({
    service: "items",
    type: "addToFolder",
    payload: toItemPayload({
      context,
      mode: "extract",
      primaryUrl: prepared.primaryUrl,
      folderId,
      parentId: null,
      title: prepared.title,
      textContent: prepared.textContent,
      source: prepared.source,
      iconUrl: prepared.iconUrl,
      displayImageUrl: prepared.displayImageUrl,
      media: prepared.media,
      ocrText: prepared.ocrText,
      ocrStatus: prepared.ocrStatus,
      ocrConfidence: prepared.ocrConfidence,
      ocrLineCount: prepared.ocrLineCount,
      ocrModelVersion: prepared.ocrModelVersion,
      ocrSourceHash: prepared.ocrSourceHash,
      shouldFetchMetadata: false,
      isMetaFetched: true,
    }),
  });

  void recordFolderToLru(folderId, spaceId, autoFolderName(context, "extract"));

  sendProcessStatus(job.id, job.label, "success", "Extracted text saved.");
  scheduleContextMenuRefresh("low");
  await showBrandedToast(
    tab,
    "Extracted text saved",
    [
      {
        label: "Undo",
        action: "UNDO_SAVE",
        payload: { primaryUrl: inserted.url },
      },
      { label: "Open", action: "OPEN_SEARCH" },
    ],
    5000,
  );
};

const runExtractTextAction = (
  target: ImportTarget,
  context: ImportClickContext,
  tab?: chrome.tabs.Tab,
) => runBackgroundDataJob(() => runExtractTextActionImpl(target, context, tab));

type PendingScreenshot = {
  pendingId: string;
  context: ImportClickContext;
  tab: chrome.tabs.Tab | undefined;
  job: { id: string; label: string };
  itemId: string;
  primaryUrl: string;
  prepared: PreparedImportContent;
  createdAt: number;
};

const pendingScreenshots = new Map<string, PendingScreenshot>();

export const clearPendingScreenshots = (): void => {
  pendingScreenshots.clear();
};
const PENDING_SCREENSHOT_TTL_MS = 5 * 60 * 1000;

const buildDestinationPickerSpaces = async (): Promise<
  DestinationPickerSpace[]
> => {
  const [targets, lru] = await Promise.all([
    loadImportTargets().catch(() => []),
    pruneLruFolders(),
  ]);
  const lruByFolder = new Map(
    lru.map((entry) => [entry.folderId, entry.usedAt]),
  );
  const lruSpaceRank = new Map<string, number>();
  for (const entry of lru) {
    if (!lruSpaceRank.has(entry.spaceId)) {
      lruSpaceRank.set(entry.spaceId, entry.usedAt);
    }
  }
  return targets
    .filter((space) => space.isUnlocked)
    .map((space) => ({
      spaceId: space.id,
      spaceName: space.name,
      folders: space.folders.map((folder) => ({
        folderId: folder.id,
        folderName: folder.name || "Untitled",
        usedAt: lruByFolder.get(folder.id) ?? 0,
      })),
    }))
    .sort(
      (a, b) =>
        (lruSpaceRank.get(b.spaceId) ?? 0) - (lruSpaceRank.get(a.spaceId) ?? 0),
    );
};

const runScreenshotActionImpl = async (
  target: ImportTarget,
  context: ImportClickContext,
  tab?: chrome.tabs.Tab,
) => {
  const job = createImportJob("shot", context);
  sendProcessStatus(job.id, job.label, "processing", "Queued...");
  const settings = await getImportSettings();

  if (settings.reviewBeforeSave) {
    sendProcessStatus(job.id, job.label, "processing", "Preparing draft...");
    const draft = await createDraftFromAction(target, context, tab, job);
    await openDraftEditor(draft.id);
    sendProcessStatus(
      job.id,
      job.label,
      "success",
      "Draft ready. Review and save.",
    );
    return;
  }

  const itemId = crypto.randomUUID();
  const resolved = resolveSavePrimaryUrlOrFallback(context, "shot");
  const primaryUrl = resolved.url;
  const source = inferSource(primaryUrl);

  sendProcessStatus(job.id, job.label, "processing", "Capturing screenshot...");
  let screenshotMedia: { media?: ItemDocType["media"] };
  try {
    screenshotMedia = await captureScreenshotMedia(
      context,
      tab,
      job,
      itemId,
      target.screenshotMode || "visible",
    );
  } catch (error) {
    const detail =
      error instanceof Error ? error.message : "Screenshot capture failed.";
    if (error instanceof ImportCancelledError) {
      sendProcessStatus(job.id, job.label, "success", detail);
      return;
    }
    await showBrandedToast(tab, detail);
    throw error;
  }

  const prepared: PreparedImportContent = {
    itemId,
    primaryUrl,
    title: createTitle(
      context,
      target.extractIntent ? "extract" : "shot",
      primaryUrl,
    ),
    textContent: screenshotText(context),
    source,
    iconUrl: context.tabFavIconUrl || undefined,
    media: screenshotMedia.media,
    ocrStatus: "pending",
    ocrModelVersion: "",
    tags: uniqueList([
      source !== "web" ? source : "",
      "screenshot",
      pickHostLabel(context),
    ]),
    shouldFetchMetadata: false,
    isMetaFetched: true,
  };

  const pendingId = `shot-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  pendingScreenshots.set(pendingId, {
    pendingId,
    context,
    tab,
    job,
    itemId,
    primaryUrl,
    prepared,
    createdAt: Date.now(),
  });

  sendProcessStatus(job.id, job.label, "processing", "Choose where to save...");

  const spaces = await buildDestinationPickerSpaces();
  if (spaces.length === 0) {
    await finalizeScreenshotSave(
      pendingId,
      "",
      target.spaceId || PUBLIC_SPACE_ID,
      {
        preferLru: true,
      },
    );
    return;
  }
  const quickSaveTarget = await resolveQuickSaveFolder();
  const autoSaveTargetLabel =
    quickSaveTarget?.folderName?.trim() || "a new folder";
  await showDestinationPickerToast(
    tab,
    "Save screenshot to…",
    spaces,
    "SAVE_SCREENSHOT_TO",
    { pendingId },
    {
      allowSpaceDirectSave: true,
      autoSave: { timeoutMs: 5000, targetLabel: autoSaveTargetLabel },
    },
  );
};

export const runScreenshotAction = async (
  target: ImportTarget,
  context: ImportClickContext,
  tab?: chrome.tabs.Tab,
) => {
  if (!await legacyBrowserEnabled()) {
    if (tab?.id === undefined) throw new Error("LOCAL_PAGE_UNAVAILABLE");
    const saved = await saveLocalScreenshot(tab.id, target.screenshotMode ?? "visible");
    await showBrandedToast(tab, saved.state === "saved" ? "Screenshot saved to your local library." : "Screenshot preserved in your local queue.");
    return;
  }
  return runBackgroundDataJob(() => runScreenshotActionImpl(target, context, tab));
};

export const finalizeScreenshotSave = async (
  pendingId: string,
  folderId: string,
  spaceId: string,
  options: { preferLru?: boolean } = {},
): Promise<void> => {
  const pending = pendingScreenshots.get(pendingId);
  if (!pending) return;
  pendingScreenshots.delete(pendingId);

  const { context, tab, job, prepared } = pending;

  let resolvedFolderId = folderId;
  let resolvedSpaceId = spaceId || PUBLIC_SPACE_ID;
  if (!resolvedFolderId) {
    // Only fall back to the most-recently-used folder when the caller has no
    // explicit destination (the 5s auto-save). When a user explicitly picks a
    // space with no groups, honor that space and create a folder inside it.
    const lru = options.preferLru ? await resolveQuickSaveFolder() : null;
    if (lru) {
      resolvedFolderId = lru.folderId;
      resolvedSpaceId = lru.spaceId;
    } else {
      const created = await sendForwardedToOffscreen<FolderDocType>({
        service: "folders",
        type: "create",
        payload: {
          name: autoFolderName(context, "shot"),
          userId: "",
          spaceId: resolvedSpaceId,
          allowLockedPrivateWrite: true,
        },
      });
      if (!created?.id) {
        sendProcessStatus(
          job.id,
          job.label,
          "error",
          "Could not create destination folder.",
        );
        return;
      }
      resolvedFolderId = created.id;
    }
  }

  sendProcessStatus(job.id, job.label, "processing", "Saving screenshot...");
  try {
    const inserted = await sendForwardedToOffscreen<ItemDocType>({
      service: "items",
      type: "addToFolder",
      payload: toItemPayload({
        id: prepared.itemId,
        context,
        mode: "shot",
        primaryUrl: prepared.primaryUrl,
        folderId: resolvedFolderId,
        parentId: null,
        title: prepared.title,
        textContent: prepared.textContent,
        source: prepared.source,
        iconUrl: prepared.iconUrl,
        media: prepared.media,
        displayImageUrl: prepared.displayImageUrl,
        ocrText: prepared.ocrText,
        ocrStatus: prepared.ocrStatus,
        ocrConfidence: prepared.ocrConfidence,
        ocrLineCount: prepared.ocrLineCount,
        ocrModelVersion: prepared.ocrModelVersion,
        ocrSourceHash: prepared.ocrSourceHash,
        shouldFetchMetadata: prepared.shouldFetchMetadata,
        isMetaFetched: prepared.isMetaFetched,
        deferBackgroundProcessing: true,
      }),
    });

    scheduleScreenshotPostImportWork(inserted.id, prepared.primaryUrl);
    void recordFolderToLru(
      resolvedFolderId,
      resolvedSpaceId,
      autoFolderName(context, "shot"),
    );

    sendProcessStatus(job.id, job.label, "success", "Screenshot saved.");
    scheduleContextMenuRefresh("low");
    await showBrandedToast(
      tab,
      "Screenshot saved",
      [
        {
          label: "Undo",
          action: "UNDO_SAVE",
          payload: { primaryUrl: prepared.primaryUrl },
        },
        { label: "Open", action: "OPEN_SEARCH" },
      ],
      4000,
    );
  } catch (error) {
    const detail =
      error instanceof Error ? error.message : "Failed to save screenshot.";
    sendProcessStatus(job.id, job.label, "error", detail);
    await showBrandedToast(tab, detail);
  }
};

setInterval(() => {
  const now = Date.now();
  for (const [id, pending] of pendingScreenshots) {
    if (now - pending.createdAt > PENDING_SCREENSHOT_TTL_MS) {
      pendingScreenshots.delete(id);
    }
  }
}, 60 * 1000).unref?.();

const isArchivableTab = (tab?: chrome.tabs.Tab): boolean =>
  tab?.id !== undefined && /^https?:\/\//i.test(tab?.url || "");

/**
 * Preserve the web-support branch's explicit Archive action while routing it
 * through the bounded page-capture session and durable archive outbox. The
 * former implementation returned a full HTML string through the service worker
 * and duplicated the archive already queued by runImportAction.
 */
export const runArchiveSnapshotAction = async (
  context: ImportClickContext,
  tab?: chrome.tabs.Tab,
): Promise<void> => {
  if (!await legacyBrowserEnabled()) {
    const saved = await saveLocalContext(context, tab);
    await showBrandedToast(tab, saved.state === "saved" ? "Page text saved to your local library." : "Page text preserved in your local queue.");
    return;
  }
  const job = {
    id: `archive-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    label: `Archive • ${pickHostLabel(context)}`,
  };

  if (!isArchivableTab(tab)) {
    sendProcessStatus(
      job.id,
      job.label,
      "error",
      "This page can't be archived. Open a normal web page (http/https) and try again.",
    );
    await showBrandedToast(tab, "This page can't be archived");
    return;
  }

  sendProcessStatus(
    job.id,
    job.label,
    "processing",
    "Saving and queuing an offline preview…",
  );
  try {
    const archiveUrl = normalizeHttpUrl(
      context.frameUrl || context.pageUrl || context.tabUrl || tab?.url || null,
    );
    const candidateUrls = uniqueList([
      archiveUrl || "",
      normalizeHttpUrl(context.pageUrl) || "",
      normalizeHttpUrl(context.tabUrl) || "",
      normalizeHttpUrl(tab?.url) || "",
    ]);
    const existing =
      candidateUrls.length > 0
        ? await sendForwardedToOffscreen<{ id: string; url: string } | null>({
            service: "items",
            type: "findLiveByUrls",
            payload: { urls: candidateUrls },
          })
        : null;
    if (existing && archiveUrl) {
      await capturePageArchiveForItem({
        itemId: existing.id,
        archiveUrl,
        liveArchiveUrl: resolveLiveArchiveUrl(context, tab),
        tab,
      });
      sendProcessStatus(
        job.id,
        job.label,
        "success",
        "Saved; the existing archive was updated.",
      );
      await showBrandedToast(
        tab,
        "Archive updated",
        [{ label: "Open", action: "OPEN_SEARCH" }],
        4000,
      );
      return;
    }
    await runImportAction(
      { mode: "save", spaceId: PUBLIC_SPACE_ID },
      context,
      tab,
    );
    sendProcessStatus(
      job.id,
      job.label,
      "success",
      "Saved; the offline preview is queued.",
    );
  } catch (error) {
    const detail = error instanceof Error ? error.message : "Archiving failed.";
    sendProcessStatus(job.id, job.label, "error", detail);
    await showBrandedToast(tab, `Couldn't archive this page: ${detail}`);
  }
};

export const runTargetAction = async (
  target: ImportTarget,
  context: ImportClickContext,
  tab?: chrome.tabs.Tab,
) => {
  if (!await legacyBrowserEnabled()) {
    if (target.mode === "shot") return runScreenshotAction(target, context, tab);
    const saved = await saveLocalContext(context, tab);
    await showBrandedToast(tab, saved.state === "saved" ? "Saved to your local library." : "Capture preserved in your local queue.");
    return;
  }
  if (target.mode === "shot") {
    await runScreenshotAction(target, context, tab);
    return;
  }
  if (target.mode === "extract") {
    await runExtractTextAction(target, context, tab);
    return;
  }
  await runImportAction(target, context, tab);
};
