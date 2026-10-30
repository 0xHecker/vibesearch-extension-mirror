import { requireLegacyCloud } from "@src/services/extension-policy";
import type { CloudConnectionLifetime } from "./cloud-auth";
import { assertCloudConnectionCurrent, CloudConnectionRetiredError, getArchiveCloudConnection } from "./cloud-connection";
import { withOpfsMutationLock } from "./media-storage";
import { collectArchiveItemIds, normalizeArchiveItemId } from "./archive-identity";
import { isServerCapturableArchiveUrl } from "./archive-resource-url";

export const ARCHIVE_OUTBOX_STORAGE_KEY = "vibesearch:archiveOutbox:v1";
export const ARCHIVE_OUTBOX_ALARM_NAME = "archive-outbox-alarm";
export const ARCHIVE_OUTBOX_DIRECTORY = "archive-outbox-v1";
export const ARCHIVE_OUTBOX_MAX_FILE_BYTES = 24 * 1024 * 1024;
export const ARCHIVE_OUTBOX_MAX_DISK_BYTES = 256 * 1024 * 1024;
export const ARCHIVE_OUTBOX_MAX_JOBS = 20_000;
export const ARCHIVE_OUTBOX_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;
export const ARCHIVE_OUTBOX_DRAIN_LIMIT = 2;
/** Server captures burn Browser Run minutes; give up after this many tries. */
export const ARCHIVE_CAPTURE_MAX_ATTEMPTS = 8;
/**
 * A terminal server capture is retried from the user's own browser session.
 * That fallback opens a temporary tab, so it stays strictly bounded per queued
 * job instead of running on every drain. Two attempts, because the first can be
 * lost to a transient condition (a tab that cannot answer yet, a page still
 * loading) rather than to the page being genuinely uncapturable.
 */
export const ARCHIVE_SESSION_CAPTURE_MAX_ATTEMPTS = 2;
/** Marker error for a target the archiving service can never fetch. */
export const ARCHIVE_CAPTURE_URL_NOT_PUBLIC = "ARCHIVE_CAPTURE_URL_NOT_PUBLIC";

export type ArchiveOutboxJob = {
  id: string;
  itemId: string;
  mode: "upload" | "capture";
  sourceUrl: string;
  fileName?: string;
  byteSize: number;
  createdAt: number;
  updatedAt: number;
  attempts: number;
  nextAttemptAt: number;
  lastError?: string;
  locallyRetained?: boolean;
  /** A bounded server capture exhausted retries and now waits for explicit user action. */
  terminal?: true;
  /** How many times the browser-session fallback has been started for this item. */
  sessionCaptureAttempts?: number;
  /**
   * Attempts where the archiving service actually answered. The remote cap must
   * count only these: a sync backlog or a flaky connection is not the site
   * refusing to be captured.
   */
  remoteAttempts?: number;
};

export type ArchiveOutboxConnection = CloudConnectionLifetime & {
  token: string;
  apiBase: string;
  /** Login-less identity: uploads land in the anonymous per-device namespace. */
  deviceKey?: string;
};

export type ArchiveItemReadiness = {
  ready: boolean;
  reason?: string;
  retryAfterMs?: number;
};

export type ArchiveOutboxStorage = {
  read(): Promise<unknown>;
  write(jobs: ArchiveOutboxJob[]): Promise<void>;
};

export type ArchiveOutboxWritable = {
  write(chunk: Uint8Array): Promise<void>;
  close(): Promise<void>;
  abort(): Promise<void>;
};

export type ArchiveOutboxFiles = {
  create(fileName: string): Promise<ArchiveOutboxWritable>;
  read(fileName: string): Promise<File | Blob | null>;
  delete(fileName: string): Promise<void>;
  cleanup(keepFileNames: Set<string>): Promise<void>;
};

export type ArchiveOutboxOptions = {
  storage: ArchiveOutboxStorage;
  files: ArchiveOutboxFiles;
  ensureItem: (itemId: string) => Promise<ArchiveItemReadiness>;
  getConnection?: (forceRefresh?: boolean) => Promise<ArchiveOutboxConnection>;
  fetcher?: typeof fetch;
  now?: () => number;
  randomId?: () => string;
  maxDiskBytes?: number;
  maxJobs?: number;
  maxAgeMs?: number;
  requestTimeoutMs?: number;
  retainUploadedArchive?: (itemId: string, body: Blob, updatedAt: number) => Promise<void>;
  retainUploadedArchiveWithinMutationLock?: (
    itemId: string,
    body: Blob,
    updatedAt: number,
  ) => Promise<void>;
  isUploadedArchiveRetained?: (
    itemId: string,
    updatedAt: number,
    byteSize: number,
  ) => Promise<boolean>;
};

export type ArchiveOutboxDrainResult = {
  attempted: number;
  uploaded: number;
  deferred: number;
  convertedToServerCapture: number;
  discarded: number;
  terminal: number;
  /** Snapshots kept in the offline cache after the cloud refused the target. */
  retainedLocally: number;
  /**
   * The API refused a bearer-token request during this drain. Reported even when
   * a fallback identity later succeeded, so a dead session cannot hide behind a
   * successful device-key upload.
   */
  tokenRejected: boolean;
  remaining: number;
  reason?: "empty" | "missing-token" | "auth-required" | "not-due" | "terminal" | "cancelled";
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const safeInteger = (value: unknown, fallback: number): number =>
  Number.isSafeInteger(value) && Number(value) >= 0 ? Number(value) : fallback;

const trimError = (value: unknown): string | undefined => {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim().slice(0, 240);
  return trimmed || undefined;
};

/**
 * Bounded, factual copy for a capture that will not be retried remotely. It
 * states only what happened — the background worker owns the "what happens
 * next" wording, because only it knows whether a browser-session capture is
 * still available. The attempt count comes from the job instead of assuming the
 * cap, because a hard rejection goes terminal on its first try.
 */
const terminalArchiveMessage = (job: ArchiveOutboxJob, error: string): string => {
  if (error === ARCHIVE_CAPTURE_URL_NOT_PUBLIC) {
    return "This page is only reachable from your browser (a local, private, or custom-port address), " +
      "so the archiving service cannot fetch it.";
  }
  const detail = trimError(error) || "The site rejected automated capture.";
  const attempts = Math.max(1, job.remoteAttempts ?? job.attempts);
  return attempts >= ARCHIVE_CAPTURE_MAX_ATTEMPTS
    ? `This site could not be captured after ${attempts} attempts. It may block automated archiving. ${detail}`
    : `This site rejected automated capture. ${detail}`;
};

const normalizeHttpUrl = (value: unknown): string | null => {
  if (typeof value !== "string") return null;
  try {
    const url = new URL(value);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    return url.toString();
  } catch {
    return null;
  }
};

const normalizeJob = (value: unknown): ArchiveOutboxJob | null => {
  if (!isRecord(value)) return null;
  const id = typeof value.id === "string" ? value.id.trim().slice(0, 160) : "";
  const itemId = normalizeArchiveItemId(value.itemId) ?? "";
  const sourceUrl = normalizeHttpUrl(value.sourceUrl);
  const mode = value.mode === "upload" ? "upload" : value.mode === "capture" ? "capture" : null;
  const fileName = typeof value.fileName === "string" ? value.fileName.trim().slice(0, 200) : "";
  if (!id || !itemId || !sourceUrl || !mode || (mode === "upload" && !fileName)) return null;

  const createdAt = safeInteger(value.createdAt, 0);
  const updatedAt = safeInteger(value.updatedAt, createdAt);
  const sessionCaptureAttempts = safeInteger(value.sessionCaptureAttempts, 0);
  const remoteAttempts = safeInteger(value.remoteAttempts, 0);
  return {
    id,
    itemId,
    mode,
    sourceUrl,
    ...(mode === "upload" ? { fileName } : {}),
    byteSize: mode === "upload" ? safeInteger(value.byteSize, 0) : 0,
    createdAt,
    updatedAt,
    attempts: safeInteger(value.attempts, 0),
    nextAttemptAt: safeInteger(value.nextAttemptAt, createdAt),
    ...(trimError(value.lastError) ? { lastError: trimError(value.lastError) } : {}),
    ...(value.locallyRetained === true ? { locallyRetained: true } : {}),
    ...(value.terminal === true && mode === "capture" ? { terminal: true } : {}),
    ...(sessionCaptureAttempts > 0 ? { sessionCaptureAttempts } : {}),
    ...(remoteAttempts > 0 ? { remoteAttempts } : {}),
  };
};

/** One newest pending archive intent per item, in stable FIFO order. */
export const normalizeArchiveOutbox = (value: unknown): ArchiveOutboxJob[] => {
  if (!Array.isArray(value)) return [];
  const byItem = new Map<string, ArchiveOutboxJob>();
  for (const raw of value) {
    const job = normalizeJob(raw);
    if (!job) continue;
    const previous = byItem.get(job.itemId);
    if (!previous || job.updatedAt > previous.updatedAt || (job.updatedAt === previous.updatedAt && job.id > previous.id)) {
      byItem.set(job.itemId, job);
    }
  }
  return [...byItem.values()]
    .sort((left, right) => left.createdAt - right.createdAt || left.id.localeCompare(right.id));
};

export const archiveRetryDelayMs = (attempts: number, retryAfterMs = 0): number => {
  const exponent = Math.min(10, Math.max(0, Math.floor(attempts)));
  const exponential = Math.min(6 * 60 * 60 * 1000, 30_000 * 2 ** exponent);
  return Math.max(exponential, Math.min(24 * 60 * 60 * 1000, Math.max(0, retryAfterMs)));
};

export const parseRetryAfterMs = (value: string | null, now = Date.now()): number => {
  if (!value) return 0;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return Math.max(0, Math.floor(seconds * 1000));
  const date = Date.parse(value);
  return Number.isFinite(date) ? Math.max(0, date - now) : 0;
};

const defaultConnection = getArchiveCloudConnection;

export const createChromeArchiveOutboxStorage = (): ArchiveOutboxStorage => ({
  async read() {
    const row = await chrome.storage.local.get(ARCHIVE_OUTBOX_STORAGE_KEY);
    return row[ARCHIVE_OUTBOX_STORAGE_KEY];
  },
  async write(jobs) {
    await chrome.storage.local.set({ [ARCHIVE_OUTBOX_STORAGE_KEY]: jobs });
  },
});

const getArchiveDirectory = async (): Promise<FileSystemDirectoryHandle> => {
  const root = await navigator.storage.getDirectory();
  return root.getDirectoryHandle(ARCHIVE_OUTBOX_DIRECTORY, { create: true });
};

const isNotFoundError = (error: unknown): boolean =>
  error instanceof DOMException && error.name === "NotFoundError";

export const createOpfsArchiveOutboxFiles = (): ArchiveOutboxFiles => ({
  async create(fileName) {
    const directory = await getArchiveDirectory();
    const handle = await directory.getFileHandle(fileName, { create: true });
    const writable = await handle.createWritable();
    let settled = false;
    return {
      async write(chunk) {
        if (settled) throw new Error("ARCHIVE_FILE_CLOSED");
        await writable.write(chunk);
      },
      async close() {
        if (settled) return;
        try {
          await writable.close();
          settled = true;
        } catch (error) {
          settled = true;
          await writable.abort().catch(() => {});
          await directory.removeEntry(fileName).catch(() => {});
          throw error;
        }
      },
      async abort() {
        if (settled) return;
        settled = true;
        await writable.abort().catch(() => {});
        await directory.removeEntry(fileName).catch(() => {});
      },
    };
  },
  async read(fileName) {
    try {
      const directory = await getArchiveDirectory();
      const handle = await directory.getFileHandle(fileName);
      return await handle.getFile();
    } catch (error) {
      if (isNotFoundError(error)) return null;
      throw error;
    }
  },
  async delete(fileName) {
    const directory = await getArchiveDirectory();
    try {
      await directory.removeEntry(fileName);
    } catch (error) {
      if (!isNotFoundError(error)) throw error;
    }
  },
  async cleanup(keepFileNames) {
    const directory = await getArchiveDirectory();
    const entries = (directory as FileSystemDirectoryHandle & {
      entries(): AsyncIterableIterator<[string, FileSystemHandle]>;
    }).entries();
    for await (const [name, handle] of entries) {
      if (handle.kind === "file" && !keepFileNames.has(name)) {
        try {
          await directory.removeEntry(name);
        } catch (error) {
          if (!isNotFoundError(error)) throw error;
        }
      }
    }
  },
});

export type PendingArchiveUpload = {
  itemId: string;
  body: Blob;
  sourceUrl: string;
  updatedAt: number;
};

/**
 * Read the newest completed device capture even while it is still waiting in
 * the upload outbox. The outbox bytes are already a durable local snapshot;
 * cloud acknowledgement must not be a prerequisite for opening them.
 */
export const readPendingArchiveUpload = async (
  itemIdRaw: string,
  storage: ArchiveOutboxStorage = createChromeArchiveOutboxStorage(),
  files: ArchiveOutboxFiles = createOpfsArchiveOutboxFiles(),
): Promise<PendingArchiveUpload | null> => {
  const itemId = normalizeArchiveItemId(itemIdRaw);
  if (!itemId) return null;
  const job = normalizeArchiveOutbox(await storage.read())
    .filter((candidate) => candidate.itemId === itemId && candidate.mode === "upload")
    .sort((left, right) => right.updatedAt - left.updatedAt || right.id.localeCompare(left.id))[0];
  if (!job?.fileName || job.byteSize < 20 || job.byteSize > ARCHIVE_OUTBOX_MAX_FILE_BYTES) {
    return null;
  }
  const body = await files.read(job.fileName);
  if (!body || body.size !== job.byteSize || body.size < 20 || body.size > ARCHIVE_OUTBOX_MAX_FILE_BYTES) {
    return null;
  }
  return {
    itemId,
    body,
    sourceUrl: job.sourceUrl,
    updatedAt: job.updatedAt,
  };
};

const ARCHIVE_OUTBOX_ERROR_MAX_BYTES = 64 * 1024;

const responseError = async (response: Response, signal: AbortSignal): Promise<string> => {
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > ARCHIVE_OUTBOX_ERROR_MAX_BYTES) {
    await response.body?.cancel().catch(() => {});
    return "ARCHIVE_ERROR_RESPONSE_TOO_LARGE";
  }
  let text = "";
  if (response.body) {
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let byteSize = 0;
    const cancel = () => void reader.cancel().catch(() => {});
    signal.addEventListener("abort", cancel, { once: true });
    try {
      while (true) {
        if (signal.aborted) throw new DOMException("Aborted", "AbortError");
        const { done, value } = await reader.read();
        if (signal.aborted) throw new DOMException("Aborted", "AbortError");
        if (done) break;
        if (!value?.byteLength) continue;
        byteSize += value.byteLength;
        if (byteSize > ARCHIVE_OUTBOX_ERROR_MAX_BYTES) {
          await reader.cancel().catch(() => {});
          return "ARCHIVE_ERROR_RESPONSE_TOO_LARGE";
        }
        chunks.push(value);
      }
    } finally {
      signal.removeEventListener("abort", cancel);
      reader.releaseLock();
    }
    const bytes = new Uint8Array(byteSize);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    text = new TextDecoder().decode(bytes);
  }
  let payload: { error?: unknown } | null = null;
  try {
    payload = JSON.parse(text) as { error?: unknown };
  } catch {}
  if (typeof payload?.error === "string" && payload.error.trim()) return payload.error.trim().slice(0, 240);
  return `${response.status} ${response.statusText}`.trim().slice(0, 240);
};

const requestWithTimeout = async (
  fetcher: typeof fetch,
  input: RequestInfo | URL,
  init: RequestInit,
  timeoutMs: number,
  cancellationSignal?: AbortSignal,
  connection?: ArchiveOutboxConnection,
): Promise<{ response: Response; errorText?: string }> => {
  if (connection) await assertCloudConnectionCurrent(connection);
  else await requireLegacyCloud();
  if (cancellationSignal?.aborted) throw new Error("ARCHIVE_REQUEST_CANCELLED");
  const controller = new AbortController();
  let timedOut = false;
  const cancelRequest = () => controller.abort();
  if (cancellationSignal?.aborted) cancelRequest();
  else cancellationSignal?.addEventListener("abort", cancelRequest, { once: true });
  const timeout = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);
  try {
    const response = await fetcher(input, { ...init, signal: controller.signal });
    try { if (connection) await assertCloudConnectionCurrent(connection); }
    catch (error) { await response.body?.cancel().catch(() => {}); throw error; }
    if (response.ok) {
      await response.body?.cancel().catch(() => {});
      return { response };
    }
    const errorText = await responseError(response, controller.signal);
    if (connection) await assertCloudConnectionCurrent(connection);
    return {
      response,
      errorText,
    };
  } catch (error) {
    if (controller.signal.aborted) {
      throw new Error(timedOut ? "ARCHIVE_REQUEST_TIMEOUT" : "ARCHIVE_REQUEST_CANCELLED");
    }
    throw error;
  } finally {
    clearTimeout(timeout);
    cancellationSignal?.removeEventListener("abort", cancelRequest);
  }
};

export class ArchiveOutbox {
  readonly files: ArchiveOutboxFiles;
  private readonly storage: ArchiveOutboxStorage;
  private readonly ensureItem: ArchiveOutboxOptions["ensureItem"];
  private readonly getConnection: (forceRefresh?: boolean) => Promise<ArchiveOutboxConnection>;
  private readonly fetcher: typeof fetch;
  private readonly now: () => number;
  private readonly randomId: () => string;
  private readonly maxDiskBytes: number;
  private readonly maxJobs: number;
  private readonly maxAgeMs: number;
  private readonly requestTimeoutMs: number;
  private readonly retainUploadedArchive?: ArchiveOutboxOptions["retainUploadedArchive"];
  private readonly retainUploadedArchiveWithinMutationLock?: ArchiveOutboxOptions["retainUploadedArchiveWithinMutationLock"];
  private readonly isUploadedArchiveRetained?: ArchiveOutboxOptions["isUploadedArchiveRetained"];
  private mutationTail: Promise<void> = Promise.resolve();
  private drainInFlight: Promise<ArchiveOutboxDrainResult> | null = null;
  private requestAbortController = new AbortController();
  private generation = 0;

  constructor(options: ArchiveOutboxOptions) {
    this.storage = options.storage;
    this.files = options.files;
    this.ensureItem = options.ensureItem;
    this.getConnection = options.getConnection ?? defaultConnection;
    // Bound like archive-preview: a detached fetch reference throws
    // "Illegal invocation" in window contexts.
    this.fetcher = options.fetcher ?? fetch.bind(globalThis);
    this.now = options.now ?? Date.now;
    this.randomId = options.randomId ?? (() => crypto.randomUUID());
    this.maxDiskBytes = options.maxDiskBytes ?? ARCHIVE_OUTBOX_MAX_DISK_BYTES;
    this.maxJobs = options.maxJobs ?? ARCHIVE_OUTBOX_MAX_JOBS;
    this.maxAgeMs = options.maxAgeMs ?? ARCHIVE_OUTBOX_MAX_AGE_MS;
    this.requestTimeoutMs = Math.max(10, Math.floor(options.requestTimeoutMs ?? 60_000));
    this.retainUploadedArchive = options.retainUploadedArchive;
    this.retainUploadedArchiveWithinMutationLock = options.retainUploadedArchiveWithinMutationLock;
    this.isUploadedArchiveRetained = options.isUploadedArchiveRetained;
  }

  createFileName(): string {
    return `${this.randomId()}.html`;
  }

  async list(): Promise<ArchiveOutboxJob[]> {
    return normalizeArchiveOutbox(await this.storage.read());
  }

  async enqueueUpload(input: {
    itemId: string;
    sourceUrl: string;
    fileName: string;
    byteSize: number;
  }): Promise<ArchiveOutboxJob> {
    const itemId = normalizeArchiveItemId(input.itemId);
    if (!itemId || !normalizeHttpUrl(input.sourceUrl)) throw new Error("INVALID_ARCHIVE_JOB");
    if (!input.fileName || input.byteSize < 20 || input.byteSize > ARCHIVE_OUTBOX_MAX_FILE_BYTES) {
      throw new Error("INVALID_ARCHIVE_FILE");
    }
    const now = this.now();
    const job: ArchiveOutboxJob = {
      id: this.randomId(),
      itemId,
      mode: "upload",
      sourceUrl: new URL(input.sourceUrl).toString(),
      fileName: input.fileName,
      byteSize: input.byteSize,
      createdAt: now,
      updatedAt: now,
      attempts: 0,
      nextAttemptAt: now,
    };
    await this.replaceItemJob(job);
    if (this.retainUploadedArchive) {
      const body = await this.files.read(input.fileName);
      if (body && body.size >= 20 && body.size <= ARCHIVE_OUTBOX_MAX_FILE_BYTES) {
        try {
          await this.retainUploadedArchive(job.itemId, body, job.updatedAt);
          job.locallyRetained = true;
          await this.mutate((jobs) => jobs.map((candidate) =>
            candidate.id === job.id ? { ...candidate, locallyRetained: true } : candidate
          ));
        } catch {
          // The outbox file remains authoritative and upload acknowledgement
          // retries the cache write before that source can be removed.
        }
      }
    }
    return job;
  }

  async enqueueServerCapture(
    itemId: string,
    sourceUrl: string,
    options: { notBefore?: number } = {},
  ): Promise<ArchiveOutboxJob> {
    const normalizedUrl = normalizeHttpUrl(sourceUrl);
    const normalizedItemId = normalizeArchiveItemId(itemId);
    if (!normalizedItemId || !normalizedUrl) throw new Error("INVALID_ARCHIVE_JOB");
    const now = this.now();
    const job: ArchiveOutboxJob = {
      id: this.randomId(),
      itemId: normalizedItemId,
      mode: "capture",
      sourceUrl: normalizedUrl,
      byteSize: 0,
      createdAt: now,
      updatedAt: now,
      attempts: 0,
      nextAttemptAt: Math.max(now, safeInteger(options.notBefore, now)),
    };
    await this.replaceItemJob(job);
    return job;
  }

  async discardItem(itemId: string): Promise<void> {
    await this.discardItems([itemId]);
  }

  async discardItems(itemIdsRaw: Iterable<string>): Promise<void> {
    const itemIds = new Set(collectArchiveItemIds(itemIdsRaw));
    if (itemIds.size === 0) return;
    // The drain is intentionally small and single-flight. Abort its current
    // request before removing a purged item so sensitive HTML cannot finish
    // uploading after the user permanently deletes that item. Unrelated work
    // stays queued and will retry on the next bounded drain.
    this.invalidateInFlight();
    const removed: ArchiveOutboxJob[] = [];
    await this.mutate((jobs) => {
      const next = jobs.filter((job) => {
        if (!itemIds.has(job.itemId)) return true;
        removed.push(job);
        return false;
      });
      return next;
    });
    await this.deleteJobFiles(removed);
  }

  async clear(): Promise<void> {
    this.invalidateInFlight();
    const removed: ArchiveOutboxJob[] = [];
    await this.mutate((jobs) => {
      removed.push(...jobs);
      return [];
    });
    await this.deleteJobFiles(removed);
    await this.files.cleanup(new Set());
  }

  /** Abort a request already on the wire and prevent any late ack from mutating local state. */
  invalidateInFlight(): void {
    this.generation += 1;
    this.requestAbortController.abort();
    this.requestAbortController = new AbortController();
  }

  async cleanup(): Promise<void> {
    const now = this.now();
    const removed: ArchiveOutboxJob[] = [];
    let kept: ArchiveOutboxJob[] = [];
    await this.mutate((jobs) => {
      kept = jobs.filter((job) => {
        if (now - job.createdAt <= this.maxAgeMs) return true;
        removed.push(job);
        return false;
      });
      return kept;
    });
    await this.deleteJobFiles(removed);
    await this.files.cleanup(new Set(kept.flatMap((job) => (job.fileName ? [job.fileName] : []))));
  }

  drain(limit = ARCHIVE_OUTBOX_DRAIN_LIMIT): Promise<ArchiveOutboxDrainResult> {
    if (this.drainInFlight) return this.drainInFlight;
    const run = this.drainInternal(Math.max(1, Math.min(10, Math.floor(limit)))).finally(() => {
      if (this.drainInFlight === run) this.drainInFlight = null;
    });
    this.drainInFlight = run;
    return run;
  }

  /** Explicit user action: finish any current drain, bypass stored retry
   * windows once, and attempt pending archives immediately. */
  async drainNow(limit = ARCHIVE_OUTBOX_DRAIN_LIMIT): Promise<ArchiveOutboxDrainResult> {
    await this.drainInFlight?.catch(() => {});
    const now = this.now();
    await this.mutate((jobs) => jobs.map((job) =>
      job.attempts > 0 && job.nextAttemptAt > now
        ? { ...job, nextAttemptAt: now }
        : job
    ));
    return this.drain(limit);
  }

  private async replaceItemJob(job: ArchiveOutboxJob): Promise<void> {
    const removed: ArchiveOutboxJob[] = [];
    const downgraded: ArchiveOutboxJob[] = [];
    await this.mutate((jobs) => {
      const previousUpdatedAt = jobs.reduce(
        (latest, existing) => existing.itemId === job.itemId
          ? Math.max(latest, existing.updatedAt)
          : latest,
        -1,
      );
      if (job.updatedAt <= previousUpdatedAt) {
        job.updatedAt = previousUpdatedAt + 1;
      }
      // Any replacement inherits how many browser-session fallbacks this item
      // already consumed — including an upload, which can later be converted
      // back into a capture. Without that, a failed fallback that re-queues the
      // job earns a fresh tab on the next drain and loops forever on a page the
      // service can never fetch.
      if (job.sessionCaptureAttempts === undefined) {
        const inherited = jobs.reduce(
          (highest, existing) => existing.itemId === job.itemId
            ? Math.max(highest, existing.sessionCaptureAttempts ?? 0)
            : highest,
          0,
        );
        if (inherited > 0) job.sessionCaptureAttempts = inherited;
      }
      const next = jobs.filter((existing) => {
        if (existing.itemId !== job.itemId) return true;
        removed.push(existing);
        return false;
      });
      next.push(job);
      if (next.length > this.maxJobs && next.length > jobs.length) {
        throw new Error("ARCHIVE_OUTBOX_CAPACITY");
      }

      let retainedBytes = 0;
      for (let index = next.length - 1; index >= 0; index -= 1) {
        const candidate = next[index];
        if (candidate.mode !== "upload") continue;
        if (retainedBytes + candidate.byteSize <= this.maxDiskBytes) {
          retainedBytes += candidate.byteSize;
          continue;
        }
        downgraded.push(candidate);
        next[index] = {
          ...candidate,
          id: this.randomId(),
          mode: "capture",
          fileName: undefined,
          byteSize: 0,
          attempts: 0,
          nextAttemptAt: this.now(),
          updatedAt: this.now(),
          lastError: "LOCAL_ARCHIVE_DISK_BUDGET",
        };
      }
      return next;
    });
    await this.deleteJobFiles([...removed, ...downgraded].filter((entry) => entry.fileName !== job.fileName));
  }

  private async drainInternal(limit: number): Promise<ArchiveOutboxDrainResult> {
    await requireLegacyCloud();
    const result: ArchiveOutboxDrainResult = {
      attempted: 0,
      uploaded: 0,
      deferred: 0,
      convertedToServerCapture: 0,
      discarded: 0,
      terminal: 0,
      retainedLocally: 0,
      tokenRejected: false,
      remaining: 0,
    };
    let connection = await this.getConnection();
    let jobs = await this.list();
    if (jobs.length === 0) return { ...result, reason: "empty" };
    // Login-optional: a device key uploads to the anonymous namespace when no
    // cloud account is connected.
    if (!connection.token && !connection.deviceKey) {
      return { ...result, remaining: jobs.length, reason: "missing-token" };
    }

    const attemptedIds = new Set<string>();
    let authRefreshAttempted = false;
    let authRejected = false;
    let rejectedConnection: ArchiveOutboxConnection | undefined;
    const connectionCurrent = async () => {
      try { await assertCloudConnectionCurrent(connection); return true; }
      catch (error) {
        if (error instanceof CloudConnectionRetiredError || (error instanceof Error && error.message === "LOCAL_ONLY_CLOUD_DISABLED")) return false;
        throw error;
      }
    };
    const cancelled = async () => ({ ...result, tokenRejected: false, remaining: (await this.list()).length, reason: "cancelled" as const });
    if (!await connectionCurrent()) return cancelled();
    while (result.attempted < limit) {
      const now = this.now();
      jobs = await this.list();
      if (!await connectionCurrent()) return cancelled();
      const expired = jobs.filter((job) => now - job.createdAt > this.maxAgeMs);
      if (expired.length > 0) {
        await this.removeJobs(expired);
        await this.deleteJobFiles(expired);
        result.discarded += expired.length;
        continue;
      }

      const job = jobs.find(
        (candidate) =>
          candidate.terminal !== true &&
          candidate.nextAttemptAt <= now &&
          !attemptedIds.has(candidate.id),
      );
      if (!job) break;
      const jobGeneration = this.generation;
      // Pin the controller that was current when this job was selected. A
      // delete/clear swaps the instance after aborting it; consulting the
      // mutable field later could otherwise give a pre-delete job a fresh,
      // non-aborted signal and let it start uploading after it was purged.
      const jobCancellationSignal = this.requestAbortController.signal;
      attemptedIds.add(job.id);
      result.attempted += 1;

      // Server captures render the live page in a headless browser — the most
      // expensive thing the outbox does. Pages that block bots (login walls,
      // bot checks) fail identically every time, so stop after a bounded
      // number of attempts instead of retrying for the job's full 30-day age.
      if (job.mode === "capture" && (job.remoteAttempts ?? 0) >= ARCHIVE_CAPTURE_MAX_ATTEMPTS) {
        await this.markTerminal(job, job.lastError || "ARCHIVE_CAPTURE_ATTEMPTS_EXHAUSTED");
        result.terminal += 1;
        continue;
      }

      // The archiving service fetches the page from its own network. A target
      // that only resolves inside this browser (localhost, a private address,
      // a custom port) is rejected as an unusable stub URL, identically every
      // time. Fail it on the spot so the browser-session fallback takes over
      // instead of spending eight remote attempts on a certain rejection.
      if (job.mode === "capture" && !isServerCapturableArchiveUrl(job.sourceUrl)) {
        await this.markTerminal(job, ARCHIVE_CAPTURE_URL_NOT_PUBLIC);
        result.terminal += 1;
        continue;
      }

      let readiness: ArchiveItemReadiness;
      if (!connection.token && connection.deviceKey) {
        // Login-less uploads anchor the item inside the anonymous namespace;
        // there is no account to sync the item into first.
        readiness = { ready: true };
      } else {
        try {
          readiness = await this.ensureItem(job.itemId);
        } catch (error) {
          readiness = { ready: false, reason: error instanceof Error ? error.message : "ITEM_SYNC_FAILED" };
        }
      }
      if (!(await this.isCurrentJob(job, jobGeneration, jobCancellationSignal))) {
        result.discarded += 1;
        continue;
      }
      if (!await connectionCurrent()) return cancelled();
      if (!readiness.ready) {
        await this.deferJob(job, readiness.reason || "ITEM_NOT_SYNCED", readiness.retryAfterMs, connectionCurrent);
        result.deferred += 1;
        continue;
      }

      let body: Blob | null = null;
      if (job.mode === "upload") {
        body = job.fileName ? await this.files.read(job.fileName) : null;
        if (!(await this.isCurrentJob(job, jobGeneration, jobCancellationSignal))) {
          result.discarded += 1;
          continue;
        }
        if (!await connectionCurrent()) return cancelled();
        if (!body || body.size < 20 || body.size > ARCHIVE_OUTBOX_MAX_FILE_BYTES) {
          await this.convertToServerCapture(job, "LOCAL_ARCHIVE_FILE_MISSING", connectionCurrent);
          result.convertedToServerCapture += 1;
          continue;
        }
      }

      let response: Response;
      let responseFailure = "";
      try {
        const sendArchiveRequest = (activeConnection: ArchiveOutboxConnection) => requestWithTimeout(
          this.fetcher,
          `${activeConnection.apiBase}/v1/items/${encodeURIComponent(job.itemId)}/archive`,
          {
            method: job.mode === "upload" ? "PUT" : "POST",
            headers: {
              // Login-less uploads target the anonymous per-device namespace;
              // the signed-in token always wins when both exist.
              ...(activeConnection.token
                ? { authorization: `Bearer ${activeConnection.token}` }
                : {}),
              ...(!activeConnection.token && activeConnection.deviceKey
                ? { "x-vs-device-key": activeConnection.deviceKey }
                : {}),
              // Server-capture stubs need a source URL to anchor the item.
              // The import marker also lets the server revive items that are
              // alive locally but tombstoned server-side (e.g. casualties of
              // the old bin-resurrection bug) — the user is explicitly
              // archiving this live page right now.
              ...(job.mode === "upload"
                ? {
                    "content-type": "text/html; charset=utf-8",
                    "x-vs-archive-byte-size": String(body?.size ?? job.byteSize),
                    "x-vs-archive-source-url": job.sourceUrl,
                  }
                : { "x-vs-archive-source-url": job.sourceUrl }),
              "x-vs-archive-import": "1",
            },
            ...(body ? { body } : {}),
            credentials: "omit",
            cache: "no-store",
          },
          this.requestTimeoutMs,
          jobCancellationSignal,
          activeConnection,
        );
        // One send, plus one retry if a refusal can be answered by a different
        // identity on this device (a dead bearer session leaves the device key).
        const send = async (activeConnection: ArchiveOutboxConnection) => {
          const attempt = await sendArchiveRequest(activeConnection);
          const refused = attempt.response.status === 401 || attempt.response.status === 403;
          // Report a refused session even when the retry below rescues this
          // upload, so a dead account cannot hide behind a working device key.
          if (refused && activeConnection.token) { result.tokenRejected = true; rejectedConnection = activeConnection; }
          return { attempt, refused };
        };

        let { attempt: request, refused } = await send(connection);
        // The service answered, so this attempt counts against the remote cap.
        await this.noteRemoteAttempt(job, connectionCurrent);
        if (!await connectionCurrent()) return cancelled();
        if (refused && !authRefreshAttempted && (connection.token || connection.deviceKey)) {
          authRefreshAttempted = true;
          const refreshed = await this.getConnection(true);
          if (!await connectionCurrent()) return cancelled();
          const sameIdentity =
            refreshed.token === connection.token && refreshed.deviceKey === connection.deviceKey;
          const usable = Boolean(refreshed.token || refreshed.deviceKey);
          if (usable && !sameIdentity) {
            connection = refreshed;
            ({ attempt: request } = await send(connection));
          }
        }
        response = request.response;
        responseFailure = request.errorText || "";
      } catch (error) {
        if (!await connectionCurrent()) return cancelled();
        await this.deferJob(job, error instanceof Error ? error.message : "ARCHIVE_NETWORK_ERROR", 0, connectionCurrent);
        result.deferred += 1;
        continue;
      }
      if (!await connectionCurrent()) return cancelled();

      if (response.ok) {
        const stillCurrent = jobGeneration === this.generation &&
          (await this.list()).some((candidate) => candidate.id === job.id);
        if (!await connectionCurrent()) return cancelled();
        if (!stillCurrent) {
          // A permanent delete, whole-library clear, or newer capture won while
          // this request was in flight. Never resurrect its local cache entry.
          result.discarded += 1;
          continue;
        }
        if (body && this.retainUploadedArchiveWithinMutationLock) {
          try {
            const finalized = await withOpfsMutationLock(async () => {
              const current = jobGeneration === this.generation &&
                (await this.list()).some((candidate) => candidate.id === job.id);
              if (!current || !await connectionCurrent()) return false;
              await this.retainUploadedArchiveWithinMutationLock?.(
                job.itemId,
                body,
                job.updatedAt,
              );
              const currentAfterRetention = jobGeneration === this.generation &&
                (await this.list()).some((candidate) => candidate.id === job.id);
              if (!currentAfterRetention || !await connectionCurrent()) return false;
              if (!await this.removeJobs([job], connectionCurrent)) return false;
              await this.deleteJobFiles([job]);
              return true;
            });
            if (!finalized) {
              if (!await connectionCurrent()) return cancelled();
              result.discarded += 1;
              continue;
            }
            result.uploaded += 1;
            continue;
          } catch (error) {
            await this.deferJob(
              job,
              error instanceof Error ? error.message : "ARCHIVE_CACHE_WRITE_FAILED",
              0, connectionCurrent,
            );
            result.deferred += 1;
            continue;
          }
        }
        let retained = false;
        if (body && job.locallyRetained === true && this.isUploadedArchiveRetained) {
          retained = await this.isUploadedArchiveRetained(
            job.itemId,
            job.updatedAt,
            body.size,
          ).catch(() => false);
        }
        if (body && this.retainUploadedArchive && !retained) {
          if (!await connectionCurrent()) return cancelled();
          try {
            // R2 acknowledgement is not enough for airplane-mode preview. Keep
            // the exact uploaded bytes in the bounded archive cache before the
            // outbox source is allowed to disappear.
            await this.retainUploadedArchive(job.itemId, body, job.updatedAt);
          } catch (error) {
            await this.deferJob(
              job,
              error instanceof Error ? error.message : "ARCHIVE_CACHE_WRITE_FAILED",
              0, connectionCurrent,
            );
            result.deferred += 1;
            continue;
          }
        }
        if (!await connectionCurrent()) return cancelled();
        if (!await this.removeJobs([job], connectionCurrent)) return cancelled();
        await this.deleteJobFiles([job]);
        result.uploaded += 1;
        continue;
      }

      const error = responseFailure || `${response.status} ${response.statusText}`.trim().slice(0, 240);
      if (response.status === 401 || response.status === 403) {
        authRejected = true;
      }
      if (job.mode === "upload" && (response.status === 400 || response.status === 413 || response.status === 415 || response.status === 422)) {
        // A page only this browser can reach cannot anchor a cloud archive
        // owner, so the mirror will refuse it forever. Settle as a local-only
        // archive instead of converting it into a server capture that can never
        // run — but only once the bytes are confirmed still readable. The
        // `locallyRetained` flag is written at enqueue time and the bounded
        // cache may have evicted the entry since, and this branch deletes the
        // last remaining copy.
        if (!isServerCapturableArchiveUrl(job.sourceUrl) && job.locallyRetained === true) {
          const stillReadable = body && this.isUploadedArchiveRetained
            ? await this.isUploadedArchiveRetained(job.itemId, job.updatedAt, body.size).catch(() => false)
            : false;
          if (stillReadable) {
            if (!await this.removeJobs([job], connectionCurrent)) return cancelled();
            await this.deleteJobFiles([job]);
            result.retainedLocally += 1;
            continue;
          }
          // The cache lost it: keep the outbox copy, which is now the only one.
          if (body && this.retainUploadedArchive) {
            try {
              await this.retainUploadedArchive(job.itemId, body, job.updatedAt);
            } catch {
              // Deferring below keeps the bytes; the next drain retries.
            }
          }
          await this.deferJob(job, "ARCHIVE_LOCAL_COPY_UNVERIFIED", 0, connectionCurrent);
          result.deferred += 1;
          continue;
        }
        await this.convertToServerCapture(job, error, connectionCurrent);
        result.convertedToServerCapture += 1;
        continue;
      }

      if (
        response.status === 401 ||
        response.status === 403 ||
        response.status === 404 ||
        response.status === 408 ||
        response.status === 409 ||
        response.status === 425 ||
        response.status === 429 ||
        response.status >= 500
      ) {
        // A refused bearer token normally means waiting for the user to
        // reconnect. But when this device also holds an archive device key, the
        // next attempt authenticates as a different identity, so there is
        // nothing to wait for — retry soon instead of parking for 15 minutes.
        const authRefused = response.status === 401 || response.status === 403;
        const identityCanChange = Boolean(connection.token && connection.deviceKey);
        const authDelay = authRefused ? (identityCanChange ? 30_000 : 15 * 60 * 1000) : 0;
        await this.deferJob(job, error, Math.max(authDelay, parseRetryAfterMs(response.headers.get("retry-after"), now)), connectionCurrent);
        result.deferred += 1;
        continue;
      }

      if (
        job.mode === "capture" &&
        (response.status === 400 || response.status === 409 || response.status === 410 || response.status === 422)
      ) {
        await this.markTerminal(job, error);
        result.terminal += 1;
        continue;
      }

      if (!await this.removeJobs([job], connectionCurrent)) return cancelled();
      await this.deleteJobFiles([job]);
      result.discarded += 1;
    }

    result.remaining = (await this.list()).length;
    if (!await connectionCurrent()) return cancelled();
    await rejectedConnection?.reject?.();
    if (authRejected) result.reason = "auth-required";
    else if (result.terminal > 0 || (result.remaining > 0 && (await this.list()).every((job) => job.terminal))) {
      result.reason = "terminal";
    } else if (result.attempted === 0 && result.remaining > 0) result.reason = "not-due";
    return result;
  }

  private async convertToServerCapture(job: ArchiveOutboxJob, reason: string, canMutate?: () => Promise<boolean>): Promise<void> {
    const replacement: ArchiveOutboxJob = {
      ...job,
      id: this.randomId(),
      mode: "capture",
      fileName: undefined,
      byteSize: 0,
      attempts: 0,
      nextAttemptAt: this.now(),
      updatedAt: this.now(),
      lastError: trimError(reason),
      locallyRetained: undefined,
      // Carried explicitly: a conversion must not hand the item a fresh budget
      // of browser-session captures.
      ...(job.sessionCaptureAttempts ? { sessionCaptureAttempts: job.sessionCaptureAttempts } : {}),
    };
    if (!await this.mutate((jobs) => jobs.map((candidate) => (candidate.id === job.id ? replacement : candidate)), canMutate)) return;
    await this.deleteJobFiles([job]);
  }

  /** Count one attempt where the archiving service actually responded. */
  private async noteRemoteAttempt(job: ArchiveOutboxJob, canMutate?: () => Promise<boolean>): Promise<void> {
    await this.mutate((jobs) =>
      jobs.map((candidate) =>
        candidate.id === job.id
          ? { ...candidate, remoteAttempts: (candidate.remoteAttempts ?? 0) + 1 }
          : candidate,
      ),
      canMutate,
    );
  }

  private async deferJob(job: ArchiveOutboxJob, error: string, retryAfterMs = 0, canMutate?: () => Promise<boolean>): Promise<void> {
    const now = this.now();
    await this.mutate((jobs) =>
      jobs.map((candidate) =>
        candidate.id === job.id
          ? {
              ...candidate,
              attempts: candidate.attempts + 1,
              nextAttemptAt: now + archiveRetryDelayMs(candidate.attempts, retryAfterMs),
              updatedAt: now,
              lastError: trimError(error),
            }
          : candidate,
      ),
      canMutate,
    );
  }

  private async markTerminal(job: ArchiveOutboxJob, error: string): Promise<void> {
    await this.mutate((jobs) =>
      jobs.map((candidate) =>
        candidate.id === job.id
          ? {
              ...candidate,
              terminal: true,
              nextAttemptAt: Number.MAX_SAFE_INTEGER,
              updatedAt: this.now(),
              lastError: trimError(terminalArchiveMessage(candidate, error)),
            }
          : candidate,
      ),
    );
  }

  /**
   * Terminal captures whose only remaining remedy is a capture from the user's
   * own browser session. Claiming increments the bounded attempt counter inside
   * the storage mutation, so two overlapping drains can never open two tabs for
   * the same page.
   */
  async claimSessionCaptureCandidates(limit = 1): Promise<ArchiveOutboxJob[]> {
    const max = Math.max(0, Math.floor(limit));
    if (max === 0) return [];
    const claimable = (job: ArchiveOutboxJob): boolean =>
      job.terminal === true &&
      job.mode === "capture" &&
      (job.sessionCaptureAttempts ?? 0) < ARCHIVE_SESSION_CAPTURE_MAX_ATTEMPTS;
    // Callers poll this on every drain so a row that went terminal in an
    // earlier worker lifetime still gets its one fallback. Read first and skip
    // the storage write entirely when there is nothing to claim.
    if (!(await this.list()).some(claimable)) return [];
    const claimed: ArchiveOutboxJob[] = [];
    await this.mutate((jobs) =>
      jobs.map((job) => {
        if (claimed.length >= max || !claimable(job)) return job;
        const next: ArchiveOutboxJob = {
          ...job,
          sessionCaptureAttempts: (job.sessionCaptureAttempts ?? 0) + 1,
          updatedAt: this.now(),
        };
        claimed.push(next);
        return next;
      }),
    );
    return claimed;
  }

  private async removeJobs(toRemove: ArchiveOutboxJob[], canMutate?: () => Promise<boolean>): Promise<boolean> {
    const ids = new Set(toRemove.map((job) => job.id));
    return this.mutate((jobs) => jobs.filter((job) => !ids.has(job.id)), canMutate);
  }

  private async isCurrentJob(
    job: ArchiveOutboxJob,
    generation: number,
    cancellationSignal: AbortSignal,
  ): Promise<boolean> {
    if (cancellationSignal.aborted || generation !== this.generation) return false;
    const current = (await this.list()).some((candidate) => candidate.id === job.id);
    return current && !cancellationSignal.aborted && generation === this.generation;
  }

  private async deleteJobFiles(jobs: ArchiveOutboxJob[]): Promise<void> {
    const names = new Set(jobs.flatMap((job) => (job.fileName ? [job.fileName] : [])));
    await Promise.all([...names].map((name) => this.files.delete(name)));
  }

  private async mutate(operation: (jobs: ArchiveOutboxJob[]) => ArchiveOutboxJob[], canMutate?: () => Promise<boolean>): Promise<boolean> {
    let release!: () => void;
    const previous = this.mutationTail;
    this.mutationTail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      const current = normalizeArchiveOutbox(await this.storage.read());
      if (canMutate && !await canMutate()) return false;
      const next = normalizeArchiveOutbox(operation(current));
      await this.storage.write(next);
      return true;
    } finally {
      release();
    }
  }
}
