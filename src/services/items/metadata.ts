import type { ItemDocType } from "@src/schemas/item_schema";
import {
  isWriteConflict,
  triggerBackgroundProcessing,
} from "@src/services/items/runtime";
import type { MyDatabase } from "@src/services/DatabaseService";
import { hasVectorReference } from "@src/search-core/embedding-state";
import { categorizeMedia, getMediaCounts, MEDIA_LIMITS } from "@src/services/media-storage";
import { appendOcrTextToTextContent } from "@src/services/ocr-text";
import { isMetadataFetchableUrl } from "@src/utils/metadata-url";
import { isYouTubeShortsUrl } from "@src/utils/media-embed";

type ItemMedia = ItemDocType["media"];
type ItemMediaEntry = NonNullable<ItemMedia>[number];

export type SaveFetchedMetadataPayload = {
  metaMap: Record<string, Partial<ItemDocType>>;
  forceRefresh?: boolean;
  forceRefreshUrls?: string[];
};

export type SaveFetchedMetadataResult = {
  updated: number;
};

export type PendingMetadataUrlsPayload = {
  limit?: number;
};

export type PendingMetadataUrlsResult = {
  urls: string[];
};

function mediaEntryKey(entry: ItemMediaEntry): string | null {
  const value = entry.embedUrl || entry.s3Url || entry.opfsPath || entry.originalUrl;
  const normalized = value.trim();
  return normalized ? `${entry.type}:${normalized}` : null;
}

function mergeFetchedMedia(currentMedia: ItemMedia, fetchedMedia: ItemMedia): ItemMedia {
  if (!fetchedMedia || fetchedMedia.length === 0) return currentMedia;
  if (!currentMedia || currentMedia.length === 0) return fetchedMedia;

  const existing: ItemMediaEntry[] = [];
  const acceptedFetched: ItemMediaEntry[] = [];
  const seen = new Set<string>();
  const counts = getMediaCounts(
    currentMedia.map((entry) => ({
      type: entry.type,
      originalUrl: entry.originalUrl || entry.s3Url || "",
    })),
  );

  for (const entry of currentMedia) {
    const key = mediaEntryKey(entry);
    if (key && seen.has(key)) continue;
    if (key) seen.add(key);
    existing.push(entry);
  }

  for (const entry of fetchedMedia) {
    const key = mediaEntryKey(entry);
    if (key && seen.has(key)) continue;
    const category = categorizeMedia({
      type: entry.type,
      originalUrl: entry.originalUrl || entry.s3Url || "",
    });
    if (counts[category] >= MEDIA_LIMITS[category]) continue;
    counts[category] += 1;
    if (key) seen.add(key);
    acceptedFetched.push(entry);
  }

  const storedExisting = existing.filter(
    (entry) => entry.storageType === "opfs" || entry.storageType === "s3",
  );
  const hotlinkExisting = existing.filter((entry) => entry.storageType === "hotlink");
  return [...storedExisting, ...acceptedFetched, ...hotlinkExisting];
}

function hasStoredMedia(media: ItemMedia): boolean {
  return (media || []).some(
    (entry) => entry.storageType === "opfs" || entry.storageType === "s3",
  );
}

function buildMetadataPatch(
  current: ItemDocType,
  metadata: Partial<ItemDocType> | undefined,
  forceRefresh: boolean,
): Partial<ItemDocType> {
  const patch: Partial<ItemDocType> = {};
  if (!metadata) {
    patch.isMetaFetched = true;
    return patch;
  }

  let embeddingRelevantChanged = false;
  if (metadata.title !== undefined && metadata.title !== current.title) {
    patch.title = metadata.title;
    embeddingRelevantChanged = true;
  }
  if (metadata.textContent !== undefined) {
    const textContent = appendOcrTextToTextContent(metadata.textContent, current.ocrText);
    if (textContent !== current.textContent) {
      patch.textContent = textContent;
      embeddingRelevantChanged = true;
    }
  }
  if (metadata.iconUrl !== undefined) patch.iconUrl = metadata.iconUrl;
  if (
    metadata.displayImageUrl !== undefined &&
    !hasStoredMedia(current.media) &&
    (forceRefresh || !current.displayImageUrl || isYouTubeShortsUrl(current.url))
  ) {
    patch.displayImageUrl = metadata.displayImageUrl;
  }
  if (metadata.source && metadata.source !== current.source) {
    patch.source = metadata.source;
  }
  if (
    metadata.authorUsername !== undefined &&
    metadata.authorUsername !== current.authorUsername
  ) {
    patch.authorUsername = metadata.authorUsername;
    embeddingRelevantChanged = true;
  }
  if (metadata.updatedAt !== undefined && metadata.updatedAt > 0) {
    patch.updatedAt = metadata.updatedAt;
  }
  if (metadata.media !== undefined) {
    patch.media = mergeFetchedMedia(current.media, metadata.media);
  }
  if (embeddingRelevantChanged) patch.isDirty = true;
  patch.isMetaFetched = true;
  return patch;
}

function repairEmbeddedState(
  current: ItemDocType,
  patch: Partial<ItemDocType>,
): void {
  if (current.isMetaFetched || !current.isEmbedded) return;
  if (hasVectorReference(current)) {
    patch.isDirty = true;
    return;
  }
  patch.vector_index = -1;
  patch.vector_indexes = [];
  patch.isEmbedded = false;
  patch.isDirty = false;
}

export async function saveFetchedMetadata(
  db: MyDatabase,
  payload: SaveFetchedMetadataPayload,
): Promise<SaveFetchedMetadataResult> {
  const urls = Object.keys(payload.metaMap);
  if (urls.length === 0) return { updated: 0 };
  const forceRefreshUrls = new Set(payload.forceRefreshUrls || []);
  const documents = await db.items.find({ selector: { url: { $in: urls } } }).exec();

  for (const originalDocument of documents) {
    const maxAttempts = 5;
    for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
      const document = await db.items.findOne(originalDocument.primary).exec();
      if (!document) break;
      const current = document.toMutableJSON();
      const refreshAll = payload.forceRefresh === true && payload.forceRefreshUrls === undefined;
      const forceRefresh = refreshAll || (
        payload.forceRefresh === true && forceRefreshUrls.has(current.url)
      );
      const patch = buildMetadataPatch(
        current,
        payload.metaMap[current.url],
        forceRefresh,
      );
      repairEmbeddedState(current, patch);

      try {
        await document.patch(patch);
        break;
      } catch (error) {
        if (!isWriteConflict(error)) throw error;
      }
    }
  }

  triggerBackgroundProcessing("TRIGGER_EMBEDDING");
  return { updated: documents.length };
}

export async function getPendingMetadataUrls(
  db: MyDatabase,
  payload: PendingMetadataUrlsPayload = {},
): Promise<PendingMetadataUrlsResult> {
  const requestedLimit = payload.limit ?? 500;
  const limit = Number.isFinite(requestedLimit)
    ? Math.max(1, Math.min(1_000, Math.floor(requestedLimit)))
    : 500;
  const documents = await db.items.find({
    selector: { isMetaFetched: false, deletedAt: { $eq: 0 } },
    limit,
  }).exec();
  const urls = Array.from(
    new Set(
      documents
        .map((document) => document.get("url") || "")
        .filter((url) => isMetadataFetchableUrl(url)),
    ),
  );
  return { urls };
}
