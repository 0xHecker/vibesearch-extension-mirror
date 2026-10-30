import { expect, spyOn, test } from "bun:test";
import { EmbeddingQueue } from "@src/pages/offscreen/runtime/embedding-queue";
import { OcrQueue } from "@src/pages/offscreen/runtime/ocr-queue";
import { listenForProcessingTriggers } from "@src/pages/offscreen/runtime/processing-trigger-listener";
import { EmbeddingWorkerClient } from "@src/services/embedding-worker-client";
import { embeddingService } from "@src/services/embedding.service";
import { ItemsController } from "@src/services/controllers/items.controller";
import { vectorStoreService } from "@src/services/vector-store.service";
import { EXTENSION_POLICY_KEY, type ExtensionPolicy } from "@src/services/extension-policy";
import { forwardProcessingTriggerToOffscreen } from "@src/workers/background/processing-triggers";

type MessageListener = Parameters<typeof chrome.runtime.onMessage.addListener>[0];

function processingRuntime(mode: ExtensionPolicy["mode"]) {
  const previousChrome = Object.getOwnPropertyDescriptor(globalThis, "chrome");
  const policy: ExtensionPolicy = { version: 1, mode, legacyCloudEnabled: false };
  let listener: MessageListener | undefined;
  let hostChecks = 0;
  let messages = 0;
  const dispatch = (message: unknown): Promise<unknown> => new Promise((resolve, reject) => {
    if (!listener) {
      reject(new Error("Processing listener was not registered."));
      return;
    }
    listener(message, { id: "test-extension", url: "chrome-extension://test-extension/background.js" }, resolve);
  });
  Object.defineProperty(globalThis, "chrome", {
    configurable: true,
    value: {
      storage: { local: { get: async (key: string) => ({ [key]: key === EXTENSION_POLICY_KEY ? policy : undefined }) } },
      runtime: {
        id: "test-extension",
        getURL: (path: string) => `chrome-extension://test-extension/${path}`,
        getContexts: async () => { hostChecks++; return [{ contextType: "OFFSCREEN_DOCUMENT" }]; },
        onMessage: { addListener: (entry: MessageListener) => { listener = entry; } },
        sendMessage: async (message: unknown) => { messages++; return dispatch(message); },
      },
      offscreen: { createDocument: async () => { throw new Error("The test must not create a browser document."); } },
    },
  });
  const embedding = new EmbeddingQueue(() => {});
  const ocr = new OcrQueue({ isEmbeddingRunning: () => false, scheduleEmbedding: () => {} });
  const embeddingTrigger = spyOn(embedding, "trigger").mockImplementation(() => {});
  const ocrTrigger = spyOn(ocr, "trigger").mockImplementation(() => {});
  const ocrEnqueue = spyOn(ocr, "enqueue").mockImplementation(() => {});
  listenForProcessingTriggers({ embedding, ocr });
  return {
    dispatch, embeddingTrigger, ocrTrigger, ocrEnqueue,
    counts: () => ({ hostChecks, messages }),
    restore: () => {
      embeddingTrigger.mockRestore();
      ocrTrigger.mockRestore();
      ocrEnqueue.mockRestore();
      if (previousChrome) Object.defineProperty(globalThis, "chrome", previousChrome);
      else Reflect.deleteProperty(globalThis, "chrome");
    },
  };
}

test("browser mode forwards embeddings and automatic/manual OCR to the existing queues", async () => {
  const runtime = processingRuntime("legacy-browser");
  try {
    await forwardProcessingTriggerToOffscreen("TRIGGER_EMBEDDING");
    await forwardProcessingTriggerToOffscreen("TRIGGER_OCR");
    await forwardProcessingTriggerToOffscreen("TRIGGER_OCR", { itemId: "saved-image", force: true });
    expect(runtime.embeddingTrigger).toHaveBeenCalledTimes(1);
    expect(runtime.ocrTrigger).toHaveBeenCalledTimes(2);
    expect(runtime.ocrEnqueue).toHaveBeenCalledTimes(1);
    expect(runtime.ocrEnqueue).toHaveBeenCalledWith("saved-image", true);
    expect(runtime.counts()).toEqual({ hostChecks: 3, messages: 3 });
  } finally { runtime.restore(); }
});

test("explicit local-only mode blocks processing before host creation and rejects forwarded commands", async () => {
  const runtime = processingRuntime("local-only");
  try {
    for (const type of ["TRIGGER_EMBEDDING", "TRIGGER_OCR"] satisfies Array<"TRIGGER_EMBEDDING" | "TRIGGER_OCR">) {
      await expect(forwardProcessingTriggerToOffscreen(type)).rejects.toThrow("LOCAL_ONLY_LEGACY_DISABLED");
      expect(await runtime.dispatch({ type, isForwarded: true })).toEqual({ success: false, error: "LOCAL_ONLY_LEGACY_DISABLED" });
    }
    expect(await runtime.dispatch({ type: "TRIGGER_OCR", isForwarded: true, payload: { itemId: "saved-image", force: true } })).toEqual({ success: false, error: "LOCAL_ONLY_LEGACY_DISABLED" });
    expect(runtime.embeddingTrigger).toHaveBeenCalledTimes(0);
    expect(runtime.ocrTrigger).toHaveBeenCalledTimes(0);
    expect(runtime.ocrEnqueue).toHaveBeenCalledTimes(0);
    expect(runtime.counts()).toEqual({ hostChecks: 0, messages: 0 });
  } finally { runtime.restore(); }
});

test("the embedding service dispatches browser requests and rejects local-only requests before the worker", async () => {
  const embed = spyOn(EmbeddingWorkerClient.prototype, "embed").mockResolvedValue(new Float32Array([1, 2]));
  try {
    const browser = processingRuntime("legacy-browser");
    try {
      expect(await embeddingService.generateEmbeddings({ sentences: ["saved text"], priority: "interactive" })).toEqual(new Float32Array([1, 2]));
      expect(embed).toHaveBeenCalledWith(["saved text"], "interactive", undefined);
    } finally { browser.restore(); }
    const local = processingRuntime("local-only");
    try {
      await expect(embeddingService.generateEmbeddings({ sentences: ["saved text"] })).rejects.toThrow("LOCAL_ONLY_LEGACY_DISABLED");
      expect(embed).toHaveBeenCalledTimes(1);
    } finally { local.restore(); }
  } finally { embed.mockRestore(); }
});

test("browser semantic search acquires its vector lease while local-only search skips vectors", async () => {
  const acquire = spyOn(vectorStoreService, "acquireQueryLease").mockRejectedValue(new Error("vector-search-dispatched"));
  const controller = new ItemsController({ getDb: async () => { throw new Error("lexical-search-dispatched"); } });
  const query = { query: "agents", useKeyword: false, useVector: true };
  try {
    const browser = processingRuntime("legacy-browser");
    try {
      await expect(controller.queryLocal(query)).rejects.toThrow("vector-search-dispatched");
      expect(acquire).toHaveBeenCalledTimes(1);
    } finally { browser.restore(); }
    const local = processingRuntime("local-only");
    try {
      await expect(controller.queryLocal(query)).rejects.toThrow("lexical-search-dispatched");
      expect(acquire).toHaveBeenCalledTimes(1);
    } finally { local.restore(); }
  } finally { acquire.mockRestore(); }
});

test("browser queues schedule automatic processing and local-only queues do not schedule model work", async () => {
  const previousWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
  const delays: number[] = [];
  Object.defineProperty(globalThis, "window", { configurable: true, value: { setTimeout: (_callback: () => void, delay: number) => { delays.push(delay); return delays.length; } } });
  try {
    for (const mode of ["legacy-browser", "local-only"] satisfies ExtensionPolicy["mode"][]) {
      const runtime = processingRuntime(mode);
      try {
        delays.length = 0;
        const embedding = new EmbeddingQueue(() => {});
        const ocr = new OcrQueue({ isEmbeddingRunning: () => false, scheduleEmbedding: () => {} });
        embedding.trigger();
        embedding.scheduleIfNeeded();
        ocr.trigger();
        ocr.scheduleIfNeeded();
        await Bun.sleep(0);
        expect(delays).toEqual(mode === "legacy-browser" ? [200, 250, 500, 1_000] : []);
      } finally { runtime.restore(); }
    }
  } finally {
    if (previousWindow) Object.defineProperty(globalThis, "window", previousWindow);
    else Reflect.deleteProperty(globalThis, "window");
  }
});
