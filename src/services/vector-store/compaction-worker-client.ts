import type {
  CopyCleanVectorsWorkerPayload,
  CopyCleanVectorsWorkerRequest,
  CopyCleanVectorsWorkerResponse,
  CopyCleanVectorsWorkerResult,
} from "./compaction-copy";

type WorkerListener = (event: any) => void;

export type VectorCompactionWorkerLike = {
  addEventListener(type: string, listener: WorkerListener): void;
  removeEventListener(type: string, listener: WorkerListener): void;
  postMessage(message: CopyCleanVectorsWorkerRequest): void;
  terminate(): void;
};

type VectorCompactionWorkerFactory = () => VectorCompactionWorkerLike;

const createVectorCompactionWorker = (): VectorCompactionWorkerLike =>
  new Worker(new URL("../workers/vector-compaction.worker.ts", import.meta.url), {
    type: "module",
  });

export const VECTOR_COMPACTION_WORKER_TIMEOUT_MS = 5 * 60 * 1000;

/** One request per worker keeps OPFS failures and worker memory tightly scoped. */
export class VectorCompactionWorkerClient {
  private requestId = 0;

  constructor(
    private readonly workerFactory: VectorCompactionWorkerFactory = createVectorCompactionWorker,
    private readonly timeoutMs = VECTOR_COMPACTION_WORKER_TIMEOUT_MS
  ) {}

  async copyCleanVectors(
    payload: CopyCleanVectorsWorkerPayload
  ): Promise<CopyCleanVectorsWorkerResult> {
    const worker = this.workerFactory();
    const requestId = ++this.requestId;

    return new Promise<CopyCleanVectorsWorkerResult>((resolve, reject) => {
      let settled = false;
      let timer: ReturnType<typeof setTimeout> | null = null;

      const cleanup = () => {
        if (timer !== null) {
          clearTimeout(timer);
          timer = null;
        }
        try {
          worker.removeEventListener("message", onMessage);
          worker.removeEventListener("error", onError);
          worker.removeEventListener("messageerror", onMessageError);
        } catch {}
        try {
          worker.terminate();
        } catch {}
      };

      const settle = (
        outcome:
          | { ok: true; value: CopyCleanVectorsWorkerResult }
          | { ok: false; error: Error }
      ) => {
        if (settled) return;
        settled = true;
        cleanup();
        if (outcome.ok) resolve(outcome.value);
        else reject(outcome.error);
      };

      const onMessage = (event: MessageEvent<CopyCleanVectorsWorkerResponse>) => {
        const response = event.data;
        if (
          !response ||
          response.type !== "COPY_CLEAN_VECTORS_RESULT" ||
          response.requestId !== requestId
        ) {
          return;
        }
        if (response.ok) {
          settle({ ok: true, value: response.payload });
        } else {
          settle({ ok: false, error: new Error(response.error) });
        }
      };

      const onError = (event: ErrorEvent | { message?: string }) => {
        settle({
          ok: false,
          error: new Error(event?.message || "Vector compaction worker failed."),
        });
      };

      const onMessageError = () => {
        settle({
          ok: false,
          error: new Error("Vector compaction worker returned an unreadable response."),
        });
      };

      worker.addEventListener("message", onMessage);
      worker.addEventListener("error", onError);
      worker.addEventListener("messageerror", onMessageError);
      timer = setTimeout(() => {
        settle({
          ok: false,
          error: new Error(`Vector compaction worker timed out after ${this.timeoutMs}ms.`),
        });
      }, this.timeoutMs);

      try {
        worker.postMessage({
          type: "COPY_CLEAN_VECTORS",
          requestId,
          payload,
        });
      } catch (error) {
        settle({
          ok: false,
          error: error instanceof Error ? error : new Error("Failed to start vector compaction."),
        });
      }
    });
  }
}
