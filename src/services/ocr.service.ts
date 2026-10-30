import { requireLegacyBrowser } from "@src/services/extension-policy";
import type { OcrResultItem } from "@paddleocr/paddleocr-js";
import type { ItemDocType } from "@src/schemas/item_schema";
import { readOpfsFile } from "@src/services/media-storage";
import {
  METADATA_WORKER_BASE_URL,
  OCR_IMAGE_PROXY_URL,
  OCR_MODEL_BASE_URL,
  OCR_MODEL_CACHE,
  OCR_MODEL_VERSION,
  getLegacyOcrModelUrl,
  getOcrModelUrl,
  resolveOcrModelRoleFromUrl,
} from "@src/services/ocr-model-config";

export { OCR_MODEL_VERSION } from "@src/services/ocr-model-config";
export const OCR_SUPPORTED = true;
const MAX_IMAGE_BYTES = 12 * 1024 * 1024;
const MAX_IMAGE_LONG_SIDE = 1600;
const MIN_IMAGE_SIDE = 24;
const MAX_IMAGES_PER_ITEM = 3;
const MIN_LINE_SCORE = 0.45;
const MAX_OCR_TEXT_CHARS = 12000;
const ENABLE_DEV_OCR_CACHE_CLEANUP = import.meta.env.DEV;

type ImageCandidate = {
  url: string;
  source: "display" | "s3" | "original" | "opfs";
  width?: number;
  height?: number;
  capturedAt?: number;
};

export type ItemOcrMediaResult = {
  url: string;
  source: ImageCandidate["source"];
  status: "done" | "skipped" | "error";
  text: string;
  confidence?: number;
  lineCount: number;
  sourceHash: string;
  width?: number;
  height?: number;
  error?: string;
};

type ImageOcrResult = {
  lines: Array<{ text: string; score: number }>;
  width: number;
  height: number;
};

type SandboxOcrPayload = {
  image: { width?: number; height?: number };
  items: OcrResultItem[];
};

type SandboxMessage =
  | { target: "vibe-search-ocr-sandbox"; type: "ready" }
  | { target: "vibe-search-ocr-sandbox"; type: "response"; id: string; payload?: unknown; error?: string }
  | { target: "vibe-search-ocr-sandbox"; type: "modelFetch"; id: string; url: string };

type ParentMessage = {
  target: "vibe-search-ocr-parent";
  type: "runOcr" | "modelFetchResponse";
  id: string;
  payload?: unknown;
  error?: string;
};

export type ItemOcrResult = {
  status: "done" | "skipped" | "error";
  text: string;
  confidence?: number;
  lineCount: number;
  sourceHash: string;
  error?: string;
  media?: ItemOcrMediaResult[];
};

const normalizeWhitespace = (input: string): string =>
  input
    .replace(/\u00a0/g, " ")
    .replace(/[ \t]+/g, " ")
    .replace(/\s+\n/g, "\n")
    .replace(/\n\s+/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

const isHttpUrl = (value: string): boolean => {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
};

const isLikelyDirectFetchable = (value: string): boolean => {
  try {
    const hostname = new URL(value).hostname.toLowerCase();
    return (
      hostname === "metadata-worker.watermelons.workers.dev" ||
      hostname === "metadata-worker.shanmukh6789op.workers.dev" ||
      hostname === "bucket.vibesearch.app" ||
      hostname === "preview-bucket.vibesearch.app"
    );
  } catch {
    return false;
  }
};

const getWorkerR2Url = (value: string): string | null => {
  try {
    const url = new URL(value);
    const hostname = url.hostname.toLowerCase();
    if (hostname === "bucket.vibesearch.app" || hostname === "preview-bucket.vibesearch.app") {
      const key = decodeURIComponent(url.pathname.replace(/^\/+/, ""));
      if (key) return `${METADATA_WORKER_BASE_URL}/r2/${encodeURIComponent(key)}`;
    }
  } catch {}
  return null;
};

const blobFromCanvas = (canvas: HTMLCanvasElement, type: string): Promise<Blob> =>
  new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) => {
        if (blob) resolve(blob);
        else reject(new Error("Failed to encode resized OCR image."));
      },
      type || "image/png",
      0.92
    );
  });

const cleanupDevModelCaches: ((cache: Cache) => Promise<void>) | null = ENABLE_DEV_OCR_CACHE_CLEANUP
  ? (() => {
      let cleanupPromise: Promise<void> | null = null;
      return async (cache: Cache): Promise<void> => {
        if (!cleanupPromise) {
          cleanupPromise = (async () => {
            const normalize = (value: string) => value.toLowerCase().replace(/[^a-z0-9]+/g, "");
            const currentCacheName = normalize(OCR_MODEL_CACHE);
            const isOwnedStaleCache = (cacheName: string) => {
              const normalizedName = normalize(cacheName);
              return (
                normalizedName !== currentCacheName &&
                normalizedName.includes("vibesearch") &&
                normalizedName.includes("ocr")
              );
            };
            const isStaleModelRequest = (request: Request) => {
              try {
                if (resolveOcrModelRoleFromUrl(request.url)) return false;
                const url = new URL(request.url);
                return (
                  url.pathname.includes("ocr-model") &&
                  (url.hostname.endsWith("vibesearch.app") ||
                    url.hostname.endsWith("workers.dev") ||
                    url.hostname === location.hostname)
                );
              } catch {
                return false;
              }
            };

            const cacheNames = await caches.keys();
            await Promise.all(
              cacheNames
                .filter(isOwnedStaleCache)
                .map((cacheName) => caches.delete(cacheName).catch(() => false))
            );
            const requests = await cache.keys();
            await Promise.all(
              requests.filter(isStaleModelRequest).map((request) => cache.delete(request).catch(() => false))
            );
          })()
            .catch((error) => {
              console.warn("[OCR] Failed to clean dev OCR model caches.", error);
            })
            .then(() => undefined);
        }
        await cleanupPromise;
      };
    })()
  : null;

export class OcrSandboxClient {
  private frame: HTMLIFrameElement | null = null;
  private readyPromise: Promise<void> | null = null;
  private resolveReady: (() => void) | null = null;
  private rejectReady: ((error: Error) => void) | null = null;
  private readyTimeout: number | null = null;
  private readonly pending = new Map<
    string,
    { resolve: (value: unknown) => void; reject: (error: Error) => void }
  >();

  constructor(private readonly fetchModel: (url: string) => Promise<Response>) {
    window.addEventListener("message", this.handleMessage);
  }

  private createId(): string {
    return `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  }

  private async ensureReady(): Promise<void> {
    if (this.readyPromise) return this.readyPromise;

    this.readyPromise = new Promise((resolve, reject) => {
      this.resolveReady = resolve;
      this.rejectReady = reject;
      this.readyTimeout = window.setTimeout(() => {
        this.readyTimeout = null;
        reject(new Error("OCR sandbox did not initialize."));
      }, 30_000);
      this.resolveReady = () => {
        if (this.readyTimeout !== null) {
          window.clearTimeout(this.readyTimeout);
          this.readyTimeout = null;
        }
        this.rejectReady = null;
        resolve();
      };
    });

    const frame = document.createElement("iframe");
    frame.src = chrome.runtime.getURL("src/pages/ocr-sandbox/index.html");
    frame.style.display = "none";
    frame.setAttribute("aria-hidden", "true");
    this.frame = frame;
    document.body.appendChild(frame);
    return this.readyPromise;
  }

  private postToSandbox(message: ParentMessage, transfer: Transferable[] = []) {
    const target = this.frame?.contentWindow;
    if (!target) {
      throw new Error("OCR sandbox is not available.");
    }
    // The sandbox page has an opaque origin (manifest sandbox page), so its
    // origin cannot be matched. Post with "*" and trust event.source on the way
    // back. Targeting a concrete origin silently drops every message, so the
    // sandbox never receives runOcr and init times out after 30s.
    target.postMessage(message, "*", transfer);
  }

  private readonly handleMessage = (event: MessageEvent<SandboxMessage>) => {
    if (this.frame?.contentWindow && event.source !== this.frame.contentWindow) return;
    const message = event.data;
    if (!message || message.target !== "vibe-search-ocr-sandbox") return;

    if (message.type === "ready") {
      this.resolveReady?.();
      this.resolveReady = null;
      return;
    }

    if (message.type === "modelFetch") {
      void this.handleModelFetch(message);
      return;
    }

    if (message.type === "response") {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      if (message.error) {
        pending.reject(new Error(message.error));
      } else {
        pending.resolve(message.payload);
      }
    }
  };

  private async handleModelFetch(message: Extract<SandboxMessage, { type: "modelFetch" }>) {
    try {
      const response = await this.fetchModel(message.url);
      if (!response.ok) {
        throw new Error(`Model fetch failed: HTTP ${response.status}`);
      }
      const buffer = await response.arrayBuffer();
      this.postToSandbox(
        {
          target: "vibe-search-ocr-parent",
          type: "modelFetchResponse",
          id: message.id,
          payload: {
            status: response.status,
            statusText: response.statusText,
            contentType: response.headers.get("content-type") || "application/octet-stream",
            buffer,
          },
        },
        [buffer]
      );
    } catch (error) {
      if (!this.frame) return;
      this.postToSandbox({
        target: "vibe-search-ocr-parent",
        type: "modelFetchResponse",
        id: message.id,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private async request<T>(type: ParentMessage["type"], payload: unknown, transfer: Transferable[] = []): Promise<T> {
    await this.ensureReady();
    const id = this.createId();
    return new Promise<T>((resolve, reject) => {
      const timeout = window.setTimeout(() => {
        this.pending.delete(id);
        reject(new Error("OCR sandbox request timed out."));
      }, 180_000);
      this.pending.set(id, {
        resolve: (value) => {
          window.clearTimeout(timeout);
          resolve(value as T);
        },
        reject: (error) => {
          window.clearTimeout(timeout);
          reject(error);
        },
      });
      try {
        this.postToSandbox(
          {
            target: "vibe-search-ocr-parent",
            type,
            id,
            payload,
          },
          transfer
        );
      } catch (error) {
        window.clearTimeout(timeout);
        this.pending.delete(id);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  public async runOcr(
    blob: Blob,
    image: { width: number; height: number },
    params: Record<string, unknown>
  ): Promise<SandboxOcrPayload> {
    const buffer = await blob.arrayBuffer();
    return this.request<SandboxOcrPayload>(
      "runOcr",
      {
        imageBuffer: buffer,
        imageType: blob.type || "image/png",
        imageWidth: image.width,
        imageHeight: image.height,
        params,
      },
      [buffer]
    );
  }

  public async prepare(): Promise<void> {
    await requireLegacyBrowser();
    await this.ensureReady();
  }

  public dispose(reason = "OCR sandbox released to free memory."): void {
    window.removeEventListener("message", this.handleMessage);
    if (this.readyTimeout !== null) {
      window.clearTimeout(this.readyTimeout);
      this.readyTimeout = null;
    }
    const error = new Error(reason);
    this.rejectReady?.(error);
    this.resolveReady = null;
    this.rejectReady = null;
    this.readyPromise = null;
    for (const [id, pending] of this.pending) {
      this.pending.delete(id);
      pending.reject(error);
    }
    this.frame?.remove();
    this.frame = null;
  }
}

export class OcrService {
  private sandbox: OcrSandboxClient | null = null;
  private idleReleaseTimer: number | null = null;
  private activeOperations = 0;
  private idleReleaseRequested = false;
  private consecutiveInitFailures = 0;
  private initCircuitOpenUntil = 0;
  private readonly INIT_CIRCUIT_OPEN_MS = 60_000;
  private readonly IDLE_RELEASE_MS = 60_000;

  private cancelIdleRelease(): void {
    if (this.idleReleaseTimer === null) return;
    window.clearTimeout(this.idleReleaseTimer);
    this.idleReleaseTimer = null;
  }

  private async withActiveOperation<T>(operation: () => Promise<T>): Promise<T> {
    this.cancelIdleRelease();
    this.activeOperations += 1;
    try {
      return await operation();
    } finally {
      this.activeOperations = Math.max(0, this.activeOperations - 1);
      if (this.activeOperations === 0 && this.idleReleaseRequested) {
        this.armIdleRelease();
      }
    }
  }

  private armIdleRelease(): void {
    if (!this.sandbox || this.activeOperations > 0) return;
    this.cancelIdleRelease();
    this.idleReleaseTimer = window.setTimeout(() => {
      this.idleReleaseTimer = null;
      if (this.activeOperations > 0) return;
      this.idleReleaseRequested = false;
      const sandbox = this.sandbox;
      this.sandbox = null;
      sandbox?.dispose();
    }, this.IDLE_RELEASE_MS);
  }

  private async fetchWithModelCache(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
    const request = new Request(input, init);
    const modelRole = resolveOcrModelRoleFromUrl(request.url);
    if (request.method !== "GET" || !modelRole || !request.url.startsWith(OCR_MODEL_BASE_URL)) {
      return fetch(request);
    }

    if (typeof caches === "undefined") {
      return fetch(request);
    }

    const cache = await caches.open(OCR_MODEL_CACHE);
    if (cleanupDevModelCaches) {
      await cleanupDevModelCaches(cache);
    }
    const cacheKey = getOcrModelUrl(modelRole);
    const cached = await cache.match(cacheKey);
    if (cached) {
      return cached;
    }

    const response = await this.fetchModelWithFallback(request, modelRole);
    if (response.ok) {
      return this.storeModelResponse(cache, cacheKey, response, modelRole);
    }
    return response;
  }

  private async storeModelResponse(
    cache: Cache,
    cacheKey: string,
    response: Response,
    modelRole: "det" | "rec"
  ): Promise<Response> {
    const buffer = await response.arrayBuffer();
    const headers = new Headers(response.headers);
    if (!headers.has("content-type")) {
      headers.set("content-type", "application/x-tar");
    }
    const init: ResponseInit = {
      status: response.status,
      statusText: response.statusText,
      headers,
    };

    try {
      await cache.put(cacheKey, new Response(buffer.slice(0), init));
    } catch (error) {
      throw new Error(
        `OCR ${modelRole} model downloaded but could not be saved to Cache Storage: ${
          error instanceof Error ? error.message : String(error)
        }`
      );
    }

    return new Response(buffer, init);
  }

  private async fetchModelWithFallback(request: Request, modelRole: "det" | "rec"): Promise<Response> {
    try {
      const response = await fetch(request);
      if (response.ok || !request.url.startsWith(OCR_MODEL_BASE_URL)) {
        return response;
      }
    } catch (error) {
      if (!request.url.startsWith(OCR_MODEL_BASE_URL)) throw error;
    }

    return fetch(getLegacyOcrModelUrl(modelRole), { credentials: "omit" });
  }

  private async prefetchModelAssets(): Promise<void> {
    for (const modelRole of ["det", "rec"] as const) {
      const response = await this.fetchWithModelCache(getOcrModelUrl(modelRole));
      if (!response.ok) {
        throw new Error(`OCR ${modelRole} model warmup failed: HTTP ${response.status}`);
      }
    }

    if (typeof caches !== "undefined") {
      const cache = await caches.open(OCR_MODEL_CACHE);
      for (const modelRole of ["det", "rec"] as const) {
        const cached = await cache.match(getOcrModelUrl(modelRole));
        if (!cached) {
          throw new Error(`OCR ${modelRole} model warmup finished but cache entry is missing.`);
        }
      }
    }
  }

  /**
   * Ensure both OCR model files are present in Cache Storage, downloading any
   * that are missing. Cheap to call repeatedly (a cache hit is a no-op) and
   * independent of the sandbox, so wiping Cache Storage and re-triggering OCR
   * re-downloads the models without an extension reload.
   */
  public async ensureModelsCached(): Promise<void> {
    await requireLegacyBrowser();
    if (typeof caches === "undefined") return;
    await this.prefetchModelAssets();
  }

  private async initialize(): Promise<OcrSandboxClient> {
    this.cancelIdleRelease();
    if (this.sandbox) return this.sandbox;
    if (Date.now() < this.initCircuitOpenUntil) {
      const seconds = Math.ceil((this.initCircuitOpenUntil - Date.now()) / 1000);
      throw new Error(`OCR model temporarily unavailable. Retry in ${seconds}s.`);
    }
    let sandbox: OcrSandboxClient | null = null;
    try {
      sandbox = new OcrSandboxClient(this.fetchWithModelCache.bind(this));
      this.sandbox = sandbox;
      await sandbox.prepare();
      await this.prefetchModelAssets();
      this.consecutiveInitFailures = 0;
      this.initCircuitOpenUntil = 0;
      return sandbox;
    } catch (error) {
      if (this.sandbox === sandbox) this.sandbox = null;
      sandbox?.dispose("OCR sandbox initialization failed.");
      this.consecutiveInitFailures += 1;
      if (this.consecutiveInitFailures >= 2) {
        this.initCircuitOpenUntil = Date.now() + this.INIT_CIRCUIT_OPEN_MS;
      }
      throw error;
    }
  }

  public scheduleIdleRelease(): void {
    if (!this.sandbox) return;
    this.idleReleaseRequested = true;
    this.armIdleRelease();
  }

  public releaseResources(): void {
    this.cancelIdleRelease();
    this.idleReleaseRequested = false;
    const sandbox = this.sandbox;
    this.sandbox = null;
    sandbox?.dispose();
  }

  private stableHash(input: string): string {
    let hash = 2166136261;
    for (let i = 0; i < input.length; i += 1) {
      hash ^= input.charCodeAt(i);
      hash = Math.imul(hash, 16777619);
    }
    return (hash >>> 0).toString(36);
  }

  public getImageCandidates(item: ItemDocType): ImageCandidate[] {
    const byUrl = new Map<string, ImageCandidate>();
    const add = (candidate: ImageCandidate | null) => {
      if (!candidate?.url) return;
      if (candidate.source !== "opfs" && !isHttpUrl(candidate.url)) return;
      if (!byUrl.has(candidate.url)) byUrl.set(candidate.url, candidate);
    };

    const imageMedia = (item.media || []).filter((entry) => entry?.type === "image");
    const storedMedia = imageMedia.filter(
      (entry) => entry.storageType === "opfs" || entry.storageType === "s3"
    );
    const fetchedMedia = imageMedia.filter(
      (entry) => entry.storageType !== "opfs" && entry.storageType !== "s3"
    );

    for (const entry of [...storedMedia, ...fetchedMedia]) {
      if (entry?.type !== "image") continue;
      const meta = {
        width: entry.width,
        height: entry.height,
        capturedAt: entry.capturedAt,
      };
      if (entry.opfsPath) add({ url: entry.opfsPath, source: "opfs", ...meta });
      else if (entry.s3Url) add({ url: entry.s3Url, source: "s3", ...meta });
      else if (entry.originalUrl) add({ url: entry.originalUrl, source: "original", ...meta });
    }
    add(item.displayImageUrl ? { url: item.displayImageUrl, source: "display" } : null);

    return Array.from(byUrl.values()).slice(0, MAX_IMAGES_PER_ITEM);
  }

  public getSourceHash(item: ItemDocType): string {
    const parts = this.getImageCandidates(item).map((candidate) =>
      [
        candidate.source,
        candidate.url,
        candidate.width || "",
        candidate.height || "",
        candidate.capturedAt || "",
      ].join("|")
    );
    return this.stableHash([OCR_MODEL_VERSION, ...parts].join("\n"));
  }

  private getSourceHashForCandidates(candidates: ImageCandidate[]): string {
    const parts = candidates.map((candidate) =>
      [
        candidate.source,
        candidate.url,
        candidate.width || "",
        candidate.height || "",
        candidate.capturedAt || "",
      ].join("|")
    );
    return this.stableHash([OCR_MODEL_VERSION, ...parts].join("\n"));
  }

  private async fetchImageBlob(candidate: ImageCandidate): Promise<Blob> {
    if (candidate.source === "opfs") {
      const file = await readOpfsFile(candidate.url);
      if (!file) throw new Error("OPFS_IMAGE_NOT_FOUND");
      if (file.size > MAX_IMAGE_BYTES) throw new Error("IMAGE_TOO_LARGE");
      if (file.type === "image/svg+xml") throw new Error("UNSUPPORTED_IMAGE_TYPE");
      return file;
    }

    const fetchDirect = async () => {
      const response = await fetch(candidate.url, { credentials: "omit" });
      return this.responseToImageBlob(response);
    };

    if (isLikelyDirectFetchable(candidate.url)) {
      try {
        return await fetchDirect();
      } catch {}
    }

    const workerR2Url = getWorkerR2Url(candidate.url);
    if (workerR2Url) {
      try {
        const response = await fetch(workerR2Url, { credentials: "omit" });
        return this.responseToImageBlob(response);
      } catch {}
    }

    const proxy = new URL(OCR_IMAGE_PROXY_URL);
    proxy.searchParams.set("url", workerR2Url || candidate.url);
    const response = await fetch(proxy.toString(), { credentials: "omit" });
    return this.responseToImageBlob(response);
  }

  private async responseToImageBlob(response: Response): Promise<Blob> {
    if (!response.ok) {
      throw new Error(`Image fetch failed: HTTP ${response.status}`);
    }

    const contentLength = Number(response.headers.get("content-length") || 0);
    if (Number.isFinite(contentLength) && contentLength > MAX_IMAGE_BYTES) {
      throw new Error("IMAGE_TOO_LARGE");
    }

    const blob = await response.blob();
    if (blob.size > MAX_IMAGE_BYTES) {
      throw new Error("IMAGE_TOO_LARGE");
    }
    if (blob.type === "image/svg+xml") {
      throw new Error("UNSUPPORTED_IMAGE_TYPE");
    }
    return blob;
  }

  private async normalizeImageBlob(blob: Blob): Promise<{ blob: Blob; width: number; height: number }> {
    const bitmap = await createImageBitmap(blob);
    try {
      if (bitmap.width < MIN_IMAGE_SIDE || bitmap.height < MIN_IMAGE_SIDE) {
        throw new Error("IMAGE_TOO_SMALL");
      }

      const longSide = Math.max(bitmap.width, bitmap.height);
      if (longSide <= MAX_IMAGE_LONG_SIDE) {
        return { blob, width: bitmap.width, height: bitmap.height };
      }

      const scale = MAX_IMAGE_LONG_SIDE / longSide;
      const width = Math.max(1, Math.round(bitmap.width * scale));
      const height = Math.max(1, Math.round(bitmap.height * scale));
      const canvas = document.createElement("canvas");
      canvas.width = width;
      canvas.height = height;
      const ctx = canvas.getContext("2d", { alpha: false });
      if (!ctx) throw new Error("Failed to create OCR resize canvas.");
      ctx.drawImage(bitmap, 0, 0, width, height);
      return { blob: await blobFromCanvas(canvas, "image/png"), width, height };
    } finally {
      bitmap.close();
    }
  }

  private sortLines(items: OcrResultItem[]): OcrResultItem[] {
    return [...items].sort((a, b) => {
      const ay = a.poly.reduce((sum, point) => sum + point[1], 0) / Math.max(1, a.poly.length);
      const by = b.poly.reduce((sum, point) => sum + point[1], 0) / Math.max(1, b.poly.length);
      const ax = a.poly.reduce((sum, point) => sum + point[0], 0) / Math.max(1, a.poly.length);
      const bx = b.poly.reduce((sum, point) => sum + point[0], 0) / Math.max(1, b.poly.length);
      if (Math.abs(ay - by) > 12) return ay - by;
      return ax - bx;
    });
  }

  private async runImage(candidate: ImageCandidate): Promise<ImageOcrResult> {
    const sourceBlob = await this.fetchImageBlob(candidate);
    const image = await this.normalizeImageBlob(sourceBlob);
    const sandbox = await this.initialize();
    const result = await sandbox.runOcr(image.blob, image, {
      textDetLimitSideLen: 960,
      textDetLimitType: "max",
      textDetMaxSideLimit: MAX_IMAGE_LONG_SIDE,
      textDetThresh: 0.2,
      textDetBoxThresh: 0.45,
      textDetUnclipRatio: 1.4,
      textRecScoreThresh: MIN_LINE_SCORE,
    });

    const lines = this.sortLines(result?.items || [])
      .map((item) => ({ text: normalizeWhitespace(item.text || ""), score: item.score || 0 }))
      .filter((line) => line.text && line.score >= MIN_LINE_SCORE);

    return {
      lines,
      width: result?.image?.width || image.width,
      height: result?.image?.height || image.height,
    };
  }

  public async processItem(item: ItemDocType): Promise<ItemOcrResult> {
    await requireLegacyBrowser();
    const candidates = this.getImageCandidates(item);
    const sourceHash = this.getSourceHashForCandidates(candidates);
    return this.withActiveOperation(() => this.processCandidates(candidates, sourceHash));
  }

  public async processImageUrl(url: string): Promise<ItemOcrResult> {
    await requireLegacyBrowser();
    const trimmed = (url || "").trim();
    const candidates: ImageCandidate[] = isHttpUrl(trimmed)
      ? [{ url: trimmed, source: "original", capturedAt: Date.now() }]
      : [];
    const sourceHash = this.getSourceHashForCandidates(candidates);
    return this.withActiveOperation(() => this.processCandidates(candidates, sourceHash));
  }

  private async processCandidates(
    candidates: ImageCandidate[],
    sourceHash: string
  ): Promise<ItemOcrResult> {
    if (candidates.length === 0) {
      return {
        status: "skipped",
        text: "",
        lineCount: 0,
        sourceHash,
        error: "No OCR image found.",
        media: [],
      };
    }

    const allLines: Array<{ text: string; score: number }> = [];
    const errors: string[] = [];
    const mediaResults: ItemOcrMediaResult[] = [];
    for (const candidate of candidates) {
      const candidateSourceHash = this.getSourceHashForCandidates([candidate]);
      try {
        const result = await this.runImage(candidate);
        const candidateSeen = new Set<string>();
        const candidateLines = result.lines.filter((line) => {
          const key = line.text.toLowerCase();
          if (candidateSeen.has(key)) return false;
          candidateSeen.add(key);
          return true;
        });
        const candidateText = normalizeWhitespace(candidateLines.map((line) => line.text).join("\n")).slice(
          0,
          MAX_OCR_TEXT_CHARS
        );
        const candidateConfidence =
          candidateLines.length > 0
            ? candidateLines.reduce((sum, line) => sum + line.score, 0) / candidateLines.length
            : undefined;
        mediaResults.push({
          url: candidate.url,
          source: candidate.source,
          status: candidateLines.length > 0 ? "done" : "skipped",
          text: candidateText,
          confidence: candidateConfidence,
          lineCount: candidateLines.length,
          sourceHash: candidateSourceHash,
          width: result.width,
          height: result.height,
          error: candidateLines.length > 0 ? undefined : "No readable text found in image.",
        });
        allLines.push(...candidateLines);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const permanent = ["IMAGE_TOO_LARGE", "IMAGE_TOO_SMALL", "UNSUPPORTED_IMAGE_TYPE"].includes(message);
        errors.push(message);
        mediaResults.push({
          url: candidate.url,
          source: candidate.source,
          status: permanent ? "skipped" : "error",
          text: "",
          lineCount: 0,
          sourceHash: candidateSourceHash,
          error: message,
        });
      }
    }

    const seen = new Set<string>();
    const lines = allLines.filter((line) => {
      const key = line.text.toLowerCase();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });

    if (lines.length === 0 && errors.length === candidates.length) {
      const permanent = errors.every((error) =>
        ["IMAGE_TOO_LARGE", "IMAGE_TOO_SMALL", "UNSUPPORTED_IMAGE_TYPE"].includes(error)
      );
      return {
        status: permanent ? "skipped" : "error",
        text: "",
        lineCount: 0,
        sourceHash,
        error: errors.slice(0, 3).join("; "),
        media: mediaResults,
      };
    }

    const text = normalizeWhitespace(lines.map((line) => line.text).join("\n")).slice(
      0,
      MAX_OCR_TEXT_CHARS
    );
    const confidence =
      lines.length > 0
        ? lines.reduce((sum, line) => sum + line.score, 0) / lines.length
        : undefined;

    return {
      status: "done",
      text,
      confidence,
      lineCount: lines.length,
      sourceHash,
      error: errors.length > 0 ? errors.slice(0, 3).join("; ") : undefined,
      media: mediaResults,
    };
  }
}

export const ocrService = new OcrService();
