import { clearGoogleAccessToken, getGoogleAccessToken } from "@src/services/google-auth";
import { setGoogleWorkspaceExplicitlyDisconnected } from "@src/services/google-oauth-config";
import type { ShareSnapshotV1 } from "@src/services/share-snapshot";
import {
  GOOGLE_BACKUP_MAX_BYTES,
  GOOGLE_BACKUP_MULTIPART_MAX_BYTES,
  GOOGLE_BACKUP_REQUEST_TIMEOUT_MS,
  GOOGLE_BACKUP_UPLOAD_TIMEOUT_MS,
} from "@src/services/google-backup-limits";

const GOOGLE_SYNC_STATE_KEY = "vs_google_workspace_sync_v1";
const GOOGLE_API_MAX_JSON_RESPONSE_BYTES = 4 * 1024 * 1024;
const GOOGLE_API_MAX_ERROR_BYTES = 64 * 1024;
const GOOGLE_SYNC_STATE_VERSION = 2;
const GOOGLE_SYNC_MAX_ACCOUNTS = 5;
const GOOGLE_BACKUP_FILE_NAME = "vibesearch-export.json";
const GOOGLE_BACKUP_MIME_TYPE = "application/json";
const GOOGLE_BACKUP_APP_PROPERTY_KEY = "vibesearchBackup";
const GOOGLE_BACKUP_APP_PROPERTY_VALUE = "library-v1";

export type GoogleWorkspaceSyncState = {
  accountId?: string;
  driveFileId?: string;
  driveFileUrl?: string;
  lastSyncedAt?: number;
  itemCount?: number;
  folderCount?: number;
  error?: string;
};

export type GoogleWorkspaceSyncStateStore = {
  version: typeof GOOGLE_SYNC_STATE_VERSION;
  activeAccountId?: string;
  accounts: Record<string, GoogleWorkspaceSyncState>;
  /** One pre-account-binding row from an older extension release. */
  legacy?: GoogleWorkspaceSyncState;
};

export type GoogleWorkspaceSyncResult = GoogleWorkspaceSyncState & {
  ok: true;
};

export type GoogleWorkspaceConnection = {
  connected: true;
  accountId: string;
};

export type GoogleFile = {
  id?: string;
  name?: string;
  mimeType?: string;
  ownedByMe?: boolean;
  trashed?: boolean;
  modifiedTime?: string;
  size?: string;
  webViewLink?: string;
  webContentLink?: string;
  appProperties?: Record<string, string>;
};

export type GoogleBackupTargetResult = {
  driveFile: GoogleFile;
};

/** Commit the Drive file before publishing its target id to local state. */
export async function syncGoogleBackupTargets(operations: {
  syncDrive: () => Promise<GoogleFile>;
  afterDrive?: (driveFile: GoogleFile) => Promise<void>;
}): Promise<GoogleBackupTargetResult> {
  const driveFile = await operations.syncDrive();
  if (!driveFile.id) throw new Error("GOOGLE_DRIVE_FILE_ID_MISSING");
  await operations.afterDrive?.(driveFile);
  return { driveFile };
}

export type GoogleDriveBackup = {
  id: string;
  name: string;
  modifiedTime?: string;
  size?: string;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const normalizedAccountId = (value: unknown): string =>
  typeof value === "string" ? value.trim().slice(0, 256) : "";

const normalizeGoogleSyncState = (value: unknown): GoogleWorkspaceSyncState => {
  if (!isRecord(value)) return {};
  const state: GoogleWorkspaceSyncState = {};
  const accountId = normalizedAccountId(value.accountId);
  const driveFileId = typeof value.driveFileId === "string"
    ? value.driveFileId.trim().slice(0, 256)
    : "";
  const driveFileUrl = typeof value.driveFileUrl === "string"
    ? value.driveFileUrl.trim().slice(0, 2_048)
    : "";
  if (accountId) state.accountId = accountId;
  if (driveFileId) state.driveFileId = driveFileId;
  if (driveFileUrl) state.driveFileUrl = driveFileUrl;
  for (const field of ["lastSyncedAt", "itemCount", "folderCount"] as const) {
    const number = Number(value[field]);
    if (Number.isSafeInteger(number) && number >= 0) state[field] = number;
  }
  if (typeof value.error === "string" && value.error.trim()) {
    state.error = value.error.trim().slice(0, 500);
  }
  return state;
};

export const normalizeGoogleWorkspaceSyncStateStore = (
  value: unknown,
): GoogleWorkspaceSyncStateStore => {
  if (isRecord(value) && value.version === GOOGLE_SYNC_STATE_VERSION && isRecord(value.accounts)) {
    const candidates: Array<[string, GoogleWorkspaceSyncState]> = [];
    for (const [key, raw] of Object.entries(value.accounts)) {
      const accountId = normalizedAccountId(key);
      if (!accountId) continue;
      candidates.push([accountId, { ...normalizeGoogleSyncState(raw), accountId }]);
    }
    candidates.sort((left, right) =>
      (right[1].lastSyncedAt || 0) - (left[1].lastSyncedAt || 0) || left[0].localeCompare(right[0])
    );
    candidates.length = Math.min(candidates.length, GOOGLE_SYNC_MAX_ACCOUNTS);
    const accounts = Object.fromEntries(candidates);
    const activeAccountId = normalizedAccountId(value.activeAccountId);
    const legacy = normalizeGoogleSyncState(value.legacy);
    return {
      version: GOOGLE_SYNC_STATE_VERSION,
      ...(activeAccountId && accounts[activeAccountId] ? { activeAccountId } : {}),
      accounts,
      ...(!legacy.accountId && legacy.driveFileId ? { legacy } : {}),
    };
  }

  // Version one stored one state row. Account-bound rows migrate directly;
  // older unbound targets remain quarantined until Drive proves ownership.
  const legacyState = normalizeGoogleSyncState(value);
  if (legacyState.accountId) {
    return {
      version: GOOGLE_SYNC_STATE_VERSION,
      activeAccountId: legacyState.accountId,
      accounts: { [legacyState.accountId]: legacyState },
    };
  }
  return {
    version: GOOGLE_SYNC_STATE_VERSION,
    accounts: {},
    ...(legacyState.driveFileId ? { legacy: legacyState } : {}),
  };
};

export const googleSyncStateForAccountStore = (
  store: GoogleWorkspaceSyncStateStore,
  accountIdRaw: string,
): GoogleWorkspaceSyncState => {
  const accountId = normalizedAccountId(accountIdRaw);
  return accountId && store.accounts[accountId]
    ? { ...store.accounts[accountId], accountId }
    : { accountId };
};

export const upsertGoogleSyncStateForAccount = (
  storeValue: GoogleWorkspaceSyncStateStore,
  stateValue: GoogleWorkspaceSyncState,
): GoogleWorkspaceSyncStateStore => {
  const store = normalizeGoogleWorkspaceSyncStateStore(storeValue);
  const state = normalizeGoogleSyncState(stateValue);
  const accountId = normalizedAccountId(state.accountId);
  if (!accountId) throw new Error("GOOGLE_ACCOUNT_ID_MISSING");
  const retainedOthers = Object.entries(store.accounts)
    .filter(([candidateAccountId]) => candidateAccountId !== accountId)
    .sort((left, right) =>
      (right[1].lastSyncedAt || 0) - (left[1].lastSyncedAt || 0) || left[0].localeCompare(right[0])
    )
    .slice(0, GOOGLE_SYNC_MAX_ACCOUNTS - 1);
  return {
    version: GOOGLE_SYNC_STATE_VERSION,
    activeAccountId: accountId,
    accounts: Object.fromEntries([
      [accountId, { ...state, accountId }],
      ...retainedOthers,
    ]),
    ...(store.legacy ? { legacy: store.legacy } : {}),
  };
};

const getGoogleWorkspaceSyncStateStore = async (): Promise<GoogleWorkspaceSyncStateStore> => {
  const row = await chrome.storage.local.get(GOOGLE_SYNC_STATE_KEY);
  return normalizeGoogleWorkspaceSyncStateStore(row[GOOGLE_SYNC_STATE_KEY]);
};

const writeGoogleWorkspaceSyncStateStore = async (
  store: GoogleWorkspaceSyncStateStore,
): Promise<void> => {
  await chrome.storage.local.set({
    [GOOGLE_SYNC_STATE_KEY]: normalizeGoogleWorkspaceSyncStateStore(store),
  });
};

export async function getGoogleWorkspaceSyncState(): Promise<GoogleWorkspaceSyncState> {
  const store = await getGoogleWorkspaceSyncStateStore();
  return store.activeAccountId
    ? googleSyncStateForAccountStore(store, store.activeAccountId)
    : {};
}

export const googleSyncStateForAccount = (
  state: GoogleWorkspaceSyncState,
  accountId: string,
): GoogleWorkspaceSyncState =>
  state.accountId === accountId ? state : { accountId };

let googleWorkspaceMutationTail: Promise<void> = Promise.resolve();
const withGoogleWorkspaceMutation = async <T>(work: () => Promise<T>): Promise<T> => {
  const previous = googleWorkspaceMutationTail;
  let release!: () => void;
  googleWorkspaceMutationTail = new Promise<void>((resolve) => {
    release = resolve;
  });
  await previous;
  try {
    return await work();
  } finally {
    release();
  }
};

export async function clearGoogleWorkspaceAuth(): Promise<void> {
  await withGoogleWorkspaceMutation(async () => {
    const store = await getGoogleWorkspaceSyncStateStore();
    const { activeAccountId: _activeAccountId, ...inactiveStore } = store;
    await Promise.all([
      clearGoogleAccessToken(),
      // Keep the bounded per-account target map so reconnecting the same
      // account updates its existing file instead of creating a duplicate.
      writeGoogleWorkspaceSyncStateStore(inactiveStore),
      setGoogleWorkspaceExplicitlyDisconnected(true),
    ]);
  });
}

/**
 * Resolve and verify Google auth in the service-worker realm that also owns
 * backup, listing, and restore. A cached token alone is not enough to report a
 * connected account: the Drive API must accept it and return an account id.
 */
export async function connectGoogleWorkspace(
  options: { interactive?: boolean } = {},
): Promise<GoogleWorkspaceConnection> {
  const { token } = await getGoogleAccessToken(options.interactive !== false);
  const accountId = await getGoogleDriveAccountId(token);
  return { connected: true, accountId };
}

export const isUsableOwnedGoogleBackupFile = (
  file: GoogleFile | null | undefined,
  options: { requireMarker?: boolean } = {},
): file is GoogleFile & { id: string } =>
  !!file &&
  typeof file.id === "string" &&
  file.id.trim().length > 0 &&
  file.ownedByMe === true &&
  file.trashed !== true &&
  file.mimeType === GOOGLE_BACKUP_MIME_TYPE &&
  (!options.requireMarker ||
    file.appProperties?.[GOOGLE_BACKUP_APP_PROPERTY_KEY] === GOOGLE_BACKUP_APP_PROPERTY_VALUE);

export const googleOwnedBackupListQuery = (options: { requireMarker?: boolean } = {}): string => [
  `name = '${GOOGLE_BACKUP_FILE_NAME}'`,
  `mimeType = '${GOOGLE_BACKUP_MIME_TYPE}'`,
  "trashed = false",
  "'me' in owners",
  ...(options.requireMarker
    ? [`appProperties has { key='${GOOGLE_BACKUP_APP_PROPERTY_KEY}' and value='${GOOGLE_BACKUP_APP_PROPERTY_VALUE}' }`]
    : []),
].join(" and ");

const GOOGLE_FILE_FIELDS =
  "id,name,mimeType,ownedByMe,trashed,modifiedTime,size,webViewLink,webContentLink,appProperties";

const readGoogleDriveFileMetadata = async (
  token: string,
  fileId: string,
): Promise<GoogleFile | null> => {
  try {
    return await googleJson<GoogleFile>(
      token,
      `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}?fields=${encodeURIComponent(GOOGLE_FILE_FIELDS)}`,
      { method: "GET" },
    );
  } catch (error) {
    if (isNotFoundOrForbidden(error)) return null;
    throw error;
  }
};

const findReusableOwnedGoogleBackup = async (token: string): Promise<GoogleFile | null> => {
  const url = new URL("https://www.googleapis.com/drive/v3/files");
  url.searchParams.set("q", googleOwnedBackupListQuery({ requireMarker: true }));
  url.searchParams.set("orderBy", "modifiedTime desc");
  url.searchParams.set("pageSize", "10");
  url.searchParams.set("fields", `files(${GOOGLE_FILE_FIELDS})`);
  const response = await googleJson<{ files?: GoogleFile[] }>(token, url.toString(), {
    method: "GET",
  });
  return (response.files || []).find((file) =>
    isUsableOwnedGoogleBackupFile(file, { requireMarker: true })
  ) || null;
};

export async function listGoogleWorkspaceBackups(
  options: { interactive?: boolean } = {}
): Promise<GoogleDriveBackup[]> {
  const { token } = await getGoogleAccessToken(options.interactive !== false);
  const url = new URL("https://www.googleapis.com/drive/v3/files");
  url.searchParams.set("q", googleOwnedBackupListQuery());
  url.searchParams.set("orderBy", "modifiedTime desc");
  url.searchParams.set("pageSize", "20");
  url.searchParams.set("fields", `files(${GOOGLE_FILE_FIELDS})`);

  const response = await googleJson<{ files?: GoogleFile[] }>(token, url.toString(), {
    method: "GET",
  });
  return (response.files || [])
    .filter((file) => isUsableOwnedGoogleBackupFile(file))
    .map((file) => ({
      id: file.id,
      name: file.name || GOOGLE_BACKUP_FILE_NAME,
      modifiedTime: file.modifiedTime,
      size: file.size,
    }));
}

export async function downloadGoogleWorkspaceBackup(
  fileId: string,
  options: { interactive?: boolean } = {}
): Promise<ShareSnapshotV1> {
  const blob = await downloadGoogleWorkspaceBackupBlob(fileId, options);
  return JSON.parse(await blob.text()) as ShareSnapshotV1;
}

export async function downloadGoogleWorkspaceBackupBlob(
  fileId: string,
  options: { interactive?: boolean } = {}
): Promise<Blob> {
  if (!fileId) throw new Error("GOOGLE_BACKUP_FILE_ID_MISSING");
  const { token } = await getGoogleAccessToken(options.interactive !== false);
  const metadata = await readGoogleDriveFileMetadata(token, fileId);
  if (!isUsableOwnedGoogleBackupFile(metadata)) {
    throw new Error("GOOGLE_BACKUP_NOT_OWNED");
  }
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), GOOGLE_BACKUP_REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(
      `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}?alt=media`,
      {
        headers: { Authorization: `Bearer ${token}` },
        signal: controller.signal,
        credentials: "omit",
        cache: "no-store",
      }
    );
    if (response.status === 401) await clearGoogleAccessToken(token);
    if (!response.ok) throw await googleError(response, controller.signal);
    return await readBoundedGoogleBackup(response, controller.signal);
  } catch (error) {
    if (controller.signal.aborted) throw new Error("GOOGLE_BACKUP_DOWNLOAD_TIMEOUT");
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

const readBoundedGoogleBackup = async (
  response: Response,
  signal: AbortSignal,
): Promise<Blob> => {
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > GOOGLE_BACKUP_MAX_BYTES) {
    await response.body?.cancel().catch(() => {});
    throw new Error("GOOGLE_BACKUP_TOO_LARGE");
  }
  if (!response.body) {
    const bytes = await response.arrayBuffer();
    if (bytes.byteLength > GOOGLE_BACKUP_MAX_BYTES) throw new Error("GOOGLE_BACKUP_TOO_LARGE");
    return new Blob([bytes], { type: "application/json" });
  }

  const reader = response.body.getReader();
  const parts: BlobPart[] = [];
  let byteSize = 0;
  try {
    while (true) {
      if (signal.aborted) throw new DOMException("Aborted", "AbortError");
      const { done, value } = await reader.read();
      if (done) break;
      if (!value?.byteLength) continue;
      byteSize += value.byteLength;
      if (byteSize > GOOGLE_BACKUP_MAX_BYTES) {
        await reader.cancel().catch(() => {});
        throw new Error("GOOGLE_BACKUP_TOO_LARGE");
      }
      parts.push(value as BlobPart);
    }
  } finally {
    reader.releaseLock();
  }
  if (byteSize === 0) throw new Error("GOOGLE_BACKUP_EMPTY");
  return new Blob(parts, { type: "application/json" });
};

export async function syncSnapshotToGoogleWorkspace(
  snapshot: ShareSnapshotV1,
  options: { interactive?: boolean } = {}
): Promise<GoogleWorkspaceSyncResult> {
  return withGoogleWorkspaceMutation(async () => {
    const content = new Blob([JSON.stringify(snapshot)], {
      type: "application/json; charset=UTF-8",
    });
    return syncSnapshotBlobToGoogleWorkspace(
      content,
      { itemCount: snapshot.items.length, folderCount: snapshot.folders.length },
      options,
    );
  });
}

export async function syncSnapshotFileToGoogleWorkspace(
  content: Blob,
  counts: { itemCount: number; folderCount: number },
  options: { interactive?: boolean } = {},
): Promise<GoogleWorkspaceSyncResult> {
  return withGoogleWorkspaceMutation(() =>
    syncSnapshotBlobToGoogleWorkspace(content, counts, options)
  );
}

async function syncSnapshotBlobToGoogleWorkspace(
  content: Blob,
  counts: { itemCount: number; folderCount: number },
  options: { interactive?: boolean },
): Promise<GoogleWorkspaceSyncResult> {
  if (content.size <= 0 || content.size > GOOGLE_BACKUP_MAX_BYTES) {
    throw new Error("GOOGLE_BACKUP_TOO_LARGE");
  }
  const { token } = await getGoogleAccessToken(options.interactive !== false);
  const accountId = await getGoogleDriveAccountId(token);
  const resolved = await resolveGoogleSyncStateForAccount(
    token,
    await getGoogleWorkspaceSyncStateStore(),
    accountId,
  );
  const currentState = resolved.state;
  let durableStore = upsertGoogleSyncStateForAccount(resolved.store, currentState);
  // Persist legacy migration/discovery before upload. A worker termination can
  // then resume by PATCHing the known owned target instead of POSTing another.
  await writeGoogleWorkspaceSyncStateStore(durableStore);
  const targets = await syncGoogleBackupTargets({
    syncDrive: () => syncDriveBlob(token, content, currentState.driveFileId),
    afterDrive: async (driveFile) => {
      const durableDriveState: GoogleWorkspaceSyncState = {
        ...currentState,
        accountId,
        driveFileId: driveFile.id,
        driveFileUrl: driveFile.webViewLink || driveFile.webContentLink,
        lastSyncedAt: Date.now(),
        itemCount: counts.itemCount,
        folderCount: counts.folderCount,
      };
      durableStore = upsertGoogleSyncStateForAccount(durableStore, durableDriveState);
      await writeGoogleWorkspaceSyncStateStore(durableStore);
    },
  });
  const driveFile = targets.driveFile;

  const nextState: GoogleWorkspaceSyncResult = {
    ok: true,
    accountId,
    driveFileId: driveFile.id,
    driveFileUrl: driveFile.webViewLink || driveFile.webContentLink,
    lastSyncedAt: Date.now(),
    itemCount: counts.itemCount,
    folderCount: counts.folderCount,
  };

  durableStore = upsertGoogleSyncStateForAccount(durableStore, nextState);
  await writeGoogleWorkspaceSyncStateStore(durableStore);
  return nextState;
}

export async function getGoogleDriveAccountId(token: string): Promise<string> {
  const result = await googleJson<{
    user?: { permissionId?: string; emailAddress?: string };
  }>(
    token,
    "https://www.googleapis.com/drive/v3/about?fields=user(permissionId,emailAddress)",
    { method: "GET" },
  );
  const permissionId = result.user?.permissionId?.trim();
  if (!permissionId) throw new Error("GOOGLE_ACCOUNT_ID_MISSING");
  return permissionId;
}

const withoutLegacyGoogleState = (
  store: GoogleWorkspaceSyncStateStore,
): GoogleWorkspaceSyncStateStore => {
  const { legacy: _legacy, ...withoutLegacy } = store;
  return withoutLegacy;
};

const resolveGoogleSyncStateForAccount = async (
  token: string,
  storeValue: GoogleWorkspaceSyncStateStore,
  accountId: string,
): Promise<{ store: GoogleWorkspaceSyncStateStore; state: GoogleWorkspaceSyncState }> => {
  let store = normalizeGoogleWorkspaceSyncStateStore(storeValue);
  let state = googleSyncStateForAccountStore(store, accountId);

  if (state.driveFileId) {
    const metadata = await readGoogleDriveFileMetadata(token, state.driveFileId);
    if (isUsableOwnedGoogleBackupFile(metadata)) {
      return {
        store,
        state: {
          ...state,
          driveFileUrl: metadata.webViewLink || metadata.webContentLink || state.driveFileUrl,
        },
      };
    }
    state = { accountId };
  }

  // Upgrade one unbound version-one target only after Drive proves that the
  // current account still owns a live JSON file. Shared/transferred targets are
  // never adopted or patched.
  const legacyDriveFileId = store.legacy?.driveFileId;
  if (legacyDriveFileId) {
    const legacy = store.legacy!;
    const metadata = await readGoogleDriveFileMetadata(token, legacyDriveFileId);
    store = withoutLegacyGoogleState(store);
    if (isUsableOwnedGoogleBackupFile(metadata)) {
      return {
        store,
        state: {
          ...legacy,
          accountId,
          driveFileId: metadata.id,
          driveFileUrl: metadata.webViewLink || metadata.webContentLink || legacy.driveFileUrl,
        },
      };
    }
  }

  // A tagged target may already exist even if a create response or local state
  // write failed. Rediscovery makes the create path idempotent across retries.
  const discovered = await findReusableOwnedGoogleBackup(token);
  if (discovered) {
    return {
      store,
      state: {
        accountId,
        driveFileId: discovered.id,
        driveFileUrl: discovered.webViewLink || discovered.webContentLink,
      },
    };
  }
  return { store, state: { accountId } };
};

async function syncDriveBlob(
  token: string,
  body: Blob,
  existingFileId?: string
): Promise<GoogleFile> {
  if (body.size > GOOGLE_BACKUP_MAX_BYTES) throw new Error("GOOGLE_BACKUP_TOO_LARGE");
  if (existingFileId) {
    const updated = await uploadDriveFile<GoogleFile>(
      token,
      existingFileId,
      "PATCH",
      {
        name: GOOGLE_BACKUP_FILE_NAME,
        mimeType: GOOGLE_BACKUP_MIME_TYPE,
        appProperties: {
          [GOOGLE_BACKUP_APP_PROPERTY_KEY]: GOOGLE_BACKUP_APP_PROPERTY_VALUE,
        },
      },
      body
    ).catch((error) => {
      if (isNotFound(error)) return null;
      throw error;
    });
    if (updated) {
      if (!updated.id) throw new Error("GOOGLE_DRIVE_FILE_ID_MISSING");
      return updated;
    }
  }

  const created = await uploadDriveFile<GoogleFile>(
    token,
    undefined,
    "POST",
    {
      name: GOOGLE_BACKUP_FILE_NAME,
      mimeType: GOOGLE_BACKUP_MIME_TYPE,
      appProperties: {
        [GOOGLE_BACKUP_APP_PROPERTY_KEY]: GOOGLE_BACKUP_APP_PROPERTY_VALUE,
      },
    },
    body
  );
  if (!created.id) throw new Error("GOOGLE_DRIVE_FILE_ID_MISSING");
  return created;
}

export const shouldUseGoogleResumableUpload = (byteSize: number): boolean =>
  byteSize > GOOGLE_BACKUP_MULTIPART_MAX_BYTES;

async function uploadDriveFile<T>(
  token: string,
  existingFileId: string | undefined,
  method: "POST" | "PATCH",
  metadata: Record<string, unknown>,
  content: Blob,
): Promise<T> {
  const filePath = existingFileId ? `/${encodeURIComponent(existingFileId)}` : "";
  if (shouldUseGoogleResumableUpload(content.size)) {
    return uploadResumable<T>(
      token,
      `https://www.googleapis.com/upload/drive/v3/files${filePath}?uploadType=resumable&fields=id,webViewLink,webContentLink`,
      method,
      metadata,
      content,
    );
  }
  return uploadMultipart<T>(
    token,
    `https://www.googleapis.com/upload/drive/v3/files${filePath}?uploadType=multipart&fields=id,webViewLink,webContentLink`,
    method,
    metadata,
    content,
  );
}

async function googleJson<T = unknown>(
  token: string,
  url: string,
  init: RequestInit
): Promise<T> {
  return fetchWithTimeout(
    url,
    {
      ...init,
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        ...(init.headers || {}),
      },
      credentials: "omit",
      cache: "no-store",
    },
    GOOGLE_BACKUP_REQUEST_TIMEOUT_MS,
    "GOOGLE_API_REQUEST_TIMEOUT",
    async (response, signal) => {
      if (response.status === 401) await clearGoogleAccessToken(token);
      if (!response.ok) throw await googleError(response, signal);
      return readBoundedJson<T>(response, signal, GOOGLE_API_MAX_JSON_RESPONSE_BYTES);
    },
  );
}

async function uploadMultipart<T>(
  token: string,
  url: string,
  method: "POST" | "PATCH",
  metadata: Record<string, unknown>,
  content: Blob
): Promise<T> {
  const boundary = `vibesearch_${crypto.randomUUID()}`;
  const body = new Blob(
    [
      `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n`,
      JSON.stringify(metadata),
      `\r\n--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n`,
      content,
      `\r\n--${boundary}--\r\n`,
    ],
    { type: `multipart/related; boundary=${boundary}` }
  );

  return fetchWithTimeout(
    url,
    {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": `multipart/related; boundary=${boundary}`,
      },
      body,
      credentials: "omit",
      cache: "no-store",
    },
    GOOGLE_BACKUP_UPLOAD_TIMEOUT_MS,
    "GOOGLE_BACKUP_UPLOAD_TIMEOUT",
    async (response, signal) => {
      if (response.status === 401) await clearGoogleAccessToken(token);
      if (!response.ok) throw await googleError(response, signal);
      return readBoundedJson<T>(response, signal, GOOGLE_API_MAX_JSON_RESPONSE_BYTES);
    },
  );
}

async function uploadResumable<T>(
  token: string,
  url: string,
  method: "POST" | "PATCH",
  metadata: Record<string, unknown>,
  content: Blob,
): Promise<T> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), GOOGLE_BACKUP_UPLOAD_TIMEOUT_MS);
  try {
    const initiated = await fetch(url, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json; charset=UTF-8",
        "X-Upload-Content-Type": "application/json; charset=UTF-8",
        "X-Upload-Content-Length": String(content.size),
      },
      body: JSON.stringify(metadata),
      signal: controller.signal,
      credentials: "omit",
      cache: "no-store",
    });
    if (initiated.status === 401) await clearGoogleAccessToken(token);
    if (!initiated.ok) throw await googleError(initiated, controller.signal);
    const uploadUrl = initiated.headers.get("location");
    if (!uploadUrl) throw new Error("GOOGLE_RESUMABLE_LOCATION_MISSING");

    const uploaded = await fetch(uploadUrl, {
      method: "PUT",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json; charset=UTF-8",
      },
      body: content,
      signal: controller.signal,
      credentials: "omit",
      cache: "no-store",
    });
    if (uploaded.status === 401) await clearGoogleAccessToken(token);
    if (!uploaded.ok) throw await googleError(uploaded, controller.signal);
    return await readBoundedJson<T>(
      uploaded,
      controller.signal,
      GOOGLE_API_MAX_JSON_RESPONSE_BYTES,
    );
  } catch (error) {
    if (controller.signal.aborted) throw new Error("GOOGLE_BACKUP_UPLOAD_TIMEOUT");
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

async function googleError(response: Response, signal?: AbortSignal): Promise<Error> {
  let detail = "";
  try {
    detail = await readBoundedResponseText(response, signal, GOOGLE_API_MAX_ERROR_BYTES);
  } catch (error) {
    if (signal?.aborted) throw error;
    detail = error instanceof Error ? error.message : "GOOGLE_API_ERROR_BODY_UNREADABLE";
  }
  const error = new Error(`GOOGLE_API_${response.status}: ${detail || response.statusText}`);
  (error as Error & { status?: number }).status = response.status;
  return error;
}

function isNotFound(error: unknown): boolean {
  return (error as { status?: number })?.status === 404 || /GOOGLE_API_404/.test(String(error));
}

function isNotFoundOrForbidden(error: unknown): boolean {
  const status = (error as { status?: number })?.status;
  return status === 403 || status === 404 || /GOOGLE_API_(403|404)/.test(String(error));
}

export async function readBoundedResponseText(
  response: Response,
  signal: AbortSignal | undefined,
  maxBytes: number,
): Promise<string> {
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maxBytes) {
    await response.body?.cancel().catch(() => {});
    throw new Error("GOOGLE_API_RESPONSE_TOO_LARGE");
  }
  if (!response.body) {
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.byteLength > maxBytes) throw new Error("GOOGLE_API_RESPONSE_TOO_LARGE");
    return new TextDecoder().decode(bytes);
  }

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let byteSize = 0;
  const cancel = () => {
    void reader.cancel().catch(() => {});
  };
  signal?.addEventListener("abort", cancel, { once: true });
  try {
    while (true) {
      if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
      const { done, value } = await reader.read();
      // Cancelling a reader commonly resolves the pending read with
      // `{ done: true }`; do not mistake a timeout-triggered cancel for a
      // successfully completed response body.
      if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
      if (done) break;
      if (!value?.byteLength) continue;
      byteSize += value.byteLength;
      if (byteSize > maxBytes) {
        await reader.cancel().catch(() => {});
        throw new Error("GOOGLE_API_RESPONSE_TOO_LARGE");
      }
      chunks.push(value);
    }
  } finally {
    signal?.removeEventListener("abort", cancel);
    reader.releaseLock();
  }
  if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
  const merged = new Uint8Array(byteSize);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(merged);
}

async function readBoundedJson<T>(
  response: Response,
  signal: AbortSignal,
  maxBytes: number,
): Promise<T> {
  const text = await readBoundedResponseText(response, signal, maxBytes);
  if (!text.trim()) return {} as T;
  return JSON.parse(text) as T;
}

export async function fetchWithTimeout<T>(
  input: RequestInfo | URL,
  init: RequestInit,
  timeoutMs: number,
  timeoutCode: string,
  consume: (response: Response, signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(input, { ...init, signal: controller.signal });
    return await consume(response, controller.signal);
  } catch (error) {
    if (controller.signal.aborted) throw new Error(timeoutCode);
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}
