/**
 * connectors/harvest.ts — shape-agnostic extraction.
 *
 * Social platforms change their internal JSON shapes constantly, so we do NOT
 * hardcode field paths. Instead we deep-scan a response and pull out the data we
 * actually need (id, text, author, media, timestamp, permalink, counts) by
 * *meaning* (key-name heuristics + value patterns). If a platform renames or
 * re-nests fields, extraction still works as long as the data is present somewhere.
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
  avatar: /(profile_pic|avatar|icon|favicon)/i,
  likes: /(favorite_count|like_count|^likes$|reaction)/i,
  ups: /(^ups$|^score$|upvote)/i,
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

function collectMedia(node: Json): CapturedMedia[] {
  const out: CapturedMedia[] = [];
  const seen = new Set<string>();
  const add = (url: string, type: string) => {
    const clean = decodeEntities(url);
    if (!isHttp(clean) || seen.has(clean)) return;
    seen.add(clean);
    out.push({ type, url: clean });
  };
  const visit = (value: Json, keyName: string) => {
    if (typeof value === "string") {
      if (KEY.avatar.test(keyName)) return; // author avatar, not content
      if (MEDIA_EXT.test(value) && isHttp(value)) add(value, VIDEO_EXT.test(value) ? "video" : "photo");
      else if (isHttp(value) && KEY.media.test(keyName)) add(value, /video|playback/i.test(keyName) ? "video" : "photo");
    } else if (Array.isArray(value)) {
      for (const x of value) visit(x, keyName);
    } else if (isObj(value)) {
      for (const k of Object.keys(value)) visit(value[k], k);
    }
  };
  visit(node, "");
  return out.slice(0, 8);
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
  return pickText(node).length > 0 || collectMedia(node).length > 0;
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
  if (!id) return null;
  const text = pickText(el);
  const handle = pickString(el, KEY.author, { skipHttp: true });
  const code = pickString(el, KEY.code, { skipHttp: true });
  const media = collectMedia(el);
  let url = pickPermalink(el);
  if (url && url.startsWith("/")) url = (ctx.origin ?? "").replace(/\/$/, "") + url;
  if (!url) url = ctx.buildUrl?.({ id, handle, code }) || "";
  const hasVideo = media.some((m) => m.type === "video");
  const externalId = `${ctx.idPrefix}:${id}`;
  return {
    externalId,
    url,
    title: (text.split("\n").find(Boolean) || `${ctx.source} item`).slice(0, 140),
    textContent: text,
    source: ctx.source,
    type: hasVideo ? "video" : ctx.defaultType || "social",
    authorUsername: handle,
    media,
    likes: pickNumber(el, KEY.likes),
    upvotes: pickNumber(el, KEY.ups),
    createdAt: pickTimestamp(el),
    fields: { externalId, connector: ctx.connector },
  };
}

/**
 * Find the next pagination cursor, shape-agnostically. Looks for common cursor
 * fields (`next_max_id`, `after`, `min_id`, `next_cursor`) and X's bottom-cursor
 * value; returns the first non-empty one.
 */
export function findCursor(root: Json): string | undefined {
  // X: TimelineTimelineCursor with cursorType "Bottom" → value.
  for (const { node } of walk(root)) {
    const type = node.cursorType ?? node.entryType;
    if ((type === "Bottom" || node.cursorType === "Bottom") && typeof node.value === "string") {
      return node.value;
    }
  }
  const CURSOR_KEY = /(next_max_id|^max_id$|^after$|next_cursor|min_id|end_cursor|paging_token)/i;
  for (const [k, v] of entries(root)) {
    if (typeof v === "string" && v.trim() && CURSOR_KEY.test(k)) return v;
    if (typeof v === "number" && CURSOR_KEY.test(k)) return String(v);
  }
  return undefined;
}
