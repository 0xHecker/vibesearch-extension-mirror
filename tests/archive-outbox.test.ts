import { expect, test } from "bun:test";
import {
  ArchiveOutbox,
  ARCHIVE_CAPTURE_MAX_ATTEMPTS,
  ARCHIVE_SESSION_CAPTURE_MAX_ATTEMPTS,
  archiveRetryDelayMs,
  normalizeArchiveOutbox,
  readPendingArchiveUpload,
  type ArchiveOutboxFiles,
  type ArchiveOutboxJob,
  type ArchiveOutboxConnection,
  type ArchiveOutboxStorage,
} from "@src/services/archive-outbox";

class MemoryStorage implements ArchiveOutboxStorage {
  value: unknown = [];
  async read() {
    return structuredClone(this.value);
  }
  async write(jobs: ArchiveOutboxJob[]) {
    this.value = structuredClone(jobs);
  }
}

class MemoryFiles implements ArchiveOutboxFiles {
  files = new Map<string, Blob>();
  deleted: string[] = [];

  async put(name: string, body: string) {
    this.files.set(name, new Blob([body], { type: "text/html" }));
  }

  async create(fileName: string) {
    const chunks: Uint8Array[] = [];
    let settled = false;
    return {
      write: async (chunk: Uint8Array) => {
        if (settled) throw new Error("closed");
        chunks.push(chunk.slice());
      },
      close: async () => {
        settled = true;
        this.files.set(fileName, new Blob(chunks, { type: "text/html" }));
      },
      abort: async () => {
        settled = true;
        this.files.delete(fileName);
      },
    };
  }

  async read(fileName: string) {
    return this.files.get(fileName) ?? null;
  }

  async delete(fileName: string) {
    this.deleted.push(fileName);
    this.files.delete(fileName);
  }

  async cleanup(keep: Set<string>) {
    for (const name of this.files.keys()) if (!keep.has(name)) this.files.delete(name);
  }
}

const createHarness = (options: {
  token?: string;
  getConnection?: (forceRefresh?: boolean) => Promise<ArchiveOutboxConnection>;
  now?: number;
  ensureReady?: boolean;
  fetcher?: typeof fetch;
  maxDiskBytes?: number;
  maxJobs?: number;
  requestTimeoutMs?: number;
  retainUploadedArchive?: (itemId: string, body: Blob) => Promise<void>;
  isUploadedArchiveRetained?: (itemId: string, updatedAt: number, byteSize: number) => Promise<boolean>;
} = {}) => {
  const storage = new MemoryStorage();
  const files = new MemoryFiles();
  let now = options.now ?? 1_000;
  let id = 0;
  const ensured: string[] = [];
  const outbox = new ArchiveOutbox({
    storage,
    files,
    now: () => now,
    randomId: () => `id-${++id}`,
    maxDiskBytes: options.maxDiskBytes,
    maxJobs: options.maxJobs,
    requestTimeoutMs: options.requestTimeoutMs,
    getConnection: options.getConnection ?? (async () => ({
      token: options.token ?? "token",
      apiBase: "https://api.example",
    })),
    ensureItem: async (itemId) => {
      ensured.push(itemId);
      return options.ensureReady === false ? { ready: false, reason: "still-queued" } : { ready: true };
    },
    fetcher: options.fetcher ?? (async () => Response.json({ ok: true })),
    retainUploadedArchive: options.retainUploadedArchive,
    isUploadedArchiveRetained: options.isUploadedArchiveRetained ??
      (options.retainUploadedArchive ? async () => true : undefined),
  });
  return { storage, files, outbox, ensured, get now() { return now; }, set now(value: number) { now = value; } };
};

test("archive outbox normalizes 10,000 items in one pass and keeps the newest duplicate", () => {
  const rows = Array.from({ length: 10_000 }, (_, index) => ({
    id: `job-${index}`,
    itemId: `item-${index}`,
    mode: "capture",
    sourceUrl: `https://example.com/${index}`,
    byteSize: 0,
    createdAt: index,
    updatedAt: index,
    attempts: 0,
    nextAttemptAt: index,
  }));
  rows.push({ ...rows[5], id: "new-five", updatedAt: 20_000 });
  const normalized = normalizeArchiveOutbox(rows);

  expect(normalized).toHaveLength(10_000);
  expect(normalized.find((job) => job.itemId === "item-5")?.id).toBe("new-five");
});

test("archive outbox preserves the full shared opaque item identity", async () => {
  const itemId = ` item/${"x".repeat(480)} `;
  const harness = createHarness();

  await harness.outbox.enqueueServerCapture(itemId, "https://example.com/opaque");

  expect(await harness.outbox.list()).toMatchObject([{ itemId }]);
});

test("a completed local capture is readable before its cloud upload finishes", async () => {
  const harness = createHarness();
  const html = "<html><body>captured while offline</body></html>";
  await harness.files.put("offline.html", html);
  await harness.outbox.enqueueUpload({
    itemId: "item-offline",
    sourceUrl: "https://example.com/offline",
    fileName: "offline.html",
    byteSize: new Blob([html]).size,
  });

  const pending = await readPendingArchiveUpload(
    "item-offline",
    harness.storage,
    harness.files,
  );

  expect(await pending?.body.text()).toBe(html);
  expect(pending).toMatchObject({
    itemId: "item-offline",
    sourceUrl: "https://example.com/offline",
  });
});

test("archive outbox capacity rejects a new item without evicting accepted work", async () => {
  const harness = createHarness({ maxJobs: 2 });
  await harness.outbox.enqueueServerCapture("first", "https://example.com/first");
  await harness.outbox.enqueueServerCapture("second", "https://example.com/second");

  await expect(
    harness.outbox.enqueueServerCapture("third", "https://example.com/third"),
  ).rejects.toThrow("ARCHIVE_OUTBOX_CAPACITY");
  expect((await harness.outbox.list()).map((job) => job.itemId)).toEqual(["first", "second"]);
});

test("archive outbox capacity still permits a newer capture for the same item", async () => {
  const harness = createHarness({ maxJobs: 2 });
  await harness.outbox.enqueueServerCapture("first", "https://example.com/first");
  await harness.outbox.enqueueServerCapture("second", "https://example.com/second");
  harness.now += 1;

  await harness.outbox.enqueueServerCapture("first", "https://example.com/first-new");

  const jobs = await harness.outbox.list();
  expect(jobs).toHaveLength(2);
  expect(jobs.find((job) => job.itemId === "first")?.sourceUrl).toBe("https://example.com/first-new");
});

test("same-millisecond replacements still receive a strictly newer item version", async () => {
  const harness = createHarness({ now: 1_000 });
  const first = await harness.outbox.enqueueServerCapture("item-1", "https://example.com/old");
  const second = await harness.outbox.enqueueServerCapture("item-1", "https://example.com/new");

  expect(second.updatedAt).toBeGreaterThan(first.updatedAt);
  expect((await harness.outbox.list())[0].sourceUrl).toBe("https://example.com/new");
});

test("a delayed server fallback survives until a live capture replaces it", async () => {
  let fetchCalls = 0;
  const harness = createHarness({
    fetcher: async () => {
      fetchCalls += 1;
      return Response.json({ ok: true });
    },
  });
  await harness.outbox.enqueueServerCapture("item-1", "https://example.com/page", {
    notBefore: harness.now + 45_000,
  });

  expect(await harness.outbox.drain(1)).toMatchObject({ attempted: 0, reason: "not-due", remaining: 1 });
  expect(await harness.outbox.drainNow(1)).toMatchObject({ attempted: 0, reason: "not-due", remaining: 1 });
  expect(fetchCalls).toBe(0);

  await harness.files.put("page.html", "<html><body>live page snapshot</body></html>");
  await harness.outbox.enqueueUpload({
    itemId: "item-1",
    sourceUrl: "https://example.com/page",
    fileName: "page.html",
    byteSize: 44,
  });

  const [job] = await harness.outbox.list();
  expect(job).toMatchObject({ mode: "upload", fileName: "page.html", nextAttemptAt: harness.now });
});

test("archive retry backoff is bounded and respects Retry-After", () => {
  expect(archiveRetryDelayMs(0)).toBe(30_000);
  expect(archiveRetryDelayMs(3)).toBe(240_000);
  expect(archiveRetryDelayMs(99)).toBe(6 * 60 * 60 * 1000);
  expect(archiveRetryDelayMs(0, 120_000)).toBe(120_000);
});

test("archive upload retains offline bytes before deleting its outbox file", async () => {
  const methods: string[] = [];
  const retained: Array<{ itemId: string; html: string }> = [];
  const harness = createHarness({
    fetcher: async (_input, init) => {
      methods.push(init?.method || "GET");
      expect(init?.headers).toMatchObject({
        authorization: "Bearer token",
        "x-vs-archive-byte-size": "40",
        "x-vs-archive-source-url": "https://example.com/page",
      });
      expect(init?.body).toBeInstanceOf(Blob);
      return Response.json({ blob: { key: "archive/key" } });
    },
    retainUploadedArchive: async (itemId, body) => {
      retained.push({ itemId, html: await body.text() });
    },
  });
  await harness.files.put("page.html", "<html><body>saved snapshot</body></html>");
  await harness.outbox.enqueueUpload({
    itemId: "item-1",
    sourceUrl: "https://example.com/page",
    fileName: "page.html",
    byteSize: 40,
  });
  expect(retained).toEqual([
    { itemId: "item-1", html: "<html><body>saved snapshot</body></html>" },
  ]);

  const result = await harness.outbox.drain(1);
  expect(result).toMatchObject({ attempted: 1, uploaded: 1, remaining: 0 });
  expect(harness.ensured).toEqual(["item-1"]);
  expect(methods).toEqual(["PUT"]);
  expect(retained).toEqual([
    { itemId: "item-1", html: "<html><body>saved snapshot</body></html>" },
  ]);
  expect(harness.files.files.has("page.html")).toBe(false);
});

test("archive upload stays queued when the durable offline copy cannot be written", async () => {
  const harness = createHarness({
    retainUploadedArchive: async () => {
      throw new Error("OPFS quota exceeded");
    },
  });
  await harness.files.put("page.html", "<html><body>saved snapshot</body></html>");
  await harness.outbox.enqueueUpload({
    itemId: "item-1",
    sourceUrl: "https://example.com/page",
    fileName: "page.html",
    byteSize: 40,
  });

  const result = await harness.outbox.drain(1);

  expect(result).toMatchObject({ uploaded: 0, deferred: 1, remaining: 1 });
  expect(harness.files.files.has("page.html")).toBe(true);
});

test("an evicted retained copy is rechecked before its authoritative source is deleted", async () => {
  let retainCalls = 0;
  const harness = createHarness({
    retainUploadedArchive: async () => {
      retainCalls += 1;
      if (retainCalls > 1) throw new Error("ARCHIVE_CACHE_CAPACITY");
    },
    isUploadedArchiveRetained: async () => false,
  });
  await harness.files.put("page.html", "<html><body>saved snapshot payload</body></html>");
  await harness.outbox.enqueueUpload({
    itemId: "item-1",
    sourceUrl: "https://example.com/page",
    fileName: "page.html",
    byteSize: 48,
  });

  const result = await harness.outbox.drain(1);

  expect(result).toMatchObject({ uploaded: 0, deferred: 1, remaining: 1 });
  expect(harness.files.files.has("page.html")).toBe(true);
  expect(retainCalls).toBe(2);
});

test("archive upload remains durable when item sync is not ready", async () => {
  let fetchCalls = 0;
  const harness = createHarness({
    ensureReady: false,
    fetcher: async () => {
      fetchCalls += 1;
      return Response.json({});
    },
  });
  await harness.outbox.enqueueServerCapture("item-1", "https://example.com/page");

  const result = await harness.outbox.drain(1);
  const [job] = await harness.outbox.list();
  expect(result).toMatchObject({ deferred: 1, remaining: 1 });
  expect(fetchCalls).toBe(0);
  expect(job.attempts).toBe(1);
  expect(job.nextAttemptAt).toBeGreaterThan(harness.now);
});

test("missing auth leaves jobs untouched without incrementing attempts", async () => {
  const harness = createHarness({ token: "" });
  await harness.outbox.enqueueServerCapture("item-1", "https://example.com/page");

  const result = await harness.outbox.drain();
  expect(result).toMatchObject({ reason: "missing-token", attempted: 0, remaining: 1 });
  expect((await harness.outbox.list())[0].attempts).toBe(0);
  expect(harness.ensured).toEqual([]);
});

test("archive upload refreshes rejected auth once before deferring the job", async () => {
  const connectionRefreshes: boolean[] = [];
  const authorizationHeaders: string[] = [];
  const harness = createHarness({
    getConnection: async (forceRefresh) => {
      connectionRefreshes.push(forceRefresh === true);
      return {
        token: forceRefresh ? "fresh-token" : "stale-token",
        apiBase: "https://api.example",
      };
    },
    fetcher: async (_input, init) => {
      const headers = new Headers(init?.headers);
      authorizationHeaders.push(headers.get("authorization") || "");
      return authorizationHeaders.length === 1
        ? new Response("expired", { status: 401 })
        : Response.json({ blob: { key: "archive/key" } });
    },
  });
  await harness.outbox.enqueueServerCapture("item-1", "https://example.com/page");

  const result = await harness.outbox.drain(1);

  expect(result).toMatchObject({ attempted: 1, uploaded: 1, deferred: 0, remaining: 0 });
  expect(connectionRefreshes).toEqual([false, true]);
  expect(authorizationHeaders).toEqual(["Bearer stale-token", "Bearer fresh-token"]);
});

test("archive upload reports when refreshed auth is still rejected", async () => {
  const connectionRefreshes: boolean[] = [];
  let fetchCalls = 0;
  const harness = createHarness({
    getConnection: async (forceRefresh) => {
      connectionRefreshes.push(forceRefresh === true);
      return {
        token: forceRefresh ? "fresh-token" : "stale-token",
        apiBase: "https://api.example",
      };
    },
    fetcher: async () => {
      fetchCalls += 1;
      return new Response("expired", { status: 401 });
    },
  });
  await harness.outbox.enqueueServerCapture("item-1", "https://example.com/page");

  const result = await harness.outbox.drain(1);

  expect(result).toMatchObject({
    attempted: 1,
    uploaded: 0,
    deferred: 1,
    remaining: 1,
    reason: "auth-required",
  });
  expect(connectionRefreshes).toEqual([false, true]);
  expect(fetchCalls).toBe(2);
});

test("an explicit drain-now retries a deferred archive without waiting for backoff", async () => {
  let acceptUpload = false;
  let fetchCalls = 0;
  const harness = createHarness({
    fetcher: async () => {
      fetchCalls += 1;
      return acceptUpload
        ? Response.json({ blob: { key: "archive/key" } })
        : new Response("expired", { status: 401 });
    },
  });
  await harness.outbox.enqueueServerCapture("item-1", "https://example.com/page");
  expect(await harness.outbox.drain(1)).toMatchObject({
    attempted: 1,
    deferred: 1,
    reason: "auth-required",
    remaining: 1,
  });
  expect((await harness.outbox.list())[0].nextAttemptAt).toBeGreaterThan(harness.now);
  acceptUpload = true;

  const result = await harness.outbox.drainNow(1);

  expect(result).toMatchObject({ attempted: 1, uploaded: 1, remaining: 0 });
  // One request per drain: a refresh that returns the very same identity is not
  // retried, because repeating it would be refused identically.
  expect(fetchCalls).toBe(2);
});

test("404 keeps an upload for retry instead of losing it", async () => {
  const harness = createHarness({ fetcher: async () => new Response("missing", { status: 404 }) });
  await harness.files.put("page.html", "<html><body>saved snapshot</body></html>");
  await harness.outbox.enqueueUpload({
    itemId: "item-1",
    sourceUrl: "https://example.com/page",
    fileName: "page.html",
    byteSize: 40,
  });

  const result = await harness.outbox.drain(1);
  const [job] = await harness.outbox.list();
  expect(result).toMatchObject({ deferred: 1, remaining: 1 });
  expect(job.mode).toBe("upload");
  expect(job.attempts).toBe(1);
  expect(harness.files.files.has("page.html")).toBe(true);
});

test("a stalled error body times out without losing the queued archive", async () => {
  const harness = createHarness({
    requestTimeoutMs: 20,
    fetcher: async () => new Response(new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('{"error":"partial'));
      },
    }), { status: 500, headers: { "content-type": "application/json" } }),
  });
  await harness.outbox.enqueueServerCapture("item-1", "https://example.com/page");

  const result = await harness.outbox.drain(1);
  const [job] = await harness.outbox.list();

  expect(result).toMatchObject({ deferred: 1, remaining: 1 });
  expect(job.lastError).toBe("ARCHIVE_REQUEST_TIMEOUT");
});

test("an oversized archive error response is bounded and remains retryable", async () => {
  const harness = createHarness({
    fetcher: async () => new Response("x", {
      status: 500,
      headers: { "content-length": String(70 * 1024) },
    }),
  });
  await harness.outbox.enqueueServerCapture("item-1", "https://example.com/page");

  await harness.outbox.drain(1);

  expect((await harness.outbox.list())[0].lastError).toBe("ARCHIVE_ERROR_RESPONSE_TOO_LARGE");
});

test("invalid or oversized client archive automatically falls back to server capture", async () => {
  const methods: string[] = [];
  const harness = createHarness({
    fetcher: async (_input, init) => {
      methods.push(init?.method || "GET");
      return init?.method === "PUT"
        ? Response.json({ error: "archive too large" }, { status: 413 })
        : Response.json({ blob: { key: "server/archive" } });
    },
  });
  await harness.files.put("page.html", "<html><body>saved snapshot</body></html>");
  await harness.outbox.enqueueUpload({
    itemId: "item-1",
    sourceUrl: "https://example.com/page",
    fileName: "page.html",
    byteSize: 40,
  });

  const result = await harness.outbox.drain(2);
  expect(result).toMatchObject({ convertedToServerCapture: 1, uploaded: 1, remaining: 0 });
  expect(methods).toEqual(["PUT", "POST"]);
  expect(harness.files.files.has("page.html")).toBe(false);
});

test("a missing OPFS file falls back to server capture", async () => {
  const methods: string[] = [];
  const harness = createHarness({
    fetcher: async (_input, init) => {
      methods.push(init?.method || "GET");
      return Response.json({ ok: true });
    },
  });
  await harness.outbox.enqueueUpload({
    itemId: "item-1",
    sourceUrl: "https://example.com/page",
    fileName: "missing.html",
    byteSize: 40,
  });

  const result = await harness.outbox.drain(2);
  expect(result).toMatchObject({ convertedToServerCapture: 1, uploaded: 1, remaining: 0 });
  expect(methods).toEqual(["POST"]);
});

test("an old in-flight success cannot clear a newer archive for the same item", async () => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const harness = createHarness({
    fetcher: async () => {
      await gate;
      return Response.json({ ok: true });
    },
  });
  await harness.files.put("old.html", "<html><body>old snapshot payload</body></html>");
  await harness.outbox.enqueueUpload({
    itemId: "item-1",
    sourceUrl: "https://example.com/page",
    fileName: "old.html",
    byteSize: 40,
  });
  const draining = harness.outbox.drain(1);
  await new Promise((resolve) => setTimeout(resolve, 0));

  await harness.files.put("new.html", "<html><body>new snapshot payload</body></html>");
  await harness.outbox.enqueueUpload({
    itemId: "item-1",
    sourceUrl: "https://example.com/page",
    fileName: "new.html",
    byteSize: 40,
  });
  release();
  await draining;

  const jobs = await harness.outbox.list();
  expect(jobs).toHaveLength(1);
  expect(jobs[0].fileName).toBe("new.html");
  expect(harness.files.files.has("new.html")).toBe(true);
});

test("clearing during an in-flight upload cannot resurrect cached or queued bytes", async () => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let retainCalls = 0;
  const harness = createHarness({
    fetcher: async () => {
      await gate;
      return Response.json({ ok: true });
    },
    retainUploadedArchive: async () => {
      retainCalls += 1;
      if (retainCalls === 1) throw new Error("initial cache unavailable");
    },
  });
  await harness.files.put("page.html", "<html><body>saved snapshot payload</body></html>");
  await harness.outbox.enqueueUpload({
    itemId: "item-1",
    sourceUrl: "https://example.com/page",
    fileName: "page.html",
    byteSize: 48,
  });
  const draining = harness.outbox.drain(1);
  await new Promise((resolve) => setTimeout(resolve, 0));

  await harness.outbox.clear();
  release();
  await draining;

  expect(await harness.outbox.list()).toEqual([]);
  expect(harness.files.files.size).toBe(0);
  expect(retainCalls).toBe(1);
});

test("clearing aborts an archive request that is already on the wire", async () => {
  let markFetchStarted!: () => void;
  const fetchStarted = new Promise<void>((resolve) => {
    markFetchStarted = resolve;
  });
  let requestAborted = false;
  const harness = createHarness({
    fetcher: async (_input, init) => {
      markFetchStarted();
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => {
          requestAborted = true;
          reject(new DOMException("aborted", "AbortError"));
        }, { once: true });
      });
    },
  });
  await harness.outbox.enqueueServerCapture("item-1", "https://example.com/page");

  const draining = harness.outbox.drain(1);
  await fetchStarted;
  await harness.outbox.clear();
  await draining;

  expect(requestAborted).toBe(true);
  expect(await harness.outbox.list()).toEqual([]);
  expect(harness.files.files.size).toBe(0);
});

test("permanently discarding an item aborts its in-flight archive upload", async () => {
  let markFetchStarted!: () => void;
  const fetchStarted = new Promise<void>((resolve) => {
    markFetchStarted = resolve;
  });
  let requestAborted = false;
  const harness = createHarness({
    fetcher: async (_input, init) => {
      markFetchStarted();
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => {
          requestAborted = true;
          reject(new DOMException("aborted", "AbortError"));
        }, { once: true });
      });
    },
  });
  await harness.files.put("page.html", "<html><body>private archived page</body></html>");
  await harness.outbox.enqueueUpload({
    itemId: "item-1",
    sourceUrl: "https://example.com/page",
    fileName: "page.html",
    byteSize: 48,
  });

  const draining = harness.outbox.drain(1);
  await fetchStarted;
  await harness.outbox.discardItem("item-1");
  await draining;

  expect(requestAborted).toBe(true);
  expect(await harness.outbox.list()).toEqual([]);
  expect(harness.files.files.has("page.html")).toBe(false);
});

test("discarding during file preflight cannot start the purged upload with a replacement signal", async () => {
  let fetchCalls = 0;
  const harness = createHarness({
    fetcher: async () => {
      fetchCalls += 1;
      return Response.json({ ok: true });
    },
  });
  await harness.files.put("page.html", "<html><body>private archived page</body></html>");
  await harness.outbox.enqueueUpload({
    itemId: "item-1",
    sourceUrl: "https://example.com/page",
    fileName: "page.html",
    byteSize: 48,
  });

  let markReadStarted!: () => void;
  let releaseRead!: () => void;
  const readStarted = new Promise<void>((resolve) => {
    markReadStarted = resolve;
  });
  const readReleased = new Promise<void>((resolve) => {
    releaseRead = resolve;
  });
  const originalRead = harness.files.read.bind(harness.files);
  harness.files.read = async (fileName) => {
    const body = await originalRead(fileName);
    markReadStarted();
    await readReleased;
    return body;
  };

  const draining = harness.outbox.drain(1);
  await readStarted;
  await harness.outbox.discardItem("item-1");
  releaseRead();
  await draining;

  expect(fetchCalls).toBe(0);
  expect(await harness.outbox.list()).toEqual([]);
  expect(harness.files.files.has("page.html")).toBe(false);
});

test("disk pressure downgrades oldest local HTML to a lightweight server-capture intent", async () => {
  const harness = createHarness({ maxDiskBytes: 50 });
  await harness.files.put("first.html", "x".repeat(30));
  await harness.outbox.enqueueUpload({
    itemId: "first",
    sourceUrl: "https://example.com/first",
    fileName: "first.html",
    byteSize: 30,
  });
  harness.now += 1;
  await harness.files.put("second.html", "y".repeat(30));
  await harness.outbox.enqueueUpload({
    itemId: "second",
    sourceUrl: "https://example.com/second",
    fileName: "second.html",
    byteSize: 30,
  });

  const jobs = await harness.outbox.list();
  expect(jobs.map((job) => [job.itemId, job.mode])).toEqual([
    ["first", "capture"],
    ["second", "upload"],
  ]);
  expect(harness.files.files.has("first.html")).toBe(false);
  expect(harness.files.files.has("second.html")).toBe(true);
});

test("login-less drains upload with the device key and a source url", async () => {
  const requests: Array<{ url: string; init?: RequestInit }> = [];
  const harness = createHarness({
    token: "",
    getConnection: async () => ({
      token: "",
      apiBase: "https://api.example",
      deviceKey: "device-secret-123",
    }),
    fetcher: async (input, init) => {
      requests.push({ url: String(input), init });
      return Response.json({ blob: { key: "archive/anon/key" } });
    },
  });
  await harness.outbox.enqueueServerCapture("anon-item-1", "https://example.com/page");

  const result = await harness.outbox.drain(1);

  expect(result).toMatchObject({ attempted: 1, uploaded: 1, deferred: 0, remaining: 0 });
  expect(requests).toHaveLength(1);
  expect(requests[0].url).toBe("https://api.example/v1/items/anon-item-1/archive");
  const headers = new Headers(requests[0].init?.headers);
  expect(headers.get("x-vs-device-key")).toBe("device-secret-123");
  expect(headers.get("authorization")).toBeNull();
  // Server-capture stubs need the source URL to anchor the anonymous item.
  expect(headers.get("x-vs-archive-source-url")).toBe("https://example.com/page");
});

test("server captures become terminal and manually recoverable after the attempt cap", async () => {
  let postCount = 0;
  const harness = createHarness({
    ensureReady: true,
    fetcher: async (_input, init) => {
      if ((init?.method ?? "GET") === "POST") {
        postCount += 1;
        return new Response(JSON.stringify({ error: "login wall" }), { status: 502 });
      }
      return Response.json({});
    },
  });
  await harness.outbox.enqueueServerCapture("item-capped", "https://example.com/walled");

  // Drain repeatedly past the cap; each drain attempts at most one job.
  for (let round = 0; round < 12; round += 1) {
    await harness.outbox.drain(1);
    const job = (await harness.outbox.list()).find((candidate) => candidate.itemId === "item-capped");
    if (!job) break;
    // Force the stored retry window due again for the next round.
    await harness.outbox.drainNow(1);
  }

  const job = (await harness.outbox.list()).find((candidate) => candidate.itemId === "item-capped");
  expect(job).toMatchObject({
    terminal: true,
    attempts: ARCHIVE_CAPTURE_MAX_ATTEMPTS,
  });
  expect(job?.lastError).toContain("This site could not be captured");
  expect(postCount).toBe(ARCHIVE_CAPTURE_MAX_ATTEMPTS);

  // A deliberate retry replaces the terminal record and starts clean.
  await harness.outbox.enqueueServerCapture("item-capped", "https://example.com/walled");
  expect(await harness.outbox.list()).toMatchObject([{
    itemId: "item-capped",
    attempts: 0,
  }]);
  expect((await harness.outbox.list())[0].terminal).toBeUndefined();
});

test("a target only this browser can reach never reaches the capture service", async () => {
  const requests: string[] = [];
  const harness = createHarness({
    ensureReady: true,
    fetcher: async (input, init) => {
      requests.push(`${init?.method ?? "GET"} ${String(input)}`);
      // The API answers an unusable stub target with exactly this rejection.
      return new Response(JSON.stringify({ error: "missing archive source url" }), { status: 400 });
    },
  });
  await harness.outbox.enqueueServerCapture("item-local", "http://localhost:5173/dashboard");

  const result = await harness.outbox.drain(1);

  expect(requests).toEqual([]);
  expect(result).toMatchObject({ attempted: 1, terminal: 1, remaining: 1 });
  const job = (await harness.outbox.list())[0];
  expect(job).toMatchObject({ terminal: true, attempts: 0 });
  expect(job.lastError).toContain("only reachable from your browser");
  expect(job.lastError).not.toContain("8 attempts");
  expect(job.lastError).not.toContain("missing archive source url");
});

test("a terminal capture is claimed a bounded number of times", async () => {
  const harness = createHarness({
    ensureReady: true,
    fetcher: async () => new Response("{}", { status: 400 }),
  });
  await harness.outbox.enqueueServerCapture("item-session", "http://localhost:5173/dashboard");
  await harness.outbox.drain(1);

  // Each claim opens a tab, so the budget is spent one attempt at a time...
  for (let attempt = 1; attempt <= ARCHIVE_SESSION_CAPTURE_MAX_ATTEMPTS; attempt += 1) {
    const claimed = await harness.outbox.claimSessionCaptureCandidates(1);
    expect(claimed.map((job) => job.itemId)).toEqual(["item-session"]);
    expect(claimed[0].sourceUrl).toBe("http://localhost:5173/dashboard");
    expect(claimed[0].sessionCaptureAttempts).toBe(attempt);
  }
  // ...and never beyond it.
  expect(await harness.outbox.claimSessionCaptureCandidates(1)).toEqual([]);

  // A re-queued capture for the same item inherits the spent budget instead of
  // earning a fresh tab on every drain.
  harness.now += 1;
  await harness.outbox.enqueueServerCapture("item-session", "http://localhost:5173/dashboard");
  await harness.outbox.drain(1);
  expect(await harness.outbox.claimSessionCaptureCandidates(1)).toEqual([]);
});

test("a row stranded terminal by an earlier session is still claimed", async () => {
  const harness = createHarness({ ensureReady: true });
  // Written by a build that had no browser-session fallback: terminal, with the
  // old attempt-cap error text and no escalation budget recorded.
  harness.storage.value = [{
    id: "legacy-job",
    itemId: "item-stranded",
    mode: "capture",
    sourceUrl: "https://walled.example.com/article",
    byteSize: 0,
    createdAt: 900,
    updatedAt: 900,
    attempts: ARCHIVE_CAPTURE_MAX_ATTEMPTS,
    nextAttemptAt: Number.MAX_SAFE_INTEGER,
    lastError: "This site could not be captured after 8 attempts. missing archive source url",
    terminal: true,
  }];

  const claimed = await harness.outbox.claimSessionCaptureCandidates(1);

  expect(claimed.map((job) => job.itemId)).toEqual(["item-stranded"]);
  // A row whose budget was already spent by an older build must still get a
  // retry once the recovery path itself is fixed.
  harness.storage.value = [{
    ...(harness.storage.value as Array<Record<string, unknown>>)[0],
    sessionCaptureAttempts: 1,
  }];
  expect((await harness.outbox.claimSessionCaptureCandidates(1)).map((job) => job.itemId))
    .toEqual(["item-stranded"]);

  // Once fully spent, polling must not rewrite storage.
  expect(await harness.outbox.claimSessionCaptureCandidates(1)).toEqual([]);
  const before = structuredClone(harness.storage.value);
  expect(await harness.outbox.claimSessionCaptureCandidates(1)).toEqual([]);
  expect(harness.storage.value).toEqual(before);
});

test("a refused token falls back to the device key instead of parking for 15 minutes", async () => {
  // The state a signed-in install lands in when its session dies: the bearer
  // token is refused and cannot be refreshed, while the device key remains a
  // working identity for archive routes.
  const attempts: string[] = [];
  const harness = createHarness({
    ensureReady: true,
    getConnection: async (forceRefresh = false) => ({
      // A forced refresh after the refusal yields no token, exactly as
      // cloud-auth does once it records the rejection.
      token: forceRefresh ? "" : "dead-token",
      apiBase: "https://api.example",
      deviceKey: "device-secret-123",
    }),
    fetcher: async (_input, init) => {
      const headers = new Headers(init?.headers);
      const asBearer = Boolean(headers.get("authorization"));
      attempts.push(asBearer ? "bearer" : "device-key");
      return asBearer
        ? new Response(JSON.stringify({ error: "unauthorized" }), { status: 401 })
        : Response.json({ ok: true });
    },
  });
  await harness.files.put("page.html", "<html><body>a saved page</body></html>");
  await harness.outbox.enqueueUpload({
    itemId: "item-dead-session",
    sourceUrl: "https://example.com/page",
    fileName: "page.html",
    byteSize: 38,
  });

  const result = await harness.outbox.drain(1);

  // The refused bearer attempt is retried as the device and the upload lands,
  // instead of the job waiting for a reconnect that is not required.
  expect(result).toMatchObject({ uploaded: 1, remaining: 0 });
  expect(attempts).toEqual(["bearer", "device-key"]);
  // The rescue must not hide the fact that the session itself is dead.
  expect(result.tokenRejected).toBe(true);
});

test("a refused token defers briefly, not for 15 minutes, when a device key exists", async () => {
  const harness = createHarness({
    ensureReady: true,
    getConnection: async () => ({
      token: "dead-token",
      apiBase: "https://api.example",
      deviceKey: "device-secret-123",
    }),
    fetcher: async () => new Response(JSON.stringify({ error: "unauthorized" }), { status: 401 }),
  });
  await harness.files.put("page.html", "<html><body>a saved page</body></html>");
  await harness.outbox.enqueueUpload({
    itemId: "item-short-backoff",
    sourceUrl: "https://example.com/page",
    fileName: "page.html",
    byteSize: 38,
  });

  const result = await harness.outbox.drain(1);

  expect(result).toMatchObject({ deferred: 1 });
  const deferred = (await harness.outbox.list())[0];
  expect(deferred.nextAttemptAt - harness.now).toBeLessThanOrEqual(60_000);
});

test("a refused token with no device key still waits for the user to reconnect", async () => {
  const harness = createHarness({
    ensureReady: true,
    getConnection: async () => ({ token: "dead-token", apiBase: "https://api.example" }),
    fetcher: async () => new Response(JSON.stringify({ error: "unauthorized" }), { status: 401 }),
  });
  await harness.files.put("page.html", "<html><body>a saved page</body></html>");
  await harness.outbox.enqueueUpload({
    itemId: "item-no-device-key",
    sourceUrl: "https://example.com/page",
    fileName: "page.html",
    byteSize: 38,
  });

  const result = await harness.outbox.drain(1);

  expect(result).toMatchObject({ deferred: 1, reason: "auth-required" });
  expect((await harness.outbox.list())[0].nextAttemptAt - harness.now)
    .toBeGreaterThanOrEqual(15 * 60 * 1000);
});

test("a sync backlog never makes a capturable page look uncapturable", async () => {
  // Readiness failures and network errors defer the job. They must not spend the
  // remote cap, or a public page gets declared uncapturable and blamed.
  let posts = 0;
  const harness = createHarness({
    ensureReady: false,
    fetcher: async () => {
      posts += 1;
      return Response.json({ ok: true });
    },
  });
  await harness.outbox.enqueueServerCapture("item-backlog", "https://example.com/article");

  for (let round = 0; round < 12; round += 1) {
    await harness.outbox.drainNow(1);
  }

  expect(posts).toBe(0);
  const job = (await harness.outbox.list())[0];
  expect(job.terminal).toBeUndefined();
  expect(job.remoteAttempts ?? 0).toBe(0);
  expect(job.attempts).toBeGreaterThan(0);
});

test("a local-only page keeps its offline snapshot when the cloud refuses the target", async () => {
  const retained: string[] = [];
  const harness = createHarness({
    ensureReady: true,
    retainUploadedArchive: async (itemId) => {
      retained.push(itemId);
    },
    fetcher: async (_input, init) =>
      (init?.method ?? "GET") === "PUT"
        ? new Response(JSON.stringify({ error: "missing archive source url" }), { status: 400 })
        : Response.json({ ok: true }),
  });
  await harness.files.put("local.html", "<html>dev server</html>");
  await harness.outbox.enqueueUpload({
    itemId: "item-dev",
    sourceUrl: "http://localhost:5173/dashboard",
    fileName: "local.html",
    byteSize: 23,
  });

  const result = await harness.outbox.drain(1);

  expect(retained).toEqual(["item-dev"]);
  expect(result).toMatchObject({
    attempted: 1,
    retainedLocally: 1,
    convertedToServerCapture: 0,
    remaining: 0,
  });
  expect(await harness.outbox.list()).toEqual([]);
});
