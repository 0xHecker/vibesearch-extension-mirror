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
import { getCloudAuthToken } from "../cloud-auth";
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
export const CONNECTOR_CONTINUATION_ALARM = "vibesearch:connectors-continuation";

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
  for (const existing of Object.values(map)) {
    if (existing.platform === platform && existing.accountId !== account.accountId) {
      existing.connected = false;
      existing.autoSync = false;
      existing.lastError = `Browser session changed to @${account.handle}; reconnect this account to resume.`;
    }
  }
  map[key] = {
    platform,
    accountId: account.accountId,
    handle: account.handle,
    displayName: account.displayName,
    connected: true,
    autoSync: prev?.autoSync ?? true,
    sinceId: prev?.sinceId,
    continuationCursor: prev?.continuationCursor,
    pendingNewestId: prev?.pendingNewestId,
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
      alive = await CONNECTOR_MODULES[state.platform].checkAlive(state.accountId);
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
  hasMore?: boolean;
  error?: string;
}

type ConnectorCursorCommitInput = Pick<
  ConnectorSyncOutcome,
  "fetched" | "pushed" | "skipped" | "failed"
> & { cancelled: boolean };

export const shouldAdvanceConnectorCursor = ({
  fetched,
  pushed,
  skipped,
  failed,
  cancelled,
}: ConnectorCursorCommitInput): boolean =>
  !cancelled && failed === 0 && pushed + skipped === fetched;

const scheduleConnectorContinuation = async (): Promise<void> => {
  try {
    await chrome.alarms.create(CONNECTOR_CONTINUATION_ALARM, {
      delayInMinutes: 1,
    });
  } catch {
    /* alarms unavailable */
  }
};

const syncInFlight = new Map<string, Promise<ConnectorSyncOutcome>>();

/** Incrementally sync one account's saved items → cloud, reporting live progress. */
async function runConnectorSync(
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
  const token = await getCloudAuthToken();
  if (!token) {
    state.lastError = "Sign in to Vibesearch to sync to the cloud.";
    await saveStates(map);
    return { ...base, error: state.lastError };
  }

  cancelRequested.delete(platform); // fresh run
  const shouldCancel = () => cancelRequested.has(platform);

  try {
    onProgress?.(`Reading your ${label} saved items…`);
    const { items, newestId, nextCursor, complete } = await CONNECTOR_MODULES[platform].fetchSaved({
      sinceId: state.sinceId,
      cursor: state.continuationCursor,
      onProgress,
      shouldCancel,
    });
    if (items.length === 0) {
      const cancelled = shouldCancel();
      cancelRequested.delete(platform);
      state.lastSyncAt = Date.now();
      if (cancelled) {
        state.lastError = "Sync cancelled — will resume later.";
      } else if (complete) {
        state.sinceId = state.pendingNewestId ?? state.sinceId;
        state.continuationCursor = undefined;
        state.pendingNewestId = undefined;
        state.lastError = undefined;
      } else if (nextCursor) {
        state.continuationCursor = nextCursor;
        state.pendingNewestId = state.pendingNewestId ?? newestId;
        state.lastError = "More saved items remain; sync will resume shortly.";
        void scheduleConnectorContinuation();
      } else {
        state.lastError = "Sync paused before the remote backlog was complete; it will retry.";
      }
      await saveStates(map);
      let progressDetail = "More saved items remain; continuing shortly.";
      if (cancelled) progressDetail = "Sync cancelled.";
      else if (complete) progressDetail = "You're all caught up — no new saved items.";
      onProgress?.(progressDetail);
      return { ...base, fetched: 0, cancelled, hasMore: !complete };
    }
    onProgress?.(`Found ${items.length} new item${items.length === 1 ? "" : "s"} — sending to Vibesearch…`);
    const push = await pushCapturedItems(items, {
      onProgress: (done, total) => onProgress?.(`Sending to Vibesearch… ${done}/${total}`),
      shouldCancel,
    });
    const cancelled = shouldCancel();
    cancelRequested.delete(platform);
    const batchCommitted = shouldAdvanceConnectorCursor({
      fetched: items.length,
      ...push,
      cancelled,
    });
    const resumable = complete || Boolean(nextCursor);
    const progressCommitted = batchCommitted && resumable;
    if (progressCommitted && complete) {
      state.sinceId = state.pendingNewestId ?? newestId ?? state.sinceId;
      state.continuationCursor = undefined;
      state.pendingNewestId = undefined;
    } else if (progressCommitted && nextCursor) {
      state.continuationCursor = nextCursor;
      state.pendingNewestId = state.pendingNewestId ?? newestId;
      void scheduleConnectorContinuation();
    }
    state.lastSyncAt = Date.now();
    state.itemCount += push.pushed;
    if (cancelled) {
      state.lastError = "Sync cancelled — will resume later.";
    } else if (push.failed) {
      state.lastError = `${push.failed} item(s) failed to sync; they will be retried.`;
    } else if (!progressCommitted) {
      state.lastError = "Sync incomplete; remaining items will be retried.";
    } else if (complete) {
      state.lastError = undefined;
    } else {
      state.lastError = "More saved items remain; sync will resume shortly.";
    }
    await saveStates(map);
    return { ...base, fetched: items.length, ...push, cancelled, hasMore: !complete };
  } catch (err) {
    cancelRequested.delete(platform);
    state.lastError = err instanceof Error ? err.message : String(err);
    await saveStates(map);
    return { ...base, error: state.lastError };
  }
}

export function syncConnector(
  platform: ConnectorPlatform,
  accountId: string,
  onProgress?: (detail: string) => void,
): Promise<ConnectorSyncOutcome> {
  const key = connectorKey(platform, accountId);
  const existing = syncInFlight.get(key);
  if (existing) return existing;
  const operation = runConnectorSync(platform, accountId, onProgress).finally(() => {
    if (syncInFlight.get(key) === operation) syncInFlight.delete(key);
  });
  syncInFlight.set(key, operation);
  return operation;
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
