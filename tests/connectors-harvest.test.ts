import { describe, it, expect } from "bun:test";
import {
  findCursor,
  findEntryList,
  findInstagramEntryList,
  findRedditEntryList,
  findXEntryList,
  normalizeEntry,
} from "../src/services/connectors/harvest";

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
    const entries = findXEntryList(payload);
    expect(entries.length).toBeGreaterThanOrEqual(1);
    const item = normalizeEntry(entries[0], xCtx)!;
    expect(item.externalId).toBe("x:111");
    expect(item.textContent).toContain("hello world");
    expect(item.authorUsername).toBe("alice");
    expect(item.media?.[0]).toMatchObject({ type: "image", url: "https://pbs.twimg.com/a.jpg" });
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
    expect(item.type).toBe("social");
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
    const entries = findRedditEntryList(payload);
    const item = normalizeEntry(entries[0], {
      source: "reddit",
      idPrefix: "reddit",
      connector: "reddit-saved",
      defaultType: "forum",
      origin: "https://www.reddit.com",
      buildUrl: ({ id }) => `https://www.reddit.com/${id}`,
    })!;
    expect(item.externalId).toBe("reddit:t3_abc");
    expect(item.title).toBe("A saved post");
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
    const entries = findInstagramEntryList(payload);
    const item = normalizeEntry(entries[0], {
      source: "instagram",
      idPrefix: "ig",
      connector: "instagram-saved",
      defaultType: "social",
      origin: "https://www.instagram.com",
      buildUrl: ({ code }) => (code ? `https://www.instagram.com/p/${code}/` : "https://www.instagram.com/"),
    })!;
    expect(item.externalId).toBe("ig:999");
    expect(item.textContent).toBe("a nice photo");
    expect(item.authorUsername).toBe("dave");
    expect(item.url).toBe("https://www.instagram.com/p/ABC123/");
    expect(item.media?.[0]?.url).toBe("https://scontent.cdninstagram.com/p.jpg");
    expect(item.media?.[0]?.type).toBe("image");
    expect(item.type).toBe("social");
    expect(item.createdAt).toBeUndefined();
    expect(item.metadata?.social?.postedAt).toBe(1751328000000);
    expect(findCursor(payload)).toBe("NEXTIG");
  });

  it("keeps one X bookmark when the tweet contains a four-photo gallery", () => {
    const payload = {
      data: {
        bookmark_timeline_v2: {
          timeline: {
            instructions: [{
              type: "TimelineAddEntries",
              entries: [{
                entryId: "tweet-111",
                content: {
                  itemContent: {
                    tweet_results: {
                      result: {
                        rest_id: "111",
                        legacy: {
                          full_text: "one saved gallery",
                          entities: {
                            user_mentions: [
                              { id_str: "998", name: "Mention One", screen_name: "mention_one" },
                              { id_str: "999", name: "Mention Two", screen_name: "mention_two" },
                            ],
                          },
                          extended_entities: {
                            media: [1, 2, 3, 4].map((index) => ({
                              id_str: `m${index}`,
                              type: "photo",
                              media_url_https: `https://pbs.twimg.com/${index}.jpg`,
                            })),
                          },
                        },
                        core: {
                          user_results: {
                            result: {
                              rest_id: "42",
                              legacy: {
                                name: "Alice Example",
                                screen_name: "alice",
                                profile_image_url_https: "https://pbs.twimg.com/alice.jpg",
                                verified: true,
                              },
                            },
                          },
                        },
                      },
                    },
                  },
                },
              }],
            }],
          },
        },
      },
    };

    const entries = findXEntryList(payload);
    expect(entries).toHaveLength(1);
    const item = normalizeEntry(entries[0], xCtx)!;
    expect(item.externalId).toBe("x:111");
    expect(item.authorUsername).toBe("alice");
    expect(item.media).toHaveLength(4);
    expect(item.media?.every((media) => media.type === "image")).toBe(true);
    expect(item.metadata?.sourceRecords).toHaveLength(1);
    expect(item.metadata?.social?.author).toMatchObject({
      id: "42",
      name: "Alice Example",
      handle: "alice",
      verified: true,
    });
  });

  it("credits a licensed-music reel to its poster, not the song's artist", () => {
    const artist = {
      pk: "266319242",
      username: "theweeknd",
      full_name: "Abel",
      profile_pic_url: "https://scontent.cdninstagram.com/artist.jpg",
      is_verified: true,
    };
    const payload = {
      items: [
        {
          media: {
            pk: "3973717440187449358",
            code: "DclevVMJcAO",
            taken_at: 1787924171,
            // Instagram puts the soundtrack, tags and comments before the owner.
            clips_metadata: {
              audio_type: "licensed_music",
              music_info: {
                music_asset_info: { title: "Blinding Lights (Extended Radio Edit)", display_artist: "The Weeknd" },
                music_consumption_info: { ig_artist: artist },
              },
            },
            usertags: { in: [{ user: { pk: "11", username: "tagged.friend", full_name: "Tagged Friend", profile_pic_url: "https://scontent.cdninstagram.com/t.jpg" } }] },
            preview_comments: [{ text: "This comment is much longer than the caption and is not what the post says.", user: artist }],
            caption: { text: "Hot chicken, done right" },
            user: {
              pk: "4242",
              username: "bangalore.eats",
              full_name: "Bangalore Eats",
              profile_pic_url: "https://scontent.cdninstagram.com/owner.jpg",
            },
          },
        },
      ],
    };
    const item = normalizeEntry(findInstagramEntryList(payload)[0], {
      source: "instagram",
      idPrefix: "ig",
      connector: "instagram-saved",
      defaultType: "social",
      buildUrl: ({ code }) => `https://www.instagram.com/p/${code}/`,
    })!;
    expect(item.authorUsername).toBe("bangalore.eats");
    expect(item.textContent).toBe("Hot chicken, done right");
  });

  it("keeps an Instagram carousel as one saved social post", () => {
    const payload = {
      items: [{
        media: {
          pk: "999",
          code: "CAROUSEL",
          caption: { text: "three places I loved" },
          user: { pk: "7", username: "dave", full_name: "Dave Example" },
          carousel_media: [1, 2, 3].map((index) => ({
            pk: `slide-${index}`,
            image_versions2: {
              candidates: [{ url: `https://scontent.cdninstagram.com/${index}.jpg` }],
            },
          })),
        },
      }],
    };

    const entries = findInstagramEntryList(payload);
    expect(entries).toHaveLength(1);
    const item = normalizeEntry(entries[0], {
      source: "instagram",
      idPrefix: "ig",
      connector: "instagram-saved",
      defaultType: "social",
      buildUrl: ({ code }) => `https://www.instagram.com/p/${code}/`,
    })!;
    expect(item.externalId).toBe("ig:999");
    expect(item.type).toBe("social");
    expect(item.media).toHaveLength(3);
  });
});
