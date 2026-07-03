/**
 * connectors/registry.ts — drives all social connectors uniformly.
 *
 * Responsibilities:
 *  • state store (chrome.storage) keyed by `${platform}:${accountId}` → supports
 *    **multiple accounts** per platform, each with its own switch + cursor.
 *  • connect / disconnect = the **switch**; `autoSync` gates periodic syncing.
 *  • **heartbeat**: pings each connected account; on failure flips the switch off.
 *  • per-account **incremental** sync → pushes to the cloud (unidirectional).
 *  • **scheduler** via chrome.alarms.
 */
import { pushCapturedItems } from "../cloud-sync.service";
import { getValidIdToken } from "../cloud-auth.service";
import { xConnector } from "./x-bookmarks";
import { redditConnector } from "./reddit-saved";
import { instagramConnector } from "./instagram-saved";
import { connectorKey, type ConnectorModule, type ConnectorPlatform, type ConnectorState } from "./types";

export const CONNECTOR_MODULES: Record<ConnectorPlatform, ConnectorModule> = {
  x: xConnector,
  reddit: redditConnector,
  instagram: instagramConnector,
};

const STORE_KEY = "vibesearch:connectors";
export const CONNECTOR_SYNC_ALARM = "vibesearch:connectors-sync";

/** Platforms with a cancel requested for their in-flight sync. */
const cancelRequested = new Set<ConnectorPlatform>();

/** Ask an in-progress sync for a platform to stop as soon as it can. */
export function cancelConnectorSync(platform: ConnectorPlatform): void {
  cancelRequested.add(platform);
}

type StateMap = Record<string, ConnectorState>;

async function loadStates(): Promise<StateMap> {
  try {
    const row = await chrome.storage.local.get(STORE_KEY);
    const map = row?.[STORE_KEY];
    return map && typeof map === "object" ? (map as StateMap) : {};
  } catch {
    return {};
  }
}

async function saveStates(map: StateMap): Promise<void> {
  try {
    await chrome.storage.local.set({ [STORE_KEY]: map });
  } catch {
    /* best-effort */
  }
}

export async function listConnectors(): Promise<ConnectorState[]> {
  return Object.values(await loadStates());
}

/** Turn the switch ON for the platform's currently logged-in account. */
export async function connect(platform: ConnectorPlatform): Promise<ConnectorState> {
  const mod = CONNECTOR_MODULES[platform];
  const account = await mod.detectAccount();
  if (!account) {
    throw new Error(`You're not logged in to ${mod.label} in this browser. Open it, sign in, then connect.`);
  }
  const map = await loadStates();
  const key = connectorKey(platform, account.accountId);
  const prev = map[key];
  map[key] = {
    platform,
    accountId: account.accountId,
    handle: account.handle,
    displayName: account.displayName,
    connected: true,
    autoSync: prev?.autoSync ?? true,
    sinceId: prev?.sinceId,
    lastSyncAt: prev?.lastSyncAt,
    lastHeartbeatAt: Date.now(),
    lastError: undefined,
    itemCount: prev?.itemCount ?? 0,
  };
  await saveStates(map);
  return map[key];
}

/** Turn the switch OFF (keeps the cursor/history for a later reconnect). */
export async function disconnect(platform: ConnectorPlatform, accountId: string): Promise<void> {
  const map = await loadStates();
  const key = connectorKey(platform, accountId);
  if (map[key]) {
    map[key].connected = false;
    map[key].autoSync = false;
    await saveStates(map);
  }
}

export async function setAutoSync(
  platform: ConnectorPlatform,
  accountId: string,
  on: boolean,
): Promise<void> {
  const map = await loadStates();
  const key = connectorKey(platform, accountId);
  if (map[key]) {
    map[key].autoSync = on;
    await saveStates(map);
  }
}

/** Ping every connected account; flip the switch off for any whose session died. */
export async function runHeartbeats(): Promise<ConnectorState[]> {
  const map = await loadStates();
  for (const key of Object.keys(map)) {
    const state = map[key];
    if (!state.connected) continue;
    let alive = false;
    try {
      alive = await CONNECTOR_MODULES[state.platform].checkAlive();
    } catch {
      alive = false;
    }
    state.lastHeartbeatAt = Date.now();
    if (!alive) {
      state.connected = false;
      state.lastError = "Session expired — reconnect to resume syncing.";
    }
  }
  await saveStates(map);
  return Object.values(map);
}

export interface ConnectorSyncOutcome {
  platform: ConnectorPlatform;
  accountId: string;
  handle: string;
  fetched: number;
  pushed: number;
  skipped: number;
  failed: number;
  cancelled?: boolean;
  error?: string;
}

/** Incrementally sync one account's saved items → cloud, reporting live progress. */
export async function syncConnector(
  platform: ConnectorPlatform,
  accountId: string,
  onProgress?: (detail: string) => void,
): Promise<ConnectorSyncOutcome> {
  const map = await loadStates();
  const key = connectorKey(platform, accountId);
  const state = map[key];
  if (!state) throw new Error("Connector not found — connect it first.");
  const label = CONNECTOR_MODULES[platform].label;
  const base: ConnectorSyncOutcome = { platform, accountId, handle: state.handle, fetched: 0, pushed: 0, skipped: 0, failed: 0 };

  onProgress?.("Checking your Vibesearch sign-in…");
  const token = await getValidIdToken();
  if (!token) {
    state.lastError = "Sign in to Vibesearch to sync to the cloud.";
    await saveStates(map);
    return { ...base, error: state.lastError };
  }

  cancelRequested.delete(platform); // fresh run
  const shouldCancel = () => cancelRequested.has(platform);

  try {
    onProgress?.(`Reading your ${label} saved items…`);
    const { items, newestId } = await CONNECTOR_MODULES[platform].fetchSaved({
      sinceId: state.sinceId,
      onProgress,
      shouldCancel,
    });
    if (items.length === 0) {
      state.lastSyncAt = Date.now();
      state.lastError = undefined;
      await saveStates(map);
      onProgress?.(shouldCancel() ? "Sync cancelled." : "You're all caught up — no new saved items.");
      cancelRequested.delete(platform);
      return { ...base, fetched: 0 };
    }
    onProgress?.(`Found ${items.length} new item${items.length === 1 ? "" : "s"} — sending to Vibesearch…`);
    const push = await pushCapturedItems(items, {
      onProgress: (done, total) => onProgress?.(`Sending to Vibesearch… ${done}/${total}`),
      shouldCancel,
    });
    const cancelled = shouldCancel();
    cancelRequested.delete(platform);
    state.sinceId = newestId ?? state.sinceId;
    state.lastSyncAt = Date.now();
    state.itemCount += push.pushed;
    state.lastError = cancelled ? "Sync cancelled — will resume later." : push.failed ? `${push.failed} item(s) failed to sync.` : undefined;
    await saveStates(map);
    return { ...base, fetched: items.length, ...push, cancelled };
  } catch (err) {
    cancelRequested.delete(platform);
    state.lastError = err instanceof Error ? err.message : String(err);
    await saveStates(map);
    return { ...base, error: state.lastError };
  }
}

/** Sync every connected + auto-sync account. */
export async function syncAllConnected(onProgress?: (detail: string) => void): Promise<ConnectorSyncOutcome[]> {
  const out: ConnectorSyncOutcome[] = [];
  for (const s of await listConnectors()) {
    if (s.connected && s.autoSync) out.push(await syncConnector(s.platform, s.accountId, onProgress));
  }
  return out;
}

/** Register the periodic sync alarm (also runs a heartbeat each tick). */
export async function setupConnectorScheduler(intervalMinutes = 240): Promise<void> {
  try {
    await chrome.alarms.create(CONNECTOR_SYNC_ALARM, {
      periodInMinutes: Math.max(30, intervalMinutes),
      delayInMinutes: 1,
    });
  } catch {
    /* alarms unavailable */
  }
}

/** Called from the alarm handler: heartbeat, then sync the still-connected ones. */
export async function onConnectorAlarm(): Promise<void> {
  await runHeartbeats();
  await syncAllConnected();
}
