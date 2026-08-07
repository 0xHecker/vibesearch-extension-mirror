import type { ItemDocType } from "@src/schemas/item_schema";
import { OCR_MODEL_VERSION } from "@src/services/ocr-model-config";

export { OCR_MODEL_VERSION } from "@src/services/ocr-model-config";

/**
 * Firefox MV3 does not yet support manifest sandbox pages, which the bundled
 * PaddleOCR/OpenCV runtime needs for its unsafe-eval boundary. Keep OCR out of
 * the Gecko package instead of shipping code Firefox blocks or AMO rejects.
 */
export const OCR_SUPPORTED = false;

const unavailable = (): Error =>
  new Error(
    "Local image OCR is not available in the Firefox build because Firefox MV3 does not support extension sandbox pages."
  );

const stableHash = (input: string): string => {
  let hash = 2166136261;
  for (let index = 0; index < input.length; index += 1) {
    hash ^= input.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36);
};

const getSourceHash = (item: ItemDocType): string => {
  const media = (item.media || []).map((entry) =>
    [
      entry.storageType || "",
      entry.opfsPath || entry.s3Url || entry.originalUrl || "",
      entry.width || "",
      entry.height || "",
      entry.capturedAt || "",
    ].join("|")
  );
  return stableHash(
    [OCR_MODEL_VERSION, item.displayImageUrl || "", ...media].join("\n")
  );
};

export const ocrService = {
  getSourceHash,
  async processItem(_item: ItemDocType): Promise<never> {
    throw unavailable();
  },
  async processImageUrl(_url: string): Promise<never> {
    throw unavailable();
  },
  scheduleIdleRelease(): void {},
  releaseResources(): void {},
};
