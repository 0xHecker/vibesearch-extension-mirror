import { jsonString } from "@src/common/json-value";
import type { CapturedMedia } from "@src/services/connectors/cloud-push";
import {
  cleanHttpUrl,
  decodeEntities,
  directArray,
  directNumber,
  directObject,
  directString,
  isHttp,
  isObj,
  KEY,
  MEDIA_EXT,
  VIDEO_EXT,
  walk,
  type Json,
  type Obj,
} from "./primitives";

type MediaCandidate = {
  node: Obj;
  url: string;
  width?: number;
  height?: number;
  bitrate?: number;
  mimeType?: string;
};

function toMediaCandidate(
  value: Json,
  urlKeys: readonly string[],
): MediaCandidate | undefined {
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
}

function chooseBestCandidate(
  values: Json[] | undefined,
  urlKeys: readonly string[],
  priority: "area" | "bitrate" = "area",
  predicate: (candidate: MediaCandidate) => boolean = () => true,
): MediaCandidate | undefined {
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
    const winsByBitrate = bitrate > bestBitrate || (bitrate === bestBitrate && area > bestArea);
    const winsByArea = area > bestArea || (area === bestArea && bitrate > bestBitrate);
    const better = priority === "bitrate" ? winsByBitrate : winsByArea;
    if (better) best = candidate;
  }
  return best;
}

const MAX_LOGICAL_MEDIA = 32;

/** Conservative fallback for a provider shape we do not recognise yet. */
export function collectMediaFallback(node: Json): CapturedMedia[] {
  const output: CapturedMedia[] = [];
  const seen = new Set<string>();
  const add = (url: string, type: CapturedMedia["type"]) => {
    const clean = decodeEntities(url);
    if (!isHttp(clean) || seen.has(clean)) return;
    seen.add(clean);
    output.push({ type, url: clean });
  };
  const visit = (value: Json, keyName: string) => {
    const text = jsonString(value);
    if (text !== undefined) {
      if (KEY.avatar.test(keyName)) return;
      if (MEDIA_EXT.test(text) && isHttp(text)) {
        add(text, VIDEO_EXT.test(text) ? "video" : "image");
      } else if (isHttp(text) && KEY.media.test(keyName)) {
        add(text, /video|playback/iu.test(keyName) ? "video" : "image");
      }
      return;
    }
    if (Array.isArray(value)) {
      for (const child of value) visit(child, keyName);
      return;
    }
    if (isObj(value)) {
      for (const key of Object.keys(value)) visit(value[key], key);
    }
  };
  visit(node, "");
  return output.slice(0, MAX_LOGICAL_MEDIA);
}

function mediaIdentity(id: string | undefined, provider: string): Partial<CapturedMedia> {
  return id ? { id, externalId: id, provider } : { provider };
}

type MediaDimensions = {
  width?: number;
  height?: number;
};

function mediaDimensions(primary: Obj | undefined, fallback?: Obj): MediaDimensions {
  const width = (primary ? directNumber(primary, ["width", "w", "x"]) : undefined)
    ?? (fallback ? directNumber(fallback, ["width", "w", "x", "original_width"]) : undefined);
  const height = (primary ? directNumber(primary, ["height", "h", "y"]) : undefined)
    ?? (fallback ? directNumber(fallback, ["height", "h", "y", "original_height"]) : undefined);
  const dimensions: MediaDimensions = {};
  if (width !== undefined) dimensions.width = width;
  if (height !== undefined) dimensions.height = height;
  return dimensions;
}

function finalizeMedia(items: CapturedMedia[]): CapturedMedia[] {
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
}

function unwrapXResult(value: Obj): Obj {
  return directObject(value, ["tweet"]) ?? value;
}

/** Main tweet result only; quoted tweets remain metadata, not saved-post media. */
function findXPost(entry: Json): Obj | undefined {
  for (const { node } of walk(entry)) {
    for (const key of ["tweet_results", "tweetResult"] as const) {
      const container = node[key];
      if (!isObj(container) || !isObj(container.result)) continue;
      return unwrapXResult(container.result);
    }
  }
  return undefined;
}

function xAltText(media: Obj): string | undefined {
  return directString(media, ["ext_alt_text", "alt_text", "altText", "accessibility_caption"]);
}

function extractXMedia(entry: Json): CapturedMedia[] | undefined {
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
      const mediaItem: CapturedMedia = {
        type: "video",
        url,
        ...mediaIdentity(id, "twitter"),
        ...dimensions,
      };
      if (poster) mediaItem.thumbnailUrl = poster;
      if (variant?.mimeType) mediaItem.mimeType = variant.mimeType;
      if (durationMillis !== undefined) mediaItem.durationSec = durationMillis / 1000;
      if (altText) mediaItem.altText = altText;
      output.push(mediaItem);
      continue;
    }

    if (!poster) continue;
    const mediaItem: CapturedMedia = {
      type: "image",
      url: poster,
      ...mediaIdentity(id, "twitter"),
      ...dimensions,
    };
    if (altText) mediaItem.altText = altText;
    output.push(mediaItem);
  }
  return finalizeMedia(output);
}

type RedditPreview = {
  url: string;
  width?: number;
  height?: number;
};

function redditPreviewImage(post: Obj): RedditPreview | undefined {
  const preview = directObject(post, ["preview"]);
  const first = directArray(preview ?? {}, ["images"])?.find(isObj);
  if (!isObj(first)) return undefined;
  const source = directObject(first, ["source", "s"]);
  const sourceUrl = source ? cleanHttpUrl(directString(source, ["url", "u"])) : undefined;
  if (sourceUrl) return { url: sourceUrl, ...mediaDimensions(source) };
  const candidate = chooseBestCandidate(directArray(first, ["resolutions", "p"]), ["url", "u"]);
  return candidate
    ? { url: candidate.url, width: candidate.width, height: candidate.height }
    : undefined;
}

function redditGalleryMedia(
  id: string,
  metadata: Obj,
  listingItem?: Obj,
): CapturedMedia | undefined {
  const source = directObject(metadata, ["s", "source"]);
  const preview = chooseBestCandidate(directArray(metadata, ["p", "resolutions"]), ["u", "url"]);
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
    const media: CapturedMedia = {
      type: "video",
      url: directVideo,
      ...mediaIdentity(id, "reddit"),
      mimeType: mimeType?.startsWith("video/") ? mimeType : "video/mp4",
      ...mediaDimensions(source, metadata),
    };
    if (thumbnailUrl) media.thumbnailUrl = thumbnailUrl;
    if (altText) media.altText = altText;
    return media;
  }

  const sourceUrl = source ? cleanHttpUrl(directString(source, ["u", "url", "gif"])) : undefined;
  const url = sourceUrl ?? preview?.url;
  if (!url) return undefined;
  const media: CapturedMedia = {
    type: entityKind.includes("video") && VIDEO_EXT.test(url) ? "video" : "image",
    url,
    ...mediaIdentity(id, "reddit"),
  };
  if (mimeType) media.mimeType = mimeType;
  if (sourceUrl) {
    Object.assign(media, mediaDimensions(source, metadata));
  } else {
    if (preview?.width !== undefined) media.width = preview.width;
    if (preview?.height !== undefined) media.height = preview.height;
  }
  if (altText) media.altText = altText;
  return media;
}

function redditGallery(post: Obj): CapturedMedia[] | undefined {
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
}

function redditVideo(post: Obj): CapturedMedia | undefined {
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
  const mediaItem: CapturedMedia = {
    type: "video",
    url,
    mimeType: "video/mp4",
    ...mediaDimensions(video),
    provider: "reddit",
  };
  if (thumbnail) mediaItem.thumbnailUrl = thumbnail.url;
  if (durationSec !== undefined) mediaItem.durationSec = durationSec;
  if (altText) mediaItem.altText = altText;
  return mediaItem;
}

function extractRedditMedia(entry: Json): CapturedMedia[] | undefined {
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
    const media: CapturedMedia = { type: "image", url: preview.url, provider: "reddit" };
    if (preview.width !== undefined) media.width = preview.width;
    if (preview.height !== undefined) media.height = preview.height;
    return [media];
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
}

function instagramRoot(entry: Obj): Obj {
  const wrapped = directObject(entry, ["media"]);
  if (
    wrapped && (
      wrapped.pk !== undefined || wrapped.id !== undefined || wrapped.media_type !== undefined ||
      wrapped.image_versions2 !== undefined || wrapped.video_versions !== undefined
    )
  ) return wrapped;
  return entry;
}

function instagramImageCandidate(media: Obj): MediaCandidate | undefined {
  const versions = directObject(media, ["image_versions2", "imageVersions2", "image_versions"]);
  return chooseBestCandidate(directArray(versions ?? {}, ["candidates"]), ["url"]);
}

function instagramAltText(media: Obj, fallback?: string): string | undefined {
  return directString(media, [
    "accessibility_caption",
    "accessibilityCaption",
    "alt_text",
    "altText",
  ]) ?? fallback;
}

function instagramDuration(media: Obj): number | undefined {
  const seconds = directNumber(media, ["video_duration", "videoDuration", "duration"]);
  if (seconds !== undefined) return seconds;
  const millis = directNumber(media, ["duration_millis", "durationMillis", "duration_ms"]);
  return millis !== undefined ? millis / 1000 : undefined;
}

function instagramLogicalMedia(media: Obj, fallbackAlt?: string): CapturedMedia | undefined {
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
    const mediaItem: CapturedMedia = {
      type: "video",
      url: video.url,
      ...mediaIdentity(id, "instagram"),
      ...mediaDimensions(video.node, media),
    };
    if (image) mediaItem.thumbnailUrl = image.url;
    if (durationSec !== undefined) mediaItem.durationSec = durationSec;
    if (altText) mediaItem.altText = altText;
    return mediaItem;
  }
  if (!image) return undefined;
  const mediaItem: CapturedMedia = {
    type: "image",
    url: image.url,
    ...mediaIdentity(id, "instagram"),
    ...mediaDimensions(image.node, media),
  };
  if (altText) mediaItem.altText = altText;
  return mediaItem;
}

function extractInstagramMedia(entry: Json): CapturedMedia[] | undefined {
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
}

export function collectMedia(node: Json, source?: string): CapturedMedia[] {
  let providerMedia: CapturedMedia[] | undefined;
  if (source === "twitter") providerMedia = extractXMedia(node);
  if (source === "reddit") providerMedia = extractRedditMedia(node);
  if (source === "instagram") providerMedia = extractInstagramMedia(node);
  return providerMedia ?? collectMediaFallback(node);
}
