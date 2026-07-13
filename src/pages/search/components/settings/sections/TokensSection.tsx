import * as React from "react";
import { Check, Cloud, KeyRound, Loader2, Plug, Unplug } from "lucide-react";
import { Button } from "@src/components/ui/button";
import { Input } from "@src/components/ui/input";
import { showErrorToast, showSuccessToast } from "@src/utils/toast-feedback";
import { getGoogleAccessToken, clearGoogleAccessToken } from "@src/services/google-auth";
import { SectionHeading, SettingGroup, SettingRow } from "../SettingsPrimitives";
import { GitHubIcon, GoogleIcon } from "../BrandIcons";
import type { CloudAuthStatus } from "@src/services/cloud-auth";

/** chrome.storage.local key for the persisted GitHub personal access token. */
export const GITHUB_TOKEN_STORAGE_KEY = "vibesearch:githubToken";

type RuntimeResponse<T> = { success?: boolean; payload?: T; error?: string };

const callCloudAuth = async <T,>(type: "status" | "connect" | "disconnect", payload?: unknown): Promise<T> => {
  const response = await chrome.runtime.sendMessage({
    service: "cloudAuth",
    type,
    target: "offscreen",
    payload,
  }) as RuntimeResponse<T>;
  if (!response?.success) throw new Error(response?.error || `Cloud account ${type} failed.`);
  return response.payload as T;
};

const maskToken = (token: string) => {
  const trimmed = token.trim();
  if (trimmed.length <= 8) return "•".repeat(Math.max(trimmed.length, 4));
  return `${trimmed.slice(0, 4)}${"•".repeat(6)}${trimmed.slice(-4)}`;
};

export function TokensSection() {
  const [storedToken, setStoredToken] = React.useState<string | null>(null);
  const [draftToken, setDraftToken] = React.useState("");
  const [editing, setEditing] = React.useState(false);
  const [savingToken, setSavingToken] = React.useState(false);

  const [googleState, setGoogleState] = React.useState<"unknown" | "connected" | "disconnected">(
    "unknown"
  );
  const [googleBusy, setGoogleBusy] = React.useState(false);
  const [cloudState, setCloudState] = React.useState<CloudAuthStatus | null>(null);
  const [cloudBusy, setCloudBusy] = React.useState(false);

  // Load persisted GitHub token + probe Google connection (non-interactive).
  React.useEffect(() => {
    let active = true;
    void chrome.storage.local.get(GITHUB_TOKEN_STORAGE_KEY).then((result) => {
      if (!active) return;
      const value = typeof result?.[GITHUB_TOKEN_STORAGE_KEY] === "string" ? result[GITHUB_TOKEN_STORAGE_KEY] : "";
      setStoredToken(value || null);
      setEditing(!value);
    });
    void getGoogleAccessToken(false)
      .then(() => active && setGoogleState("connected"))
      .catch(() => active && setGoogleState("disconnected"));
    void callCloudAuth<CloudAuthStatus>("status", { refresh: true })
      .then((status) => active && setCloudState(status))
      .catch(() => active && setCloudState({
        connected: false,
        optedIn: false,
        needsReconnect: false,
        expiresAt: 0,
        user: null,
      }));
    return () => {
      active = false;
    };
  }, []);

  const saveToken = async () => {
    const value = draftToken.trim();
    if (!value) return;
    setSavingToken(true);
    try {
      await chrome.storage.local.set({ [GITHUB_TOKEN_STORAGE_KEY]: value });
      setStoredToken(value);
      setDraftToken("");
      setEditing(false);
      showSuccessToast("GitHub token saved.");
    } catch {
      showErrorToast("Could not save the token.");
    } finally {
      setSavingToken(false);
    }
  };

  const removeToken = async () => {
    try {
      await chrome.storage.local.remove(GITHUB_TOKEN_STORAGE_KEY);
      setStoredToken(null);
      setDraftToken("");
      setEditing(true);
      showSuccessToast("GitHub token removed.");
    } catch {
      showErrorToast("Could not remove the token.");
    }
  };

  const connectGoogle = async () => {
    setGoogleBusy(true);
    try {
      await getGoogleAccessToken(true);
      setGoogleState("connected");
      showSuccessToast("Google account connected.");
    } catch (cause) {
      showErrorToast(cause instanceof Error ? cause.message : "Could not connect to Google.");
    } finally {
      setGoogleBusy(false);
    }
  };

  const disconnectGoogle = async () => {
    setGoogleBusy(true);
    try {
      await clearGoogleAccessToken();
      setGoogleState("disconnected");
      showSuccessToast("Google account disconnected.");
    } catch {
      showErrorToast("Could not disconnect.");
    } finally {
      setGoogleBusy(false);
    }
  };

  const connectCloud = async () => {
    setCloudBusy(true);
    try {
      const status = await callCloudAuth<CloudAuthStatus>("connect");
      setCloudState(status);
      showSuccessToast("Cloud backup connected. Pending saves are uploading now.");
    } catch (cause) {
      showErrorToast(cause instanceof Error ? cause.message : "Could not connect cloud backup.");
    } finally {
      setCloudBusy(false);
    }
  };

  const disconnectCloud = async () => {
    setCloudBusy(true);
    try {
      setCloudState(await callCloudAuth<CloudAuthStatus>("disconnect"));
      showSuccessToast("Cloud backup disconnected. Local capture still works.");
    } catch (cause) {
      showErrorToast(cause instanceof Error ? cause.message : "Could not disconnect cloud backup.");
    } finally {
      setCloudBusy(false);
    }
  };

  return (
    <div>
      <SectionHeading
        title="Data connectors"
        description="Connect the services VibeSearch imports from and syncs with. Credentials are stored locally on this device and only ever sent to the service you connect."
      />

      <SettingGroup label="Vibesearch">
        <SettingRow
          title={
            <span className="flex items-center gap-2">
              <Cloud className="size-4 text-foreground-accent" />
              Cloud library
            </span>
          }
          description={
            cloudState?.user?.email
              ? `One-way backup from this extension to ${cloudState.user.email}. Web and mobile edits never overwrite this local library.`
              : "Back up extension saves one-way to your web and mobile library. Web and mobile edits never overwrite this local library."
          }
        >
          <span
            className={
              cloudState?.connected
                ? "inline-flex items-center gap-1 rounded-full bg-background-positive-faded px-2 py-0.5 text-xs font-medium text-foreground-positive"
                : cloudState?.needsReconnect
                  ? "inline-flex items-center gap-1 rounded-full bg-background-warning px-2 py-0.5 text-xs font-medium text-foreground-warning"
                  : "inline-flex items-center gap-1 rounded-full bg-background-page-secondary px-2 py-0.5 text-xs font-medium text-foreground-tertiary"
            }
          >
            {cloudState?.connected ? (
              <Check className="size-3" />
            ) : (
              <span className="size-1.5 rounded-full bg-current opacity-70" />
            )}
            {cloudState === null
              ? "Checking…"
              : cloudState.connected
                ? "Connected"
                : cloudState.needsReconnect
                  ? "Reconnect"
                  : "Not connected"}
          </span>
          {cloudState?.connected ? (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => void disconnectCloud()}
              disabled={cloudBusy}
              className="text-foreground-tertiary hover:text-foreground-danger"
            >
              {cloudBusy ? <Loader2 className="size-4 animate-spin" /> : <Unplug className="size-4" />}
              Disconnect
            </Button>
          ) : (
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => void connectCloud()}
              disabled={cloudBusy || cloudState === null}
              static={cloudBusy}
            >
              {cloudBusy ? <Loader2 className="size-4 animate-spin" /> : <Plug className="size-4" />}
              {cloudState?.needsReconnect ? "Reconnect" : "Connect"}
            </Button>
          )}
        </SettingRow>
      </SettingGroup>

      <SettingGroup label="GitHub">
        <SettingRow
          title={
            <span className="flex items-center gap-2">
              <GitHubIcon className="size-4" />
              GitHub personal access token
            </span>
          }
          description="Used to import your starred repositories. A token with read-only scope is enough."
          align={editing ? "start" : "center"}
        >
          {storedToken && !editing ? (
            <>
              <code className="rounded bg-background-page-secondary px-2 py-1 font-mono text-xs text-foreground-secondary">
                {maskToken(storedToken)}
              </code>
              <Button type="button" variant="ghost" size="sm" onClick={() => setEditing(true)}>
                Update
              </Button>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="text-foreground-tertiary hover:text-foreground-danger"
                onClick={() => void removeToken()}
              >
                Remove
              </Button>
            </>
          ) : (
            <div className="flex items-center gap-2">
              <Input
                type="password"
                autoComplete="off"
                value={draftToken}
                onChange={(e) => setDraftToken(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") void saveToken();
                }}
                placeholder="ghp_…"
                className="h-8 w-52 font-mono text-xs"
                aria-label="GitHub personal access token"
              />
              <Button type="button" size="sm" onClick={() => void saveToken()} disabled={!draftToken.trim() || savingToken} static={savingToken}>
                {savingToken ? <Loader2 className="size-4 animate-spin" /> : <KeyRound className="size-4" />}
                Save
              </Button>
              {storedToken && (
                <Button type="button" variant="ghost" size="sm" onClick={() => { setEditing(false); setDraftToken(""); }}>
                  Cancel
                </Button>
              )}
            </div>
          )}
        </SettingRow>
      </SettingGroup>

      <SettingGroup label="Google">
        <SettingRow
          title={
            <span className="flex items-center gap-2">
              <GoogleIcon className="size-4" />
              Google account
            </span>
          }
          description="Connect to back up and restore from Google Drive. Disconnecting clears the cached sign-in on this device."
        >
          <span
            className={
              googleState === "connected"
                ? "inline-flex items-center gap-1 rounded-full bg-background-positive-faded px-2 py-0.5 text-xs font-medium text-foreground-positive"
                : "inline-flex items-center gap-1 rounded-full bg-background-page-secondary px-2 py-0.5 text-xs font-medium text-foreground-tertiary"
            }
          >
            {googleState === "connected" ? <Check className="size-3" /> : <span className="size-1.5 rounded-full bg-foreground-tertiary" />}
            {googleState === "connected" ? "Connected" : googleState === "unknown" ? "Checking…" : "Not connected"}
          </span>
          {googleState === "connected" ? (
            <Button type="button" variant="ghost" size="sm" onClick={() => void disconnectGoogle()} disabled={googleBusy} className="text-foreground-tertiary hover:text-foreground-danger">
              {googleBusy ? <Loader2 className="size-4 animate-spin" /> : <Unplug className="size-4" />}
              Disconnect
            </Button>
          ) : (
            <Button type="button" variant="outline" size="sm" onClick={() => void connectGoogle()} disabled={googleBusy} static={googleBusy}>
              {googleBusy ? <Loader2 className="size-4 animate-spin" /> : <Plug className="size-4" />}
              Connect
            </Button>
          )}
        </SettingRow>
      </SettingGroup>
    </div>
  );
}
