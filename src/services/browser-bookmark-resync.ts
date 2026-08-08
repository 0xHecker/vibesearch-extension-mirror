export const BROWSER_BOOKMARK_RESYNC_ALARM_NAME = "browser-bookmark-resync";
export const BROWSER_BOOKMARK_RESYNC_DEBOUNCE_MS = 1_500;
export const BROWSER_BOOKMARK_RESYNC_FALLBACK_DELAY_MS = 30_000;

type TimerHandle = unknown;

export type BrowserBookmarkResyncSchedulerOptions = {
  isEnabled: () => Promise<boolean>;
  runSync: () => Promise<void>;
  createFallbackAlarm: (when: number) => Promise<void>;
  clearFallbackAlarm: () => Promise<void>;
  now?: () => number;
  setTimer?: (callback: () => void, delayMs: number) => TimerHandle;
  clearTimer?: (timer: TimerHandle) => void;
  onError?: (error: unknown) => void;
};

/**
 * Collapses bookmark API event bursts into one source-of-truth tree scan.
 * The alarm covers MV3 worker suspension; the timer keeps ordinary edits fast.
 */
export class BrowserBookmarkResyncScheduler {
  private timer: TimerHandle | null = null;
  private requestedGeneration = 0;
  private completedGeneration = 0;
  private importInProgress = false;
  private armVersion = 0;
  private runInFlight: Promise<void> | null = null;

  constructor(private readonly options: BrowserBookmarkResyncSchedulerOptions) {}

  async request(): Promise<void> {
    this.requestedGeneration += 1;
    this.armVersion += 1;
    await this.arm(this.armVersion);
  }

  async onImportBegan(): Promise<void> {
    this.importInProgress = true;
    this.completedGeneration = this.requestedGeneration;
    this.armVersion += 1;
    this.cancelTimer();
    await this.clearFallbackAlarm();
  }

  async onImportEnded(): Promise<void> {
    this.importInProgress = false;
    await this.request();
  }

  async onFallbackAlarm(): Promise<void> {
    if (this.importInProgress) return;
    this.requestedGeneration += 1;
    this.armVersion += 1;
    this.cancelTimer();
    await this.run(this.requestedGeneration);
  }

  /** Cancel queued automatic work and wait for an already-running scan. */
  async reset(): Promise<void> {
    this.armVersion += 1;
    this.cancelTimer();
    this.completedGeneration = this.requestedGeneration;
    await this.clearFallbackAlarm();
    await this.runInFlight?.catch(() => {});
  }

  private hasPendingWork(): boolean {
    return this.requestedGeneration > this.completedGeneration;
  }

  private async arm(version: number): Promise<void> {
    if (this.importInProgress || !this.hasPendingWork() || this.runInFlight) return;

    const enabled = await this.readEnabled();
    if (enabled === null) {
      await this.scheduleFallbackAlarm();
      return;
    }
    if (version !== this.armVersion || this.importInProgress || !this.hasPendingWork() || this.runInFlight) return;
    if (!enabled) {
      this.completedGeneration = this.requestedGeneration;
      await this.clearFallbackAlarm();
      return;
    }

    await this.scheduleFallbackAlarm();
    if (version !== this.armVersion || this.importInProgress || !this.hasPendingWork() || this.runInFlight) return;

    this.cancelTimer();
    this.timer = this.setTimer(() => {
      this.timer = null;
      void this.run();
    }, BROWSER_BOOKMARK_RESYNC_DEBOUNCE_MS);
  }

  private async run(forcedGeneration?: number): Promise<void> {
    if (this.importInProgress) return;
    if (this.runInFlight) return this.runInFlight;
    if (!this.hasPendingWork() && forcedGeneration === undefined) {
      await this.clearFallbackAlarm();
      return;
    }

    const generation = Math.max(forcedGeneration ?? 0, this.requestedGeneration);
    let rearmAfterRun = false;
    const run = (async () => {
      const enabled = await this.readEnabled();
      if (enabled === null) {
        await this.scheduleFallbackAlarm();
        return;
      }
      if (!enabled) {
        this.completedGeneration = Math.max(this.completedGeneration, generation);
        if (!this.hasPendingWork()) await this.clearFallbackAlarm();
        return;
      }

      try {
        await this.options.runSync();
        this.completedGeneration = Math.max(this.completedGeneration, generation);
        if (this.hasPendingWork() && !this.importInProgress) {
          rearmAfterRun = true;
        } else {
          await this.clearFallbackAlarm();
        }
      } catch (error) {
        this.reportError(error);
        await this.scheduleFallbackAlarm();
      }
    })();
    this.runInFlight = run;
    try {
      await run;
    } finally {
      this.runInFlight = null;
      if (rearmAfterRun) {
        this.armVersion += 1;
        await this.arm(this.armVersion);
      }
    }
  }

  private async readEnabled(): Promise<boolean | null> {
    try {
      return await this.options.isEnabled();
    } catch (error) {
      this.reportError(error);
      return null;
    }
  }

  private async scheduleFallbackAlarm(): Promise<void> {
    try {
      await this.options.createFallbackAlarm(this.now() + BROWSER_BOOKMARK_RESYNC_FALLBACK_DELAY_MS);
    } catch (error) {
      this.reportError(error);
    }
  }

  private now(): number {
    return this.options.now?.() ?? Date.now();
  }

  private setTimer(callback: () => void, delayMs: number): TimerHandle {
    return this.options.setTimer?.(callback, delayMs) ?? setTimeout(callback, delayMs);
  }

  private cancelTimer(): void {
    if (this.timer === null) return;
    if (this.options.clearTimer) this.options.clearTimer(this.timer);
    else clearTimeout(this.timer as ReturnType<typeof setTimeout>);
    this.timer = null;
  }

  private async clearFallbackAlarm(): Promise<void> {
    try {
      await this.options.clearFallbackAlarm();
    } catch (error) {
      this.reportError(error);
    }
  }

  private reportError(error: unknown): void {
    this.options.onError?.(error);
  }
}
