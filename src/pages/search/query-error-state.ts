const NON_DESTRUCTIVE_QUERY_ERROR_CODES = [
  "RANK_REQUEST_SUPERSEDED",
  "RANK_WORKER_CAPACITY_ERROR",
] as const;

/** Transient concurrency errors must not erase the last successfully rendered page. */
export const shouldPreserveSearchResultsForError = (message: string): boolean =>
  NON_DESTRUCTIVE_QUERY_ERROR_CODES.some((code) => message.includes(code));
