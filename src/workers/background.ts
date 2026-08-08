import {
  clearMetadataPipelineData,
  retryStoredFailedMetadataUrls,
  scheduleForProcessing,
  setMetadataProgressListener,
  type MetadataProgressSnapshot,
} from "@src/services/metadata-pipeline";
import { setupOffscreenDocument } from "@src/services/offscreen-helper";
import { PRIVATE_SPACE_ID, PUBLIC_SPACE_ID } from "@src/common/spaces";
import { OPEN_ON_NEW_TAB_STORAGE_KEY } from "@src/common/new-tab-pref";
import {
  importSettingsPatchFromPayload,
  normalizeImportSettings,
  type ImportSettings,
} from "@src/common/import-settings";
import {
  reconcileLiveImportLruFolders,
  resolveLiveImportFolderTarget,
  selectQuickSaveFolderTarget,
  type ImportLruFolderEntry,
  type LiveImportFolderTarget,
  type LiveImportSpaceSnapshot,
} from "@src/common/import-lru";
import type { ImportTargetSpace } from "@src/services/db-manager";
import type { FolderDocType } from "@src/schemas/folder_schema";
import type { ItemDocType } from "@src/schemas/item_schema";
import { inferSource } from "@src/utils/infer-source";
import {
  isLikelyDirectResourceUrl,
  isMetadataFetchableUrl,
} from "@src/utils/metadata-url";
import {
  saveMediaToOpfs,
  uploadOpfsFileToR2,
  uploadRemoteMediaToR2,
  mapWithConcurrencyStable,
  BoundedOpfsCleanupBatch,
  type OpfsFileIdentity,
} from "@src/services/media-storage";
import { OCR_MODEL_VERSION } from "@src/services/ocr-model-config";
import {
  syncSnapshotToGoogleWorkspace,
  syncSnapshotFileToGoogleWorkspace,
  getGoogleWorkspaceSyncState,
  connectGoogleWorkspace,
  clearGoogleWorkspaceAuth,
  downloadGoogleWorkspaceBackupBlob,
  fetchWithTimeout,
  listGoogleWorkspaceBackups,
  readBoundedResponseText,
} from "@src/services/google-workspace-sync";
import type { ShareSnapshotV1 } from "@src/services/share-snapshot";
import type {
  BrowserBookmarkImportResult,
  BrowserBookmarkNode,
} from "@src/services/browser-bookmark-import";
import {
  BROWSER_BOOKMARK_RESYNC_ALARM_NAME,
  BrowserBookmarkResyncScheduler,
} from "@src/services/browser-bookmark-resync";
import { registerBrowserBookmarkEvents } from "@src/services/browser-bookmark-events";
import {
  CLOUD_SYNC_CONTINUATION_DELAY_MS,
  shouldScheduleCloudSyncContinuation,
} from "@src/services/cloud-sync-continuation";
import {
  ARCHIVE_OUTBOX_ALARM_NAME,
  ARCHIVE_OUTBOX_DRAIN_LIMIT,
  ArchiveOutbox,
  createChromeArchiveOutboxStorage,
  createOpfsArchiveOutboxFiles,
} from "@src/services/archive-outbox";
import { ArchiveCaptureSessionManager } from "@src/services/archive-capture-session";
import { getArchiveCache } from "@src/services/archive-cache";
import {
  PAGE_ARCHIVE_ABORT_MESSAGE,
  PAGE_ARCHIVE_CAPTURE_MESSAGE,
  PAGE_ARCHIVE_CAPTURE_TIMEOUT_MS,
  PAGE_ARCHIVE_CHUNK_CODE_UNITS,
  PAGE_ARCHIVE_CHUNK_MESSAGE,
  PAGE_ARCHIVE_FINISH_MESSAGE,
  type ArchiveProtocolResponse,
} from "@src/services/archive-capture-protocol";
import { CLOUD_SYNC_TOKEN_KEY } from "@src/services/cloud-sync";
import type { CloudAuthStatus } from "@src/services/cloud-auth";
import type { GitHubStar, GitHubStarsImportResult } from "@src/services/github-stars-import";
import { collectGitHubStarsPages } from "@src/services/github-stars-api";
import {
  connect as connectConnector,
  disconnect as disconnectConnector,
  syncConnector,
  syncAllConnected,
  cancelConnectorSync,
  listConnectors,
  setAutoSync as setConnectorAutoSync,
  setupConnectorScheduler,
  onConnectorAlarm,
  CONNECTOR_SYNC_ALARM,
  CONNECTOR_CONTINUATION_ALARM,
  type ConnectorSyncOutcome,
} from "@src/services/connectors/registry";
import type { ConnectorPlatform } from "@src/services/connectors/types";
import {
  cleanupStagedPayloads,
  deleteStagedPayloadFile,
  LOCAL_DATA_RESET_EPOCH_STORAGE_KEY,
  LOCAL_DATA_RESET_STORAGE_KEY,
  stagePayloadFile,
  takeStagedPayloadFile,
} from "@src/services/large-payload-staging";
import {
  isInternalOnlyOffscreenCall,
  isSearchOnlyOffscreenCall,
} from "@src/services/offscreen-routing-policy";
import {
  connectNotion,
  disconnectNotion,
  getNotionAccessToken,
  getNotionConnectionStatus,
} from "@src/services/notion-auth";
import {
  appendNotionExportItems,
  createNotionExportPage,
} from "@src/services/notion-export";
import {
  NOTION_EXPORT_BATCH_SIZE,
  NOTION_EXPORT_MAX_ITEMS,
  type NotionExportBatch,
} from "@src/services/notion-export-source";

const SYNC_ALARM_NAME = "vector-sync-alarm";
const CLOUD_SYNC_ALARM_NAME = "cloud-sync-alarm";
const CLOUD_SYNC_CONTINUATION_ALARM_NAME = "cloud-sync-continuation";
const ARCHIVE_OUTBOX_RETRY_ALARM_NAME = "archive-outbox-retry";
const EMBEDDING_ALARM_NAME = "embedding-alarm";
const METADATA_RETRY_ALARM_NAME = "metadata-retry-alarm";
const OPFS_MEDIA_RECONCILE_CONTINUATION_ALARM_NAME = "opfs-media-reconcile-continuation";
const OPFS_MEDIA_RECONCILE_CURSOR_KEY = "vibesearch:opfsMediaReconcileCursor:v1";
const SHARE_SNAPSHOT_MAX_BYTES = 16 * 1024 * 1024;
const SHARE_SNAPSHOT_FETCH_TIMEOUT_MS = 60_000;
const CONNECTOR_MESSAGE_TYPES = new Set([
  "RUN_CONNECTOR_SYNC",
  "CANCEL_CONNECTOR_SYNC",
  "CONNECTOR_LIST",
  "CONNECTOR_CONNECT",
  "CONNECTOR_DISCONNECT",
  "CONNECTOR_SET_AUTOSYNC",
]);
const GOOGLE_WORKSPACE_MESSAGE_TYPES = new Set([
  "GOOGLE_AUTH_STATUS",
  "GOOGLE_AUTH_CONNECT",
  "GOOGLE_SYNC_STATUS",
  "GOOGLE_SYNC_CLEAR_AUTH",
  "GOOGLE_BACKUP_LIST",
  "GOOGLE_BACKUP_RESTORE",
  "GOOGLE_SYNC_EXPORT_ALL",
]);
const LOCAL_BACKUP_MESSAGE_TYPES = new Set([
  "LOCAL_BACKUP_BUILD_DOWNLOAD",
  "LOCAL_BACKUP_STAGE_FILE",
  "LOCAL_BACKUP_RESTORE_STAGED",
]);
const NOTION_MESSAGE_TYPES = new Set([
  "NOTION_AUTH_STATUS",
  "NOTION_AUTH_CONNECT",
  "NOTION_AUTH_DISCONNECT",
  "NOTION_EXPORT_ALL",
]);
const CONNECTOR_LABELS: Record<ConnectorPlatform, string> = {
  x: "X (Twitter)",
  reddit: "Reddit",
  instagram: "Instagram",
};
const isConnectorPlatform = (value: string): value is ConnectorPlatform =>
  value === "x" || value === "reddit" || value === "instagram";
const describeConnectorOutcome = (
  who: string,
  outcome: ConnectorSyncOutcome,
): string => {
  if (outcome.error) return outcome.error;
  if (outcome.cancelled) {
    return `${who}: cancelled — ${outcome.pushed} synced before stopping.`;
  }
  if (outcome.fetched === 0) {
    return outcome.hasMore
      ? `${who}: backlog checkpoint saved; continuing shortly.`
      : `${who}: already up to date — nothing new to sync.`;
  }
  const parts = [`${outcome.pushed} new item${outcome.pushed === 1 ? "" : "s"} synced`];
  if (outcome.skipped) parts.push(`${outcome.skipped} already saved`);
  if (outcome.failed) parts.push(`${outcome.failed} failed`);
  if (outcome.hasMore) parts.push("more queued for the next bounded run");
  return `${who}: ${parts.join(", ")}.`;
};
const FORCE_DEV_OFFSCREEN_RESET =
  import.meta.env.VITE_FORCE_DEV_OFFSCREEN_RESET === "1";
const SEARCH_PAGE_PATH = "/src/pages/search/index.html";
const IMPORT_SETTINGS_KEY = "vs_import_settings_v1";
const IMPORT_DRAFTS_KEY = "vs_import_drafts_v1";
const IMPORT_LRU_FOLDERS_KEY = "vs_import_lru_folders_v1";
const BROWSER_BOOKMARK_AUTO_SYNC_ENABLED_KEY = "vibesearch:browserBookmarkAutoSyncEnabled:v1";
const IMPORT_LRU_MAX = 5;
const IMPORT_MAX_DRAFTS = 24;
const IMPORT_FAILED_ATTEMPTS_MAX = 20;
const IMPORT_CONTEXTS: [`${chrome.contextMenus.ContextType}`, ...`${chrome.contextMenus.ContextType}`[]] = [
  chrome.contextMenus.ContextType.PAGE,
  chrome.contextMenus.ContextType.FRAME,
  chrome.contextMenus.ContextType.SELECTION,
  chrome.contextMenus.ContextType.LINK,
  chrome.contextMenus.ContextType.IMAGE,
  chrome.contextMenus.ContextType.VIDEO,
  chrome.contextMenus.ContextType.AUDIO,
];
const MENU_ROOT_ID = "vs:root";
const MENU_OPEN_SEARCH_ID = "vs:open:search";
const MENU_IMPORT_SHARED_ID = "vs:import:shared";
// Content-aware primary actions
const MENU_SAVE_IMAGE_ID = "vs:save:image";
const MENU_SAVE_VIDEO_ID = "vs:save:video";
const MENU_SAVE_LINK_ID = "vs:save:link";
const MENU_SAVE_SELECTION_ID = "vs:save:selection";
const MENU_SAVE_PAGE_ID = "vs:save:page";
const MENU_SAVE_SNAPSHOT_ID = "vs:save:snapshot";
const MENU_EXTRACT_TEXT_ID = "vs:extract:text";
// Screenshot actions
const MENU_SHOT_VISIBLE_ID = "vs:shot:visible";
const MENU_SHOT_REGION_ID = "vs:shot:region";
// Targeting submenus
const MENU_SAVE_TARGETS_ID = "vs:targets:save";
const MENU_EXTRACT_TARGETS_ID = "vs:targets:extract";
const MENU_SHOT_TARGETS_ID = "vs:targets:shot";
const MENU_REFRESH_DEBOUNCE_MS = 180;
const MENU_REFRESH_LOW_PRIORITY_DEBOUNCE_MS = 900;
const MENU_REFRESH_MIN_INTERVAL_MS = 2500;
const HOVER_SAVE_TARGET_TTL_MS = 30_000;
const SHARE_URL_HOSTS = new Set([
  "share-worker.watermelons.workers.dev",
  "share.watermelons.workers.dev",
  "share.vibesearch.app",
]);


const LOCAL_IMPORT_HOST = "local.vibesearch.invalid";
const PROCESS_STATUS_HISTORY_MAX = 120;
const PROCESS_STATUS_SUCCESS_TTL_MS = 15 * 60 * 1000;
const PROCESS_STATUS_PROCESSING_TTL_MS = 45 * 60 * 1000;

type OffscreenResponse<T> = { success?: boolean; payload?: T; error?: string };
type ImportMode = "save" | "shot" | "extract";
type ImportTarget = { mode: ImportMode; spaceId?: string; folderId?: string; itemId?: string; screenshotMode?: "visible" | "region"; extractIntent?: boolean };
type ImportRetryAction = "RETRY_IMPORT";
type ImportClickContext = {
  pageUrl: string | null;
  frameUrl: string | null;
  linkUrl: string | null;
  mediaUrl: string | null;
  mediaType: chrome.contextMenus.OnClickData["mediaType"] | null;
  selectionText: string;
  tabUrl: string | null;
  tabTitle: string;
  tabFavIconUrl: string | null;
  capturedAt: number;
};
type HoverSaveTarget = {
  url: string;
  title?: string;
  capturedAt: number;
};
type ImportMediaUpload = { url?: string | null; key?: string };
type ExtractImageTextResponse = {
  status: "done" | "skipped" | "error";
  text: string;
  confidence?: number;
  lineCount: number;
  sourceHash: string;
  error?: string;
};
type SaveContentKind = "default" | "text-only" | "image-only" | "video-only" | "audio-only";
type ImageDomMetadata = {
  pageTitle: string;
  siteName: string;
  pageUrl: string;
  faviconUrl: string;
  altText: string;
  titleText: string;
  ariaLabel: string;
  width: number;
  height: number;
};
type PreparedImportContent = {
  itemId?: string;
  primaryUrl: string;
  title: string;
  textContent: string;
  source: ItemDocType["source"];
  iconUrl?: string;
  displayImageUrl?: string;
  media?: ItemDocType["media"];
  ocrText?: string;
  ocrStatus?: ItemDocType["ocrStatus"];
  ocrConfidence?: number;
  ocrLineCount?: number;
  ocrModelVersion?: string;
  ocrSourceHash?: string;
  tags: string[];
  shouldFetchMetadata: boolean;
  isMetaFetched: boolean;
  archiveUrl?: string;
  liveArchiveUrl?: string;
};

type ScreenshotRegionSelection = {
  x: number;
  y: number;
  width: number;
  height: number;
  viewportWidth: number;
  viewportHeight: number;
};
type ScreenshotRegionSelectionResult =
  | { status: "selected"; selection: ScreenshotRegionSelection }
  | { status: "cancelled" }
  | { status: "unavailable" };

type ExtractedContent = {
  canonicalUrl: string;
  title: string;
  author?: string;
  description?: string;
  thumbnailUrl?: string;
  mediaUrls?: Array<{ url: string; type: "image" | "video" | "audio" }>;
  platform: string;
  timestamp?: number;
};

class ImportCancelledError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ImportCancelledError";
  }
}
type TabSnapshot = {
  id?: number;
  windowId?: number;
  url?: string;
  title?: string;
};
type ImportDraft = {
  id: string;
  itemId?: string;
  mode: ImportMode;
  createdAt: number;
  updatedAt: number;
  primaryUrl: string;
  title: string;
  textContent: string;
  source: ItemDocType["source"];
  tags: string[];
  iconUrl?: string;
  displayImageUrl?: string;
  media?: ItemDocType["media"];
  ocrText?: string;
  ocrStatus?: ItemDocType["ocrStatus"];
  ocrConfidence?: number;
  ocrLineCount?: number;
  ocrModelVersion?: string;
  ocrSourceHash?: string;
  shouldFetchMetadata?: boolean;
  isMetaFetched?: boolean;
  archiveUrl?: string;
  liveArchiveUrl?: string;
  context: ImportClickContext;
  target: { spaceId: string; folderId?: string; parentId?: string | null; newFolderName?: string };
};
type ImportDraftSubmitPayload = {
  draftId: string;
  title?: string;
  url?: string;
  textContent?: string;
  source?: ItemDocType["source"];
  iconUrl?: string;
  displayImageUrl?: string;
  tags?: string[] | string;
  spaceId?: string;
  folderId?: string;
  parentId?: string | null;
  createFolderName?: string;
};
type FailedImportAttempt = {
  target: ImportTarget;
  context: ImportClickContext;
  tab?: TabSnapshot;
  createdAt: number;
};
type ProcessStatusRecord = {
  id: string;
  label: string;
  state: "processing" | "success" | "error";
  detail: string;
  retryAction?: string;
  updatedAt: number;
};
type PublicShareResponse = {
  share?: unknown;
  snapshot?: ShareSnapshotV1;
};

const trimText = (value: string, max = 80) =>
  value.length <= max ? value : `${value.slice(0, Math.max(0, max - 1)).trim()}…`;
const trimMultilineText = (value: string, max = 4000) =>
  value
    .replace(/\r\n/g, "\n")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n[ \t]+/g, "\n")
    .replace(/[ \t]{2,}/g, " ")
    .replace(/\s+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim()
    .slice(0, max);
const normalizeHttpUrl = (value: string | null | undefined): string | null => {
  if (!value) return null;
  try {
    const parsed = new URL(value.trim());
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
    return parsed.toString();
  } catch {
    return null;
  }
};
const isVibeShareUrl = (value: string | null | undefined): boolean => {
  const normalized = normalizeHttpUrl(value);
  if (!normalized) return false;
  try {
    const parsed = new URL(normalized);
    if (!SHARE_URL_HOSTS.has(parsed.hostname)) return false;
    return parsed.pathname.startsWith("/s/") || parsed.pathname.startsWith("/v1/public-shares/");
  } catch {
    return false;
  }
};
const pickSharedUrl = (context: ImportClickContext): string | null => {
  const candidates = [context.linkUrl, context.pageUrl, context.tabUrl, context.frameUrl];
  return candidates.find(isVibeShareUrl) || null;
};
const normalizeIconUrl = (value: string | null | undefined): string | null => {
  if (!value) return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  if (trimmed.startsWith("data:image/")) return trimmed;
  try {
    const parsed = new URL(trimmed);
    if (parsed.protocol === "http:" || parsed.protocol === "https:") return parsed.toString();
    return null;
  } catch {
    return null;
  }
};
const getFileNameFromUrl = (url: string | null | undefined): string => {
  if (!url) return "image";
  try {
    const parsed = new URL(url);
    const raw = parsed.pathname.split("/").filter(Boolean).pop() || "image";
    const decoded = decodeURIComponent(raw).replace(/\.[a-z0-9]{2,5}$/i, "");
    return trimText(decoded || "image", 60);
  } catch {
    return "image";
  }
};
const normalizeSelectionText = (value: string): string => {
  if (!value) return "";
  const normalizedLines = value
    .replace(/\r\n/g, "\n")
    .split("\n")
    .map((line) => line.replace(/[ \t]{2,}/g, " ").trim());
  return trimMultilineText(normalizedLines.join("\n"), 6000);
};
const buildSyntheticImportUrl = (context: ImportClickContext, mode: ImportMode): string => {
  const host = pickHostLabel(context).replace(/[^a-z0-9-]/gi, "-").replace(/-+/g, "-").replace(/^-|-$/g, "");
  const safeHost = host || "capture";
  const pathMode = mode === "shot" ? "screenshot" : mode === "extract" ? "image-text" : "import";
  return `https://${LOCAL_IMPORT_HOST}/${pathMode}/${safeHost}/${context.capturedAt}`;
};
const getHostname = (url: string | null | undefined): string | null => {
  if (!url) return null;
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return null;
  }
};
const uniqueList = (values: string[]) => {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of values) {
    const value = raw.trim();
    if (!value) continue;
    const key = value.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(value);
  }
  return out;
};
const pickHostLabel = (context: ImportClickContext) =>
  (getHostname(context.linkUrl) ||
    getHostname(context.pageUrl) ||
    getHostname(context.frameUrl) ||
    getHostname(context.mediaUrl) ||
    getHostname(context.tabUrl) ||
    "web")
    .replace(/^www\./, "");
const autoFolderName = (context: ImportClickContext, mode: ImportMode) => {
  const day = new Date(context.capturedAt).toISOString().slice(0, 10);
  const label = mode === "shot" ? "Screenshots" : mode === "extract" ? "Image text" : "Imports";
  return trimText(`${label} · ${pickHostLabel(context)} · ${day}`, 80);
};
const looksLikeMediaUrl = (url: string | null) =>
  isLikelyDirectResourceUrl(url);
const resolveMediaType = (
  mediaType: chrome.contextMenus.OnClickData["mediaType"] | null,
  url: string | null
): "image" | "video" | "audio" | null => {
  if (mediaType === "image") return "image";
  if (mediaType === "video") return "video";
  if (mediaType === "audio") return "audio";
  if (!url) return null;
  const lower = url.toLowerCase();
  if ([".jpg", ".jpeg", ".png", ".gif", ".webp", ".avif"].some((ext) => lower.includes(ext))) return "image";
  if ([".mp4", ".webm", ".mov", ".m3u8"].some((ext) => lower.includes(ext))) return "video";
  if ([".mp3", ".wav", ".ogg", ".m4a", ".aac"].some((ext) => lower.includes(ext))) return "audio";
  return null;
};

const recentProcessStatuses = new Map<string, ProcessStatusRecord>();

const sendProcessStatus = (
  id: string,
  label: string,
  state: "processing" | "success" | "error",
  detail: string,
  retryAction?: ImportRetryAction
) => {
  const payload: ProcessStatusRecord = {
    id,
    label,
    state,
    detail,
    retryAction,
    updatedAt: Date.now(),
  };
  recentProcessStatuses.set(id, payload);
  pruneRecentProcessStatuses();
  if (recentProcessStatuses.size > PROCESS_STATUS_HISTORY_MAX) {
    const trim = [...recentProcessStatuses.values()]
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .slice(0, PROCESS_STATUS_HISTORY_MAX);
    recentProcessStatuses.clear();
    for (const row of trim) recentProcessStatuses.set(row.id, row);
  }
  try {
    chrome.runtime.sendMessage({
      type: "PROCESS_STATUS",
      payload,
    });
  } catch {}
};
const isProcessStatusFresh = (row: ProcessStatusRecord, now = Date.now()): boolean => {
  if (row.state === "success") return now - row.updatedAt <= PROCESS_STATUS_SUCCESS_TTL_MS;
  if (row.state === "processing") return now - row.updatedAt <= PROCESS_STATUS_PROCESSING_TTL_MS;
  return true;
};
const pruneRecentProcessStatuses = () => {
  const now = Date.now();
  for (const [id, row] of recentProcessStatuses.entries()) {
    if (!isProcessStatusFresh(row, now)) recentProcessStatuses.delete(id);
  }
};
const listRecentProcessStatuses = (max = 24): ProcessStatusRecord[] => {
  pruneRecentProcessStatuses();
  return [...recentProcessStatuses.values()]
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .slice(0, Math.max(1, Math.min(200, max)));
};

// Publish a live "Metadata" row so a bulk import shows exactly how much
// enrichment is left. The pipeline already paces and retries requests; this
// only mirrors its progress for the UI.
setMetadataProgressListener((snapshot: MetadataProgressSnapshot) => {
  if (snapshot.pending > 0) {
    sendProcessStatus(
      "metadata-queue",
      "Metadata",
      "processing",
      `Fetching metadata — ${snapshot.completed.toLocaleString()} done, ${snapshot.pending.toLocaleString()} pending${
        snapshot.failed > 0 ? `, ${snapshot.failed.toLocaleString()} failed` : ""
      }.`
    );
    return;
  }
  sendProcessStatus(
    "metadata-queue",
    "Metadata",
    "success",
    snapshot.completed > 0
      ? `Metadata complete for ${snapshot.completed.toLocaleString()} links${
          snapshot.failed > 0 ? ` (${snapshot.failed.toLocaleString()} failed)` : ""
        }.`
      : "Metadata is idle."
  );
});
const createImportJob = (mode: ImportMode, context: ImportClickContext) => ({
  id: `import-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
  label: `${mode === "shot" ? "Screenshot" : mode === "extract" ? "Extract text" : "Import"} • ${pickHostLabel(context)}`,
});

const getStorageValue = async <T>(key: string, fallback: T): Promise<T> => {
  const row = await chrome.storage.local.get(key);
  if (!(key in row)) return fallback;
  return (row[key] as T) ?? fallback;
};
const setStorageValue = async <T>(key: string, value: T): Promise<void> => {
  await chrome.storage.local.set({ [key]: value });
};
const getImportSettings = async (): Promise<ImportSettings> => {
  const raw = await getStorageValue<Partial<ImportSettings>>(IMPORT_SETTINGS_KEY, {});
  return normalizeImportSettings(raw);
};
const setImportSettings = async (patch: Partial<ImportSettings>): Promise<ImportSettings> => {
  const raw = await getStorageValue<Partial<ImportSettings>>(IMPORT_SETTINGS_KEY, {});
  const next = normalizeImportSettings({ ...raw, ...patch });
  await setStorageValue(IMPORT_SETTINGS_KEY, next);
  return next;
};
const loadDrafts = async (): Promise<ImportDraft[]> => {
  const raw = await getStorageValue<unknown[]>(IMPORT_DRAFTS_KEY, []);
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((entry): entry is ImportDraft => !!entry && typeof (entry as ImportDraft).id === "string")
    .sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0))
    .slice(0, IMPORT_MAX_DRAFTS);
};
const saveDrafts = async (drafts: ImportDraft[]) => {
  await setStorageValue(
    IMPORT_DRAFTS_KEY,
    [...drafts].sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0)).slice(0, IMPORT_MAX_DRAFTS)
  );
};

type LruFolderEntry = ImportLruFolderEntry;

const getLruFolders = async (): Promise<LruFolderEntry[]> => {
  const raw = await getStorageValue<unknown[]>(IMPORT_LRU_FOLDERS_KEY, []);
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((entry): entry is LruFolderEntry =>
      !!entry && typeof (entry as LruFolderEntry).folderId === "string"
    )
    .sort((a, b) => b.usedAt - a.usedAt)
    .slice(0, IMPORT_LRU_MAX);
};

const recordLruFolder = async (entry: LruFolderEntry): Promise<void> => {
  const current = await getLruFolders();
  const filtered = current.filter((existing) => existing.folderId !== entry.folderId);
  filtered.unshift(entry);
  await setStorageValue(IMPORT_LRU_FOLDERS_KEY, filtered.slice(0, IMPORT_LRU_MAX));
};

const loadLiveImportSpaces = async (): Promise<LiveImportSpaceSnapshot[]> => {
  const spaces = await sendForwardedToOffscreen<Array<{ id: string; name?: string }>>({
    service: "spaces",
    type: "listSpaces",
    payload: {},
  });
  return Array.isArray(spaces) ? spaces.filter((space) => !!space?.id) : [];
};

const loadImportFolder = (folderId: string): Promise<FolderDocType | null> =>
  sendForwardedToOffscreen<FolderDocType | null>({
    service: "folders",
    type: "getById",
    payload: { id: folderId, skipLockCheck: true },
  });

const resolveFreshLiveImportFolder = async (
  folderId: string
): Promise<LiveImportFolderTarget | null> => {
  try {
    const [folder, liveSpaces] = await Promise.all([
      loadImportFolder(folderId),
      loadLiveImportSpaces(),
    ]);
    return resolveLiveImportFolderTarget(folder, liveSpaces);
  } catch {
    return null;
  }
};

const sameLruEntry = (left: LruFolderEntry, right: LruFolderEntry): boolean =>
  left.folderId === right.folderId &&
  left.spaceId === right.spaceId &&
  left.folderName === right.folderName &&
  left.spaceName === right.spaceName &&
  left.usedAt === right.usedAt;

const pruneLruFolders = async (): Promise<LruFolderEntry[]> => {
  const lru = await getLruFolders();
  if (lru.length === 0) return [];
  let liveSpaces: LiveImportSpaceSnapshot[];
  try {
    liveSpaces = await loadLiveImportSpaces();
  } catch {
    // A transient offscreen failure must not permanently erase recent targets.
    // Returning no target makes quick-save use its safe new-folder fallback.
    return [];
  }
  const folders = await Promise.all(
    lru.map((entry) => loadImportFolder(entry.folderId).catch(() => null))
  );
  const alive = reconcileLiveImportLruFolders(lru, folders, liveSpaces).slice(0, IMPORT_LRU_MAX);
  if (
    alive.length !== lru.length ||
    alive.some((entry, index) => !sameLruEntry(entry, lru[index]))
  ) {
    await setStorageValue(IMPORT_LRU_FOLDERS_KEY, alive);
  }
  return alive;
};

const resolveQuickSaveFolder = async (): Promise<{
  folderId: string;
  spaceId: string;
  folderName: string;
} | null> => {
  const lru = await pruneLruFolders();
  if (lru.length === 0) return null;
  const top = lru[0];
  return { folderId: top.folderId, spaceId: top.spaceId, folderName: top.folderName };
};

const buildLruEntryFromFolder = (
  folder: { id: string; spaceId: string; name: string },
  spaceName: string
): LruFolderEntry => ({
  folderId: folder.id,
  spaceId: folder.spaceId,
  folderName: folder.name,
  spaceName,
  usedAt: Date.now(),
});

const fetchSpaceName = async (spaceId: string): Promise<string> => {
  try {
    const spaces = await sendForwardedToOffscreen<Array<{ id: string; name: string }>>({
      service: "spaces",
      type: "listSpaces",
      payload: {},
    });
    return spaces?.find((s) => s.id === spaceId)?.name || "Space";
  } catch {
    return "Space";
  }
};

const toTabSnapshot = (tab?: chrome.tabs.Tab): TabSnapshot | undefined => {
  if (!tab) return undefined;
  return {
    id: typeof tab.id === "number" ? tab.id : undefined,
    windowId: typeof tab.windowId === "number" ? tab.windowId : undefined,
    url: tab.url,
    title: tab.title,
  };
};

const failedImportAttempts = new Map<string, FailedImportAttempt>();
const rememberFailedImportAttempt = (statusId: string, attempt: FailedImportAttempt) => {
  failedImportAttempts.set(statusId, attempt);
  const entries = [...failedImportAttempts.entries()].sort(
    (a, b) => (a[1].createdAt || 0) - (b[1].createdAt || 0)
  );
  while (entries.length > IMPORT_FAILED_ATTEMPTS_MAX) {
    const oldest = entries.shift();
    if (!oldest) break;
    failedImportAttempts.delete(oldest[0]);
  }
};
const getFailedImportAttempt = (statusId: string): FailedImportAttempt | null => {
  return failedImportAttempts.get(statusId) || null;
};

let localDataResetInProgress = false;
// Start closed until the persisted reset journal has been checked. This keeps
// an MV3 worker restart from accepting imports in the small window before an
// interrupted wipe is detected and resumed.
let localDataResetRecoveryRequired = true;
const activeBackgroundDataJobs = new Set<Promise<unknown>>();
const activeOffscreenRequests = new Set<Promise<unknown>>();

const trackBackgroundDataJob = <T>(work: Promise<T>): Promise<T> => {
  activeBackgroundDataJobs.add(work);
  void work.finally(() => activeBackgroundDataJobs.delete(work)).catch(() => {});
  return work;
};

const runBackgroundDataJob = <T>(work: () => Promise<T>): Promise<T> => {
  if (localDataResetInProgress || localDataResetRecoveryRequired) {
    return Promise.reject(new Error("LOCAL_DATA_RESET_IN_PROGRESS"));
  }
  return trackBackgroundDataJob(work());
};

const trackOffscreenRequest = <T>(work: Promise<T>): Promise<T> => {
  activeOffscreenRequests.add(work);
  void work.finally(() => activeOffscreenRequests.delete(work)).catch(() => {});
  return work;
};
const resolveRetryTab = async (snapshot?: TabSnapshot): Promise<chrome.tabs.Tab | undefined> => {
  if (!snapshot) return undefined;
  if (typeof snapshot.id === "number") {
    try {
      const tab = await chrome.tabs.get(snapshot.id);
      return tab;
    } catch {}
  }
  return snapshot as chrome.tabs.Tab;
};

const sendForwardedToOffscreen = async <T = unknown>(request: {
  service: string;
  type: string;
  payload?: unknown;
}): Promise<T> => {
  const isResetControlRequest =
    (request.service === "dbManager" && request.type === "deleteAllData") ||
    (request.service === "cloudSync" && request.type === "cancelAndClear");
  if ((localDataResetInProgress || localDataResetRecoveryRequired) && !isResetControlRequest) {
    throw new Error("LOCAL_DATA_RESET_IN_PROGRESS");
  }
  return trackOffscreenRequest((async () => {
    await setupOffscreenDocument();
    const response = (await chrome.runtime.sendMessage({
      ...request,
      target: "offscreen",
      isForwarded: true,
    })) as OffscreenResponse<T>;
    if (!response?.success) throw new Error(response?.error || `${request.service}.${request.type} failed`);
    return response.payload as T;
  })());
};

const refreshConnectorCloudAuth = async (): Promise<CloudAuthStatus | null> => {
  try {
    return await sendForwardedToOffscreen<CloudAuthStatus>({
      service: "cloudAuth",
      type: "status",
      payload: { refresh: true },
    });
  } catch {
    return null;
  }
};

type CloudSyncPushItemResponse = {
  ready?: boolean;
  reason?: string;
};

const archiveOutboxFiles = createOpfsArchiveOutboxFiles();
const archiveCache = getArchiveCache();
const archiveOutbox = new ArchiveOutbox({
  storage: createChromeArchiveOutboxStorage(),
  files: archiveOutboxFiles,
  ensureItem: async (itemId) => {
    if (typeof navigator !== "undefined" && navigator.onLine === false) {
      return { ready: false, reason: "OFFLINE", retryAfterMs: 60_000 };
    }
    const result = await sendForwardedToOffscreen<CloudSyncPushItemResponse>({
      service: "cloudSync",
      type: "pushItem",
      payload: { itemId },
    });
    return result?.ready
      ? { ready: true }
      : {
          ready: false,
          reason: result?.reason || "ITEM_NOT_SYNCED",
          retryAfterMs: result?.reason === "missing-local-item" ? 5 * 60_000 : 30_000,
        };
  },
  retainUploadedArchive: (itemId, body, updatedAt) =>
    archiveCache.put(itemId, body, updatedAt).then(() => undefined),
  retainUploadedArchiveWithinMutationLock: (itemId, body, updatedAt) =>
    archiveCache.putWithinMutationLock(itemId, body, updatedAt, {
      source: "local",
      replaceCloudNewer: true,
    }).then(() => undefined),
  isUploadedArchiveRetained: async (itemId, updatedAt, byteSize) => {
    const entry = (await archiveCache.list()).find((candidate) => candidate.itemId === itemId);
    if (!entry || entry.updatedAt !== updatedAt || entry.byteSize !== byteSize) return false;
    return (await archiveCache.get(itemId))?.size === byteSize;
  },
});
const archiveCaptureSessions = new ArchiveCaptureSessionManager({
  outbox: archiveOutbox,
});
const cancelledArchiveItems = new Map<string, number>();
let archiveWritesSuspended = false;

const purgeArchivedItems = async (itemIdsRaw: Iterable<string>): Promise<void> => {
  const itemIds = Array.from(
    new Set(Array.from(itemIdsRaw, (itemId) => itemId.trim()).filter(Boolean)),
  );
  if (itemIds.length === 0) return;
  const cancelledAt = Date.now();
  for (const itemId of itemIds) cancelledArchiveItems.set(itemId, cancelledAt);
  for (const [id, markedAt] of cancelledArchiveItems) {
    if (Date.now() - markedAt > 60 * 60 * 1000) cancelledArchiveItems.delete(id);
  }
  await Promise.all(itemIds.map((itemId) => archiveCaptureSessions.cancelItem(itemId)));
  await archiveOutbox.discardItems(itemIds);
  await archiveCache.deleteMany(itemIds);
};

const reconcileArchivedItemsWithDatabase = async (): Promise<void> => {
  const [cached, queued] = await Promise.all([archiveCache.list(), archiveOutbox.list()]);
  const candidateIds = Array.from(new Set([
    ...cached.map((entry) => entry.itemId),
    ...queued.map((job) => job.itemId),
  ]));
  if (candidateIds.length === 0) return;

  const existing = new Set<string>();
  for (let offset = 0; offset < candidateIds.length; offset += 2_000) {
    const itemIds = candidateIds.slice(offset, offset + 2_000);
    const found = await sendForwardedToOffscreen<string[]>({
      service: "dbManager",
      type: "filterExistingItemIds",
      payload: { itemIds },
    });
    for (const itemId of found || []) existing.add(itemId);
  }
  await purgeArchivedItems(candidateIds.filter((itemId) => !existing.has(itemId)));
};

const markArchiveItemCancelled = async (itemId: string): Promise<void> => {
  if (!itemId) return;
  await purgeArchivedItems([itemId]);
};

const scheduleArchiveOutboxRetry = async (): Promise<void> => {
  const jobs = await archiveOutbox.list();
  if (jobs.length === 0) {
    await chrome.alarms.clear(ARCHIVE_OUTBOX_RETRY_ALARM_NAME);
    return;
  }
  const nextAttemptAt = Math.min(...jobs.map((job) => job.nextAttemptAt));
  await chrome.alarms.create(ARCHIVE_OUTBOX_RETRY_ALARM_NAME, {
    when: Math.max(Date.now() + 30_000, nextAttemptAt),
  });
};

const triggerArchiveOutboxDrain = async (): Promise<void> => {
  if (archiveWritesSuspended) return;
  if (typeof navigator !== "undefined" && navigator.onLine === false) return;
  try {
    const result = await archiveOutbox.drain(ARCHIVE_OUTBOX_DRAIN_LIMIT);
    if (result.remaining > 0 && result.reason !== "missing-token") await scheduleArchiveOutboxRetry();
  } catch (error) {
    console.warn("[archive] outbox drain skipped", error);
    await scheduleArchiveOutboxRetry().catch(() => {});
  }
};

const queueServerArchive = async (itemId: string, archiveUrl: string): Promise<void> => {
  if (archiveWritesSuspended || cancelledArchiveItems.has(itemId)) return;
  await archiveOutbox.enqueueServerCapture(itemId, archiveUrl);
  sendProcessStatus(`archive-${itemId}`, "Offline preview", "processing", "Queued for capture.");
  void triggerArchiveOutboxDrain();
};

const capturePageArchiveForItem = async (input: {
  itemId: string;
  archiveUrl: string;
  liveArchiveUrl?: string;
  tab?: chrome.tabs.Tab;
}): Promise<void> => {
  if (archiveWritesSuspended) return;
  cancelledArchiveItems.delete(input.itemId);
  const tabId = input.tab?.id;
  const liveUrl = normalizeHttpUrl(input.liveArchiveUrl || null);
  if (typeof tabId !== "number" || !liveUrl) {
    await queueServerArchive(input.itemId, input.archiveUrl);
    return;
  }

  const statusId = `archive-${input.itemId}`;
  sendProcessStatus(statusId, "Offline preview", "processing", "Capturing this page in the background...");
  let sessionId = "";
  try {
    const currentTab = await chrome.tabs.get(tabId);
    const currentUrl = normalizeHttpUrl(currentTab.url || null);
    if (!currentUrl || currentUrl !== liveUrl) throw new Error("ARCHIVE_PAGE_NAVIGATED");

    const deadlineAt = Date.now() + PAGE_ARCHIVE_CAPTURE_TIMEOUT_MS;
    // The service worker can be terminated unexpectedly even while Chrome would
    // normally keep this message alive. A delayed server job is the durable
    // fallback; a completed local capture replaces it with the OPFS upload.
    await archiveOutbox.enqueueServerCapture(input.itemId, input.archiveUrl, {
      notBefore: deadlineAt + 2_000,
    });
    await scheduleArchiveOutboxRetry();
    const opened = await archiveCaptureSessions.open({
      itemId: input.itemId,
      tabId,
      sourceUrl: liveUrl,
      deadlineAt,
    });
    sessionId = opened.sessionId;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const timeoutPromise = new Promise<never>((_resolve, reject) => {
      timeout = setTimeout(() => reject(new Error("ARCHIVE_CAPTURE_DEADLINE")), PAGE_ARCHIVE_CAPTURE_TIMEOUT_MS + 2_000);
    });
    let response: ArchiveProtocolResponse;
    try {
      response = (await Promise.race([
        chrome.tabs.sendMessage(tabId, {
          type: PAGE_ARCHIVE_CAPTURE_MESSAGE,
          payload: {
            sessionId,
            expectedUrl: liveUrl,
            deadlineAt,
            maxHtmlBytes: opened.maxHtmlBytes,
          },
        }),
        timeoutPromise,
      ])) as ArchiveProtocolResponse;
    } finally {
      if (timeout) clearTimeout(timeout);
    }
    if (!response?.success) throw new Error(response?.error || "ARCHIVE_CAPTURE_FAILED");
    if (archiveCaptureSessions.isOpen(sessionId)) throw new Error("ARCHIVE_CAPTURE_INCOMPLETE");
    if (archiveWritesSuspended || cancelledArchiveItems.has(input.itemId)) {
      await archiveOutbox.discardItem(input.itemId);
      return;
    }
    sendProcessStatus(statusId, "Offline preview", "processing", "Captured locally; waiting to sync.");
    void triggerArchiveOutboxDrain();
  } catch (error) {
    if (sessionId) await archiveCaptureSessions.abort(sessionId, tabId).catch(() => {});
    if (archiveWritesSuspended || cancelledArchiveItems.has(input.itemId)) return;
    console.warn("[archive] live page capture fell back to server capture", error);
    await queueServerArchive(input.itemId, input.archiveUrl);
  }
};

const deleteAllLocalDataOrchestrated = async (): Promise<{ deletedCollections: number }> => {
  if (localDataResetInProgress) throw new Error("LOCAL_DATA_RESET_IN_PROGRESS");
  localDataResetInProgress = true;
  archiveWritesSuspended = true;
  archiveOutbox.invalidateInFlight();
  let result: { deletedCollections: number } | undefined;
  let operationError: unknown;
  let resetMarkerPersisted = false;
  try {
    await chrome.storage.local.set({
      [LOCAL_DATA_RESET_STORAGE_KEY]: true,
      [LOCAL_DATA_RESET_EPOCH_STORAGE_KEY]: Date.now(),
    });
    resetMarkerPersisted = true;
    cloudSyncRequestVersion += 1;
    await sendForwardedToOffscreen({
      service: "cloudSync",
      type: "cancelAndClear",
      payload: {},
    });
    await chrome.alarms.clear(CLOUD_SYNC_CONTINUATION_ALARM_NAME);
    await chrome.alarms.clear(OPFS_MEDIA_RECONCILE_CONTINUATION_ALARM_NAME);
    await chrome.storage.local.remove(OPFS_MEDIA_RECONCILE_CURSOR_KEY);
    await clearMetadataPipelineData();
    await archiveCaptureSessions.cancelAll();
    browserBookmarkAutoSyncEnabled = false;
    browserBookmarkAutoSyncEnabledLoad = null;
    await chrome.storage.local.set({ [BROWSER_BOOKMARK_AUTO_SYNC_ENABLED_KEY]: false });
    await browserBookmarkResyncScheduler.reset();
    await Promise.allSettled([
      ...Array.from(activeBackgroundDataJobs),
      ...Array.from(activeOffscreenRequests),
    ]);
    // Jobs already unwinding when cancellation started may have queued a final
    // cloud reference. Clear once more after every tracked writer is settled.
    await sendForwardedToOffscreen({
      service: "cloudSync",
      type: "cancelAndClear",
      payload: {},
    });
    await chrome.storage.local.remove([IMPORT_DRAFTS_KEY, IMPORT_LRU_FOLDERS_KEY]);
    failedImportAttempts.clear();
    pendingScreenshots.clear();
    hoverSaveTargetsByTab.clear();
    recentProcessStatuses.clear();
    const payload = await sendForwardedToOffscreen<{ deletedCollections: number }>({
      service: "dbManager",
      type: "deleteAllData",
      payload: {},
    });
    // The offscreen operation clears persisted bytes after its collection
    // deletes commit. Repeat through the live background owners so a stale
    // in-memory drain/session cannot recreate state after the wipe.
    await archiveOutbox.clear();
    await archiveCache.clear();
    await chrome.alarms.clear(ARCHIVE_OUTBOX_RETRY_ALARM_NAME);
    cancelledArchiveItems.clear();
    // Repeat volatile/persisted cleanup after the durable wipe. Any job that
    // was already unwinding when reset began has now settled and cannot
    // repopulate these stores.
    await clearMetadataPipelineData();
    await chrome.storage.local.remove([IMPORT_DRAFTS_KEY, IMPORT_LRU_FOLDERS_KEY]);
    failedImportAttempts.clear();
    pendingScreenshots.clear();
    hoverSaveTargetsByTab.clear();
    result = payload;
  } catch (error) {
    operationError = error;
  } finally {
    let cleanupError: unknown;
    const completed = operationError === undefined && result !== undefined;
    // A failed, partially completed wipe intentionally keeps its durable
    // marker. The next worker startup (or an explicit retry) resumes the wipe
    // rather than silently accepting the partial state as complete.
    if (completed || !resetMarkerPersisted) {
      try {
        await chrome.storage.local.remove(LOCAL_DATA_RESET_STORAGE_KEY);
      } catch (error) {
        cleanupError = error;
      }
    }
    localDataResetRecoveryRequired = (!completed && resetMarkerPersisted) || cleanupError !== undefined;
    archiveWritesSuspended = localDataResetRecoveryRequired;
    localDataResetInProgress = false;
    if (cleanupError !== undefined) {
      if (operationError !== undefined) {
        throw new AggregateError(
          [operationError, cleanupError],
          "LOCAL_DATA_RESET_AND_MARKER_CLEANUP_FAILED",
        );
      }
      throw cleanupError;
    }
  }
  if (operationError !== undefined) throw operationError;
  if (!result) throw new Error("LOCAL_DATA_RESET_RESULT_MISSING");
  return result;
};

let localDataResetRecoveryInFlight: Promise<boolean> | null = null;
const recoverInterruptedLocalDataReset = (): Promise<boolean> => {
  if (localDataResetRecoveryInFlight) return localDataResetRecoveryInFlight;
  const recovery = (async () => {
    const resetState = await chrome.storage.local.get(LOCAL_DATA_RESET_STORAGE_KEY);
    if (resetState[LOCAL_DATA_RESET_STORAGE_KEY] !== true) {
      localDataResetRecoveryRequired = false;
      archiveWritesSuspended = false;
      return false;
    }
    console.warn("[storage] completing an interrupted local-data reset");
    await deleteAllLocalDataOrchestrated();
    return true;
  })().finally(() => {
    localDataResetRecoveryInFlight = null;
  });
  localDataResetRecoveryInFlight = recovery;
  return recovery;
};

const retryPendingLocalMetadataUrls = async (): Promise<number> => {
  const result = await sendForwardedToOffscreen<{ urls?: string[] }>({
    service: "items",
    type: "getPendingMetadataUrls",
    payload: { limit: 500 },
  });
  const urls = Array.isArray(result?.urls)
    ? result.urls.filter((url) => typeof url === "string" && isMetadataFetchableUrl(url))
    : [];
  if (urls.length === 0) return 0;

  sendProcessStatus(
    "metadata-queue",
    "Metadata",
    "processing",
    `Retrying metadata for ${urls.length.toLocaleString()} pending links...`
  );
  scheduleForProcessing(urls, false);
  return urls.length;
};

let browserBookmarkImportInFlight: Promise<BrowserBookmarkImportResult> | null = null;
let githubStarsImportInFlight: Promise<GitHubStarsImportResult> | null = null;
let browserBookmarkAutoSyncEnabled: boolean | null = null;
let browserBookmarkAutoSyncEnabledLoad: Promise<boolean> | null = null;

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
      throw new Error(`GitHub stars request failed: ${response.status} ${detail.slice(0, 200)}`);
    }
    return response.json();
  });
};

const markBrowserBookmarkAutoSyncEnabled = async (): Promise<void> => {
  try {
    await setStorageValue(BROWSER_BOOKMARK_AUTO_SYNC_ENABLED_KEY, true);
    browserBookmarkAutoSyncEnabled = true;
  } catch (error) {
    console.warn("[browserBookmarks] could not persist automatic sync preference", error);
  }
};

const isBrowserBookmarkAutoSyncEnabled = async (): Promise<boolean> => {
  if (browserBookmarkAutoSyncEnabled !== null) return browserBookmarkAutoSyncEnabled;
  if (browserBookmarkAutoSyncEnabledLoad) return browserBookmarkAutoSyncEnabledLoad;

  const load = (async () => {
    try {
      const stored = await chrome.storage.local.get(BROWSER_BOOKMARK_AUTO_SYNC_ENABLED_KEY);
      const explicitValue = stored[BROWSER_BOOKMARK_AUTO_SYNC_ENABLED_KEY];
      if (explicitValue === true || explicitValue === false) return explicitValue;

      // Upgrade existing imports once. A fresh profile stays opt-in until the
      // person explicitly imports browser bookmarks from the app.
      const imported = await sendForwardedToOffscreen<boolean>({
        service: "browserBookmarks",
        type: "hasImported",
      });
      await setStorageValue(BROWSER_BOOKMARK_AUTO_SYNC_ENABLED_KEY, imported);
      return imported;
    } catch (error) {
      console.warn("[browserBookmarks] automatic sync availability check failed", error);
      return false;
    }
  })();
  browserBookmarkAutoSyncEnabledLoad = load;
  try {
    const enabled = await load;
    browserBookmarkAutoSyncEnabled = enabled;
    return enabled;
  } finally {
    if (browserBookmarkAutoSyncEnabledLoad === load) browserBookmarkAutoSyncEnabledLoad = null;
  }
};

type BrowserBookmarkImportOptions = {
  silent?: boolean;
  afterInFlight?: boolean;
};

const importBrowserBookmarks = async (
  options: BrowserBookmarkImportOptions = {}
): Promise<BrowserBookmarkImportResult> => {
  if (browserBookmarkImportInFlight) {
    if (!options.afterInFlight) return browserBookmarkImportInFlight;
    try {
      await browserBookmarkImportInFlight;
    } catch {
      // Read a fresh tree below so a failed overlapping import cannot discard
      // a browser mutation that arrived while it was running.
    }
    return importBrowserBookmarks({ ...options, afterInFlight: false });
  }

  const run = (async () => {
    if (!chrome.bookmarks?.getTree) {
      throw new Error("Browser bookmark access is not available in this browser.");
    }

    if (!options.silent) {
      sendProcessStatus("browser-bookmarks", "Browser bookmarks", "processing", "Reading your bookmark folders...");
    }
    const tree = (await chrome.bookmarks.getTree()) as BrowserBookmarkNode[];
    if (!options.silent) {
      sendProcessStatus("browser-bookmarks", "Browser bookmarks", "processing", "Preserving folders and importing bookmarks...");
    }
    const result = await sendForwardedToOffscreen<BrowserBookmarkImportResult>({
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
          `Queueing metadata for ${metadataUrls.length.toLocaleString()} bookmarks...`
        );
      }
      scheduleForProcessing(metadataUrls, false);
    }
    await markBrowserBookmarkAutoSyncEnabled();
    scheduleContextMenuRefresh("high");
    if (
      result.updatedFolderCount === 0 &&
      result.updatedBookmarkCount === 0 &&
      result.removedBookmarkCount === 0
    ) {
      void triggerCloudSync();
    }
    if (!options.silent) {
      sendProcessStatus(
        "browser-bookmarks",
        "Browser bookmarks",
        "success",
        `Imported ${result.bookmarkCount.toLocaleString()} bookmarks across ${result.spaceIds.length.toLocaleString()} spaces; metadata queued for ${metadataUrls.length.toLocaleString()}.`
      );
    }
    return result;
  })();

  browserBookmarkImportInFlight = run;
  try {
    return await run;
  } catch (error) {
    const detail = error instanceof Error ? error.message : "Browser bookmark import failed.";
    if (!options.silent) sendProcessStatus("browser-bookmarks", "Browser bookmarks", "error", detail);
    throw error;
  } finally {
    browserBookmarkImportInFlight = null;
  }
};

const browserBookmarkResyncScheduler = new BrowserBookmarkResyncScheduler({
  isEnabled: isBrowserBookmarkAutoSyncEnabled,
  runSync: async () => {
    await runBackgroundDataJob(() => importBrowserBookmarks({ silent: true, afterInFlight: true }));
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

const requestBrowserBookmarkResync = (): void => {
  void browserBookmarkResyncScheduler.request();
};

const importGitHubStars = async (accessToken: string): Promise<GitHubStarsImportResult> => {
  if (githubStarsImportInFlight) return githubStarsImportInFlight;

  const run = (async () => {
    sendProcessStatus("github-stars", "GitHub stars", "processing", "Reading starred repositories...");
    const stars = await fetchGitHubStars(accessToken);
    sendProcessStatus("github-stars", "GitHub stars", "processing", "Importing starred repositories...");
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
        `Queueing metadata for ${result.metadataUrls.length.toLocaleString()} starred repositories...`
      );
      scheduleForProcessing(result.metadataUrls, false);
    }
    scheduleContextMenuRefresh("high");
    sendProcessStatus(
      "github-stars",
      "GitHub stars",
      "success",
      `Imported ${result.importedCount.toLocaleString()} starred repositories across ${result.spaceIds.length.toLocaleString()} spaces; metadata queued for ${result.metadataUrls.length.toLocaleString()}.`
    );
    return result;
  })();

  githubStarsImportInFlight = run;
  try {
    return await run;
  } catch (error) {
    const detail = error instanceof Error ? error.message : "GitHub stars import failed.";
    sendProcessStatus("github-stars", "GitHub stars", "error", detail);
    throw error;
  } finally {
    githubStarsImportInFlight = null;
  }
};

const captureVisibleTabPng = async (tab?: chrome.tabs.Tab) =>
  await new Promise<string>((resolve, reject) => {
    const callback = (dataUrl?: string) => {
      if (chrome.runtime.lastError) return reject(new Error(chrome.runtime.lastError.message));
      if (!dataUrl) return reject(new Error("captureVisibleTab returned empty image"));
      resolve(dataUrl);
    };
    if (typeof tab?.windowId === "number") chrome.tabs.captureVisibleTab(tab.windowId, { format: "png" }, callback);
    else chrome.tabs.captureVisibleTab({ format: "png" }, callback);
  });
const parseTargetFromMenuId = (menuId: string): ImportTarget | null => {
  const bySpace = /^vs:(save|shot|extract):space:([^:]+)$/i.exec(menuId);
  if (bySpace) return { mode: bySpace[1] as ImportMode, spaceId: bySpace[2] };
  const byFolder = /^vs:(save|shot|extract):folder:([^:]+)$/i.exec(menuId);
  if (byFolder) return { mode: byFolder[1] as ImportMode, folderId: byFolder[2] };
  const byLru = /^vs:save:lru:folder:([^:]+)$/i.exec(menuId);
  if (byLru) return { mode: "save", folderId: byLru[1] };
  return null;
};
const hoverSaveTargetsByTab = new Map<number, HoverSaveTarget>();

const getHoverSaveTarget = (tabId: number | undefined): HoverSaveTarget | null => {
  if (typeof tabId !== "number") return null;
  const target = hoverSaveTargetsByTab.get(tabId);
  if (!target) return null;
  if (Date.now() - target.capturedAt > HOVER_SAVE_TARGET_TTL_MS) {
    hoverSaveTargetsByTab.delete(tabId);
    return null;
  }
  return target;
};

const rememberHoverSaveTarget = (tabId: number, url: string, title?: string): void => {
  hoverSaveTargetsByTab.set(tabId, {
    url,
    title: title ? trimText(title.trim(), 160) : undefined,
    capturedAt: Date.now(),
  });
};

const collectContext = (info: chrome.contextMenus.OnClickData, tab?: chrome.tabs.Tab): ImportClickContext => {
  const hoverTarget = getHoverSaveTarget(tab?.id);
  const pageUrl = normalizeHttpUrl(info.pageUrl || null);
  const nativeLinkUrl = normalizeHttpUrl(info.linkUrl || null);
  const hoverLinkUrl = hoverTarget?.url || null;
  const linkUrl =
    hoverLinkUrl && nativeLinkUrl && pageUrl && nativeLinkUrl === pageUrl && hoverLinkUrl !== pageUrl
      ? hoverLinkUrl
      : nativeLinkUrl || hoverLinkUrl;
  return {
    pageUrl,
    frameUrl: normalizeHttpUrl(info.frameUrl || null),
    linkUrl,
    mediaUrl: normalizeHttpUrl(info.srcUrl || null),
    mediaType: info.mediaType || null,
    selectionText: normalizeSelectionText(info.selectionText || ""),
    tabUrl: normalizeHttpUrl(tab?.url || null),
    tabTitle: hoverTarget?.title || (tab?.title || "").trim(),
    tabFavIconUrl: normalizeIconUrl(tab?.favIconUrl || null),
    capturedAt: Date.now(),
  };
};
const collectContextFromTab = (tab?: chrome.tabs.Tab): ImportClickContext => ({
  pageUrl: normalizeHttpUrl(tab?.url || null),
  frameUrl: null,
  linkUrl: null,
  mediaUrl: null,
  mediaType: null,
  selectionText: "",
  tabUrl: normalizeHttpUrl(tab?.url || null),
  tabTitle: (tab?.title || "").trim(),
  tabFavIconUrl: normalizeIconUrl(tab?.favIconUrl || null),
  capturedAt: Date.now(),
});
const getActiveTab = async (): Promise<chrome.tabs.Tab | undefined> => {
  try {
    const [active] = await chrome.tabs.query({ active: true, currentWindow: true });
    return active;
  } catch {
    return undefined;
  }
};
const buildContextFromUrl = (url: string): ImportClickContext => {
  const normalized = normalizeHttpUrl(url);
  let host: string | null = null;
  try {
    host = new URL(normalized!).hostname.replace(/^www\./, "");
  } catch {}
  return {
    pageUrl: normalized,
    frameUrl: null,
    linkUrl: normalized,
    mediaUrl: null,
    mediaType: null,
    selectionText: "",
    tabUrl: normalized,
    tabTitle: host || normalized || "Pasted link",
    tabFavIconUrl: host ? `https://${host}/favicon.ico` : null,
    capturedAt: Date.now(),
  };
};
const resolvePrimaryUrl = (context: ImportClickContext, mode: ImportMode) => {
  if (mode === "shot") {
    return context.pageUrl || context.tabUrl || context.linkUrl || context.mediaUrl || null;
  }
  if (mode === "extract") {
    return context.mediaUrl || context.linkUrl || context.pageUrl || context.frameUrl || context.tabUrl || null;
  }
  return context.linkUrl || context.pageUrl || context.frameUrl || context.mediaUrl || context.tabUrl || null;
};
const createTitle = (context: ImportClickContext, mode: ImportMode, fallbackUrl: string) => {
  if (mode === "shot") return trimText(context.tabTitle ? `Screenshot · ${context.tabTitle}` : `Screenshot · ${fallbackUrl}`);
  if (mode === "extract") return trimText(context.tabTitle ? `Image text · ${context.tabTitle}` : `Image text · ${fallbackUrl}`);
  if (context.selectionText) return trimText(context.selectionText.replace(/\s+/g, " "));
  if (context.tabTitle) return trimText(context.tabTitle);
  return trimText(fallbackUrl);
};
const contextText = (context: ImportClickContext, mode: ImportMode) => {
  const lines: string[] = [];
  if (context.selectionText) lines.push(context.selectionText, "");
  lines.push(`Imported via: ${mode === "shot" ? "page-screenshot" : mode === "extract" ? "image-ocr" : "context-menu"}`);
  lines.push(`Imported at: ${new Date(context.capturedAt).toISOString()}`);
  if (context.tabTitle) lines.push(`Tab: ${context.tabTitle}`);
  if (context.pageUrl) lines.push(`Page: ${context.pageUrl}`);
  if (context.frameUrl && context.frameUrl !== context.pageUrl) lines.push(`Frame: ${context.frameUrl}`);
  if (context.linkUrl) lines.push(`Link: ${context.linkUrl}`);
  if (context.mediaUrl) lines.push(`Media source: ${context.mediaUrl}`);
  return lines.join("\n");
};
const screenshotText = (context: ImportClickContext) => {
  const lines: string[] = [];
  lines.push("Imported via: page-screenshot");
  lines.push(`Imported at: ${new Date(context.capturedAt).toISOString()}`);
  if (context.tabTitle) lines.push(`Tab: ${context.tabTitle}`);
  return lines.join("\n");
};
const suggestedTags = (context: ImportClickContext, source: ItemDocType["source"]) =>
  uniqueList([source !== "web" ? source : "", pickHostLabel(context), context.mediaType || ""]).slice(0, 6);

const uploadRemoteMediaIfPresent = async (context: ImportClickContext) => {
  const mediaUrl = context.mediaUrl || (!context.mediaUrl && looksLikeMediaUrl(context.linkUrl) ? context.linkUrl : null);
  if (!mediaUrl) return { upload: null as ImportMediaUpload | null, mediaType: null as "image" | "video" | "audio" | null, originalUrl: null as string | null };
  const mediaType = resolveMediaType(context.mediaType, mediaUrl);
  if (!mediaType) return { upload: null, mediaType: null, originalUrl: mediaUrl };
  const uploaded = await uploadRemoteMediaToR2(mediaUrl, context.pageUrl || context.tabUrl || mediaUrl);
  const upload = uploaded ? { url: uploaded.r2Url, key: uploaded.key } : null;
  return { upload, mediaType, originalUrl: mediaUrl };
};
const dataUrlToBlob = (dataUrl: string): Blob => {
  const commaIndex = dataUrl.indexOf(",");
  if (!dataUrl.startsWith("data:") || commaIndex < 0) {
    throw new Error("Invalid screenshot data URL.");
  }

  const meta = dataUrl.slice(5, commaIndex);
  const rawBody = dataUrl.slice(commaIndex + 1);
  const mimeType = (meta.split(";")[0] || "image/png").trim() || "image/png";
  const isBase64 = /;base64/i.test(meta);

  if (isBase64) {
    const binary = atob(rawBody);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) {
      bytes[i] = binary.charCodeAt(i);
    }
    return new Blob([bytes], { type: mimeType });
  }

  const text = decodeURIComponent(rawBody);
  return new Blob([text], { type: mimeType });
};
const cropScreenshotBlob = async (
  sourceBlob: Blob,
  selection: ScreenshotRegionSelection
): Promise<Blob> => {
  if (typeof OffscreenCanvas === "undefined" || typeof createImageBitmap === "undefined") {
    return sourceBlob;
  }

  const bitmap = await createImageBitmap(sourceBlob);
  try {
    const viewportWidth = Math.max(1, Math.floor(selection.viewportWidth || 1));
    const viewportHeight = Math.max(1, Math.floor(selection.viewportHeight || 1));
    const scaleX = bitmap.width / viewportWidth;
    const scaleY = bitmap.height / viewportHeight;

    const sx = Math.max(0, Math.min(bitmap.width - 1, Math.floor(selection.x * scaleX)));
    const sy = Math.max(0, Math.min(bitmap.height - 1, Math.floor(selection.y * scaleY)));
    const maxWidth = Math.max(1, bitmap.width - sx);
    const maxHeight = Math.max(1, bitmap.height - sy);
    const sw = Math.max(1, Math.min(maxWidth, Math.floor(selection.width * scaleX)));
    const sh = Math.max(1, Math.min(maxHeight, Math.floor(selection.height * scaleY)));

    const canvas = new OffscreenCanvas(sw, sh);
    const ctx = canvas.getContext("2d");
    if (!ctx) {
      return sourceBlob;
    }
    ctx.drawImage(bitmap, sx, sy, sw, sh, 0, 0, sw, sh);
    const cropped = await canvas.convertToBlob({ type: "image/png", quality: 1 });
    return cropped || sourceBlob;
  } catch {
    return sourceBlob;
  } finally {
    bitmap.close();
  }
};
const captureScreenshotBlob = async (
  context: ImportClickContext,
  tab: chrome.tabs.Tab | undefined,
  sequence = 0,
  selection?: ScreenshotRegionSelection,
  onCaptured?: () => Promise<void> | void
) => {
  if (selection) {
    await new Promise((r) => setTimeout(r, 150));
  }
  const dataUrl = await captureVisibleTabPng(tab);
  if (onCaptured) {
    await onCaptured();
  }
  const sourceBlob = dataUrlToBlob(dataUrl);
  const uploadBlob = selection ? await cropScreenshotBlob(sourceBlob, selection) : sourceBlob;
  const suffix = sequence > 0 ? `-${sequence + 1}` : "";
  return {
    blob: uploadBlob,
    fileName: `screenshot-${context.capturedAt}${suffix}.png`,
  };
};

const executeScriptInTab = async <T>(
  tab: chrome.tabs.Tab | undefined,
  func: (...args: any[]) => T | Promise<T>,
  args: unknown[] = []
): Promise<T | null> => {
  if (!tab || typeof tab.id !== "number") {
    return null;
  }
  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func,
      args,
    });
    return (results?.[0]?.result as T | undefined) ?? null;
  } catch {
    return null;
  }
};

const extractContentFromPage = async (
  tab: chrome.tabs.Tab | undefined,
  clickedUrl?: string
): Promise<ExtractedContent | null> => {
  if (!tab || typeof tab.id !== "number") return null;
  
  try {
    // Inject a minimal universal extractor (OG meta + canonical link)
    const result = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: (clickedUrl?: string) => {
        const getMeta = (name: string): string | null => {
          for (const sel of [`meta[property="${name}"]`, `meta[name="${name}"]`, `meta[property="og:${name}"]`, `meta[name="twitter:${name}"]`]) {
            const el = document.querySelector(sel);
            if (el) return el.getAttribute("content") || null;
          }
          return null;
        };
        const trim = (s: string | null | undefined, max = 500): string => {
          const v = (s || "").trim();
          return v.length <= max ? v : v.slice(0, max - 1) + "…";
        };
        const resolveUrl = (href: string | null | undefined): string | null => {
          if (!href) return null;
          try { return new URL(href, window.location.href).href; } catch { return null; }
        };
        const text = (el: Element | null | undefined): string => trim(el?.textContent || "");
        const queryText = (root: ParentNode, selectors: string[]): string => {
          for (const selector of selectors) {
            const value = text(root.querySelector(selector));
            if (value) return value;
          }
          return "";
        };
        const youtubeVideoId = (): string | null => {
          const href = clickedUrl || "";
          const clickedWatchMatch = /[?&]v=([^&#]+)/.exec(href);
          if (clickedWatchMatch?.[1]) return clickedWatchMatch[1];
          const clickedShortMatch = /\/shorts\/([^/?#]+)/.exec(href);
          if (clickedShortMatch?.[1]) return clickedShortMatch[1];

          const path = window.location.pathname;
          if (path.startsWith("/shorts/")) {
            return path.split("/shorts/")[1]?.split(/[?#/]/)[0] || null;
          }
          const fromSearch = new URLSearchParams(window.location.search).get("v");
          if (fromSearch) return fromSearch;
          const watchMatch = /[?&]v=([^&#]+)/.exec(window.location.href);
          if (watchMatch?.[1]) return watchMatch[1];
          const shortMatch = /\/shorts\/([^/?#]+)/.exec(window.location.href);
          return shortMatch?.[1] || null;
        };
        const visibleScore = (el: Element): number => {
          const rect = el.getBoundingClientRect();
          if (rect.width <= 0 || rect.height <= 0) return Number.POSITIVE_INFINITY;
          if (rect.bottom < 0 || rect.top > window.innerHeight) return Number.POSITIVE_INFINITY;
          const centerY = rect.top + rect.height / 2;
          return Math.abs(centerY - window.innerHeight / 2);
        };
        const findShortRenderer = (videoId: string): Element | null => {
          const renderers = Array.from(document.querySelectorAll("ytd-reel-video-renderer, ytd-shorts, [is-active]"));
          const matching = renderers
            .filter((el) =>
              Array.from(el.querySelectorAll("a[href]")).some((anchor) =>
                ((anchor as HTMLAnchorElement).href || anchor.getAttribute("href") || "").includes(videoId)
              )
            )
            .sort((a, b) => visibleScore(a) - visibleScore(b));
          if (matching[0]) return matching[0];

          const active = renderers.find((el) => {
            const attr = el.getAttribute("is-active");
            return attr === "" || attr === "true";
          });
          if (active) return active;

          return renderers.sort((a, b) => visibleScore(a) - visibleScore(b))[0] || null;
        };
        const extractYouTube = (): ExtractedContent | null => {
          const host = window.location.hostname.replace(/^www\./, "");
          if (host !== "youtube.com" && host !== "youtu.be") return null;

          const videoId = youtubeVideoId();
          if (!videoId) return null;
          const clickedIsShort = /\/shorts\/[^/?#]+/.test(clickedUrl || "");
          const isShort = clickedIsShort || (!clickedUrl && window.location.pathname.startsWith("/shorts/"));
          const canonicalUrl = isShort
            ? `https://www.youtube.com/shorts/${videoId}`
            : `https://www.youtube.com/watch?v=${videoId}`;
          const thumbnailUrl = `https://i.ytimg.com/vi/${videoId}/maxresdefault.jpg`;

          if (isShort) {
            const root = findShortRenderer(videoId) || document;
            const title =
              queryText(root, [
                "#title h2",
                "h2 #video-title",
                "h2 yt-formatted-string",
                "#video-title",
                "h2",
              ]) || "YouTube Short";
            const author = queryText(root, [
              "ytd-channel-name a",
              "#channel-name a",
              "a[href^='/@']",
              "a[href*='/@']",
            ]);
            return {
              canonicalUrl,
              title: trim(title, 160),
              author: author || undefined,
              description: trim(getMeta("description"), 300),
              thumbnailUrl,
              platform: "youtube",
            };
          }

          const title =
            queryText(document, [
              "h1.ytd-watch-metadata yt-formatted-string",
              "h1.title",
              "h1",
            ]) ||
            trim((document.title || "").replace(/\s+-\s+YouTube$/, ""), 160) ||
            "YouTube video";
          const author = queryText(document, [
            "ytd-channel-name a",
            "#owner-name a",
            "#channel-name a",
            "a[href^='/@']",
          ]);
          return {
            canonicalUrl,
            title: trim(title, 160),
            author: author || undefined,
            description: trim(getMeta("description"), 300),
            thumbnailUrl,
            platform: "youtube",
          };
        };

        const platformResult = extractYouTube();
        if (platformResult) return platformResult;

        const canonicalUrl = resolveUrl(clickedUrl) || resolveUrl(getMeta("url")) || resolveUrl(document.querySelector('link[rel="canonical"]')?.getAttribute("href")) || window.location.href;
        const title = getMeta("title") || document.querySelector("h1")?.textContent?.trim() || document.title || "Saved page";
        const description = getMeta("description");
        const thumbnailUrl = resolveUrl(getMeta("image"));
        const author = getMeta("author");

        return {
          canonicalUrl,
          title: trim(title),
          author: author ?? undefined,
          description: trim(description, 300),
          thumbnailUrl: thumbnailUrl ?? undefined,
          platform: "web",
        };
      },
      args: [clickedUrl],
    });
    
    return (result?.[0]?.result as ExtractedContent | undefined) ?? null;
  } catch {
    return null;
  }
};

const showBrandedToast = async (
  tab: chrome.tabs.Tab | undefined,
  message: string,
  actions?: Array<{ label: string; action: string; payload?: Record<string, unknown> }>,
  duration = 4000
) => {
  await executeScriptInTab(
    tab,
    (payload: {
      message: string;
      actions?: Array<{ label: string; action: string; payload?: Record<string, unknown> }>;
      duration: number;
    }) => {
      try {
        const TOKENS = {
          bg: "#ffffff",
          border: "#c6c6c6",
          accent: "#ff4d4d",
          accentFaded: "#ffe5e5",
          text: "#212121",
          shadow: "0px 20px 35px rgba(15, 23, 42, 0.18)",
          radius: "10px",
          radiusSm: "6px",
          fontSans: '"Neutral Sans", ui-sans-serif, system-ui, sans-serif',
        };

        const rootId = "__vibesearch_toast_root__";
        let root = document.getElementById(rootId);
        if (!root) {
          root = document.createElement("div");
          root.id = rootId;
          const shadow = root.attachShadow({ mode: "open" });
          const container = document.createElement("div");
          container.id = "container";
          Object.assign(container.style, {
            position: "fixed",
            right: "16px",
            bottom: "16px",
            zIndex: "2147483647",
            display: "flex",
            flexDirection: "column",
            gap: "10px",
            pointerEvents: "none",
            fontFamily: TOKENS.fontSans,
          });
          shadow.appendChild(container);
          document.documentElement.appendChild(root);
        }

        const shadow = root.shadowRoot!;
        const container = shadow.getElementById("container")!;

        const toast = document.createElement("div");
        Object.assign(toast.style, {
          maxWidth: "380px",
          minWidth: "280px",
          padding: "12px 14px",
          borderRadius: TOKENS.radius,
          background: TOKENS.bg,
          border: `1px solid ${TOKENS.border}`,
          boxShadow: TOKENS.shadow,
          display: "flex",
          alignItems: "center",
          gap: "12px",
          pointerEvents: "auto",
          fontSize: "13px",
          lineHeight: "1.4",
          color: TOKENS.text,
          fontFamily: TOKENS.fontSans,
        });

        const messageEl = document.createElement("div");
        messageEl.textContent = payload.message;
        Object.assign(messageEl.style, { flex: "1", fontWeight: "500" });
        toast.appendChild(messageEl);

        if (payload.actions && payload.actions.length > 0) {
          const actionsRow = document.createElement("div");
          Object.assign(actionsRow.style, {
            display: "flex",
            gap: "8px",
            alignItems: "center",
            flexWrap: "wrap",
          });

          for (const action of payload.actions) {
            const btn = document.createElement("button");
            btn.type = "button";
            btn.textContent = action.label;
            Object.assign(btn.style, {
              padding: "5px 10px",
              borderRadius: TOKENS.radiusSm,
              border: `1px solid ${TOKENS.accent}`,
              background: "transparent",
              color: TOKENS.accent,
              fontSize: "12px",
              fontWeight: "600",
              cursor: "pointer",
              fontFamily: TOKENS.fontSans,
              transition: "all 150ms",
            });
            btn.addEventListener("mouseenter", () => {
              btn.style.background = TOKENS.accentFaded;
            });
            btn.addEventListener("mouseleave", () => {
              btn.style.background = "transparent";
            });
            btn.addEventListener("click", () => {
              chrome.runtime.sendMessage({
                target: "background",
                type: action.action,
                payload: action.payload,
              });
              toast.remove();
              if (container.childElementCount === 0) root!.remove();
            });
            actionsRow.appendChild(btn);
          }

          toast.appendChild(actionsRow);
        }

        container.appendChild(toast);

        if (payload.duration > 0) {
          setTimeout(() => {
            toast.remove();
            if (container.childElementCount === 0) root!.remove();
          }, payload.duration);
        }
      } catch {}
    },
    [{ message, actions, duration }]
  );
};

type DestinationPickerSpace = {
  spaceId: string;
  spaceName: string;
  folders: Array<{ folderId: string; folderName: string; usedAt: number }>;
};

const showDestinationPickerToast = async (
  tab: chrome.tabs.Tab | undefined,
  title: string,
  spaces: DestinationPickerSpace[],
  confirmAction: string,
  extraPayload: Record<string, unknown> = {},
  options: {
    autoSave?: { timeoutMs: number; targetLabel: string };
    allowSpaceDirectSave?: boolean;
  } = {}
) => {
  await executeScriptInTab(
    tab,
    (payload: {
      title: string;
      spaces: Array<{
        spaceId: string;
        spaceName: string;
        folders: Array<{ folderId: string; folderName: string; usedAt: number }>;
      }>;
      confirmAction: string;
      extraPayload: Record<string, unknown>;
      autoSave: { timeoutMs: number; targetLabel: string } | null;
      allowSpaceDirectSave: boolean;
    }) => {
      try {
        const TOKENS = {
          bg: "#ffffff",
          border: "#c6c6c6",
          accent: "#ff4d4d",
          accentFaded: "#ffe5e5",
          text: "#212121",
          textMuted: "#6b6b6b",
          rowHover: "#f5f5f5",
          shadow: "0px 20px 35px rgba(15, 23, 42, 0.18)",
          radius: "10px",
          radiusSm: "6px",
          fontSans: '"Neutral Sans", ui-sans-serif, system-ui, sans-serif',
        };

        const rootId = "__vibesearch_picker_root__";
        const existing = document.getElementById(rootId);
        if (existing) existing.remove();

        const root = document.createElement("div");
        root.id = rootId;
        const shadow = root.attachShadow({ mode: "open" });

        let closed = false;
        let countdownTimer: ReturnType<typeof setInterval> | null = null;
        let onKey: ((event: KeyboardEvent) => void) | null = null;
        const cleanup = () => {
          if (countdownTimer !== null) {
            clearInterval(countdownTimer);
            countdownTimer = null;
          }
          if (onKey) {
            window.removeEventListener("keydown", onKey, true);
            onKey = null;
          }
        };
        const dismiss = () => {
          if (closed) return;
          closed = true;
          cleanup();
          root.remove();
        };
        const confirmSave = (folderId: string, spaceId: string, auto: boolean) => {
          if (closed) return;
          chrome.runtime.sendMessage({
            target: "background",
            type: payload.confirmAction,
            payload: { ...payload.extraPayload, folderId, spaceId, autoSave: auto },
          });
          dismiss();
        };

        const panel = document.createElement("div");
        Object.assign(panel.style, {
          position: "fixed",
          right: "16px",
          bottom: "16px",
          zIndex: "2147483647",
          width: "320px",
          maxHeight: "420px",
          display: "flex",
          flexDirection: "column",
          background: TOKENS.bg,
          border: `1px solid ${TOKENS.border}`,
          borderRadius: TOKENS.radius,
          boxShadow: TOKENS.shadow,
          fontFamily: TOKENS.fontSans,
          color: TOKENS.text,
          fontSize: "13px",
          overflow: "hidden",
          pointerEvents: "auto",
        });

        const header = document.createElement("div");
        Object.assign(header.style, {
          padding: "10px 14px",
          borderBottom: `1px solid ${TOKENS.border}`,
          fontWeight: "600",
          fontSize: "13px",
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
        });
        header.textContent = payload.title;

        const closeBtn = document.createElement("button");
        closeBtn.type = "button";
        closeBtn.textContent = "×";
        Object.assign(closeBtn.style, {
          background: "transparent",
          border: "none",
          color: TOKENS.textMuted,
          fontSize: "18px",
          cursor: "pointer",
          padding: "0 4px",
          lineHeight: "1",
          fontFamily: TOKENS.fontSans,
        });
        closeBtn.addEventListener("click", () => {
          dismiss();
        });
        header.appendChild(closeBtn);
        panel.appendChild(header);

        const listScroll = document.createElement("div");
        Object.assign(listScroll.style, {
          overflowY: "auto",
          flex: "1",
          padding: "4px 0",
        });

        const renderRow = (
          label: string,
          onClick: () => void,
          opts: { indent?: boolean; muted?: boolean; bold?: boolean; chevron?: boolean } = {}
        ) => {
          const row = document.createElement("div");
          Object.assign(row.style, {
            padding: "8px 14px",
            cursor: "pointer",
            display: "flex",
            alignItems: "center",
            gap: "8px",
            paddingLeft: opts.indent ? "28px" : "14px",
            color: opts.muted ? TOKENS.textMuted : TOKENS.text,
            fontWeight: opts.bold ? "600" : "400",
            fontSize: "13px",
            transition: "background 120ms",
            fontFamily: TOKENS.fontSans,
          });
          row.textContent = label;
          row.addEventListener("mouseenter", () => {
            row.style.background = TOKENS.rowHover;
          });
          row.addEventListener("mouseleave", () => {
            row.style.background = "transparent";
          });
          row.addEventListener("click", onClick);
          return row;
        };

        const addHint = (row: HTMLElement, text: string) => {
          const hint = document.createElement("span");
          hint.textContent = text;
          Object.assign(hint.style, {
            marginLeft: "auto",
            fontSize: "11px",
            fontWeight: "400",
            color: TOKENS.textMuted,
          });
          row.appendChild(hint);
        };

        for (const space of payload.spaces) {
          const spaceLabel = `space-${space.spaceName}`;
          const sortedFolders = [...space.folders].sort((a, b) => b.usedAt - a.usedAt);

          // A space with no groups can't be expanded into folder rows. Instead of
          // leaving an inert row that looks "stuck", make it directly saveable
          // (screenshot picker) or show it as non-actionable.
          if (sortedFolders.length === 0) {
            if (payload.allowSpaceDirectSave) {
              const spaceRow = renderRow(
                spaceLabel,
                () => confirmSave("", space.spaceId, false),
                { bold: true }
              );
              addHint(spaceRow, "save here");
              listScroll.appendChild(spaceRow);
            } else {
              const spaceRow = renderRow(spaceLabel, () => {}, { bold: true, muted: true });
              spaceRow.style.cursor = "default";
              addHint(spaceRow, "no groups");
              listScroll.appendChild(spaceRow);
            }
            continue;
          }

          let expanded = false;
          const folderRows: HTMLElement[] = [];

          const spaceRow = renderRow(
            spaceLabel,
            () => {
              expanded = !expanded;
              for (const fr of folderRows) {
                fr.style.display = expanded ? "flex" : "none";
              }
            },
            { bold: true, chevron: true }
          );

          const chevron = document.createElement("span");
          chevron.textContent = "›";
          Object.assign(chevron.style, {
            fontSize: "14px",
            color: TOKENS.textMuted,
            transition: "transform 150ms",
          });
          spaceRow.insertBefore(chevron, spaceRow.firstChild!);

          listScroll.appendChild(spaceRow);

          for (const folder of sortedFolders) {
            const folderRow = renderRow(
              folder.folderName || "Untitled",
              () => confirmSave(folder.folderId, space.spaceId, false),
              { indent: true, muted: false }
            );
            folderRow.style.display = "none";
            folderRows.push(folderRow);
            listScroll.appendChild(folderRow);
          }
        }

        panel.appendChild(listScroll);

        if (payload.autoSave) {
          const autoSave = payload.autoSave;
          const footer = document.createElement("div");
          Object.assign(footer.style, {
            padding: "8px 14px",
            borderTop: `1px solid ${TOKENS.border}`,
            fontSize: "12px",
            color: TOKENS.textMuted,
            fontFamily: TOKENS.fontSans,
          });
          panel.appendChild(footer);

          let remainingMs = autoSave.timeoutMs;
          let paused = false;
          let lastTick = Date.now();
          const secondsLeft = () => Math.max(0, Math.ceil(remainingMs / 1000));
          const renderFooter = () => {
            footer.textContent = paused
              ? `Paused. Move away to resume saving to ${autoSave.targetLabel}.`
              : `Auto-saving to ${autoSave.targetLabel} in ${secondsLeft()}s. Hover to pause.`;
          };
          renderFooter();

          countdownTimer = setInterval(() => {
            const now = Date.now();
            const delta = now - lastTick;
            lastTick = now;
            if (!paused) {
              remainingMs -= delta;
              if (remainingMs <= 0) {
                // No explicit choice within the window: save to the recent/LRU
                // folder (empty folderId + spaceId routes through preferLru).
                confirmSave("", "", true);
                return;
              }
            }
            renderFooter();
          }, 200);

          panel.addEventListener("mouseenter", () => {
            paused = true;
            renderFooter();
          });
          panel.addEventListener("mouseleave", () => {
            paused = false;
            lastTick = Date.now();
            renderFooter();
          });
        }

        shadow.appendChild(panel);
        document.documentElement.appendChild(root);

        onKey = (event: KeyboardEvent) => {
          if (event.key === "Escape") dismiss();
        };
        window.addEventListener("keydown", onKey, true);
      } catch {}
    },
    [
      {
        title,
        spaces,
        confirmAction,
        extraPayload,
        autoSave: options.autoSave ?? null,
        allowSpaceDirectSave: options.allowSpaceDirectSave === true,
      },
    ]
  );
};

const selectScreenshotRegion = async (
  tab: chrome.tabs.Tab | undefined
): Promise<ScreenshotRegionSelectionResult> => {
  const result = await executeScriptInTab<ScreenshotRegionSelectionResult | null>(
    tab,
    () => {
      try {
        return new Promise<{
          status: "selected";
          selection: {
            x: number;
            y: number;
            width: number;
            height: number;
            viewportWidth: number;
            viewportHeight: number;
          };
        } | { status: "cancelled" }>((resolve) => {
          const TOKENS = {
            bg: "#ffffff",
            border: "#c6c6c6",
            accent: "#ff4d4d",
            text: "#212121",
            shadow: "0px 20px 35px rgba(15, 23, 42, 0.18)",
            radius: "10px",
            fontSans: '"Neutral Sans", ui-sans-serif, system-ui, sans-serif',
          };

          const rootId = "__vibesearch_screenshot_selector__";
          const existing = document.getElementById(rootId);
          if (existing) existing.remove();

          const root = document.createElement("div");
          root.id = rootId;
          const shadow = root.attachShadow({ mode: "open" });

          // Scrim
          const scrim = document.createElement("div");
          Object.assign(scrim.style, {
            position: "fixed",
            top: "0",
            left: "0",
            width: "100%",
            height: "100%",
            background: "rgba(0, 0, 0, 0.4)",
            zIndex: "2147483646",
            cursor: "crosshair",
          });

          // Selection box
          const box = document.createElement("div");
          Object.assign(box.style, {
            position: "fixed",
            border: `2px solid ${TOKENS.accent}`,
            background: "rgba(255, 77, 77, 0.08)",
            pointerEvents: "none",
            display: "none",
            zIndex: "2147483647",
          });

          // Hint
          const hint = document.createElement("div");
          hint.textContent = "Drag to select \u2022 Enter to save \u2022 Esc to cancel";
          Object.assign(hint.style, {
            position: "fixed",
            top: "20px",
            left: "50%",
            transform: "translateX(-50%)",
            padding: "10px 16px",
            borderRadius: TOKENS.radius,
            background: TOKENS.bg,
            border: `1px solid ${TOKENS.border}`,
            boxShadow: TOKENS.shadow,
            fontSize: "13px",
            fontWeight: "500",
            color: TOKENS.text,
            fontFamily: TOKENS.fontSans,
            zIndex: "2147483647",
            pointerEvents: "none",
          });

          shadow.appendChild(scrim);
          shadow.appendChild(box);
          shadow.appendChild(hint);
          document.documentElement.appendChild(root);

          let startX = 0;
          let startY = 0;
          let isDragging = false;

          const cleanup = (
            selection: {
              x: number;
              y: number;
              width: number;
              height: number;
              viewportWidth: number;
              viewportHeight: number;
            } | null
          ) => {
            window.removeEventListener("keydown", onKeyDown, true);
            scrim.removeEventListener("mousedown", onMouseDown);
            scrim.removeEventListener("mousemove", onMouseMove);
            scrim.removeEventListener("mouseup", onMouseUp);
            root.remove();
            requestAnimationFrame(() => {
              requestAnimationFrame(() => {
                if (selection) {
                  resolve({ status: "selected", selection });
                } else {
                  resolve({ status: "cancelled" });
                }
              });
            });
          };

          const onMouseDown = (e: MouseEvent) => {
            startX = e.clientX;
            startY = e.clientY;
            isDragging = true;
            box.style.display = "block";
            box.style.left = `${startX}px`;
            box.style.top = `${startY}px`;
            box.style.width = "0";
            box.style.height = "0";
          };

          const onMouseMove = (e: MouseEvent) => {
            if (!isDragging) return;
            const x = Math.min(startX, e.clientX);
            const y = Math.min(startY, e.clientY);
            const width = Math.abs(e.clientX - startX);
            const height = Math.abs(e.clientY - startY);
            box.style.left = `${x}px`;
            box.style.top = `${y}px`;
            box.style.width = `${width}px`;
            box.style.height = `${height}px`;
          };

          const onMouseUp = (e: MouseEvent) => {
            if (!isDragging) return;
            isDragging = false;
            const x = Math.min(startX, e.clientX);
            const y = Math.min(startY, e.clientY);
            const width = Math.abs(e.clientX - startX);
            const height = Math.abs(e.clientY - startY);
            if (width > 10 && height > 10) {
              cleanup({
                x,
                y,
                width,
                height,
                viewportWidth: window.innerWidth,
                viewportHeight: window.innerHeight,
              });
            } else {
              box.style.display = "none";
            }
          };

          const onKeyDown = (e: KeyboardEvent) => {
            if (e.key === "Escape") {
              e.preventDefault();
              cleanup(null);
            } else if (e.key === "Enter" && box.style.display === "block") {
              e.preventDefault();
              const x = parseInt(box.style.left, 10);
              const y = parseInt(box.style.top, 10);
              const width = parseInt(box.style.width, 10);
              const height = parseInt(box.style.height, 10);
              if (width > 10 && height > 10) {
                cleanup({
                  x,
                  y,
                  width,
                  height,
                  viewportWidth: window.innerWidth,
                  viewportHeight: window.innerHeight,
                });
              }
            }
          };

          scrim.addEventListener("mousedown", onMouseDown);
          scrim.addEventListener("mousemove", onMouseMove);
          scrim.addEventListener("mouseup", onMouseUp);
          window.addEventListener("keydown", onKeyDown, true);
        });
      } catch {
        return { status: "unavailable" } satisfies ScreenshotRegionSelectionResult;
      }
    },
    []
  );

  if (!result) {
    return { status: "unavailable" };
  }
  if (result.status === "selected") {
    const { selection } = result;
    if (
      Number.isFinite(selection.x) &&
      Number.isFinite(selection.y) &&
      Number.isFinite(selection.width) &&
      Number.isFinite(selection.height) &&
      selection.width > 0 &&
      selection.height > 0 &&
      selection.viewportWidth > 0 &&
      selection.viewportHeight > 0
    ) {
      return result;
    }
    return { status: "cancelled" };
  }
  if (result.status === "cancelled") {
    return result;
  }
  return { status: "unavailable" };
};

const resolveSaveContentKind = (context: ImportClickContext): SaveContentKind => {
  const mediaUrl =
    context.mediaUrl || (!context.mediaUrl && looksLikeMediaUrl(context.linkUrl) ? context.linkUrl : null);
  const mediaType = resolveMediaType(context.mediaType, mediaUrl);
  const hasSelectionText = context.selectionText.length > 0;

  if (mediaType === "image" && !!mediaUrl) {
    return "image-only";
  }
  if (mediaType === "video" && !!mediaUrl) {
    return "video-only";
  }
  if (mediaType === "audio" && !!mediaUrl) {
    return "audio-only";
  }

  const pageMediaUrl = looksLikeMediaUrl(context.pageUrl) ? context.pageUrl
    : looksLikeMediaUrl(context.tabUrl) ? context.tabUrl
    : looksLikeMediaUrl(context.frameUrl) ? context.frameUrl
    : null;
  if (pageMediaUrl) {
    const pageMediaType = resolveMediaType(null, pageMediaUrl);
    if (pageMediaType === "image") return "image-only";
    if (pageMediaType === "video") return "video-only";
    if (pageMediaType === "audio") return "audio-only";
  }

  if (hasSelectionText && !mediaUrl) {
    return "text-only";
  }
  return "default";
};

const resolveSavePrimaryUrl = (context: ImportClickContext) =>
  context.pageUrl || context.frameUrl || context.tabUrl || context.linkUrl || context.mediaUrl || null;

const resolveLiveArchiveUrl = (
  context: ImportClickContext,
  tab: chrome.tabs.Tab | undefined,
): string | undefined => {
  if (
    typeof tab?.id !== "number" ||
    context.linkUrl ||
    context.mediaUrl ||
    context.selectionText ||
    (context.frameUrl && context.frameUrl !== context.tabUrl)
  ) {
    return undefined;
  }
  return normalizeHttpUrl(tab.url || context.tabUrl || context.pageUrl) || undefined;
};

const resolveSavePrimaryUrlOrFallback = (
  context: ImportClickContext,
  mode: ImportMode
): { url: string; synthetic: boolean } => {
  const primary = resolveSavePrimaryUrl(context);
  if (primary) {
    return { url: primary, synthetic: false };
  }
  return { url: buildSyntheticImportUrl(context, mode), synthetic: true };
};

const isMetadataFetchablePageUrl = (url: string): boolean => {
  return isMetadataFetchableUrl(url, { blockedHosts: [LOCAL_IMPORT_HOST] });
};

const fetchImageDomMetadata = async (
  tab: chrome.tabs.Tab | undefined,
  mediaUrl: string
): Promise<ImageDomMetadata | null> => {
  return await executeScriptInTab<ImageDomMetadata | null>(
    tab,
    (targetUrl: string) => {
      const normalize = (raw: string | null | undefined) => {
        if (!raw) return "";
        try {
          return new URL(raw, window.location.href).toString();
        } catch {
          return "";
        }
      };
      const normalizedTarget = normalize(targetUrl);
      const images = Array.from(document.querySelectorAll("img")) as HTMLImageElement[];
      const directMatch = images.find((img) => {
        const current = normalize(img.currentSrc || img.src);
        return !!current && current === normalizedTarget;
      });
      const looseMatch =
        directMatch ||
        images.find((img) => {
          const src = img.currentSrc || img.src || "";
          return src.includes(targetUrl) || targetUrl.includes(src);
        }) ||
        null;

      const siteNameMeta =
        (document.querySelector('meta[property="og:site_name"]') as HTMLMetaElement | null)?.content ||
        (document.querySelector('meta[name="application-name"]') as HTMLMetaElement | null)?.content ||
        "";
      const iconEl = document.querySelector(
        'link[rel~="icon"], link[rel="shortcut icon"], link[rel="apple-touch-icon"]'
      ) as HTMLLinkElement | null;
      const iconHref = iconEl?.getAttribute("href") || "";
      let faviconUrl = "";
      if (iconHref) {
        try {
          faviconUrl = new URL(iconHref, window.location.href).toString();
        } catch {}
      }
      if (!faviconUrl) {
        try {
          faviconUrl = new URL("/favicon.ico", window.location.origin).toString();
        } catch {}
      }

      const image = looseMatch;
      return {
        pageTitle: (document.title || "").trim(),
        siteName: (siteNameMeta || window.location.hostname.replace(/^www\./, "")).trim(),
        pageUrl: window.location.href,
        faviconUrl,
        altText: (image?.getAttribute("alt") || "").trim(),
        titleText: (image?.getAttribute("title") || "").trim(),
        ariaLabel: (image?.getAttribute("aria-label") || "").trim(),
        width: Number(image?.naturalWidth || 0),
        height: Number(image?.naturalHeight || 0),
      } satisfies ImageDomMetadata;
    },
    [mediaUrl]
  );
};

const buildTextOnlyContent = (context: ImportClickContext): PreparedImportContent | null => {
  const selected = normalizeSelectionText(context.selectionText);
  if (!selected) return null;
  const saveTarget = resolveSavePrimaryUrlOrFallback(context, "save");
  const source = inferSource(resolveSavePrimaryUrl(context) || saveTarget.url);
  const title = trimText(selected.split(/\n+/).find((line) => line.trim()) || selected, 80);
  return {
    primaryUrl: saveTarget.url,
    title,
    textContent: selected,
    source,
    iconUrl: context.tabFavIconUrl || undefined,
    tags: uniqueList([source !== "web" ? source : "", "text", pickHostLabel(context)]),
    shouldFetchMetadata: false,
    isMetaFetched: true,
  };
};

const buildImageOnlyContent = async (
  context: ImportClickContext,
  tab: chrome.tabs.Tab | undefined
): Promise<PreparedImportContent | null> => {
  const mediaUrl =
    context.mediaUrl ||
    (looksLikeMediaUrl(context.linkUrl) ? context.linkUrl : null) ||
    (looksLikeMediaUrl(context.pageUrl) ? context.pageUrl : null) ||
    (looksLikeMediaUrl(context.tabUrl) ? context.tabUrl : null) ||
    (looksLikeMediaUrl(context.frameUrl) ? context.frameUrl : null);
  if (!mediaUrl) return null;
  const mediaType = resolveMediaType(context.mediaType, mediaUrl);
  if (mediaType !== "image") return null;

  const domMeta = await fetchImageDomMetadata(tab, mediaUrl);
  const pageUrl = normalizeHttpUrl(domMeta?.pageUrl || null) || context.pageUrl || context.tabUrl || null;
  const source = inferSource(pageUrl || mediaUrl);

  let media: ItemDocType["media"] | undefined;
  let displayImageUrl: string | undefined;
  try {
    const mediaResult = await uploadRemoteMediaIfPresent({
      ...context,
      mediaUrl,
      mediaType: "image",
    });
    if (mediaResult.upload?.url) {
      media = [{
        type: "image",
        originalUrl: mediaUrl,
        storageType: "s3",
        s3Url: mediaResult.upload.url,
        altText: domMeta?.altText || undefined,
        titleText: domMeta?.titleText || undefined,
        ariaLabel: domMeta?.ariaLabel || undefined,
        pageUrl: pageUrl || undefined,
        pageTitle: domMeta?.pageTitle || undefined,
        siteName: domMeta?.siteName || undefined,
        faviconUrl: normalizeIconUrl(domMeta?.faviconUrl || null) || context.tabFavIconUrl || undefined,
        width: domMeta?.width || undefined,
        height: domMeta?.height || undefined,
        capturedAt: context.capturedAt,
      }];
      displayImageUrl = mediaResult.upload.url || undefined;
    }
  } catch {}

  if (!media) {
    media = [{
      type: "image",
      originalUrl: mediaUrl,
      storageType: "hotlink",
      altText: domMeta?.altText || undefined,
      titleText: domMeta?.titleText || undefined,
      ariaLabel: domMeta?.ariaLabel || undefined,
      pageUrl: pageUrl || undefined,
      pageTitle: domMeta?.pageTitle || undefined,
      siteName: domMeta?.siteName || undefined,
      faviconUrl: normalizeIconUrl(domMeta?.faviconUrl || null) || context.tabFavIconUrl || undefined,
      width: domMeta?.width || undefined,
      height: domMeta?.height || undefined,
      capturedAt: context.capturedAt,
    }];
    displayImageUrl = mediaUrl;
  }

  const candidateLabel = trimText(
    domMeta?.altText || domMeta?.titleText || domMeta?.ariaLabel || getFileNameFromUrl(mediaUrl),
    80
  );
  const title = candidateLabel || `Image · ${getFileNameFromUrl(mediaUrl)}`;

  return {
    primaryUrl: mediaUrl,
    title,
    textContent: "",
    source,
    iconUrl: normalizeIconUrl(domMeta?.faviconUrl || null) || context.tabFavIconUrl || undefined,
    displayImageUrl,
    media,
    tags: uniqueList([source !== "web" ? source : "", "image", pickHostLabel(context)]),
    shouldFetchMetadata: false,
    isMetaFetched: true,
  };
};

const buildVideoOnlyContent = async (
  context: ImportClickContext
): Promise<PreparedImportContent | null> => {
  const mediaUrl =
    context.mediaUrl ||
    (looksLikeMediaUrl(context.linkUrl) ? context.linkUrl : null) ||
    (looksLikeMediaUrl(context.pageUrl) ? context.pageUrl : null) ||
    (looksLikeMediaUrl(context.tabUrl) ? context.tabUrl : null) ||
    (looksLikeMediaUrl(context.frameUrl) ? context.frameUrl : null);
  if (!mediaUrl) return null;
  const mediaType = resolveMediaType(context.mediaType, mediaUrl);
  if (mediaType !== "video") return null;

  const pageUrl = context.pageUrl || context.tabUrl || null;
  const source = inferSource(pageUrl || mediaUrl);

  const media: ItemDocType["media"] = [{
    type: "video",
    originalUrl: mediaUrl,
    storageType: "hotlink",
    pageUrl: pageUrl || undefined,
    pageTitle: context.tabTitle || undefined,
    faviconUrl: context.tabFavIconUrl || undefined,
    capturedAt: context.capturedAt,
  }];

  const title = trimText(context.tabTitle || `Video · ${getFileNameFromUrl(mediaUrl)}`, 80) || "Video";

  return {
    primaryUrl: mediaUrl,
    title,
    textContent: "",
    source,
    iconUrl: context.tabFavIconUrl || undefined,
    media,
    tags: uniqueList([source !== "web" ? source : "", "video", pickHostLabel(context)]),
    shouldFetchMetadata: false,
    isMetaFetched: true,
  };
};

const buildAudioOnlyContent = async (
  context: ImportClickContext
): Promise<PreparedImportContent | null> => {
  const mediaUrl =
    context.mediaUrl ||
    (looksLikeMediaUrl(context.linkUrl) ? context.linkUrl : null) ||
    (looksLikeMediaUrl(context.pageUrl) ? context.pageUrl : null) ||
    (looksLikeMediaUrl(context.tabUrl) ? context.tabUrl : null) ||
    (looksLikeMediaUrl(context.frameUrl) ? context.frameUrl : null);
  if (!mediaUrl) return null;
  const mediaType = resolveMediaType(context.mediaType, mediaUrl);
  if (mediaType !== "audio") return null;

  const pageUrl = context.pageUrl || context.tabUrl || null;
  const source = inferSource(pageUrl || mediaUrl);

  const media: ItemDocType["media"] = [{
    type: "audio",
    originalUrl: mediaUrl,
    storageType: "hotlink",
    pageUrl: pageUrl || undefined,
    pageTitle: context.tabTitle || undefined,
    faviconUrl: context.tabFavIconUrl || undefined,
    capturedAt: context.capturedAt,
  }];

  const title = trimText(context.tabTitle || `Audio · ${getFileNameFromUrl(mediaUrl)}`, 80) || "Audio";

  return {
    primaryUrl: mediaUrl,
    title,
    textContent: "",
    source,
    iconUrl: context.tabFavIconUrl || undefined,
    media,
    tags: uniqueList([source !== "web" ? source : "", "audio", pickHostLabel(context)]),
    shouldFetchMetadata: false,
    isMetaFetched: true,
  };
};

const buildExtractedImageTextContent = async (
  context: ImportClickContext,
  tab: chrome.tabs.Tab | undefined,
  job: { id: string; label: string }
): Promise<PreparedImportContent> => {
  const mediaUrl =
    context.mediaUrl || (!context.mediaUrl && looksLikeMediaUrl(context.linkUrl) ? context.linkUrl : null);
  if (!mediaUrl || resolveMediaType(context.mediaType, mediaUrl) !== "image") {
    throw new Error("No image found for text extraction.");
  }

  const domMeta = await fetchImageDomMetadata(tab, mediaUrl);
  const pageUrl = normalizeHttpUrl(domMeta?.pageUrl || null) || context.pageUrl || context.tabUrl || null;
  const source = inferSource(pageUrl || mediaUrl);

  sendProcessStatus(job.id, job.label, "processing", "Running OCR...");
  const result = await sendForwardedToOffscreen<ExtractImageTextResponse>({
    service: "ocr",
    type: "extractImageText",
    payload: { url: mediaUrl },
  });

  const OCR_CONFIDENCE_THRESHOLD = 0.3;
  const hasUsableText =
    result.status === "done" &&
    result.text.trim().length > 0 &&
    (typeof result.confidence !== "number" || result.confidence >= OCR_CONFIDENCE_THRESHOLD);

  const text = hasUsableText ? trimMultilineText(result.text, 12000) : "";
  const firstLine = text.split(/\n+/).find((line) => line.trim()) || "";
  const titleSeed =
    firstLine ||
    domMeta?.altText ||
    domMeta?.titleText ||
    domMeta?.ariaLabel ||
    getFileNameFromUrl(mediaUrl);

  const sourceImageMedia: ItemDocType["media"] = [{
    type: "image",
    originalUrl: mediaUrl,
    storageType: "hotlink",
    altText: domMeta?.altText || undefined,
    titleText: domMeta?.titleText || undefined,
    ariaLabel: domMeta?.ariaLabel || undefined,
    pageUrl: pageUrl || undefined,
    pageTitle: domMeta?.pageTitle || undefined,
    siteName: domMeta?.siteName || undefined,
    faviconUrl: normalizeIconUrl(domMeta?.faviconUrl || null) || context.tabFavIconUrl || undefined,
    width: domMeta?.width || undefined,
    height: domMeta?.height || undefined,
    capturedAt: context.capturedAt,
    ...(hasUsableText
      ? {
          ocr: {
            status: "done" as const,
            text,
            confidence: typeof result.confidence === "number" ? result.confidence : null,
            lineCount: result.lineCount,
            modelVersion: OCR_MODEL_VERSION,
            sourceHash: result.sourceHash,
            extractedAt: context.capturedAt,
            engine: "paddleocr",
          },
        }
      : {}),
  }];

  return {
    primaryUrl: mediaUrl,
    title: hasUsableText
      ? trimText(`Image text · ${titleSeed}`, 80)
      : trimText(titleSeed || `Image · ${getFileNameFromUrl(mediaUrl)}`, 80) || "Image",
    // Extracted OCR must be saved as visible tab text and as OCR provenance.
    // `textContent` feeds notes/snippets immediately; `ocrText` keeps OCR-specific
    // indexing and later media OCR updates from discarding or duplicating it.
    textContent: hasUsableText ? text : "",
    source,
    iconUrl: normalizeIconUrl(domMeta?.faviconUrl || null) || context.tabFavIconUrl || undefined,
    displayImageUrl: mediaUrl,
    media: sourceImageMedia,
    ocrText: hasUsableText ? text : undefined,
    ocrStatus: hasUsableText ? "done" : "skipped",
    ocrConfidence: hasUsableText ? result.confidence : undefined,
    ocrLineCount: hasUsableText ? result.lineCount : undefined,
    ocrModelVersion: hasUsableText ? OCR_MODEL_VERSION : undefined,
    ocrSourceHash: hasUsableText ? result.sourceHash : undefined,
    tags: uniqueList([
      source !== "web" ? source : "",
      hasUsableText ? "image-text" : "image",
      hasUsableText ? "ocr" : "",
      pickHostLabel(context),
    ]),
    shouldFetchMetadata: false,
    isMetaFetched: true,
  };
};

const captureScreenshotMedia = async (
  context: ImportClickContext,
  tab: chrome.tabs.Tab | undefined,
  job: { id: string; label: string },
  itemId: string,
  mode: "visible" | "region" = "visible"
): Promise<{ media?: ItemDocType["media"] }> => {
  let regionSelection: ScreenshotRegionSelection | undefined;

  if (mode === "region") {
    if (typeof OffscreenCanvas === "undefined" || typeof createImageBitmap === "undefined") {
      sendProcessStatus(
        job.id,
        job.label,
        "processing",
        "Area crop is not available in this browser context. Capturing full tab instead."
      );
    } else {
      sendProcessStatus(job.id, job.label, "processing", "Select an area to capture...");
      const regionResult = await selectScreenshotRegion(tab);
      if (regionResult.status === "cancelled") {
        throw new ImportCancelledError("Screenshot area selection cancelled.");
      }
      if (regionResult.status === "selected") {
        regionSelection = regionResult.selection;
      } else {
        sendProcessStatus(
          job.id,
          job.label,
          "processing",
          "Area selection is unavailable on this page. Capturing full tab instead."
        );
      }
    }
  }

  sendProcessStatus(job.id, job.label, "processing", "Capturing screenshot...");
  let captured: { blob: Blob; fileName: string };
  try {
    captured = await captureScreenshotBlob(
      context,
      tab,
      0,
      regionSelection,
      async () => {
        sendProcessStatus(job.id, job.label, "processing", "Screenshot captured. Saving locally...");
        await showBrandedToast(tab, "Screenshot captured. Saving locally...");
      }
    );
  } catch (error) {
    const detail = error instanceof Error ? error.message : "Screenshot capture failed.";
    await showBrandedToast(tab, detail);
    throw error;
  }

  const file = new File([captured.blob], captured.fileName, {
    type: captured.blob.type || "image/png",
    lastModified: context.capturedAt,
  });
  const saved = await saveMediaToOpfs(itemId, file, captured.fileName);

  sendProcessStatus(job.id, job.label, "processing", "Screenshot saved locally.");

  const media: ItemDocType["media"] = [{
    type: "image",
    originalUrl: captured.fileName,
    storageType: "opfs",
    opfsPath: saved.opfsPath,
    altText: context.tabTitle ? `Screenshot of ${context.tabTitle}` : "Screenshot",
    pageUrl: context.pageUrl || context.tabUrl || undefined,
    pageTitle: context.tabTitle || undefined,
    faviconUrl: context.tabFavIconUrl || undefined,
    capturedAt: context.capturedAt,
  }];
  return {
    media,
  };
};
const prepareImportContent = async (
  target: ImportTarget,
  context: ImportClickContext,
  tab: chrome.tabs.Tab | undefined,
  job: { id: string; label: string }
): Promise<PreparedImportContent> => {
  if (target.mode === "shot") {
    const itemId = crypto.randomUUID();
    const resolved = resolveSavePrimaryUrlOrFallback(context, "shot");
    const primaryUrl = resolved.url;
    const screenshot = await captureScreenshotMedia(context, tab, job, itemId, target.screenshotMode || "visible");
    const source = inferSource(primaryUrl);
    return {
      itemId,
      primaryUrl,
      title: createTitle(context, target.mode, primaryUrl),
      textContent: screenshotText(context),
      source,
      iconUrl: context.tabFavIconUrl || undefined,
      media: screenshot.media,
      ocrStatus: "pending",
      ocrModelVersion: "",
      tags: uniqueList([source !== "web" ? source : "", "screenshot", pickHostLabel(context)]),
      shouldFetchMetadata: false,
      isMetaFetched: true,
    };
  }

  // Extract platform-aware content (canonical URL, title, author, media)
  const extracted = await extractContentFromPage(tab, context.linkUrl || context.pageUrl || undefined);

  const kind = resolveSaveContentKind(context);
  if (kind === "text-only") {
    const textOnly = buildTextOnlyContent(context);
    if (textOnly) return textOnly;
  }
  if (kind === "image-only") {
    const imageOnly = await buildImageOnlyContent(context, tab);
    if (imageOnly) return imageOnly;
  }
  if (kind === "video-only") {
    const videoOnly = await buildVideoOnlyContent(context);
    if (videoOnly) return videoOnly;
  }
  if (kind === "audio-only") {
    const audioOnly = await buildAudioOnlyContent(context);
    if (audioOnly) return audioOnly;
  }

  const resolved = resolveSavePrimaryUrlOrFallback(context, "save");
  const primaryUrl = normalizeHttpUrl(extracted?.canonicalUrl || null) || resolved.url;
  const source = inferSource(primaryUrl);
  let media: ItemDocType["media"] | undefined;
  let displayImageUrl: string | undefined;
  
  // Use extracted media if available
  if (extracted?.mediaUrls && extracted.mediaUrls.length > 0) {
    media = extracted.mediaUrls.slice(0, 4).map((m) => ({
      type: m.type,
      originalUrl: m.url,
      storageType: "hotlink" as const,
    }));
    if (extracted.mediaUrls[0].type === "image") {
      displayImageUrl = extracted.thumbnailUrl || extracted.mediaUrls[0].url;
    }
  }

  const extractedThumbnailUrl = normalizeHttpUrl(extracted?.thumbnailUrl || null);
  if (extractedThumbnailUrl) {
    displayImageUrl = displayImageUrl || extractedThumbnailUrl;
    if (!media) {
      media = [{
        type: "image",
        originalUrl: extractedThumbnailUrl,
        storageType: "hotlink" as const,
        pageUrl: primaryUrl,
        capturedAt: context.capturedAt,
      }];
    }
  }
  
  // Otherwise try to upload remote media from context
  if (!media) {
    try {
      const mediaResult = await uploadRemoteMediaIfPresent(context);
      if (mediaResult.upload?.url && mediaResult.mediaType) {
        media = [{
          type: mediaResult.mediaType,
          originalUrl: mediaResult.originalUrl || primaryUrl,
          storageType: "s3",
          s3Url: mediaResult.upload.url,
        }];
        if (mediaResult.mediaType === "image") displayImageUrl = mediaResult.upload.url || undefined;
      }
    } catch (error) {
      const detail = error instanceof Error ? error.message : "Media upload failed.";
      sendProcessStatus(
        job.id,
        job.label,
        "processing",
        `Media upload failed (${detail}). Continuing without media preview.`
      );
    }
  }

  // Fallback: if we have a direct media URL but no media entry, store as hotlink
  if (!media) {
    const directMediaUrl = context.mediaUrl || (looksLikeMediaUrl(context.linkUrl) ? context.linkUrl : null);
    const directMediaType = resolveMediaType(context.mediaType, directMediaUrl);
    if (directMediaUrl && directMediaType) {
      media = [{
        type: directMediaType,
        originalUrl: directMediaUrl,
        storageType: "hotlink",
        pageUrl: resolveSavePrimaryUrl(context) || undefined,
        capturedAt: context.capturedAt,
      }];
      if (directMediaType === "image") displayImageUrl = directMediaUrl;
    }
  }

  // Use extracted content for title, description, author
  const title = extracted?.title || createTitle(context, target.mode, primaryUrl);
  const textContent = extracted?.description || contextText(context, target.mode);
  const shouldFetchMetadata = isMetadataFetchablePageUrl(primaryUrl);

  return {
    itemId: crypto.randomUUID(),
    primaryUrl,
    title,
    textContent,
    source,
    iconUrl: context.tabFavIconUrl || undefined,
    displayImageUrl,
    media,
    tags: suggestedTags(context, source),
    shouldFetchMetadata,
    isMetaFetched: !shouldFetchMetadata,
    archiveUrl: primaryUrl,
    liveArchiveUrl: resolveLiveArchiveUrl(context, tab),
  };
};

const toItemPayload = (params: {
  id?: string;
  context: ImportClickContext;
  mode: ImportMode;
  primaryUrl: string;
  folderId: string;
  parentId: string | null;
  title?: string;
  textContent?: string;
  source?: ItemDocType["source"];
  iconUrl?: string;
  displayImageUrl?: string;
  media?: ItemDocType["media"];
  ocrText?: string;
  ocrStatus?: ItemDocType["ocrStatus"];
  ocrConfidence?: number;
  ocrLineCount?: number;
  ocrModelVersion?: string;
  ocrSourceHash?: string;
  shouldFetchMetadata?: boolean;
  isMetaFetched?: boolean;
  deferBackgroundProcessing?: boolean;
}) => ({
  id: params.id,
  folderId: params.folderId,
  url: params.primaryUrl,
  title: params.title || createTitle(params.context, params.mode, params.primaryUrl),
  textContent: params.textContent ?? contextText(params.context, params.mode),
  source: params.source || inferSource(params.primaryUrl),
  iconUrl: params.iconUrl,
  displayImageUrl: params.displayImageUrl,
  media: params.media,
  ocrText: params.ocrText,
  ocrStatus: params.ocrStatus,
  ocrConfidence: params.ocrConfidence,
  ocrLineCount: params.ocrLineCount,
  ocrModelVersion: params.ocrModelVersion,
  ocrSourceHash: params.ocrSourceHash,
  parentId: params.parentId,
  chunkOrder: params.context.capturedAt,
  allowLockedPrivateWrite: true,
  isMetaFetched: params.isMetaFetched ?? false,
  shouldFetchMetadata: params.shouldFetchMetadata ?? true,
  deferBackgroundProcessing: params.deferBackgroundProcessing === true,
  isDirty: true,
  createdAt: params.context.capturedAt,
  updatedAt: params.context.capturedAt,
});

const resolveTargetFolder = async (
  target: { spaceId: string; folderId?: string; newFolderName?: string },
  context: ImportClickContext,
  mode: ImportMode
) => {
  const folderId = (target.folderId || "").trim();
  if (folderId) return folderId;
  const created = await sendForwardedToOffscreen<FolderDocType>({
    service: "folders",
    type: "create",
    payload: {
      name: (target.newFolderName || "").trim() || autoFolderName(context, mode),
      userId: "",
      spaceId: target.spaceId || PUBLIC_SPACE_ID,
      allowLockedPrivateWrite: true,
    },
  });
  if (!created?.id) throw new Error("Could not create destination folder.");
  return created.id;
};

const recordFolderToLru = async (
  folderId: string,
  fallbackSpaceId: string,
  fallbackName?: string
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
        { id: folder.id, spaceId: folder.spaceId, name: folder.name || fallbackName || "Folder" },
        spaceName
      )
    );
  } catch (error) {
    void error;
  }
};

const resolveQuickSaveTarget = async (
  target: ImportTarget,
  context: ImportClickContext,
  mode: ImportMode
): Promise<{ folderId: string; spaceId: string }> => {
  const requestedFolder = target.folderId
    ? await resolveFreshLiveImportFolder(target.folderId)
    : null;
  const lru = requestedFolder ? [] : await pruneLruFolders();
  const selectedFolder = selectQuickSaveFolderTarget(requestedFolder, lru);
  if (selectedFolder) {
    return { folderId: selectedFolder.folderId, spaceId: selectedFolder.spaceId };
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
    { spaceId: fallbackSpaceId, folderId: undefined, newFolderName: autoFolderName(context, mode) },
    context,
    mode
  );
  return { folderId, spaceId: fallbackSpaceId };
};

let menuRefreshTimer: ReturnType<typeof setTimeout> | null = null;
let menuRefreshRunning = false;
let menuRefreshQueued = false;
let lastMenuRefreshAt = 0;

const loadImportTargets = async () => {
  try {
    const payload = await sendForwardedToOffscreen<ImportTargetSpace[]>({
      service: "dbManager",
      type: "getImportTargets",
      payload: { maxSpaces: 0, maxFoldersPerSpace: 0, maxItemsPerFolder: 0 },
    });
    return Array.isArray(payload) ? payload : [];
  } catch {
    return [] as ImportTargetSpace[];
  }
};
const refreshContextMenus = async () => {
  if (menuRefreshRunning) {
    menuRefreshQueued = true;
    return;
  }
  menuRefreshRunning = true;
  menuRefreshQueued = false;
  try {
    await new Promise<void>((resolve) => chrome.contextMenus.removeAll(() => resolve()));
    const add = (options: chrome.contextMenus.CreateProperties) =>
      new Promise<void>((resolve) => {
        chrome.contextMenus.create(options, () => {
          if (chrome.runtime.lastError) {
            console.warn("[ContextMenu] create failed:", chrome.runtime.lastError.message, options.id);
          }
          resolve();
        });
      });

    await add({ id: MENU_ROOT_ID, title: "VibeSearch", contexts: IMPORT_CONTEXTS });
    
    // Content-aware primary actions
    await add({ 
      id: MENU_SAVE_IMAGE_ID, 
      parentId: MENU_ROOT_ID, 
      title: "Save image", 
      contexts: [chrome.contextMenus.ContextType.IMAGE] 
    });
    await add({
      id: MENU_EXTRACT_TEXT_ID,
      parentId: MENU_ROOT_ID,
      title: "Extract text from image",
      contexts: [chrome.contextMenus.ContextType.IMAGE]
    });
    await add({ 
      id: MENU_SAVE_VIDEO_ID, 
      parentId: MENU_ROOT_ID, 
      title: "Save video", 
      contexts: [chrome.contextMenus.ContextType.VIDEO] 
    });
    await add({ 
      id: MENU_SAVE_LINK_ID, 
      parentId: MENU_ROOT_ID, 
      title: "Save link", 
      contexts: [chrome.contextMenus.ContextType.LINK] 
    });
    await add({ 
      id: MENU_SAVE_SELECTION_ID, 
      parentId: MENU_ROOT_ID, 
      title: "Save quote", 
      contexts: [chrome.contextMenus.ContextType.SELECTION] 
    });
    await add({ 
      id: MENU_SAVE_PAGE_ID, 
      parentId: MENU_ROOT_ID, 
      title: "Save this page", 
      contexts: [chrome.contextMenus.ContextType.PAGE, chrome.contextMenus.ContextType.FRAME] 
    });
    await add({
      id: MENU_SAVE_SNAPSHOT_ID,
      parentId: MENU_ROOT_ID,
      title: "Archive full-page snapshot",
      contexts: [chrome.contextMenus.ContextType.PAGE, chrome.contextMenus.ContextType.FRAME],
    });
    await add({
      id: MENU_IMPORT_SHARED_ID,
      parentId: MENU_ROOT_ID,
      title: "Import shared VibeSearch link",
      contexts: IMPORT_CONTEXTS,
    });

    // Screenshot submenu
    await add({ id: `${MENU_ROOT_ID}:sep:shot`, parentId: MENU_ROOT_ID, type: "separator", contexts: IMPORT_CONTEXTS });
    await add({ 
      id: MENU_SHOT_VISIBLE_ID, 
      parentId: MENU_ROOT_ID, 
      title: "Screenshot visible area", 
      contexts: IMPORT_CONTEXTS 
    });
    await add({ 
      id: MENU_SHOT_REGION_ID, 
      parentId: MENU_ROOT_ID, 
      title: "Screenshot a region", 
      contexts: IMPORT_CONTEXTS 
    });

    // Save to… submenu (spaces/folders)
    await add({ id: `${MENU_ROOT_ID}:sep:targets`, parentId: MENU_ROOT_ID, type: "separator", contexts: IMPORT_CONTEXTS });
    await add({ id: MENU_SAVE_TARGETS_ID, parentId: MENU_ROOT_ID, title: "Save this link to…", contexts: IMPORT_CONTEXTS });

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
      await add({ id: `${MENU_ROOT_ID}:sep:lru`, parentId: root, type: "separator", contexts: IMPORT_CONTEXTS });
    }

    const spaces = await loadImportTargets();
    for (const space of spaces) {
      const spaceNodeId = `vs:node:save:space:${space.id}`;
      await add({
        id: spaceNodeId,
        parentId: root,
        title: trimText(space.isPrivate && !space.isUnlocked ? `${space.name} (locked)` : space.name, 60),
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

    await add({ id: `${MENU_ROOT_ID}:sep:extract`, parentId: MENU_ROOT_ID, type: "separator", contexts: [chrome.contextMenus.ContextType.IMAGE] });
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
        title: trimText(space.isPrivate && !space.isUnlocked ? `${space.name} (locked)` : space.name, 60),
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

    await add({ id: `${MENU_ROOT_ID}:sep:2`, parentId: MENU_ROOT_ID, type: "separator", contexts: IMPORT_CONTEXTS });
    await add({ id: MENU_OPEN_SEARCH_ID, parentId: MENU_ROOT_ID, title: "Open VibeSearch", contexts: IMPORT_CONTEXTS });
  } catch (error) {
    console.error("[Background] Failed to refresh context menus:", error);
  } finally {
    menuRefreshRunning = false;
    lastMenuRefreshAt = Date.now();
    if (menuRefreshQueued) void refreshContextMenus();
  }
};
const scheduleContextMenuRefresh = (priority: "high" | "low" = "low") => {
  if (menuRefreshTimer) clearTimeout(menuRefreshTimer);
  const now = Date.now();
  const elapsed = now - lastMenuRefreshAt;
  const minGapDelay = Math.max(0, MENU_REFRESH_MIN_INTERVAL_MS - elapsed);
  const baseDelay =
    priority === "high" ? MENU_REFRESH_DEBOUNCE_MS : MENU_REFRESH_LOW_PRIORITY_DEBOUNCE_MS;
  const delay = priority === "high" ? baseDelay : Math.max(baseDelay, minGapDelay);
  menuRefreshTimer = setTimeout(() => {
    menuRefreshTimer = null;
    void refreshContextMenus();
  }, delay);
};

const createDraftFromAction = async (
  target: ImportTarget,
  context: ImportClickContext,
  tab: chrome.tabs.Tab | undefined,
  job: { id: string; label: string }
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
      newFolderName: target.folderId ? undefined : autoFolderName(context, target.mode),
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
      sendProcessStatus(`archive-${draft.itemId}`, "Offline preview", "error", "Could not queue this preview.");
    });
  }
  return draft;
};

const openDraftEditor = async (draftId: string) => {
  const url = new URL(chrome.runtime.getURL("src/pages/popup/index.html"));
  url.searchParams.set("mode", "import");
  url.searchParams.set("draftId", draftId);
  await chrome.windows.create({ url: url.toString(), type: "popup", width: 500, height: 760, focused: true });
};

const runImportActionImpl = async (
  target: ImportTarget,
  context: ImportClickContext,
  tab?: chrome.tabs.Tab
) => {
  const job = createImportJob(target.mode, context);
  sendProcessStatus(job.id, job.label, "processing", "Queued...");
  const settings = await getImportSettings();

  if (settings.reviewBeforeSave) {
    sendProcessStatus(job.id, job.label, "processing", "Preparing draft...");
    const draft = await createDraftFromAction(target, context, tab, job);
    await openDraftEditor(draft.id);
    sendProcessStatus(job.id, job.label, "success", "Draft ready. Review and save.");
    return;
  }

  sendProcessStatus(job.id, job.label, "processing", "Preparing import...");

  const prepared = await prepareImportContent(target, context, tab, job);

  // Save immediately to the resolved destination so the quick-save stays one
  // click — no action required. When the user didn't pick an explicit folder we
  // additionally surface a destination picker that *re-files* the saved item if
  // they choose to; taking no action just leaves it where it landed.
  sendProcessStatus(job.id, job.label, "processing", "Resolving destination...");
  const { folderId, spaceId } = await resolveQuickSaveTarget(target, context, target.mode);

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
      sendProcessStatus(`archive-${inserted.id}`, "Offline preview", "error", "Could not queue this preview.");
    });
  }

  // Saved images (right-click → save image, image links, etc.) are OCR'd like
  // screenshots so their text becomes searchable; OCR then re-embeds them. The
  // explicit per-item trigger is reliable even in a large library.
  if (
    prepared.ocrStatus !== "done" &&
    (prepared.media || []).some((entry) => entry?.type === "image")
  ) {
    void forwardProcessingTriggerToOffscreen("TRIGGER_OCR", { itemId: inserted.id }).catch(
      (error) => console.warn("[Import] Failed to start OCR for saved image.", error)
    );
  }

  await recordFolderToLru(folderId, spaceId, autoFolderName(context, target.mode));
  sendProcessStatus(job.id, job.label, "success", "Imported.");
  scheduleContextMenuRefresh("low");

  const savedActions = [
    { label: "Undo", action: "UNDO_SAVE", payload: { primaryUrl: prepared.primaryUrl, itemId: inserted.id } },
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
  await showDestinationPickerToast(tab, "Saved — move to…?", spaces, "MOVE_SAVED_ITEM", {
    itemId: inserted.id,
    primaryUrl: prepared.primaryUrl,
  });
};

const runImportAction = (
  target: ImportTarget,
  context: ImportClickContext,
  tab?: chrome.tabs.Tab,
) => runBackgroundDataJob(() => runImportActionImpl(target, context, tab));

// Re-file an already-saved item into a folder chosen from the post-save picker.
// The item was saved immediately, so this is an optional correction — it never
// blocks the original one-click save.
const moveSavedItemToFolder = async (
  itemId: string,
  folderId: string,
  tab?: chrome.tabs.Tab
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
      3000
    );
  } catch (error) {
    const detail = error instanceof Error ? error.message : "Could not move the saved item.";
    await showBrandedToast(tab, detail);
  }
};

const scheduleScreenshotPostImportWork = (itemId: string, pageUrl: string): void => {
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
  tab?: chrome.tabs.Tab
) => {
  const job = createImportJob("extract", context);
  sendProcessStatus(job.id, job.label, "processing", "Resolving destination...");

  const { folderId, spaceId } = await resolveQuickSaveTarget(target, context, "extract");

  const prepared = await buildExtractedImageTextContent(context, tab, job);
  sendProcessStatus(job.id, job.label, "processing", "Saving extracted text...");
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
      { label: "Undo", action: "UNDO_SAVE", payload: { primaryUrl: inserted.url } },
      { label: "Open", action: "OPEN_SEARCH" },
    ],
    5000
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
const PENDING_SCREENSHOT_TTL_MS = 5 * 60 * 1000;

const buildDestinationPickerSpaces = async (): Promise<DestinationPickerSpace[]> => {
  const [targets, lru] = await Promise.all([
    loadImportTargets().catch(() => [] as ImportTargetSpace[]),
    pruneLruFolders(),
  ]);
  const lruByFolder = new Map(lru.map((entry) => [entry.folderId, entry.usedAt]));
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
    .sort((a, b) => (lruSpaceRank.get(b.spaceId) ?? 0) - (lruSpaceRank.get(a.spaceId) ?? 0));
};

const runScreenshotActionImpl = async (
  target: ImportTarget,
  context: ImportClickContext,
  tab?: chrome.tabs.Tab
) => {
  const job = createImportJob("shot", context);
  sendProcessStatus(job.id, job.label, "processing", "Queued...");
  const settings = await getImportSettings();

  if (settings.reviewBeforeSave) {
    sendProcessStatus(job.id, job.label, "processing", "Preparing draft...");
    const draft = await createDraftFromAction(target, context, tab, job);
    await openDraftEditor(draft.id);
    sendProcessStatus(job.id, job.label, "success", "Draft ready. Review and save.");
    return;
  }

  const itemId = crypto.randomUUID();
  const resolved = resolveSavePrimaryUrlOrFallback(context, "shot");
  const primaryUrl = resolved.url;
  const source = inferSource(primaryUrl);

  sendProcessStatus(job.id, job.label, "processing", "Capturing screenshot...");
  let screenshotMedia: { media?: ItemDocType["media"] };
  try {
    screenshotMedia = await captureScreenshotMedia(context, tab, job, itemId, target.screenshotMode || "visible");
  } catch (error) {
    const detail = error instanceof Error ? error.message : "Screenshot capture failed.";
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
    title: createTitle(context, target.extractIntent ? "extract" : "shot", primaryUrl),
    textContent: screenshotText(context),
    source,
    iconUrl: context.tabFavIconUrl || undefined,
    media: screenshotMedia.media,
    ocrStatus: "pending",
    ocrModelVersion: "",
    tags: uniqueList([source !== "web" ? source : "", "screenshot", pickHostLabel(context)]),
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
    await finalizeScreenshotSave(pendingId, "", target.spaceId || PUBLIC_SPACE_ID, {
      preferLru: true,
    });
    return;
  }
  const quickSaveTarget = await resolveQuickSaveFolder();
  const autoSaveTargetLabel = quickSaveTarget?.folderName?.trim() || "a new folder";
  await showDestinationPickerToast(
    tab,
    "Save screenshot to…",
    spaces,
    "SAVE_SCREENSHOT_TO",
    { pendingId },
    {
      allowSpaceDirectSave: true,
      autoSave: { timeoutMs: 5000, targetLabel: autoSaveTargetLabel },
    }
  );
};

const runScreenshotAction = (
  target: ImportTarget,
  context: ImportClickContext,
  tab?: chrome.tabs.Tab,
) => runBackgroundDataJob(() => runScreenshotActionImpl(target, context, tab));

const finalizeScreenshotSave = async (
  pendingId: string,
  folderId: string,
  spaceId: string,
  options: { preferLru?: boolean } = {}
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
        sendProcessStatus(job.id, job.label, "error", "Could not create destination folder.");
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
    void recordFolderToLru(resolvedFolderId, resolvedSpaceId, autoFolderName(context, "shot"));

    sendProcessStatus(job.id, job.label, "success", "Screenshot saved.");
    scheduleContextMenuRefresh("low");
    await showBrandedToast(tab, "Screenshot saved", [
      { label: "Undo", action: "UNDO_SAVE", payload: { primaryUrl: prepared.primaryUrl } },
      { label: "Open", action: "OPEN_SEARCH" },
    ], 4000);
  } catch (error) {
    const detail = error instanceof Error ? error.message : "Failed to save screenshot.";
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
  typeof tab?.id === "number" && /^https?:\/\//i.test(tab?.url || "");

/**
 * Preserve the web-support branch's explicit Archive action while routing it
 * through the bounded page-capture session and durable archive outbox. The
 * former implementation returned a full HTML string through the service worker
 * and duplicated the archive already queued by runImportAction.
 */
const runArchiveSnapshotAction = async (
  context: ImportClickContext,
  tab?: chrome.tabs.Tab
): Promise<void> => {
  const job = {
    id: `archive-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    label: `Archive • ${pickHostLabel(context)}`,
  };

  if (!isArchivableTab(tab)) {
    sendProcessStatus(
      job.id,
      job.label,
      "error",
      "This page can't be archived. Open a normal web page (http/https) and try again."
    );
    await showBrandedToast(tab, "This page can't be archived");
    return;
  }

  sendProcessStatus(job.id, job.label, "processing", "Saving and queuing an offline preview…");
  try {
    await runImportAction({ mode: "save", spaceId: PUBLIC_SPACE_ID }, context, tab);
    sendProcessStatus(job.id, job.label, "success", "Saved; the offline preview is queued.");
  } catch (error) {
    const detail = error instanceof Error ? error.message : "Archiving failed.";
    sendProcessStatus(job.id, job.label, "error", detail);
    await showBrandedToast(tab, `Couldn't archive this page: ${detail}`);
  }
};

const runTargetAction = async (
  target: ImportTarget,
  context: ImportClickContext,
  tab?: chrome.tabs.Tab
) => {
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
const SHARE_WORKER_JSON_BASE = "https://share-worker.watermelons.workers.dev";
const sharePairFromShareUrl = (url: string): string | null => {
  try {
    const { pathname } = new URL(url);
    const viewer = pathname.match(/\/s\/([^/]+?)(?:\.json)?$/);
    if (viewer) return viewer[1];
    const api = pathname.match(/\/v1\/public-shares\/([^/]+?)(?:\/export\.json)?$/);
    if (api) return api[1];
  } catch {
    // fall through to null
  }
  return null;
};
const fetchShareSnapshot = async (url: string): Promise<ShareSnapshotV1> => {
  const normalized = normalizeHttpUrl(url);
  if (!normalized || !isVibeShareUrl(normalized)) throw new Error("INVALID_SHARE_URL");
  // A share link may point at the HTML viewer (e.g. share.watermelons.workers.dev)
  // or the worker. Either way, fetch the snapshot JSON from the worker's export
  // endpoint instead of the viewer's HTML page.
  const pair = sharePairFromShareUrl(normalized);
  const fetchUrl = pair ? `${SHARE_WORKER_JSON_BASE}/s/${pair}.json` : normalized;
  return fetchWithTimeout(
    fetchUrl,
    {
      headers: { Accept: "application/json" },
      credentials: "omit",
      cache: "no-store",
    },
    SHARE_SNAPSHOT_FETCH_TIMEOUT_MS,
    "SHARE_FETCH_TIMEOUT",
    async (response, signal) => {
      if (!response.ok) throw new Error(`SHARE_FETCH_FAILED_${response.status}`);
      let text: string;
      try {
        text = await readBoundedResponseText(response, signal, SHARE_SNAPSHOT_MAX_BYTES);
      } catch (error) {
        if (error instanceof Error && error.message === "GOOGLE_API_RESPONSE_TOO_LARGE") {
          throw new Error("SHARE_SNAPSHOT_TOO_LARGE");
        }
        throw error;
      }
      let body: PublicShareResponse | ShareSnapshotV1;
      try {
        body = JSON.parse(text) as PublicShareResponse | ShareSnapshotV1;
      } catch {
        throw new Error("SHARE_SNAPSHOT_INVALID_JSON");
      }
      if ((body as ShareSnapshotV1).schemaVersion === 1) return body as ShareSnapshotV1;
      if ((body as PublicShareResponse).snapshot?.schemaVersion === 1) {
        return (body as PublicShareResponse).snapshot as ShareSnapshotV1;
      }
      throw new Error("SHARE_SNAPSHOT_MISSING");
    },
  );
};
const importSharedLink = async (url: string, targetSpaceId = PUBLIC_SPACE_ID) => {
  const jobId = `share-import-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  sendProcessStatus(jobId, "Shared link import", "processing", "Fetching shared snapshot...");
  const snapshot = await fetchShareSnapshot(url);
  sendProcessStatus(jobId, "Shared link import", "processing", `Importing ${snapshot.items.length} items...`);
  const result = await sendForwardedToOffscreen({
    service: "dbManager",
    type: "importSharedSnapshot",
    payload: {
      snapshot,
      targetSpaceId,
      rootFolderName: snapshot.title,
    },
  });
  await forwardProcessingTriggerToOffscreen("TRIGGER_EMBEDDING").catch(() => {});
  scheduleContextMenuRefresh("high");
  sendProcessStatus(jobId, "Shared link import", "success", `Imported ${snapshot.items.length} items.`);
  return result;
};
const isSearchPageSender = (sender: chrome.runtime.MessageSender) => {
  const senderUrl = typeof sender.url === "string" ? sender.url : "";
  if (!senderUrl) return false;
  try {
    return new URL(senderUrl).pathname.endsWith(SEARCH_PAGE_PATH);
  } catch {
    return false;
  }
};
const isTrustedExtensionSender = (sender: chrome.runtime.MessageSender) => {
  if (!sender || sender.id !== chrome.runtime.id) return false;
  const senderUrl = typeof sender.url === "string" ? sender.url : "";
  if (!senderUrl) return true;
  try {
    return new URL(senderUrl).href.startsWith(chrome.runtime.getURL(""));
  } catch {
    return false;
  }
};
const isSpaceUnlocked = async (spaceId: string): Promise<boolean> => {
  if (!spaceId || spaceId !== PRIVATE_SPACE_ID) return true;
  try {
    const state = await sendForwardedToOffscreen<{ isUnlocked?: boolean }>({
      service: "spaces",
      type: "getSpaceAccessState",
      payload: { spaceId },
    });
    return state?.isUnlocked === true;
  } catch {
    return false;
  }
};
const filterAccessibleDrafts = async (drafts: ImportDraft[]): Promise<ImportDraft[]> => {
  if (!drafts.some((draft) => draft.target.spaceId === PRIVATE_SPACE_ID)) {
    return drafts;
  }
  const privateUnlocked = await isSpaceUnlocked(PRIVATE_SPACE_ID);
  return drafts.filter((draft) => draft.target.spaceId !== PRIVATE_SPACE_ID || privateUnlocked);
};

const handleImportControlMessage = async (message: any, sender: chrome.runtime.MessageSender) => {
  if (!isTrustedExtensionSender(sender)) return { success: false, error: "UNAUTHORIZED_SENDER" };

  if (message.type === "IMPORT_RETRY_FAILED") {
    const statusId = `${message?.payload?.statusId || ""}`.trim();
    if (!statusId) return { success: false, error: "MISSING_STATUS_ID" };
    const attempt = getFailedImportAttempt(statusId);
    if (!attempt) return { success: false, error: "IMPORT_RETRY_NOT_FOUND" };
    const retryTab = await resolveRetryTab(attempt.tab);
    await runTargetAction(attempt.target, attempt.context, retryTab);
    failedImportAttempts.delete(statusId);
    return { success: true, payload: { retried: true } };
  }

  if (message.type === "IMPORT_GET_SETTINGS") {
    return { success: true, payload: await getImportSettings() };
  }
  if (message.type === "IMPORT_GET_PROCESS_STATUSES") {
    const max = Number(message?.payload?.max || 12);
    return { success: true, payload: listRecentProcessStatuses(max) };
  }
  if (message.type === "IMPORT_SET_SETTINGS") {
    return { success: true, payload: await setImportSettings(importSettingsPatchFromPayload(message?.payload)) };
  }
  if (message.type === "IMPORT_LIST_DRAFTS") {
    const drafts = await filterAccessibleDrafts(await loadDrafts());
    return {
      success: true,
      payload: drafts.map((draft) => ({
        id: draft.id,
        mode: draft.mode,
        title: draft.title,
        host: pickHostLabel(draft.context),
        createdAt: draft.createdAt,
      })),
    };
  }
  if (message.type === "IMPORT_GET_DRAFT") {
    const draftId = typeof message?.payload?.draftId === "string" ? message.payload.draftId : "";
    const [allDrafts, settings, targets] = await Promise.all([
      loadDrafts(),
      getImportSettings(),
      sendForwardedToOffscreen<ImportTargetSpace[]>({
        service: "dbManager",
        type: "getImportTargets",
        payload: { maxSpaces: 14, maxFoldersPerSpace: 40, maxItemsPerFolder: 12 },
      }).catch(() => [] as ImportTargetSpace[]),
    ]);
    const drafts = await filterAccessibleDrafts(allDrafts);
    const draft = draftId
      ? allDrafts.find((entry) => entry.id === draftId) || null
      : drafts[0] || null;
    return { success: true, payload: { draft, settings, targets } };
  }
  if (message.type === "IMPORT_OPEN_EDITOR") {
    const draftId = typeof message?.payload?.draftId === "string" ? message.payload.draftId : "";
    const accessibleDrafts = await filterAccessibleDrafts(await loadDrafts());
    let targetId = draftId;
    if (targetId && !accessibleDrafts.some((draft) => draft.id === targetId)) {
      targetId = "";
    }
    if (!targetId) targetId = accessibleDrafts[0]?.id || "";
    if (!targetId) return { success: false, error: "NO_IMPORT_DRAFTS" };
    await openDraftEditor(targetId);
    return { success: true, payload: { opened: true, draftId: targetId } };
  }
  if (message.type === "IMPORT_DELETE_DRAFT") {
    const draftId = (message?.payload?.draftId || "").trim();
    if (!draftId) return { success: false, error: "MISSING_DRAFT_ID" };
    const drafts = await loadDrafts();
    const removed = drafts.find((entry) => entry.id === draftId);
    await saveDrafts(drafts.filter((entry) => entry.id !== draftId));
    if (removed?.itemId) await markArchiveItemCancelled(removed.itemId);
    return { success: true, payload: { deleted: true } };
  }
  if (message.type === "IMPORT_SUBMIT_DRAFT") {
    const payload = message.payload as ImportDraftSubmitPayload;
    const draftId = (payload?.draftId || "").trim();
    if (!draftId) return { success: false, error: "MISSING_DRAFT_ID" };

    const drafts = await loadDrafts();
    const draft = drafts.find((entry) => entry.id === draftId);
    if (!draft) return { success: false, error: "DRAFT_NOT_FOUND" };

    const primaryUrl = normalizeHttpUrl(payload.url || draft.primaryUrl);
    if (!primaryUrl) return { success: false, error: "INVALID_URL" };
    const originalDraftUrl = normalizeHttpUrl(draft.primaryUrl);
    const didPrimaryUrlChange = !!originalDraftUrl && originalDraftUrl !== primaryUrl;
    const effectiveMedia = didPrimaryUrlChange ? undefined : draft.media;
    const effectiveDisplayImageUrl = didPrimaryUrlChange
      ? undefined
      : payload.displayImageUrl ?? draft.displayImageUrl;
    const effectiveShouldFetchMetadata = didPrimaryUrlChange
      ? isMetadataFetchablePageUrl(primaryUrl)
      : draft.shouldFetchMetadata ?? true;
    const effectiveIsMetaFetched = effectiveShouldFetchMetadata
      ? didPrimaryUrlChange
        ? false
        : draft.isMetaFetched ?? false
      : true;
    const effectiveSource = payload.source || (didPrimaryUrlChange ? inferSource(primaryUrl) : draft.source);

    const spaceId = (payload.spaceId || draft.target.spaceId || PUBLIC_SPACE_ID).trim() || PUBLIC_SPACE_ID;
    let folderId = (payload.folderId || draft.target.folderId || "").trim();
    if (folderId === "__new__" || !folderId) {
      const created = await sendForwardedToOffscreen<FolderDocType>({
        service: "folders",
        type: "create",
        payload: {
          name: (payload.createFolderName || draft.target.newFolderName || autoFolderName(draft.context, draft.mode)).trim(),
          userId: "",
          spaceId,
          allowLockedPrivateWrite: true,
        },
      });
      if (!created?.id) return { success: false, error: "FOLDER_CREATE_FAILED" };
      folderId = created.id;
    }

    const parentId =
      typeof payload.parentId === "string"
        ? payload.parentId || null
        : payload.parentId === null
          ? null
          : folderId === (draft.target.folderId || "")
            ? draft.target.parentId || null
            : null;

    const inserted = await sendForwardedToOffscreen<ItemDocType>({
      service: "items",
      type: "addToFolder",
      payload: toItemPayload({
        id: didPrimaryUrlChange ? undefined : draft.itemId,
        context: draft.context,
        mode: draft.mode,
        primaryUrl,
        folderId,
        parentId,
        title: trimText((payload.title || draft.title || "").trim() || primaryUrl),
        textContent: (payload.textContent ?? draft.textContent ?? "").trim(),
        source: effectiveSource,
        iconUrl: payload.iconUrl ?? draft.iconUrl,
        displayImageUrl: effectiveDisplayImageUrl,
        media: effectiveMedia,
        ocrText: draft.ocrText,
        ocrStatus: draft.ocrStatus,
        ocrConfidence: draft.ocrConfidence,
        ocrLineCount: draft.ocrLineCount,
        ocrModelVersion: draft.ocrModelVersion,
        ocrSourceHash: draft.ocrSourceHash,
        shouldFetchMetadata: effectiveShouldFetchMetadata,
        isMetaFetched: effectiveIsMetaFetched,
        deferBackgroundProcessing: draft.mode === "shot" && !didPrimaryUrlChange,
      }),
    });

    const tags = Array.isArray(payload.tags)
      ? uniqueList(payload.tags)
      : typeof payload.tags === "string"
        ? uniqueList(payload.tags.split(/[,\n]/))
        : uniqueList(draft.tags);

    for (const tagName of tags) {
      await sendForwardedToOffscreen({
        service: "tags",
        type: "addTagToItem",
        payload: { itemId: inserted.id, tagName },
      });
    }

    await saveDrafts(drafts.filter((entry) => entry.id !== draft.id));
    if (draft.archiveUrl) {
      if (didPrimaryUrlChange || (draft.itemId && inserted.id !== draft.itemId)) {
        if (draft.itemId) await markArchiveItemCancelled(draft.itemId);
        cancelledArchiveItems.delete(inserted.id);
        void queueServerArchive(inserted.id, primaryUrl).catch((error) =>
          console.warn("[archive] edited draft preview could not be queued", error),
        );
      } else {
        void triggerArchiveOutboxDrain();
      }
    }
    if (draft.mode === "shot" && !didPrimaryUrlChange) {
      scheduleScreenshotPostImportWork(inserted.id, primaryUrl);
    }
    scheduleContextMenuRefresh("low");
    sendProcessStatus(`import-submit-${Date.now()}`, "Import", "success", "Draft imported.");
    return { success: true, payload: inserted };
  }

  return { success: false, error: "UNSUPPORTED_IMPORT_MESSAGE" };
};
chrome.contextMenus.onClicked.addListener((info, tab) => {
  let attemptedTarget: ImportTarget | null = null;
  let attemptedContext: ImportClickContext | null = null;
  const attemptedTabSnapshot = toTabSnapshot(tab);
  void (async () => {
    const menuId = typeof info.menuItemId === "string" ? info.menuItemId : `${info.menuItemId}`;
    if (menuId === MENU_OPEN_SEARCH_ID) {
      await chrome.tabs.create({ url: chrome.runtime.getURL("src/pages/search/index.html") });
      return;
    }
    const context = collectContext(info, tab);
    attemptedContext = context;

    if (menuId === MENU_IMPORT_SHARED_ID) {
      const sharedUrl = pickSharedUrl(context);
      if (!sharedUrl) throw new Error("No VibeSearch shared link found.");
      await runBackgroundDataJob(() => importSharedLink(sharedUrl, PUBLIC_SPACE_ID));
      return;
    }

    // Full-page offline archive (self-contained, highest-fidelity snapshot).
    if (menuId === MENU_SAVE_SNAPSHOT_ID) {
      await runArchiveSnapshotAction(context, tab);
      return;
    }
    
    // Content-aware primary actions (instant save to Public/auto-folder)
    if (menuId === MENU_SAVE_IMAGE_ID || menuId === MENU_SAVE_VIDEO_ID || 
        menuId === MENU_SAVE_LINK_ID || menuId === MENU_SAVE_SELECTION_ID || 
        menuId === MENU_SAVE_PAGE_ID) {
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
      attemptedTarget = { mode: "shot", spaceId: PUBLIC_SPACE_ID, screenshotMode: "region" };
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

chrome.runtime.onInstalled.addListener((details) => {
  chrome.alarms.create(SYNC_ALARM_NAME, { periodInMinutes: 6 * 60 });
  chrome.alarms.create(CLOUD_SYNC_ALARM_NAME, { periodInMinutes: 15 });
  chrome.alarms.create(EMBEDDING_ALARM_NAME, { periodInMinutes: 5 });
  chrome.alarms.create(METADATA_RETRY_ALARM_NAME, { periodInMinutes: 30 });
  void setupConnectorScheduler();
  chrome.alarms.create(ARCHIVE_OUTBOX_ALARM_NAME, { periodInMinutes: 10 });
  void retryStoredFailedMetadataUrls().catch(() => {});
  void retryPendingLocalMetadataUrls().catch(() => {});
  if (details.reason !== "install") requestBrowserBookmarkResync();
  scheduleContextMenuRefresh("high");
});

chrome.runtime.onStartup.addListener(() => {
  void (async () => {
    if (await recoverInterruptedLocalDataReset()) return;
    await setupOffscreenDocument();
    await chrome.runtime.sendMessage({
      type: "TRIGGER_EMBEDDING",
      target: "offscreen",
      isForwarded: true,
    });
    await retryStoredFailedMetadataUrls();
    await retryPendingLocalMetadataUrls();
    await triggerCloudSync();
    await archiveOutbox.cleanup();
    await reconcileOrphanedOpfsMedia();
    await reconcileArchivedItemsWithDatabase();
    await triggerArchiveOutboxDrain();
    requestBrowserBookmarkResync();
  })().catch(() => {});
  scheduleContextMenuRefresh("high");
});

const onBrowserBookmarkMutation = () => {
  requestBrowserBookmarkResync();
};

registerBrowserBookmarkEvents({
  onMutation: onBrowserBookmarkMutation,
  onImportBegan: () => {
    void browserBookmarkResyncScheduler.onImportBegan();
  },
  onImportEnded: () => {
    void browserBookmarkResyncScheduler.onImportEnded();
  },
});

chrome.alarms.onAlarm.addListener((alarm) => {
  void (async () => {
    if (alarm.name === BROWSER_BOOKMARK_RESYNC_ALARM_NAME) {
      await browserBookmarkResyncScheduler.onFallbackAlarm();
      return;
    }
    await setupOffscreenDocument();
    if (alarm.name === SYNC_ALARM_NAME) {
      await chrome.runtime.sendMessage({
        service: "sync",
        type: "rebuildAndCompact",
        target: "offscreen",
          isForwarded: true,
        });
    } else if (alarm.name === CLOUD_SYNC_ALARM_NAME) {
      await triggerCloudSync();
    } else if (alarm.name === CLOUD_SYNC_CONTINUATION_ALARM_NAME) {
      await triggerCloudSync();
    } else if (alarm.name === EMBEDDING_ALARM_NAME) {
      await chrome.runtime.sendMessage({
        type: "TRIGGER_EMBEDDING",
        target: "offscreen",
        isForwarded: true,
      });
    } else if (alarm.name === METADATA_RETRY_ALARM_NAME) {
      await retryStoredFailedMetadataUrls();
      await retryPendingLocalMetadataUrls();
    } else if (alarm.name === ARCHIVE_OUTBOX_ALARM_NAME || alarm.name === ARCHIVE_OUTBOX_RETRY_ALARM_NAME) {
      await reconcileArchivedItemsWithDatabase();
      await triggerArchiveOutboxDrain();
    } else if (alarm.name === CONNECTOR_SYNC_ALARM || alarm.name === CONNECTOR_CONTINUATION_ALARM) {
      await refreshConnectorCloudAuth();
      await onConnectorAlarm();
    } else if (alarm.name === "opfs-promote-alarm") {
      await Promise.allSettled([triggerOpfsPromotion(), reconcileOrphanedOpfsMedia()]);
    } else if (alarm.name === OPFS_MEDIA_RECONCILE_CONTINUATION_ALARM_NAME) {
      await reconcileOrphanedOpfsMedia();
    }
  })().catch(() => {});
});

const isOnline = (): boolean =>
  typeof navigator !== "undefined" ? navigator.onLine : true;

let cloudSyncInFlight: Promise<void> | null = null;
let cloudSyncRequestVersion = 0;

const scheduleCloudSyncContinuation = async (): Promise<void> => {
  try {
    await chrome.alarms.create(CLOUD_SYNC_CONTINUATION_ALARM_NAME, {
      when: Date.now() + CLOUD_SYNC_CONTINUATION_DELAY_MS,
    });
  } catch (error) {
    console.warn("[cloudSync] continuation alarm was not scheduled", error);
  }
};

const triggerCloudSync = (): Promise<void> => {
  if (!isOnline()) return Promise.resolve();
  cloudSyncRequestVersion += 1;
  if (cloudSyncInFlight) return cloudSyncInFlight;

  const runVersion = cloudSyncRequestVersion;
  const run = (async () => {
    try {
      const result = await sendForwardedToOffscreen({
        service: "cloudSync",
        type: "drain",
        payload: { maxBatches: 10 },
      });
      if (shouldScheduleCloudSyncContinuation(result) || cloudSyncRequestVersion > runVersion) {
        await scheduleCloudSyncContinuation();
      }
    } catch (error) {
      console.warn("[cloudSync] upload skipped", error);
      if (cloudSyncRequestVersion > runVersion) await scheduleCloudSyncContinuation();
    }
  })().finally(() => {
    cloudSyncInFlight = null;
  });
  cloudSyncInFlight = run;
  return run;
};

const OPFS_PROMOTION_SCAN_PAGE_SIZE = 50;
const OPFS_PROMOTION_CLEANUP_FILES_PER_RUN = 700;

type OpfsMediaPromotionPage = {
  items: { id: string; media: NonNullable<ItemDocType["media"]> }[];
  nextCursor: string | null;
  hasMore: boolean;
  scannedCount: number;
};

const promoteOpfsMediaToR2 = async (): Promise<void> => {
  if (!isOnline()) return;
  let afterId = "";
  const cleanupBatch = new BoundedOpfsCleanupBatch(
    OPFS_PROMOTION_CLEANUP_FILES_PER_RUN
  );

  try {
    while (isOnline()) {
      let page: OpfsMediaPromotionPage;
      try {
        page = await sendForwardedToOffscreen<OpfsMediaPromotionPage>({
          service: "items",
          type: "listItemsWithOpfsMedia",
          payload: {
            afterId,
            limit: OPFS_PROMOTION_SCAN_PAGE_SIZE,
          },
        });
      } catch (e) {
        console.error("[promoteOpfsMedia] list failed", e);
        return;
      }
      if (!page) return;

      for (const { id, media } of page.items || []) {
        if (!isOnline()) return;
        const promotions = (
          await mapWithConcurrencyStable(media || [], 2, async (entry) => {
            if (typeof entry?.opfsPath !== "string" || !entry.opfsPath) return null;
            try {
              const uploaded = await uploadOpfsFileToR2(
                entry.opfsPath,
                entry.originalUrl
              );
              if (!uploaded) return null;
              return {
                opfsPath: entry.opfsPath,
                s3Url: uploaded.r2Url,
                sourceIdentity: uploaded.sourceIdentity,
              };
            } catch (e) {
              console.error("[promoteOpfsMedia] upload failed for", entry.opfsPath, e);
              return null;
            }
          })
        ).filter(
          (promotion): promotion is {
            opfsPath: string;
            s3Url: string;
            sourceIdentity: OpfsFileIdentity;
          } => promotion !== null
        );

        if (promotions.length === 0) continue;

        try {
          const result = await sendForwardedToOffscreen<{
            success: boolean;
            promotedOpfsPaths: string[];
            error?: string;
          }>({
            service: "items",
            type: "applyOpfsMediaPromotions",
            payload: { id, promotions },
          });
          if (!result?.success) {
            console.error(
              "[promoteOpfsMedia] conditional commit failed for",
              id,
              result?.error || "UNKNOWN_ERROR"
            );
            continue;
          }
          const promotionByPath = new Map(
            promotions.map((promotion) => [promotion.opfsPath, promotion] as const)
          );
          for (const opfsPath of result.promotedOpfsPaths || []) {
            const promotion = promotionByPath.get(opfsPath);
            if (promotion) {
              cleanupBatch.add({
                opfsPath,
                sourceIdentity: promotion.sourceIdentity,
              });
            }
          }
        } catch (e) {
          console.error("[promoteOpfsMedia] conditional commit failed for", id, e);
        }
      }

      if (!page.hasMore) return;
      const nextCursor = (page.nextCursor || "").trim();
      if (!nextCursor || nextCursor <= afterId) {
        console.error("[promoteOpfsMedia] item scan cursor did not advance");
        return;
      }
      afterId = nextCursor;
    }
  } finally {
    try {
      await cleanupBatch.flush(async (files) => {
        await sendForwardedToOffscreen({
          service: "items",
          type: "deleteUnreferencedOpfsMedia",
          payload: { files },
        });
      });
      if (cleanupBatch.overflowed) {
        console.warn(
          "[promoteOpfsMedia] deferred excess OPFS cleanup to keep the run bounded"
        );
      }
    } catch (e) {
      // Promotion is durable already. Leave local files in place rather than
      // failing the run or deleting without a complete reference scan.
      console.warn("[promoteOpfsMedia] cleanup deferred", e);
    }
  }
};

let opfsPromotionInFlight: Promise<void> | null = null;
let opfsPromotionQueued = false;
const triggerOpfsPromotion = (): Promise<void> => {
  if (!isOnline()) return Promise.resolve();
  opfsPromotionQueued = true;
  if (opfsPromotionInFlight) return opfsPromotionInFlight;

  const promotion = (async () => {
    while (opfsPromotionQueued && isOnline()) {
      opfsPromotionQueued = false;
      await promoteOpfsMediaToR2();
    }
  })()
    .catch((error) => console.error("[promoteOpfsMedia] error", error))
    .finally(() => {
      opfsPromotionInFlight = null;
    });
  opfsPromotionInFlight = promotion;
  return promotion;
};

let opfsMediaReconcileInFlight: Promise<void> | null = null;
const reconcileOrphanedOpfsMedia = (): Promise<void> => {
  if (opfsMediaReconcileInFlight) return opfsMediaReconcileInFlight;
  const run = (async () => {
    const cursorState = await chrome.storage.local.get(OPFS_MEDIA_RECONCILE_CURSOR_KEY);
    const afterId = typeof cursorState[OPFS_MEDIA_RECONCILE_CURSOR_KEY] === "string"
      ? cursorState[OPFS_MEDIA_RECONCILE_CURSOR_KEY]
      : "";
    const result = await sendForwardedToOffscreen<{
      scanned: number;
      deleted: number;
      nextCursor: string | null;
      hasMore: boolean;
    }>({
      service: "items",
      type: "reconcileOrphanedOpfsItemDirectories",
      payload: { afterId, limit: 5_000 },
    });
    if (result.hasMore && result.nextCursor && result.nextCursor > afterId) {
      await chrome.storage.local.set({
        [OPFS_MEDIA_RECONCILE_CURSOR_KEY]: result.nextCursor,
      });
      await chrome.alarms.create(OPFS_MEDIA_RECONCILE_CONTINUATION_ALARM_NAME, {
        when: Date.now() + 1_000,
      });
      return;
    }
    await chrome.storage.local.remove(OPFS_MEDIA_RECONCILE_CURSOR_KEY);
    await chrome.alarms.clear(OPFS_MEDIA_RECONCILE_CONTINUATION_ALARM_NAME);
  })().finally(() => {
    opfsMediaReconcileInFlight = null;
  });
  opfsMediaReconcileInFlight = run;
  return run;
};

type ProcessingTriggerType = "TRIGGER_EMBEDDING" | "TRIGGER_OCR";

const isProcessingTrigger = (type: unknown): type is ProcessingTriggerType =>
  type === "TRIGGER_EMBEDDING" || type === "TRIGGER_OCR";

const forwardProcessingTriggerToOffscreen = async (
  type: ProcessingTriggerType,
  payload?: { itemId?: string; force?: boolean }
): Promise<void> => {
  await setupOffscreenDocument();
  const response = (await chrome.runtime.sendMessage({
    type,
    target: "offscreen",
    isForwarded: true,
    payload,
  })) as OffscreenResponse<unknown>;
  if (!response?.success) throw new Error(response?.error || `${type} failed`);
};

// Attempt repair and promotion on startup. An interrupted user-requested wipe
// takes precedence over every sync/import path and is completed before any of
// them are allowed to start.
void (async () => {
  if (await recoverInterruptedLocalDataReset()) return;
  void triggerOpfsPromotion();
  void triggerCloudSync();
  await setupOffscreenDocument();
  // Staged files can contain a full library, so do not let unrelated cache
  // repair failures prevent their expiry cleanup.
  await cleanupStagedPayloads();
  await Promise.allSettled([
    archiveCache.cleanup(),
    archiveOutbox.cleanup(),
    reconcileOrphanedOpfsMedia(),
  ]);
  await reconcileArchivedItemsWithDatabase();
  await triggerArchiveOutboxDrain();
})().catch(() => {});

// Listen for connectivity regain (service worker context: self)
if (typeof self !== "undefined" && typeof self.addEventListener === "function") {
  self.addEventListener("online", () => {
    void triggerOpfsPromotion();
    void triggerCloudSync();
    void triggerArchiveOutboxDrain();
  });
}

chrome.alarms.create("opfs-promote-alarm", { periodInMinutes: 30 });
chrome.alarms.create(ARCHIVE_OUTBOX_ALARM_NAME, { periodInMinutes: 10 });

chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName === "local" && changes[CLOUD_SYNC_TOKEN_KEY]?.newValue) {
    void triggerArchiveOutboxDrain();
  }
});

chrome.tabs.onRemoved.addListener((tabId) => {
  hoverSaveTargetsByTab.delete(tabId);
});

// Open VibeSearch on the new-tab page when enabled (Settings → Misc). A
// background redirect (not a manifest override) keeps the native new tab when
// the option is off.
chrome.tabs.onCreated.addListener((tab) => {
  try {
    const url = tab.pendingUrl || tab.url || "";
    if (!/^chrome:\/\/newtab\/?$/.test(url)) return;
    const tabId = tab.id;
    if (typeof tabId !== "number") return;
    chrome.storage.local.get(OPEN_ON_NEW_TAB_STORAGE_KEY, (result) => {
      if (result?.[OPEN_ON_NEW_TAB_STORAGE_KEY] !== true) return;
      void chrome.tabs.update(tabId, {
        url: chrome.runtime.getURL("src/pages/search/index.html"),
      });
    });
  } catch {}
});

// Keyboard command shortcuts (Settings → Shortcuts). Reuse the same actions the
// context menu uses so behavior stays identical.
if (chrome.commands?.onCommand) {
  chrome.commands.onCommand.addListener((command) => {
    void (async () => {
      if (command === "quick-save") {
        const tab = await getActiveTab();
        await runTargetAction({ mode: "save", spaceId: PUBLIC_SPACE_ID }, collectContextFromTab(tab), tab);
      } else if (command === "take-screenshot") {
        const tab = await getActiveTab();
        await runTargetAction({ mode: "shot", spaceId: PUBLIC_SPACE_ID }, collectContextFromTab(tab), tab);
      }
    })().catch((error) => {
      console.error("[background] command failed:", command, error);
    });
  });
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  const archiveSenderTabId =
    sender?.id === chrome.runtime.id && typeof sender.tab?.id === "number" ? sender.tab.id : null;
  if (
    message?.target === "background" &&
    CONNECTOR_MESSAGE_TYPES.has(String(message?.type || "")) &&
    (!isTrustedExtensionSender(sender) || !isSearchPageSender(sender))
  ) {
    sendResponse({ ok: false, error: "UNAUTHORIZED_CONTEXT" });
    return true;
  }
  if (
    message?.target === "background" &&
    GOOGLE_WORKSPACE_MESSAGE_TYPES.has(String(message?.type || "")) &&
    (!isTrustedExtensionSender(sender) || !isSearchPageSender(sender))
  ) {
    sendResponse({ success: false, error: "UNAUTHORIZED_CONTEXT" });
    return true;
  }
  if (
    message?.target === "background" &&
    LOCAL_BACKUP_MESSAGE_TYPES.has(String(message?.type || "")) &&
    (!isTrustedExtensionSender(sender) || !isSearchPageSender(sender))
  ) {
    sendResponse({ success: false, error: "UNAUTHORIZED_CONTEXT" });
    return true;
  }
  if (
    message?.target === "background" &&
    NOTION_MESSAGE_TYPES.has(String(message?.type || "")) &&
    (!isTrustedExtensionSender(sender) || !isSearchPageSender(sender))
  ) {
    sendResponse({ success: false, error: "UNAUTHORIZED_CONTEXT" });
    return true;
  }

  if (message?.target === "background" && message?.type === PAGE_ARCHIVE_CHUNK_MESSAGE) {
    if (archiveSenderTabId === null) {
      sendResponse({ success: false, error: "UNAUTHORIZED_ARCHIVE_SENDER" } satisfies ArchiveProtocolResponse);
      return true;
    }
    const sessionId = typeof message?.payload?.sessionId === "string" ? message.payload.sessionId : "";
    const sequence = Number.isSafeInteger(message?.payload?.sequence) ? Number(message.payload.sequence) : -1;
    const chunk = typeof message?.payload?.chunk === "string" ? message.payload.chunk : "";
    if (chunk.length > PAGE_ARCHIVE_CHUNK_CODE_UNITS + 1) {
      sendResponse({ success: false, error: "ARCHIVE_CHUNK_TOO_LARGE" } satisfies ArchiveProtocolResponse);
      return true;
    }
    void archiveCaptureSessions
      .append(sessionId, archiveSenderTabId, sequence, chunk)
      .then((payload) => sendResponse({ success: true, payload } satisfies ArchiveProtocolResponse))
      .catch((error) =>
        sendResponse({
          success: false,
          error: error instanceof Error ? error.message : "ARCHIVE_CHUNK_FAILED",
        } satisfies ArchiveProtocolResponse),
      );
    return true;
  }

  if (message?.target === "background" && message?.type === PAGE_ARCHIVE_FINISH_MESSAGE) {
    if (archiveSenderTabId === null) {
      sendResponse({ success: false, error: "UNAUTHORIZED_ARCHIVE_SENDER" } satisfies ArchiveProtocolResponse);
      return true;
    }
    const sessionId = typeof message?.payload?.sessionId === "string" ? message.payload.sessionId : "";
    const chunkCount = Number.isSafeInteger(message?.payload?.chunkCount) ? Number(message.payload.chunkCount) : -1;
    const capturedUrl = typeof message?.payload?.capturedUrl === "string" ? message.payload.capturedUrl.slice(0, 8192) : "";
    void archiveCaptureSessions
      .finish(sessionId, archiveSenderTabId, { chunkCount, capturedUrl })
      .then((payload) => sendResponse({ success: true, payload } satisfies ArchiveProtocolResponse))
      .catch((error) =>
        sendResponse({
          success: false,
          error: error instanceof Error ? error.message : "ARCHIVE_FINISH_FAILED",
        } satisfies ArchiveProtocolResponse),
      );
    return true;
  }

  if (message?.target === "background" && message?.type === PAGE_ARCHIVE_ABORT_MESSAGE) {
    if (archiveSenderTabId === null) {
      sendResponse({ success: false, error: "UNAUTHORIZED_ARCHIVE_SENDER" } satisfies ArchiveProtocolResponse);
      return true;
    }
    const sessionId = typeof message?.payload?.sessionId === "string" ? message.payload.sessionId : "";
    void archiveCaptureSessions
      .abort(sessionId, archiveSenderTabId)
      .then(() => sendResponse({ success: true } satisfies ArchiveProtocolResponse))
      .catch((error) =>
        sendResponse({
          success: false,
          error: error instanceof Error ? error.message : "ARCHIVE_ABORT_FAILED",
        } satisfies ArchiveProtocolResponse),
      );
    return true;
  }

  if (message?.target === "background" && message?.type === "ARCHIVE_ITEMS_PURGED") {
    if (!isTrustedExtensionSender(sender)) {
      sendResponse({ success: false, error: "UNAUTHORIZED_CONTEXT" });
      return true;
    }
    const itemIds = Array.isArray(message?.payload?.itemIds)
      ? message.payload.itemIds
          .filter((itemId: unknown): itemId is string => typeof itemId === "string")
          .slice(0, 2_000)
      : [];
    void purgeArchivedItems(itemIds)
      .then(() => sendResponse({ success: true }))
      .catch((error) => sendResponse({
        success: false,
        error: error instanceof Error ? error.message : "Archive cleanup failed",
      }));
    return true;
  }

  if (message?.target === "background" && message?.type === "OPFS_MEDIA_RECONCILE_REQUESTED") {
    if (!isTrustedExtensionSender(sender)) {
      sendResponse({ success: false, error: "UNAUTHORIZED_CONTEXT" });
      return true;
    }
    void reconcileOrphanedOpfsMedia()
      .then(() => sendResponse({ success: true }))
      .catch((error) => sendResponse({
        success: false,
        error: error instanceof Error ? error.message : "OPFS media reconciliation failed",
      }));
    return true;
  }

  if (message?.target === "background" && message?.type === "DELETE_ALL_LOCAL_DATA") {
    if (!isTrustedExtensionSender(sender) || !isSearchPageSender(sender)) {
      sendResponse({ success: false, error: "UNAUTHORIZED_CONTEXT" });
      return true;
    }
    void deleteAllLocalDataOrchestrated()
      .then((payload) => sendResponse({ success: true, payload }))
      .catch((error) => sendResponse({
        success: false,
        error: error instanceof Error ? error.message : "Delete all data failed",
      }));
    return true;
  }

  if (message?.target === "background" && message?.type === "CLOUD_SYNC_QUEUED") {
    if (isTrustedExtensionSender(sender)) {
      void triggerCloudSync().then(() => triggerArchiveOutboxDrain());
    }
    return;
  }

  if (message?.target === "background" && message?.type === "HOVER_SAVE_TARGET") {
    const tabId = sender.tab?.id;
    const url = normalizeHttpUrl(typeof message?.payload?.url === "string" ? message.payload.url : null);
    const title = typeof message?.payload?.title === "string" ? message.payload.title : undefined;
    if (sender.id === chrome.runtime.id && typeof tabId === "number" && url) {
      rememberHoverSaveTarget(tabId, url, title);
    }
    return;
  }

  if (message?.target === "background" && message?.type === "FETCH_METADATA") {
    const { urls, revalidate } = message.payload || { urls: [], revalidate: false };
    scheduleForProcessing(urls, revalidate === true);
    return;
  }

  if (message?.target === "background" && message?.type === "IMPORT_SHARED_LINK_FROM_PAGE") {
    // Triggered by the share-viewer bridge content script. Import the share the
    // visitor is viewing — the URL comes from sender.url (set by Chrome, not the
    // page) and must be a recognized vibe share link.
    const senderUrl = typeof sender.url === "string" ? sender.url : "";
    if (sender.id !== chrome.runtime.id || !isVibeShareUrl(senderUrl)) {
      sendResponse({ success: false, error: "UNAUTHORIZED_SHARE_IMPORT" });
      return true;
    }
    void runBackgroundDataJob(() => importSharedLink(senderUrl, PUBLIC_SPACE_ID))
      .then(() => sendResponse({ success: true }))
      .catch((error) =>
        sendResponse({ success: false, error: error instanceof Error ? error.message : "Share import failed." })
      );
    return true;
  }

  if (message?.target === "background" && message?.type === "IMPORT_BROWSER_BOOKMARKS") {
    if (!isTrustedExtensionSender(sender) || !isSearchPageSender(sender)) {
      sendResponse({ success: false, error: "UNAUTHORIZED_CONTEXT" });
      return true;
    }
    void runBackgroundDataJob(() => importBrowserBookmarks())
      .then((payload) => sendResponse({ success: true, payload }))
      .catch((error) =>
        sendResponse({ success: false, error: error instanceof Error ? error.message : "Browser bookmark import failed." })
      );
    return true;
  }

  if (message?.target === "background" && message?.type === "IMPORT_GITHUB_STARS") {
    if (!isTrustedExtensionSender(sender) || !isSearchPageSender(sender)) {
      sendResponse({ success: false, error: "UNAUTHORIZED_CONTEXT" });
      return true;
    }
    const accessToken = typeof message?.payload?.accessToken === "string" ? message.payload.accessToken : "";
    void runBackgroundDataJob(() => importGitHubStars(accessToken))
      .then((payload) => sendResponse({ success: true, payload }))
      .catch((error) =>
        sendResponse({ success: false, error: error instanceof Error ? error.message : "GitHub stars import failed." })
      );
    return true;
  }

  if (message?.target === "background" && isProcessingTrigger(message?.type)) {
    const triggerPayload = {
      itemId: typeof message?.payload?.itemId === "string" ? message.payload.itemId : undefined,
      force: message?.payload?.force === true,
    };
    void forwardProcessingTriggerToOffscreen(message.type, triggerPayload)
      .then(() => sendResponse({ success: true }))
      .catch((error) =>
        sendResponse({ success: false, error: error instanceof Error ? error.message : String(error) })
      );
    return true;
  }

  if (message?.target === "background" && message?.type === "PROMOTE_OPFS_MEDIA") {
    triggerOpfsPromotion();
    return;
  }

  if (message?.target === "background" && message?.type === "UNDO_SAVE") {
    const primaryUrl = typeof message?.payload?.primaryUrl === "string" ? message.payload.primaryUrl : "";
    const itemId = typeof message?.payload?.itemId === "string" ? message.payload.itemId : "";
    void (async () => {
      if (itemId) await markArchiveItemCancelled(itemId);
      if (primaryUrl) {
        await sendForwardedToOffscreen({
          service: "items",
          type: "deleteByUrl",
          payload: { url: primaryUrl },
        });
      }
    })()
      .then(() => sendResponse({ success: true }))
      .catch((error) =>
        sendResponse({
          success: false,
          error: error instanceof Error ? error.message : "Undo failed.",
        }),
      );
    return true;
  }

  if (message?.target === "background" && message?.type === "OPEN_SEARCH") {
    void chrome.tabs.create({ url: chrome.runtime.getURL("src/pages/search/index.html") });
    return;
  }

  if (message?.target === "background" && message?.type === "SAVE_SCREENSHOT_TO") {
    const pendingId = typeof message?.payload?.pendingId === "string" ? message.payload.pendingId : "";
    const folderId = typeof message?.payload?.folderId === "string" ? message.payload.folderId : "";
    const spaceId = typeof message?.payload?.spaceId === "string" ? message.payload.spaceId : PUBLIC_SPACE_ID;
    const autoSave = message?.payload?.autoSave === true;
    if (pendingId) {
      void finalizeScreenshotSave(pendingId, folderId, spaceId, { preferLru: autoSave });
    }
    return;
  }

  if (message?.target === "background" && message?.type === "MOVE_SAVED_ITEM") {
    const itemId = typeof message?.payload?.itemId === "string" ? message.payload.itemId : "";
    const folderId = typeof message?.payload?.folderId === "string" ? message.payload.folderId : "";
    if (itemId && folderId) {
      void moveSavedItemToFolder(itemId, folderId, sender?.tab);
    }
    return;
  }

  if (message?.target === "background" && message?.type === "QUICK_SAVE_PAGE") {
    void (async () => {
      const tab = await getActiveTab();
      if (!tab?.id) return;
      const context = collectContextFromTab(tab);
      await runImportAction({ mode: "save", spaceId: PUBLIC_SPACE_ID }, context, tab);
    })();
    return;
  }

  if (message?.target === "background" && message?.type === "QUICK_ARCHIVE_PAGE") {
    void (async () => {
      const tab = await getActiveTab();
      if (!tab?.id) return;
      const context = collectContextFromTab(tab);
      await runArchiveSnapshotAction(context, tab);
    })();
    return;
  }

  if (message?.target === "background" && message?.type === "RUN_CONNECTOR_SYNC") {
    const source = String(message?.payload?.source || "");
    const accountId = String(message?.payload?.accountId || "");
    let platform: ConnectorPlatform | null = null;
    if (source) {
      if (!isConnectorPlatform(source)) {
        sendResponse({ ok: false, error: "UNKNOWN_CONNECTOR" });
        return true;
      }
      platform = source;
    }
    const nice = platform ? CONNECTOR_LABELS[platform] : "connectors";
    void (async () => {
      const job = { id: `connector-${source || "all"}-${Date.now()}`, label: `Sync • ${nice}` };
      const report = (detail: string) => {
        console.log(`[Vibesearch · Sync${source ? " · " + nice : ""}] ${detail}`);
        sendProcessStatus(job.id, job.label, "processing", detail);
      };
      report(source ? `Connecting to ${nice}…` : "Syncing your connected accounts…");
      try {
        await refreshConnectorCloudAuth();
        if (platform) {
          const state = accountId
            ? (await listConnectors()).find(
                (entry) => entry.platform === platform && entry.accountId === accountId,
              )
            : await connectConnector(platform);
          if (!state) throw new Error("Connector account not found — reconnect it first.");
          const who = state.handle.startsWith("id:") ? "your account" : `@${state.handle}`;
          report(`Reading saved items for ${who}…`);
          const r = await syncConnector(platform, state.accountId, report);
          sendProcessStatus(
            job.id,
            job.label,
            r.error ? "error" : "success",
            describeConnectorOutcome(who, r),
          );
        } else {
          const results = await syncAllConnected(report);
          const pushed = results.reduce((n, r) => n + r.pushed, 0);
          sendProcessStatus(job.id, job.label, "success", `Synced ${results.length} account${results.length === 1 ? "" : "s"} — ${pushed} new item${pushed === 1 ? "" : "s"} to Vibesearch.`);
        }
        sendResponse({ ok: true });
      } catch (err) {
        sendProcessStatus(job.id, job.label, "error", err instanceof Error ? err.message : "Sync failed.");
        sendResponse({ ok: false });
      }
    })();
    return true;
  }

  if (message?.target === "background" && message?.type === "CANCEL_CONNECTOR_SYNC") {
    const source = String(message?.payload?.source || "");
    if (isConnectorPlatform(source)) cancelConnectorSync(source);
    sendResponse({ ok: true });
    return true;
  }

  if (message?.target === "background" && message?.type === "CONNECTOR_LIST") {
    void (async () => sendResponse({ ok: true, connectors: await listConnectors() }))().catch(() =>
      sendResponse({ ok: false, connectors: [] }),
    );
    return true;
  }

  if (message?.target === "background" && message?.type === "CONNECTOR_CONNECT") {
    void (async () => {
      try {
        const platform = String(message?.payload?.platform || "");
        if (!isConnectorPlatform(platform)) throw new Error("Unknown connector.");
        const state = await connectConnector(platform);
        sendResponse({ ok: true, state });
      } catch (err) {
        sendResponse({ ok: false, error: err instanceof Error ? err.message : "Connect failed." });
      }
    })();
    return true;
  }

  if (message?.target === "background" && message?.type === "CONNECTOR_DISCONNECT") {
    void (async () => {
      const platform = String(message?.payload?.platform || "");
      if (!isConnectorPlatform(platform)) throw new Error("Unknown connector.");
      await disconnectConnector(
        platform,
        String(message?.payload?.accountId),
      );
      sendResponse({ ok: true });
    })().catch(() => sendResponse({ ok: false }));
    return true;
  }

  if (message?.target === "background" && message?.type === "CONNECTOR_SET_AUTOSYNC") {
    void (async () => {
      const platform = String(message?.payload?.platform || "");
      if (!isConnectorPlatform(platform)) throw new Error("Unknown connector.");
      await setConnectorAutoSync(
        platform,
        String(message?.payload?.accountId),
        !!message?.payload?.on,
      );
      sendResponse({ ok: true });
    })().catch(() => sendResponse({ ok: false }));
    return true;
  }

  if (message?.target === "background" && message?.type === "QUICK_SCREENSHOT") {
    const screenshotMode = message?.payload?.mode === "region" ? "region" : "visible";
    void (async () => {
      const tab = await getActiveTab();
      if (!tab?.id) return;
      const context = collectContextFromTab(tab);
      await runScreenshotAction({ mode: "shot", spaceId: PUBLIC_SPACE_ID, screenshotMode }, context, tab);
    })();
    return;
  }

  if (message?.target === "background" && message?.type === "QUICK_EXTRACT_PAGE") {
    void (async () => {
      const tab = await getActiveTab();
      if (!tab?.id) return;
      const context = collectContextFromTab(tab);
      await runScreenshotAction({ mode: "shot", spaceId: PUBLIC_SPACE_ID, screenshotMode: "visible", extractIntent: true }, context, tab);
    })();
    return;
  }

  if (message?.target === "background" && message?.type === "SAVE_PASTED_URL") {
    const url = normalizeHttpUrl(typeof message?.payload?.url === "string" ? message.payload.url.trim() : "");
    if (!url) return;
    void (async () => {
      const context = buildContextFromUrl(url);
      await runImportAction({ mode: "save", spaceId: PUBLIC_SPACE_ID }, context, undefined);
    })();
    return;
  }

  if (message?.target === "background" && message?.type === "SHARE_IMPORT_FROM_URL") {
    void runBackgroundDataJob(async () => {
      const url = normalizeHttpUrl(typeof message?.payload?.url === "string" ? message.payload.url : "");
      if (!url) throw new Error("INVALID_SHARE_URL");
      const targetSpaceId =
        typeof message?.payload?.targetSpaceId === "string" ? message.payload.targetSpaceId : PUBLIC_SPACE_ID;
      const result = await importSharedLink(url, targetSpaceId);
      sendResponse({ success: true, payload: result });
    }).catch((error) =>
      sendResponse({ success: false, error: error instanceof Error ? error.message : "Share import failed" })
    );
    return true;
  }

  if (message?.target === "background" && message?.type === "LOCAL_BACKUP_BUILD_DOWNLOAD") {
    void runBackgroundDataJob(() => sendForwardedToOffscreen({
      service: "dbManager",
      type: "buildLocalExtensionMigrationDownload",
      payload: {},
    }))
      .then((payload) => sendResponse({ success: true, payload }))
      .catch((error) => sendResponse({
        success: false,
        error: error instanceof Error ? error.message : "Local backup export failed",
      }));
    return true;
  }

  if (message?.target === "background" && message?.type === "LOCAL_BACKUP_STAGE_FILE") {
    void runBackgroundDataJob(() => sendForwardedToOffscreen({
      service: "dbManager",
      type: "stageLocalExtensionMigrationFile",
      payload: { fileName: message?.payload?.fileName },
    }))
      .then((payload) => sendResponse({ success: true, payload }))
      .catch((error) => sendResponse({
        success: false,
        error: error instanceof Error ? error.message : "Local backup validation failed",
      }));
    return true;
  }

  if (message?.target === "background" && message?.type === "LOCAL_BACKUP_RESTORE_STAGED") {
    void runBackgroundDataJob(() => sendForwardedToOffscreen({
      service: "dbManager",
      type: "restoreStagedLocalExtensionMigrationBundle",
      payload: { stageId: message?.payload?.stageId },
    }))
      .then((payload) => sendResponse({ success: true, payload }))
      .catch((error) => sendResponse({
        success: false,
        error: error instanceof Error ? error.message : "Local backup restore failed",
      }));
    return true;
  }

  if (message?.target === "background" && message?.type === "GOOGLE_SYNC_STATUS") {
    void getGoogleWorkspaceSyncState()
      .then((payload) => sendResponse({ success: true, payload }))
      .catch((error) =>
        sendResponse({ success: false, error: error instanceof Error ? error.message : "Google sync status failed" })
      );
    return true;
  }

  if (message?.target === "background" && message?.type === "GOOGLE_AUTH_STATUS") {
    void connectGoogleWorkspace({ interactive: false })
      .then((payload) => sendResponse({ success: true, payload }))
      .catch((error) =>
        sendResponse({ success: false, error: error instanceof Error ? error.message : "Google auth status failed" })
      );
    return true;
  }

  if (message?.target === "background" && message?.type === "GOOGLE_AUTH_CONNECT") {
    void connectGoogleWorkspace({ interactive: true })
      .then((payload) => sendResponse({ success: true, payload }))
      .catch((error) =>
        sendResponse({ success: false, error: error instanceof Error ? error.message : "Google connection failed" })
      );
    return true;
  }

  if (message?.target === "background" && message?.type === "GOOGLE_SYNC_CLEAR_AUTH") {
    void clearGoogleWorkspaceAuth()
      .then(() => sendResponse({ success: true, payload: { cleared: true } }))
      .catch((error) =>
        sendResponse({ success: false, error: error instanceof Error ? error.message : "Google auth clear failed" })
      );
    return true;
  }

  if (message?.target === "background" && message?.type === "GOOGLE_BACKUP_LIST") {
    void listGoogleWorkspaceBackups()
      .then((payload) => sendResponse({ success: true, payload }))
      .catch((error) =>
        sendResponse({ success: false, error: error instanceof Error ? error.message : "Google backup listing failed" })
      );
    return true;
  }

  if (message?.target === "background" && message?.type === "GOOGLE_BACKUP_RESTORE") {
    void runBackgroundDataJob(async () => {
      const fileId = typeof message?.payload?.fileId === "string" ? message.payload.fileId : "";
      if (!fileId) throw new Error("GOOGLE_BACKUP_FILE_ID_MISSING");
      sendProcessStatus("google-backup-restore", "Google backup", "processing", "Downloading backup...");
      const backupBlob = await downloadGoogleWorkspaceBackupBlob(fileId);
      const stagedFileName = await stagePayloadFile(backupBlob, "drive-import");
      sendProcessStatus(
        "google-backup-restore",
        "Google backup",
        "processing",
        "Validating and merging the downloaded backup..."
      );
      let payload: unknown;
      try {
        payload = await sendForwardedToOffscreen({
          service: "dbManager",
          type: "mergeBackupSnapshotFile",
          payload: { fileName: stagedFileName },
        });
      } finally {
        await deleteStagedPayloadFile(stagedFileName).catch(() => {});
      }
      scheduleContextMenuRefresh("high");
      sendProcessStatus("google-backup-restore", "Google backup", "success", "Backup merged.");
      sendResponse({ success: true, payload });
    }).catch((error) => {
      const detail = error instanceof Error ? error.message : "Google backup restore failed";
      sendProcessStatus("google-backup-restore", "Google backup", "error", detail);
      sendResponse({ success: false, error: detail });
    });
    return true;
  }

  if (message?.target === "background" && message?.type === "GOOGLE_SYNC_EXPORT_ALL") {
    void runBackgroundDataJob(async () => {
      sendProcessStatus("google-sync", "Google sync", "processing", "Building local export...");
      const staged = await sendForwardedToOffscreen<{
        fileName: string;
        itemCount: number;
        folderCount: number;
      }>({
        service: "dbManager",
        type: "buildExportSnapshotFile",
        payload: { title: "VibeSearch export" },
      });
      const snapshotFile = await takeStagedPayloadFile(staged.fileName);
      sendProcessStatus("google-sync", "Google sync", "processing", `Syncing ${staged.itemCount} items...`);
      const payload = await syncSnapshotFileToGoogleWorkspace(
        snapshotFile,
        { itemCount: staged.itemCount, folderCount: staged.folderCount },
        { interactive: true },
      );
      sendProcessStatus(
        "google-sync",
        "Google backup",
        "success",
        `Backed up ${staged.itemCount} items to Drive.`,
      );
      sendResponse({ success: true, payload });
    }).catch((error) => {
      const detail = error instanceof Error ? error.message : "Google sync failed";
      sendProcessStatus("google-sync", "Google sync", "error", detail);
      sendResponse({ success: false, error: detail });
    });
    return true;
  }

  if (message?.target === "background" && message?.type === "NOTION_AUTH_STATUS") {
    void getNotionConnectionStatus()
      .then((payload) => sendResponse({ success: true, payload }))
      .catch((error) => sendResponse({
        success: false,
        error: error instanceof Error ? error.message : "Notion auth status failed",
      }));
    return true;
  }

  if (message?.target === "background" && message?.type === "NOTION_AUTH_CONNECT") {
    void connectNotion()
      .then((payload) => sendResponse({ success: true, payload }))
      .catch((error) => sendResponse({
        success: false,
        error: error instanceof Error ? error.message : "Notion connection failed",
      }));
    return true;
  }

  if (message?.target === "background" && message?.type === "NOTION_AUTH_DISCONNECT") {
    void disconnectNotion()
      .then(() => sendResponse({ success: true, payload: { disconnected: true } }))
      .catch((error) => sendResponse({
        success: false,
        error: error instanceof Error ? error.message : "Notion disconnect failed",
      }));
    return true;
  }

  if (message?.target === "background" && message?.type === "NOTION_EXPORT_ALL") {
    void runBackgroundDataJob(async () => {
      sendProcessStatus("notion-export", "Notion export", "processing", "Connecting to Notion...");
      const token = await getNotionAccessToken({ interactive: true });
      const page = await createNotionExportPage(token);
      let itemCount = 0;
      let afterId = "";
      try {
        while (true) {
          const batch = await sendForwardedToOffscreen<NotionExportBatch>({
            service: "dbManager",
            type: "getNotionExportBatch",
            payload: { afterId, limit: NOTION_EXPORT_BATCH_SIZE },
          });
          if (batch.items.length === 0) break;
          if (itemCount + batch.items.length > NOTION_EXPORT_MAX_ITEMS) {
            throw new Error("NOTION_EXPORT_ITEM_LIMIT");
          }
          await appendNotionExportItems(token, page.id, batch.items);
          itemCount += batch.items.length;
          sendProcessStatus(
            "notion-export",
            "Notion export",
            "processing",
            `Exported ${itemCount.toLocaleString()} items...`,
          );
          if (!batch.hasMore || !batch.nextCursor) break;
          afterId = batch.nextCursor;
        }
      } catch (error) {
        const detail = error instanceof Error ? error.message : "Notion export failed";
        throw new Error(`${detail}. Partial page: ${page.url}`);
      }
      const payload = { pageId: page.id, pageUrl: page.url, itemCount };
      sendProcessStatus(
        "notion-export",
        "Notion export",
        "success",
        `Exported ${itemCount.toLocaleString()} items.`,
      );
      sendResponse({ success: true, payload });
    }).catch((error) => {
      const detail = error instanceof Error ? error.message : "Notion export failed";
      sendProcessStatus("notion-export", "Notion export", "error", detail);
      sendResponse({ success: false, error: detail });
    });
    return true;
  }

  if (message?.target === "background" && typeof message?.type === "string" && message.type.startsWith("IMPORT_")) {
    void runBackgroundDataJob(() => handleImportControlMessage(message, sender))
      .then((result) => sendResponse(result))
      .catch((error) =>
        sendResponse({ success: false, error: error instanceof Error ? error.message : "Unknown error" })
      );
    return true;
  }

  if (
    message?.type === "DB_CHANGE" &&
    (message.scope === "items" || message.scope === "folders" || message.scope === "spaces")
  ) {
    scheduleContextMenuRefresh(message.scope === "items" ? "low" : "high");
    return;
  }

  if (message?.target !== "offscreen" || message?.isForwarded) {
    return;
  }

  if (!isTrustedExtensionSender(sender)) {
    sendResponse({ success: false, error: "UNAUTHORIZED_SENDER" });
    return true;
  }

  if (isSearchOnlyOffscreenCall(message) && !isSearchPageSender(sender)) {
    sendResponse({ success: false, error: "UNAUTHORIZED_CONTEXT" });
    return true;
  }

  if (isInternalOnlyOffscreenCall(message)) {
    sendResponse({ success: false, error: "UNAUTHORIZED_CONTEXT" });
    return true;
  }

  if (localDataResetInProgress || localDataResetRecoveryRequired) {
    sendResponse({ success: false, error: "LOCAL_DATA_RESET_IN_PROGRESS" });
    return true;
  }

  const forwardedRequest = trackOffscreenRequest((async () => {
    try {
      if (import.meta.env.MODE === "development" && FORCE_DEV_OFFSCREEN_RESET) {
        try {
          const offscreenApi = (chrome as any)["offscreen"];
          await offscreenApi?.["closeDocument"]?.();
        } catch {}
      }

      await setupOffscreenDocument();
      const response = await chrome.runtime.sendMessage({ ...message, isForwarded: true });
      sendResponse(response);
    } catch (error) {
      sendResponse({
        success: false,
        error: error instanceof Error ? error.message : "Unknown error",
      });
    }
  })());
  void forwardedRequest;

  return true;
});

scheduleContextMenuRefresh("high");

console.log("Background script loaded with offscreen routing, context import, and draft review.");
