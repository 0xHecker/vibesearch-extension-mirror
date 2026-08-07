export const GOOGLE_WORKSPACE_SCOPES = [
  "https://www.googleapis.com/auth/drive.file",
  "https://www.googleapis.com/auth/spreadsheets",
];

export type GoogleTokenResult = {
  token: string;
  grantedScopes?: string[];
};

// Firefox implements the WebExtensions OAuth redirect flow, but not Chrome's
// browser-managed token/cache APIs. Request a short-lived token directly and keep no
// extension-managed token cache to clear.
export async function getGoogleAccessToken(
  interactive: boolean
): Promise<GoogleTokenResult> {
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
    throw new Error(params.get("error") || "GOOGLE_AUTH_TOKEN_MISSING");
  }

  const scope = params.get("scope") || "";
  return {
    token,
    grantedScopes: scope ? scope.split(/\s+/).filter(Boolean) : undefined,
  };
}

export async function clearGoogleAccessToken(_token?: string): Promise<void> {
  // launchWebAuthFlow does not populate Firefox's browser-managed token cache.
}
