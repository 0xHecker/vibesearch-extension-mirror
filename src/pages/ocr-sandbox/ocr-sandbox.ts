import { PaddleOCR } from "@paddleocr/paddleocr-js";
import type { OcrResult } from "@paddleocr/paddleocr-js";
import {
  DET_MODEL_NAME,
  REC_MODEL_NAME,
  getOcrModelUrl,
} from "@src/services/ocr-model-config";

type ModelFetchPayload = {
  status: number;
  statusText: string;
  contentType: string;
  buffer: ArrayBuffer;
};

type ParentMessage =
  | {
      target: "vibe-search-ocr-parent";
      type: "runOcr";
      id: string;
      payload?: {
        imageBuffer?: ArrayBuffer;
        imageType?: string;
        imageWidth?: number;
        imageHeight?: number;
        params?: Record<string, unknown>;
      };
    }
  | {
      target: "vibe-search-ocr-parent";
      type: "modelFetchResponse";
      id: string;
      payload?: ModelFetchPayload;
      error?: string;
    };

type SandboxMessage =
  | { target: "vibe-search-ocr-sandbox"; type: "ready" }
  | { target: "vibe-search-ocr-sandbox"; type: "response"; id: string; payload?: unknown; error?: string }
  | { target: "vibe-search-ocr-sandbox"; type: "modelFetch"; id: string; url: string };

type OcrRunner = {
  predict(input: unknown, params?: Record<string, unknown>): Promise<OcrResult[]>;
};

let runnerPromise: Promise<OcrRunner> | null = null;
const pendingModelFetches = new Map<
  string,
  { resolve: (payload: ModelFetchPayload) => void; reject: (error: Error) => void; timeout: number }
>();

const createId = (): string => `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;

// The OCR sandbox is a manifest sandbox page, so it runs in an opaque origin
// ("null"). It cannot target the parent's chrome-extension:// origin, and the
// parent cannot target this opaque origin either — so both sides post with "*"
// and authenticate via event.source. Targeting a concrete origin silently drops
// every message, which surfaced as a 30s "OCR sandbox did not initialize."
const postToParent = (message: SandboxMessage, transfer: Transferable[] = []) => {
  window.parent.postMessage(message, "*", transfer);
};

const fetchModelThroughParent = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
  const request = new Request(input, init);
  if (request.method !== "GET") return fetch(request);

  const id = createId();
  const payload = await new Promise<ModelFetchPayload>((resolve, reject) => {
    const timeout = window.setTimeout(() => {
      pendingModelFetches.delete(id);
      reject(new Error("OCR model fetch timed out."));
    }, 120_000);
    pendingModelFetches.set(id, {
      resolve: (payload) => {
        window.clearTimeout(timeout);
        resolve(payload);
      },
      reject: (error) => {
        window.clearTimeout(timeout);
        reject(error);
      },
      timeout,
    });
    postToParent({
      target: "vibe-search-ocr-sandbox",
      type: "modelFetch",
      id,
      url: request.url,
    });
  });

  return new Response(payload.buffer, {
    status: payload.status,
    statusText: payload.statusText,
    headers: {
      "content-type": payload.contentType,
    },
  });
};

const getRunner = async (): Promise<OcrRunner> => {
  if (!runnerPromise) {
    runnerPromise = (PaddleOCR.create({
      initialize: true,
      textDetectionModelName: DET_MODEL_NAME,
      textDetectionModelAsset: { url: getOcrModelUrl("det") },
      textRecognitionModelName: REC_MODEL_NAME,
      textRecognitionModelAsset: { url: getOcrModelUrl("rec") },
      textDetectionBatchSize: 1,
      textRecognitionBatchSize: 8,
      fetch: fetchModelThroughParent,
      ortOptions: {
        backend: "wasm",
        numThreads: 1,
        simd: true,
        proxy: false,
        disableWasmProxy: true,
      },
    }) as Promise<OcrRunner>).catch((error) => {
      runnerPromise = null;
      throw error``;
    });
  }
  return runnerPromise;
};

const runOcr = async (payload: Extract<ParentMessage, { type: "runOcr" }>["payload"]) => {
  if (!payload?.imageBuffer) {
    throw new Error("OCR image payload missing.");
  }

  const runner = await getRunner();
  const image = new Blob([payload.imageBuffer], { type: payload.imageType || "image/png" });
  const [result] = await runner.predict(image, payload.params || {});
  return {
    image: result?.image || {
      width: payload.imageWidth || 0,
      height: payload.imageHeight || 0,
    },
    items: result?.items || [],
  };
};

window.addEventListener("message", (event: MessageEvent<ParentMessage>) => {
  if (event.source !== window.parent) return;
  const message = event.data;
  if (!message || message.target !== "vibe-search-ocr-parent") return;

  if (message.type === "modelFetchResponse") {
    const pending = pendingModelFetches.get(message.id);
    if (!pending) return;
    pendingModelFetches.delete(message.id);
    window.clearTimeout(pending.timeout);
    if (message.error || !message.payload) {
      pending.reject(new Error(message.error || "Model fetch failed."));
    } else {
      pending.resolve(message.payload);
    }
    return;
  }

  if (message.type === "runOcr") {
    void runOcr(message.payload)
      .then((payload) =>
        postToParent({
          target: "vibe-search-ocr-sandbox",
          type: "response",
          id: message.id,
          payload,
        })
      )
      .catch((error) =>
        postToParent({
          target: "vibe-search-ocr-sandbox",
          type: "response",
          id: message.id,
          error: error instanceof Error ? error.message : String(error),
        })
      );
  }
});

postToParent({ target: "vibe-search-ocr-sandbox", type: "ready" });
