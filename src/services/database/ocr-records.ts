import type { ItemDocType, MediaOcrMetadata } from "@src/schemas/item_schema";
import { getDb } from "@src/services/DatabaseService";
import {
  appendOcrTextToTextContent,
  normalizeOcrText,
} from "@src/services/ocr-text";
import { z } from "zod";

type MediaEntry = NonNullable<ItemDocType["media"]>[number];

export type SavedMediaOcrResult = {
  url: string;
  source?: "display" | "s3" | "original" | "opfs";
  status?: MediaOcrMetadata["status"];
  text?: string;
  confidence?: number | null;
  lineCount?: number;
  sourceHash?: string;
  error?: string;
};

export type SaveItemOcrResultPayload = {
  id: string;
  status: ItemDocType["ocrStatus"];
  modelVersion: string;
  sourceHash: string;
  text?: string;
  confidence?: number | null;
  lineCount?: number;
  error?: string;
  media?: SavedMediaOcrResult[];
};

const writeConflictSchema = z.union([
  z.object({ status: z.literal(409) }).passthrough(),
  z.object({ rxdb: z.object({ status: z.literal(409) }).passthrough() }).passthrough(),
  z.object({
    parameters: z.object({
      writeError: z.object({ status: z.literal(409) }).passthrough(),
    }).passthrough(),
  }).passthrough(),
]);

function isWriteConflict(cause: unknown): boolean {
  return writeConflictSchema.safeParse(cause).success;
}

function errorFromCause(cause: unknown): Error {
  return cause instanceof Error ? cause : new Error("OCR_WRITE_CONFLICT");
}

function itemHasOcrImage(item: ItemDocType): boolean {
  if (item.displayImageUrl?.trim()) return true;
  return (item.media || []).some((entry) =>
    entry.type === "image" && Boolean(entry.s3Url || entry.originalUrl || entry.opfsPath));
}

function normalizeOcrConfidence(value: number | null | undefined): number | null {
  if (!Number.isFinite(value)) return null;
  return Math.max(0, Math.min(1, value ?? 0));
}

function normalizeOcrLineCount(value: number | undefined): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.floor(value ?? 0));
}

function normalizeComparableUrl(value: string | undefined): string {
  const trimmed = value?.trim() ?? "";
  if (!trimmed) return "";
  try {
    return new URL(trimmed).toString();
  } catch {
    return trimmed;
  }
}

function mediaOcrResultMatchesEntry(
  entry: MediaEntry,
  result: SavedMediaOcrResult,
): boolean {
  const target = normalizeComparableUrl(result.url);
  if (!target) return false;
  if (result.source === "s3") return normalizeComparableUrl(entry.s3Url) === target;
  if (result.source === "original") return normalizeComparableUrl(entry.originalUrl) === target;
  if (result.source === "opfs") return normalizeComparableUrl(entry.opfsPath) === target;
  return [entry.s3Url, entry.originalUrl, entry.opfsPath]
    .map(normalizeComparableUrl)
    .some((url) => Boolean(url) && url === target);
}

function buildMediaOcrMetadata(
  result: SavedMediaOcrResult,
  payload: SaveItemOcrResultPayload,
  now: number,
): MediaOcrMetadata {
  const text = normalizeOcrText(result.text ?? payload.text);
  const error = (result.error || payload.error || "").slice(0, 500);
  const ocr: MediaOcrMetadata = {
    status: result.status || payload.status,
    confidence: normalizeOcrConfidence(result.confidence ?? payload.confidence),
    lineCount: normalizeOcrLineCount(result.lineCount ?? payload.lineCount),
    modelVersion: payload.modelVersion,
    sourceHash: result.sourceHash || payload.sourceHash,
    extractedAt: now,
    engine: "paddleocr",
  };
  if (text) ocr.text = text;
  if (error) ocr.error = error;
  return ocr;
}

function applyMediaOcrResults(
  media: ItemDocType["media"],
  payload: SaveItemOcrResultPayload,
  now: number,
): ItemDocType["media"] {
  if (!media?.length) return media;
  const imageCount = media.filter((entry) => entry.type === "image").length;
  if (imageCount === 0) return media;
  const results = (payload.media || []).filter((result) => result.url.trim());
  let fallbackResult: SavedMediaOcrResult | null = null;
  if (results.length === 0 && imageCount === 1) {
    fallbackResult = {
      url: "",
      source: "display",
      status: payload.status,
      text: payload.text,
      confidence: payload.confidence,
      lineCount: payload.lineCount,
      sourceHash: payload.sourceHash,
      error: payload.error,
    };
  }
  const usedResults = new Set<number>();
  return media.map((entry) => {
    if (entry.type !== "image") return entry;
    let resultIndex = results.findIndex((result, index) =>
      !usedResults.has(index) && mediaOcrResultMatchesEntry(entry, result));
    if (resultIndex < 0 && imageCount === 1 && results.length === 1) resultIndex = 0;
    const result = resultIndex >= 0 ? results[resultIndex] : fallbackResult;
    if (!result) return entry;
    if (resultIndex >= 0) usedResults.add(resultIndex);
    return { ...entry, ocr: buildMediaOcrMetadata(result, payload, now) };
  });
}

function markMediaOcrProcessing(
  media: ItemDocType["media"],
  payload: { modelVersion: string; sourceHash: string },
  now: number,
): ItemDocType["media"] {
  if (!media?.length) return media;
  return media.map((entry) => {
    if (entry.type !== "image") return entry;
    return {
      ...entry,
      ocr: {
        ...entry.ocr,
        status: "processing",
        modelVersion: payload.modelVersion,
        sourceHash: payload.sourceHash,
        extractedAt: now,
        engine: entry.ocr?.engine || "paddleocr",
        error: "",
      },
    };
  });
}

export async function getItemsToOcr(payload: {
  limit: number;
  modelVersion: string;
  retryErroredBefore: number;
}): Promise<ItemDocType[]> {
  const db = await getDb();
  const limit = Math.max(1, Math.min(100, Math.floor(payload.limit || 10)));
  const pendingDocuments = await db.items.find({
    selector: {
      deletedAt: { $eq: 0 },
      ocrStatus: { $in: ["pending", "processing", "error"] },
    },
    limit: limit * 12,
  }).exec();
  const items = pendingDocuments
    .map((document) => document.toMutableJSON())
    .filter((item) => {
      if (item.ocrStatus === "pending" || item.ocrStatus === "processing") return true;
      return item.ocrStatus === "error" && (item.ocrUpdatedAt || 0) < payload.retryErroredBefore;
    })
    .filter(itemHasOcrImage);

  if (items.length < limit) {
    const selectedIds = new Set(items.map((item) => item.id));
    const staleDocuments = await db.items.find({
      selector: { deletedAt: { $eq: 0 } },
      limit: limit * 12,
    }).exec();
    for (const document of staleDocuments) {
      if (items.length >= limit) break;
      const item = document.toMutableJSON();
      if (selectedIds.has(item.id) || item.ocrStatus !== "done") continue;
      if (item.ocrModelVersion !== payload.modelVersion && itemHasOcrImage(item)) {
        selectedIds.add(item.id);
        items.push(item);
      }
    }
  }
  return items.slice(0, limit);
}

export async function markItemOcrProcessing(payload: {
  id: string;
  modelVersion: string;
  sourceHash: string;
}): Promise<void> {
  const db = await getDb();
  let lastError = new Error("OCR_WRITE_CONFLICT");
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const document = await db.items.findOne(payload.id).exec();
    if (!document) return;
    const current = document.toMutableJSON();
    const now = Date.now();
    const patch: Partial<ItemDocType> = {
      ocrStatus: "processing",
      ocrError: "",
      ocrModelVersion: payload.modelVersion,
      ocrSourceHash: payload.sourceHash,
      ocrUpdatedAt: now,
    };
    const media = markMediaOcrProcessing(current.media, payload, now);
    if (media) patch.media = media;
    try {
      await document.patch(patch);
      return;
    } catch (cause) {
      if (!isWriteConflict(cause)) throw cause;
      lastError = errorFromCause(cause);
    }
  }
  throw lastError;
}

export async function saveItemOcrResult(
  payload: SaveItemOcrResultPayload,
): Promise<void> {
  const db = await getDb();
  let lastError = new Error("OCR_WRITE_CONFLICT");
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const document = await db.items.findOne(payload.id).exec();
    if (!document) return;
    const current = document.toMutableJSON();
    const now = Date.now();
    const nextText = normalizeOcrText(payload.text);
    const currentText = normalizeOcrText(current.ocrText);
    const textChanged = payload.status === "done" && nextText !== currentText;
    const nextTextContent = payload.status === "done"
      ? appendOcrTextToTextContent(current.textContent, nextText)
      : current.textContent;
    const textContentChanged = nextTextContent !== (current.textContent || "").trim();
    const patch: Partial<ItemDocType> = {
      ocrStatus: payload.status,
      ocrError: payload.error ? payload.error.slice(0, 500) : "",
      ocrModelVersion: payload.modelVersion,
      ocrSourceHash: payload.sourceHash,
      ocrUpdatedAt: now,
      ocrConfidence: normalizeOcrConfidence(payload.confidence),
      ocrLineCount: normalizeOcrLineCount(payload.lineCount),
    };
    const media = applyMediaOcrResults(current.media, payload, now);
    if (media) patch.media = media;
    if (payload.status === "done") {
      patch.ocrText = nextText;
      patch.textContent = nextTextContent;
    }
    if (textChanged || textContentChanged) {
      patch.isDirty = true;
      patch.isEmbedded = false;
      patch.updatedAt = now;
    }
    try {
      await document.patch(patch);
      return;
    } catch (cause) {
      if (!isWriteConflict(cause)) throw cause;
      lastError = errorFromCause(cause);
    }
  }
  throw lastError;
}
