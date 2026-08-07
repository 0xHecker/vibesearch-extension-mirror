import { expect, test } from "bun:test";
import { EmbeddingWorkerClient } from "@src/services/embedding-worker-client";

type Listener = (event: any) => void;

class FakeEmbeddingWorker {
  public sent: Array<{ requestId: number; priority: string }> = [];
  public terminateCount = 0;
  private listeners = new Map<string, Listener[]>();

  addEventListener(type: string, listener: Listener) {
    const current = this.listeners.get(type) || [];
    current.push(listener);
    this.listeners.set(type, current);
  }

  removeEventListener(type: string, listener: Listener) {
    const current = this.listeners.get(type) || [];
    this.listeners.set(type, current.filter((entry) => entry !== listener));
  }

  postMessage(message: { requestId: number; priority: string }) {
    this.sent.push(message);
  }

  terminate() {
    this.terminateCount += 1;
  }

  respond(requestId: number, vector: Float32Array) {
    for (const listener of this.listeners.get("message") || []) {
      listener({
        data: {
          type: "EMBEDDING_RESULT",
          requestId,
          payload: { buffer: vector.buffer },
        },
      });
    }
  }

  fail(message = "late worker failure") {
    for (const listener of this.listeners.get("error") || []) {
      listener({ message });
    }
  }

  listenerCount() {
    return Array.from(this.listeners.values()).reduce((total, entries) => total + entries.length, 0);
  }
}

test("EmbeddingWorkerClient serves an interactive query before queued background batches", async () => {
  const worker = new FakeEmbeddingWorker();
  const client = new EmbeddingWorkerClient(() => worker as unknown as Worker);

  const firstBackground = client.embed(["first"], "background");
  const queuedBackground = client.embed(["second"], "background");
  const interactive = client.embed(["search"], "interactive");

  expect(worker.sent.map((request) => request.priority)).toEqual(["background"]);

  worker.respond(1, new Float32Array([1]));
  await firstBackground;
  expect(worker.sent.map((request) => request.priority)).toEqual(["background", "interactive"]);

  worker.respond(3, new Float32Array([3]));
  await interactive;
  expect(worker.sent.map((request) => request.priority)).toEqual([
    "background",
    "interactive",
    "background",
  ]);

  worker.respond(2, new Float32Array([2]));
  await expect(queuedBackground).resolves.toEqual(new Float32Array([2]));
});

test("EmbeddingWorkerClient releases the model worker after an idle period", async () => {
  const workers: FakeEmbeddingWorker[] = [];
  const client = new EmbeddingWorkerClient(() => {
    const worker = new FakeEmbeddingWorker();
    workers.push(worker);
    return worker as unknown as Worker;
  }, 5);

  const first = client.embed(["first"], "interactive");
  workers[0].respond(1, new Float32Array([1]));
  await first;
  await Bun.sleep(20);

  expect(workers[0].terminateCount).toBe(1);
  expect(workers[0].listenerCount()).toBe(0);

  const second = client.embed(["second"], "interactive");
  expect(workers).toHaveLength(2);
  workers[1].respond(2, new Float32Array([2]));
  await expect(second).resolves.toEqual(new Float32Array([2]));
});

test("EmbeddingWorkerClient keeps the worker alive while queued work remains", async () => {
  const worker = new FakeEmbeddingWorker();
  const client = new EmbeddingWorkerClient(() => worker as unknown as Worker, 5);

  const first = client.embed(["first"], "background");
  const second = client.embed(["second"], "background");
  worker.respond(1, new Float32Array([1]));
  await first;
  await Bun.sleep(20);

  expect(worker.terminateCount).toBe(0);

  worker.respond(2, new Float32Array([2]));
  await second;
  await Bun.sleep(20);
  expect(worker.terminateCount).toBe(1);
});

test("EmbeddingWorkerClient removes an aborted queued interactive request", async () => {
  const worker = new FakeEmbeddingWorker();
  const client = new EmbeddingWorkerClient(() => worker as unknown as Worker);
  const controller = new AbortController();

  const activeBackground = client.embed(["background"], "background");
  const queuedInteractive = client.embed(["obsolete search"], "interactive", controller.signal);
  expect(worker.sent.map((request) => request.requestId)).toEqual([1]);

  controller.abort(new Error("search superseded"));
  await expect(queuedInteractive).rejects.toThrow("search superseded");
  worker.respond(1, new Float32Array([1]));
  await activeBackground;

  expect(worker.sent.map((request) => request.requestId)).toEqual([1]);
});

test("EmbeddingWorkerClient rejects an aborted active request but waits for inference to finish", async () => {
  const worker = new FakeEmbeddingWorker();
  const client = new EmbeddingWorkerClient(() => worker as unknown as Worker);
  const controller = new AbortController();

  const activeInteractive = client.embed(["obsolete search"], "interactive", controller.signal);
  const queuedBackground = client.embed(["background"], "background");
  controller.abort(new Error("search superseded"));

  await expect(activeInteractive).rejects.toThrow("search superseded");
  expect(worker.sent.map((request) => request.requestId)).toEqual([1]);

  worker.respond(1, new Float32Array([1]));
  expect(worker.sent.map((request) => request.requestId)).toEqual([1, 2]);
  worker.respond(2, new Float32Array([2]));
  await expect(queuedBackground).resolves.toEqual(new Float32Array([2]));
});

test("EmbeddingWorkerClient rotates a hung worker and continues queued work", async () => {
  const workers: FakeEmbeddingWorker[] = [];
  const client = new EmbeddingWorkerClient(() => {
    const worker = new FakeEmbeddingWorker();
    workers.push(worker);
    return worker as unknown as Worker;
  }, 1_000, 5);

  const hung = client.embed(["never responds"], "background");
  const queued = client.embed(["must continue"], "background");
  let queuedValue: Float32Array | undefined;
  void queued.then((value) => {
    queuedValue = value;
  });

  await expect(hung).rejects.toThrow("timed out after 5ms");
  expect(workers).toHaveLength(2);
  expect(workers[0].terminateCount).toBe(1);
  expect(workers[0].listenerCount()).toBe(0);
  expect(workers[1].sent.map((request) => request.requestId)).toEqual([2]);

  // Even a fake retired worker that can emit after terminate must not settle
  // or fail the replacement worker's active request.
  workers[0].respond(2, new Float32Array([99]));
  workers[0].fail();
  await Promise.resolve();
  expect(queuedValue).toBeUndefined();

  workers[1].respond(2, new Float32Array([2]));
  await expect(queued).resolves.toEqual(new Float32Array([2]));
  expect((client as any).activeTimer).toBeNull();
  await Bun.sleep(15);
  expect(workers[1].terminateCount).toBe(0);
});

test("EmbeddingWorkerClient watchdog recovers an aborted active request", async () => {
  const workers: FakeEmbeddingWorker[] = [];
  let markReplacementCreated!: () => void;
  const replacementCreated = new Promise<void>((resolve) => {
    markReplacementCreated = resolve;
  });
  const client = new EmbeddingWorkerClient(() => {
    const worker = new FakeEmbeddingWorker();
    workers.push(worker);
    if (workers.length === 2) markReplacementCreated();
    return worker as unknown as Worker;
  }, 1_000, 5);
  const controller = new AbortController();

  const abandoned = client.embed(["abandoned inference"], "interactive", controller.signal);
  const queued = client.embed(["background survives"], "background");
  controller.abort(new Error("search superseded"));

  await expect(abandoned).rejects.toThrow("search superseded");
  expect(workers[0].terminateCount).toBe(0);
  expect(workers[0].sent.map((request) => request.requestId)).toEqual([1]);

  await replacementCreated;
  expect(workers).toHaveLength(2);
  expect(workers[0].terminateCount).toBe(1);
  expect(workers[0].listenerCount()).toBe(0);
  expect(workers[1].sent.map((request) => request.requestId)).toEqual([2]);

  workers[1].respond(2, new Float32Array([2]));
  await expect(queued).resolves.toEqual(new Float32Array([2]));
  expect((client as any).activeTimer).toBeNull();
});
