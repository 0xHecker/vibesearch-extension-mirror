import type { CapturedItem } from "./cloud-push";

/** Bound one newest-first social sync so a large backlog cannot monopolize a run. */
export const SOCIAL_SAVED_SYNC_ITEM_LIMIT = 200;

export type SavedSyncWindow = {
  items: CapturedItem[];
  newestId?: string;
  stopReason?: "known-item" | "item-limit";
};

/** Select the next part of a newest-first page without leaking policy into a connector loop. */
export function selectSavedSyncWindow(
  candidates: readonly CapturedItem[],
  options: {
    externalIdPrefix: string;
    sinceId?: string;
    remaining: number;
  },
): SavedSyncWindow {
  const limit = Math.max(0, Math.floor(options.remaining));
  if (limit === 0) return { items: [], stopReason: "item-limit" };

  const items: CapturedItem[] = [];
  let newestId: string | undefined;
  for (const candidate of candidates) {
    const rawId = candidate.externalId.startsWith(options.externalIdPrefix)
      ? candidate.externalId.slice(options.externalIdPrefix.length)
      : candidate.externalId;
    newestId ??= rawId;
    if (options.sinceId && rawId === options.sinceId) {
      return { items, newestId, stopReason: "known-item" };
    }
    items.push(candidate);
    if (items.length === limit) {
      return { items, newestId, stopReason: "item-limit" };
    }
  }
  return { items, newestId };
}
