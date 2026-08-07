import { afterEach, describe, expect, it } from "bun:test";
import { fetchXBookmarks } from "../src/services/connectors/x-bookmarks";

const originalChrome = globalThis.chrome;
const originalFetch = globalThis.fetch;

const xPage = (id: string, cursor?: string) => ({
  data: {
    bookmark_timeline_v2: {
      timeline: {
        instructions: [
          {
            type: "TimelineAddEntries",
            entries: [
              {
                entryId: `tweet-${id}`,
                content: {
                  itemContent: {
                    tweet_results: {
                      result: {
                        rest_id: id,
                        legacy: { full_text: `bookmark ${id}` },
                        core: {
                          user_results: {
                            result: { legacy: { screen_name: "alice" } },
                          },
                        },
                      },
                    },
                  },
                },
              },
              ...(cursor
                ? [{
                    entryId: "cursor-bottom",
                    content: {
                      entryType: "TimelineTimelineCursor",
                      cursorType: "Bottom",
                      value: cursor,
                    },
                  }]
                : []),
            ],
          },
        ],
      },
    },
  },
});

afterEach(() => {
  globalThis.chrome = originalChrome;
  globalThis.fetch = originalFetch;
});

describe("bounded connector pagination", () => {
  it("returns and consumes a continuation cursor instead of skipping a large backlog", async () => {
    globalThis.chrome = {
      cookies: {
        get: async ({ name }: { name: string }) => ({
          value: name === "ct0" ? "csrf" : "session",
        }),
      },
    } as typeof chrome;

    const requestedUrls: string[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = String(input);
      requestedUrls.push(url);
      const isContinuation = decodeURIComponent(url).includes('"cursor":"NEXT_PAGE"');
      return new Response(
        JSON.stringify(isContinuation ? xPage("older") : xPage("newest", "NEXT_PAGE")),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }) as typeof fetch;

    const first = await fetchXBookmarks({ maxPages: 1 });
    expect(first.complete).toBe(false);
    expect(first.nextCursor).toBe("NEXT_PAGE");
    expect(first.items.map((item) => item.externalId)).toEqual(["x:newest"]);

    const second = await fetchXBookmarks({ cursor: first.nextCursor, maxPages: 1 });
    expect(second.complete).toBe(true);
    expect(second.nextCursor).toBeUndefined();
    expect(second.items.map((item) => item.externalId)).toEqual(["x:older"]);
    expect(requestedUrls).toHaveLength(2);
  });
});
