import wasmUrl from "onnxruntime-web/ort-wasm-simd-threaded.asyncify.wasm?url";
import mjsUrl from "onnxruntime-web/ort-wasm-simd-threaded.asyncify.mjs?url";

export const embeddingWasmAssets = {
  wasm: wasmUrl,
  mjs: mjsUrl,
};
