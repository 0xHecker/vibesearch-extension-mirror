export const GOOGLE_WORKSPACE_SCOPES = [
  "https://www.googleapis.com/auth/drive.file",
  "https://www.googleapis.com/auth/spreadsheets",
];

export type GoogleTokenResult = {
  token: string;
  grantedScopes?: string[];
};

export async function getGoogleAccessToken(interactive: boolean): Promise<GoogleTokenResult> {
  const identity = chrome.identity;
  const getAuthToken = identity?.getAuthToken;
  if (typeof getAuthToken === "function") {
    try {
      const result = await getAuthToken({
        interactive,
        scopes: GOOGLE_WORKSPACE_SCOPES,
      });
      const token = extractToken(result);
      if (token) {
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

  return getTokenWithWebAuthFlow(interactive);
}

export async function clearGoogleAccessToken(token?: string): Promise<void> {
  try {
    if (token) {
      await chrome.identity.removeCachedAuthToken({ token });
      return;
    }
    await chrome.identity.clearAllCachedAuthTokens();
  } catch {}
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
  const clientId = (import.meta.env.VITE_GOOGLE_OAUTH_CLIENT_ID || "").trim();
  if (!clientId) {
    throw new Error("GOOGLE_OAUTH_CLIENT_ID_MISSING");
  }
  const redirectUri = chrome.identity.getRedirectURL("google");
  const authUrl = new URL("https://accounts.google.com/o/oauth2/v2/auth");
  authUrl.searchParams.set("client_id", clientId);
  authUrl.searchParams.set("response_type", "token");
  authUrl.searchParams.set("redirect_uri", redirectUri);
  authUrl.searchParams.set("scope", GOOGLE_WORKSPACE_SCOPES.join(" "));
  authUrl.searchParams.set("include_granted_scopes", "true");
  authUrl.searchParams.set("prompt", "consent");

  const redirectUrl = await chrome.identity.launchWebAuthFlow({
    url: authUrl.toString(),
    interactive,
  });
  if (!redirectUrl) throw new Error("GOOGLE_AUTH_CANCELLED");

  const parsed = new URL(redirectUrl);
  const params = new URLSearchParams(parsed.hash.replace(/^#/, ""));
  const token = params.get("access_token") || "";
  if (!token) {
    const error = params.get("error") || "GOOGLE_AUTH_TOKEN_MISSING";
    throw new Error(error);
  }
  const scope = params.get("scope") || "";
  return {
    token,
    grantedScopes: scope ? scope.split(/\s+/).filter(Boolean) : undefined,
  };
}
