import type {
  QuerySortBy,
  QuerySortOrder,
  RankableItem,
} from "@src/search-core/contracts";

export type RankOrderItem = Pick<
  RankableItem,
  "id" | "title" | "source" | "createdAt" | "updatedAt"
>;

export type RankOrderEntry = {
  item: RankOrderItem;
  relevance: number;
};

/**
 * Compare only the requested field. Equal values deliberately return zero so
 * every ranker can apply the same relevance/createdAt/id fallback chain.
 */
export const compareRankField = (
  a: RankOrderItem,
  b: RankOrderItem,
  sortBy: Exclude<QuerySortBy, "relevance">,
  sortOrder: QuerySortOrder
): number => {
  const direction = sortOrder === "asc" ? 1 : -1;

  if (sortBy === "title") {
    return direction * (a.title || "").localeCompare(b.title || "");
  }

  if (sortBy === "source") {
    return direction * (a.source || "").localeCompare(b.source || "");
  }

  const aValue = sortBy === "updatedAt" ? a.updatedAt || 0 : a.createdAt || 0;
  const bValue = sortBy === "updatedAt" ? b.updatedAt || 0 : b.createdAt || 0;
  return direction * (aValue - bValue);
};

export const compareRankRelevance = (
  a: RankOrderEntry,
  b: RankOrderEntry,
  sortOrder: QuerySortOrder
): number => {
  const direction = sortOrder === "asc" ? 1 : -1;
  if (a.relevance !== b.relevance) {
    return direction * (a.relevance - b.relevance);
  }

  const createdCompare = (b.item.createdAt || 0) - (a.item.createdAt || 0);
  if (createdCompare !== 0) return createdCompare;
  return a.item.id.localeCompare(b.item.id);
};

/** Canonical ordering shared by worker, streaming, and local fallback ranks. */
export const compareRankedEntries = (
  a: RankOrderEntry,
  b: RankOrderEntry,
  sortBy: QuerySortBy,
  sortOrder: QuerySortOrder
): number => {
  if (sortBy === "relevance") {
    return compareRankRelevance(a, b, sortOrder);
  }

  const fieldCompare = compareRankField(a.item, b.item, sortBy, sortOrder);
  return fieldCompare !== 0 ? fieldCompare : compareRankRelevance(a, b, "desc");
};

/**
 * A cursor row is exclusive by identity even if a time-sensitive relevance
 * component drifted between requests and makes that same row compare later.
 */
export const isRankedEntryAfterCursor = <Entry extends { item: { id: string } }>(
  entry: Entry,
  cursor: Entry,
  compare: (left: Entry, right: Entry) => number
): boolean => entry.item.id !== cursor.item.id && compare(entry, cursor) > 0;
