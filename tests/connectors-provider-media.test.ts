import { describe, expect, it } from "bun:test";
import {
  findInstagramCursor,
  findInstagramEntryList,
  findRedditCursor,
  findRedditEntryList,
  findXCursor,
  findXEntryList,
  normalizeEntry,
} from "../src/services/connectors/harvest";
import {
  instagramSavedMediaPage,
  instagramTerminalPageWithStaleCursor,
  redditSavedMediaPage,
  xBookmarksMediaPage,
} from "./fixtures/provider-media-shapes";

const xCtx = {
  source: "twitter",
  idPrefix: "x",
  connector: "x-bookmarks",
  defaultType: "social",
  buildUrl: ({ id, handle }: { id: string; handle?: string }) =>
    `https://x.com/${handle || "i"}/status/${id}`,
};

const redditCtx = {
  source: "reddit",
  idPrefix: "reddit",
  connector: "reddit-saved",
  defaultType: "forum",
  origin: "https://www.reddit.com",
  buildUrl: ({ id }: { id: string }) => `https://www.reddit.com/${id}`,
};

const instagramCtx = {
  source: "instagram",
  idPrefix: "ig",
  connector: "instagram-saved",
  defaultType: "social",
  origin: "https://www.instagram.com",
  buildUrl: ({ code }: { code?: string }) =>
    code ? `https://www.instagram.com/p/${code}/` : "https://www.instagram.com/",
};

describe("provider media response shapes", () => {
  it("keeps one highest-bitrate X video and one full-size X photo", () => {
    const entries = findXEntryList(xBookmarksMediaPage);
    expect(entries).toHaveLength(2);

    const photo = normalizeEntry(entries[0], xCtx)!;
    expect(photo.media).toEqual([{
      type: "image",
      url: "https://pbs.twimg.com/media/photo-1.jpg",
      id: "3_photo-1",
      width: 2048,
      height: 1365,
      altText: "Sunlight crossing a mountain ridge",
      provider: "twitter",
      externalId: "3_photo-1",
    }]);

    const video = normalizeEntry(entries[1], xCtx)!;
    expect(video.media).toEqual([{
      type: "video",
      url: "https://video.twimg.com/ext_tw_video/video-1/pu/vid/1280x720/high.mp4",
      thumbnailUrl: "https://pbs.twimg.com/ext_tw_video_thumb/video-1/pu/img/cover.jpg",
      id: "7_video-1",
      mimeType: "video/mp4",
      width: 1280,
      height: 720,
      durationSec: 12.4,
      altText: "A train passing through snowy trees",
      provider: "twitter",
      externalId: "7_video-1",
    }]);
    expect(findXCursor(xBookmarksMediaPage)).toBe("X_BOTTOM_CURSOR");
  });

  it("uses only Reddit's outer saved-listing children", () => {
    const entries = findRedditEntryList(redditSavedMediaPage);
    expect(entries).toHaveLength(4);
    expect(entries.map((entry) => normalizeEntry(entry, redditCtx)?.externalId)).toEqual([
      "reddit:t3_single_photo",
      "reddit:t3_gallery",
      "reddit:t3_hosted_video",
      "reddit:t1_saved_comment",
    ]);
    expect(findRedditCursor(redditSavedMediaPage)).toBe("t3_PAGE_TWO");
  });

  it("collapses Reddit preview resolutions to the source image", () => {
    const entry = redditSavedMediaPage.data.children[0];
    const item = normalizeEntry(entry, redditCtx)!;
    expect(item.media).toEqual([{
      type: "image",
      url: "https://preview.redd.it/single-photo.jpg?auto=webp&s=source",
      width: 2048,
      height: 1365,
      provider: "reddit",
    }]);
  });

  it("preserves Reddit gallery order with one source per gallery slide", () => {
    const entry = redditSavedMediaPage.data.children[1];
    const item = normalizeEntry(entry, redditCtx)!;
    expect(item.media).toEqual([
      {
        type: "image",
        url: "https://preview.redd.it/gallery-b.png?auto=webp&s=source",
        id: "gallery-b",
        mimeType: "image/png",
        width: 1536,
        height: 2048,
        altText: "Second upload, shown first",
        provider: "reddit",
        externalId: "gallery-b",
      },
      {
        type: "image",
        url: "https://preview.redd.it/gallery-a.jpg?auto=webp&s=source",
        id: "gallery-a",
        mimeType: "image/jpeg",
        width: 1800,
        height: 1200,
        altText: "First upload, shown second",
        provider: "reddit",
        externalId: "gallery-a",
      },
    ]);
  });

  it("represents a Reddit hosted video once and carries its preview metadata", () => {
    const entry = redditSavedMediaPage.data.children[2];
    const item = normalizeEntry(entry, redditCtx)!;
    expect(item.media).toEqual([{
      type: "video",
      url: "https://v.redd.it/hosted-video/DASH_1080.mp4?source=fallback",
      thumbnailUrl: "https://preview.redd.it/hosted-video.jpg?auto=webp&s=source",
      mimeType: "video/mp4",
      width: 1920,
      height: 1080,
      durationSec: 31,
      provider: "reddit",
    }]);
  });

  it("does not turn a URL mentioned in a saved Reddit comment into API media", () => {
    const entry = redditSavedMediaPage.data.children[3];
    const item = normalizeEntry(entry, redditCtx)!;
    expect(item.externalId).toBe("reddit:t1_saved_comment");
    expect(item.media).toEqual([]);
  });

  it("keeps an Instagram carousel as one item with one best candidate per slide", () => {
    const entries = findInstagramEntryList(instagramSavedMediaPage);
    expect(entries).toHaveLength(2);
    const item = normalizeEntry(entries[0], instagramCtx)!;
    expect(item.externalId).toBe("ig:9001");
    expect(item.media).toEqual([
      {
        type: "image",
        url: "https://scontent.cdninstagram.com/slide-photo-1440.jpg",
        id: "slide-photo",
        width: 1440,
        height: 1800,
        altText: "A red door beside a flowering tree",
        provider: "instagram",
        externalId: "slide-photo",
      },
      {
        type: "video",
        url: "https://scontent.cdninstagram.com/slide-video-1920.mp4",
        thumbnailUrl: "https://scontent.cdninstagram.com/slide-video-cover-1920.jpg",
        id: "slide-video",
        width: 1920,
        height: 1080,
        durationSec: 7.25,
        altText: "Waves rolling onto a quiet beach",
        provider: "instagram",
        externalId: "slide-video",
      },
    ]);
  });

  it("chooses one highest-resolution Instagram video candidate", () => {
    const entries = findInstagramEntryList(instagramSavedMediaPage);
    const item = normalizeEntry(entries[1], instagramCtx)!;
    expect(item.media).toEqual([{
      type: "video",
      url: "https://scontent.cdninstagram.com/reel-1080.mp4",
      thumbnailUrl: "https://scontent.cdninstagram.com/reel-cover-1080.jpg",
      id: "9002",
      width: 1080,
      height: 1920,
      durationSec: 18.6,
      altText: "A potter shaping clay on a wheel",
      provider: "instagram",
      externalId: "9002",
    }]);
  });

  it("does not follow an Instagram stale cursor when more_available is false", () => {
    expect(findInstagramCursor(instagramTerminalPageWithStaleCursor)).toBeUndefined();
  });
});
