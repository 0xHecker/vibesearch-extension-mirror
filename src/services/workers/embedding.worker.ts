/// <reference lib="webworker" />

import {
  env,
  AutoModel,
  AutoTokenizer,
  type DataType,
  type PreTrainedModel,
  type PreTrainedTokenizer,
  type Tensor,
} from "@huggingface/transformers";
import { VECTOR_DIMENSION } from "@src/common/constants";
import { configureEmbeddingWorkerRuntime } from "@src/services/embedding-worker-runtime";
import { embeddingWasmAssets } from "@src/services/embedding-wasm-assets";
import { planLengthAwareBatches } from "@src/search-core/embedding-batching";
import type { EmbeddingWorkerRequest, EmbeddingWorkerResponse } from "./embedding-worker-protocol";

// The model is onnx-community/mdbr-leaf-ir-ONNX, mirrored to our R2 bucket and
// served via the metadata worker (see embedding-worker-runtime.ts for the host
// + path template). It exports the full sentence-transformers graph
// (mean pooling -> 384x768 Dense -> L2 normalize) and exposes a
// `sentence_embedding` output. We therefore run AutoModel directly and read
// that output, rather than the feature-extraction pipeline which would
// mean-pool `last_hidden_state` and skip the Dense/Normalize layers, yielding
// the wrong 384-dim vectors. Query/passage asymmetry (the query prefix) is
// applied upstream in search-core/embedding-text.ts.
//
// MODEL_ID is the R2 key namespace: combined with remotePathTemplate "r2/{model}/"
// it yields keys like r2/models/mdbr-leaf-ir-onnx/onnx/model.onnx on the worker.
const MODEL_ID = "models/mdbr-leaf-ir-onnx";

// We load full-precision fp32 only, for retrieval quality and so every vector
// in the index comes from the same numerical model. We attempt twice to ride
// out a transient fetch failure before opening the circuit breaker.
const INITIALIZATION_ATTEMPTS: ReadonlyArray<{ dtype: DataType; label: string }> = [
  { dtype: "fp32", label: "primary" },
  { dtype: "fp32", label: "retry" },
];
const INITIALIZATION_RETRY_MS = 500;
const CIRCUIT_OPEN_MS = 30_000;

// Self-attention memory scales with (batchSize * paddedLength^2). A single
// unbounded batch is what spikes a bulk import to multiple GB. We cap every
// inference pass to a few sentences and bucket by length so padding stays
// small. The query path embeds one sentence, so it is unaffected.
const MICRO_BATCH_MAX_SENTENCES = 8;
// ~4 chars/token; the model truncates at 512 tokens (~2048 chars), so this is
// the most a single sentence can contribute to a batch's padded width.
const SENTENCE_WEIGHT_CAP = 2048;
const MAX_MICRO_BATCH_WEIGHT = MICRO_BATCH_MAX_SENTENCES * SENTENCE_WEIGHT_CAP;

type EmbeddingRuntime = {
  tokenizer: PreTrainedTokenizer;
  model: PreTrainedModel;
};

let embeddingRuntime: EmbeddingRuntime | null = null;
let initialization: Promise<EmbeddingRuntime> | null = null;
let consecutiveFailures = 0;
let circuitOpenUntil = 0;

configureEmbeddingWorkerRuntime(env, {
  // Vite emits these as chrome-extension:// same-origin assets and reuses the
  // asyncify WASM that is already present for OCR, avoiding a second /ort copy.
  wasmPaths: {
    wasm: new URL(embeddingWasmAssets.wasm, self.location.href).href,
    ...(embeddingWasmAssets.mjs
      ? { mjs: new URL(embeddingWasmAssets.mjs, self.location.href).href }
      : {}),
  },
});

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

const initializeRuntime = async (): Promise<EmbeddingRuntime> => {
  let lastError: unknown = null;

  for (let index = 0; index < INITIALIZATION_ATTEMPTS.length; index += 1) {
    const attempt = INITIALIZATION_ATTEMPTS[index];
    try {
      const tokenizer = await AutoTokenizer.from_pretrained(MODEL_ID);
      const model = await AutoModel.from_pretrained(MODEL_ID, {
        dtype: attempt.dtype,
        device: "wasm",
      });
      embeddingRuntime = { tokenizer, model };
      consecutiveFailures = 0;
      circuitOpenUntil = 0;
      return embeddingRuntime;
    } catch (error) {
      lastError = error;
      if (index < INITIALIZATION_ATTEMPTS.length - 1) {
        await sleep(INITIALIZATION_RETRY_MS * (index + 1));
      }
    }
  }

  consecutiveFailures += 1;
  if (consecutiveFailures >= 2) {
    circuitOpenUntil = Date.now() + CIRCUIT_OPEN_MS;
  }
  throw new Error(
    `Failed to initialize embedding model: ${lastError instanceof Error ? lastError.message : "unknown error"}`
  );
};

const getRuntime = async (): Promise<EmbeddingRuntime> => {
  if (embeddingRuntime) return embeddingRuntime;
  if (Date.now() < circuitOpenUntil) {
    throw new Error(`Embedding model is temporarily unavailable. Retry in ${Math.ceil((circuitOpenUntil - Date.now()) / 1000)}s.`);
  }
  if (!initialization) {
    initialization = initializeRuntime().finally(() => {
      initialization = null;
    });
  }
  return initialization;
};

const post = (message: EmbeddingWorkerResponse, transfer?: Transferable[]) => {
  const scope = self as unknown as DedicatedWorkerGlobalScope;
  if (transfer) {
    scope.postMessage(message, transfer);
    return;
  }
  scope.postMessage(message);
};

// Embed one bounded micro-batch and scatter its rows into `output` at the
// callers' original positions, so the returned buffer matches input order.
const embedMicroBatch = async (
  runtime: EmbeddingRuntime,
  sentences: string[],
  indices: number[],
  output: Float32Array
): Promise<void> => {
  const batchSentences = indices.map((index) => sentences[index]);
  // Per-batch padding + truncation keeps the padded width local to this small
  // batch and guards against inputs longer than the model's 512-token limit.
  const inputs = await runtime.tokenizer(batchSentences, { padding: true, truncation: true });
  const outputs = (await runtime.model(inputs)) as { sentence_embedding?: Tensor };
  const sentenceEmbedding = outputs.sentence_embedding;
  if (!sentenceEmbedding) {
    throw new Error("Embedding model did not return a sentence_embedding output.");
  }

  const data = sentenceEmbedding.data as Float32Array;
  const expectedLength = indices.length * VECTOR_DIMENSION;
  if (data.length !== expectedLength) {
    throw new Error(`Embedding output shape mismatch. Expected ${expectedLength}, received ${data.length}.`);
  }

  for (let row = 0; row < indices.length; row += 1) {
    const sourceStart = row * VECTOR_DIMENSION;
    output.set(data.subarray(sourceStart, sourceStart + VECTOR_DIMENSION), indices[row] * VECTOR_DIMENSION);
  }
};

self.addEventListener("message", async (event: MessageEvent<EmbeddingWorkerRequest>) => {
  const request = event.data;
  if (!request || request.type !== "EMBEDDING_REQUEST") return;

  try {
    const sentences = request.payload.sentences;
    const output = new Float32Array(sentences.length * VECTOR_DIMENSION);

    if (sentences.length > 0) {
      const runtime = await getRuntime();
      const weights = sentences.map((sentence) => Math.min(sentence.length, SENTENCE_WEIGHT_CAP));
      const microBatches = planLengthAwareBatches(weights, {
        maxItems: MICRO_BATCH_MAX_SENTENCES,
        maxBatchWeight: MAX_MICRO_BATCH_WEIGHT,
      });

      for (const indices of microBatches) {
        await embedMicroBatch(runtime, sentences, indices, output);
      }
    }

    post(
      {
        type: "EMBEDDING_RESULT",
        requestId: request.requestId,
        payload: { buffer: output.buffer },
      },
      [output.buffer]
    );
  } catch (error) {
    post({
      type: "EMBEDDING_ERROR",
      requestId: request.requestId,
      error: error instanceof Error ? error.message : "Embedding failed.",
    });
  }
});
