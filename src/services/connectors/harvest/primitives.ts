import {
  jsonFiniteNumber,
  jsonObject,
  jsonString,
  type JsonObject,
  type JsonValue,
} from "@src/common/json-value";

export type Obj = JsonObject;
export type Json = JsonValue;

export const isObj = (value: Json | undefined): value is Obj =>
  jsonObject(value) !== undefined;

export const isHttp = (value: string): boolean => /^https?:\/\//iu.test(value);

export const MEDIA_EXT = /\.(jpe?g|png|gif|webp|avif|mp4|webm|mov|m4v|heic)(\?|#|$)/i;
export const VIDEO_EXT = /\.(mp4|webm|mov|m4v)(\?|#|$)/i;

export const KEY = {
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
export function* walk(node: Json, depth = 0): Generator<{ node: Obj; depth: number }> {
  if (Array.isArray(node)) {
    for (const child of node) yield* walk(child, depth);
  } else if (isObj(node)) {
    yield { node, depth };
    for (const key of Object.keys(node)) yield* walk(node[key], depth + 1);
  }
}

/** All key/value pairs anywhere below a JSON node. */
export function* entries(node: Json): Generator<[string, Json]> {
  for (const { node: object } of walk(node)) {
    for (const key of Object.keys(object)) yield [key, object[key]];
  }
}

export function decodeEntities(text: string): string {
  return text
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'");
}

/** Longest non-URL string under a known text field. */
export function pickText(node: Json): string {
  let best = "";
  for (const [key, value] of entries(node)) {
    const text = jsonString(value);
    if (text?.trim() && !isHttp(text) && KEY.text.test(key) && text.length > best.length) {
      best = text;
    }
  }
  return decodeEntities(best.trim());
}

/** Longest text under an explicit field family, preserving title/body roles. */
export function pickTextByKey(node: Json, keyPattern: RegExp): string {
  let best = "";
  for (const [key, value] of entries(node)) {
    const text = jsonString(value);
    if (!text?.trim() || isHttp(text) || !keyPattern.test(key)) continue;
    const decoded = decodeEntities(text.trim());
    if (decoded.length > best.length) best = decoded;
  }
  return best;
}

export function pickString(
  node: Json,
  keyPattern: RegExp,
  options: { skipHttp?: boolean } = {},
): string | undefined {
  for (const [key, value] of entries(node)) {
    const text = jsonString(value);
    if (!text?.trim() || !keyPattern.test(key)) continue;
    if (options.skipHttp && isHttp(text)) continue;
    return text.trim().replace(/^@+/, "");
  }
  return undefined;
}

export function pickId(node: Json): string | undefined {
  const scan = (keyPattern: RegExp): string | undefined => {
    for (const [key, value] of entries(node)) {
      if (!keyPattern.test(key)) continue;
      const text = jsonString(value);
      const number = jsonFiniteNumber(value);
      const scalar = text ?? (number === undefined ? undefined : String(number));
      const id = scalar?.trim();
      if (id && id !== "0" && !/^https?:/iu.test(id)) return id;
    }
    return undefined;
  };
  return scan(KEY.strongId) ?? scan(KEY.code) ?? scan(KEY.id);
}

export function pickNumber(node: Json, keyPattern: RegExp): number | undefined {
  for (const [key, value] of entries(node)) {
    if (!keyPattern.test(key)) continue;
    const number = jsonFiniteNumber(value);
    if (number !== undefined) return number;
    const text = jsonString(value);
    if (text && /^\d+$/.test(text)) return Number(text);
  }
  return undefined;
}

export function directString(node: Obj, keys: readonly string[]): string | undefined {
  for (const key of keys) {
    const value = node[key];
    const text = jsonString(value);
    if (text?.trim()) return decodeEntities(text.trim());
    const number = jsonFiniteNumber(value);
    if (number !== undefined) return String(number);
  }
  return undefined;
}

export function directNumber(node: Obj, keys: readonly string[]): number | undefined {
  for (const key of keys) {
    const value = node[key];
    const number = jsonFiniteNumber(value);
    if (number !== undefined) return number;
    const text = jsonString(value);
    if (text?.trim() && Number.isFinite(Number(text))) return Number(text);
  }
  return undefined;
}

export function directObject(node: Obj, keys: readonly string[]): Obj | undefined {
  for (const key of keys) {
    const value = node[key];
    if (isObj(value)) return value;
  }
  return undefined;
}

export function directArray(node: Obj, keys: readonly string[]): Json[] | undefined {
  for (const key of keys) {
    const value = node[key];
    if (Array.isArray(value)) return value;
  }
  return undefined;
}

export function cleanHttpUrl(value: Json | undefined): string | undefined {
  const text = jsonString(value);
  if (text === undefined) return undefined;
  const clean = decodeEntities(text.trim());
  return isHttp(clean) ? clean : undefined;
}
