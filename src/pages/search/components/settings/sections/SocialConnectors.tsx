import * as React from "react";
import { AtSign, Camera, Check, Cloud, Loader2, MessageCircle, Plus, RefreshCw, TriangleAlert, X } from "lucide-react";
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

// Test account (dev only): the button below is shown only when these are set in
// the build env (.env.local), so it never ships in a normal production build.
const TEST_EMAIL = import.meta.env.VITE_TEST_EMAIL;
const TEST_PASSWORD = import.meta.env.VITE_TEST_PASSWORD;

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

export function SocialConnectors() {
  const [account, setAccount] = React.useState<{ uid: string; email?: string } | null>(null);
  const [cloudBusy, setCloudBusy] = React.useState(false);
  const [loading, setLoading] = React.useState(true);
  const [connectors, setConnectors] = React.useState<ConnectorStateView[]>([]);
  const [busy, setBusy] = React.useState<string | null>(null);
  const [syncingPlatform, setSyncingPlatform] = React.useState<Platform | null>(null);

  const refresh = React.useCallback(async () => {
    try {
      const [status, list] = await Promise.all([
        bg<{ account: { uid: string; email?: string } | null }>("CLOUD_STATUS"),
        bg<{ connectors: ConnectorStateView[] }>("CONNECTOR_LIST"),
      ]);
      setAccount(status?.account ?? null);
      setConnectors(Array.isArray(list?.connectors) ? list.connectors : []);
    } catch {
      /* background not ready */
    } finally {
      setLoading(false);
    }
  }, []);

  React.useEffect(() => {
    void refresh();
  }, [refresh]);

  const signedIn = !!account;

  const signIn = async () => {
    setCloudBusy(true);
    try {
      const res = await bg<{ ok: boolean; account?: { uid: string; email?: string }; error?: string }>("CLOUD_SIGN_IN", { mode: "google" });
      if (res?.ok) {
        setAccount(res.account ?? null);
        showSuccessToast("Signed in — your saved items will sync to Vibesearch.");
      } else showErrorToast(res?.error || "Sign-in failed.");
    } finally {
      setCloudBusy(false);
    }
  };

  const signInTest = async () => {
    if (!TEST_EMAIL || !TEST_PASSWORD) return;
    setCloudBusy(true);
    try {
      const res = await bg<{ ok: boolean; account?: { uid: string; email?: string }; error?: string }>("CLOUD_SIGN_IN", {
        mode: "test",
        email: TEST_EMAIL,
        password: TEST_PASSWORD,
      });
      if (res?.ok) {
        setAccount(res.account ?? null);
        showSuccessToast("Signed in with the test account.");
      } else showErrorToast(res?.error || "Test sign-in failed.");
    } finally {
      setCloudBusy(false);
    }
  };

  const signOut = async () => {
    setCloudBusy(true);
    try {
      await bg("CLOUD_SIGN_OUT");
      setAccount(null);
      showSuccessToast("Signed out of Vibesearch cloud.");
    } finally {
      setCloudBusy(false);
    }
  };

  const accountsFor = (platform: Platform) => connectors.filter((c) => c.platform === platform);

  const runSync = async (platform: Platform) => {
    setSyncingPlatform(platform);
    try {
      await bg("RUN_CONNECTOR_SYNC", { source: platform });
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
    let ok = false;
    try {
      const res = await bg<{ ok: boolean; error?: string }>("CONNECTOR_CONNECT", { platform });
      if (res?.ok) {
        ok = true;
        showSuccessToast(`Connected — syncing your saved items…`);
      } else {
        showErrorToast(res?.error || `Couldn't connect ${platform}.`);
      }
      await refresh();
    } finally {
      setBusy(null);
    }
    if (ok) await runSync(platform);
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

  const syncNow = (platform: Platform) => void runSync(platform);

  const statusLine = (c: ConnectorStateView): string => {
    if (!c.connected) return c.lastError || "Paused — turn on to reconnect.";
    return `${c.itemCount} synced · updated ${relativeTime(c.lastSyncAt)}`;
  };

  return (
    <SettingGroup label="Saved from social">
      <p className="-mt-1 mb-3 px-1 text-xs leading-relaxed text-foreground-tertiary">
        Connect an account and Vibesearch pulls in your bookmarks &amp; saved posts — then keeps them in sync automatically, in the background. Everything flows one way, into your Vibesearch library.
      </p>

      {/* Cloud account — the destination. Required before syncing. */}
      <SettingRow
        title={
          <span className="flex items-center gap-2">
            <Cloud className={signedIn ? "size-4 text-foreground-positive" : "size-4 text-foreground-tertiary"} />
            Vibesearch account
          </span>
        }
        description={signedIn ? "Your saved items sync here." : "Sign in to choose where your saved items go."}
      >
        {loading ? (
          <Loader2 className="size-4 animate-spin text-foreground-tertiary" />
        ) : signedIn ? (
          <>
            <span className="inline-flex items-center gap-1 rounded-full bg-background-positive-faded px-2 py-0.5 text-xs font-medium text-foreground-positive">
              <Check className="size-3" /> {account?.email || "Signed in"}
            </span>
            <Button type="button" variant="ghost" size="sm" onClick={() => void signOut()} disabled={cloudBusy} className="text-foreground-tertiary hover:text-foreground-danger">
              Sign out
            </Button>
          </>
        ) : (
          <div className="flex items-center gap-1.5">
            <Button type="button" size="sm" onClick={() => void signIn()} disabled={cloudBusy} static={cloudBusy}>
              {cloudBusy ? <Loader2 className="size-4 animate-spin" /> : <Cloud className="size-4" />}
              Sign in with Google
            </Button>
            {TEST_EMAIL && (
              <Button type="button" variant="ghost" size="sm" onClick={() => void signInTest()} disabled={cloudBusy} className="text-foreground-tertiary">
                Use test account
              </Button>
            )}
          </div>
        )}
      </SettingRow>

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
                description={signedIn ? hint : "Sign in above first, then connect."}
              >
                <Switch on={false} busy={connecting} disabled={!signedIn} onToggle={() => void connect(platform)} label={`Connect ${label}`} />
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
                      <Button type="button" variant="ghost" size="sm" onClick={() => void syncNow(platform)} className="text-foreground-secondary">
                        <RefreshCw className="size-4" /> Sync now
                      </Button>
                    ) : null}
                    <Switch on={c.connected} busy={toggling} disabled={!signedIn || isSyncing} onToggle={() => void toggleAccount(c)} label={`${c.connected ? "Disconnect" : "Reconnect"} ${label}`} />
                  </SettingRow>
                );
              })
            )}
            {accounts.length > 0 && signedIn && (
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
