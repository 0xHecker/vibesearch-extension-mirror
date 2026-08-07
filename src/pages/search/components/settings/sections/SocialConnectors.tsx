import * as React from "react";
import { AtSign, Camera, Loader2, MessageCircle, Plus, RefreshCw, TriangleAlert, X } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { Button } from "@src/components/ui/button";
import { showErrorToast, showSuccessToast } from "@src/utils/toast-feedback";
import { SettingGroup, SettingRow } from "../SettingsPrimitives";

type Platform = "x" | "reddit" | "instagram";

interface ConnectorStateView {
  platform: Platform;
  accountId: string;
  handle: string;
  displayName?: string;
  connected: boolean;
  autoSync: boolean;
  lastSyncAt?: number;
  lastError?: string;
  itemCount: number;
}

const PLATFORMS: { platform: Platform; label: string; icon: LucideIcon; hint: string }[] = [
  { platform: "x", label: "X (Twitter)", icon: AtSign, hint: "Sync your bookmarks." },
  { platform: "reddit", label: "Reddit", icon: MessageCircle, hint: "Sync your saved posts & comments." },
  { platform: "instagram", label: "Instagram", icon: Camera, hint: "Sync your saved posts." },
];

const bg = <T,>(type: string, payload?: Record<string, unknown>): Promise<T> =>
  chrome.runtime.sendMessage({ target: "background", type, payload }) as Promise<T>;

const relativeTime = (ts?: number): string => {
  if (!ts) return "not yet";
  const s = Math.round((Date.now() - ts) / 1000);
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
};

/** A small, tasteful on/off switch (no external dep). */
function Switch({ on, busy, disabled, onToggle, label }: { on: boolean; busy?: boolean; disabled?: boolean; onToggle: () => void; label: string }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      aria-label={label}
      title={disabled ? "Sign in to Vibesearch first" : label}
      disabled={busy || disabled}
      onClick={onToggle}
      className={[
        "relative inline-flex h-5 w-9 shrink-0 items-center rounded-full transition-colors duration-200",
        on ? "bg-foreground-positive" : "bg-background-page-secondary ring-1 ring-inset ring-black/[0.08]",
        busy || disabled ? "opacity-50" : "cursor-pointer",
      ].join(" ")}
    >
      {busy ? (
        <Loader2 className="mx-auto size-3 animate-spin text-white" />
      ) : (
        <span className={["inline-block size-4 rounded-full bg-white shadow-sm transition-transform duration-200", on ? "translate-x-4" : "translate-x-0.5"].join(" ")} />
      )}
    </button>
  );
}

function PlatformIcon({ Icon }: { Icon: LucideIcon }) {
  return (
    <span className="grid size-7 shrink-0 place-items-center rounded-lg bg-background-page-secondary text-foreground-secondary">
      <Icon className="size-4" />
    </span>
  );
}

export function SocialConnectors({ cloudConnected }: { cloudConnected: boolean }) {
  const [connectors, setConnectors] = React.useState<ConnectorStateView[]>([]);
  const [busy, setBusy] = React.useState<string | null>(null);
  const [syncingPlatform, setSyncingPlatform] = React.useState<Platform | null>(null);

  const refresh = React.useCallback(async () => {
    try {
      const list = await bg<{ connectors: ConnectorStateView[] }>("CONNECTOR_LIST");
      setConnectors(Array.isArray(list?.connectors) ? list.connectors : []);
    } catch {
      /* background not ready */
    }
  }, []);

  React.useEffect(() => {
    void refresh();
  }, [refresh]);

  const accountsFor = (platform: Platform) => connectors.filter((c) => c.platform === platform);

  const runSync = async (platform: Platform, accountId: string) => {
    setSyncingPlatform(platform);
    try {
      await bg("RUN_CONNECTOR_SYNC", { source: platform, accountId });
    } finally {
      setSyncingPlatform(null);
      await refresh();
    }
  };

  const cancelSync = (platform: Platform) => {
    void bg("CANCEL_CONNECTOR_SYNC", { source: platform });
    showSuccessToast("Stopping sync…");
  };

  const connect = async (platform: Platform) => {
    setBusy(`connect:${platform}`);
    let connectedAccountId = "";
    try {
      const res = await bg<{ ok: boolean; state?: ConnectorStateView; error?: string }>("CONNECTOR_CONNECT", { platform });
      if (res?.ok && res.state) {
        connectedAccountId = res.state.accountId;
        showSuccessToast(`Connected — syncing your saved items…`);
      } else {
        showErrorToast(res?.error || `Couldn't connect ${platform}.`);
      }
      await refresh();
    } finally {
      setBusy(null);
    }
    if (connectedAccountId) await runSync(platform, connectedAccountId);
  };

  const toggleAccount = async (c: ConnectorStateView) => {
    if (!c.connected) {
      await connect(c.platform);
      return;
    }
    setBusy(`toggle:${c.platform}:${c.accountId}`);
    try {
      await bg("CONNECTOR_DISCONNECT", { platform: c.platform, accountId: c.accountId });
      await refresh();
    } finally {
      setBusy(null);
    }
  };

  const syncNow = (connector: ConnectorStateView) =>
    void runSync(connector.platform, connector.accountId);

  const statusLine = (c: ConnectorStateView): string => {
    if (!c.connected) return c.lastError || "Paused — turn on to reconnect.";
    return `${c.itemCount} synced · updated ${relativeTime(c.lastSyncAt)}`;
  };

  return (
    <SettingGroup label="Saved from social">
      <p className="-mt-1 mb-3 px-1 text-xs leading-relaxed text-foreground-tertiary">
        {cloudConnected
          ? "Connect an account and Vibesearch pulls in bookmarks and saved posts, then keeps them synced in the background."
          : "Connect Cloud library above first, then add the social accounts you want to sync."}
      </p>

      {/* One block per platform: connected accounts (multi) + a connect affordance. */}
      {PLATFORMS.map(({ platform, label, icon, hint }) => {
        const accounts = accountsFor(platform);
        const connecting = busy === `connect:${platform}`;
        const isSyncing = syncingPlatform === platform;
        return (
          <React.Fragment key={platform}>
            {accounts.length === 0 ? (
              <SettingRow
                title={
                  <span className="flex items-center gap-2">
                    <PlatformIcon Icon={icon} />
                    {label}
                  </span>
                }
                description={cloudConnected ? hint : "Connect Cloud library above first."}
              >
                <Switch on={false} busy={connecting} disabled={!cloudConnected} onToggle={() => void connect(platform)} label={`Connect ${label}`} />
              </SettingRow>
            ) : (
              accounts.map((c, i) => {
                const toggling = busy === `toggle:${c.platform}:${c.accountId}`;
                const expired = !c.connected && !!c.lastError;
                return (
                  <SettingRow
                    key={c.accountId}
                    title={
                      <span className="flex items-center gap-2">
                        <PlatformIcon Icon={icon} />
                        <span className="flex flex-col">
                          <span className="flex items-center gap-1.5">
                            {i === 0 ? label : ""}
                            <span className="text-xs font-normal text-foreground-secondary">
                              {c.handle.startsWith("id:") ? "connected" : `@${c.handle}`}
                            </span>
                            {expired && <TriangleAlert className="size-3 text-foreground-danger" />}
                          </span>
                        </span>
                      </span>
                    }
                    description={isSyncing ? "Syncing… (watch progress above)" : statusLine(c)}
                  >
                    {isSyncing ? (
                      <Button type="button" variant="ghost" size="sm" onClick={() => cancelSync(platform)} className="text-foreground-danger hover:text-foreground-danger">
                        <X className="size-4" /> Cancel
                      </Button>
                    ) : c.connected ? (
                      <Button type="button" variant="ghost" size="sm" onClick={() => syncNow(c)} className="text-foreground-secondary">
                        <RefreshCw className="size-4" /> Sync now
                      </Button>
                    ) : null}
                    <Switch on={c.connected} busy={toggling} disabled={!cloudConnected || isSyncing} onToggle={() => void toggleAccount(c)} label={`${c.connected ? "Disconnect" : "Reconnect"} ${label}`} />
                  </SettingRow>
                );
              })
            )}
            {accounts.length > 0 && cloudConnected && (
              <button
                type="button"
                onClick={() => void connect(platform)}
                disabled={connecting}
                className="mb-1 ml-9 inline-flex items-center gap-1 text-xs font-medium text-foreground-tertiary transition-colors hover:text-foreground-secondary disabled:opacity-50"
              >
                {connecting ? <Loader2 className="size-3 animate-spin" /> : <Plus className="size-3" />}
                Add another account
              </button>
            )}
          </React.Fragment>
        );
      })}
    </SettingGroup>
  );
}
