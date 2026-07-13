import { expect, test } from "bun:test";
import {
  ArchiveOutbox,
  archiveRetryDelayMs,
  normalizeArchiveOutbox,
  type ArchiveOutboxFiles,
  type ArchiveOutboxJob,
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
  now?: number;
  ensureReady?: boolean;
  fetcher?: typeof fetch;
  maxDiskBytes?: number;
  maxJobs?: number;
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
    getConnection: async () => ({ token: options.token ?? "token", apiBase: "https://api.example" }),
    ensureItem: async (itemId) => {
      ensured.push(itemId);
      return options.ensureReady === false ? { ready: false, reason: "still-queued" } : { ready: true };
    },
    fetcher: options.fetcher ?? (async () => Response.json({ ok: true })),
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

test("archive upload ensures its item first, uploads once, and deletes local bytes", async () => {
  const methods: string[] = [];
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
  });
  await harness.files.put("page.html", "<html><body>saved snapshot</body></html>");
  await harness.outbox.enqueueUpload({
    itemId: "item-1",
    sourceUrl: "https://example.com/page",
    fileName: "page.html",
    byteSize: 40,
  });

  const result = await harness.outbox.drain(1);
  expect(result).toMatchObject({ attempted: 1, uploaded: 1, remaining: 0 });
  expect(harness.ensured).toEqual(["item-1"]);
  expect(methods).toEqual(["PUT"]);
  expect(harness.files.files.has("page.html")).toBe(false);
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
