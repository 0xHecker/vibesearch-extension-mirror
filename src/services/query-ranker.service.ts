import type {
  RankQueryWorkerPayload,
  RankQueryWorkerRequest,
  RankQueryWorkerResponse,
  RankQueryWorkerResult,
} from "@src/search-core/contracts";

export const RANK_REQUEST_SUPERSEDED = "RANK_REQUEST_SUPERSEDED";
export const RANK_WORKER_EXECUTION_ERROR = "RANK_WORKER_EXECUTION_ERROR";
export const RANK_WORKER_CAPACITY_ERROR = "RANK_WORKER_CAPACITY_ERROR";

export class SupersededRankRequestError extends Error {
  constructor() {
    super(RANK_REQUEST_SUPERSEDED);
    this.name = RANK_REQUEST_SUPERSEDED;
  }
}

export class RankWorkerExecutionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = RANK_WORKER_EXECUTION_ERROR;
  }
}

export class RankWorkerCapacityError extends Error {
  constructor(message: string) {
    super(`${RANK_WORKER_CAPACITY_ERROR}: ${message}`);
    this.name = RANK_WORKER_CAPACITY_ERROR;
  }
}

type RankTaskState = "queued" | "active" | "settled";

type RankTask = {
  clientId: string;
  requestId: number;
  payload: RankQueryWorkerPayload | null;
  resolve: (value: RankQueryWorkerResult) => void;
  reject: (error: Error) => void;
  state: RankTaskState;
  slot: RankWorkerSlot | null;
  queueTimer: ReturnType<typeof setTimeout> | null;
  executionTimer: ReturnType<typeof setTimeout> | null;
  signal?: AbortSignal;
  abortListener?: () => void;
};

type RankWorkerSlot = {
  worker: Worker;
  task: RankTask | null;
  lastUsedAt: number;
  idleTimer: ReturnType<typeof setTimeout> | null;
  onMessage: ((event: MessageEvent<RankQueryWorkerResponse>) => void) | null;
  onError: ((event: ErrorEvent) => void) | null;
};

export type QueryRankerServiceOptions = {
  workerFactory?: () => Worker;
  baseTimeoutMs?: number;
  maxTimeoutMs?: number;
  idleReleaseMs?: number;
  /** Hard cap for active rank workers and structured-cloned rank payloads. */
  maxWorkers?: number;
  /** Number of completed workers retained briefly for the next query. */
  maxIdleWorkers?: number;
  /** Hard cap for not-yet-cloned request payloads waiting for a worker. */
  maxQueuedRequests?: number;
  queueTimeoutMs?: number;
};

const DEFAULT_RANK_CLIENT_ID = "__legacy_rank_client__";
const MAX_RANK_CLIENT_ID_LENGTH = 128;

export class QueryRankerService {
  private readonly tasksByClient = new Map<string, RankTask>();
  private readonly queue: RankTask[] = [];
  private readonly slots = new Set<RankWorkerSlot>();
  private requestId = 0;
  private readonly workerFactory: () => Worker;
  private readonly baseTimeoutMs: number;
  private readonly maxTimeoutMs: number;
  private readonly idleReleaseMs: number;
  private readonly maxWorkers: number;
  private readonly maxIdleWorkers: number;
  private readonly maxQueuedRequests: number;
  private readonly queueTimeoutMs: number;

  constructor(options: QueryRankerServiceOptions = {}) {
    this.workerFactory = options.workerFactory || (() =>
      new Worker(new URL("./workers/query-ranker.worker.ts", import.meta.url), {
        type: "module",
      }));
    this.baseTimeoutMs = Math.max(1, options.baseTimeoutMs ?? 2200);
    this.maxTimeoutMs = Math.max(this.baseTimeoutMs, options.maxTimeoutMs ?? 8000);
    this.idleReleaseMs = Math.max(0, options.idleReleaseMs ?? 60_000);
    this.maxWorkers = Math.max(1, options.maxWorkers ?? 2);
    this.maxIdleWorkers = Math.max(
      0,
      Math.min(this.maxWorkers, options.maxIdleWorkers ?? 1)
    );
    this.maxQueuedRequests = Math.max(0, options.maxQueuedRequests ?? 8);
    this.queueTimeoutMs = Math.max(1, options.queueTimeoutMs ?? 20_000);
  }

  private normalizeClientId(clientId?: string): string {
    const normalized = typeof clientId === "string" ? clientId.trim() : "";
    return normalized
      ? normalized.slice(0, MAX_RANK_CLIENT_ID_LENGTH)
      : DEFAULT_RANK_CLIENT_ID;
  }

  private createRawWorker(): Worker {
    return this.workerFactory();
  }

  private createSlot(): RankWorkerSlot {
    const slot: RankWorkerSlot = {
      worker: this.createRawWorker(),
      task: null,
      lastUsedAt: Date.now(),
      idleTimer: null,
      onMessage: null,
      onError: null,
    };
    this.slots.add(slot);
    return slot;
  }

  private resolveTimeoutMs(payload: RankQueryWorkerPayload): number {
    const computed = this.baseTimeoutMs + payload.items.length * 0.35;
    return Math.max(this.baseTimeoutMs, Math.min(this.maxTimeoutMs, Math.round(computed)));
  }

  private cancelSlotIdleRelease(slot: RankWorkerSlot): void {
    if (!slot.idleTimer) return;
    clearTimeout(slot.idleTimer);
    slot.idleTimer = null;
  }

  private detachSlotListeners(slot: RankWorkerSlot): void {
    if (slot.onMessage) {
      slot.worker.removeEventListener("message", slot.onMessage);
      slot.onMessage = null;
    }
    if (slot.onError) {
      slot.worker.removeEventListener("error", slot.onError);
      slot.onError = null;
    }
  }

  private attachIdleErrorListener(slot: RankWorkerSlot): void {
    if (slot.onError || slot.task || !this.slots.has(slot)) return;
    const worker = slot.worker;
    const onError = () => {
      if (slot.worker === worker && slot.task === null && this.slots.has(slot)) {
        this.terminateSlot(slot);
      }
    };
    slot.onError = onError;
    worker.addEventListener("error", onError);
  }

  private terminateSlot(slot: RankWorkerSlot): void {
    this.cancelSlotIdleRelease(slot);
    this.detachSlotListeners(slot);
    if (slot.task) {
      slot.task.slot = null;
      slot.task = null;
    }
    this.slots.delete(slot);
    try {
      slot.worker.terminate();
    } catch {}
  }

  private trimIdleSlots(): void {
    const idle = Array.from(this.slots)
      .filter((slot) => slot.task === null)
      .sort((a, b) => a.lastUsedAt - b.lastUsedAt);
    while (idle.length > this.maxIdleWorkers) {
      const slot = idle.shift();
      if (slot) this.terminateSlot(slot);
    }
  }

  private scheduleSlotIdleRelease(slot: RankWorkerSlot): void {
    this.cancelSlotIdleRelease(slot);
    if (!this.slots.has(slot) || slot.task) return;
    if (this.idleReleaseMs === 0 || this.maxIdleWorkers === 0) {
      this.terminateSlot(slot);
      return;
    }
    this.attachIdleErrorListener(slot);
    slot.idleTimer = setTimeout(() => {
      slot.idleTimer = null;
      if (this.slots.has(slot) && slot.task === null) {
        this.terminateSlot(slot);
      }
    }, this.idleReleaseMs);
    this.trimIdleSlots();
  }

  prewarm(): void {
    if (
      this.idleReleaseMs === 0 ||
      this.maxIdleWorkers === 0 ||
      this.tasksByClient.size > 0 ||
      this.slots.size > 0
    ) {
      return;
    }
    this.scheduleSlotIdleRelease(this.createSlot());
  }

  private takeAvailableSlot(): RankWorkerSlot | null {
    const idle = Array.from(this.slots).find((slot) => slot.task === null);
    if (idle) {
      this.cancelSlotIdleRelease(idle);
      return idle;
    }
    if (this.slots.size >= this.maxWorkers) return null;
    return this.createSlot();
  }

  private removeQueuedTask(task: RankTask): void {
    const index = this.queue.indexOf(task);
    if (index >= 0) this.queue.splice(index, 1);
  }

  private cleanupTask(task: RankTask): void {
    if (task.queueTimer) {
      clearTimeout(task.queueTimer);
      task.queueTimer = null;
    }
    if (task.executionTimer) {
      clearTimeout(task.executionTimer);
      task.executionTimer = null;
    }
    if (task.signal && task.abortListener) {
      task.signal.removeEventListener("abort", task.abortListener);
      task.abortListener = undefined;
    }
    if (this.tasksByClient.get(task.clientId) === task) {
      this.tasksByClient.delete(task.clientId);
    }
    task.payload = null;
    task.slot = null;
    task.state = "settled";
  }

  private rejectTask(
    task: RankTask,
    error: Error,
    options: { pump?: boolean } = {}
  ): void {
    if (task.state === "settled") return;
    const { pump = true } = options;
    this.removeQueuedTask(task);
    const slot = task.slot;
    if (slot && slot.task === task) {
      this.terminateSlot(slot);
    }
    const reject = task.reject;
    this.cleanupTask(task);
    reject(error);
    if (pump) this.pumpQueue();
  }

  private finishTask(task: RankTask, result: RankQueryWorkerResult): void {
    if (task.state !== "active") return;
    const slot = task.slot;
    if (!slot || slot.task !== task || !this.slots.has(slot)) return;

    this.detachSlotListeners(slot);
    slot.task = null;
    slot.lastUsedAt = Date.now();
    const resolve = task.resolve;
    this.cleanupTask(task);
    resolve(result);

    this.pumpQueue();
    if (this.slots.has(slot) && slot.task === null) {
      this.scheduleSlotIdleRelease(slot);
    }
  }

  private startTask(task: RankTask, slot: RankWorkerSlot): void {
    if (task.state === "settled" || this.tasksByClient.get(task.clientId) !== task) {
      this.scheduleSlotIdleRelease(slot);
      return;
    }
    if (task.queueTimer) {
      clearTimeout(task.queueTimer);
      task.queueTimer = null;
    }
    const payload = task.payload;
    if (!payload) {
      this.scheduleSlotIdleRelease(slot);
      return;
    }

    task.state = "active";
    task.slot = slot;
    slot.task = task;
    slot.lastUsedAt = Date.now();
    this.cancelSlotIdleRelease(slot);
    this.detachSlotListeners(slot);
    const worker = slot.worker;

    const onMessage = (event: MessageEvent<RankQueryWorkerResponse>) => {
      const message = event.data;
      if (
        !message ||
        message.type !== "RANK_QUERY_RESULT" ||
        message.requestId !== task.requestId ||
        slot.worker !== worker ||
        slot.task !== task ||
        task.state !== "active"
      ) {
        return;
      }
      this.finishTask(task, message.payload);
    };
    const onError = (event: ErrorEvent) => {
      if (slot.worker !== worker || slot.task !== task || task.state !== "active") return;
      this.rejectTask(
        task,
        new RankWorkerExecutionError(
          event?.message || "Query rank worker failed while processing request."
        )
      );
    };
    slot.onMessage = onMessage;
    slot.onError = onError;
    worker.addEventListener("message", onMessage);
    worker.addEventListener("error", onError);

    const timeoutMs = this.resolveTimeoutMs(payload);
    task.executionTimer = setTimeout(() => {
      if (slot.worker !== worker || slot.task !== task || task.state !== "active") return;
      this.rejectTask(
        task,
        new RankWorkerExecutionError(`Query rank worker timed out after ${timeoutMs}ms.`)
      );
    }, timeoutMs);

    const request: RankQueryWorkerRequest = {
      type: "RANK_QUERY",
      requestId: task.requestId,
      payload,
    };
    try {
      worker.postMessage(request);
      // The worker now owns its structured clone. Do not retain a second
      // service-layer reference for the duration of CPU-bound ranking.
      task.payload = null;
    } catch (error) {
      if (slot.task !== task || task.state !== "active") return;
      this.rejectTask(
        task,
        error instanceof Error
          ? error
          : new RankWorkerExecutionError("Failed to post rank request to worker.")
      );
    }
  }

  private enqueueTask(task: RankTask): void {
    if (this.queue.length >= this.maxQueuedRequests) {
      this.rejectTask(
        task,
        new RankWorkerCapacityError(
          `Query rank queue is full (${this.maxQueuedRequests} waiting requests).`
        ),
        { pump: false }
      );
      return;
    }
    task.state = "queued";
    this.queue.push(task);
    task.queueTimer = setTimeout(() => {
      if (task.state !== "queued" || this.tasksByClient.get(task.clientId) !== task) return;
      this.rejectTask(
        task,
        new RankWorkerCapacityError(
          `Query rank request waited more than ${this.queueTimeoutMs}ms for a worker.`
        )
      );
    }, this.queueTimeoutMs);
  }

  private scheduleTask(task: RankTask): void {
    const slot = this.takeAvailableSlot();
    if (slot) {
      this.startTask(task, slot);
    } else {
      this.enqueueTask(task);
    }
  }

  private pumpQueue(): void {
    while (this.queue.length > 0) {
      const slot = this.takeAvailableSlot();
      if (!slot) return;
      const task = this.queue.shift();
      if (!task || task.state !== "queued" || this.tasksByClient.get(task.clientId) !== task) {
        if (this.slots.has(slot) && slot.task === null) this.scheduleSlotIdleRelease(slot);
        continue;
      }
      this.startTask(task, slot);
    }
  }

  rank(
    payload: RankQueryWorkerPayload,
    clientId?: string,
    signal?: AbortSignal
  ): Promise<RankQueryWorkerResult> {
    const normalizedClientId = this.normalizeClientId(clientId);
    const existing = this.tasksByClient.get(normalizedClientId);
    if (existing) {
      // A newer request from this page gets the released slot before unrelated
      // queued work; another page's active task is never disturbed.
      this.rejectTask(existing, new SupersededRankRequestError(), { pump: false });
    }

    this.requestId += 1;
    const requestId = this.requestId;

    return new Promise<RankQueryWorkerResult>((resolve, reject) => {
      const task: RankTask = {
        clientId: normalizedClientId,
        requestId,
        payload,
        resolve,
        reject,
        state: "queued",
        slot: null,
        queueTimer: null,
        executionTimer: null,
        signal,
      };

      this.tasksByClient.set(normalizedClientId, task);
      if (signal) {
        task.abortListener = () => {
          if (task.state === "settled") return;
          this.rejectTask(task, new SupersededRankRequestError());
        };
        if (signal.aborted) {
          task.abortListener();
          return;
        }
        signal.addEventListener("abort", task.abortListener, { once: true });
      }
      this.scheduleTask(task);
    });
  }

  dispose(): void {
    const error = new RankWorkerExecutionError("Query ranker service was disposed.");
    for (const task of Array.from(this.tasksByClient.values())) {
      this.rejectTask(task, error, { pump: false });
    }
    this.queue.length = 0;
    for (const slot of Array.from(this.slots)) {
      this.terminateSlot(slot);
    }
  }
}

export const queryRankerService = new QueryRankerService();
