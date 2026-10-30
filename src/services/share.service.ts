import { buildLocalExportSnapshot } from "@src/services/share-snapshot";
import type { ShareSnapshotV1, ShareSourceKind } from "@src/services/share-snapshot";

/**
 * share.service.ts
 *
 * Owner-side client for the share-worker backend. All endpoints hit
 * the worker over HTTPS with the owner token as Bearer credential.
 * Raw owner token lives in chrome.storage.local (never in RxDB).
 */

const SHARE_WORKER_BASE =
  (import.meta as any).env?.VITE_SHARE_API_BASE ??
  "https://share-worker.shanmukh6789op.workers.dev";

const OWNER_TOKEN_STORAGE_KEY = "shareOwnerToken";
const OWNER_HINT_STORAGE_KEY = "shareOwnerHint";
const OWNER_ID_STORAGE_KEY = "shareOwnerId";

export type ShareOwnerRegistration = {
  ownerId: string;
  tokenHint: string;
  createdAt: number;
};

export type OwnedShareSummary = {
  shareId: string;
  publicUrl: string;
  title: string;
  status: "active" | "revoked";
  sourceKind: ShareSourceKind;
  sourceIds: string[];
  itemCount: number;
  folderCount: number;
  totalViews: number;
  uniqueViewers: number;
  createdAt: number;
  updatedAt: number;
  lastViewedAt: number | null;
  requiresPin?: boolean;
  expiresAt?: number | null;
};

export type OwnedShareListResponse = {
  shares: OwnedShareSummary[];
};

export type OwnedShareDetail = {
  share: OwnedShareSummary & {
    description?: string;
    contentHash?: string;
    latestVersion: number;
  };
  snapshot: ShareSnapshotV1;
  items: Array<{
    title: string;
    url: string;
    domain?: string;
    source: string;
  }>;
  analytics: {
    totalViews: number;
    uniqueViewers: number;
    daily: Array<{ day: string; totalViews: number; uniqueViewers: number }>;
  };
};

export type CreateShareResponse = {
  shareId: string;
  publicUrl: string;
  publicId: string;
  version: number;
  itemCount: number;
  folderCount: number;
  createdAt: number;
  requiresPin?: boolean;
  expiresAt?: number | null;
};

export type UpdateShareSnapshotResponse = {
  shareId: string;
  version: number;
  updatedAt: number;
};

export type RevokeShareResponse = {
  shareId: string;
  status: "revoked";
  revokedAt: number;
};

export type ShareErrorCode =
  | "OWNER_TOKEN_REQUIRED"
  | "OWNER_TOKEN_INVALID"
  | "OWNER_TOKEN_REVOKED"
  | "SHARE_NOT_FOUND"
  | "SHARE_SECRET_INVALID"
  | "SHARE_REVOKED"
  | "SNAPSHOT_TOO_LARGE"
  | "SNAPSHOT_INVALID"
  | "SNAPSHOT_HAS_LOCAL_MEDIA"
  | "PIN_REQUIRED"
  | "PIN_INVALID"
  | "RATE_LIMITED";

export class ShareApiError extends Error {
  code: ShareErrorCode | string;
  status: number;
  constructor(code: ShareErrorCode | string, status: number, message?: string) {
    super(message || code);
    this.name = "ShareApiError";
    this.code = code;
    this.status = status;
  }
}

const isShareApiError = (error: unknown, codes?: ShareErrorCode | ShareErrorCode[]): error is ShareApiError => {
  if (!(error instanceof ShareApiError)) return false;
  if (!codes) return true;
  return Array.isArray(codes) ? codes.includes(error.code as ShareErrorCode) : error.code === codes;
};

const generateOwnerToken = (): string => {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  const b64 = btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
  return `vshr_owner_${b64}`;
};

const readStoredOwnerToken = async (): Promise<string | null> => {
  try {
    const result = await chrome.storage.local.get(OWNER_TOKEN_STORAGE_KEY);
    const value = result?.[OWNER_TOKEN_STORAGE_KEY];
    return typeof value === "string" && value.startsWith("vshr_owner_") ? value : null;
  } catch {
    return null;
  }
};

const writeStoredOwnerToken = async (
  token: string,
  meta: { ownerId: string; tokenHint: string }
): Promise<void> => {
  await chrome.storage.local.set({
    [OWNER_TOKEN_STORAGE_KEY]: token,
    [OWNER_HINT_STORAGE_KEY]: meta.tokenHint,
    [OWNER_ID_STORAGE_KEY]: meta.ownerId,
  });
};

const clearStoredOwnerToken = async (): Promise<void> => {
  await chrome.storage.local.remove([
    OWNER_TOKEN_STORAGE_KEY,
    OWNER_HINT_STORAGE_KEY,
    OWNER_ID_STORAGE_KEY,
  ]);
};

// The public share secret is part of the capability URL and is NEVER stored
// server-side (the worker keeps only a hash), so the owner share list can't
// reconstruct a working link. We remember the real link locally on the device
// that created the share so the "Shared tabs" panel can re-copy/open it.
const SHARE_LINKS_STORAGE_KEY = "shareLinksByShareId";

export const rememberShareLink = async (shareId: string, publicUrl: string): Promise<void> => {
  if (!shareId || !publicUrl || publicUrl.includes("<secret-hidden>")) return;
  try {
    const result = await chrome.storage.local.get(SHARE_LINKS_STORAGE_KEY);
    const map = (result?.[SHARE_LINKS_STORAGE_KEY] as Record<string, string> | undefined) ?? {};
    map[shareId] = publicUrl;
    await chrome.storage.local.set({ [SHARE_LINKS_STORAGE_KEY]: map });
  } catch {
    // best-effort; re-copy just falls back to "not available on this device"
  }
};

export const getRememberedShareLinks = async (): Promise<Record<string, string>> => {
  try {
    const result = await chrome.storage.local.get(SHARE_LINKS_STORAGE_KEY);
    const map = result?.[SHARE_LINKS_STORAGE_KEY];
    return map && typeof map === "object" ? (map as Record<string, string>) : {};
  } catch {
    return {};
  }
};

export const forgetShareLink = async (shareId: string): Promise<void> => {
  try {
    const result = await chrome.storage.local.get(SHARE_LINKS_STORAGE_KEY);
    const map = (result?.[SHARE_LINKS_STORAGE_KEY] as Record<string, string> | undefined) ?? {};
    if (shareId in map) {
      delete map[shareId];
      await chrome.storage.local.set({ [SHARE_LINKS_STORAGE_KEY]: map });
    }
  } catch {
    // best-effort
  }
};

const authHeaders = (ownerToken: string): HeadersInit => ({
  Authorization: `Bearer ${ownerToken}`,
  "Content-Type": "application/json",
});

const parseShareError = async (response: Response): Promise<ShareApiError> => {
  let code: string = `HTTP_${response.status}`;
  let message: string | undefined;
  try {
    const body = (await response.json()) as { error?: string; message?: string };
    if (body?.error) code = body.error;
    if (body?.message) message = body.message;
  } catch {}
  return new ShareApiError(code, response.status, message);
};

const shareFetch = async <T>(
  path: string,
  init: RequestInit & { ownerToken?: string }
): Promise<T> => {
  const { ownerToken, headers, ...rest } = init;
  const finalHeaders: HeadersInit = {
    Accept: "application/json",
    ...(headers || {}),
  };
  if (ownerToken) {
    (finalHeaders as Record<string, string>).Authorization = `Bearer ${ownerToken}`;
  }
  const response = await fetch(`${SHARE_WORKER_BASE}${path}`, {
    ...rest,
    headers: finalHeaders,
  });
  if (!response.ok) {
    throw await parseShareError(response);
  }
  if (response.status === 204) return undefined as T;
  return (await response.json()) as T;
};

/**
 * Ensures an owner token exists. Reads from chrome.storage.local first;
 * if absent, generates a new one and registers it with the worker.
 */
export const ensureShareOwnerToken = async (): Promise<string> => {
  const existing = await readStoredOwnerToken();
  if (existing) return existing;

  const token = generateOwnerToken();
  const registration = await shareFetch<ShareOwnerRegistration>("/v1/share-owners", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ clientGeneratedToken: token }),
  });
  await writeStoredOwnerToken(token, {
    ownerId: registration.ownerId,
    tokenHint: registration.tokenHint,
  });
  return token;
};

export const getStoredOwnerMeta = async (): Promise<{
  token: string | null;
  ownerId: string | null;
  tokenHint: string | null;
}> => {
  try {
    const result = await chrome.storage.local.get([
      OWNER_TOKEN_STORAGE_KEY,
      OWNER_HINT_STORAGE_KEY,
      OWNER_ID_STORAGE_KEY,
    ]);
    return {
      token: (result?.[OWNER_TOKEN_STORAGE_KEY] as string) || null,
      ownerId: (result?.[OWNER_ID_STORAGE_KEY] as string) || null,
      tokenHint: (result?.[OWNER_HINT_STORAGE_KEY] as string) || null,
    };
  } catch {
    return { token: null, ownerId: null, tokenHint: null };
  }
};

/**
 * Rotates the owner token by registering a new one. Old shares remain
 * active at their public URL but become unmanageable from this device
 * because the worker only stores token hashes.
 */
export const rotateShareOwnerToken = async (): Promise<string> => {
  const token = generateOwnerToken();
  const registration = await shareFetch<ShareOwnerRegistration>("/v1/share-owners", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ clientGeneratedToken: token }),
  });
  await writeStoredOwnerToken(token, {
    ownerId: registration.ownerId,
    tokenHint: registration.tokenHint,
  });
  return token;
};

export const clearShareOwnerTokenLocally = clearStoredOwnerToken;

export type CreateShareInput = {
  title: string;
  description?: string;
  sourceKind: ShareSourceKind;
  sourceIds: string[];
  snapshot: ShareSnapshotV1;
  pin?: string;
  expiresAt?: number | null;
};

export const createShare = async (input: CreateShareInput): Promise<CreateShareResponse> => {
  const ownerToken = await ensureShareOwnerToken();
  return shareFetch<CreateShareResponse>("/v1/shares", {
    method: "POST",
    ownerToken,
    body: JSON.stringify({
      title: input.title,
      description: input.description || "",
      sourceKind: input.sourceKind,
      sourceIds: input.sourceIds,
      snapshot: input.snapshot,
      pin: input.pin,
      expiresAt: input.expiresAt ?? null,
    }),
  });
};

export const listOwnedShares = async (): Promise<OwnedShareSummary[]> => {
  const ownerToken = await ensureShareOwnerToken();
  const response = await shareFetch<OwnedShareListResponse>("/v1/shares", {
    method: "GET",
    ownerToken,
  });
  return response.shares || [];
};

export const getOwnedShareDetail = async (shareId: string): Promise<OwnedShareDetail> => {
  const ownerToken = await ensureShareOwnerToken();
  return shareFetch<OwnedShareDetail>(`/v1/shares/${encodeURIComponent(shareId)}`, {
    method: "GET",
    ownerToken,
  });
};

export const updateShareSnapshot = async (
  shareId: string,
  snapshot: ShareSnapshotV1
): Promise<UpdateShareSnapshotResponse> => {
  const ownerToken = await ensureShareOwnerToken();
  return shareFetch<UpdateShareSnapshotResponse>(
    `/v1/shares/${encodeURIComponent(shareId)}/snapshot`,
    {
      method: "PUT",
      ownerToken,
      body: JSON.stringify({ snapshot }),
    }
  );
};

export const revokeShare = async (shareId: string): Promise<RevokeShareResponse> => {
  const ownerToken = await ensureShareOwnerToken();
  return shareFetch<RevokeShareResponse>(
    `/v1/shares/${encodeURIComponent(shareId)}/revoke`,
    {
      method: "POST",
      ownerToken,
    }
  );
};

export type SetShareExpiryResponse = {
  shareId: string;
  expiresAt: number | null;
  updatedAt: number;
};

/** Set (or clear, with null) when a share's public link expires. */
export const setShareExpiry = async (
  shareId: string,
  expiresAt: number | null
): Promise<SetShareExpiryResponse> => {
  const ownerToken = await ensureShareOwnerToken();
  return shareFetch<SetShareExpiryResponse>(
    `/v1/shares/${encodeURIComponent(shareId)}/expiry`,
    {
      method: "POST",
      ownerToken,
      body: JSON.stringify({ expiresAt }),
    }
  );
};

export type SetSharePinResponse = {
  shareId: string;
  requiresPin: boolean;
  updatedAt: number;
};

/** Add, change, or clear (with null) the PIN on an already-shared link. */
export const setSharePin = async (
  shareId: string,
  pin: string | null
): Promise<SetSharePinResponse> => {
  const ownerToken = await ensureShareOwnerToken();
  return shareFetch<SetSharePinResponse>(
    `/v1/shares/${encodeURIComponent(shareId)}/pin`,
    {
      method: "POST",
      ownerToken,
      body: JSON.stringify({ pin }),
    }
  );
};

const SHARE_PAIR_PATTERN = "pub_[A-Za-z0-9_-]+\\.sec_[A-Za-z0-9_-]+";

/**
 * Extracts the `pub_XXX.sec_YYY` pair from a pasted share reference. Accepts a
 * viewer URL (`…/s/<pair>`), the worker export URL (`…/public-shares/<pair>`),
 * or the bare pair itself. A trailing `.json` is tolerated on the bare form.
 */
const extractSharePair = (shareUrl: string): string => {
  const trimmed = shareUrl.trim();
  const viewerMatch = trimmed.match(new RegExp(`/s/(${SHARE_PAIR_PATTERN})`));
  if (viewerMatch) return viewerMatch[1];
  const exportMatch = trimmed.match(new RegExp(`public-shares/(${SHARE_PAIR_PATTERN})`));
  if (exportMatch) return exportMatch[1];
  return trimmed.replace(/\.json$/i, "");
};

/**
 * Reads a public share snapshot from a pasted viewer/worker URL or bare pair.
 * This is the unauthenticated counterpart to the owner endpoints: anyone with
 * the public pair (plus the PIN, when one is set) can fetch the snapshot. The
 * PIN travels in the `x-share-pin` header. Worker status codes are mapped to
 * ShareApiError codes the import dialog branches on.
 */
export const importSharedLink = async (
  shareUrl: string,
  pin?: string
): Promise<ShareSnapshotV1> => {
  const pair = extractSharePair(shareUrl);
  const headers: Record<string, string> = { Accept: "application/json" };
  const trimmedPin = pin?.trim();
  if (trimmedPin) headers["x-share-pin"] = trimmedPin;

  const response = await fetch(`${SHARE_WORKER_BASE}/s/${pair}.json`, {
    method: "GET",
    headers,
  });

  if (!response.ok) {
    if (response.status === 401) throw new ShareApiError("PIN_REQUIRED", 401);
    if (response.status === 403) throw new ShareApiError("PIN_INVALID", 403);
    if (response.status === 410) throw new ShareApiError("SHARE_REVOKED", 410);
    if (response.status === 404) throw new ShareApiError("SHARE_NOT_FOUND", 404);
    throw new ShareApiError(String(response.status), response.status);
  }

  return (await response.json()) as ShareSnapshotV1;
};

/**
 * Builds a sanitized snapshot from any combination of selected folders,
 * items, spaces, and space groups. Caller passes the full truth: the
 * folder/item/space/spaceGroup docs that are currently loaded by the app;
 * this function filters to only what is selected.
 */
export type MixedShareSelection = {
  folderIds: Set<string>;
  itemIds: Set<string>;
  spaceIds: Set<string>;
  spaceGroupIds: Set<string>;
};

const emptySelection = (selection: MixedShareSelection): boolean =>
  selection.folderIds.size === 0 &&
  selection.itemIds.size === 0 &&
  selection.spaceIds.size === 0 &&
  selection.spaceGroupIds.size === 0;

export const describeShareSelection = (selection: MixedShareSelection): {
  count: number;
  label: string;
} => {
  const folderCount = selection.folderIds.size;
  const itemCount = selection.itemIds.size;
  const spaceCount = selection.spaceIds.size;
  const groupCount = selection.spaceGroupIds.size;
  const total = folderCount + itemCount + spaceCount + groupCount;
  if (total === 0) return { count: 0, label: "Nothing selected" };
  const parts: string[] = [];
  if (spaceCount > 0) parts.push(`${spaceCount} space${spaceCount === 1 ? "" : "s"}`);
  if (groupCount > 0) parts.push(`${groupCount} group${groupCount === 1 ? "" : "s"}`);
  if (folderCount > 0) parts.push(`${folderCount} tab group${folderCount === 1 ? "" : "s"}`);
  if (itemCount > 0) parts.push(`${itemCount} tab${itemCount === 1 ? "" : "s"}`);
  return { count: total, label: parts.join(" · ") };
};

export {
  buildLocalExportSnapshot,
  emptySelection,
  isShareApiError,
  SHARE_WORKER_BASE,
  OWNER_TOKEN_STORAGE_KEY,
};
