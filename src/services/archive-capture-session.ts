import {
  PAGE_ARCHIVE_MAX_HTML_BYTES,
} from "./archive-capture-protocol";
import { ArchiveOutbox, type ArchiveOutboxWritable } from "./archive-outbox";

type CaptureSession = {
  id: string;
  itemId: string;
  tabId: number;
  sourceUrl: string;
  fileName: string;
  writer: ArchiveOutboxWritable;
  deadlineAt: number;
  expectedSequence: number;
  byteSize: number;
  settled: boolean;
};

export type ArchiveCaptureSessionManagerOptions = {
  outbox: ArchiveOutbox;
  now?: () => number;
  randomId?: () => string;
  maxHtmlBytes?: number;
};

const sameDocumentUrl = (left: string, right: string): boolean => {
  try {
    const a = new URL(left);
    const b = new URL(right);
    a.hash = "";
    b.hash = "";
    return a.toString() === b.toString();
  } catch {
    return false;
  }
};

export class ArchiveCaptureSessionManager {
  private readonly outbox: ArchiveOutbox;
  private readonly now: () => number;
  private readonly randomId: () => string;
  private readonly maxHtmlBytes: number;
  private readonly sessions = new Map<string, CaptureSession>();

  constructor(options: ArchiveCaptureSessionManagerOptions) {
    this.outbox = options.outbox;
    this.now = options.now ?? Date.now;
    this.randomId = options.randomId ?? (() => crypto.randomUUID());
    this.maxHtmlBytes = options.maxHtmlBytes ?? PAGE_ARCHIVE_MAX_HTML_BYTES;
  }

  async open(input: {
    itemId: string;
    tabId: number;
    sourceUrl: string;
    deadlineAt: number;
  }): Promise<{ sessionId: string; maxHtmlBytes: number }> {
    const sourceUrl = new URL(input.sourceUrl).toString();
    if (!/^https?:$/i.test(new URL(sourceUrl).protocol)) throw new Error("INVALID_ARCHIVE_SOURCE_URL");
    await this.cancelItem(input.itemId);
    const sessionId = this.randomId();
    const fileName = this.outbox.createFileName();
    const writer = await this.outbox.files.create(fileName);
    const session: CaptureSession = {
      id: sessionId,
      itemId: input.itemId,
      tabId: input.tabId,
      sourceUrl,
      fileName,
      writer,
      deadlineAt: input.deadlineAt,
      expectedSequence: 0,
      byteSize: 0,
      settled: false,
    };
    this.sessions.set(sessionId, session);
    return { sessionId, maxHtmlBytes: this.maxHtmlBytes };
  }

  isOpen(sessionId: string): boolean {
    return this.sessions.has(sessionId);
  }

  async append(sessionId: string, tabId: number, sequence: number, chunk: string): Promise<{ byteSize: number }> {
    const session = this.requireSession(sessionId, tabId);
    if (this.now() >= session.deadlineAt) throw new Error("ARCHIVE_CAPTURE_DEADLINE");
    if (sequence !== session.expectedSequence) throw new Error("ARCHIVE_CHUNK_OUT_OF_ORDER");
    if (typeof chunk !== "string" || chunk.length === 0) throw new Error("ARCHIVE_CHUNK_EMPTY");

    const bytes = new TextEncoder().encode(chunk);
    if (session.byteSize + bytes.byteLength > this.maxHtmlBytes) throw new Error("ARCHIVE_HTML_TOO_LARGE");
    await session.writer.write(bytes);
    session.byteSize += bytes.byteLength;
    session.expectedSequence += 1;
    return { byteSize: session.byteSize };
  }

  async finish(
    sessionId: string,
    tabId: number,
    input: { chunkCount: number; capturedUrl: string },
  ): Promise<{ byteSize: number }> {
    const session = this.requireSession(sessionId, tabId);
    if (this.now() >= session.deadlineAt) throw new Error("ARCHIVE_CAPTURE_DEADLINE");
    if (input.chunkCount !== session.expectedSequence) throw new Error("ARCHIVE_CHUNK_COUNT_MISMATCH");
    if (!sameDocumentUrl(input.capturedUrl, session.sourceUrl)) throw new Error("ARCHIVE_PAGE_NAVIGATED");
    if (session.byteSize < 20) throw new Error("ARCHIVE_CAPTURE_EMPTY");

    session.settled = true;
    this.sessions.delete(session.id);
    try {
      await session.writer.close();
      await this.outbox.enqueueUpload({
        itemId: session.itemId,
        sourceUrl: session.sourceUrl,
        fileName: session.fileName,
        byteSize: session.byteSize,
      });
    } catch (error) {
      await session.writer.abort().catch(() => {});
      await this.outbox.files.delete(session.fileName).catch(() => {});
      throw error;
    }
    return { byteSize: session.byteSize };
  }

  async abort(sessionId: string, tabId?: number): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session || (typeof tabId === "number" && session.tabId !== tabId)) return;
    session.settled = true;
    this.sessions.delete(session.id);
    await session.writer.abort().catch(() => {});
  }

  async cancelItem(itemId: string): Promise<void> {
    const matching = [...this.sessions.values()].filter((session) => session.itemId === itemId);
    await Promise.all(matching.map((session) => this.abort(session.id, session.tabId)));
  }

  private requireSession(sessionId: string, tabId: number): CaptureSession {
    const session = this.sessions.get(sessionId);
    if (!session || session.tabId !== tabId || session.settled) throw new Error("ARCHIVE_SESSION_NOT_FOUND");
    return session;
  }
}
