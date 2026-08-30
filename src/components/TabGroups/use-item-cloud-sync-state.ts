import * as React from "react";

/** What this device knows about one item's backup state. */
export type ItemCloudSyncState = "synced" | "pending" | "not-connected" | "unknown";

type CachedState = { value: ItemCloudSyncState; readAt: number };

const CACHE_TTL_MS = 20_000;
const cache = new Map<string, CachedState>();

/** Requests are batched per tick so hovering a grid never fans out one call per card. */
let pendingIds = new Set<string>();
let pendingFlush: Promise<void> | null = null;
const listeners = new Set<() => void>();

const notify = () => {
  for (const listener of listeners) listener();
};

const flush = async (): Promise<void> => {
  const itemIds = Array.from(pendingIds);
  pendingIds = new Set();
  pendingFlush = null;
  if (itemIds.length === 0) return;
  try {
    const response = await chrome.runtime.sendMessage({
      target: "background",
      type: "CLOUD_SYNC_ITEM_STATE",
      payload: { itemIds },
    });
    const states = (response?.payload ?? {}) as Record<string, ItemCloudSyncState>;
    const readAt = Date.now();
    for (const itemId of itemIds) {
      cache.set(itemId, { value: states[itemId] ?? "unknown", readAt });
    }
  } catch {
    const readAt = Date.now();
    for (const itemId of itemIds) cache.set(itemId, { value: "unknown", readAt });
  }
  notify();
};

const request = (itemId: string) => {
  pendingIds.add(itemId);
  pendingFlush ??= Promise.resolve().then(flush);
};

/**
 * Read one item's backup state, refreshing a stale answer in the background.
 *
 * Deliberately lazy: the badge is a hover affordance, so nothing is fetched
 * until a card actually asks, and a short TTL keeps a long session honest
 * without polling.
 */
export const useItemCloudSyncState = (itemId: string, enabled: boolean): ItemCloudSyncState => {
  const [, setTick] = React.useState(0);

  React.useEffect(() => {
    if (!enabled || !itemId) return;
    const listener = () => setTick((value) => value + 1);
    listeners.add(listener);
    const cached = cache.get(itemId);
    if (!cached || Date.now() - cached.readAt > CACHE_TTL_MS) request(itemId);
    return () => {
      listeners.delete(listener);
    };
  }, [itemId, enabled]);

  if (!enabled || !itemId) return "unknown";
  return cache.get(itemId)?.value ?? "unknown";
};

/** Forget cached answers after a sync so the badge reflects the new reality. */
export const invalidateItemCloudSyncState = (): void => {
  cache.clear();
  notify();
};

export const itemCloudSyncLabel = (state: ItemCloudSyncState): string => {
  switch (state) {
    case "synced":
      return "Backed up to your web library";
    case "pending":
      return "Waiting to back up — it will upload in the background";
    case "not-connected":
      return "On this device only. Log in with Google to back it up.";
    case "unknown":
      return "Checking backup state…";
  }
};
