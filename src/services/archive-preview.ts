import type { CloudConnectionLifetime } from "./cloud-auth";
import { assertCloudConnectionCurrent, CloudConnectionRetiredError, getArchiveCloudConnection } from "./cloud-connection";
import { getArchiveCache } from "./archive-cache";
import { normalizeArchiveItemId } from "./archive-identity";
import {
  readPendingArchiveUpload,
  type PendingArchiveUpload,
} from "./archive-outbox";
import { sanitizeArchivePreviewBlob } from "./archive-preview-sanitizer";

/** Matches the API's maximum extension archive size and bounds viewer memory. */
export const ARCHIVE_PREVIEW_MAX_BYTES = 40 * 1024 * 1024;
export const ARCHIVE_PREVIEW_TIMEOUT_MS = 45_000;

/**
 * Defense-in-depth policy for every archived document, including legacy R2
 * objects captured before the API began injecting the shared archive policy.
 */
export const ARCHIVE_PREVIEW_DOCUMENT_CSP =
  "default-src 'none'; base-uri 'none'; form-action 'none'; frame-src 'none'; connect-src 'none'; " +
  "img-src data:; media-src data:; font-src data:; style-src 'unsafe-inline'";

// iframe sandboxing prevents script/top-level escape but still permits the
// child frame to navigate itself when a user activates a saved link. Making
// the root document inert keeps View a read-only archive surface; the sheet's
// explicit Open live page button is the only network-navigation path.
const ARCHIVE_PREVIEW_VIEWPORT_CSS =
  "html[data-vs-archive-document],html[data-vs-archive-document] body{" +
  "max-width:100%;min-height:100%;overflow-y:auto!important;overscroll-behavior:auto!important;}" +
  "a,area,button,input,select,textarea,[contenteditable]{pointer-events:none!important;}" +
  "img,svg,video,canvas,iframe,embed,object{max-width:100%!important;height:auto!important;}" +
  "audio,video{max-width:100%!important;}" +
  "pre{max-width:100%;white-space:pre-wrap;overflow-wrap:anywhere;}";

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

export type ArchivePreviewConnection = CloudConnectionLifetime & {
  token: string;
  apiBase: string;
  /** Login-less identity: unlocks the anonymous per-device archive namespace. */
  deviceKey?: string;
};

export type ArchivePreviewDocument = {
  url: string;
  sourceByteSize: number;
  capturedAt?: number;
};

export type ArchivePreviewSessionOptions = {
  getConnection?: (forceRefresh: boolean) => Promise<ArchivePreviewConnection>;
  fetcher?: typeof fetch;
  createObjectUrl?: (blob: Blob) => string;
  revokeObjectUrl?: (url: string) => void;
  maxBytes?: number;
  timeoutMs?: number;
  preferFresh?: boolean;
  sanitizeSource?: (source: Blob) => Promise<Blob>;
  /** One bounded repair attempt for legacy items that predate snapshots. */
  recoverMissing?: (itemId: string) => Promise<boolean>;
  cache?: {
    get(itemId: string): Promise<Blob | null>;
    put(itemId: string, body: Blob, updatedAt?: number, assertCurrent?: () => Promise<void>): Promise<unknown>;
    putCloud?(itemId: string, body: Blob, updatedAt?: number, assertCurrent?: () => Promise<void>): Promise<unknown>;
    putIfAbsent?(itemId: string, body: Blob, updatedAt?: number, assertCurrent?: () => Promise<void>): Promise<unknown>;
  };
};

type ArchivePreviewCache = NonNullable<ArchivePreviewSessionOptions["cache"]>;

/**
 * The preview's local source includes both acknowledged cache entries and
 * completed captures that are still queued for upload. Pending bytes win: a
 * deliberate re-capture is newer local intent than an older cloud mirror.
 */
export const createArchivePreviewLocalCache = (
  cache: ArchivePreviewCache,
  readPending?: (itemId: string) => Promise<PendingArchiveUpload | null>,
): ArchivePreviewCache => {
  const pendingReader = readPending ?? (
    typeof chrome === "undefined"
      ? async () => null
      : readPendingArchiveUpload
  );
  return ({
  async get(itemId) {
    try {
      const pending = await pendingReader(itemId);
      if (pending?.body) return pending.body;
    } catch (error) {
      // A transient outbox read must not hide an older but readable cache copy.
      if (typeof console !== "undefined") {
        console.warn("[archive-preview] could not read pending device capture", error);
      }
    }
    return cache.get(itemId);
  },
  put: (itemId, body, updatedAt, assertCurrent) => cache.put(itemId, body, updatedAt, assertCurrent),
  ...(cache.putCloud
    ? { putCloud: (itemId: string, body: Blob, updatedAt?: number, assertCurrent?: () => Promise<void>) => cache.putCloud!(itemId, body, updatedAt, assertCurrent) }
    : {}),
  ...(cache.putIfAbsent
    ? { putIfAbsent: (itemId: string, body: Blob, updatedAt?: number, assertCurrent?: () => Promise<void>) => cache.putIfAbsent!(itemId, body, updatedAt, assertCurrent) }
    : {}),
  });
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

const defaultConnection = getArchiveCloudConnection;

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
      "No snapshot exists yet.",
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

const responseCapturedAt = (response: Response): number | undefined => {
  const raw = response.headers.get("x-vs-archive-captured-at")?.trim() || "";
  if (!raw) return undefined;
  const numeric = Number(raw);
  if (Number.isSafeInteger(numeric) && numeric > 0) return numeric;
  const parsed = Date.parse(raw);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : undefined;
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
  private readonly sanitizeSource: (source: Blob) => Promise<Blob>;
  private readonly recoverMissing?: (itemId: string) => Promise<boolean>;
  private readonly cache: NonNullable<ArchivePreviewSessionOptions["cache"]>;
  private readonly controller = new AbortController();
  private objectUrl: string | null = null;
  private timeout: ReturnType<typeof setTimeout> | null = null;
  private active = true;
  private started = false;
  private timedOut = false;

  constructor(options: ArchivePreviewSessionOptions = {}) {
    this.getConnection = options.getConnection ?? defaultConnection;
    // `fetch` must keep its global receiver: calling a detached reference
    // throws "Illegal invocation" in window contexts.
    this.fetcher = options.fetcher ?? fetch.bind(globalThis);
    this.createObjectUrl = options.createObjectUrl ?? ((blob) => URL.createObjectURL(blob));
    this.revokeObjectUrl = options.revokeObjectUrl ?? ((url) => URL.revokeObjectURL(url));
    this.maxBytes = Math.max(1, Math.min(
      ARCHIVE_PREVIEW_MAX_BYTES,
      Math.floor(options.maxBytes ?? ARCHIVE_PREVIEW_MAX_BYTES),
    ));
    this.timeoutMs = Math.max(1_000, Math.floor(options.timeoutMs ?? ARCHIVE_PREVIEW_TIMEOUT_MS));
    this.preferFresh = options.preferFresh === true;
    this.sanitizeSource = options.sanitizeSource ?? ((source) => sanitizeArchivePreviewBlob(
      source,
      ARCHIVE_PREVIEW_DOCUMENT_CSP,
      ARCHIVE_PREVIEW_VIEWPORT_CSS,
    ));
    this.recoverMissing = options.recoverMissing;
    this.cache = options.cache ?? createArchivePreviewLocalCache(getArchiveCache());
  }

  async load(itemIdRaw: string): Promise<ArchivePreviewDocument> {
    if (this.started || !this.active) {
      throw new ArchivePreviewError("ARCHIVE_PREVIEW_ABORTED", "The archive preview was closed.");
    }
    this.started = true;
    const loadStartedAt = Date.now();
    const itemId = normalizeArchiveItemId(itemIdRaw);
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
      const cached = await this.awaitWhileActive(
        this.cache.get(itemId).catch(() => null),
      );
      cachedFallback = cached;
      this.assertActive();
      if (cached && !this.preferFresh) {
        return await this.createDocument(cached, cached.size, this.localCapturedAt(cached));
      }

      let connection = await this.awaitWhileActive(this.getConnection(false));
      this.assertActive();
      // `null` means cloud storage will not serve this copy to this device —
      // treated below exactly like "no cloud copy exists".
      const cloud = await this.fetchCloudCopy(itemId, connection);
      connection = cloud.connection;
      let response = cloud.response;

      if ((response === null || response.status === 404) && this.recoverMissing) {
        await response?.body?.cancel().catch(() => {});
        const recovered = await this.awaitWhileActive(this.recoverMissing(itemId));
        this.assertActive();
        // Browser capture is authoritative as soon as its OPFS/outbox file is
        // complete. Never wait for a large cloud upload before opening it.
        const recoveredLocal = await this.awaitWhileActive(
          this.cache.get(itemId).catch(() => null),
        );
        this.assertActive();
        if (recoveredLocal) {
          return await this.createDocument(
            recoveredLocal,
            recoveredLocal.size,
            this.localCapturedAt(recoveredLocal),
          );
        }
        if (recovered) response = await this.request(itemId, connection);
      }

      if (!response) {
        throw new ArchivePreviewError(
          "ARCHIVE_PREVIEW_AUTH_REQUIRED",
          "This copy is not on this device, and cloud storage is unavailable without a connected account.",
        );
      }
      if (!response.ok) {
        await response.body?.cancel().catch(() => {});
        throw errorForResponse(response);
      }
      const capturedAt = responseCapturedAt(response);
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
      await this.assertConnectionCurrent(connection);
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
          ? this.cache.putCloud(itemId, sourceBlob, loadStartedAt, () => this.assertConnectionCurrent(connection))
          : this.cache.put(itemId, sourceBlob, loadStartedAt, () => this.assertConnectionCurrent(connection))
        : this.cache.putIfAbsent
          ? this.cache.putIfAbsent(itemId, sourceBlob, loadStartedAt, () => this.assertConnectionCurrent(connection))
          : this.cache.put(itemId, sourceBlob, loadStartedAt, () => this.assertConnectionCurrent(connection));
      await this.awaitWhileActive(
        cacheRemote.catch((error) => {
          if (typeof chrome !== "undefined") {
            console.warn("[archive-preview] could not retain offline copy", error);
          }
        }),
      );
      this.assertActive();
      await this.assertConnectionCurrent(connection);
      // A newer local capture may have filled the cache while the cloud read
      // was in flight. Render that authoritative copy instead of briefly
      // showing the older response that putIfAbsent correctly refused.
      const authoritativeBlob = await this.awaitWhileActive(
        this.cache.get(itemId).catch(() => null),
      );
      this.assertActive();
      await this.assertConnectionCurrent(connection);
      return await this.createDocument(
        authoritativeBlob || sourceBlob,
        authoritativeBlob?.size || byteSize,
        this.localCapturedAt(authoritativeBlob) || capturedAt,
        connection,
      );
    } catch (error) {
      if (
        cachedFallback &&
        !this.timedOut &&
        this.active &&
        !this.controller.signal.aborted &&
        !isAbortError(error)
      ) {
        return await this.createDocument(
          cachedFallback,
          cachedFallback.size,
          this.localCapturedAt(cachedFallback),
        );
      }
      if (this.timedOut) {
        throw new ArchivePreviewError(
          "ARCHIVE_PREVIEW_TIMEOUT",
          "The saved copy took too long to load.",
        );
      }
      if (!this.active || this.controller.signal.aborted || isAbortError(error) || error instanceof CloudConnectionRetiredError) {
        throw new ArchivePreviewError("ARCHIVE_PREVIEW_ABORTED", "The archive preview was closed.");
      }
      if (error instanceof ArchivePreviewError) throw error;
      // Surface the original failure before wrapping it: the generic
      // "check your connection" copy hides auth, storage, and stream errors.
      if (typeof console !== "undefined") {
        console.warn("[archive-preview] load failed with unexpected error:", error);
      }
      throw new ArchivePreviewError(
        "ARCHIVE_PREVIEW_NETWORK_ERROR",
        typeof navigator !== "undefined" && navigator.onLine === false
          ? "You’re offline, and this device has no saved snapshot for this page yet."
          : "The saved copy could not be reached. Check your connection and try again.",
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

  /** `null` when this device holds no credential cloud storage would accept. */
  private async request(
    itemId: string,
    connection: ArchivePreviewConnection,
  ): Promise<Response | null> {
    await this.assertConnectionCurrent(connection);
    const token = connection.token.trim();
    const deviceKey = connection.deviceKey?.trim() ?? "";
    if (!token && !deviceKey) return null;
    const apiBase = normalizeApiBase(connection.apiBase.trim());
    const response = await this.fetcher(`${apiBase}/v1/items/${encodeURIComponent(itemId)}/archive`, {
      method: "GET",
      headers: {
        accept: "text/html, application/xhtml+xml",
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        // Login-less reads resolve to the anonymous per-device namespace; the
        // signed-in token always wins when both exist.
        ...(!token && deviceKey ? { "x-vs-device-key": deviceKey } : {}),
      },
      credentials: "omit",
      cache: "no-store",
      signal: this.controller.signal,
    });
    try { await this.assertConnectionCurrent(connection); }
    catch (error) { await response.body?.cancel().catch(() => {}); throw error; }
    return response;
  }

  /**
   * Ask cloud storage for this item's snapshot.
   *
   * Returns `response: null` when cloud storage will not serve the copy to this
   * device at all — no credential, or a refusal that no identity on this device
   * can satisfy. Callers treat that the same as "no cloud copy exists", because
   * a library that lives on this device should not be gated behind an account.
   *
   * A bearer session gets one refresh: it can come back as a different identity
   * (or as the device key once the session is gone). A device key is stable, so
   * re-asking with it would be refused identically and is skipped.
   */
  private async fetchCloudCopy(
    itemId: string,
    connection: ArchivePreviewConnection,
  ): Promise<{ response: Response | null; connection: ArchivePreviewConnection }> {
    const refused = (response: Response | null): boolean =>
      response !== null && (response.status === 401 || response.status === 403);
    const discard = async (response: Response | null): Promise<null> => {
      await response?.body?.cancel().catch(() => {});
      return null;
    };

    let response = await this.request(itemId, connection);
    if (!refused(response)) return { response, connection };
    await discard(response);
    if (!connection.token) return { response: null, connection };

    const refreshed = await this.awaitWhileActive(this.getConnection(true));
    await this.assertConnectionCurrent(connection);
    await this.assertConnectionCurrent(refreshed);
    this.assertActive();
    const sameIdentity =
      refreshed.token === connection.token && refreshed.deviceKey === connection.deviceKey;
    if (sameIdentity) return { response: null, connection: refreshed };

    response = await this.request(itemId, refreshed);
    if (refused(response)) response = await discard(response);
    return { response, connection: refreshed };
  }

  private async createDocument(
    source: Blob,
    sourceByteSize: number,
    capturedAt?: number,
    connection?: ArchivePreviewConnection,
  ): Promise<ArchivePreviewDocument> {
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
    const blob = await this.awaitWhileActive(this.sanitizeSource(source));
    this.assertActive();
    if (connection) await this.assertConnectionCurrent(connection);
    const objectUrl = this.createObjectUrl(blob);
    if (!this.active || this.controller.signal.aborted || connection?.isCurrent?.() === false) {
      this.revokeObjectUrl(objectUrl);
      this.assertActive();
      throw new CloudConnectionRetiredError();
    }
    this.objectUrl = objectUrl;
    return { url: objectUrl, sourceByteSize, ...(capturedAt ? { capturedAt } : {}) };
  }

  private localCapturedAt(source: Blob | null): number | undefined {
    if (typeof File === "undefined" || !(source instanceof File)) return undefined;
    return Number.isSafeInteger(source.lastModified) && source.lastModified > 0
      ? source.lastModified
      : undefined;
  }

  private assertActive(): void {
    if (!this.active || this.controller.signal.aborted) {
      throw new ArchivePreviewError("ARCHIVE_PREVIEW_ABORTED", "The archive preview was closed.");
    }
  }

  private async assertConnectionCurrent(connection: ArchivePreviewConnection): Promise<void> {
    await assertCloudConnectionCurrent(connection);
    this.assertActive();
  }

  /**
   * OPFS and identity calls do not accept an AbortSignal. Race each one with
   * this session so closing the sheet (or hitting the overall deadline) does
   * not leave a permanently pending load retaining the component/session.
   * The original promise remains observed, so a later rejection cannot become
   * an unhandled rejection.
   */
  private awaitWhileActive<T>(work: Promise<T>): Promise<T> {
    const signal = this.controller.signal;
    if (signal.aborted) {
      return Promise.reject(new DOMException("Aborted", "AbortError"));
    }
    return new Promise<T>((resolve, reject) => {
      let settled = false;
      const finish = (callback: () => void) => {
        if (settled) return;
        settled = true;
        signal.removeEventListener("abort", abort);
        callback();
      };
      const abort = () => finish(() => reject(new DOMException("Aborted", "AbortError")));
      signal.addEventListener("abort", abort, { once: true });
      work.then(
        (value) => finish(() => resolve(value)),
        (error) => finish(() => reject(error)),
      );
    });
  }
}
