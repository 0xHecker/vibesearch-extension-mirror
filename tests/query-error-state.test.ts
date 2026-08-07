import { describe, expect, test } from "bun:test";
import { shouldPreserveSearchResultsForError } from "@src/pages/search/query-error-state";

describe("Search query error state", () => {
  test("does not erase valid results for transient supersession or bounded-capacity errors", () => {
    expect(shouldPreserveSearchResultsForError("RANK_REQUEST_SUPERSEDED")).toBe(true);
    expect(
      shouldPreserveSearchResultsForError(
        "RANK_WORKER_CAPACITY_ERROR: Query rank queue is full."
      )
    ).toBe(true);
    expect(shouldPreserveSearchResultsForError("Database failed")).toBe(false);
  });
});
