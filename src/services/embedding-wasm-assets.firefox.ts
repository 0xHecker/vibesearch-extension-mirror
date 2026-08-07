import wasmUrl from "onnxruntime-web/ort-wasm-simd-threaded.wasm?url";

// The Firefox ONNX entry embeds its CSP-safe factory, so only the standard
// WASM binary needs to be emitted and located explicitly.
export const embeddingWasmAssets = {
  wasm: wasmUrl,
};
