/**
 * connectors/harvest.ts — provider-bounded, shape-tolerant extraction.
 *
 * Social platforms change their internal JSON shapes constantly. Entry
 * boundaries are nevertheless provider-specific: X timeline entries, Reddit
 * listing children, and Instagram feed items. Only fields *inside one selected
 * post* use shape-tolerant extraction. This prevents nested media, mentions, and
 * carousel slides from being mistaken for independent saved posts.
 *
 * Connectors keep only the stable bits — the endpoint, auth, and roughly where the
 * list of entries + the pagination cursor live — and hand each raw page to
 * `findEntryList` + `normalizeEntry`.
 */
import type { CapturedItem, CapturedMedia } from "../cloud-sync.service";

type Json = unknown;
type Obj = Record<string, Json>;

/**
 * Polite pause between paginated requests to a provider, so we look like a human
 * browsing rather than a scraper — avoids rate-limit flags. ~0.9–1.7s jittered.
 */
export const politeDelay = (base = 900, jitter = 800): Promise<void> =>
  new Promise((r) => setTimeout(r, base + Math.floor(Math.random() * jitter)));

const isObj = (v: Json): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);
const isHttp = (s: unknown): s is string => typeof s === "string" && /^https?:\/\//i.test(s);

const MEDIA_EXT = /\.(jpe?g|png|gif|webp|avif|mp4|webm|mov|m4v|heic)(\?|#|$)/i;
const VIDEO_EXT = /\.(mp4|webm|mov|m4v)(\?|#|$)/i;

const KEY = {
  id: /^(rest_id|id_str|pk|pk_id|tweet_id|post_id|media_id|fullname|name|id|guid)$/i,
  strongId: /^(rest_id|id_str|pk|pk_id|fullname|tweet_id|post_id)$/i,
  code: /(shortcode|^code$|slug)/i,
  text: /(full_text|note_tweet|^caption$|caption_text|selftext|^text$|^body$|^title$|description|headline|content_text)/i,
  author: /(screen_name|^username$|user_?name|author_?name|^author$|^handle$)/i,
  time: /(created_at|taken_at|created_utc|created_time|^timestamp$|published|^date$)/i,
  url: /(permalink|expanded_url|^url$|^link$|^href$|source_url|canonical)/i,
  media: /(media_url|image_url|video_url|display_url|thumbnail|image_versions|video_versions|preview|cover|^src$|playback_url)/i,
  avatar: /(profile_pic|profile_image|avatar|icon|favicon)/i,
  likes: /(favorite_count|like_count|^likes$|reaction)/i,
  ups: /(^ups$|^score$|upvote)/i,
  comments: /(comment_count|num_comments|^comments$)/i,
  replies: /(reply_count|^replies$)/i,
  reposts: /(retweet_count|repost_count|^reposts$)/i,
  views: /(view_count|^views$)/i,
  saves: /(save_count|bookmark_count|^saves$)/i,
  shares: /(share_count|^shares$)/i,
};

/** Depth-first walk over every object node (arrays traversed, objects yielded). */
function* walk(node: Json, depth = 0): Generator<{ node: Obj; depth: number }> {
  if (Array.isArray(node)) {
    for (const x of node) yield* walk(x, depth);
  } else if (isObj(node)) {
    yield { node, depth };
    for (const k of Object.keys(node)) yield* walk(node[k], depth + 1);
  }
}

/** All [key, value] pairs anywhere under a node (deep). */
function* entries(node: Json): Generator<[string, Json]> {
  for (const { node: o } of walk(node)) {
    for (const k of Object.keys(o)) yield [k, o[k]];
  }
}

/** Longest non-URL string under a key matching `keyRe` (searched deep). */
function pickText(node: Json): string {
  let best = "";
  for (const [k, v] of entries(node)) {
    if (typeof v === "string" && v.trim() && !/^https?:\/\//i.test(v) && KEY.text.test(k)) {
      if (v.length > best.length) best = v;
    }
    // caption objects: { caption: { text } } — the inner text key is caught by ^text$.
  }
  return decodeEntities(best.trim());
}

/** Longest text under an explicit field family, preserving title/body roles. */
function pickTextByKey(node: Json, keyRe: RegExp): string {
  let best = "";
  for (const [key, value] of entries(node)) {
    if (
      typeof value === "string" && value.trim() &&
      !/^https?:\/\//iu.test(value) && keyRe.test(key)
    ) {
      const decoded = decodeEntities(value.trim());
      if (decoded.length > best.length) best = decoded;
    }
  }
  return best;
}

function pickString(node: Json, keyRe: RegExp, opts: { skipHttp?: boolean } = {}): string | undefined {
  for (const [k, v] of entries(node)) {
    if (typeof v === "string" && v.trim() && keyRe.test(k)) {
      if (opts.skipHttp && isHttp(v)) continue;
      return v.trim().replace(/^@+/, "");
    }
  }
  return undefined;
}

function pickId(node: Json): string | undefined {
  // Prefer strong ids, then codes, then any id-ish scalar.
  const scan = (re: RegExp): string | undefined => {
    for (const [k, v] of entries(node)) {
      if ((typeof v === "string" || typeof v === "number") && re.test(k)) {
        const s = String(v).trim();
        if (s && s !== "0" && !/^https?:/i.test(s)) return s;
      }
    }
    return undefined;
  };
  return scan(KEY.strongId) ?? scan(KEY.code) ?? scan(KEY.id);
}

function pickNumber(node: Json, keyRe: RegExp): number | undefined {
  for (const [k, v] of entries(node)) {
    if (typeof v === "number" && Number.isFinite(v) && keyRe.test(k)) return v;
    if (typeof v === "string" && /^\d+$/.test(v) && keyRe.test(k)) return Number(v);
  }
  return undefined;
}

const directString = (node: Obj, keys: readonly string[]): string | undefined => {
  for (const key of keys) {
    const value = node[key];
    if (typeof value === "string" && value.trim()) return decodeEntities(value.trim());
    if (typeof value === "number" && Number.isFinite(value)) return String(value);
  }
  return undefined;
};

const directNumber = (node: Obj, keys: readonly string[]): number | undefined => {
  for (const key of keys) {
    const value = node[key];
    if (typeof value === "number" && Number.isFinite(value)) return value;
    if (typeof value === "string" && value.trim() && Number.isFinite(Number(value))) {
      return Number(value);
    }
  }
  return undefined;
};

const directObject = (node: Obj, keys: readonly string[]): Obj | undefined => {
  for (const key of keys) {
    const value = node[key];
    if (isObj(value)) return value;
  }
  return undefined;
};

const directArray = (node: Obj, keys: readonly string[]): Json[] | undefined => {
  for (const key of keys) {
    const value = node[key];
    if (Array.isArray(value)) return value;
  }
  return undefined;
};

const cleanHttpUrl = (value: Json): string | undefined => {
  if (typeof value !== "string") return undefined;
  const clean = decodeEntities(value.trim());
  return isHttp(clean) ? clean : undefined;
};

type MediaCandidate = {
  node: Obj;
  url: string;
  width?: number;
  height?: number;
  bitrate?: number;
  mimeType?: string;
};

const toMediaCandidate = (
  value: Json,
  urlKeys: readonly string[],
): MediaCandidate | undefined => {
  if (!isObj(value)) return undefined;
  const url = cleanHttpUrl(directString(value, urlKeys));
  if (!url) return undefined;
  return {
    node: value,
    url,
    width: directNumber(value, ["width", "w", "x"]),
    height: directNumber(value, ["height", "h", "y"]),
    bitrate: directNumber(value, ["bitrate", "bitrate_kbps", "bitrateKbps"]),
    mimeType: directString(value, ["content_type", "mime_type", "mimeType", "m"]),
  };
};

const chooseBestCandidate = (
  values: Json[] | undefined,
  urlKeys: readonly string[],
  priority: "area" | "bitrate" = "area",
  predicate: (candidate: MediaCandidate) => boolean = () => true,
): MediaCandidate | undefined => {
  let best: MediaCandidate | undefined;
  for (const value of values ?? []) {
    const candidate = toMediaCandidate(value, urlKeys);
    if (!candidate || !predicate(candidate)) continue;
    if (!best) {
      best = candidate;
      continue;
    }
    const area = (candidate.width ?? 0) * (candidate.height ?? 0);
    const bestArea = (best.width ?? 0) * (best.height ?? 0);
    const bitrate = candidate.bitrate ?? 0;
    const bestBitrate = best.bitrate ?? 0;
    const better = priority === "bitrate"
      ? bitrate > bestBitrate || (bitrate === bestBitrate && area > bestArea)
      : area > bestArea || (area === bestArea && bitrate > bestBitrate);
    if (better) best = candidate;
  }
  return best;
};

type NormalizedCreator = {
  id?: string;
  name?: string;
  handle?: string;
  avatarUrl?: string;
  url?: string;
  verified?: boolean;
};

/** Pick the richest author object, so X mention entities cannot beat the creator. */
function pickCreator(node: Json, source: string): NormalizedCreator | undefined {
  let best: { score: number; creator: NormalizedCreator } | undefined;
  for (const { node: candidate } of walk(node)) {
    const profile = isObj(candidate.legacy) ? candidate.legacy : candidate;
    const handle = directString(profile, ["screen_name", "username", "user_name", "handle"])
      ?.replace(/^@+/u, "");
    const name = directString(profile, ["full_name", "display_name", "name"]);
    const id = directString(candidate, ["user_id", "owner_id", "rest_id", "id_str", "pk", "id"]) ??
      directString(profile, ["user_id", "owner_id", "rest_id", "id_str", "pk", "id"]);
    const avatarUrl = directString(profile, [
      "profile_image_url_https",
      "profile_image_url",
      "profile_pic_url",
      "avatar_url",
      "icon_img",
    ]);
    if (!handle && !name) continue;
    const verified = typeof profile.verified === "boolean" ? profile.verified : undefined;
    const score = (handle ? 5 : 0) + (name ? 2 : 0) + (id ? 1 : 0) +
      (avatarUrl && isHttp(avatarUrl) ? 5 : 0) + (verified !== undefined ? 1 : 0);
    const profileUrl = handle
      ? source === "twitter"
        ? `https://x.com/${handle}`
        : source === "instagram"
          ? `https://www.instagram.com/${handle}/`
          : source === "reddit"
            ? `https://www.reddit.com/user/${handle}/`
            : undefined
      : undefined;
    const creator: NormalizedCreator = {
      ...(id ? { id } : {}),
      ...(name ? { name } : {}),
      ...(handle ? { handle } : {}),
      ...(avatarUrl && isHttp(avatarUrl) ? { avatarUrl } : {}),
      ...(profileUrl ? { url: profileUrl } : {}),
      ...(verified !== undefined ? { verified } : {}),
    };
    if (!best || score > best.score) best = { score, creator };
  }
  if (best) return best.creator;
  const handle = pickString(node, KEY.author, { skipHttp: true });
  if (!handle) return undefined;
  return {
    handle,
    ...(source === "reddit" ? { url: `https://www.reddit.com/user/${handle}/` } : {}),
  };
}

function pickTimestamp(node: Json): number | undefined {
  for (const [k, v] of entries(node)) {
    if (!KEY.time.test(k)) continue;
    if (typeof v === "number" && Number.isFinite(v)) {
      if (v > 1e15) return Math.round(v / 1000); // microseconds
      if (v > 1e12) return v; // ms
      if (v > 1e9) return v * 1000; // seconds
    }
    if (typeof v === "string") {
      const t = Date.parse(v);
      if (Number.isFinite(t)) return t;
      if (/^\d+$/.test(v)) return pickTimestamp({ t: Number(v) });
    }
  }
  return undefined;
}

const MAX_LOGICAL_MEDIA = 32;

/** Conservative fallback for a provider shape we do not recognise yet. */
function collectMediaFallback(node: Json): CapturedMedia[] {
  const out: CapturedMedia[] = [];
  const seen = new Set<string>();
  const add = (url: string, type: CapturedMedia["type"]) => {
    const clean = decodeEntities(url);
    if (!isHttp(clean) || seen.has(clean)) return;
    seen.add(clean);
    out.push({ type, url: clean });
  };
  const visit = (value: Json, keyName: string) => {
    if (typeof value === "string") {
      if (KEY.avatar.test(keyName)) return; // author avatar, not content
      if (MEDIA_EXT.test(value) && isHttp(value)) add(value, VIDEO_EXT.test(value) ? "video" : "image");
      else if (isHttp(value) && KEY.media.test(keyName)) add(value, /video|playback/i.test(keyName) ? "video" : "image");
    } else if (Array.isArray(value)) {
      for (const x of value) visit(x, keyName);
    } else if (isObj(value)) {
      for (const k of Object.keys(value)) visit(value[k], k);
    }
  };
  visit(node, "");
  return out.slice(0, MAX_LOGICAL_MEDIA);
}

const mediaIdentity = (id: string | undefined, provider: string): Partial<CapturedMedia> =>
  id
    ? { id, externalId: id, provider }
    : { provider };

const mediaDimensions = (
  primary: Obj | undefined,
  fallback?: Obj,
): { width?: number; height?: number } => {
  const width = (primary ? directNumber(primary, ["width", "w", "x"]) : undefined)
    ?? (fallback ? directNumber(fallback, ["width", "w", "x", "original_width"]) : undefined);
  const height = (primary ? directNumber(primary, ["height", "h", "y"]) : undefined)
    ?? (fallback ? directNumber(fallback, ["height", "h", "y", "original_height"]) : undefined);
  return {
    ...(width !== undefined ? { width } : {}),
    ...(height !== undefined ? { height } : {}),
  };
};

const finalizeMedia = (items: CapturedMedia[]): CapturedMedia[] => {
  const output: CapturedMedia[] = [];
  const seen = new Set<string>();
  for (const item of items) {
    const url = cleanHttpUrl(item.url);
    if (!url || seen.has(url)) continue;
    seen.add(url);
    output.push({ ...item, url });
    if (output.length >= MAX_LOGICAL_MEDIA) break;
  }
  return output;
};

const unwrapXResult = (value: Obj): Obj => {
  const tweet = directObject(value, ["tweet"]);
  return tweet ?? value;
};

/** Main tweet result only; quoted tweets remain metadata, not saved-post media. */
const findXPost = (entry: Json): Obj | undefined => {
  for (const { node } of walk(entry)) {
    for (const key of ["tweet_results", "tweetResult"] as const) {
      const container = node[key];
      if (!isObj(container) || !isObj(container.result)) continue;
      return unwrapXResult(container.result);
    }
  }
  return undefined;
};

const xAltText = (media: Obj): string | undefined =>
  directString(media, ["ext_alt_text", "alt_text", "altText", "accessibility_caption"]);

const extractXMedia = (entry: Json): CapturedMedia[] | undefined => {
  const post = findXPost(entry);
  if (!post) return undefined;
  const legacy = directObject(post, ["legacy"]) ?? post;
  const extended = directObject(legacy, ["extended_entities", "extendedEntities"])
    ?? directObject(post, ["extended_entities", "extendedEntities"]);
  const entities = directObject(legacy, ["entities"]) ?? directObject(post, ["entities"]);
  const rawMedia = directArray(extended ?? {}, ["media"])
    ?? directArray(entities ?? {}, ["media"])
    ?? [];
  const output: CapturedMedia[] = [];

  for (const raw of rawMedia) {
    if (!isObj(raw)) continue;
    const kind = directString(raw, ["type", "media_type"])?.toLowerCase();
    const info = directObject(raw, ["video_info", "videoInfo"]);
    const originalInfo = directObject(raw, ["original_info", "originalInfo"]);
    const id = directString(raw, ["media_key", "mediaKey", "id_str", "id"]);
    const altText = xAltText(raw);
    const poster = cleanHttpUrl(directString(raw, [
      "media_url_https",
      "media_url",
      "image_url",
      "display_url",
    ]));
    const dimensions = mediaDimensions(originalInfo, raw);
    const isVideo = kind === "video" || kind === "animated_gif" || !!info;

    if (isVideo) {
      const variant = chooseBestCandidate(
        directArray(info ?? {}, ["variants"]),
        ["url"],
        "bitrate",
        (candidate) => {
          const mime = candidate.mimeType?.toLowerCase();
          return mime === "video/mp4" || VIDEO_EXT.test(candidate.url);
        },
      );
      const url = variant?.url ?? cleanHttpUrl(directString(raw, ["video_url", "playback_url"]));
      if (!url) continue;
      const durationMillis = info
        ? directNumber(info, ["duration_millis", "durationMillis", "duration_ms"])
        : undefined;
      output.push({
        type: "video",
        url,
        ...(poster ? { thumbnailUrl: poster } : {}),
        ...mediaIdentity(id, "twitter"),
        ...(variant?.mimeType ? { mimeType: variant.mimeType } : {}),
        ...dimensions,
        ...(durationMillis !== undefined ? { durationSec: durationMillis / 1000 } : {}),
        ...(altText ? { altText } : {}),
      });
      continue;
    }

    if (!poster) continue;
    output.push({
      type: "image",
      url: poster,
      ...mediaIdentity(id, "twitter"),
      ...dimensions,
      ...(altText ? { altText } : {}),
    });
  }

  return finalizeMedia(output);
};

type RedditPreview = {
  url: string;
  width?: number;
  height?: number;
};

const redditPreviewImage = (post: Obj): RedditPreview | undefined => {
  const preview = directObject(post, ["preview"]);
  const first = directArray(preview ?? {}, ["images"])?.find(isObj);
  if (!isObj(first)) return undefined;
  const source = directObject(first, ["source", "s"]);
  const sourceUrl = source
    ? cleanHttpUrl(directString(source, ["url", "u"]))
    : undefined;
  if (sourceUrl) {
    return {
      url: sourceUrl,
      ...mediaDimensions(source),
    };
  }
  const candidate = chooseBestCandidate(
    directArray(first, ["resolutions", "p"]),
    ["url", "u"],
  );
  return candidate
    ? { url: candidate.url, width: candidate.width, height: candidate.height }
    : undefined;
};

const redditGalleryMedia = (
  id: string,
  metadata: Obj,
  listingItem?: Obj,
): CapturedMedia | undefined => {
  const source = directObject(metadata, ["s", "source"]);
  const preview = chooseBestCandidate(
    directArray(metadata, ["p", "resolutions"]),
    ["u", "url"],
  );
  const mimeType = directString(metadata, ["m", "mime_type", "mimeType"]);
  const entityKind = directString(metadata, ["e", "type"])?.toLowerCase() ?? "";
  const altText = directString(listingItem ?? {}, ["caption", "alt", "alt_text", "altText"])
    ?? directString(metadata, ["caption", "alt", "alt_text", "altText"]);
  const directVideo = source
    ? cleanHttpUrl(directString(source, ["mp4", "fallback_url", "fallbackUrl"]))
    : undefined;
  if (directVideo) {
    const thumbnailUrl = source
      ? cleanHttpUrl(directString(source, ["u", "url", "gif"])) ?? preview?.url
      : preview?.url;
    return {
      type: "video",
      url: directVideo,
      ...(thumbnailUrl ? { thumbnailUrl } : {}),
      ...mediaIdentity(id, "reddit"),
      ...(mimeType?.startsWith("video/") ? { mimeType } : { mimeType: "video/mp4" }),
      ...mediaDimensions(source, metadata),
      ...(altText ? { altText } : {}),
    };
  }

  const sourceUrl = source
    ? cleanHttpUrl(directString(source, ["u", "url", "gif"]))
    : undefined;
  const url = sourceUrl ?? preview?.url;
  if (!url) return undefined;
  return {
    type: entityKind.includes("video") && VIDEO_EXT.test(url) ? "video" : "image",
    url,
    ...mediaIdentity(id, "reddit"),
    ...(mimeType ? { mimeType } : {}),
    ...(sourceUrl ? mediaDimensions(source, metadata) : {
      ...(preview?.width !== undefined ? { width: preview.width } : {}),
      ...(preview?.height !== undefined ? { height: preview.height } : {}),
    }),
    ...(altText ? { altText } : {}),
  };
};

const redditGallery = (post: Obj): CapturedMedia[] | undefined => {
  const galleryData = directObject(post, ["gallery_data", "galleryData"]);
  const metadata = directObject(post, ["media_metadata", "mediaMetadata"]);
  if (!metadata) return undefined;
  const listing = directArray(galleryData ?? {}, ["items"]);
  const ordered: Array<{ id: string; item?: Obj }> = [];
  for (const raw of listing ?? []) {
    if (!isObj(raw)) continue;
    const id = directString(raw, ["media_id", "mediaId"]);
    if (id) ordered.push({ id, item: raw });
  }
  if (!ordered.length) {
    for (const id of Object.keys(metadata)) ordered.push({ id });
  }
  const output: CapturedMedia[] = [];
  for (const { id, item } of ordered) {
    const raw = metadata[id];
    if (!isObj(raw)) continue;
    const media = redditGalleryMedia(id, raw, item);
    if (media) output.push(media);
  }
  return output;
};

const redditVideo = (post: Obj): CapturedMedia | undefined => {
  const secureMedia = directObject(post, ["secure_media", "secureMedia"]);
  const media = directObject(post, ["media"]);
  const preview = directObject(post, ["preview"]);
  const video = directObject(secureMedia ?? {}, ["reddit_video", "redditVideo"])
    ?? directObject(media ?? {}, ["reddit_video", "redditVideo"])
    ?? directObject(preview ?? {}, ["reddit_video_preview", "redditVideoPreview"]);
  if (!video) return undefined;
  const url = cleanHttpUrl(directString(video, ["fallback_url", "fallbackUrl"]));
  if (!url) return undefined;
  const thumbnail = redditPreviewImage(post);
  const durationSec = directNumber(video, ["duration", "duration_sec", "durationSec"]);
  const altText = directString(post, ["media_alt_text", "mediaAltText", "alt_text", "altText"]);
  return {
    type: "video",
    url,
    ...(thumbnail ? { thumbnailUrl: thumbnail.url } : {}),
    mimeType: "video/mp4",
    ...mediaDimensions(video),
    ...(durationSec !== undefined ? { durationSec } : {}),
    ...(altText ? { altText } : {}),
    provider: "reddit",
  };
};

const extractRedditMedia = (entry: Json): CapturedMedia[] | undefined => {
  if (!isObj(entry)) return undefined;
  const post = isObj(entry.data) ? entry.data : entry;
  const kind = directString(entry, ["kind"]);
  const fullname = directString(post, ["name", "fullname"]);
  const isComment = kind === "t1" || fullname?.startsWith("t1_");
  const isPost = kind === "t3" || fullname?.startsWith("t3_");
  if (!isComment && !isPost) return undefined;
  if (isComment) return [];

  const gallery = redditGallery(post);
  if (gallery?.length) return finalizeMedia(gallery);
  const hostedVideo = redditVideo(post);
  if (hostedVideo) return [hostedVideo];

  const preview = redditPreviewImage(post);
  if (preview) {
    return [{
      type: "image",
      url: preview.url,
      ...(preview.width !== undefined ? { width: preview.width } : {}),
      ...(preview.height !== undefined ? { height: preview.height } : {}),
      provider: "reddit",
    }];
  }
  const destination = cleanHttpUrl(directString(post, [
    "url_overridden_by_dest",
    "urlOverriddenByDest",
  ]));
  if (destination && MEDIA_EXT.test(destination)) {
    return [{
      type: VIDEO_EXT.test(destination) ? "video" : "image",
      url: destination,
      provider: "reddit",
    }];
  }

  const crossposts = directArray(post, ["crosspost_parent_list", "crosspostParentList"]);
  const crosspost = crossposts?.find(isObj);
  if (isObj(crosspost)) {
    const inherited = extractRedditMedia({ kind: "t3", data: crosspost });
    if (inherited?.length) return inherited;
  }
  return [];
};

const instagramRoot = (entry: Obj): Obj => {
  const wrapped = directObject(entry, ["media"]);
  if (
    wrapped && (
      wrapped.pk !== undefined || wrapped.id !== undefined || wrapped.media_type !== undefined ||
      wrapped.image_versions2 !== undefined || wrapped.video_versions !== undefined
    )
  ) return wrapped;
  return entry;
};

const instagramImageCandidate = (media: Obj): MediaCandidate | undefined => {
  const versions = directObject(media, ["image_versions2", "imageVersions2", "image_versions"]);
  return chooseBestCandidate(directArray(versions ?? {}, ["candidates"]), ["url"]);
};

const instagramAltText = (media: Obj, fallback?: string): string | undefined =>
  directString(media, ["accessibility_caption", "accessibilityCaption", "alt_text", "altText"])
  ?? fallback;

const instagramDuration = (media: Obj): number | undefined => {
  const seconds = directNumber(media, ["video_duration", "videoDuration", "duration"]);
  if (seconds !== undefined) return seconds;
  const millis = directNumber(media, ["duration_millis", "durationMillis", "duration_ms"]);
  return millis !== undefined ? millis / 1000 : undefined;
};

const instagramLogicalMedia = (media: Obj, fallbackAlt?: string): CapturedMedia | undefined => {
  const id = directString(media, ["pk", "pk_id", "id"]);
  const mediaType = directNumber(media, ["media_type", "mediaType"]);
  const videos = directArray(media, ["video_versions", "videoVersions"]);
  const isVideo = mediaType === 2 || !!videos?.length;
  const image = instagramImageCandidate(media);
  const altText = instagramAltText(media, fallbackAlt);
  if (isVideo) {
    const video = chooseBestCandidate(videos, ["url"]);
    if (!video) return undefined;
    const durationSec = instagramDuration(media);
    return {
      type: "video",
      url: video.url,
      ...(image ? { thumbnailUrl: image.url } : {}),
      ...mediaIdentity(id, "instagram"),
      ...mediaDimensions(video.node, media),
      ...(durationSec !== undefined ? { durationSec } : {}),
      ...(altText ? { altText } : {}),
    };
  }
  if (!image) return undefined;
  return {
    type: "image",
    url: image.url,
    ...mediaIdentity(id, "instagram"),
    ...mediaDimensions(image.node, media),
    ...(altText ? { altText } : {}),
  };
};

const extractInstagramMedia = (entry: Json): CapturedMedia[] | undefined => {
  if (!isObj(entry)) return undefined;
  const media = instagramRoot(entry);
  const recognized = media.pk !== undefined || media.id !== undefined || media.code !== undefined ||
    media.media_type !== undefined || media.image_versions2 !== undefined ||
    media.video_versions !== undefined || media.carousel_media !== undefined;
  if (!recognized) return undefined;
  const parentAlt = instagramAltText(media);
  const carousel = directArray(media, ["carousel_media", "carouselMedia"]);
  if (carousel?.length) {
    const output: CapturedMedia[] = [];
    for (const slide of carousel) {
      if (!isObj(slide)) continue;
      const selected = instagramLogicalMedia(slide, parentAlt);
      if (selected) output.push(selected);
    }
    return finalizeMedia(output);
  }
  const selected = instagramLogicalMedia(media);
  return selected ? [selected] : [];
};

function collectMedia(node: Json, source?: string): CapturedMedia[] {
  const providerMedia = source === "twitter"
    ? extractXMedia(node)
    : source === "reddit"
      ? extractRedditMedia(node)
      : source === "instagram"
        ? extractInstagramMedia(node)
        : undefined;
  return providerMedia === undefined ? collectMediaFallback(node) : providerMedia;
}

function pickPermalink(node: Json): string | undefined {
  for (const [k, v] of entries(node)) {
    if (typeof v !== "string" || !KEY.url.test(k) || KEY.avatar.test(k)) continue;
    if (isHttp(v) && !MEDIA_EXT.test(v)) return v;
    if (v.startsWith("/") && v.length > 1) return v; // relative (e.g. reddit permalink)
  }
  return undefined;
}

function decodeEntities(text: string): string {
  return text
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'");
}

/** Does a node look like one saved entry? Has an id AND (text OR content media). */
function looksLikeEntry(node: Obj): boolean {
  const hasId = !!pickId(node);
  if (!hasId) return false;
  return pickText(node).length > 0 || collectMediaFallback(node).length > 0;
}

/**
 * Find the array in the response that holds the saved entries — the array with the
 * most entry-like elements (handles `instructions[].entries[]`, `items[]`,
 * `children[]`, `data[]`, … without knowing the exact path).
 */
export function findEntryList(root: Json): Obj[] {
  let best: Obj[] = [];
  let bestScore = -1;
  const consider = (arr: Json[]) => {
    const elems = arr.filter(isObj).filter(looksLikeEntry) as Obj[];
    if (elems.length > bestScore) {
      bestScore = elems.length;
      best = elems;
    }
  };
  const seenArrays = new Set<Json>();
  const scan = (node: Json) => {
    if (Array.isArray(node)) {
      if (!seenArrays.has(node)) {
        seenArrays.add(node);
        consider(node);
      }
      for (const x of node) scan(x);
    } else if (isObj(node)) {
      for (const k of Object.keys(node)) scan(node[k]);
    }
  };
  scan(root);
  return best;
}

const namedEntryList = (
  root: Json,
  names: ReadonlySet<string>,
  predicate: (entry: Obj) => boolean = looksLikeEntry,
): Obj[] => {
  let best: Obj[] = [];
  for (const { node } of walk(root)) {
    for (const [key, value] of Object.entries(node)) {
      if (!names.has(key) || !Array.isArray(value)) continue;
      const candidates = value.filter(isObj).filter(predicate);
      if (candidates.length > best.length) best = candidates;
    }
  }
  return best;
};

const containsXPost = (entry: Obj): boolean => {
  if (typeof entry.entryId === "string" && /^tweet-/iu.test(entry.entryId)) {
    return looksLikeEntry(entry);
  }
  for (const { node } of walk(entry)) {
    if (
      (isObj(node.tweet_results) && isObj(node.tweet_results.result)) ||
      (isObj(node.tweetResult) && isObj(node.tweetResult.result))
    ) return true;
  }
  return false;
};

/** X GraphQL timeline entries only; nested media/mentions never compete. */
export function findXEntryList(root: Json): Obj[] {
  const timelineEntries: Obj[] = [];
  for (const { node } of walk(root)) {
    if (!Array.isArray(node.instructions)) continue;
    for (const instruction of node.instructions) {
      if (!isObj(instruction) || !Array.isArray(instruction.entries)) continue;
      timelineEntries.push(...instruction.entries.filter(isObj).filter(containsXPost));
    }
  }
  if (timelineEntries.length) return Array.from(new Set(timelineEntries));
  const timeline = namedEntryList(root, new Set(["entries"]), containsXPost);
  if (timeline.length) return timeline;
  const flat = namedEntryList(root, new Set(["items", "tweets"]));
  return flat.length ? flat : findEntryList(root);
}

/** Reddit listing children only; each child is a post/comment wrapper. */
export function findRedditEntryList(root: Json): Obj[] {
  if (isObj(root) && isObj(root.data) && Array.isArray(root.data.children)) {
    return root.data.children.filter(isObj).filter(looksLikeEntry);
  }
  const children = namedEntryList(root, new Set(["children"]));
  return children.length ? children : findEntryList(root);
}

/** Instagram feed items only; carousel_media remains attached to its post. */
export function findInstagramEntryList(root: Json): Obj[] {
  if (isObj(root) && Array.isArray(root.items)) {
    return root.items.filter(isObj).filter((entry) => !!pickId(entry));
  }
  if (isObj(root) && isObj(root.data) && Array.isArray(root.data.items)) {
    return root.data.items.filter(isObj).filter((entry) => !!pickId(entry));
  }
  const items = namedEntryList(root, new Set(["items"]));
  return items.length ? items : findEntryList(root);
}

const collectEntityStrings = (
  node: Json,
  arrayKey: RegExp,
  valueKeys: readonly string[],
): string[] => {
  const output: string[] = [];
  const seen = new Set<string>();
  for (const [key, value] of entries(node)) {
    if (!arrayKey.test(key) || !Array.isArray(value)) continue;
    for (const candidate of value.slice(0, 64)) {
      const raw = typeof candidate === "string"
        ? candidate
        : isObj(candidate)
          ? directString(candidate, valueKeys)
          : undefined;
      const normalized = raw?.replace(/^[@#]+/u, "").trim();
      if (!normalized || seen.has(normalized.toLowerCase())) continue;
      seen.add(normalized.toLowerCase());
      output.push(normalized.slice(0, 128));
      if (output.length >= 32) return output;
    }
  }
  return output;
};

const firstNestedName = (node: Json, keyRe: RegExp): string | undefined => {
  for (const [key, value] of entries(node)) {
    if (!keyRe.test(key)) continue;
    if (typeof value === "string" && value.trim()) return decodeEntities(value.trim()).slice(0, 512);
    if (isObj(value)) {
      const name = directString(value, ["name", "title", "label"]);
      if (name) return name.slice(0, 512);
    }
  }
  return undefined;
};

const firstQuotedPost = (
  node: Json,
  source: string,
): { url?: string; text?: string; author?: NormalizedCreator } | undefined => {
  for (const [key, value] of entries(node)) {
    if (!/(quoted_status_result|quoted_status|quotedPost)/iu.test(key) || !isObj(value)) continue;
    const text = pickText(value).slice(0, 16_000);
    const author = pickCreator(value, source);
    const url = pickPermalink(value);
    if (text || author || url) {
      return {
        ...(url && isHttp(url) ? { url } : {}),
        ...(text ? { text } : {}),
        ...(author ? { author } : {}),
      };
    }
  }
  return undefined;
};

const nonEmptyRecord = (value: Record<string, unknown>): Record<string, unknown> | undefined =>
  Object.keys(value).length ? value : undefined;

export interface NormalizeCtx {
  source: string; // twitter | reddit | instagram
  idPrefix: string; // x | reddit | ig
  connector: string;
  defaultType?: string; // social | image | link
  /** Origin to resolve relative permalinks against (e.g. https://www.reddit.com). */
  origin?: string;
  /** Build a permalink when the payload has none (from the extracted id/handle/code). */
  buildUrl?: (parts: { id: string; handle?: string; code?: string }) => string | undefined;
}

/** Turn one entry object into a CapturedItem via shape-agnostic extraction. */
export function normalizeEntry(el: Obj, ctx: NormalizeCtx): CapturedItem | null {
  const id = pickId(el);
  if (!id || id.length > 240) return null;
  const redditTitle = ctx.source === "reddit"
    ? pickTextByKey(el, /^(title|link_title)$/iu)
    : "";
  const redditBody = ctx.source === "reddit"
    ? pickTextByKey(el, /^(selftext|body)$/iu)
    : "";
  const text = ctx.source === "reddit" ? (redditBody || redditTitle) : pickText(el);
  const title = (
    redditTitle || text.split("\n").find(Boolean) || `${ctx.source} item`
  ).slice(0, 140);
  const creator = pickCreator(el, ctx.source);
  const handle = creator?.handle ?? pickString(el, KEY.author, { skipHttp: true });
  const code = pickString(el, KEY.code, { skipHttp: true });
  const media = collectMedia(el, ctx.source);
  let url = pickPermalink(el);
  if (url && url.startsWith("/")) url = (ctx.origin ?? "").replace(/\/$/, "") + url;
  if (!url) url = ctx.buildUrl?.({ id, handle, code }) || "";
  const externalId = `${ctx.idPrefix}:${id}`;
  const postedAt = pickTimestamp(el);
  const likes = pickNumber(el, KEY.likes);
  const upvotes = pickNumber(el, KEY.ups);
  const comments = pickNumber(el, KEY.comments);
  const replies = pickNumber(el, KEY.replies);
  const reposts = pickNumber(el, KEY.reposts);
  const views = pickNumber(el, KEY.views);
  const saves = pickNumber(el, KEY.saves);
  const shares = pickNumber(el, KEY.shares);
  const communityName = ctx.source === "reddit"
    ? pickString(el, /^(subreddit|subreddit_name_prefixed)$/iu, { skipHttp: true })?.replace(/^r\//u, "")
    : undefined;
  const communityId = ctx.source === "reddit"
    ? pickString(el, /^(subreddit_id)$/iu, { skipHttp: true })
    : undefined;
  const hashtags = collectEntityStrings(el, /hashtags/iu, ["text", "tag", "name"]);
  const mentions = collectEntityStrings(el, /(user_mentions|mentions|mentioned_users)/iu, [
    "screen_name",
    "username",
    "handle",
    "name",
  ]);
  for (const match of text.matchAll(/#([\p{L}\p{N}_]{1,128})/gu)) {
    if (!hashtags.some((value) => value.toLowerCase() === match[1].toLowerCase())) {
      hashtags.push(match[1]);
    }
    if (hashtags.length >= 32) break;
  }
  const stats = nonEmptyRecord({
    ...(likes !== undefined ? { likes } : {}),
    ...(upvotes !== undefined ? { upvotes } : {}),
    ...(comments !== undefined ? { comments } : {}),
    ...(replies !== undefined ? { replies } : {}),
    ...(reposts !== undefined ? { reposts } : {}),
    ...(views !== undefined ? { views } : {}),
    ...(saves !== undefined ? { saves } : {}),
    ...(shares !== undefined ? { shares } : {}),
  });
  const community = communityName || communityId
    ? {
        ...(communityId ? { id: communityId } : {}),
        ...(communityName ? {
          name: communityName,
          url: `https://www.reddit.com/r/${communityName}/`,
        } : {}),
      }
    : undefined;
  const language = pickString(el, /^(lang|language|lang_code)$/iu, { skipHttp: true });
  const quotedPost = ctx.source === "twitter" ? firstQuotedPost(el, ctx.source) : undefined;
  const flair = ctx.source === "reddit"
    ? pickString(el, /^(link_flair_text|flair)$/iu, { skipHttp: true })
    : undefined;
  const crosspostOrigin = ctx.source === "reddit"
    ? pickString(el, /^(crosspost_parent)$/iu, { skipHttp: true })
    : undefined;
  const linkedDomain = ctx.source === "reddit"
    ? pickString(el, /^(domain)$/iu, { skipHttp: true })
    : undefined;
  const postKind = ctx.source === "reddit"
    ? pickString(el, /^(post_hint|kind)$/iu, { skipHttp: true })
    : undefined;
  const conversationId = ctx.source === "twitter"
    ? pickString(el, /^(conversation_id_str|conversation_id)$/iu, { skipHttp: true })
    : undefined;
  const location = ctx.source === "instagram" ? firstNestedName(el, /^location$/iu) : undefined;
  const originalAudio = ctx.source === "instagram"
    ? firstNestedName(el, /(music_metadata|original_sound_info|audio)/iu) ??
      pickTextByKey(el, /(song_name|audio_title|music_title|original_audio)/iu)
    : undefined;
  const mediaKind = pickString(el, /^(product_type|post_hint|media_kind)$/iu, { skipHttp: true });
  const capturedAt = Date.now();
  const normalizedAuthor = creator ?? (handle ? { handle } : undefined);
  const inline: Record<string, unknown> = {
    id,
    title,
    description: text,
    ...(normalizedAuthor ? { author: normalizedAuthor } : {}),
    ...(postedAt !== undefined ? { postedAt } : {}),
    ...(stats ? { stats } : {}),
    ...(community ? { community } : {}),
    ...(language ? { language } : {}),
    ...(hashtags.length ? { hashtags } : {}),
    ...(mentions.length ? { mentions } : {}),
    ...(quotedPost ? { quotedPost } : {}),
    ...(flair ? { flair } : {}),
    ...(crosspostOrigin ? { crosspostOrigin } : {}),
    ...(linkedDomain ? { domain: linkedDomain } : {}),
    ...(postKind ? { postKind } : {}),
    ...(conversationId ? { conversationId } : {}),
    ...(location ? { location: { name: location } } : {}),
    ...(originalAudio ? { audio: { title: originalAudio } } : {}),
    ...(mediaKind ? { mediaKind } : {}),
    ...(media.some((entry) => entry.type === "image") ? {
      images: media.filter((entry) => entry.type === "image").map((entry) => ({
        url: entry.url,
        ...(entry.width !== undefined ? { width: entry.width } : {}),
        ...(entry.height !== undefined ? { height: entry.height } : {}),
        ...(entry.altText ? { altText: entry.altText } : {}),
      })),
    } : {}),
    ...(media.some((entry) => entry.type === "video") ? {
      videos: media.filter((entry) => entry.type === "video").map((entry) => ({
        url: entry.url,
        ...(entry.thumbnailUrl ? { thumbnailUrl: entry.thumbnailUrl } : {}),
        ...(entry.durationSec !== undefined ? { durationSec: entry.durationSec } : {}),
      })),
    } : {}),
  };
  return {
    externalId,
    url,
    title,
    textContent: text,
    source: ctx.source,
    type: ctx.defaultType || (ctx.source === "reddit" ? "forum" : "social"),
    authorUsername: handle,
    media,
    likes,
    upvotes,
    postedAt,
    fields: {
      externalId,
      connector: ctx.connector,
      ...(postedAt !== undefined ? { postedAt } : {}),
      ...(comments !== undefined ? { comments } : {}),
      ...(replies !== undefined ? { replies } : {}),
      ...(reposts !== undefined ? { reposts } : {}),
      ...(views !== undefined ? { views } : {}),
      ...(saves !== undefined ? { saves } : {}),
      ...(shares !== undefined ? { shares } : {}),
      ...(communityName ? { community: communityName } : {}),
      ...(communityId ? { subredditId: communityId } : {}),
      ...(hashtags.length ? { hashtags } : {}),
      ...(mentions.length ? { mentions } : {}),
      ...(flair ? { flair } : {}),
      ...(crosspostOrigin ? { crosspostOrigin } : {}),
      ...(linkedDomain ? { linkedDomain } : {}),
      ...(postKind ? { postKind } : {}),
      ...(conversationId ? { conversationId } : {}),
      ...(location ? { location } : {}),
      ...(originalAudio ? { originalAudio } : {}),
      ...(mediaKind ? { mediaKind } : {}),
    },
    metadata: {
      schemaVersion: 1,
      social: {
        platform: ctx.source,
        postId: id,
        ...(normalizedAuthor ? { author: normalizedAuthor } : {}),
        ...(community ? { community } : {}),
        ...(postedAt !== undefined ? { postedAt } : {}),
        ...(language ? { language } : {}),
        ...(stats ? { stats } : {}),
        ...(quotedPost ? { quotedPost } : {}),
      },
      provenance: {
        method: "extension",
        importer: ctx.connector,
        externalId,
        capturedAt,
        importedAt: capturedAt,
      },
      sourceRecords: [{
        id: `${ctx.connector}:${externalId}`.slice(0, 256),
        provider: ctx.source,
        kind: "api",
        adapterVersion: "extension-social-v1",
        ...(url && isHttp(url) ? { canonicalUrl: url } : {}),
        externalId,
        fetchedAt: capturedAt,
        inline,
      }],
    },
  };
}

const findXBottomCursor = (root: Json): string | undefined => {
  for (const { node } of walk(root)) {
    const type = node.cursorType ?? node.entryType;
    if ((type === "Bottom" || node.cursorType === "Bottom") && typeof node.value === "string") {
      return node.value;
    }
  }
  return undefined;
};

/** X only: the Bottom timeline cursor, with generic fallback for flat shapes. */
export function findXCursor(root: Json): string | undefined {
  return findXBottomCursor(root) ?? findCursor(root);
}

/** Reddit only: the outer Listing cursor, never a nested comment-replies cursor. */
export function findRedditCursor(root: Json): string | undefined {
  if (isObj(root) && isObj(root.data) && Object.hasOwn(root.data, "after")) {
    const after = root.data.after;
    if (typeof after === "string" && after.trim()) return after;
    return undefined;
  }
  return findCursor(root);
}

/** Instagram only: `more_available:false` is terminal even if a stale id remains. */
export function findInstagramCursor(root: Json): string | undefined {
  const page = isObj(root) && isObj(root.data) ? root.data : isObj(root) ? root : undefined;
  if (page) {
    const hasKnownPagination = Object.hasOwn(page, "more_available") ||
      Object.hasOwn(page, "moreAvailable") ||
      Object.hasOwn(page, "next_max_id") ||
      Object.hasOwn(page, "nextMaxId");
    if (hasKnownPagination) {
      if (page.more_available === false || page.moreAvailable === false) return undefined;
      const cursor = directString(page, ["next_max_id", "nextMaxId"]);
      return cursor?.trim() || undefined;
    }
  }
  return findCursor(root);
}

/**
 * Find a cursor for an unknown response shape. Provider connectors use the
 * bounded helpers above so similarly named nested fields cannot win.
 */
export function findCursor(root: Json): string | undefined {
  const xBottom = findXBottomCursor(root);
  if (xBottom) return xBottom;
  const CURSOR_KEY = /(next_max_id|^max_id$|^after$|next_cursor|min_id|end_cursor|paging_token)/i;
  for (const [k, v] of entries(root)) {
    if (typeof v === "string" && v.trim() && CURSOR_KEY.test(k)) return v;
    if (typeof v === "number" && CURSOR_KEY.test(k)) return String(v);
  }
  return undefined;
}
