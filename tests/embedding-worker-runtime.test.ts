import { expect, test } from "bun:test";
import { configureEmbeddingWorkerRuntime } from "@src/services/embedding-worker-runtime";

const makeRuntime = () => ({
  backends: {
    onnx: {
      wasm: {
        numThreads: 4,
        proxy: true,
      },
    },
  },
});

test("embedding worker disables nested ONNX workers in an extension CSP", () => {
  const runtime = makeRuntime();

  configureEmbeddingWorkerRuntime(runtime);

  // No blob/proxy/thread workers, and no blob-ifying wasm factory cache.
  expect(runtime.backends.onnx.wasm.numThreads).toBe(1);
  expect(runtime.backends.onnx.wasm.proxy).toBe(false);
  expect((runtime as Record<string, unknown>).useWasmCache).toBe(false);
});

test("embedding worker resolves model files from the R2-backed worker, not the CDN/FS", () => {
  const runtime = makeRuntime();

  configureEmbeddingWorkerRuntime(runtime);

  const r = runtime as Record<string, unknown>;
  expect(r.allowRemoteModels).toBe(true);
  expect(r.allowLocalModels).toBe(false);
  expect(r.remoteHost).toBe("https://metadata-worker.shanmukh6789op.workers.dev");
  expect(r.remotePathTemplate).toBe("r2/{model}/");
});

test("embedding worker points ONNX at bundled same-origin wasm when a base URL is given", () => {
  const runtime = makeRuntime();

  configureEmbeddingWorkerRuntime(runtime, {
    wasmBaseUrl: "chrome-extension://abc/ort/",
  });

  expect(runtime.backends.onnx.wasm.wasmPaths).toEqual({
    wasm: "chrome-extension://abc/ort/ort-wasm-simd-threaded.asyncify.wasm",
    mjs: "chrome-extension://abc/ort/ort-wasm-simd-threaded.asyncify.mjs",
  });
});

test("embedding worker accepts exact Vite-emitted ONNX wasm asset URLs", () => {
  const runtime = makeRuntime();

  configureEmbeddingWorkerRuntime(runtime, {
    wasmPaths: {
      wasm: "chrome-extension://abc/assets/ort-wasm-simd-threaded.asyncify-hash.wasm",
      mjs: "chrome-extension://abc/assets/ort-wasm-simd-threaded.asyncify-hash.mjs",
    },
  });

  expect(runtime.backends.onnx.wasm.wasmPaths).toEqual({
    wasm: "chrome-extension://abc/assets/ort-wasm-simd-threaded.asyncify-hash.wasm",
    mjs: "chrome-extension://abc/assets/ort-wasm-simd-threaded.asyncify-hash.mjs",
  });
});

test("embedding worker normalizes a base URL without a trailing slash", () => {
  const runtime = makeRuntime();

  configureEmbeddingWorkerRuntime(runtime, {
    wasmBaseUrl: "chrome-extension://abc/ort",
  });

  expect(runtime.backends.onnx.wasm.wasmPaths).toEqual({
    wasm: "chrome-extension://abc/ort/ort-wasm-simd-threaded.asyncify.wasm",
    mjs: "chrome-extension://abc/ort/ort-wasm-simd-threaded.asyncify.mjs",
  });
});
