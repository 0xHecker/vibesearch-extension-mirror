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

type CachedFirefoxToken = GoogleTokenResult & { expiresAt: number };
const FIREFOX_GOOGLE_TOKEN_CACHE_KEY = "vibesearch:googleFirefoxToken:v1";
let memoryFirefoxToken: CachedFirefoxToken | null = null;

// Firefox implements the WebExtensions OAuth redirect flow, but not Chrome's
// browser-managed token API. Cache the short-lived token in storage.session so
// settings/status checks and a subsequent backup do not reopen the consent UI.
export async function getGoogleAccessToken(
  interactive: boolean
): Promise<GoogleTokenResult> {
  if (!interactive && await isGoogleWorkspaceExplicitlyDisconnected()) {
    throw new Error("GOOGLE_ACCOUNT_DISCONNECTED");
  }
  const cached = await readCachedFirefoxToken();
  if (cached) return cached;
  const clientId = getGoogleOAuthWebClientId();
  if (!clientId) {
    throw new Error("GOOGLE_OAUTH_CLIENT_ID_MISSING");
  }

  const redirectUri = getFirefoxGoogleRedirectUri();
  const state = crypto.randomUUID();
  const authUrl = new URL("https://accounts.google.com/o/oauth2/v2/auth");
  authUrl.searchParams.set("client_id", clientId);
  authUrl.searchParams.set("response_type", "token");
  authUrl.searchParams.set("redirect_uri", redirectUri);
  authUrl.searchParams.set("scope", GOOGLE_WORKSPACE_SCOPES.join(" "));
  authUrl.searchParams.set("include_granted_scopes", "true");
  authUrl.searchParams.set("prompt", interactive ? "consent" : "none");
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
    throw new Error(params.get("error") || "GOOGLE_AUTH_TOKEN_MISSING");
  }

  const scope = params.get("scope") || "";
  const result = {
    token,
    grantedScopes: scope ? scope.split(/\s+/).filter(Boolean) : undefined,
  };
  await cacheFirefoxToken(result, Number(params.get("expires_in")));
  if (interactive) await setGoogleWorkspaceExplicitlyDisconnected(false);
  return result;
}

export async function clearGoogleAccessToken(_token?: string): Promise<void> {
  memoryFirefoxToken = null;
  await chrome.storage.session?.remove(FIREFOX_GOOGLE_TOKEN_CACHE_KEY).catch(() => {});
}

export function getFirefoxGoogleRedirectUri(): string {
  const generated = new URL(chrome.identity.getRedirectURL("google"));
  const extensionHash = generated.hostname.split(".")[0]?.trim();
  if (!extensionHash || !/^[a-f0-9]{40}$/i.test(extensionHash)) {
    throw new Error("FIREFOX_GOOGLE_REDIRECT_INVALID");
  }
  return `http://127.0.0.1/mozoauth2/${extensionHash}`;
}

async function readCachedFirefoxToken(): Promise<GoogleTokenResult | null> {
  let cached = memoryFirefoxToken;
  try {
    const row = await chrome.storage.session?.get(FIREFOX_GOOGLE_TOKEN_CACHE_KEY);
    const stored = row?.[FIREFOX_GOOGLE_TOKEN_CACHE_KEY] as CachedFirefoxToken | undefined;
    cached = stored && typeof stored.token === "string" && Number.isFinite(stored.expiresAt)
      ? stored
      : null;
  } catch {}
  if (!cached || cached.expiresAt <= Date.now() + 60_000) return null;
  memoryFirefoxToken = cached;
  return { token: cached.token, grantedScopes: cached.grantedScopes };
}

async function cacheFirefoxToken(result: GoogleTokenResult, expiresInRaw: number): Promise<void> {
  const expiresIn = Number.isFinite(expiresInRaw) && expiresInRaw > 0 ? expiresInRaw : 3_600;
  const cached: CachedFirefoxToken = {
    ...result,
    expiresAt: Date.now() + Math.min(expiresIn, 86_400) * 1_000,
  };
  memoryFirefoxToken = cached;
  await chrome.storage.session?.set({ [FIREFOX_GOOGLE_TOKEN_CACHE_KEY]: cached }).catch(() => {});
}
