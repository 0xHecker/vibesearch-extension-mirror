// Platform-aware content extraction for popular sites.
// Injected on-demand into the page context to resolve canonical entities
// (post/video/repo/article) from a clicked element, even mid-scroll.

import { getPreferredYouTubeVideoId } from "@src/utils/media-embed";

export type ExtractedContent = {
  canonicalUrl: string;
  title: string;
  author?: string;
  description?: string;
  thumbnailUrl?: string;
  mediaUrls?: Array<{ url: string; type: "image" | "video" | "audio" }>;
  platform: string;
  timestamp?: number;
};

type Adapter = (target: HTMLElement, clickedUrl?: string) => ExtractedContent | null;

// --- Utilities ---

const trim = (s: string | null | undefined, max = 500): string => {
  const v = (s || "").trim();
  return v.length <= max ? v : v.slice(0, max - 1) + "…";
};

const resolveUrl = (href: string | null | undefined, base?: string): string | null => {
  if (!href) return null;
  try {
    return new URL(href, base || window.location.href).href;
  } catch {
    return null;
  }
};

const closest = (el: HTMLElement | null, sel: string): HTMLElement | null => {
  return el?.closest(sel) as HTMLElement | null;
};

const qs = (root: HTMLElement | Document, sel: string): HTMLElement | null => {
  return root.querySelector(sel) as HTMLElement | null;
};

const qsa = (root: HTMLElement | Document, sel: string): HTMLElement[] => {
  return Array.from(root.querySelectorAll(sel));
};

const attr = (el: HTMLElement | null, name: string): string | null => {
  return el?.getAttribute(name) || null;
};

const text = (el: HTMLElement | null): string => {
  return (el?.textContent || "").trim();
};

const getMeta = (name: string): string | null => {
  const selectors = [
    `meta[property="${name}"]`,
    `meta[name="${name}"]`,
    `meta[property="og:${name}"]`,
    `meta[name="twitter:${name}"]`,
  ];
  for (const sel of selectors) {
    const el = document.querySelector(sel);
    if (el) return el.getAttribute("content") || null;
  }
  return null;
};

const getJsonLd = (): any => {
  const scripts = qsa(document, 'script[type="application/ld+json"]');
  for (const script of scripts) {
    try {
      const data = JSON.parse(script.textContent || "");
      if (data && typeof data === "object") return data;
    } catch {}
  }
  return null;
};

// --- Platform Adapters ---

const instagram: Adapter = (target) => {
  const article = closest(target, "article") || closest(target, '[role="presentation"]');
  if (!article) return null;

  // Resolve permalink from time anchor or header link
  const timeLink = qs(article, 'a[href*="/p/"], a[href*="/reel/"], a[href*="/tv/"]');
  const canonicalUrl = resolveUrl(attr(timeLink, "href"));
  if (!canonicalUrl) return null;

  // Author from header link
  const headerLink = qs(article, 'header a[href^="/"]');
  const author = text(headerLink) || attr(headerLink, "href")?.replace(/^\//, "").split("/")[0];

  // Caption from article text (first non-header text block)
  const captionEl = qs(article, 'h1, [role="button"] + span, ul + div span');
  const description = trim(text(captionEl), 300);

  // Media: images and videos in the article
  const mediaUrls: ExtractedContent["mediaUrls"] = [];
  const imgs = qsa(article, "img").filter((img) => {
    const src = attr(img, "src");
    return src && !src.includes("profile") && (img as HTMLImageElement).naturalWidth > 150;
  });
  for (const img of imgs.slice(0, 4)) {
    const url = resolveUrl(attr(img, "src"));
    if (url) mediaUrls.push({ url, type: "image" });
  }
  const videos = qsa(article, "video");
  for (const video of videos.slice(0, 2)) {
    const url = resolveUrl(attr(video, "src") || attr(qs(video, "source"), "src"));
    if (url) mediaUrls.push({ url, type: "video" });
  }

  return {
    canonicalUrl,
    title: description || "Instagram post",
    author,
    description,
    thumbnailUrl: mediaUrls[0]?.url,
    mediaUrls,
    platform: "instagram",
  };
};

const twitter: Adapter = (target) => {
  const article = closest(target, "article");
  if (!article) return null;

  // Permalink from time link
  const timeLink = qs(article, 'a[href*="/status/"]');
  const canonicalUrl = resolveUrl(attr(timeLink, "href"));
  if (!canonicalUrl) return null;

  // Author from data-testid or header link
  const authorLink =
    qs(article, '[data-testid="User-Name"] a') || qs(article, 'div[dir="ltr"] a[role="link"]');
  const author = text(authorLink) || attr(authorLink, "href")?.split("/").filter(Boolean)[0];

  // Tweet text
  const tweetText = qs(article, '[data-testid="tweetText"], [lang]');
  const description = trim(text(tweetText), 500);

  // Media
  const mediaUrls: ExtractedContent["mediaUrls"] = [];
  const imgs = qsa(article, '[data-testid="tweetPhoto"] img, [data-testid="card.layoutLarge.media"] img');
  for (const img of imgs.slice(0, 4)) {
    const url = resolveUrl(attr(img, "src"));
    if (url && !url.includes("profile_images")) mediaUrls.push({ url, type: "image" });
  }
  const videos = qsa(article, "video");
  for (const video of videos.slice(0, 2)) {
    const url = resolveUrl(attr(video, "src") || attr(qs(video, "source"), "src"));
    if (url) mediaUrls.push({ url, type: "video" });
  }

  return {
    canonicalUrl,
    title: description || "Tweet",
    author,
    description,
    thumbnailUrl: mediaUrls[0]?.url,
    mediaUrls,
    platform: "twitter",
  };
};

const youtube: Adapter = (target, clickedUrl) => {
  const clickedShortVideoId = clickedUrl?.match(/\/shorts\/([^/?#]+)/)?.[1] || null;
  const currentShortVideoId = !clickedUrl
    ? window.location.pathname.match(/\/shorts\/([^/?#]+)/)?.[1] || null
    : null;
  const shortVideoId = clickedShortVideoId || currentShortVideoId;
  if (shortVideoId) {
    const videoId = shortVideoId;
    const canonicalUrl = videoId ? `https://www.youtube.com/watch?v=${videoId}` : window.location.href;
    const titleEl = qs(document, "#title h2, ytd-reel-video-renderer h2");
    const channelEl = qs(document, "ytd-channel-name a, #channel-name a");
    return {
      canonicalUrl,
      title: trim(text(titleEl)) || "YouTube Short",
      author: text(channelEl),
      thumbnailUrl: `https://i.ytimg.com/vi/${videoId}/maxresdefault.jpg`,
      platform: "youtube",
    };
  }

  // Watch page
  const videoId = getPreferredYouTubeVideoId(clickedUrl, window.location.href);
  if (!videoId) return null;

  const canonicalUrl = `https://www.youtube.com/watch?v=${videoId}`;
  const titleEl = qs(document, "h1.ytd-watch-metadata yt-formatted-string, h1.title");
  const channelEl = qs(document, "ytd-channel-name a, #owner-name a");

  return {
    canonicalUrl,
    title: trim(text(titleEl)) || "YouTube video",
    author: text(channelEl),
    thumbnailUrl: `https://i.ytimg.com/vi/${videoId}/maxresdefault.jpg`,
    platform: "youtube",
  };
};

const reddit: Adapter = (target) => {
  const post = closest(target, '[data-testid="post-container"], shreddit-post, [data-post-click-location]');
  if (!post) return null;

  const linkEl = qs(post, 'a[data-click-id="timestamp"], a[slot="full-post-link"]');
  const canonicalUrl = resolveUrl(attr(linkEl, "href"));
  if (!canonicalUrl) return null;

  const titleEl = qs(post, 'h1, h3, [slot="title"]');
  const authorEl = qs(post, 'a[href^="/user/"], a[href^="/u/"]');
  const author = text(authorEl) || attr(authorEl, "href")?.split("/").filter(Boolean).pop();

  const mediaUrls: ExtractedContent["mediaUrls"] = [];
  const imgs = qsa(post, "img").filter((img) => (img as HTMLImageElement).naturalWidth > 200);
  for (const img of imgs.slice(0, 3)) {
    const url = resolveUrl(attr(img, "src"));
    if (url && !url.includes("avatar")) mediaUrls.push({ url, type: "image" });
  }

  return {
    canonicalUrl,
    title: trim(text(titleEl)) || "Reddit post",
    author,
    thumbnailUrl: mediaUrls[0]?.url,
    mediaUrls,
    platform: "reddit",
  };
};

const github: Adapter = (target, clickedUrl) => {
  const canonicalUrl = clickedUrl || window.location.href;
  const pathParts = window.location.pathname.split("/").filter(Boolean);
  const [owner, repo] = pathParts;

  const titleEl = qs(document, "h1 strong a, h1.gh-header-title, [data-pjax] h1");
  const title = trim(text(titleEl)) || `${owner}/${repo}`;

  // File view: extract line range from selection
  let description = "";
  if (pathParts[2] === "blob") {
    const sel = window.getSelection();
    if (sel && sel.rangeCount > 0) {
      description = trim(sel.toString(), 1000);
    }
  }

  return {
    canonicalUrl,
    title,
    author: owner,
    description,
    platform: "github",
  };
};

const tiktok: Adapter = (target) => {
  const videoId = window.location.pathname.match(/\/video\/(\d+)/)?.[1];
  if (!videoId) return null;

  const canonicalUrl = `https://www.tiktok.com/@${window.location.pathname.split("/@")[1]}`;
  const titleEl = qs(document, '[data-e2e="browse-video-desc"], h1');
  const authorEl = qs(document, '[data-e2e="browse-username"]');

  return {
    canonicalUrl,
    title: trim(text(titleEl)) || "TikTok video",
    author: text(authorEl),
    platform: "tiktok",
  };
};

const linkedin: Adapter = (target) => {
  const post = closest(target, '[data-urn], .feed-shared-update-v2');
  if (!post) return null;

  const linkEl = qs(post, 'a[href*="/feed/update/"]');
  const canonicalUrl = resolveUrl(attr(linkEl, "href"));
  if (!canonicalUrl) return null;

  const authorEl = qs(post, ".update-components-actor__name");
  const textEl = qs(post, ".feed-shared-text");

  return {
    canonicalUrl,
    title: trim(text(textEl)) || "LinkedIn post",
    author: text(authorEl),
    platform: "linkedin",
  };
};

const medium: Adapter = (target) => {
  const article = closest(target, "article");
  const articleLink = qs(article || document, 'a[href*="/@"], a[href*="/p/"]');
  const canonicalUrl = resolveUrl(attr(articleLink, "href")) || getMeta("url") || window.location.href;
  const title = text(articleLink) || getMeta("title") || text(qs(document, "h1"));
  const author = getMeta("author") || text(qs(document, 'a[rel="author"]')) || undefined;
  const description = getMeta("description");
  const thumbnailUrl = resolveUrl(getMeta("image"));

  return {
    canonicalUrl,
    title: trim(title) || "Medium article",
    author,
    description: trim(description, 300),
    thumbnailUrl: thumbnailUrl || undefined,
    platform: "medium",
  };
};

const substack: Adapter = (target) => {
  const article = closest(target, "article, .post-preview, [class*='post-preview']");
  const articleLink = qs(article || document, 'a[href*="/p/"]');
  const canonicalUrl = resolveUrl(attr(articleLink, "href")) || getMeta("url") || window.location.href;
  const title = text(articleLink) || getMeta("title") || text(qs(document, "h1.post-title"));
  const author = getMeta("author") || text(qs(document, ".author-name")) || undefined;
  const description = getMeta("description");
  const thumbnailUrl = resolveUrl(getMeta("image"));

  return {
    canonicalUrl,
    title: trim(title) || "Substack post",
    author,
    description: trim(description, 300),
    thumbnailUrl: thumbnailUrl || undefined,
    platform: "substack",
  };
};

const pinterest: Adapter = (target) => {
  const pin = closest(target, '[data-test-id="pin"], [data-test-id="pinWrapper"]');
  if (!pin) return null;

  const linkEl = qs(pin, 'a[href^="/pin/"]');
  const canonicalUrl = resolveUrl(attr(linkEl, "href"));
  if (!canonicalUrl) return null;

  const imgEl = qs(pin, "img");
  const thumbnailUrl = resolveUrl(attr(imgEl, "src"));
  const title = trim(attr(imgEl, "alt")) || "Pinterest pin";

  return {
    canonicalUrl,
    title,
    thumbnailUrl: thumbnailUrl || undefined,
    platform: "pinterest",
  };
};

const stackoverflow: Adapter = (target) => {
  const question = closest(target, ".question, [data-questionid]");
  if (!question) return null;

  const titleEl = qs(question, ".question-hyperlink, h1 a");
  const canonicalUrl = resolveUrl(attr(titleEl, "href")) || window.location.href;
  const title = trim(text(titleEl)) || "Stack Overflow question";

  return {
    canonicalUrl,
    title,
    platform: "stackoverflow",
  };
};

const hackernews: Adapter = (target) => {
  const row = closest(target, ".athing");
  if (!row) return null;

  const titleEl = qs(row, ".titleline a");
  const canonicalUrl = resolveUrl(attr(titleEl, "href"));
  if (!canonicalUrl) return null;

  return {
    canonicalUrl,
    title: trim(text(titleEl)) || "Hacker News post",
    platform: "hackernews",
  };
};

const spotify: Adapter = (target, clickedUrl) => {
  const canonicalUrl = clickedUrl || window.location.href;
  const titleEl = qs(document, 'h1[data-encore-id="type"]');
  const title = trim(text(titleEl)) || "Spotify track";

  return {
    canonicalUrl,
    title,
    platform: "spotify",
  };
};

const vimeo: Adapter = (target) => {
  const videoId = window.location.pathname.split("/").filter(Boolean)[0];
  const canonicalUrl = `https://vimeo.com/${videoId}`;
  const titleEl = qs(document, "h1");
  const authorEl = qs(document, '[itemprop="author"]');

  return {
    canonicalUrl,
    title: trim(text(titleEl)) || "Vimeo video",
    author: text(authorEl),
    platform: "vimeo",
  };
};

const twitch: Adapter = (target) => {
  const canonicalUrl = window.location.href;
  const titleEl = qs(document, 'h2[data-a-target="stream-title"]');
  const channelEl = qs(document, 'a[data-a-target="user-channel-header-item"]');

  return {
    canonicalUrl,
    title: trim(text(titleEl)) || "Twitch stream",
    author: text(channelEl),
    platform: "twitch",
  };
};

const producthunt: Adapter = (target) => {
  const post = closest(target, '[data-test="post-item"]');
  if (!post) return null;

  const linkEl = qs(post, 'a[href^="/posts/"]');
  const canonicalUrl = resolveUrl(attr(linkEl, "href"));
  if (!canonicalUrl) return null;

  const titleEl = qs(post, "h3");
  const title = trim(text(titleEl)) || "Product Hunt post";

  return {
    canonicalUrl,
    title,
    platform: "producthunt",
  };
};

const notion: Adapter = (target) => {
  const canonicalUrl = window.location.href;
  const titleEl = qs(document, '[placeholder="Untitled"], .notion-page-block');
  const title = trim(text(titleEl)) || "Notion page";

  return {
    canonicalUrl,
    title,
    platform: "notion",
  };
};

const figma: Adapter = (target) => {
  const canonicalUrl = window.location.href;
  const titleEl = qs(document, '[class*="filename"]');
  const title = trim(text(titleEl)) || "Figma file";

  return {
    canonicalUrl,
    title,
    platform: "figma",
  };
};

// --- Universal Fallback (OpenGraph + JSON-LD) ---

const universalFallback: Adapter = (target, clickedUrl) => {
  const canonicalUrl =
    clickedUrl ||
    getMeta("url") ||
    attr(qs(document, 'link[rel="canonical"]'), "href") ||
    window.location.href;

  const title =
    getMeta("title") ||
    text(qs(document, "h1")) ||
    document.title ||
    "Saved page";

  const description = getMeta("description");
  const thumbnailUrl = resolveUrl(getMeta("image"));

  let author: string | undefined;
  const jsonLd = getJsonLd();
  if (jsonLd?.author) {
    author = typeof jsonLd.author === "string" ? jsonLd.author : jsonLd.author.name;
  }
  if (!author) author = getMeta("author") ?? undefined;

  return {
    canonicalUrl,
    title: trim(title),
    author,
    description: trim(description, 300),
    thumbnailUrl: thumbnailUrl || undefined,
    platform: "web",
  };
};

// --- Adapter Registry ---

const adapters: Record<string, Adapter> = {
  "instagram.com": instagram,
  "twitter.com": twitter,
  "x.com": twitter,
  "youtube.com": youtube,
  "youtu.be": youtube,
  "reddit.com": reddit,
  "github.com": github,
  "tiktok.com": tiktok,
  "linkedin.com": linkedin,
  "medium.com": medium,
  "substack.com": substack,
  "pinterest.com": pinterest,
  "stackoverflow.com": stackoverflow,
  "news.ycombinator.com": hackernews,
  "spotify.com": spotify,
  "vimeo.com": vimeo,
  "twitch.tv": twitch,
  "producthunt.com": producthunt,
  "notion.so": notion,
  "notion.site": notion,
  "figma.com": figma,
};

// --- Public API ---

export const extractContent = (
  target: HTMLElement,
  clickedUrl?: string
): ExtractedContent => {
  const hostname = window.location.hostname.replace(/^www\./, "");
  const adapter = adapters[hostname] || universalFallback;
  const result = adapter(target, clickedUrl);
  return result || universalFallback(target, clickedUrl)!;
};
