import { describe, it, expect } from "bun:test";
import { findEntryList, normalizeEntry, findCursor } from "../src/services/connectors/harvest";

const xCtx = {
  source: "twitter",
  idPrefix: "x",
  connector: "x-bookmarks",
  defaultType: "social",
  buildUrl: ({ id, handle }: { id: string; handle?: string }) => `https://x.com/${handle || "i"}/status/${id}`,
};

describe("harvest — shape-agnostic extraction", () => {
  it("extracts a tweet from the nested GraphQL bookmarks shape", () => {
    const payload = {
      data: {
        bookmark_timeline_v2: {
          timeline: {
            instructions: [
              {
                type: "TimelineAddEntries",
                entries: [
                  {
                    entryId: "tweet-111",
                    content: {
                      entryType: "TimelineTimelineItem",
                      itemContent: {
                        tweet_results: {
                          result: {
                            rest_id: "111",
                            legacy: {
                              full_text: "hello world from a bookmark",
                              created_at: "Wed Jul 01 00:00:00 +0000 2026",
                              favorite_count: 12,
                              extended_entities: { media: [{ type: "photo", media_url_https: "https://pbs.twimg.com/a.jpg" }] },
                            },
                            core: { user_results: { result: { legacy: { screen_name: "alice" } } } },
                          },
                        },
                      },
                    },
                  },
                  { entryId: "cursor-bottom", content: { entryType: "TimelineTimelineCursor", cursorType: "Bottom", value: "CURSOR123" } },
                ],
              },
            ],
          },
        },
      },
    };
    const entries = findEntryList(payload);
    expect(entries.length).toBeGreaterThanOrEqual(1);
    const item = normalizeEntry(entries[0], xCtx)!;
    expect(item.externalId).toBe("x:111");
    expect(item.textContent).toContain("hello world");
    expect(item.authorUsername).toBe("alice");
    expect(item.media?.[0]?.url).toBe("https://pbs.twimg.com/a.jpg");
    expect(item.url).toBe("https://x.com/alice/status/111");
    expect(item.likes).toBe(12);
    expect(findCursor(payload)).toBe("CURSOR123");
  });

  it("still extracts when X renames/moves fields (resilience)", () => {
    // A totally different, flattened shape with renamed keys + a video.
    const payload = {
      items: [
        { id_str: "222", text: "the api changed shape but we still cope", user: { username: "bob" }, media: [{ video_url: "https://video.twimg.com/v.mp4" }] },
      ],
      next_cursor: "NEXT222",
    };
    const entries = findEntryList(payload);
    const item = normalizeEntry(entries[0], xCtx)!;
    expect(item.externalId).toBe("x:222");
    expect(item.textContent).toContain("still cope");
    expect(item.authorUsername).toBe("bob");
    expect(item.media?.[0]).toEqual({ type: "video", url: "https://video.twimg.com/v.mp4" });
    expect(item.type).toBe("video");
    expect(findCursor(payload)).toBe("NEXT222");
  });

  it("extracts reddit saved children + resolves the relative permalink", () => {
    const payload = {
      data: {
        after: "t3_next",
        children: [
          {
            kind: "t3",
            data: {
              name: "t3_abc",
              title: "A saved post",
              selftext: "the longer body text of the saved post",
              author: "carol",
              permalink: "/r/test/comments/abc/a_saved_post/",
              ups: 42,
              created_utc: 1751328000,
              preview: { images: [{ source: { url: "https://i.redd.it/x.jpg" } }] },
            },
          },
        ],
      },
    };
    const entries = findEntryList(payload);
    const item = normalizeEntry(entries[0], {
      source: "reddit",
      idPrefix: "reddit",
      connector: "reddit-saved",
      defaultType: "link",
      origin: "https://www.reddit.com",
      buildUrl: ({ id }) => `https://www.reddit.com/${id}`,
    })!;
    expect(item.externalId).toBe("reddit:t3_abc");
    expect(item.textContent).toContain("longer body text");
    expect(item.authorUsername).toBe("carol");
    expect(item.url).toBe("https://www.reddit.com/r/test/comments/abc/a_saved_post/");
    expect(item.upvotes).toBe(42);
    expect(findCursor(payload)).toBe("t3_next");
  });

  it("extracts instagram saved media + builds the /p/<code>/ url", () => {
    const payload = {
      items: [
        {
          media: {
            pk: "999",
            code: "ABC123",
            caption: { text: "a nice photo" },
            user: { username: "dave" },
            like_count: 7,
            taken_at: 1751328000,
            image_versions2: { candidates: [{ url: "https://scontent.cdninstagram.com/p.jpg" }] },
          },
        },
      ],
      next_max_id: "NEXTIG",
      more_available: true,
    };
    const entries = findEntryList(payload);
    const item = normalizeEntry(entries[0], {
      source: "instagram",
      idPrefix: "ig",
      connector: "instagram-saved",
      defaultType: "image",
      origin: "https://www.instagram.com",
      buildUrl: ({ code }) => (code ? `https://www.instagram.com/p/${code}/` : "https://www.instagram.com/"),
    })!;
    expect(item.externalId).toBe("ig:999");
    expect(item.textContent).toBe("a nice photo");
    expect(item.authorUsername).toBe("dave");
    expect(item.url).toBe("https://www.instagram.com/p/ABC123/");
    expect(item.media?.[0]?.url).toBe("https://scontent.cdninstagram.com/p.jpg");
    expect(findCursor(payload)).toBe("NEXTIG");
  });
});
