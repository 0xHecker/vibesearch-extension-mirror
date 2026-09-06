import type { ItemDocType } from "@src/schemas/item_schema";
import type { ShareSnapshotV1 } from "@src/services/share-snapshot";

export type OffscreenResponse<T> = {
  success?: boolean;
  payload?: T;
  error?: string;
};
export type ImportMode = "save" | "shot" | "extract";
export type ImportTarget = {
  mode: ImportMode;
  spaceId?: string;
  folderId?: string;
  itemId?: string;
  screenshotMode?: "visible" | "region";
  extractIntent?: boolean;
};
export type ImportRetryAction = "RETRY_IMPORT";
export type ImportClickContext = {
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
export type HoverSaveTarget = {
  url: string;
  title?: string;
  capturedAt: number;
};
export type ImportMediaUpload = { url?: string | null; key?: string };
export type ExtractImageTextResponse = {
  status: "done" | "skipped" | "error";
  text: string;
  confidence?: number;
  lineCount: number;
  sourceHash: string;
  error?: string;
};
export type SaveContentKind =
  | "default"
  | "text-only"
  | "image-only"
  | "video-only"
  | "audio-only";
export type ImageDomMetadata = {
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
export type PreparedImportContent = {
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

export type ScreenshotRegionSelection = {
  x: number;
  y: number;
  width: number;
  height: number;
  viewportWidth: number;
  viewportHeight: number;
};
export type ScreenshotRegionSelectionResult =
  | { status: "selected"; selection: ScreenshotRegionSelection }
  | { status: "cancelled" }
  | { status: "unavailable" };

export type ExtractedContent = {
  canonicalUrl: string;
  title: string;
  author?: string;
  description?: string;
  thumbnailUrl?: string;
  mediaUrls?: Array<{ url: string; type: "image" | "video" | "audio" }>;
  platform: string;
  timestamp?: number;
};

export class ImportCancelledError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ImportCancelledError";
  }
}
export type TabSnapshot = {
  id?: number;
  windowId?: number;
  url?: string;
  title?: string;
};
export type ImportDraft = {
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
  target: {
    spaceId: string;
    folderId?: string;
    parentId?: string | null;
    newFolderName?: string;
  };
};
export type ImportDraftSubmitPayload = {
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
export type FailedImportAttempt = {
  target: ImportTarget;
  context: ImportClickContext;
  tab?: TabSnapshot;
  createdAt: number;
};
export type ProcessStatusRecord = {
  id: string;
  label: string;
  state: "processing" | "success" | "error";
  detail: string;
  retryAction?: string;
  updatedAt: number;
};
export type PublicShareResponse = {
  share?: unknown;
  snapshot?: ShareSnapshotV1;
};
