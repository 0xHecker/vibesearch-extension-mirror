import * as React from "react";
import { Check, Cloud, KeyRound, Loader2, Plug, RefreshCw, TriangleAlert, Unplug } from "lucide-react";
import { invalidateItemCloudSyncState } from "@components/TabGroups/use-item-cloud-sync-state";
import { Button } from "@src/components/ui/button";
import { Input } from "@src/components/ui/input";
import { showErrorToast, showSuccessToast } from "@src/utils/toast-feedback";
import { SectionHeading, SettingGroup, SettingRow, SettingSwitch } from "../SettingsPrimitives";
import { GitHubIcon, GoogleIcon, NotionIcon } from "../BrandIcons";
import { SocialConnectors } from "./SocialConnectors";
import type { CloudAuthStatus } from "@src/services/cloud-auth";
import type { CloudSyncAllResult } from "@src/services/cloud-sync";
import type { NotionConnectionStatus } from "@src/services/notion-auth";

/** chrome.storage.local key for the persisted GitHub personal access token. */
export const GITHUB_TOKEN_STORAGE_KEY = "vibesearch:githubToken";

type RuntimeResponse<T> = { success?: boolean; payload?: T; error?: string };

type ManualCloudSyncResult = CloudSyncAllResult & {
  archive: {
    attempted: number;
    uploaded: number;
    remaining: number;
    reason?: string;
  };
};

type GoogleConnection = { connected: true; accountId: string };

const callGoogleAuth = async (type: "GOOGLE_AUTH_STATUS" | "GOOGLE_AUTH_CONNECT") => {
  const response = await chrome.runtime.sendMessage({ target: "background", type }) as RuntimeResponse<GoogleConnection>;
  if (!response?.success) throw new Error(response?.error || "Google account connection failed.");
  return response.payload as GoogleConnection;
};

const callNotionAuth = async (
  type: "NOTION_AUTH_STATUS" | "NOTION_AUTH_CONNECT" | "NOTION_AUTH_DISCONNECT",
): Promise<NotionConnectionStatus> => {
  const response = await chrome.runtime.sendMessage({ target: "background", type }) as RuntimeResponse<NotionConnectionStatus>;
  if (!response?.success) throw new Error(response?.error || "Notion account connection failed.");
  return response.payload || { connected: false };
};

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

/** Read, or set then read, whether this device accepts incoming rows. */
const callCloudAuthPullPreference = async (enabled?: boolean): Promise<boolean> => {
  const response = await chrome.runtime.sendMessage({
    service: "cloudSync",
    type: "pullPreference",
    target: "offscreen",
    payload: enabled === undefined ? {} : { enabled },
  }) as RuntimeResponse<{ enabled?: boolean }>;
  if (!response?.success) throw new Error(response?.error || "Could not read that setting.");
  return response.payload?.enabled === true;
};

const maskToken = (token: string) => {
  const trimmed = token.trim();
  if (trimmed.length <= 8) return "•".repeat(Math.max(trimmed.length, 4));
  return `${trimmed.slice(0, 4)}${"•".repeat(6)}${trimmed.slice(-4)}`;
};

/**
 * The four states this row can actually be in. Derived from one status object so
 * the badge, the description, and the buttons can never disagree with each other
 * — the bug that let a dead session keep showing "Connected".
 */
type CloudRowState = "checking" | "disconnected" | "connected" | "expired";

const cloudRowState = (status: CloudAuthStatus | null): CloudRowState => {
  if (status === null) return "checking";
  if (status.connected) return "connected";
  return status.needsReconnect ? "expired" : "disconnected";
};

const cloudRowDescription = (state: CloudRowState, email: string | null): string => {
  switch (state) {
    case "checking":
      return "Checking your cloud connection…";
    case "connected":
      return email
        ? `Signed in as ${email}. Saves here back up one-way to your web and mobile library; edits there never overwrite this device.`
        : "Saves here back up one-way to your web and mobile library; edits there never overwrite this device.";
    case "expired":
      return email
        ? `Your session for ${email} ended, so backups are paused. Everything you save still works on this device — reconnect to resume uploading.`
        : "Your session ended, so backups are paused. Everything you save still works on this device — reconnect to resume uploading.";
    case "disconnected":
      return "Log in with Google to back up this library to the web app and your other devices. Nothing on this device is overwritten.";
  }
};

/** Uses the browser's own connectivity, so "Sync now" cannot promise the impossible. */
const useOnline = (): boolean => {
  const [online, setOnline] = React.useState(
    () => typeof navigator === "undefined" || navigator.onLine !== false,
  );
  React.useEffect(() => {
    const update = () => setOnline(navigator.onLine !== false);
    window.addEventListener("online", update);
    window.addEventListener("offline", update);
    return () => {
      window.removeEventListener("online", update);
      window.removeEventListener("offline", update);
    };
  }, []);
  return online;
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
  const [notionState, setNotionState] = React.useState<NotionConnectionStatus | null>(null);
  const [notionBusy, setNotionBusy] = React.useState(false);
  const [cloudState, setCloudState] = React.useState<CloudAuthStatus | null>(null);
  const [cloudBusy, setCloudBusy] = React.useState(false);
  const [cloudSyncBusy, setCloudSyncBusy] = React.useState(false);
  const cloudRow = cloudRowState(cloudState);
  const online = useOnline();
  const [pullEnabled, setPullEnabled] = React.useState<boolean | null>(null);

  React.useEffect(() => {
    let active = true;
    void callCloudAuthPullPreference()
      .then((enabled) => active && setPullEnabled(enabled))
      .catch(() => active && setPullEnabled(false));
    return () => {
      active = false;
    };
  }, []);

  const toggleIncomingSync = async (next: boolean) => {
    setPullEnabled(next);
    try {
      const enabled = await callCloudAuthPullPreference(next);
      setPullEnabled(enabled);
      if (enabled) {
        showSuccessToast("This device will now bring in items added on your other devices.");
        void chrome.runtime.sendMessage({ target: "background", type: "CLOUD_SYNC_QUEUED" });
      } else {
        showSuccessToast("This device will only send saves out. Nothing will be brought in.");
      }
    } catch (cause) {
      setPullEnabled(!next);
      showErrorToast(cause instanceof Error ? cause.message : "Could not change that setting.");
    }
  };

  // A drain in the background worker can discover that the session died, so the
  // badge follows the stored auth state instead of only the last poll.
  React.useEffect(() => {
    const onChanged = (
      changes: Record<string, chrome.storage.StorageChange>,
      areaName: string,
    ) => {
      if (areaName !== "local") return;
      const authChanged = Object.keys(changes).some((key) => key.startsWith("vibesearch:cloudAuth") ||
        key === "vibesearch:firebaseIdToken");
      if (!authChanged) return;
      void callCloudAuth<CloudAuthStatus>("status")
        .then(setCloudState)
        .catch(() => undefined);
    };
    chrome.storage.onChanged.addListener(onChanged);
    return () => chrome.storage.onChanged.removeListener(onChanged);
  }, []);

  // Load persisted GitHub token + probe Google connection (non-interactive).
  React.useEffect(() => {
    let active = true;
    void chrome.storage.local.get(GITHUB_TOKEN_STORAGE_KEY).then((result) => {
      if (!active) return;
      const value = typeof result?.[GITHUB_TOKEN_STORAGE_KEY] === "string" ? result[GITHUB_TOKEN_STORAGE_KEY] : "";
      setStoredToken(value || null);
      setEditing(!value);
    });
    void callGoogleAuth("GOOGLE_AUTH_STATUS")
      .then(() => active && setGoogleState("connected"))
      .catch(() => active && setGoogleState("disconnected"));
    void callNotionAuth("NOTION_AUTH_STATUS")
      .then((status) => active && setNotionState(status))
      .catch(() => active && setNotionState({ connected: false }));
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
      await callGoogleAuth("GOOGLE_AUTH_CONNECT");
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
      const response = await chrome.runtime.sendMessage({
        target: "background",
        type: "GOOGLE_SYNC_CLEAR_AUTH",
      }) as RuntimeResponse<{ cleared: boolean }>;
      if (!response?.success) throw new Error(response?.error || "Could not disconnect.");
      setGoogleState("disconnected");
      showSuccessToast("Google account disconnected.");
    } catch {
      showErrorToast("Could not disconnect.");
    } finally {
      setGoogleBusy(false);
    }
  };

  const connectNotion = async () => {
    setNotionBusy(true);
    try {
      const status = await callNotionAuth("NOTION_AUTH_CONNECT");
      setNotionState(status);
      showSuccessToast(`Notion connected${status.workspaceName ? ` to ${status.workspaceName}` : ""}.`);
    } catch (cause) {
      showErrorToast(cause instanceof Error ? cause.message : "Could not connect to Notion.");
    } finally {
      setNotionBusy(false);
    }
  };

  const disconnectNotion = async () => {
    setNotionBusy(true);
    try {
      await callNotionAuth("NOTION_AUTH_DISCONNECT");
      setNotionState({ connected: false });
      showSuccessToast("Notion disconnected.");
    } catch (cause) {
      showErrorToast(cause instanceof Error ? cause.message : "Could not disconnect from Notion.");
    } finally {
      setNotionBusy(false);
    }
  };

  const connectCloud = async () => {
    setCloudBusy(true);
    try {
      const status = await callCloudAuth<CloudAuthStatus>("connect");
      setCloudState(status);
      showSuccessToast(
        status.user?.email
          ? `Signed in as ${status.user.email}. Pending saves are uploading now.`
          : "Signed in. Pending saves are uploading now.",
      );
    } catch (cause) {
      const detail = cause instanceof Error ? cause.message : "";
      // The chooser being dismissed is a normal outcome, not a failure.
      showErrorToast(
        /cancel|popup|closed|user-cancelled/i.test(detail)
          ? "Sign-in was cancelled. Nothing changed."
          : detail || "Could not sign in to cloud backup.",
      );
    } finally {
      setCloudBusy(false);
    }
  };

  const disconnectCloud = async () => {
    setCloudBusy(true);
    try {
      setCloudState(await callCloudAuth<CloudAuthStatus>("disconnect"));
      showSuccessToast(
        "Signed out of cloud backup. Your library stays on this device, and anything already backed up stays in your web library.",
      );
    } catch (cause) {
      showErrorToast(cause instanceof Error ? cause.message : "Could not disconnect cloud backup.");
    } finally {
      setCloudBusy(false);
    }
  };

  const syncCloudNow = async () => {
    setCloudSyncBusy(true);
    try {
      const response = await chrome.runtime.sendMessage({
        target: "background",
        type: "CLOUD_SYNC_NOW",
      }) as RuntimeResponse<ManualCloudSyncResult>;
      if (!response?.success || !response.payload) {
        throw new Error(response?.error || "Cloud sync failed.");
      }

      // Backup state changed for potentially every card.
      invalidateItemCloudSyncState();
      const { scanned, push, archive } = response.payload;
      const remaining = push.remaining + archive.remaining;
      const completed = push.pushed + archive.uploaded;
      showSuccessToast(
        remaining > 0
          ? `Checked ${scanned.toLocaleString()} local records. ${remaining.toLocaleString()} uploads will continue in the background.`
          : `Cloud sync complete. Checked ${scanned.toLocaleString()} local records and uploaded ${completed.toLocaleString()} changes.`,
      );
    } catch (cause) {
      const detail = cause instanceof Error ? cause.message : "Could not sync the cloud library.";
      showErrorToast(
        detail.includes("CLOUD_SYNC_AUTH_REQUIRED")
          ? "Your Vibesearch session expired. Reconnect your cloud account and try again."
          : detail,
      );
    } finally {
      setCloudSyncBusy(false);
    }
  };

  return (
    <div>
      <SectionHeading
        title="Data connectors"
        description="Connect the services VibeSearch imports from and syncs with. Connection credentials stay on this device; Notion OAuth is brokered without sending your library through VibeSearch."
      />

      <SettingGroup label="Vibesearch">
        <SettingRow
          title={
            <span className="flex items-center gap-2">
              <Cloud className="size-4 text-foreground-accent" />
              Cloud library
            </span>
          }
          description={cloudRowDescription(cloudRow, cloudState?.user?.email ?? null)}
        >
          <span
            className={
              cloudRow === "connected"
                ? "inline-flex items-center gap-1 rounded-full bg-background-positive-faded px-2 py-0.5 text-xs font-medium text-foreground-positive"
                : cloudRow === "expired"
                  ? "inline-flex items-center gap-1 rounded-full bg-background-warning px-2 py-0.5 text-xs font-medium text-foreground-warning"
                  : "inline-flex items-center gap-1 rounded-full bg-background-page-secondary px-2 py-0.5 text-xs font-medium text-foreground-tertiary"
            }
          >
            {cloudRow === "connected" ? (
              <Check className="size-3" />
            ) : cloudRow === "expired" ? (
              <TriangleAlert className="size-3" />
            ) : (
              <span className="size-1.5 rounded-full bg-current opacity-70" />
            )}
            {cloudRow === "checking"
              ? "Checking…"
              : cloudRow === "connected"
                ? "Connected"
                : cloudRow === "expired"
                  ? "Session expired"
                  : "Not connected"}
          </span>
          {cloudRow === "connected" ? (
            <>
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => void syncCloudNow()}
                disabled={cloudBusy || cloudSyncBusy || !online}
                static={cloudSyncBusy}
                title={online ? "Upload pending changes now" : "You're offline — reconnect to sync"}
              >
                {cloudSyncBusy ? <Loader2 className="size-4 animate-spin" /> : <RefreshCw className="size-4" />}
                {cloudSyncBusy ? "Syncing…" : online ? "Sync now" : "Offline"}
              </Button>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={() => void disconnectCloud()}
                disabled={cloudBusy || cloudSyncBusy}
                className="text-foreground-tertiary hover:text-foreground-danger"
                title="Sign out of cloud backup. Uploads stop; your library stays on this device and nothing already backed up is deleted."
              >
                {cloudBusy ? <Loader2 className="size-4 animate-spin" /> : <Unplug className="size-4" />}
                Disconnect
              </Button>
            </>
          ) : (
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => void connectCloud()}
              disabled={cloudBusy || cloudRow === "checking" || !online}
              static={cloudBusy}
              title={online ? undefined : "You're offline — reconnect to log in"}
            >
              {cloudBusy ? <Loader2 className="size-4 animate-spin" /> : <Plug className="size-4" />}
              {cloudRow === "expired" ? "Reconnect with Google" : "Log in with Google"}
            </Button>
          )}
        </SettingRow>

        <SettingRow
          title="Bring in items from my other devices"
          description="Saving always goes one way: out of this extension to your web library. Turn this on and this device will also pull in items saved by Vibesearch on your other browsers. Items created in the web app stay there, and nothing already here is changed or removed."
        >
          <SettingSwitch
            checked={pullEnabled === true}
            onCheckedChange={(next) => void toggleIncomingSync(next)}
            disabled={pullEnabled === null || cloudRow !== "connected"}
            label="Bring in items added on your other devices"
          />
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
              Google Drive backup
            </span>
          }
          description="Keep a private, portable VibeSearch backup in your Drive. VibeSearch can only manage backup files it creates."
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

      <SettingGroup label="Notion">
        <SettingRow
          title={
            <span className="flex items-center gap-2">
              <NotionIcon className="size-4" />
              Notion workspace
            </span>
          }
          description={
            notionState?.workspaceName
              ? `Export a readable VibeSearch catalog to ${notionState.workspaceName}. Library content goes directly to Notion.`
              : "Export a readable VibeSearch catalog to a private page in your Notion workspace."
          }
        >
          <span
            className={
              notionState?.connected
                ? "inline-flex items-center gap-1 rounded-full bg-background-positive-faded px-2 py-0.5 text-xs font-medium text-foreground-positive"
                : "inline-flex items-center gap-1 rounded-full bg-background-page-secondary px-2 py-0.5 text-xs font-medium text-foreground-tertiary"
            }
          >
            {notionState?.connected ? <Check className="size-3" /> : <span className="size-1.5 rounded-full bg-foreground-tertiary" />}
            {notionState === null ? "Checking…" : notionState.connected ? "Connected" : "Not connected"}
          </span>
          {notionState?.connected ? (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => void disconnectNotion()}
              disabled={notionBusy}
              className="text-foreground-tertiary hover:text-foreground-danger"
            >
              {notionBusy ? <Loader2 className="size-4 animate-spin" /> : <Unplug className="size-4" />}
              Disconnect
            </Button>
          ) : (
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => void connectNotion()}
              disabled={notionBusy || notionState === null}
              static={notionBusy}
            >
              {notionBusy ? <Loader2 className="size-4 animate-spin" /> : <Plug className="size-4" />}
              Connect
            </Button>
          )}
        </SettingRow>
      </SettingGroup>

      <SocialConnectors cloudConnected={cloudState?.connected === true} />
    </div>
  );
}
