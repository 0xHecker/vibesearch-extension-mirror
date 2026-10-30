export const OCR_MODEL_VERSION = "pp-ocrv6-small-hf-2026-06-12";

export const METADATA_WORKER_BASE_URL = "https://metadata-worker.shanmukh6789op.workers.dev";
export const OCR_MODEL_BASE_URL = `${METADATA_WORKER_BASE_URL}/ocr-model`;
// The retired custom domain (meta.vibesearch.app) no longer resolves. Models are
// served from the metadata worker's stable workers.dev origin, so the "fallback"
// host points there too — a transient primary failure now retries the live
// origin instead of a dead domain.
export const LEGACY_METADATA_WORKER_BASE_URL = METADATA_WORKER_BASE_URL;
export const LEGACY_OCR_MODEL_BASE_URL = `${LEGACY_METADATA_WORKER_BASE_URL}/ocr-model`;
export const OCR_IMAGE_PROXY_URL = `${METADATA_WORKER_BASE_URL}/ocr-image`;
export const OCR_MODEL_CACHE = "vibe-search-ocr-models-v1";

export type OcrModelRole = "det" | "rec";

const OCR_MODEL_ASSETS: Record<
  OcrModelRole,
  {
    modelName: string;
    publicId: string;
  }
> = {
  det: {
    modelName: "PP-OCRv6_small_det",
    publicId: "a3f6c9d1",
  },
  rec: {
    modelName: "PP-OCRv6_small_rec",
    publicId: "d8b2e7a4",
  },
};

export const DET_MODEL_NAME = OCR_MODEL_ASSETS.det.modelName;
export const REC_MODEL_NAME = OCR_MODEL_ASSETS.rec.modelName;

export const getOcrModelUrl = (model: OcrModelRole): string =>
  `${OCR_MODEL_BASE_URL}/${OCR_MODEL_ASSETS[model].publicId}`;

export const getLegacyOcrModelUrl = (model: OcrModelRole): string =>
  `${LEGACY_OCR_MODEL_BASE_URL}/${OCR_MODEL_ASSETS[model].publicId}`;

export const resolveOcrModelRoleFromUrl = (value: string): OcrModelRole | null => {
  try {
    const url = new URL(value);
    const fileName = decodeURIComponent(url.pathname.split("/").pop() || "");
    const found = Object.entries(OCR_MODEL_ASSETS).find(
      ([, asset]) => fileName === asset.publicId
    );
    return found ? (found[0] as OcrModelRole) : null;
  } catch {
    return null;
  }
};
