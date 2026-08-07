import { describe, expect, test } from "bun:test";
import type {
  RankQueryWorkerPayload,
  RankQueryWorkerRequest,
  RankQueryWorkerResult,
} from "@src/search-core/contracts";
import {
  QueryRankerService,
  RANK_REQUEST_SUPERSEDED,
} from "@src/services/query-ranker.service";

class FakeRankWorker {
  readonly requests: RankQueryWorkerRequest[] = [];
  terminated = false;
  private listeners = new Map<string, Set<(event: any) => void>>();

  addEventListener(type: string, listener: (event: any) => void) {
    const listeners = this.listeners.get(type) || new Set();
    listeners.add(listener);
    this.listeners.set(type, listeners);
  }

  removeEventListener(type: string, listener: (event: any) => void) {
    this.listeners.get(type)?.delete(listener);
  }

  postMessage(request: RankQueryWorkerRequest) {
    this.requests.push(request);
  }

  terminate() {
    this.terminated = true;
  }

  respond(result: RankQueryWorkerResult, requestIndex = 0) {
    const request = this.requests[requestIndex];
    if (!request) throw new Error("Missing fake worker request.");
    this.emit("message", {
      data: {
        type: "RANK_QUERY_RESULT",
        requestId: request.requestId,
        payload: result,
      },
    });
  }

  listenerCount(type: string): number {
    return this.listeners.get(type)?.size || 0;
  }

  private emit(type: string, event: any) {
    for (const listener of Array.from(this.listeners.get(type) || [])) {
      listener(event);
    }
  }
}

const rankPayload = (queryHash: string): RankQueryWorkerPayload => ({
  items: [],
  groups: [],
  excludedTerms: [],
  flatPositiveTerms: [],
  hasTextConstraint: false,
  useLexical: false,
  useVector: false,
  queryHash,
  sortBy: "relevance",
  sortOrder: "desc",
  page: 1,
  limit: 20,
  lexicalScores: [],
  vectorScoresByIndex: [],
});

const rankResult = (id: string): RankQueryWorkerResult => ({
  itemIds: [id],
  total: 1,
  vectorHits: 0,
  lexicalHits: 0,
  hasMore: false,
  nextCursor: null,
});

describe("QueryRankerService client lanes", () => {
  test("allows two clients to overlap without either superseding the other", async () => {
    const workers: FakeRankWorker[] = [];
    const service = new QueryRankerService({
      workerFactory: () => {
        const worker = new FakeRankWorker();
        workers.push(worker);
        return worker as unknown as Worker;
      },
      idleReleaseMs: 5,
    });

    const clientA = service.rank(rankPayload("a"), "search-page-a");
    const clientB = service.rank(rankPayload("b"), "search-page-b");

    expect(workers).toHaveLength(2);
    expect(workers[0].terminated).toBe(false);
    expect(workers[1].terminated).toBe(false);

    workers[1].respond(rankResult("result-b"));
    workers[0].respond(rankResult("result-a"));
    expect(await clientA).toEqual(rankResult("result-a"));
    expect(await clientB).toEqual(rankResult("result-b"));

    await Bun.sleep(10);
    expect(workers.every((worker) => worker.terminated)).toBe(true);
    expect(workers.every((worker) => worker.listenerCount("message") === 0)).toBe(true);
    expect(workers.every((worker) => worker.listenerCount("error") === 0)).toBe(true);
    expect((service as any).tasksByClient.size).toBe(0);
    expect((service as any).slots.size).toBe(0);
  });

  test("supersedes only the older request in the same client lane", async () => {
    const workers: FakeRankWorker[] = [];
    const service = new QueryRankerService({
      workerFactory: () => {
        const worker = new FakeRankWorker();
        workers.push(worker);
        return worker as unknown as Worker;
      },
      idleReleaseMs: 1000,
    });

    const olderA = service.rank(rankPayload("a-old"), "search-page-a");
    const olderAOutcome = olderA.then(
      () => "resolved",
      (error) => (error instanceof Error ? error.message : String(error))
    );
    const clientB = service.rank(rankPayload("b"), "search-page-b");
    const newerA = service.rank(rankPayload("a-new"), "search-page-a");

    expect(await olderAOutcome).toBe(RANK_REQUEST_SUPERSEDED);
    expect(workers).toHaveLength(3);
    expect(workers[0].terminated).toBe(true);
    expect(workers[0].listenerCount("message")).toBe(0);
    expect(workers[0].listenerCount("error")).toBe(0);
    expect(workers[1].terminated).toBe(false);
    expect(workers[2].terminated).toBe(false);

    // A retired worker cannot settle or reject the replacement lane.
    workers[0].respond(rankResult("stale-a"));
    workers[1].respond(rankResult("result-b"));
    workers[2].respond(rankResult("result-a-new"));
    expect(await clientB).toEqual(rankResult("result-b"));
    expect(await newerA).toEqual(rankResult("result-a-new"));

    service.dispose();
    expect(workers.every((worker) => worker.terminated)).toBe(true);
    expect((service as any).tasksByClient.size).toBe(0);
    expect((service as any).slots.size).toBe(0);
  });

  test("a timed-out client lane does not terminate another active client", async () => {
    const workers: FakeRankWorker[] = [];
    const service = new QueryRankerService({
      workerFactory: () => {
        const worker = new FakeRankWorker();
        workers.push(worker);
        return worker as unknown as Worker;
      },
      baseTimeoutMs: 5,
      maxTimeoutMs: 5,
      idleReleaseMs: 1000,
    });

    const clientA = service.rank(rankPayload("a-timeout"), "search-page-a");
    const clientAOutcome = clientA.then(
      () => "resolved",
      (error) => (error instanceof Error ? error.message : String(error))
    );
    const clientB = service.rank(rankPayload("b-success"), "search-page-b");
    workers[1].respond(rankResult("result-b"));

    expect(await clientB).toEqual(rankResult("result-b"));
    expect(await clientAOutcome).toContain("timed out after 5ms");
    expect(workers[0].terminated).toBe(true);
    expect(workers[1].terminated).toBe(false);
    expect((service as any).tasksByClient.size).toBe(0);

    service.dispose();
  });

  test("hard-caps active workers and starts queued clients as slots free", async () => {
    const workers: FakeRankWorker[] = [];
    const service = new QueryRankerService({
      workerFactory: () => {
        const worker = new FakeRankWorker();
        workers.push(worker);
        return worker as unknown as Worker;
      },
      maxWorkers: 2,
      maxQueuedRequests: 2,
      idleReleaseMs: 1000,
    });

    const clientA = service.rank(rankPayload("a"), "search-page-a");
    const clientB = service.rank(rankPayload("b"), "search-page-b");
    const clientC = service.rank(rankPayload("c"), "search-page-c");

    expect(workers).toHaveLength(2);
    expect((service as any).slots.size).toBe(2);
    expect((service as any).queue).toHaveLength(1);
    expect(workers[0].requests).toHaveLength(1);
    expect(workers[1].requests).toHaveLength(1);

    workers[0].respond(rankResult("result-a"));
    expect(await clientA).toEqual(rankResult("result-a"));
    expect(workers).toHaveLength(2);
    expect(workers[0].requests).toHaveLength(2);
    expect((service as any).queue).toHaveLength(0);

    workers[1].respond(rankResult("result-b"));
    workers[0].respond(rankResult("result-c"), 1);
    expect(await clientB).toEqual(rankResult("result-b"));
    expect(await clientC).toEqual(rankResult("result-c"));
    expect(workers.length).toBeLessThanOrEqual(2);

    service.dispose();
  });

  test("replaces a queued request only within the same client", async () => {
    const workers: FakeRankWorker[] = [];
    const service = new QueryRankerService({
      workerFactory: () => {
        const worker = new FakeRankWorker();
        workers.push(worker);
        return worker as unknown as Worker;
      },
      maxWorkers: 1,
      maxQueuedRequests: 2,
      idleReleaseMs: 1000,
    });

    const clientA = service.rank(rankPayload("a"), "search-page-a");
    const olderB = service.rank(rankPayload("b-old"), "search-page-b");
    const olderBOutcome = olderB.then(
      () => "resolved",
      (error) => (error instanceof Error ? error.message : String(error))
    );
    const newerB = service.rank(rankPayload("b-new"), "search-page-b");

    expect(await olderBOutcome).toBe(RANK_REQUEST_SUPERSEDED);
    expect(workers).toHaveLength(1);
    expect((service as any).queue).toHaveLength(1);
    expect((service as any).queue[0].payload.queryHash).toBe("b-new");
    expect(workers[0].terminated).toBe(false);

    workers[0].respond(rankResult("result-a"));
    expect(await clientA).toEqual(rankResult("result-a"));
    expect(workers[0].requests).toHaveLength(2);
    workers[0].respond(rankResult("result-b-new"), 1);
    expect(await newerB).toEqual(rankResult("result-b-new"));

    service.dispose();
  });

  test("bounds the waiting queue and releases a queued payload on timeout", async () => {
    const workers: FakeRankWorker[] = [];
    const service = new QueryRankerService({
      workerFactory: () => {
        const worker = new FakeRankWorker();
        workers.push(worker);
        return worker as unknown as Worker;
      },
      maxWorkers: 1,
      maxQueuedRequests: 1,
      queueTimeoutMs: 5,
      idleReleaseMs: 1000,
    });

    const active = service.rank(rankPayload("active"), "search-page-active");
    const queued = service.rank(rankPayload("queued"), "search-page-queued");
    const queuedTask = (service as any).queue[0];
    const queuedOutcome = queued.then(
      () => "resolved",
      (error) => (error instanceof Error ? error.message : String(error))
    );
    const overflow = service.rank(rankPayload("overflow"), "search-page-overflow");
    const overflowOutcome = overflow.then(
      () => "resolved",
      (error) => (error instanceof Error ? error.message : String(error))
    );

    expect(await overflowOutcome).toContain("queue is full (1 waiting requests)");
    expect(workers).toHaveLength(1);
    expect((service as any).queue).toHaveLength(1);
    expect(await queuedOutcome).toContain("waited more than 5ms");
    expect((service as any).queue).toHaveLength(0);
    expect(queuedTask.payload).toBeNull();
    expect(queuedTask.queueTimer).toBeNull();
    expect(queuedTask.executionTimer).toBeNull();
    expect(queuedTask.state).toBe("settled");
    expect(workers[0].terminated).toBe(false);

    workers[0].respond(rankResult("active-result"));
    expect(await active).toEqual(rankResult("active-result"));
    service.dispose();
  });

  test("aborting an active request releases its worker without waiting for another rank call", async () => {
    const workers: FakeRankWorker[] = [];
    const service = new QueryRankerService({
      workerFactory: () => {
        const worker = new FakeRankWorker();
        workers.push(worker);
        return worker as unknown as Worker;
      },
      idleReleaseMs: 1000,
    });
    const abortController = new AbortController();
    const active = service.rank(rankPayload("a"), "search-page-a", abortController.signal);
    const activeOutcome = active.then(
      () => "resolved",
      (error) => (error instanceof Error ? error.message : String(error))
    );

    abortController.abort(new Error(RANK_REQUEST_SUPERSEDED));
    expect(await activeOutcome).toBe(RANK_REQUEST_SUPERSEDED);

    expect(workers).toHaveLength(1);
    expect(workers[0].terminated).toBe(true);
    expect(workers[0].listenerCount("message")).toBe(0);
    expect(workers[0].listenerCount("error")).toBe(0);
    expect((service as any).tasksByClient.size).toBe(0);
    expect((service as any).queue).toHaveLength(0);
    expect((service as any).slots.size).toBe(0);
  });
});
