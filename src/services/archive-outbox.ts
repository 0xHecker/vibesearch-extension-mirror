import {
  CLOUD_SYNC_API_BASE_KEY,
  DEFAULT_VIBESEARCH_API_BASE,
} from "./cloud-config";
import { getCloudAuthToken } from "./cloud-auth";

export const ARCHIVE_OUTBOX_STORAGE_KEY = "vibesearch:archiveOutbox:v1";
export const ARCHIVE_OUTBOX_ALARM_NAME = "archive-outbox-alarm";
export const ARCHIVE_OUTBOX_DIRECTORY = "archive-outbox-v1";
export const ARCHIVE_OUTBOX_MAX_FILE_BYTES = 24 * 1024 * 1024;
export const ARCHIVE_OUTBOX_MAX_DISK_BYTES = 256 * 1024 * 1024;
export const ARCHIVE_OUTBOX_MAX_JOBS = 20_000;
export const ARCHIVE_OUTBOX_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;
export const ARCHIVE_OUTBOX_DRAIN_LIMIT = 2;

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
};

export type ArchiveOutboxConnection = {
  token: string;
  apiBase: string;
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
  getConnection?: () => Promise<ArchiveOutboxConnection>;
  fetcher?: typeof fetch;
  now?: () => number;
  randomId?: () => string;
  maxDiskBytes?: number;
  maxJobs?: number;
  maxAgeMs?: number;
};

export type ArchiveOutboxDrainResult = {
  attempted: number;
  uploaded: number;
  deferred: number;
  convertedToServerCapture: number;
  discarded: number;
  remaining: number;
  reason?: "empty" | "missing-token" | "not-due";
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
  const itemId = typeof value.itemId === "string" ? value.itemId.trim().slice(0, 160) : "";
  const sourceUrl = normalizeHttpUrl(value.sourceUrl);
  const mode = value.mode === "upload" ? "upload" : value.mode === "capture" ? "capture" : null;
  const fileName = typeof value.fileName === "string" ? value.fileName.trim().slice(0, 200) : "";
  if (!id || !itemId || !sourceUrl || !mode || (mode === "upload" && !fileName)) return null;

  const createdAt = safeInteger(value.createdAt, 0);
  const updatedAt = safeInteger(value.updatedAt, createdAt);
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

const defaultConnection = async (): Promise<ArchiveOutboxConnection> => {
  const [row, token] = await Promise.all([
    chrome.storage.local.get(CLOUD_SYNC_API_BASE_KEY),
    getCloudAuthToken(),
  ]);
  const configured = typeof row[CLOUD_SYNC_API_BASE_KEY] === "string" ? row[CLOUD_SYNC_API_BASE_KEY].trim() : "";
  return {
    token,
    apiBase: (configured || DEFAULT_VIBESEARCH_API_BASE).replace(/\/+$/, ""),
  };
};

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
    } catch {
      return null;
    }
  },
  async delete(fileName) {
    const directory = await getArchiveDirectory();
    await directory.removeEntry(fileName).catch(() => {});
  },
  async cleanup(keepFileNames) {
    const directory = await getArchiveDirectory();
    const entries = (directory as FileSystemDirectoryHandle & {
      entries(): AsyncIterableIterator<[string, FileSystemHandle]>;
    }).entries();
    for await (const [name, handle] of entries) {
      if (handle.kind === "file" && !keepFileNames.has(name)) {
        await directory.removeEntry(name).catch(() => {});
      }
    }
  },
});

const responseError = async (response: Response): Promise<string> => {
  const payload = (await response.json().catch(() => null)) as { error?: unknown } | null;
  if (typeof payload?.error === "string" && payload.error.trim()) return payload.error.trim().slice(0, 240);
  return `${response.status} ${response.statusText}`.trim().slice(0, 240);
};

const requestWithTimeout = async (
  fetcher: typeof fetch,
  input: RequestInfo | URL,
  init: RequestInit,
): Promise<Response> => {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 60_000);
  try {
    return await fetcher(input, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timeout);
  }
};

export class ArchiveOutbox {
  readonly files: ArchiveOutboxFiles;
  private readonly storage: ArchiveOutboxStorage;
  private readonly ensureItem: ArchiveOutboxOptions["ensureItem"];
  private readonly getConnection: () => Promise<ArchiveOutboxConnection>;
  private readonly fetcher: typeof fetch;
  private readonly now: () => number;
  private readonly randomId: () => string;
  private readonly maxDiskBytes: number;
  private readonly maxJobs: number;
  private readonly maxAgeMs: number;
  private mutationTail: Promise<void> = Promise.resolve();
  private drainInFlight: Promise<ArchiveOutboxDrainResult> | null = null;

  constructor(options: ArchiveOutboxOptions) {
    this.storage = options.storage;
    this.files = options.files;
    this.ensureItem = options.ensureItem;
    this.getConnection = options.getConnection ?? defaultConnection;
    this.fetcher = options.fetcher ?? fetch;
    this.now = options.now ?? Date.now;
    this.randomId = options.randomId ?? (() => crypto.randomUUID());
    this.maxDiskBytes = options.maxDiskBytes ?? ARCHIVE_OUTBOX_MAX_DISK_BYTES;
    this.maxJobs = options.maxJobs ?? ARCHIVE_OUTBOX_MAX_JOBS;
    this.maxAgeMs = options.maxAgeMs ?? ARCHIVE_OUTBOX_MAX_AGE_MS;
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
    if (!input.itemId.trim() || !normalizeHttpUrl(input.sourceUrl)) throw new Error("INVALID_ARCHIVE_JOB");
    if (!input.fileName || input.byteSize < 20 || input.byteSize > ARCHIVE_OUTBOX_MAX_FILE_BYTES) {
      throw new Error("INVALID_ARCHIVE_FILE");
    }
    const now = this.now();
    const job: ArchiveOutboxJob = {
      id: this.randomId(),
      itemId: input.itemId.trim(),
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
    return job;
  }

  async enqueueServerCapture(
    itemId: string,
    sourceUrl: string,
    options: { notBefore?: number } = {},
  ): Promise<ArchiveOutboxJob> {
    const normalizedUrl = normalizeHttpUrl(sourceUrl);
    if (!itemId.trim() || !normalizedUrl) throw new Error("INVALID_ARCHIVE_JOB");
    const now = this.now();
    const job: ArchiveOutboxJob = {
      id: this.randomId(),
      itemId: itemId.trim(),
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
    const removed: ArchiveOutboxJob[] = [];
    await this.mutate((jobs) => {
      const next = jobs.filter((job) => {
        if (job.itemId !== itemId) return true;
        removed.push(job);
        return false;
      });
      return next;
    });
    await this.deleteJobFiles(removed);
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

  private async replaceItemJob(job: ArchiveOutboxJob): Promise<void> {
    const removed: ArchiveOutboxJob[] = [];
    const downgraded: ArchiveOutboxJob[] = [];
    await this.mutate((jobs) => {
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
    const result: ArchiveOutboxDrainResult = {
      attempted: 0,
      uploaded: 0,
      deferred: 0,
      convertedToServerCapture: 0,
      discarded: 0,
      remaining: 0,
    };
    const connection = await this.getConnection();
    let jobs = await this.list();
    if (jobs.length === 0) return { ...result, reason: "empty" };
    if (!connection.token) return { ...result, remaining: jobs.length, reason: "missing-token" };

    const attemptedIds = new Set<string>();
    while (result.attempted < limit) {
      const now = this.now();
      jobs = await this.list();
      const expired = jobs.filter((job) => now - job.createdAt > this.maxAgeMs);
      if (expired.length > 0) {
        await this.removeJobs(expired);
        await this.deleteJobFiles(expired);
        result.discarded += expired.length;
        continue;
      }

      const job = jobs.find((candidate) => candidate.nextAttemptAt <= now && !attemptedIds.has(candidate.id));
      if (!job) break;
      attemptedIds.add(job.id);
      result.attempted += 1;

      let readiness: ArchiveItemReadiness;
      try {
        readiness = await this.ensureItem(job.itemId);
      } catch (error) {
        readiness = { ready: false, reason: error instanceof Error ? error.message : "ITEM_SYNC_FAILED" };
      }
      if (!readiness.ready) {
        await this.deferJob(job, readiness.reason || "ITEM_NOT_SYNCED", readiness.retryAfterMs);
        result.deferred += 1;
        continue;
      }

      let body: Blob | null = null;
      if (job.mode === "upload") {
        body = job.fileName ? await this.files.read(job.fileName) : null;
        if (!body || body.size < 20 || body.size > ARCHIVE_OUTBOX_MAX_FILE_BYTES) {
          await this.convertToServerCapture(job, "LOCAL_ARCHIVE_FILE_MISSING");
          result.convertedToServerCapture += 1;
          continue;
        }
      }

      let response: Response;
      try {
        response = await requestWithTimeout(
          this.fetcher,
          `${connection.apiBase}/v1/items/${encodeURIComponent(job.itemId)}/archive`,
          {
            method: job.mode === "upload" ? "PUT" : "POST",
            headers: {
              authorization: `Bearer ${connection.token}`,
              ...(job.mode === "upload"
                ? {
                    "content-type": "text/html; charset=utf-8",
                    "x-vs-archive-byte-size": String(body?.size ?? job.byteSize),
                    "x-vs-archive-source-url": job.sourceUrl,
                  }
                : {}),
            },
            ...(body ? { body } : {}),
            credentials: "omit",
            cache: "no-store",
          },
        );
      } catch (error) {
        await this.deferJob(job, error instanceof Error ? error.message : "ARCHIVE_NETWORK_ERROR");
        result.deferred += 1;
        continue;
      }

      if (response.ok) {
        await this.removeJobs([job]);
        await this.deleteJobFiles([job]);
        result.uploaded += 1;
        continue;
      }

      const error = await responseError(response);
      if (job.mode === "upload" && (response.status === 400 || response.status === 413 || response.status === 415 || response.status === 422)) {
        await this.convertToServerCapture(job, error);
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
        const authDelay = response.status === 401 || response.status === 403 ? 15 * 60 * 1000 : 0;
        await this.deferJob(job, error, Math.max(authDelay, parseRetryAfterMs(response.headers.get("retry-after"), now)));
        result.deferred += 1;
        continue;
      }

      await this.removeJobs([job]);
      await this.deleteJobFiles([job]);
      result.discarded += 1;
    }

    result.remaining = (await this.list()).length;
    if (result.attempted === 0 && result.remaining > 0) result.reason = "not-due";
    return result;
  }

  private async convertToServerCapture(job: ArchiveOutboxJob, reason: string): Promise<void> {
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
    };
    await this.mutate((jobs) => jobs.map((candidate) => (candidate.id === job.id ? replacement : candidate)));
    await this.deleteJobFiles([job]);
  }

  private async deferJob(job: ArchiveOutboxJob, error: string, retryAfterMs = 0): Promise<void> {
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
    );
  }

  private async removeJobs(toRemove: ArchiveOutboxJob[]): Promise<void> {
    const ids = new Set(toRemove.map((job) => job.id));
    await this.mutate((jobs) => jobs.filter((job) => !ids.has(job.id)));
  }

  private async deleteJobFiles(jobs: ArchiveOutboxJob[]): Promise<void> {
    const names = new Set(jobs.flatMap((job) => (job.fileName ? [job.fileName] : [])));
    await Promise.all([...names].map((name) => this.files.delete(name)));
  }

  private async mutate(operation: (jobs: ArchiveOutboxJob[]) => ArchiveOutboxJob[]): Promise<void> {
    let release!: () => void;
    const previous = this.mutationTail;
    this.mutationTail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      const current = normalizeArchiveOutbox(await this.storage.read());
      const next = normalizeArchiveOutbox(operation(current));
      await this.storage.write(next);
    } finally {
      release();
    }
  }
}
