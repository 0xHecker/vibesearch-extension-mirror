import { describe, expect, test } from "bun:test";
import { getOrCreateSearchClientId } from "@src/pages/search/search-client-id";

describe("Search page client IDs", () => {
  test("keeps one stable ID per page while isolating separate pages", () => {
    const pageA = { current: null as string | null };
    const pageB = { current: null as string | null };
    let sequence = 0;
    const createId = () => `search-page-${++sequence}`;

    expect(getOrCreateSearchClientId(pageA, createId)).toBe("search-page-1");
    expect(getOrCreateSearchClientId(pageA, createId)).toBe("search-page-1");
    expect(getOrCreateSearchClientId(pageB, createId)).toBe("search-page-2");
    expect(sequence).toBe(2);
  });
});
