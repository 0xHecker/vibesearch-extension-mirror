import { expect, test } from "bun:test";
import { ArchiveCaptureSessionManager } from "@src/services/archive-capture-session";
import { ArchiveOutbox, type ArchiveOutboxFiles, type ArchiveOutboxJob } from "@src/services/archive-outbox";

const harness = (
  maxHtmlBytes = 1024,
  failClose = false,
  closeControl?: { started: () => void; release: Promise<void> },
) => {
  let jobs: ArchiveOutboxJob[] = [];
  const files = new Map<string, Blob>();
  let id = 0;
  let now = 100;
  const fileApi: ArchiveOutboxFiles = {
    async create(name) {
      const chunks: Uint8Array[] = [];
      let settled = false;
      return {
        async write(chunk) {
          if (settled) throw new Error("closed");
          chunks.push(chunk.slice());
        },
        async close() {
          if (failClose) throw new Error("OPFS_CLOSE_FAILED");
          closeControl?.started();
          if (closeControl) await closeControl.release;
          settled = true;
          files.set(name, new Blob(chunks));
        },
        async abort() {
          settled = true;
          files.delete(name);
        },
      };
    },
    async read(name) { return files.get(name) ?? null; },
    async delete(name) { files.delete(name); },
    async cleanup(keep) { for (const name of files.keys()) if (!keep.has(name)) files.delete(name); },
  };
  const outbox = new ArchiveOutbox({
    storage: {
      async read() { return structuredClone(jobs); },
      async write(next) { jobs = structuredClone(next); },
    },
    files: fileApi,
    ensureItem: async () => ({ ready: true }),
    getConnection: async () => ({ token: "", apiBase: "https://api.example" }),
    randomId: () => `id-${++id}`,
    now: () => now,
  });
  const sessions = new ArchiveCaptureSessionManager({
    outbox,
    maxHtmlBytes,
    randomId: () => `session-${++id}`,
    now: () => now,
  });
  return { outbox, files, sessions, setNow: (value: number) => { now = value; } };
};

test("capture session writes ordered UTF-8 chunks and atomically queues the completed file", async () => {
  const { outbox, files, sessions } = harness();
  await outbox.enqueueServerCapture("item-1", "https://example.com/page", { notBefore: 1_000 });
  const opened = await sessions.open({
    itemId: "item-1",
    tabId: 4,
    sourceUrl: "https://example.com/page#one",
    deadlineAt: 1_000,
  });
  await sessions.append(opened.sessionId, 4, 0, "<html>🙂");
  await sessions.append(opened.sessionId, 4, 1, "snapshot</html>");
  const result = await sessions.finish(opened.sessionId, 4, {
    chunkCount: 2,
    capturedUrl: "https://example.com/page#two",
  });

  expect(result.byteSize).toBe(new TextEncoder().encode("<html>🙂snapshot</html>").byteLength);
  const [job] = await outbox.list();
  expect(job).toMatchObject({ itemId: "item-1", mode: "upload", byteSize: result.byteSize });
  expect(await outbox.list()).toHaveLength(1);
  expect(await files.get(job.fileName!)?.text()).toBe("<html>🙂snapshot</html>");
  expect(sessions.isOpen(opened.sessionId)).toBe(false);
});

test("capture session rejects wrong tabs, out-of-order chunks, navigation, and total overflow", async () => {
  const { sessions } = harness(24);
  const opened = await sessions.open({
    itemId: "item-1",
    tabId: 4,
    sourceUrl: "https://example.com/page",
    deadlineAt: 1_000,
  });
  await expect(sessions.append(opened.sessionId, 3, 0, "abc")).rejects.toThrow("ARCHIVE_SESSION_NOT_FOUND");
  await expect(sessions.append(opened.sessionId, 4, 1, "abc")).rejects.toThrow("ARCHIVE_CHUNK_OUT_OF_ORDER");
  await sessions.append(opened.sessionId, 4, 0, "<html>valid</html>");
  await expect(
    sessions.finish(opened.sessionId, 4, { chunkCount: 1, capturedUrl: "https://example.com/other" }),
  ).rejects.toThrow("ARCHIVE_PAGE_NAVIGATED");
  await expect(sessions.append(opened.sessionId, 4, 1, "too-many-extra-bytes")).rejects.toThrow(
    "ARCHIVE_HTML_TOO_LARGE",
  );
  await sessions.abort(opened.sessionId, 4);
  expect(sessions.isOpen(opened.sessionId)).toBe(false);
});

test("opening a replacement capture cancels the previous temporary stream", async () => {
  const { sessions } = harness();
  const first = await sessions.open({
    itemId: "item-1",
    tabId: 4,
    sourceUrl: "https://example.com/page",
    deadlineAt: 1_000,
  });
  const second = await sessions.open({
    itemId: "item-1",
    tabId: 4,
    sourceUrl: "https://example.com/page",
    deadlineAt: 1_000,
  });
  expect(sessions.isOpen(first.sessionId)).toBe(false);
  expect(sessions.isOpen(second.sessionId)).toBe(true);
});

test("a failed OPFS commit removes the session and temporary file", async () => {
  const { outbox, files, sessions } = harness(1024, true);
  const opened = await sessions.open({
    itemId: "item-1",
    tabId: 4,
    sourceUrl: "https://example.com/page",
    deadlineAt: 1_000,
  });
  await sessions.append(opened.sessionId, 4, 0, "<html>snapshot payload</html>");

  await expect(
    sessions.finish(opened.sessionId, 4, { chunkCount: 1, capturedUrl: "https://example.com/page" }),
  ).rejects.toThrow("OPFS_CLOSE_FAILED");
  expect(sessions.isOpen(opened.sessionId)).toBe(false);
  expect(await outbox.list()).toEqual([]);
  expect(files.size).toBe(0);
});

test("a capture cannot commit after its deadline", async () => {
  const { outbox, sessions, setNow } = harness();
  const opened = await sessions.open({
    itemId: "item-1",
    tabId: 4,
    sourceUrl: "https://example.com/page",
    deadlineAt: 200,
  });
  await sessions.append(opened.sessionId, 4, 0, "<html>snapshot payload</html>");
  setNow(200);
  await expect(
    sessions.finish(opened.sessionId, 4, { chunkCount: 1, capturedUrl: "https://example.com/page" }),
  ).rejects.toThrow(
    "ARCHIVE_CAPTURE_DEADLINE",
  );
  await sessions.abort(opened.sessionId, 4);
  expect(await outbox.list()).toEqual([]);
});

test("cancelAll waits for a finishing capture and prevents it from resurrecting the outbox", async () => {
  let markCloseStarted!: () => void;
  let releaseClose!: () => void;
  const closeStarted = new Promise<void>((resolve) => {
    markCloseStarted = resolve;
  });
  const closeReleased = new Promise<void>((resolve) => {
    releaseClose = resolve;
  });
  const { outbox, files, sessions } = harness(1024, false, {
    started: markCloseStarted,
    release: closeReleased,
  });
  const opened = await sessions.open({
    itemId: "item-1",
    tabId: 4,
    sourceUrl: "https://example.com/page",
    deadlineAt: 1_000,
  });
  await sessions.append(opened.sessionId, 4, 0, "<html>snapshot payload</html>");

  const finishing = sessions.finish(opened.sessionId, 4, {
    chunkCount: 1,
    capturedUrl: "https://example.com/page",
  });
  await closeStarted;
  const cancelling = sessions.cancelAll();
  await Promise.resolve();
  releaseClose();

  await expect(finishing).rejects.toThrow("ARCHIVE_CAPTURE_CANCELLED");
  await cancelling;
  expect(await outbox.list()).toEqual([]);
  expect(files.size).toBe(0);
  expect(sessions.isOpen(opened.sessionId)).toBe(false);
});
