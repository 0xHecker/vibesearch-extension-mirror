import { DEFAULT_VIBESEARCH_API_BASE } from "@src/services/cloud-config";

const NOTION_TOKEN_STORAGE_KEY = "vibesearch:notionOAuth:v1";
const NOTION_BROKER_BASE = (
  import.meta.env.VITE_NOTION_OAUTH_BROKER_BASE || DEFAULT_VIBESEARCH_API_BASE
).replace(/\/+$/, "");
const NOTION_AUTH_TIMEOUT_MS = 30_000;
const NOTION_AUTH_MAX_RESPONSE_BYTES = 64 * 1024;

export type NotionConnectionStatus = {
  connected: boolean;
  workspaceId?: string;
  workspaceName?: string;
  workspaceIcon?: string;
};

type StoredNotionAuth = {
  accessToken: string;
  refreshToken?: string;
  expiresAt: number;
  workspaceId?: string;
  workspaceName?: string;
  workspaceIcon?: string;
  botId?: string;
};

type BrokerTokenBundle = {
  accessToken?: unknown;
  refreshToken?: unknown;
  expiresIn?: unknown;
  workspaceId?: unknown;
  workspaceName?: unknown;
  workspaceIcon?: unknown;
  botId?: unknown;
};

const text = (value: unknown, maxLength: number): string =>
  typeof value === "string" ? value.trim().slice(0, maxLength) : "";

const normalizeStoredNotionAuth = (value: unknown): StoredNotionAuth | null => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  const accessToken = text(row.accessToken, 4_096);
  const refreshToken = text(row.refreshToken, 4_096);
  const expiresAt = Number(row.expiresAt);
  if (!accessToken || !Number.isSafeInteger(expiresAt) || expiresAt <= 0) {
    return null;
  }
  return {
    accessToken,
    ...(refreshToken ? { refreshToken } : {}),
    expiresAt,
    ...(text(row.workspaceId, 256) ? { workspaceId: text(row.workspaceId, 256) } : {}),
    ...(text(row.workspaceName, 500) ? { workspaceName: text(row.workspaceName, 500) } : {}),
    ...(text(row.workspaceIcon, 2_048) ? { workspaceIcon: text(row.workspaceIcon, 2_048) } : {}),
    ...(text(row.botId, 256) ? { botId: text(row.botId, 256) } : {}),
  };
};

const readStoredNotionAuth = async (): Promise<StoredNotionAuth | null> => {
  const row = await chrome.storage.local.get(NOTION_TOKEN_STORAGE_KEY);
  return normalizeStoredNotionAuth(row[NOTION_TOKEN_STORAGE_KEY]);
};

const writeStoredNotionAuth = async (auth: StoredNotionAuth): Promise<void> => {
  await chrome.storage.local.set({ [NOTION_TOKEN_STORAGE_KEY]: auth });
};

const removeStoredNotionAuth = async (): Promise<void> => {
  await chrome.storage.local.remove(NOTION_TOKEN_STORAGE_KEY);
};

const isTerminalRefreshError = (error: unknown): boolean =>
  error instanceof Error && error.message === "NOTION_OAUTH_PROVIDER_INVALID_GRANT";

const parseBrokerTokenBundle = (
  value: BrokerTokenBundle,
  previous?: StoredNotionAuth | null,
): StoredNotionAuth => {
  const accessToken = text(value.accessToken, 4_096);
  const refreshToken = text(value.refreshToken, 4_096) || previous?.refreshToken || "";
  if (!accessToken) throw new Error("NOTION_AUTH_TOKEN_MISSING");
  const expiresIn = Number(value.expiresIn);
  const hasDeclaredLifetime = Number.isSafeInteger(expiresIn) && expiresIn > 0;
  const expiresAt = hasDeclaredLifetime
    ? Date.now() + Math.min(expiresIn, 30 * 24 * 60 * 60) * 1_000
    : refreshToken
      ? Date.now() + 60 * 60 * 1_000
      : Number.MAX_SAFE_INTEGER;
  return {
    accessToken,
    ...(refreshToken ? { refreshToken } : {}),
    expiresAt,
    ...(text(value.workspaceId, 256) || previous?.workspaceId
      ? { workspaceId: text(value.workspaceId, 256) || previous?.workspaceId }
      : {}),
    ...(text(value.workspaceName, 500) || previous?.workspaceName
      ? { workspaceName: text(value.workspaceName, 500) || previous?.workspaceName }
      : {}),
    ...(text(value.workspaceIcon, 2_048) || previous?.workspaceIcon
      ? { workspaceIcon: text(value.workspaceIcon, 2_048) || previous?.workspaceIcon }
      : {}),
    ...(text(value.botId, 256) || previous?.botId
      ? { botId: text(value.botId, 256) || previous?.botId }
      : {}),
  };
};

const readBoundedJson = async (response: Response): Promise<Record<string, unknown>> => {
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > NOTION_AUTH_MAX_RESPONSE_BYTES) {
    await response.body?.cancel().catch(() => {});
    throw new Error("NOTION_AUTH_RESPONSE_TOO_LARGE");
  }
  const chunks: Uint8Array[] = [];
  let byteSize = 0;
  if (response.body) {
    const reader = response.body.getReader();
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (!value?.byteLength) continue;
        byteSize += value.byteLength;
        if (byteSize > NOTION_AUTH_MAX_RESPONSE_BYTES) {
          await reader.cancel().catch(() => {});
          throw new Error("NOTION_AUTH_RESPONSE_TOO_LARGE");
        }
        chunks.push(value);
      }
    } finally {
      reader.releaseLock();
    }
  }
  const buffer = new Uint8Array(byteSize);
  let offset = 0;
  for (const chunk of chunks) {
    buffer.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    const value = JSON.parse(new TextDecoder().decode(buffer)) as unknown;
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new Error("NOTION_AUTH_INVALID_RESPONSE");
    }
    return value as Record<string, unknown>;
  } catch (error) {
    if (error instanceof Error && error.message === "NOTION_AUTH_INVALID_RESPONSE") throw error;
    throw new Error("NOTION_AUTH_INVALID_RESPONSE");
  }
};

const callBroker = async <T extends Record<string, unknown>>(
  path: string,
  body: Record<string, string>,
): Promise<T> => {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), NOTION_AUTH_TIMEOUT_MS);
  try {
    const response = await fetch(`${NOTION_BROKER_BASE}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: controller.signal,
      credentials: "omit",
      cache: "no-store",
    });
    const result = await readBoundedJson(response);
    if (!response.ok) {
      throw new Error(text(result.error, 500) || `NOTION_AUTH_HTTP_${response.status}`);
    }
    return result as T;
  } catch (error) {
    if (controller.signal.aborted) throw new Error("NOTION_AUTH_TIMEOUT");
    throw error;
  } finally {
    clearTimeout(timeout);
  }
};

export async function connectNotion(): Promise<NotionConnectionStatus> {
  const state = crypto.randomUUID().replace(/-/g, "_");
  const redirectUri = chrome.identity.getRedirectURL("notion");
  const startUrl = new URL(`${NOTION_BROKER_BASE}/oauth/notion/start`);
  startUrl.searchParams.set("redirect_uri", redirectUri);
  startUrl.searchParams.set("state", state);
  const callbackUrl = await chrome.identity.launchWebAuthFlow({
    url: startUrl.toString(),
    interactive: true,
  });
  if (!callbackUrl) throw new Error("NOTION_AUTH_CANCELLED");
  const callback = new URL(callbackUrl);
  const params = new URLSearchParams(callback.hash.replace(/^#/, ""));
  const returnedState = params.get("state") || callback.searchParams.get("state") || "";
  if (returnedState !== state) throw new Error("NOTION_AUTH_STATE_MISMATCH");
  const providerError = params.get("error") || callback.searchParams.get("error");
  if (providerError) throw new Error(providerError);
  const handoff = params.get("handoff") || callback.searchParams.get("handoff") || "";
  if (!handoff) throw new Error("NOTION_AUTH_HANDOFF_MISSING");
  const bundle = await callBroker<BrokerTokenBundle & Record<string, unknown>>(
    "/oauth/notion/exchange",
    { handoff },
  );
  const auth = parseBrokerTokenBundle(bundle);
  await writeStoredNotionAuth(auth);
  return statusFromAuth(auth);
}

export async function getNotionConnectionStatus(): Promise<NotionConnectionStatus> {
  return statusFromAuth(await readStoredNotionAuth());
}

export async function getNotionAccessToken(
  options: { interactive?: boolean; forceRefresh?: boolean } = {},
): Promise<string> {
  let auth = await readStoredNotionAuth();
  if (!options.forceRefresh && auth && auth.expiresAt > Date.now() + 60_000) {
    return auth.accessToken;
  }
  if (auth?.refreshToken) {
    try {
      const bundle = await callBroker<BrokerTokenBundle & Record<string, unknown>>(
        "/oauth/notion/refresh",
        { refreshToken: auth.refreshToken },
      );
      auth = parseBrokerTokenBundle(bundle, auth);
      await writeStoredNotionAuth(auth);
      return auth.accessToken;
    } catch (error) {
      // A timeout, rate limit, broker outage, or malformed upstream response
      // must not discard a refresh token that may still be valid. Only an
      // explicit OAuth invalid_grant response proves the authorization is no
      // longer usable.
      if (!isTerminalRefreshError(error)) throw error;
      await removeStoredNotionAuth();
    }
  }
  if (auth) {
    // A long-lived access token has no refresh token. Once Notion rejects it,
    // or a declared expiry passes, it cannot be recovered without consent.
    await removeStoredNotionAuth();
    auth = null;
  }
  if (options.interactive === false) throw new Error("NOTION_NOT_CONNECTED");
  await connectNotion();
  const connected = await readStoredNotionAuth();
  if (!connected) throw new Error("NOTION_NOT_CONNECTED");
  return connected.accessToken;
}

export async function runWithNotionAccessToken<T>(
  operation: (accessToken: string) => Promise<T>,
  options: { interactive?: boolean } = {},
): Promise<T> {
  const token = await getNotionAccessToken(options);
  try {
    return await operation(token);
  } catch (error) {
    if (!(error instanceof Error) || error.message !== "NOTION_AUTH_EXPIRED") throw error;
  }

  // A direct Notion 401 can arrive before a response's synthetic/default
  // expiry. Rotate once and retry the request that Notion rejected; never
  // retry an operation after any other response status.
  const refreshed = await getNotionAccessToken({
    ...options,
    forceRefresh: true,
  });
  return operation(refreshed);
}

export async function disconnectNotion(): Promise<void> {
  const auth = await readStoredNotionAuth();
  await removeStoredNotionAuth();
  if (!auth) return;
  await callBroker<Record<string, unknown>>(
    "/oauth/notion/revoke",
    { token: auth.accessToken },
  ).catch(() => {});
}

const statusFromAuth = (auth: StoredNotionAuth | null): NotionConnectionStatus => auth
  ? {
      connected: true,
      ...(auth.workspaceId ? { workspaceId: auth.workspaceId } : {}),
      ...(auth.workspaceName ? { workspaceName: auth.workspaceName } : {}),
      ...(auth.workspaceIcon ? { workspaceIcon: auth.workspaceIcon } : {}),
    }
  : { connected: false };

export const __notionAuthTesting = {
  storageKey: NOTION_TOKEN_STORAGE_KEY,
  normalizeStoredNotionAuth,
  parseBrokerTokenBundle,
};
