/** OAuth client IDs are public identifiers, not secrets. */
export const DEFAULT_GOOGLE_OAUTH_WEB_CLIENT_ID =
  "400575856806-pnmpg6fvk3prdb6e3186g575pnkcqebo.apps.googleusercontent.com";

export const GOOGLE_WORKSPACE_SCOPES = [
  "https://www.googleapis.com/auth/drive.file",
] as const;

export const GOOGLE_WORKSPACE_DISCONNECTED_KEY = "vibesearch:googleDisconnected:v1";

export const isGoogleWorkspaceExplicitlyDisconnected = async (): Promise<boolean> => {
  const row = await chrome.storage.local.get(GOOGLE_WORKSPACE_DISCONNECTED_KEY);
  return row[GOOGLE_WORKSPACE_DISCONNECTED_KEY] === true;
};

export const setGoogleWorkspaceExplicitlyDisconnected = async (disconnected: boolean): Promise<void> => {
  if (disconnected) {
    await chrome.storage.local.set({ [GOOGLE_WORKSPACE_DISCONNECTED_KEY]: true });
  } else {
    await chrome.storage.local.remove(GOOGLE_WORKSPACE_DISCONNECTED_KEY);
  }
};

export const getGoogleOAuthWebClientId = (): string =>
  (import.meta.env.VITE_GOOGLE_OAUTH_CLIENT_ID || DEFAULT_GOOGLE_OAUTH_WEB_CLIENT_ID).trim();
