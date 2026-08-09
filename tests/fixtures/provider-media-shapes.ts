/**
 * Trimmed response fixtures that preserve the media/list/cursor structures used
 * by the providers. Signed query strings and unrelated account fields are
 * shortened, but logical nesting and variant ordering mirror live payloads.
 */

const xUser = {
  rest_id: "42",
  legacy: {
    name: "Alice Example",
    screen_name: "alice",
    profile_image_url_https: "https://pbs.twimg.com/profile_images/alice_normal.jpg",
  },
};

export const xBookmarksMediaPage = {
  data: {
    bookmark_timeline_v2: {
      timeline: {
        instructions: [{
          type: "TimelineAddEntries",
          entries: [
            {
              entryId: "tweet-7001",
              sortIndex: "7001",
              content: {
                entryType: "TimelineTimelineItem",
                itemContent: {
                  itemType: "TimelineTweet",
                  tweet_results: {
                    result: {
                      __typename: "Tweet",
                      rest_id: "7001",
                      core: { user_results: { result: xUser } },
                      legacy: {
                        full_text: "A full-resolution X photo",
                        entities: {
                          media: [{
                            id_str: "photo-1",
                            type: "photo",
                            media_url_https: "https://pbs.twimg.com/media/photo-1.jpg",
                          }],
                        },
                        extended_entities: {
                          media: [{
                            id_str: "photo-1",
                            media_key: "3_photo-1",
                            type: "photo",
                            media_url_https: "https://pbs.twimg.com/media/photo-1.jpg",
                            ext_alt_text: "Sunlight crossing a mountain ridge",
                            original_info: { width: 2048, height: 1365 },
                          }],
                        },
                      },
                    },
                  },
                },
              },
            },
            {
              entryId: "tweet-7002",
              sortIndex: "7002",
              content: {
                entryType: "TimelineTimelineItem",
                itemContent: {
                  itemType: "TimelineTweet",
                  tweet_results: {
                    result: {
                      __typename: "Tweet",
                      rest_id: "7002",
                      core: { user_results: { result: xUser } },
                      legacy: {
                        full_text: "One X video, not four media records",
                        entities: {
                          media: [{
                            id_str: "video-1",
                            type: "video",
                            media_url_https: "https://pbs.twimg.com/ext_tw_video_thumb/video-1/pu/img/cover.jpg",
                          }],
                        },
                        extended_entities: {
                          media: [{
                            id_str: "video-1",
                            media_key: "7_video-1",
                            type: "video",
                            media_url_https: "https://pbs.twimg.com/ext_tw_video_thumb/video-1/pu/img/cover.jpg",
                            ext_alt_text: "A train passing through snowy trees",
                            original_info: { width: 1280, height: 720 },
                            video_info: {
                              aspect_ratio: [16, 9],
                              duration_millis: 12_400,
                              variants: [
                                {
                                  content_type: "application/x-mpegURL",
                                  url: "https://video.twimg.com/ext_tw_video/video-1/pu/pl/master.m3u8",
                                },
                                {
                                  bitrate: 256_000,
                                  content_type: "video/mp4",
                                  url: "https://video.twimg.com/ext_tw_video/video-1/pu/vid/320x180/low.mp4",
                                },
                                {
                                  bitrate: 832_000,
                                  content_type: "video/mp4",
                                  url: "https://video.twimg.com/ext_tw_video/video-1/pu/vid/640x360/medium.mp4",
                                },
                                {
                                  bitrate: 2_176_000,
                                  content_type: "video/mp4",
                                  url: "https://video.twimg.com/ext_tw_video/video-1/pu/vid/1280x720/high.mp4",
                                },
                              ],
                            },
                          }],
                        },
                      },
                    },
                  },
                },
              },
            },
            {
              entryId: "cursor-bottom-0",
              sortIndex: "0",
              content: {
                entryType: "TimelineTimelineCursor",
                cursorType: "Bottom",
                value: "X_BOTTOM_CURSOR",
              },
            },
          ],
        }],
      },
    },
  },
};

const redditPreview = (stem: string, width: number, height: number) => ({
  id: stem,
  source: {
    url: `https://preview.redd.it/${stem}.jpg?auto=webp&amp;s=source`,
    width,
    height,
  },
  resolutions: [
    {
      url: `https://preview.redd.it/${stem}.jpg?width=108&amp;crop=smart&amp;auto=webp&amp;s=108`,
      width: 108,
      height: Math.round(height * 108 / width),
    },
    {
      url: `https://preview.redd.it/${stem}.jpg?width=640&amp;crop=smart&amp;auto=webp&amp;s=640`,
      width: 640,
      height: Math.round(height * 640 / width),
    },
  ],
});

const nestedRedditReplies = Array.from({ length: 5 }, (_, index) => ({
  kind: "t1",
  data: {
    name: `t1_unsaved_reply_${index}`,
    body: `An embedded reply that is not itself saved (${index})`,
    author: `reply_author_${index}`,
    permalink: `/r/photography/comments/thread/post/saved_comment/reply_${index}/`,
  },
}));

export const redditSavedMediaPage = {
  kind: "Listing",
  data: {
    after: "t3_PAGE_TWO",
    dist: 4,
    children: [
      {
        kind: "t3",
        data: {
          name: "t3_single_photo",
          title: "A saved Reddit image",
          author: "photo_author",
          subreddit: "photography",
          permalink: "/r/photography/comments/single_photo/a_saved_reddit_image/",
          post_hint: "image",
          url_overridden_by_dest: "https://i.redd.it/single-photo.jpg",
          thumbnail: "https://preview.redd.it/single-photo.jpg?width=140&amp;height=93&amp;auto=webp",
          preview: { enabled: true, images: [redditPreview("single-photo", 2048, 1365)] },
        },
      },
      {
        kind: "t3",
        data: {
          name: "t3_gallery",
          title: "A two-slide Reddit gallery",
          author: "gallery_author",
          subreddit: "pics",
          permalink: "/r/pics/comments/gallery/a_two_slide_gallery/",
          is_gallery: true,
          gallery_data: {
            items: [
              { media_id: "gallery-b", id: 2, caption: "Second upload, shown first" },
              { media_id: "gallery-a", id: 1, caption: "First upload, shown second" },
            ],
          },
          media_metadata: {
            "gallery-a": {
              status: "valid",
              e: "Image",
              m: "image/jpeg",
              p: [
                { x: 108, y: 72, u: "https://preview.redd.it/gallery-a.jpg?width=108&amp;crop=smart&amp;auto=webp" },
                { x: 640, y: 427, u: "https://preview.redd.it/gallery-a.jpg?width=640&amp;crop=smart&amp;auto=webp" },
              ],
              s: { x: 1800, y: 1200, u: "https://preview.redd.it/gallery-a.jpg?auto=webp&amp;s=source" },
            },
            "gallery-b": {
              status: "valid",
              e: "Image",
              m: "image/png",
              p: [
                { x: 108, y: 144, u: "https://preview.redd.it/gallery-b.png?width=108&amp;crop=smart&amp;auto=webp" },
                { x: 640, y: 853, u: "https://preview.redd.it/gallery-b.png?width=640&amp;crop=smart&amp;auto=webp" },
              ],
              s: { x: 1536, y: 2048, u: "https://preview.redd.it/gallery-b.png?auto=webp&amp;s=source" },
            },
          },
        },
      },
      {
        kind: "t3",
        data: {
          name: "t3_hosted_video",
          title: "A saved hosted video",
          author: "video_author",
          subreddit: "videos",
          permalink: "/r/videos/comments/hosted_video/a_saved_hosted_video/",
          post_hint: "hosted:video",
          is_video: true,
          preview: { enabled: true, images: [redditPreview("hosted-video", 1920, 1080)] },
          secure_media: {
            reddit_video: {
              bitrate_kbps: 4_800,
              fallback_url: "https://v.redd.it/hosted-video/DASH_1080.mp4?source=fallback",
              height: 1080,
              width: 1920,
              scrubber_media_url: "https://v.redd.it/hosted-video/DASH_96.mp4",
              dash_url: "https://v.redd.it/hosted-video/DASHPlaylist.mpd",
              duration: 31,
              hls_url: "https://v.redd.it/hosted-video/HLSPlaylist.m3u8",
              is_gif: false,
            },
          },
          media: {
            reddit_video: {
              fallback_url: "https://v.redd.it/hosted-video/DASH_1080.mp4?source=fallback",
              height: 1080,
              width: 1920,
              duration: 31,
            },
          },
        },
      },
      {
        kind: "t1",
        data: {
          name: "t1_saved_comment",
          body: "A saved comment mentions an image URL in prose: https://i.redd.it/not-an-api-attachment.jpg",
          author: "comment_author",
          subreddit: "photography",
          link_title: "The parent submission title",
          permalink: "/r/photography/comments/thread/post/saved_comment/",
          created_utc: 1_751_328_000,
          replies: {
            kind: "Listing",
            data: { after: "t1_NESTED_DECOY", children: nestedRedditReplies },
          },
        },
      },
    ],
    before: null,
  },
};

export const instagramSavedMediaPage = {
  items: [
    {
      media: {
        pk: "9001",
        id: "9001_77",
        code: "IGCAROUSEL",
        media_type: 8,
        product_type: "carousel_container",
        caption: { text: "A photo and video carousel" },
        user: { pk: "77", username: "dave", full_name: "Dave Example" },
        carousel_media_count: 2,
        carousel_media: [
          {
            pk: "slide-photo",
            id: "slide-photo_77",
            media_type: 1,
            original_width: 1440,
            original_height: 1800,
            accessibility_caption: "A red door beside a flowering tree",
            image_versions2: {
              candidates: [
                { width: 320, height: 400, url: "https://scontent.cdninstagram.com/slide-photo-320.jpg" },
                { width: 1080, height: 1350, url: "https://scontent.cdninstagram.com/slide-photo-1080.jpg" },
                { width: 1440, height: 1800, url: "https://scontent.cdninstagram.com/slide-photo-1440.jpg" },
              ],
            },
          },
          {
            pk: "slide-video",
            id: "slide-video_77",
            media_type: 2,
            original_width: 1920,
            original_height: 1080,
            video_duration: 7.25,
            accessibility_caption: "Waves rolling onto a quiet beach",
            image_versions2: {
              candidates: [
                { width: 320, height: 180, url: "https://scontent.cdninstagram.com/slide-video-cover-320.jpg" },
                { width: 1920, height: 1080, url: "https://scontent.cdninstagram.com/slide-video-cover-1920.jpg" },
              ],
            },
            video_versions: [
              { type: 101, width: 480, height: 270, url: "https://scontent.cdninstagram.com/slide-video-480.mp4" },
              { type: 103, width: 1920, height: 1080, url: "https://scontent.cdninstagram.com/slide-video-1920.mp4" },
              { type: 102, width: 720, height: 405, url: "https://scontent.cdninstagram.com/slide-video-720.mp4" },
            ],
          },
        ],
      },
    },
    {
      pk: "9002",
      id: "9002_88",
      code: "IGVIDEO",
      media_type: 2,
      product_type: "clips",
      caption: { text: "A standalone saved reel" },
      user: { pk: "88", username: "erin", full_name: "Erin Example" },
      original_width: 1080,
      original_height: 1920,
      video_duration: 18.6,
      accessibility_caption: "A potter shaping clay on a wheel",
      image_versions2: {
        candidates: [
          { width: 270, height: 480, url: "https://scontent.cdninstagram.com/reel-cover-270.jpg" },
          { width: 1080, height: 1920, url: "https://scontent.cdninstagram.com/reel-cover-1080.jpg" },
        ],
      },
      video_versions: [
        { type: 101, width: 360, height: 640, url: "https://scontent.cdninstagram.com/reel-360.mp4" },
        { type: 103, width: 1080, height: 1920, url: "https://scontent.cdninstagram.com/reel-1080.mp4" },
        { type: 102, width: 720, height: 1280, url: "https://scontent.cdninstagram.com/reel-720.mp4" },
      ],
    },
  ],
  more_available: true,
  next_max_id: "IG_NEXT_PAGE",
  status: "ok",
};

export const instagramTerminalPageWithStaleCursor = {
  items: [{
    pk: "9010",
    code: "IGLAST",
    media_type: 1,
    caption: { text: "Last saved photo" },
    image_versions2: {
      candidates: [{ width: 1080, height: 1080, url: "https://scontent.cdninstagram.com/last.jpg" }],
    },
  }],
  more_available: false,
  next_max_id: "STALE_CURSOR_MUST_NOT_CONTINUE",
  status: "ok",
};
