import {
  jsonBoolean,
  jsonFiniteNumber,
  jsonObject,
  jsonString,
} from "@src/common/json-value";
import type {
  CapturedCommunity,
  CapturedCreator,
  CapturedInlineImage,
  CapturedInlineVideo,
  CapturedItem,
  CapturedItemFields,
  CapturedQuotedPost,
  CapturedSocialMetadata,
  CapturedSourceInline,
  CapturedSourceRecord,
  CapturedStats,
} from "@src/services/connectors/cloud-push";
import { collectMedia } from "./media";
import {
  decodeEntities,
  directString,
  entries,
  isHttp,
  isObj,
  KEY,
  MEDIA_EXT,
  pickId,
  pickNumber,
  pickString,
  pickText,
  pickTextByKey,
  walk,
  type Json,
  type Obj,
} from "./primitives";

function profileUrlFor(source: string, handle: string): string | undefined {
  if (source === "twitter") return `https://x.com/${handle}`;
  if (source === "instagram") return `https://www.instagram.com/${handle}/`;
  if (source === "reddit") return `https://www.reddit.com/user/${handle}/`;
  return undefined;
}

/** Pick the richest author object, so X mention entities cannot beat the creator. */
function pickCreator(node: Json, source: string): CapturedCreator | undefined {
  let best: { score: number; creator: CapturedCreator } | undefined;
  for (const { node: candidate } of walk(node)) {
    const profile = isObj(candidate.legacy) ? candidate.legacy : candidate;
    const handle = directString(profile, ["screen_name", "username", "user_name", "handle"])
      ?.replace(/^@+/u, "");
    const name = directString(profile, ["full_name", "display_name", "name"]);
    const id = directString(candidate, ["user_id", "owner_id", "rest_id", "id_str", "pk", "id"])
      ?? directString(profile, ["user_id", "owner_id", "rest_id", "id_str", "pk", "id"]);
    const avatarUrl = directString(profile, [
      "profile_image_url_https",
      "profile_image_url",
      "profile_pic_url",
      "avatar_url",
      "icon_img",
    ]);
    if (!handle && !name) continue;
    const verified = jsonBoolean(profile.verified);
    const score = (handle ? 5 : 0) + (name ? 2 : 0) + (id ? 1 : 0)
      + (avatarUrl && isHttp(avatarUrl) ? 5 : 0) + (verified !== undefined ? 1 : 0);
    const profileUrl = handle ? profileUrlFor(source, handle) : undefined;
    const creator: CapturedCreator = {};
    if (id) creator.id = id;
    if (name) creator.name = name;
    if (handle) creator.handle = handle;
    if (avatarUrl && isHttp(avatarUrl)) creator.avatarUrl = avatarUrl;
    if (profileUrl) creator.url = profileUrl;
    if (verified !== undefined) creator.verified = verified;
    if (!best || score > best.score) best = { score, creator };
  }
  if (best) return best.creator;
  const handle = pickString(node, KEY.author, { skipHttp: true });
  if (!handle) return undefined;
  const creator: CapturedCreator = { handle };
  if (source === "reddit") creator.url = `https://www.reddit.com/user/${handle}/`;
  return creator;
}

function pickTimestamp(node: Json): number | undefined {
  for (const [key, value] of entries(node)) {
    if (!KEY.time.test(key)) continue;
    const number = jsonFiniteNumber(value);
    if (number !== undefined) {
      if (number > 1e15) return Math.round(number / 1000);
      if (number > 1e12) return number;
      if (number > 1e9) return number * 1000;
    }
    const text = jsonString(value);
    if (text !== undefined) {
      const parsed = Date.parse(text);
      if (Number.isFinite(parsed)) return parsed;
      if (/^\d+$/.test(text)) return pickTimestamp({ timestamp: Number(text) });
    }
  }
  return undefined;
}

function pickPermalink(node: Json): string | undefined {
  for (const [key, value] of entries(node)) {
    const text = jsonString(value);
    if (text === undefined || !KEY.url.test(key) || KEY.avatar.test(key)) continue;
    if (isHttp(text) && !MEDIA_EXT.test(text)) return text;
    if (text.startsWith("/") && text.length > 1) return text;
  }
  return undefined;
}

function collectEntityStrings(
  node: Json,
  arrayKey: RegExp,
  valueKeys: readonly string[],
): string[] {
  const output: string[] = [];
  const seen = new Set<string>();
  for (const [key, value] of entries(node)) {
    if (!arrayKey.test(key) || !Array.isArray(value)) continue;
    for (const candidate of value.slice(0, 64)) {
      let raw = jsonString(candidate);
      const objectCandidate = jsonObject(candidate);
      if (raw === undefined && objectCandidate) raw = directString(objectCandidate, valueKeys);
      const normalized = raw?.replace(/^[@#]+/u, "").trim();
      if (!normalized || seen.has(normalized.toLowerCase())) continue;
      seen.add(normalized.toLowerCase());
      output.push(normalized.slice(0, 128));
      if (output.length >= 32) return output;
    }
  }
  return output;
}

function firstNestedName(node: Json, keyPattern: RegExp): string | undefined {
  for (const [key, value] of entries(node)) {
    if (!keyPattern.test(key)) continue;
    const text = jsonString(value);
    if (text?.trim()) return decodeEntities(text.trim()).slice(0, 512);
    if (isObj(value)) {
      const name = directString(value, ["name", "title", "label"]);
      if (name) return name.slice(0, 512);
    }
  }
  return undefined;
}

function firstQuotedPost(node: Json, source: string): CapturedQuotedPost | undefined {
  for (const [key, value] of entries(node)) {
    if (!/(quoted_status_result|quoted_status|quotedPost)/iu.test(key) || !isObj(value)) continue;
    const text = pickText(value).slice(0, 16_000);
    const author = pickCreator(value, source);
    const url = pickPermalink(value);
    if (!text && !author && !url) continue;
    const quotedPost: CapturedQuotedPost = {};
    if (url && isHttp(url)) quotedPost.url = url;
    if (text) quotedPost.text = text;
    if (author) quotedPost.author = author;
    return quotedPost;
  }
  return undefined;
}

export interface NormalizeCtx {
  source: string;
  idPrefix: string;
  connector: string;
  defaultType?: string;
  origin?: string;
  buildUrl?: (parts: { id: string; handle?: string; code?: string }) => string | undefined;
}

/** Turn one provider entry into the stable connector item contract. */
export function normalizeEntry(entry: Obj, context: NormalizeCtx): CapturedItem | null {
  const id = pickId(entry);
  if (!id || id.length > 240) return null;
  const redditTitle = context.source === "reddit"
    ? pickTextByKey(entry, /^(title|link_title)$/iu)
    : "";
  const redditBody = context.source === "reddit"
    ? pickTextByKey(entry, /^(selftext|body)$/iu)
    : "";
  const text = context.source === "reddit" ? (redditBody || redditTitle) : pickText(entry);
  const title = (redditTitle || text.split("\n").find(Boolean) || `${context.source} item`).slice(0, 140);
  const creator = pickCreator(entry, context.source);
  const handle = creator?.handle ?? pickString(entry, KEY.author, { skipHttp: true });
  const code = pickString(entry, KEY.code, { skipHttp: true });
  const media = collectMedia(entry, context.source);
  let url = pickPermalink(entry);
  if (url?.startsWith("/")) url = (context.origin ?? "").replace(/\/$/, "") + url;
  if (!url) url = context.buildUrl?.({ id, handle, code }) || "";
  const externalId = `${context.idPrefix}:${id}`;
  const postedAt = pickTimestamp(entry);
  const likes = pickNumber(entry, KEY.likes);
  const upvotes = pickNumber(entry, KEY.ups);
  const comments = pickNumber(entry, KEY.comments);
  const replies = pickNumber(entry, KEY.replies);
  const reposts = pickNumber(entry, KEY.reposts);
  const views = pickNumber(entry, KEY.views);
  const saves = pickNumber(entry, KEY.saves);
  const shares = pickNumber(entry, KEY.shares);
  const communityName = context.source === "reddit"
    ? pickString(entry, /^(subreddit|subreddit_name_prefixed)$/iu, { skipHttp: true })
      ?.replace(/^r\//u, "")
    : undefined;
  const communityId = context.source === "reddit"
    ? pickString(entry, /^(subreddit_id)$/iu, { skipHttp: true })
    : undefined;
  const hashtags = collectEntityStrings(entry, /hashtags/iu, ["text", "tag", "name"]);
  const mentions = collectEntityStrings(entry, /(user_mentions|mentions|mentioned_users)/iu, [
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

  const collectedStats: CapturedStats = {};
  if (likes !== undefined) collectedStats.likes = likes;
  if (upvotes !== undefined) collectedStats.upvotes = upvotes;
  if (comments !== undefined) collectedStats.comments = comments;
  if (replies !== undefined) collectedStats.replies = replies;
  if (reposts !== undefined) collectedStats.reposts = reposts;
  if (views !== undefined) collectedStats.views = views;
  if (saves !== undefined) collectedStats.saves = saves;
  if (shares !== undefined) collectedStats.shares = shares;
  const stats = Object.keys(collectedStats).length ? collectedStats : undefined;

  let community: CapturedCommunity | undefined;
  if (communityName || communityId) {
    community = {};
    if (communityId) community.id = communityId;
    if (communityName) {
      community.name = communityName;
      community.url = `https://www.reddit.com/r/${communityName}/`;
    }
  }
  const language = pickString(entry, /^(lang|language|lang_code)$/iu, { skipHttp: true });
  const quotedPost = context.source === "twitter" ? firstQuotedPost(entry, context.source) : undefined;
  const flair = context.source === "reddit"
    ? pickString(entry, /^(link_flair_text|flair)$/iu, { skipHttp: true })
    : undefined;
  const crosspostOrigin = context.source === "reddit"
    ? pickString(entry, /^(crosspost_parent)$/iu, { skipHttp: true })
    : undefined;
  const linkedDomain = context.source === "reddit"
    ? pickString(entry, /^(domain)$/iu, { skipHttp: true })
    : undefined;
  const postKind = context.source === "reddit"
    ? pickString(entry, /^(post_hint|kind)$/iu, { skipHttp: true })
    : undefined;
  const conversationId = context.source === "twitter"
    ? pickString(entry, /^(conversation_id_str|conversation_id)$/iu, { skipHttp: true })
    : undefined;
  const location = context.source === "instagram"
    ? firstNestedName(entry, /^location$/iu)
    : undefined;
  const originalAudio = context.source === "instagram"
    ? firstNestedName(entry, /(music_metadata|original_sound_info|audio)/iu)
      ?? pickTextByKey(entry, /(song_name|audio_title|music_title|original_audio)/iu)
    : undefined;
  const mediaKind = pickString(entry, /^(product_type|post_hint|media_kind)$/iu, { skipHttp: true });
  const capturedAt = Date.now();
  const normalizedAuthor = creator ?? (handle ? { handle } : undefined);

  const inline: CapturedSourceInline = { id, title, description: text };
  if (normalizedAuthor) inline.author = normalizedAuthor;
  if (postedAt !== undefined) inline.postedAt = postedAt;
  if (stats) inline.stats = stats;
  if (community) inline.community = community;
  if (language) inline.language = language;
  if (hashtags.length) inline.hashtags = hashtags;
  if (mentions.length) inline.mentions = mentions;
  if (quotedPost) inline.quotedPost = quotedPost;
  if (flair) inline.flair = flair;
  if (crosspostOrigin) inline.crosspostOrigin = crosspostOrigin;
  if (linkedDomain) inline.domain = linkedDomain;
  if (postKind) inline.postKind = postKind;
  if (conversationId) inline.conversationId = conversationId;
  if (location) inline.location = { name: location };
  if (originalAudio) inline.audio = { title: originalAudio };
  if (mediaKind) inline.mediaKind = mediaKind;

  const images: CapturedInlineImage[] = [];
  const videos: CapturedInlineVideo[] = [];
  for (const mediaItem of media) {
    if (mediaItem.type === "image") {
      const image: CapturedInlineImage = { url: mediaItem.url };
      if (mediaItem.width !== undefined) image.width = mediaItem.width;
      if (mediaItem.height !== undefined) image.height = mediaItem.height;
      if (mediaItem.altText) image.altText = mediaItem.altText;
      images.push(image);
    }
    if (mediaItem.type === "video") {
      const video: CapturedInlineVideo = { url: mediaItem.url };
      if (mediaItem.thumbnailUrl) video.thumbnailUrl = mediaItem.thumbnailUrl;
      if (mediaItem.durationSec !== undefined) video.durationSec = mediaItem.durationSec;
      videos.push(video);
    }
  }
  if (images.length) inline.images = images;
  if (videos.length) inline.videos = videos;

  const fields: CapturedItemFields = { externalId, connector: context.connector };
  if (postedAt !== undefined) fields.postedAt = postedAt;
  if (comments !== undefined) fields.comments = comments;
  if (replies !== undefined) fields.replies = replies;
  if (reposts !== undefined) fields.reposts = reposts;
  if (views !== undefined) fields.views = views;
  if (saves !== undefined) fields.saves = saves;
  if (shares !== undefined) fields.shares = shares;
  if (communityName) fields.community = communityName;
  if (communityId) fields.subredditId = communityId;
  if (hashtags.length) fields.hashtags = hashtags;
  if (mentions.length) fields.mentions = mentions;
  if (flair) fields.flair = flair;
  if (crosspostOrigin) fields.crosspostOrigin = crosspostOrigin;
  if (linkedDomain) fields.linkedDomain = linkedDomain;
  if (postKind) fields.postKind = postKind;
  if (conversationId) fields.conversationId = conversationId;
  if (location) fields.location = location;
  if (originalAudio) fields.originalAudio = originalAudio;
  if (mediaKind) fields.mediaKind = mediaKind;

  const social: CapturedSocialMetadata = { platform: context.source, postId: id };
  if (normalizedAuthor) social.author = normalizedAuthor;
  if (community) social.community = community;
  if (postedAt !== undefined) social.postedAt = postedAt;
  if (language) social.language = language;
  if (stats) social.stats = stats;
  if (quotedPost) social.quotedPost = quotedPost;

  const sourceRecord: CapturedSourceRecord = {
    id: `${context.connector}:${externalId}`.slice(0, 256),
    provider: context.source,
    kind: "api",
    adapterVersion: "extension-social-v1",
    externalId,
    fetchedAt: capturedAt,
    inline,
  };
  if (url && isHttp(url)) sourceRecord.canonicalUrl = url;

  const item: CapturedItem = {
    externalId,
    url,
    title,
    textContent: text,
    source: context.source,
    type: context.defaultType || (context.source === "reddit" ? "forum" : "social"),
    media,
    fields,
    metadata: {
      schemaVersion: 1,
      social,
      provenance: {
        method: "extension",
        importer: context.connector,
        externalId,
        capturedAt,
        importedAt: capturedAt,
      },
      sourceRecords: [sourceRecord],
    },
  };
  if (handle) item.authorUsername = handle;
  if (likes !== undefined) item.likes = likes;
  if (upvotes !== undefined) item.upvotes = upvotes;
  if (postedAt !== undefined) item.postedAt = postedAt;
  return item;
}
