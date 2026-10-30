import { z } from "zod";
import { LocalCompanionError, localCaptureSchema, localOriginalSchema, localRequestBytes, LOCAL_MESSAGE_MAX_BYTES, type LocalCapture, type LocalSaveRequest, type LocalRequest, type LocalSaveResult } from "./local-companion-protocol";

export const LOCAL_OUTBOX_STORAGE_KEY = "vibesearch.local-companion.outbox.v1";
export const LOCAL_COMPANION_RETRY_ALARM = "vibesearch.local-companion.retry.v1";
export const LOCAL_OUTBOX_MAX_JOBS = 20;
export const LOCAL_OUTBOX_MAX_BYTES = 4 * 1024 * 1024;
export const LOCAL_OUTBOX_MAX_ORIGINAL_BYTES = 64 * 1024 * 1024;
export const localOutboxFileSchema = z.object({ original: localOriginalSchema, opfsPath: z.string().regex(/^vibesearch-native-snapshots\/[a-f0-9-]{36}\.png$/u) }).strict();
export type LocalOutboxFile = z.infer<typeof localOutboxFileSchema>;
const jobSchema = z.object({
  capture: localCaptureSchema,
  files: z.array(localOutboxFileSchema).max(1).default([]),
  attempts: z.number().int().nonnegative(),
  nextAttemptAt: z.number().int().nonnegative(),
  lastError: z.string().max(512),
  state: z.enum(["pending", "blocked"]),
}).strict();
export type LocalOutboxJob = z.infer<typeof jobSchema>;
export const localOutboxJobsSchema = z.array(jobSchema).max(LOCAL_OUTBOX_MAX_JOBS);
export const localPendingSummarySchema = jobSchema.omit({ capture: true, files: true }).extend({
  id: z.uuid(), title: z.string().max(2000), url: z.string(), gaps: z.array(z.string().max(512)).max(16),
  originalCount: z.number().int().nonnegative().default(0),
});
export type LocalPendingSummary = z.infer<typeof localPendingSummarySchema>;

export interface LocalOutboxStorage {
  read(): Promise<LocalOutboxJob[]>;
  write(jobs: LocalOutboxJob[]): Promise<void>;
}

export function localRetryDelay(attempts: number): number {
  return Math.min(60 * 60 * 1000, 60 * 1000 * 2 ** Math.min(attempts - 1, 6));
}

export class LocalCompanionOutbox {
  private serial: Promise<void> = Promise.resolve();
  constructor(private readonly dependencies: {
    storage: LocalOutboxStorage;
    send: (request: LocalSaveRequest, files: LocalOutboxFile[]) => Promise<LocalSaveResult>;
    removeFiles?: (files: LocalOutboxFile[]) => Promise<void>;
    now?: () => number;
  }) {}

  private run<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.serial.then(operation, operation);
    this.serial = result.then(() => undefined, () => undefined);
    return result;
  }
  private now(): number { return (this.dependencies.now ?? Date.now)(); }
  private async read(): Promise<LocalOutboxJob[]> {
    return this.dependencies.storage.read();
  }

  enqueue(capture: LocalCapture, files: LocalOutboxFile[] = []): Promise<void> {
    return this.run(async () => {
      localCaptureSchema.parse(capture);
      z.array(localOutboxFileSchema).max(1).parse(files);
      if (JSON.stringify(capture.originals ?? []) !== JSON.stringify(files.map(file => file.original))) throw new LocalCompanionError("LOCAL_ORIGINAL_MANIFEST_MISMATCH");
      const request = { version: 1, id: capture.id, action: "save", capture } satisfies LocalRequest;
      if (localRequestBytes(request) > LOCAL_MESSAGE_MAX_BYTES) throw new LocalCompanionError("REQUEST_TOO_LARGE");
      const jobs = await this.read();
      const existing = jobs.find((job) => job.capture.id === capture.id);
      if (existing) {
        if (JSON.stringify(existing.capture) !== JSON.stringify(capture) || JSON.stringify(existing.files) !== JSON.stringify(files)) throw new LocalCompanionError("LOCAL_CAPTURE_ID_CONFLICT");
        return;
      }
      if (jobs.length >= LOCAL_OUTBOX_MAX_JOBS) throw new LocalCompanionError("LOCAL_OUTBOX_FULL");
      if (jobs.flatMap(job => job.files).reduce((sum, file) => sum + file.original.byteSize, 0) + files.reduce((sum, file) => sum + file.original.byteSize, 0) > LOCAL_OUTBOX_MAX_ORIGINAL_BYTES) throw new LocalCompanionError("LOCAL_OUTBOX_FULL");
      const next: LocalOutboxJob[] = [...jobs, { capture, files, attempts: 0, nextAttemptAt: this.now(), lastError: "", state: "pending" }];
      if (new TextEncoder().encode(JSON.stringify(next)).byteLength > LOCAL_OUTBOX_MAX_BYTES) throw new LocalCompanionError("LOCAL_OUTBOX_FULL");
      await this.dependencies.storage.write(next);
    });
  }

  summary(): Promise<LocalPendingSummary[]> {
    return this.run(async () => (await this.read()).map(({ capture, files, ...job }) => ({ ...job, id: capture.id, title: capture.title, url: capture.url, gaps: capture.gaps, originalCount: files.length })));
  }

  inspect(captureId: string): Promise<LocalCapture> {
    return this.run(async () => {
      const job = (await this.read()).find(entry => entry.capture.id === captureId);
      if (!job) throw new LocalCompanionError("LOCAL_CAPTURE_NOT_FOUND");
      return structuredClone(job.capture);
    });
  }
  files(captureId: string): Promise<LocalOutboxFile[]> {
    return this.run(async () => {
      const job = (await this.read()).find(entry => entry.capture.id === captureId);
      if (!job) throw new LocalCompanionError("LOCAL_CAPTURE_NOT_FOUND");
      return structuredClone(job.files);
    });
  }
  dismiss(captureId: string): Promise<void> {
    return this.run(async () => {
      const jobs = await this.read();
      if (!jobs.some(entry => entry.capture.id === captureId)) throw new LocalCompanionError("LOCAL_CAPTURE_NOT_FOUND");
      await this.dependencies.storage.write(jobs.filter(entry => entry.capture.id !== captureId));
      await this.dependencies.removeFiles?.(jobs.find(entry => entry.capture.id === captureId)?.files ?? []).catch(() => {});
    });
  }
  repair(captureId: string): Promise<void> {
    return this.run(async () => {
      const jobs = await this.read();
      if (!jobs.some(entry => entry.capture.id === captureId)) throw new LocalCompanionError("LOCAL_CAPTURE_NOT_FOUND");
      await this.dependencies.storage.write(jobs.map(entry => entry.capture.id === captureId ? { ...entry, state: "pending", nextAttemptAt: this.now() } : entry));
    });
  }

  flush(options: { captureId?: string; force?: boolean; limit?: number } = {}): Promise<LocalSaveResult[]> {
    return this.run(async () => {
      let jobs = await this.read();
      const receipts: LocalSaveResult[] = [];
      const eligible = jobs.filter((job) => job.state === "pending" && (!options.captureId || job.capture.id === options.captureId) && (options.force || job.nextAttemptAt <= this.now())).slice(0, options.limit ?? 4);
      for (const job of eligible) {
        try {
          const request = { version: 1, id: job.capture.id, action: "save", capture: job.capture } satisfies LocalRequest;
          const receipt = await this.dependencies.send(request, job.files);
          if (receipt.captureId !== job.capture.id) throw new LocalCompanionError("INVALID_COMPANION_RESPONSE");
          const next = jobs.filter((entry) => entry.capture.id !== job.capture.id);
          // A failed acknowledgement write leaves the persisted snapshot for idempotent replay.
          await this.dependencies.storage.write(next);
          jobs = next;
          receipts.push(receipt);
          await this.dependencies.removeFiles?.(job.files).catch(() => {});
        } catch (error) {
          const code = error instanceof Error ? error.message.slice(0, 512) : "COMPANION_UNAVAILABLE";
          const attempts = job.attempts + 1;
          const state = ["NATIVE_INVALID_REQUEST", "NATIVE_CAPTURE_ID_CONFLICT", "REQUEST_TOO_LARGE", "LOCAL_ORIGINAL_MISSING", "LOCAL_ORIGINAL_CHANGED"].includes(code) ? "blocked" : "pending";
          const next: LocalOutboxJob[] = jobs.map((entry) => entry.capture.id === job.capture.id ? { ...entry, attempts, lastError: code, state, nextAttemptAt: this.now() + localRetryDelay(attempts) } : entry);
          await this.dependencies.storage.write(next);
          jobs = next;
          if (state === "pending") break;
        }
      }
      return receipts;
    });
  }
}
