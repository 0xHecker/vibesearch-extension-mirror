import { afterEach, describe, expect, it } from "bun:test";
import { instagramConnector } from "../src/services/connectors/instagram-saved";
import { SOCIAL_SAVED_SYNC_ITEM_LIMIT } from "../src/services/connectors/saved-sync-window";
import { fetchXBookmarks } from "../src/services/connectors/x-bookmarks";

const originalChrome = globalThis.chrome;
const originalFetch = globalThis.fetch;

const xEntry = (id: string) => ({
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
});

const xPage = (id: string | string[], cursor?: string) => ({
  data: {
    bookmark_timeline_v2: {
      timeline: {
        instructions: [
          {
            type: "TimelineAddEntries",
            entries: [
              ...(Array.isArray(id) ? id : [id]).map(xEntry),
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

  it("stops X at the newest sync window without leaving a cursor", async () => {
    globalThis.chrome = {
      cookies: {
        get: async ({ name }: { name: string }) => ({
          value: name === "ct0" ? "csrf" : "session",
        }),
      },
    } as typeof chrome;
    const ids = Array.from(
      { length: SOCIAL_SAVED_SYNC_ITEM_LIMIT + 1 },
      (_, index) => String(10_000 - index),
    );
    globalThis.fetch = (async () => Response.json(xPage(ids, "OLDER_PAGE"))) as typeof fetch;

    const result = await fetchXBookmarks({ maxPages: 1 });

    expect(result.items).toHaveLength(SOCIAL_SAVED_SYNC_ITEM_LIMIT);
    expect(result.items[0]?.externalId).toBe("x:10000");
    expect(result.items.at(-1)?.externalId).toBe("x:9801");
    expect(result.newestId).toBe("10000");
    expect(result.complete).toBe(true);
    expect(result.nextCursor).toBeUndefined();
  });

  it("stops Instagram at the newest sync window without leaving a cursor", async () => {
    globalThis.chrome = {
      cookies: {
        get: async ({ name }: { name: string }) => ({
          value: name === "ds_user_id" ? "42" : "session",
        }),
      },
    } as typeof chrome;
    const items = Array.from(
      { length: SOCIAL_SAVED_SYNC_ITEM_LIMIT + 1 },
      (_, index) => ({
        media: {
          pk: String(20_000 - index),
          code: `POST${index}`,
          caption: { text: `saved post ${index}` },
          user: { username: "alice" },
        },
      }),
    );
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/accounts/current_user/")) {
        return Response.json({ user: { username: "alice" } });
      }
      return Response.json({ items, next_max_id: "OLDER_PAGE", more_available: true });
    }) as typeof fetch;

    const result = await instagramConnector.fetchSaved({ maxPages: 1 });

    expect(result.items).toHaveLength(SOCIAL_SAVED_SYNC_ITEM_LIMIT);
    expect(result.items[0]?.externalId).toBe("ig:20000");
    expect(result.items.at(-1)?.externalId).toBe("ig:19801");
    expect(result.newestId).toBe("20000");
    expect(result.complete).toBe(true);
    expect(result.nextCursor).toBeUndefined();
  });
});
