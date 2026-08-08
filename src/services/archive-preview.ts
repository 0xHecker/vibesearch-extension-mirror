import { getCloudAuthToken } from "./cloud-auth";
import {
  CLOUD_SYNC_API_BASE_KEY,
  DEFAULT_VIBESEARCH_API_BASE,
} from "./cloud-config";
import { getArchiveCache } from "./archive-cache";

/** Matches the API's maximum extension archive size and bounds viewer memory. */
export const ARCHIVE_PREVIEW_MAX_BYTES = 28 * 1024 * 1024;
export const ARCHIVE_PREVIEW_TIMEOUT_MS = 45_000;

/**
 * Defense-in-depth policy for every archived document, including legacy R2
 * objects captured before the API began injecting the shared archive policy.
 */
export const ARCHIVE_PREVIEW_DOCUMENT_CSP =
  "default-src 'none'; base-uri 'none'; form-action 'none'; frame-src 'none'; connect-src 'none'; " +
  "img-src data:; media-src data:; font-src data:; style-src 'unsafe-inline'";

const ARCHIVE_PREVIEW_POLICY_PREFIX =
  `<!doctype html><meta http-equiv="Content-Security-Policy" content="${ARCHIVE_PREVIEW_DOCUMENT_CSP}">` +
  "<style data-vs-archive-viewport>" +
  "html,body{max-width:100%;min-height:100%;}" +
  "img,svg,video,canvas,iframe,embed,object{max-width:100%!important;height:auto!important;}" +
  "audio,video{max-width:100%!important;}" +
  "pre{max-width:100%;white-space:pre-wrap;overflow-wrap:anywhere;}" +
  "</style>";

export type ArchivePreviewErrorCode =
  | "ARCHIVE_PREVIEW_ABORTED"
  | "ARCHIVE_PREVIEW_TIMEOUT"
  | "ARCHIVE_PREVIEW_AUTH_REQUIRED"
  | "ARCHIVE_PREVIEW_NOT_FOUND"
  | "ARCHIVE_PREVIEW_TOO_LARGE"
  | "ARCHIVE_PREVIEW_INVALID_RESPONSE"
  | "ARCHIVE_PREVIEW_HTTP_ERROR"
  | "ARCHIVE_PREVIEW_NETWORK_ERROR";

export class ArchivePreviewError extends Error {
  readonly code: ArchivePreviewErrorCode;
  readonly status?: number;

  constructor(code: ArchivePreviewErrorCode, message: string, status?: number) {
    super(message);
    this.name = "ArchivePreviewError";
    this.code = code;
    this.status = status;
  }
}

export type ArchivePreviewConnection = {
  token: string;
  apiBase: string;
};

export type ArchivePreviewDocument = {
  url: string;
  sourceByteSize: number;
};

export type ArchivePreviewSessionOptions = {
  getConnection?: (forceRefresh: boolean) => Promise<ArchivePreviewConnection>;
  fetcher?: typeof fetch;
  createObjectUrl?: (blob: Blob) => string;
  revokeObjectUrl?: (url: string) => void;
  maxBytes?: number;
  timeoutMs?: number;
  preferFresh?: boolean;
  cache?: {
    get(itemId: string): Promise<Blob | null>;
    put(itemId: string, body: Blob, updatedAt?: number): Promise<unknown>;
    putCloud?(itemId: string, body: Blob, updatedAt?: number): Promise<unknown>;
    putIfAbsent?(itemId: string, body: Blob, updatedAt?: number): Promise<unknown>;
  };
};

const normalizeApiBase = (value: string): string => {
  const parsed = new URL(value);
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw new ArchivePreviewError(
      "ARCHIVE_PREVIEW_INVALID_RESPONSE",
      "The archive service address is invalid.",
    );
  }
  return value.replace(/\/+$/, "");
};

const defaultConnection = async (forceRefresh: boolean): Promise<ArchivePreviewConnection> => {
  const [row, token] = await Promise.all([
    chrome.storage.local
      .get(CLOUD_SYNC_API_BASE_KEY)
      .then((value) => value as Record<string, unknown>)
      .catch((): Record<string, unknown> => ({})),
    getCloudAuthToken(forceRefresh),
  ]);
  const configured = typeof row[CLOUD_SYNC_API_BASE_KEY] === "string"
    ? row[CLOUD_SYNC_API_BASE_KEY].trim()
    : "";
  return {
    token,
    apiBase: normalizeApiBase(configured || DEFAULT_VIBESEARCH_API_BASE),
  };
};

const errorForResponse = (response: Response): ArchivePreviewError => {
  if (response.status === 401 || response.status === 403) {
    return new ArchivePreviewError(
      "ARCHIVE_PREVIEW_AUTH_REQUIRED",
      "Connect your Vibesearch cloud account to open this saved copy.",
      response.status,
    );
  }
  if (response.status === 404) {
    return new ArchivePreviewError(
      "ARCHIVE_PREVIEW_NOT_FOUND",
      "This offline copy is not ready yet. It may still be uploading.",
      response.status,
    );
  }
  if (response.status === 413) {
    return new ArchivePreviewError(
      "ARCHIVE_PREVIEW_TOO_LARGE",
      "This saved copy is too large to preview safely.",
      response.status,
    );
  }
  return new ArchivePreviewError(
    "ARCHIVE_PREVIEW_HTTP_ERROR",
    "The saved copy could not be loaded from cloud storage.",
    response.status,
  );
};

const declaredByteSize = (response: Response): number | null => {
  const raw = response.headers.get("content-length");
  if (!raw) return null;
  const value = Number(raw);
  return Number.isSafeInteger(value) && value >= 0 ? value : null;
};

const readBoundedArchive = async (
  response: Response,
  maxBytes: number,
  signal: AbortSignal,
): Promise<{ parts: BlobPart[]; byteSize: number }> => {
  const declared = declaredByteSize(response);
  if (declared !== null && declared > maxBytes) {
    await response.body?.cancel().catch(() => {});
    throw new ArchivePreviewError(
      "ARCHIVE_PREVIEW_TOO_LARGE",
      "This saved copy is too large to preview safely.",
    );
  }

  if (!response.body) {
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.byteLength > maxBytes) {
      throw new ArchivePreviewError(
        "ARCHIVE_PREVIEW_TOO_LARGE",
        "This saved copy is too large to preview safely.",
      );
    }
    return { parts: [bytes as BlobPart], byteSize: bytes.byteLength };
  }

  const reader = response.body.getReader();
  const parts: BlobPart[] = [];
  let byteSize = 0;
  const cancel = () => {
    void reader.cancel().catch(() => {});
  };
  signal.addEventListener("abort", cancel, { once: true });
  try {
    while (true) {
      if (signal.aborted) throw new DOMException("Aborted", "AbortError");
      const { done, value } = await reader.read();
      if (done) break;
      if (!value?.byteLength) continue;
      byteSize += value.byteLength;
      if (byteSize > maxBytes) {
        await reader.cancel().catch(() => {});
        throw new ArchivePreviewError(
          "ARCHIVE_PREVIEW_TOO_LARGE",
          "This saved copy is too large to preview safely.",
        );
      }
      parts.push(value as BlobPart);
    }
  } finally {
    signal.removeEventListener("abort", cancel);
    reader.releaseLock();
  }
  return { parts, byteSize };
};

const isAbortError = (error: unknown): boolean =>
  error instanceof DOMException
    ? error.name === "AbortError"
    : error instanceof Error && error.name === "AbortError";

/**
 * Owns one preview request and one resulting Blob URL. A session is intentionally
 * single-use so retries cannot retain an older 20+ MiB snapshot by accident.
 */
export class ArchivePreviewSession {
  private readonly getConnection: (forceRefresh: boolean) => Promise<ArchivePreviewConnection>;
  private readonly fetcher: typeof fetch;
  private readonly createObjectUrl: (blob: Blob) => string;
  private readonly revokeObjectUrl: (url: string) => void;
  private readonly maxBytes: number;
  private readonly timeoutMs: number;
  private readonly preferFresh: boolean;
  private readonly cache: NonNullable<ArchivePreviewSessionOptions["cache"]>;
  private readonly controller = new AbortController();
  private objectUrl: string | null = null;
  private timeout: ReturnType<typeof setTimeout> | null = null;
  private active = true;
  private started = false;
  private timedOut = false;

  constructor(options: ArchivePreviewSessionOptions = {}) {
    this.getConnection = options.getConnection ?? defaultConnection;
    this.fetcher = options.fetcher ?? fetch;
    this.createObjectUrl = options.createObjectUrl ?? ((blob) => URL.createObjectURL(blob));
    this.revokeObjectUrl = options.revokeObjectUrl ?? ((url) => URL.revokeObjectURL(url));
    this.maxBytes = Math.max(1, Math.min(
      ARCHIVE_PREVIEW_MAX_BYTES,
      Math.floor(options.maxBytes ?? ARCHIVE_PREVIEW_MAX_BYTES),
    ));
    this.timeoutMs = Math.max(1_000, Math.floor(options.timeoutMs ?? ARCHIVE_PREVIEW_TIMEOUT_MS));
    this.preferFresh = options.preferFresh === true;
    this.cache = options.cache ?? getArchiveCache();
  }

  async load(itemIdRaw: string): Promise<ArchivePreviewDocument> {
    if (this.started || !this.active) {
      throw new ArchivePreviewError("ARCHIVE_PREVIEW_ABORTED", "The archive preview was closed.");
    }
    this.started = true;
    const loadStartedAt = Date.now();
    const itemId = itemIdRaw.trim();
    if (!itemId) {
      throw new ArchivePreviewError(
        "ARCHIVE_PREVIEW_INVALID_RESPONSE",
        "This saved item has no archive identifier.",
      );
    }

    this.timeout = setTimeout(() => {
      this.timedOut = true;
      this.controller.abort();
    }, this.timeoutMs);

    let cachedFallback: Blob | null = null;
    try {
      const cached = await this.cache.get(itemId).catch(() => null);
      cachedFallback = cached;
      this.assertActive();
      if (cached && !this.preferFresh) {
        return this.createDocument(cached, cached.size);
      }

      let connection = await this.getConnection(false);
      this.assertActive();
      let response = await this.request(itemId, connection);

      if (response.status === 401 || response.status === 403) {
        await response.body?.cancel().catch(() => {});
        connection = await this.getConnection(true);
        this.assertActive();
        response = await this.request(itemId, connection);
      }

      if (!response.ok) {
        await response.body?.cancel().catch(() => {});
        throw errorForResponse(response);
      }
      const contentType = response.headers.get("content-type")?.toLowerCase() ?? "";
      if (!contentType.startsWith("text/html") && !contentType.startsWith("application/xhtml+xml")) {
        await response.body?.cancel().catch(() => {});
        throw new ArchivePreviewError(
          "ARCHIVE_PREVIEW_INVALID_RESPONSE",
          "Cloud storage returned an invalid archive document.",
        );
      }

      const { parts, byteSize } = await readBoundedArchive(
        response,
        this.maxBytes,
        this.controller.signal,
      );
      this.assertActive();
      if (byteSize === 0) {
        throw new ArchivePreviewError(
          "ARCHIVE_PREVIEW_INVALID_RESPONSE",
          "The saved copy is empty.",
        );
      }

      const sourceBlob = new Blob(parts, {
        type: contentType.startsWith("application/xhtml+xml")
          ? "application/xhtml+xml"
          : "text/html",
      });
      // A cloud-only/server-captured archive becomes airplane-mode capable the
      // first time it is viewed online. Cache failure must not hide a valid R2
      // response, but a successful write is awaited before reporting success.
      const cacheRemote = this.preferFresh
        ? this.cache.putCloud
          ? this.cache.putCloud(itemId, sourceBlob, loadStartedAt)
          : this.cache.put(itemId, sourceBlob, loadStartedAt)
        : this.cache.putIfAbsent
          ? this.cache.putIfAbsent(itemId, sourceBlob, loadStartedAt)
          : this.cache.put(itemId, sourceBlob, loadStartedAt);
      await cacheRemote.catch((error) => {
        if (typeof chrome !== "undefined") {
          console.warn("[archive-preview] could not retain offline copy", error);
        }
      });
      this.assertActive();
      // A newer local capture may have filled the cache while the cloud read
      // was in flight. Render that authoritative copy instead of briefly
      // showing the older response that putIfAbsent correctly refused.
      const authoritativeBlob = await this.cache.get(itemId).catch(() => null);
      this.assertActive();
      return this.createDocument(
        authoritativeBlob || sourceBlob,
        authoritativeBlob?.size || byteSize,
      );
    } catch (error) {
      if (
        cachedFallback &&
        !this.timedOut &&
        this.active &&
        !this.controller.signal.aborted &&
        !isAbortError(error)
      ) {
        return this.createDocument(cachedFallback, cachedFallback.size);
      }
      if (this.timedOut) {
        throw new ArchivePreviewError(
          "ARCHIVE_PREVIEW_TIMEOUT",
          "The saved copy took too long to load.",
        );
      }
      if (!this.active || this.controller.signal.aborted || isAbortError(error)) {
        throw new ArchivePreviewError("ARCHIVE_PREVIEW_ABORTED", "The archive preview was closed.");
      }
      if (error instanceof ArchivePreviewError) throw error;
      throw new ArchivePreviewError(
        "ARCHIVE_PREVIEW_NETWORK_ERROR",
        "The saved copy could not be reached. Check your connection and try again.",
      );
    } finally {
      if (this.timeout) clearTimeout(this.timeout);
      this.timeout = null;
    }
  }

  dispose(): void {
    if (!this.active) return;
    this.active = false;
    if (this.timeout) clearTimeout(this.timeout);
    this.timeout = null;
    this.controller.abort();
    if (this.objectUrl) this.revokeObjectUrl(this.objectUrl);
    this.objectUrl = null;
  }

  private async request(itemId: string, connection: ArchivePreviewConnection): Promise<Response> {
    const token = connection.token.trim();
    if (!token) {
      throw new ArchivePreviewError(
        "ARCHIVE_PREVIEW_AUTH_REQUIRED",
        "Connect your Vibesearch cloud account to open this saved copy.",
      );
    }
    const apiBase = normalizeApiBase(connection.apiBase.trim());
    return this.fetcher(`${apiBase}/v1/items/${encodeURIComponent(itemId)}/archive`, {
      method: "GET",
      headers: {
        accept: "text/html, application/xhtml+xml",
        authorization: `Bearer ${token}`,
      },
      credentials: "omit",
      cache: "no-store",
      signal: this.controller.signal,
    });
  }

  private createDocument(source: Blob, sourceByteSize: number): ArchivePreviewDocument {
    if (sourceByteSize <= 0) {
      throw new ArchivePreviewError(
        "ARCHIVE_PREVIEW_INVALID_RESPONSE",
        "The saved copy is empty.",
      );
    }
    if (sourceByteSize > this.maxBytes) {
      throw new ArchivePreviewError(
        "ARCHIVE_PREVIEW_TOO_LARGE",
        "This saved copy is too large to preview safely.",
      );
    }
    const blob = new Blob([ARCHIVE_PREVIEW_POLICY_PREFIX, source], {
      type: "text/html; charset=utf-8",
    });
    const objectUrl = this.createObjectUrl(blob);
    if (!this.active || this.controller.signal.aborted) {
      this.revokeObjectUrl(objectUrl);
      this.assertActive();
    }
    this.objectUrl = objectUrl;
    return { url: objectUrl, sourceByteSize };
  }

  private assertActive(): void {
    if (!this.active || this.controller.signal.aborted) {
      throw new ArchivePreviewError("ARCHIVE_PREVIEW_ABORTED", "The archive preview was closed.");
    }
  }
}
