// We serve the embedding model from our own Cloudflare R2 bucket via the
// metadata worker's public `/r2/<key>` passthrough, instead of HuggingFace.
// HuggingFace serves the ONNX weights as Git LFS files that 302-redirect to a
// rotating CDN host (e.g. us.aws.cdn.hf.co), which is brittle under the
// extension CSP and subject to HF rate limits. Our worker origin is stable,
// already CSP-allowlisted, and returns the files directly with CORS.
//
// URL built by transformers.js = pathJoin(remoteHost, remotePathTemplate (with
// {model}/{revision} substituted), filename). With the values below and
// MODEL_ID="models/mdbr-leaf-ir-onnx" (see embedding.worker.ts), a request for
// `onnx/model.onnx` resolves to:
//   https://metadata-worker.watermelons.workers.dev/r2/models/mdbr-leaf-ir-onnx/onnx/model.onnx
export const MODEL_REMOTE_HOST = "https://metadata-worker.shanmukh6789op.workers.dev";
export const MODEL_REMOTE_PATH_TEMPLATE = "r2/{model}/";

// ORT asyncify build filenames. The embedding worker pins device "wasm", so
// this is the only ONNX Runtime variant that gets loaded. These names are only
// used by the legacy base-URL path; the production worker passes Vite-emitted
// asset URLs directly so we do not need a duplicate /ort copy.
const ORT_WASM_FILE = "ort-wasm-simd-threaded.asyncify.wasm";
const ORT_MJS_FILE = "ort-wasm-simd-threaded.asyncify.mjs";

type WasmPaths = string | { wasm?: string | URL; mjs?: string | URL };

type EmbeddingWorkerRuntime = {
  // transformers.js model-resolution settings.
  allowRemoteModels?: boolean;
  allowLocalModels?: boolean;
  remoteHost?: string;
  remotePathTemplate?: string;
  // When false, transformers.js will not fetch ORT's wasm factory script and
  // wrap it in a blob: URL. In a dedicated worker `chrome` is undefined, so it
  // would otherwise blob: the (cross-origin) factory and trip the extension CSP
  // (script-src 'self'), which has no `blob:` and cannot get one in MV3.
  useWasmCache?: boolean;
  backends: {
    onnx: {
      // transformers.js v4 types `wasm` as possibly undefined, so it is
      // optional here and initialized below when absent.
      wasm?: {
        numThreads?: number;
        proxy?: boolean;
        wasmPaths?: WasmPaths;
      };
    };
  };
};

export type ConfigureEmbeddingRuntimeOptions = {
  // Exact same-origin URLs for the ORT wasm factory and binary. Passing the
  // Vite-emitted asset URLs lets embeddings reuse the asyncify WASM already
  // emitted for OCR instead of carrying a second copy under /ort.
  wasmPaths?: Exclude<WasmPaths, string>;
  // Legacy same-origin base URL (e.g. chrome-extension://<id>/ort/) where the
  // bundled ORT wasm assets are served.
  wasmBaseUrl?: string;
};

/**
 * The dedicated embedding worker already isolates inference from the UI. ONNX
 * must not create its own blob-backed thread/proxy workers inside an extension
 * CSP, and its wasm assets must load same-origin. We also redirect model
 * downloads from HuggingFace to our R2-backed worker.
 */
export const configureEmbeddingWorkerRuntime = (
  runtime: EmbeddingWorkerRuntime,
  options: ConfigureEmbeddingRuntimeOptions = {}
) => {
  const wasm = (runtime.backends.onnx.wasm ??= {});
  wasm.numThreads = 1;
  wasm.proxy = false;

  // Load ORT from bundled same-origin files (not the jsdelivr CDN) and disable
  // the wasm-factory blob cache so nothing is loaded via a blob: URL.
  runtime.useWasmCache = false;
  if (options.wasmPaths) {
    wasm.wasmPaths = options.wasmPaths;
  } else if (options.wasmBaseUrl) {
    const base = options.wasmBaseUrl.endsWith("/") ? options.wasmBaseUrl : `${options.wasmBaseUrl}/`;
    wasm.wasmPaths = {
      wasm: `${base}${ORT_WASM_FILE}`,
      mjs: `${base}${ORT_MJS_FILE}`,
    };
  }

  // Fetch model files from our R2-backed worker, never the local FS (there is
  // no bundled copy) and never from HuggingFace.
  runtime.allowRemoteModels = true;
  runtime.allowLocalModels = false;
  runtime.remoteHost = MODEL_REMOTE_HOST;
  runtime.remotePathTemplate = MODEL_REMOTE_PATH_TEMPLATE;
};
