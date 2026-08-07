/**
 * A space never receives more than this many imported items. Loading that
 * bounded set in one request makes a selected space complete without turning
 * a cross-space/global search into an unbounded query.
 */
export const MAX_GRID_QUERY_LIMIT = 500;

/**
 * Keep the mounted result/media tree bounded. Callers may explicitly request
 * more (up to MAX_GRID_QUERY_LIMIT), but rendering an entire 500-item space by
 * default retains too many decoded images and embedded media players.
 */
export const DEFAULT_GRID_PAGE_LIMIT = 100;

/** Explicit `page:` directives keep offset semantics; implicit pages use a
 * stable rank cursor for both browsing and active searches. */
export const shouldUseCursorPagination = (pageDirective?: number): boolean =>
  pageDirective === undefined;

/**
 * Keep ranking bounded while growing the candidate window ahead of a deep
 * cursor page. The one-page lookahead is what lets the current page truthfully
 * advertise a next page beyond the original fixed score budget.
 */
export const getSearchScoreBudget = (input: {
  page: number;
  limit: number;
  minimum: number;
  maximum: number;
  multiplier: number;
}): number => {
  const page = Math.max(1, Math.floor(input.page) || 1);
  const limit = Math.max(1, Math.floor(input.limit) || 1);
  const minimum = Math.max(1, Math.floor(input.minimum) || 1);
  const maximum = Math.max(minimum, Math.floor(input.maximum) || minimum);
  const multiplier = Math.max(1, Math.floor(input.multiplier) || 1);
  const baseline = limit * multiplier;
  const cursorWindowWithLookahead = (page + 1) * limit;
  return Math.min(maximum, Math.max(minimum, baseline, cursorWindowWithLookahead));
};

export type LookaheadPage<T> = {
  items: T[];
  hasMore: boolean;
  /**
   * Exact only when this page has no lookahead row. Counting every matching
   * document would make opening a space needlessly expensive.
   */
  total: number;
  totalIsExact: boolean;
};

export const splitLookaheadPage = <T>(
  documents: readonly T[],
  limit: number,
  offset: number
): LookaheadPage<T> => {
  const hasMore = documents.length > limit;
  const items = hasMore ? documents.slice(0, limit) : [...documents];

  return {
    items,
    hasMore,
    total: offset + items.length,
    totalIsExact: !hasMore,
  };
};
