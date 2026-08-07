import type {
  EmbeddingRequestPriority,
  EmbeddingWorkerRequest,
  EmbeddingWorkerResponse,
} from "./workers/embedding-worker-protocol";

type PendingEmbedding = {
  request: EmbeddingWorkerRequest;
  resolve: (value: Float32Array) => void;
  reject: (reason: Error) => void;
  signal?: AbortSignal;
  abortListener?: () => void;
  settled: boolean;
};

type WorkerFactory = () => Worker;

type WorkerListenerBinding = {
  worker: Worker;
  generation: number;
  message: (event: MessageEvent<EmbeddingWorkerResponse>) => void;
  error: (event: ErrorEvent) => void;
  messageerror: (event: MessageEvent) => void;
};

const createEmbeddingWorker = (): Worker =>
  new Worker(new URL("./workers/embedding.worker.ts", import.meta.url), { type: "module" });

export const EMBEDDING_ACTIVE_REQUEST_TIMEOUT_MS = 3 * 60_000;

/**
 * Keeps inference out of the offscreen document and lets user-initiated search
 * run before queued import work. A single worker also avoids concurrent ONNX runs.
 */
export class EmbeddingWorkerClient {
  private worker: Worker | null = null;
  private active: PendingEmbedding | null = null;
  private interactiveQueue: PendingEmbedding[] = [];
  private backgroundQueue: PendingEmbedding[] = [];
  private requestId = 0;
  private idleTimer: ReturnType<typeof setTimeout> | null = null;
  private activeTimer: ReturnType<typeof setTimeout> | null = null;
  private workerGeneration = 0;
  private workerListeners: WorkerListenerBinding | null = null;

  constructor(
    private readonly workerFactory: WorkerFactory = createEmbeddingWorker,
    private readonly idleTimeoutMs = 60_000,
    private readonly activeRequestTimeoutMs = EMBEDDING_ACTIVE_REQUEST_TIMEOUT_MS
  ) {}

  private abortError(signal?: AbortSignal): Error {
    const error = new Error(
      signal?.reason instanceof Error ? signal.reason.message : "Embedding request was aborted."
    );
    error.name = "AbortError";
    return error;
  }

  private cleanupPending(pending: PendingEmbedding) {
    if (pending.signal && pending.abortListener) {
      pending.signal.removeEventListener("abort", pending.abortListener);
      pending.abortListener = undefined;
    }
  }

  private resolvePending(pending: PendingEmbedding, value: Float32Array) {
    if (pending.settled) return;
    pending.settled = true;
    this.cleanupPending(pending);
    pending.resolve(value);
  }

  private rejectPending(pending: PendingEmbedding, error: Error) {
    if (pending.settled) return;
    pending.settled = true;
    this.cleanupPending(pending);
    pending.reject(error);
  }

  private removeQueued(pending: PendingEmbedding): boolean {
    for (const queue of [this.interactiveQueue, this.backgroundQueue]) {
      const index = queue.indexOf(pending);
      if (index < 0) continue;
      queue.splice(index, 1);
      return true;
    }
    return false;
  }

  private clearIdleTimer() {
    if (this.idleTimer === null) return;
    clearTimeout(this.idleTimer);
    this.idleTimer = null;
  }

  private clearActiveTimer() {
    if (this.activeTimer === null) return;
    clearTimeout(this.activeTimer);
    this.activeTimer = null;
  }

  private isCurrentWorker(worker: Worker, generation: number): boolean {
    return (
      this.worker === worker &&
      this.workerListeners?.worker === worker &&
      this.workerListeners.generation === generation
    );
  }

  private terminateWorker(worker: Worker) {
    const listeners = this.workerListeners;
    if (listeners?.worker === worker) {
      worker.removeEventListener("message", listeners.message);
      worker.removeEventListener("error", listeners.error);
      worker.removeEventListener("messageerror", listeners.messageerror);
      this.workerListeners = null;
    }
    if (this.worker === worker) this.worker = null;
    worker.terminate();
  }

  private scheduleIdleTermination() {
    if (!this.worker || this.active || this.interactiveQueue.length > 0 || this.backgroundQueue.length > 0) {
      return;
    }
    this.clearIdleTimer();
    const worker = this.worker;
    const generation = this.workerGeneration;
    this.idleTimer = setTimeout(() => {
      this.idleTimer = null;
      if (this.active || this.interactiveQueue.length > 0 || this.backgroundQueue.length > 0) {
        return;
      }
      if (worker && this.isCurrentWorker(worker, generation)) {
        this.terminateWorker(worker);
      }
    }, this.idleTimeoutMs);
  }

  private ensureWorker(): Worker {
    this.clearIdleTimer();
    if (this.worker) return this.worker;

    const worker = this.workerFactory();
    const generation = ++this.workerGeneration;
    const listeners: WorkerListenerBinding = {
      worker,
      generation,
      message: (event) => {
        if (!this.isCurrentWorker(worker, generation)) return;
        this.handleMessage(event);
      },
      error: (event) => {
        if (!this.isCurrentWorker(worker, generation)) return;
        this.handleWorkerFailure(event);
      },
      messageerror: (event) => {
        if (!this.isCurrentWorker(worker, generation)) return;
        this.handleWorkerFailure(event);
      },
    };
    this.worker = worker;
    this.workerListeners = listeners;
    worker.addEventListener("message", listeners.message);
    worker.addEventListener("error", listeners.error);
    worker.addEventListener("messageerror", listeners.messageerror);
    return worker;
  }

  private handleMessage = (event: MessageEvent<EmbeddingWorkerResponse>) => {
    const response = event.data;
    const active = this.active;
    if (!active || response?.requestId !== active.request.requestId) return;

    this.clearActiveTimer();
    this.active = null;
    if (response.type === "EMBEDDING_RESULT" && response.payload.buffer instanceof ArrayBuffer) {
      this.resolvePending(active, new Float32Array(response.payload.buffer));
    } else {
      this.rejectPending(
        active,
        new Error(response.type === "EMBEDDING_ERROR" ? response.error : "Invalid embedding response.")
      );
    }
    this.pump();
  };

  private handleWorkerFailure = (event: ErrorEvent | MessageEvent) => {
    const message = "message" in event && typeof event.message === "string"
      ? event.message
      : "Embedding worker failed.";
    this.failAll(new Error(message));
  };

  private startActiveWatchdog(
    pending: PendingEmbedding,
    worker: Worker,
    generation: number
  ) {
    this.clearActiveTimer();
    const timeoutMs = Math.max(1, Math.floor(this.activeRequestTimeoutMs));
    const timer = setTimeout(() => {
      if (this.activeTimer !== timer) return;
      this.activeTimer = null;
      if (this.active !== pending || !this.isCurrentWorker(worker, generation)) return;

      this.active = null;
      this.rejectPending(
        pending,
        new Error(`Embedding worker timed out after ${timeoutMs}ms.`)
      );
      this.terminateWorker(worker);
      this.pump();
    }, timeoutMs);
    this.activeTimer = timer;
  }

  private nextPending(): PendingEmbedding | null {
    while (this.interactiveQueue.length > 0 || this.backgroundQueue.length > 0) {
      const pending = this.interactiveQueue.shift() || this.backgroundQueue.shift() || null;
      if (!pending) return null;
      if (pending.signal?.aborted) {
        this.rejectPending(pending, this.abortError(pending.signal));
        continue;
      }
      return pending;
    }
    return null;
  }

  private pump() {
    if (this.active) return;

    const next = this.nextPending();
    if (!next) {
      this.scheduleIdleTermination();
      return;
    }

    this.clearIdleTimer();
    this.active = next;
    try {
      const worker = this.ensureWorker();
      this.startActiveWatchdog(next, worker, this.workerGeneration);
      worker.postMessage(next.request);
    } catch (error) {
      this.failAll(error instanceof Error ? error : new Error("Could not start embedding worker."));
    }
  }

  private failAll(error: Error) {
    this.clearIdleTimer();
    this.clearActiveTimer();
    if (this.worker) this.terminateWorker(this.worker);

    const pending = [this.active, ...this.interactiveQueue, ...this.backgroundQueue].filter(
      (entry): entry is PendingEmbedding => entry !== null
    );
    this.active = null;
    this.interactiveQueue = [];
    this.backgroundQueue = [];
    for (const entry of pending) this.rejectPending(entry, error);
  }

  public embed(
    sentences: string[],
    priority: EmbeddingRequestPriority,
    signal?: AbortSignal
  ): Promise<Float32Array> {
    if (signal?.aborted) return Promise.reject(this.abortError(signal));
    if (sentences.length === 0) return Promise.resolve(new Float32Array());

    this.clearIdleTimer();
    this.requestId += 1;
    const request: EmbeddingWorkerRequest = {
      type: "EMBEDDING_REQUEST",
      requestId: this.requestId,
      priority,
      payload: { sentences },
    };

    return new Promise<Float32Array>((resolve, reject) => {
      const pending: PendingEmbedding = { request, resolve, reject, signal, settled: false };
      if (signal) {
        pending.abortListener = () => {
          const wasQueued = this.removeQueued(pending);
          this.rejectPending(pending, this.abortError(signal));
          if (wasQueued && !this.active) this.pump();
        };
        signal.addEventListener("abort", pending.abortListener, { once: true });
      }
      if (priority === "interactive") {
        this.interactiveQueue.push(pending);
      } else {
        this.backgroundQueue.push(pending);
      }
      this.pump();
    });
  }
}
