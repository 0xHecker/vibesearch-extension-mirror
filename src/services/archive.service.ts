/**
 * archive.service.ts
 *
 * Client for the deployed `vibesearch-api` Worker's Wayback-style offline
 * archiving endpoints (all under `/v1`, authenticated with a Firebase-issued
 * ID token as a Bearer credential — the Worker verifies it statelessly against
 * Google's public keys, see docs/architecture/multiplatform-and-cloud.md).
 *
 *   POST /v1/items/:id/archive          → server-side capture
 *   PUT  /v1/items/:id/archive          → upload a raw single-file HTML snapshot
 *   GET  /v1/items/:id/archive[?key=]   → serve a snapshot (hardened CSP)
 *   GET  /v1/items/:id/archive/meta     → { snapshots: BlobRef[] }
 *
 * The API base URL is resolved from `VITE_API_BASE` with a fallback to the live
 * origin (mirrors the `VITE_SHARE_API_BASE` pattern in share.service.ts); the
 * bearer token is read from chrome.storage.local so a sign-in flow can populate
 * it without this module hardcoding anything.
 */

/** A stored blob reference as returned by the archive API. */
export type ArchiveBlobRef = {
  key: string;
  kind: "archive";
  contentType: string;
  byteSize: number;
  hash: string;
  label?: string;
  capturedAt: number;
};

export type ArchiveMetaResponse = { snapshots: ArchiveBlobRef[] };

export type ArchiveStatus = "none" | "pending" | "archived" | "failed";
export type ArchiveSource = "server" | "extension";

const DEFAULT_API_BASE = "https://vibesearch-api.watermelons.workers.dev";

/** Resolve the archive API base URL (env override, then the live default). */
export const resolveArchiveApiBase = (): string => {
  const fromEnv = (import.meta as any)?.env?.VITE_API_BASE;
  const base = typeof fromEnv === "string" && fromEnv.trim() ? fromEnv.trim() : DEFAULT_API_BASE;
  return base.replace(/\/+$/, "");
};

/**
 * chrome.storage.local key holding the Firebase ID token used as the Bearer
 * credential for the cloud API. Populated by the sign-in flow; exported so that
 * flow (and settings UI) can read/write the same key.
 */
export const AUTH_TOKEN_STORAGE_KEY = "vibesearch:firebaseIdToken";

export class ArchiveApiError extends Error {
  code: string;
  status: number;
  constructor(code: string, status: number, message?: string) {
    super(message || code);
    this.name = "ArchiveApiError";
    this.code = code;
    this.status = status;
  }
}

/** Thrown when no (valid) token is available — surfaced to the user as "sign in". */
export class ArchiveAuthError extends ArchiveApiError {
  constructor(message = "Sign in to Vibesearch to archive pages.") {
    super("AUTH_REQUIRED", 401, message);
    this.name = "ArchiveAuthError";
  }
}

export const getStoredAuthToken = async (): Promise<string | null> => {
  try {
    const row = await chrome.storage.local.get(AUTH_TOKEN_STORAGE_KEY);
    const value = row?.[AUTH_TOKEN_STORAGE_KEY];
    return typeof value === "string" && value.trim() ? value.trim() : null;
  } catch {
    return null;
  }
};

export const setStoredAuthToken = async (token: string): Promise<void> => {
  await chrome.storage.local.set({ [AUTH_TOKEN_STORAGE_KEY]: token });
};

export const clearStoredAuthToken = async (): Promise<void> => {
  await chrome.storage.local.remove(AUTH_TOKEN_STORAGE_KEY);
};

const requireAuthToken = async (): Promise<string> => {
  const token = await getStoredAuthToken();
  if (!token) throw new ArchiveAuthError();
  return token;
};

const parseArchiveError = async (response: Response): Promise<ArchiveApiError> => {
  if (response.status === 401 || response.status === 403) {
    return new ArchiveAuthError("Your Vibesearch session expired — sign in again to archive.");
  }
  let code = `HTTP_${response.status}`;
  let message: string | undefined;
  try {
    const body = (await response.json()) as { error?: string; message?: string };
    if (body?.error) code = body.error;
    if (body?.message) message = body.message;
  } catch {
    // non-JSON error body; keep the generic code
  }
  if (response.status === 413) {
    code = code === `HTTP_413` ? "ARCHIVE_TOO_LARGE" : code;
    message = message || "This page is too large to archive.";
  }
  return new ArchiveApiError(code, response.status, message);
};

const archiveEndpoint = (itemId: string, suffix = ""): string =>
  `${resolveArchiveApiBase()}/v1/items/${encodeURIComponent(itemId)}/archive${suffix}`;

/**
 * Upload a raw single-file HTML snapshot for an item (the first-class,
 * highest-fidelity path). The body is the HTML string; content-type text/html.
 */
export const uploadArchiveSnapshot = async (
  itemId: string,
  html: string
): Promise<ArchiveBlobRef | ArchiveMetaResponse | Record<string, unknown>> => {
  if (!itemId) throw new ArchiveApiError("MISSING_ITEM_ID", 400, "Missing item id.");
  if (!html) throw new ArchiveApiError("EMPTY_SNAPSHOT", 400, "Nothing to archive.");
  const token = await requireAuthToken();
  const response = await fetch(archiveEndpoint(itemId), {
    method: "PUT",
    headers: {
      Authorization: `Bearer ${token}`,
      "content-type": "text/html",
    },
    body: html,
  });
  if (!response.ok) throw await parseArchiveError(response);
  try {
    return (await response.json()) as ArchiveBlobRef | ArchiveMetaResponse | Record<string, unknown>;
  } catch {
    return {};
  }
};

/** Ask the server to capture the item's URL itself (fallback capture path). */
export const requestServerArchive = async (
  itemId: string
): Promise<Record<string, unknown>> => {
  if (!itemId) throw new ArchiveApiError("MISSING_ITEM_ID", 400, "Missing item id.");
  const token = await requireAuthToken();
  const response = await fetch(archiveEndpoint(itemId), {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "content-type": "application/json",
    },
    body: "{}",
  });
  if (!response.ok) throw await parseArchiveError(response);
  try {
    return (await response.json()) as Record<string, unknown>;
  } catch {
    return {};
  }
};

/** List the snapshots stored for an item. */
export const getArchiveMeta = async (itemId: string): Promise<ArchiveMetaResponse> => {
  if (!itemId) throw new ArchiveApiError("MISSING_ITEM_ID", 400, "Missing item id.");
  const token = await requireAuthToken();
  const response = await fetch(archiveEndpoint(itemId, "/meta"), {
    method: "GET",
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!response.ok) throw await parseArchiveError(response);
  const data = (await response.json().catch(() => ({ snapshots: [] }))) as ArchiveMetaResponse;
  return { snapshots: Array.isArray(data?.snapshots) ? data.snapshots : [] };
};

/**
 * Build the URL that serves an item's archived snapshot HTML. Pass a `key` to
 * request a specific snapshot; omit it for the latest. (The endpoint itself is
 * authenticated, so this is for opening in an authenticated context.)
 */
export const buildArchiveViewerUrl = (itemId: string, key?: string): string => {
  const url = new URL(archiveEndpoint(itemId));
  if (key) url.searchParams.set("key", key);
  return url.toString();
};
