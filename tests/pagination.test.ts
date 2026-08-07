import { describe, expect, test } from "bun:test";
import {
  DEFAULT_GRID_PAGE_LIMIT,
  getSearchScoreBudget,
  MAX_GRID_QUERY_LIMIT,
  shouldUseCursorPagination,
  splitLookaheadPage,
} from "../src/search-core/pagination";

describe("database lookahead pagination", () => {
  test("does not report the lookahead document as a fake total", () => {
    const page = splitLookaheadPage(Array.from({ length: 101 }, (_, index) => index), 100, 0);

    expect(page.items).toHaveLength(100);
    expect(page.hasMore).toBe(true);
    expect(page.total).toBe(100);
    expect(page.totalIsExact).toBe(false);
  });

  test("reports an exact total at the end of the result set", () => {
    const page = splitLookaheadPage(Array.from({ length: 476 }, (_, index) => index), 500, 0);

    expect(page.items).toHaveLength(476);
    expect(page.hasMore).toBe(false);
    expect(page.total).toBe(476);
    expect(page.totalIsExact).toBe(true);
  });

  test("caps explicit large grid requests", () => {
    expect(MAX_GRID_QUERY_LIMIT).toBe(500);
  });

  test("keeps the default rendered page bounded below the import cap", () => {
    expect(DEFAULT_GRID_PAGE_LIMIT).toBe(100);
    expect(DEFAULT_GRID_PAGE_LIMIT).toBeLessThan(MAX_GRID_QUERY_LIMIT);
  });

  test("uses cursor pagination for implicit search pages, not only browse pages", () => {
    expect(shouldUseCursorPagination(undefined)).toBe(true);
    expect(shouldUseCursorPagination(3)).toBe(false);
  });

  test("grows the bounded score window far enough to expose deep cursor pages", () => {
    expect(
      getSearchScoreBudget({
        page: 1,
        limit: 100,
        minimum: 600,
        maximum: 4_000,
        multiplier: 8,
      })
    ).toBe(800);
    expect(
      getSearchScoreBudget({
        page: 12,
        limit: 100,
        minimum: 600,
        maximum: 4_000,
        multiplier: 8,
      })
    ).toBe(1_300);
    expect(
      getSearchScoreBudget({
        page: 100,
        limit: 100,
        minimum: 600,
        maximum: 4_000,
        multiplier: 8,
      })
    ).toBe(4_000);
  });
});
