import type { JsonObject, JsonValue } from "@src/common/json-value";
import { nextBinMutationTimestamp } from "@src/common/bin";
import { PUBLIC_SPACE_ID } from "@src/common/spaces";
import type { ItemDocType } from "@src/schemas/item_schema";
import {
  assertSpaceUnlocked,
  isWriteConflict,
  notifyDatabaseChanged,
  triggerBackgroundProcessing,
} from "@src/services/items/runtime";
import type { MyDatabase } from "@src/services/DatabaseService";
import { withEntityMutationLock } from "@src/services/entity-mutation-lock";
import {
  canAddMedia,
  getMediaCounts,
  inferMediaType,
  isGifUrl,
  MEDIA_LIMITS,
  type MediaCategory,
} from "@src/services/media-storage";
import { deleteUnreferencedOpfsFiles } from "@src/services/opfs-media-lifecycle";
import { z } from "zod";

type ItemMedia = ItemDocType["media"];
type ItemMediaEntry = NonNullable<ItemMedia>[number];

export type ItemMediaMutationResult = {
  success: boolean;
  error?: string;
};

export type UpdateItemMediaPayload = {
  id: string;
  media: ItemMedia;
  /** The media state the editor based this full-array replacement on. */
  expectedMedia?: ItemMedia;
  preserveOcr?: boolean;
};

export type RemoveItemMediaPayload = {
  id: string;
  index: number;
};

export type AddItemMediaPayload = {
  id: string;
  url: string;
  type?: "image" | "video";
  altText?: string;
};

export type ReplaceItemMediaPayload = {
  id: string;
  index: number;
  url: string;
  type?: "image" | "video";
};

type MediaPatchPlan = {
  patch: Partial<ItemDocType>;
  removedOpfsPaths: string[];
};

type MediaPatchDecision =
  | { kind: "apply"; plan: MediaPatchPlan }
  | { kind: "reject"; error: string };

type BuildMediaPatch = (current: ItemDocType) => MediaPatchDecision;

const jsonValueSchema: z.ZodType<JsonValue> = z.json();
const jsonArraySchema = z.array(jsonValueSchema);
const jsonObjectSchema = z.record(z.string(), jsonValueSchema);

function canonicalizeJson(value: JsonValue): JsonValue {
  const array = jsonArraySchema.safeParse(value);
  if (array.success) return array.data.map(canonicalizeJson);

  const object = jsonObjectSchema.safeParse(value);
  if (!object.success) return value;
  const ordered: JsonObject = {};
  for (const key of Object.keys(object.data).sort()) {
    ordered[key] = canonicalizeJson(object.data[key]);
  }
  return ordered;
}

function serializeMediaSnapshot(media: ItemMedia): string {
  const serialized = JSON.stringify(media || []);
  const parsed = jsonValueSchema.parse(JSON.parse(serialized));
  return JSON.stringify(canonicalizeJson(parsed));
}

function mediaSnapshotsEqual(left: ItemMedia, right: ItemMedia): boolean {
  return serializeMediaSnapshot(left) === serializeMediaSnapshot(right);
}

function nextMutationTimestamp(current: ItemDocType): number {
  return nextBinMutationTimestamp(Date.now(), current.updatedAt, current.deletedAt);
}

function mediaDisplayImage(media: readonly ItemMediaEntry[]): string | undefined {
  const image = media.find((entry) => entry.type === "image");
  return image?.s3Url || image?.originalUrl;
}

function mediaPatch(
  current: ItemDocType,
  media: ItemMediaEntry[],
  extra: Partial<ItemDocType> = {},
): Partial<ItemDocType> {
  const displayImageUrl = mediaDisplayImage(media);
  const patch: Partial<ItemDocType> = {
    ...extra,
    media,
    updatedAt: nextMutationTimestamp(current),
    isDirty: true,
  };
  if (displayImageUrl) patch.displayImageUrl = displayImageUrl;
  return patch;
}

function removedPaths(
  currentMedia: ItemMedia,
  nextMedia: readonly ItemMediaEntry[],
): string[] {
  const retained = new Set(nextMedia.flatMap((entry) => entry.opfsPath ? [entry.opfsPath] : []));
  return Array.from(
    new Set(
      (currentMedia || []).flatMap((entry) => {
        const path = entry.opfsPath || "";
        return path && !retained.has(path) ? [path] : [];
      }),
    ),
  );
}

async function cleanupRemovedPaths(db: MyDatabase, paths: readonly string[]): Promise<void> {
  if (paths.length === 0) return;
  try {
    await deleteUnreferencedOpfsFiles(
      db,
      paths.map((opfsPath) => ({ opfsPath })),
    );
  } catch {
    // The scheduled OPFS reconciler owns cleanup that cannot complete inline.
  }
}

async function commitMediaMutation(
  db: MyDatabase,
  itemId: string,
  buildPatch: BuildMediaPatch,
): Promise<ItemMediaMutationResult> {
  let pathsToClean: string[] = [];
  const result = await withEntityMutationLock(db, "item", itemId, async () => {
    const maxAttempts = 5;
    for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
      const document = await db.items.findOne(itemId).exec();
      if (!document) return { success: false, error: "NOT_FOUND" };

      const current = document.toMutableJSON();
      assertSpaceUnlocked(current.spaceId || PUBLIC_SPACE_ID);
      if (current.deletedAt > 0) {
        return { success: false, error: "ITEM_NOT_LIVE" };
      }

      const decision = buildPatch(current);
      if (decision.kind === "reject") {
        return { success: false, error: decision.error };
      }

      try {
        await document.patch(decision.plan.patch);
        pathsToClean = decision.plan.removedOpfsPaths;
        return { success: true };
      } catch (error) {
        if (!isWriteConflict(error)) throw error;
      }
    }
    return { success: false, error: "CONFLICT" };
  });

  if (!result.success) return result;
  await cleanupRemovedPaths(db, pathsToClean);
  notifyDatabaseChanged("items");
  return result;
}

function validateMediaLimits(media: readonly ItemMediaEntry[]): string | undefined {
  const counts = getMediaCounts(
    media.map((entry) => ({
      type: entry.type,
      originalUrl: entry.originalUrl || entry.s3Url || "",
    })),
  );
  if (counts.image > MEDIA_LIMITS.image) {
    return `Too many images (max ${MEDIA_LIMITS.image})`;
  }
  if (counts.gif > MEDIA_LIMITS.gif) {
    return `Too many GIFs (max ${MEDIA_LIMITS.gif})`;
  }
  if (counts.video > MEDIA_LIMITS.video) {
    return `Too many videos (max ${MEDIA_LIMITS.video})`;
  }
  return undefined;
}

function resetImageOcr(media: readonly ItemMediaEntry[]): ItemMediaEntry[] {
  return media.map((entry) => {
    if (entry.type !== "image") return entry;
    const { ocr: _previousOcr, ...entryWithoutOcr } = entry;
    return {
      ...entryWithoutOcr,
      ocr: {
        status: "pending",
        lineCount: 0,
        extractedAt: Date.now(),
        engine: "paddleocr",
      },
    };
  });
}

function ocrResetPatch(): Partial<ItemDocType> {
  return {
    ocrText: "",
    ocrStatus: "pending",
    ocrError: "",
    ocrModelVersion: "",
    ocrSourceHash: "",
    ocrUpdatedAt: 0,
    ocrConfidence: null,
    ocrLineCount: 0,
  };
}

export async function updateItemMedia(
  db: MyDatabase,
  payload: UpdateItemMediaPayload,
): Promise<ItemMediaMutationResult> {
  const itemId = payload.id.trim();
  if (!itemId) return { success: false, error: "NOT_FOUND" };
  if (payload.expectedMedia === undefined) {
    return { success: false, error: "EXPECTED_MEDIA_REQUIRED" };
  }

  const incomingMedia = payload.media || [];
  const hasImageMedia = incomingMedia.some((entry) => entry.type === "image");
  const shouldResetOcr = hasImageMedia && payload.preserveOcr !== true;
  const nextMedia = shouldResetOcr ? resetImageOcr(incomingMedia) : incomingMedia;
  const limitError = validateMediaLimits(nextMedia);
  if (limitError) return { success: false, error: limitError };

  const result = await commitMediaMutation(db, itemId, (current) => {
    if (!mediaSnapshotsEqual(current.media, payload.expectedMedia)) {
      return { kind: "reject", error: "MEDIA_CHANGED" };
    }
    return {
      kind: "apply",
      plan: {
        patch: mediaPatch(current, nextMedia, shouldResetOcr ? ocrResetPatch() : {}),
        removedOpfsPaths: removedPaths(current.media, nextMedia),
      },
    };
  });
  if (!result.success) return result;

  triggerBackgroundProcessing("TRIGGER_EMBEDDING");
  if (hasImageMedia && payload.preserveOcr !== true) {
    triggerBackgroundProcessing("TRIGGER_OCR");
  }
  if (nextMedia.some((entry) => Boolean(entry.opfsPath))) {
    try {
      void Promise.resolve(
        chrome.runtime.sendMessage({ type: "PROMOTE_OPFS_MEDIA", target: "background" }),
      ).catch(() => undefined);
    } catch {
      // The background startup path will discover pending OPFS media later.
    }
  }
  return result;
}

export async function removeItemMedia(
  db: MyDatabase,
  payload: RemoveItemMediaPayload,
): Promise<ItemMediaMutationResult> {
  const itemId = payload.id.trim();
  if (!itemId) return { success: false, error: "NOT_FOUND" };
  if (!Number.isInteger(payload.index) || payload.index < 0) {
    return { success: false, error: "INVALID_INDEX" };
  }

  return commitMediaMutation(db, itemId, (current) => {
    const media = current.media || [];
    if (payload.index >= media.length) {
      return { kind: "reject", error: "INVALID_INDEX" };
    }
    const nextMedia = media.filter((_entry, index) => index !== payload.index);
    return {
      kind: "apply",
      plan: {
        patch: mediaPatch(current, nextMedia),
        removedOpfsPaths: removedPaths(current.media, nextMedia),
      },
    };
  });
}

export async function addItemMedia(
  db: MyDatabase,
  payload: AddItemMediaPayload,
): Promise<ItemMediaMutationResult> {
  const itemId = payload.id.trim();
  if (!itemId) return { success: false, error: "NOT_FOUND" };
  const url = payload.url.trim();
  if (!url) return { success: false, error: "URL_REQUIRED" };

  const type = payload.type || inferMediaType(url);
  const category: MediaCategory =
    type === "video" ? "video" : isGifUrl(url) ? "gif" : "image";
  return commitMediaMutation(db, itemId, (current) => {
    const existingMedia = current.media || [];
    const hasCapacity = canAddMedia(
      existingMedia.map((entry) => ({
        type: entry.type,
        originalUrl: entry.originalUrl,
      })),
      category,
    );
    if (!hasCapacity) {
      return {
        kind: "reject",
        error: `Limit reached for ${category}s (max ${MEDIA_LIMITS[category]})`,
      };
    }

    const entry: ItemMediaEntry = {
      type,
      originalUrl: url,
      storageType: "hotlink",
    };
    if (payload.altText) entry.altText = payload.altText;
    return {
      kind: "apply",
      plan: {
        patch: mediaPatch(current, [...existingMedia, entry]),
        removedOpfsPaths: [],
      },
    };
  });
}

export async function replaceItemMedia(
  db: MyDatabase,
  payload: ReplaceItemMediaPayload,
): Promise<ItemMediaMutationResult> {
  const itemId = payload.id.trim();
  if (!itemId) return { success: false, error: "NOT_FOUND" };
  if (!Number.isInteger(payload.index) || payload.index < 0) {
    return { success: false, error: "INVALID_INDEX" };
  }
  const url = payload.url.trim();
  if (!url) return { success: false, error: "URL_REQUIRED" };
  const type = payload.type || inferMediaType(url);

  return commitMediaMutation(db, itemId, (current) => {
    const media = current.media || [];
    if (payload.index >= media.length) {
      return { kind: "reject", error: "INVALID_INDEX" };
    }
    const previous = media[payload.index];
    const replacement: ItemMediaEntry = {
      type,
      originalUrl: url,
      storageType: "hotlink",
    };
    if (previous.altText) replacement.altText = previous.altText;
    const nextMedia = media.map((entry, index) =>
      index === payload.index ? replacement : entry,
    );
    return {
      kind: "apply",
      plan: {
        patch: mediaPatch(current, nextMedia),
        removedOpfsPaths: removedPaths(current.media, nextMedia),
      },
    };
  });
}
