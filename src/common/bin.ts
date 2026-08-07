export type BinEntryKind = "space" | "folder" | "item";

export type BinEntry = {
  kind: BinEntryKind;
  id: string;
  name: string;
  subtitle: string;
  deletedAt: number;
  purgeAt: number;
  spaceId?: string;
  folderId?: string | null;
  itemCount?: number;
};

export type BinEntryCursor = Pick<BinEntry, "purgeAt" | "name" | "kind" | "id">;

export type BinContentsPage = {
  entries: BinEntry[];
  total: number;
  hasMore: boolean;
  nextCursor: BinEntryCursor | null;
};

export type BinContentsRequest = {
  limit?: number;
  after?: BinEntryCursor | null;
};

export const DEFAULT_BIN_PAGE_SIZE = 100;
export const MAX_BIN_PAGE_SIZE = 200;

/**
 * Produce a strictly newer Bin incarnation timestamp even when the browser
 * reduces clock precision. Throw instead of reusing a token at the numeric
 * limit, because token reuse could authorize a stale permanent-delete action.
 */
export const nextBinMutationTimestamp = (
  clockNow: number,
  ...previousMarkers: Array<number | null | undefined>
): number => {
  const safeClock = Number.isFinite(clockNow) ? Math.max(1, Math.ceil(clockNow)) : 1;
  let newestMarker = 0;
  for (const marker of previousMarkers) {
    if (typeof marker === "number" && Number.isFinite(marker) && marker > newestMarker) {
      newestMarker = Math.ceil(marker);
    }
  }
  const next = Math.max(safeClock, newestMarker + 1);
  if (!Number.isSafeInteger(next)) throw new Error("BIN_TIMESTAMP_UNAVAILABLE");
  return next;
};

const kindOrder: Record<BinEntryKind, number> = {
  space: 0,
  folder: 1,
  item: 2,
};

export const compareBinEntries = (
  left: BinEntryCursor,
  right: BinEntryCursor
): number =>
  (left.purgeAt || Number.MAX_SAFE_INTEGER) -
    (right.purgeAt || Number.MAX_SAFE_INTEGER) ||
  left.name.localeCompare(right.name) ||
  kindOrder[left.kind] - kindOrder[right.kind] ||
  left.id.localeCompare(right.id);

export const toBinEntryCursor = (entry: BinEntry): BinEntryCursor => ({
  purgeAt: entry.purgeAt,
  name: entry.name,
  kind: entry.kind,
  id: entry.id,
});
