export const PAGE_ARCHIVE_CAPTURE_MESSAGE = "VS_PAGE_ARCHIVE_CAPTURE";
export const PAGE_ARCHIVE_CHUNK_MESSAGE = "VS_PAGE_ARCHIVE_CHUNK";
export const PAGE_ARCHIVE_FINISH_MESSAGE = "VS_PAGE_ARCHIVE_FINISH";
export const PAGE_ARCHIVE_ABORT_MESSAGE = "VS_PAGE_ARCHIVE_ABORT";

export const PAGE_ARCHIVE_MAX_HTML_BYTES = 24 * 1024 * 1024;
export const PAGE_ARCHIVE_CHUNK_CODE_UNITS = 256 * 1024;
export const PAGE_ARCHIVE_MAX_RESOURCE_BYTES = 4 * 1024 * 1024;
export const PAGE_ARCHIVE_MAX_RESOURCE_TOTAL_BYTES = 14 * 1024 * 1024;
export const PAGE_ARCHIVE_MAX_RESOURCE_REQUESTS = 96;
export const PAGE_ARCHIVE_RESOURCE_CONCURRENCY = 4;
export const PAGE_ARCHIVE_CAPTURE_TIMEOUT_MS = 45_000;

export type PageArchiveCaptureRequest = {
  type: typeof PAGE_ARCHIVE_CAPTURE_MESSAGE;
  payload: {
    sessionId: string;
    expectedUrl: string;
    deadlineAt: number;
    maxHtmlBytes: number;
  };
};

export type PageArchiveChunkRequest = {
  target: "background";
  type: typeof PAGE_ARCHIVE_CHUNK_MESSAGE;
  payload: {
    sessionId: string;
    sequence: number;
    chunk: string;
  };
};

export type PageArchiveFinishRequest = {
  target: "background";
  type: typeof PAGE_ARCHIVE_FINISH_MESSAGE;
  payload: {
    sessionId: string;
    chunkCount: number;
    capturedUrl: string;
    title: string;
  };
};

export type PageArchiveAbortRequest = {
  target: "background";
  type: typeof PAGE_ARCHIVE_ABORT_MESSAGE;
  payload: {
    sessionId: string;
    reason?: string;
  };
};

export type ArchiveProtocolResponse<T = unknown> = {
  success: boolean;
  payload?: T;
  error?: string;
};
