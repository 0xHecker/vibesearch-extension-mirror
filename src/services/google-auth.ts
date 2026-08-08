import {
  getGoogleOAuthWebClientId,
  GOOGLE_WORKSPACE_SCOPES,
  isGoogleWorkspaceExplicitlyDisconnected,
  setGoogleWorkspaceExplicitlyDisconnected,
} from "./google-oauth-config";

export { GOOGLE_WORKSPACE_SCOPES } from "./google-oauth-config";

export type GoogleTokenResult = {
  token: string;
  grantedScopes?: string[];
};

type CachedWebToken = GoogleTokenResult & { expiresAt: number };
const GOOGLE_WEB_TOKEN_CACHE_KEY = "vibesearch:googleWebToken:v1";
let memoryWebToken: CachedWebToken | null = null;

export async function getGoogleAccessToken(interactive: boolean): Promise<GoogleTokenResult> {
  if (!interactive && await isGoogleWorkspaceExplicitlyDisconnected()) {
    throw new Error("GOOGLE_ACCOUNT_DISCONNECTED");
  }
  const identity = chrome.identity;
  const getAuthToken = identity?.getAuthToken;
  if (typeof getAuthToken === "function") {
    try {
      const result = await getAuthToken({
        interactive,
        scopes: [...GOOGLE_WORKSPACE_SCOPES],
      });
      const token = extractToken(result);
      if (token) {
        if (interactive) await setGoogleWorkspaceExplicitlyDisconnected(false);
        return {
          token,
          grantedScopes: Array.isArray((result as { grantedScopes?: string[] })?.grantedScopes)
            ? (result as { grantedScopes?: string[] }).grantedScopes
            : undefined,
        };
      }
    } catch (error) {
      if (!shouldFallbackToWebFlow(error)) throw error;
    }
  }

  const result = await getTokenWithWebAuthFlow(interactive);
  if (interactive) await setGoogleWorkspaceExplicitlyDisconnected(false);
  return result;
}

export async function clearGoogleAccessToken(token?: string): Promise<void> {
  try {
    if (token) {
      await chrome.identity.removeCachedAuthToken({ token });
    } else {
      await chrome.identity.clearAllCachedAuthTokens();
    }
  } catch {}
  memoryWebToken = null;
  await chrome.storage.session?.remove(GOOGLE_WEB_TOKEN_CACHE_KEY).catch(() => {});
}

function extractToken(result: unknown): string {
  if (typeof result === "string") return result;
  if (result && typeof result === "object" && typeof (result as { token?: unknown }).token === "string") {
    return (result as { token: string }).token;
  }
  return "";
}

function shouldFallbackToWebFlow(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error || "");
  return /oauth|client|manifest|not granted|not configured|invalid/i.test(message);
}

async function getTokenWithWebAuthFlow(interactive: boolean): Promise<GoogleTokenResult> {
  const cached = await readCachedWebToken();
  if (cached) return cached;
  const clientId = getGoogleOAuthWebClientId();
  if (!clientId) {
    throw new Error("GOOGLE_OAUTH_CLIENT_ID_MISSING");
  }
  const redirectUri = chrome.identity.getRedirectURL("google");
  const state = crypto.randomUUID();
  const authUrl = new URL("https://accounts.google.com/o/oauth2/v2/auth");
  authUrl.searchParams.set("client_id", clientId);
  authUrl.searchParams.set("response_type", "token");
  authUrl.searchParams.set("redirect_uri", redirectUri);
  authUrl.searchParams.set("scope", GOOGLE_WORKSPACE_SCOPES.join(" "));
  authUrl.searchParams.set("include_granted_scopes", "true");
  // Let Google show consent when it is actually required. Forcing consent on
  // every fallback sign-in makes reconnects look broken and repeatedly asks
  // for the same Drive-only permission.
  authUrl.searchParams.set("prompt", interactive ? "select_account" : "none");
  authUrl.searchParams.set("state", state);

  const redirectUrl = await chrome.identity.launchWebAuthFlow({
    url: authUrl.toString(),
    interactive,
  });
  if (!redirectUrl) throw new Error("GOOGLE_AUTH_CANCELLED");

  const parsed = new URL(redirectUrl);
  const params = new URLSearchParams(parsed.hash.replace(/^#/, ""));
  if ((params.get("state") || parsed.searchParams.get("state")) !== state) {
    throw new Error("GOOGLE_AUTH_STATE_MISMATCH");
  }
  const token = params.get("access_token") || "";
  if (!token) {
    const error = params.get("error") || "GOOGLE_AUTH_TOKEN_MISSING";
    throw new Error(error);
  }
  const scope = params.get("scope") || "";
  const result = {
    token,
    grantedScopes: scope ? scope.split(/\s+/).filter(Boolean) : undefined,
  };
  await cacheWebToken(result, Number(params.get("expires_in")));
  return result;
}

async function readCachedWebToken(): Promise<GoogleTokenResult | null> {
  let cached = memoryWebToken;
  try {
    const row = await chrome.storage.session?.get(GOOGLE_WEB_TOKEN_CACHE_KEY);
    const stored = row?.[GOOGLE_WEB_TOKEN_CACHE_KEY] as CachedWebToken | undefined;
    cached = stored && typeof stored.token === "string" && Number.isFinite(stored.expiresAt)
      ? stored
      : null;
  } catch {}
  if (!cached || cached.expiresAt <= Date.now() + 60_000) return null;
  memoryWebToken = cached;
  return { token: cached.token, grantedScopes: cached.grantedScopes };
}

async function cacheWebToken(result: GoogleTokenResult, expiresInRaw: number): Promise<void> {
  const expiresIn = Number.isFinite(expiresInRaw) && expiresInRaw > 0 ? expiresInRaw : 3_600;
  const cached: CachedWebToken = {
    ...result,
    expiresAt: Date.now() + Math.min(expiresIn, 86_400) * 1_000,
  };
  memoryWebToken = cached;
  await chrome.storage.session?.set({ [GOOGLE_WEB_TOKEN_CACHE_KEY]: cached }).catch(() => {});
}
