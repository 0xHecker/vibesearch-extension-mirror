import { describe, expect, test } from "bun:test";
import {
  BROWSER_BOOKMARK_RESYNC_DEBOUNCE_MS,
  BROWSER_BOOKMARK_RESYNC_FALLBACK_DELAY_MS,
  BrowserBookmarkResyncScheduler,
} from "../src/services/browser-bookmark-resync";

type Timer = { callback: () => void; delayMs: number };

const flush = async () => {
  for (let index = 0; index < 8; index += 1) await Promise.resolve();
};

const createSchedulerHarness = (options?: {
  enabled?: boolean;
  runSync?: () => Promise<void>;
}) => {
  let now = 1_764_000_000_000;
  let nextTimer = 0;
  let enabled = options?.enabled ?? true;
  const timers = new Map<number, Timer>();
  const alarmTimes: number[] = [];
  let clearAlarmCalls = 0;
  const errors: unknown[] = [];
  const scheduler = new BrowserBookmarkResyncScheduler({
    isEnabled: async () => enabled,
    runSync: options?.runSync ?? (async () => {}),
    createFallbackAlarm: async (when) => {
      alarmTimes.push(when);
    },
    clearFallbackAlarm: async () => {
      clearAlarmCalls += 1;
    },
    now: () => now,
    setTimer: (callback, delayMs) => {
      const id = ++nextTimer;
      timers.set(id, { callback, delayMs });
      return id;
    },
    clearTimer: (timer) => {
      timers.delete(timer as number);
    },
    onError: (error) => errors.push(error),
  });
  const fireOnlyTimer = () => {
    expect(timers).toHaveLength(1);
    const [id, timer] = Array.from(timers.entries())[0];
    timers.delete(id);
    timer.callback();
  };
  return {
    scheduler,
    timers,
    alarmTimes,
    errors,
    get clearAlarmCalls() {
      return clearAlarmCalls;
    },
    setEnabled(value: boolean) {
      enabled = value;
    },
    setNow(value: number) {
      now = value;
    },
    fireOnlyTimer,
  };
};

describe("BrowserBookmarkResyncScheduler", () => {
  test("debounces a burst into one fast scan with a durable fallback alarm", async () => {
    let runs = 0;
    const harness = createSchedulerHarness({
      runSync: async () => {
        runs += 1;
      },
    });

    await Promise.all([harness.scheduler.request(), harness.scheduler.request(), harness.scheduler.request()]);
    expect(harness.timers).toHaveLength(1);
    expect(Array.from(harness.timers.values())[0].delayMs).toBe(BROWSER_BOOKMARK_RESYNC_DEBOUNCE_MS);
    expect(harness.alarmTimes).toEqual([1_764_000_000_000 + BROWSER_BOOKMARK_RESYNC_FALLBACK_DELAY_MS]);

    harness.fireOnlyTimer();
    await flush();
    expect(runs).toBe(1);
    expect(harness.clearAlarmCalls).toBe(1);
  });

  test("waits for a browser import session and then performs one final reconciliation", async () => {
    const harness = createSchedulerHarness();

    await harness.scheduler.onImportBegan();
    await harness.scheduler.request();
    expect(harness.timers).toHaveLength(0);

    await harness.scheduler.onImportEnded();
    expect(harness.timers).toHaveLength(1);
    harness.fireOnlyTimer();
    await flush();
    expect(harness.clearAlarmCalls).toBe(2);
  });

  test("queues a follow-up scan when another bookmark event arrives during a sync", async () => {
    let runs = 0;
    let releaseFirstRun!: () => void;
    const firstRun = new Promise<void>((resolve) => {
      releaseFirstRun = resolve;
    });
    const harness = createSchedulerHarness({
      runSync: async () => {
        runs += 1;
        if (runs === 1) await firstRun;
      },
    });

    await harness.scheduler.request();
    harness.fireOnlyTimer();
    await flush();
    expect(runs).toBe(1);

    await harness.scheduler.request();
    expect(harness.timers).toHaveLength(0);
    releaseFirstRun();
    await flush();
    expect(harness.timers).toHaveLength(1);

    harness.fireOnlyTimer();
    await flush();
    expect(runs).toBe(2);
  });

  test("keeps a durable retry when reconciliation fails", async () => {
    let runs = 0;
    const harness = createSchedulerHarness({
      runSync: async () => {
        runs += 1;
        throw new Error("offscreen unavailable");
      },
    });

    await harness.scheduler.request();
    harness.fireOnlyTimer();
    await flush();
    expect(runs).toBe(1);
    expect(harness.errors).toHaveLength(1);
    expect(harness.timers).toHaveLength(0);
    expect(harness.alarmTimes).toHaveLength(2);
  });

  test("does not scan before the user has imported browser bookmarks", async () => {
    let runs = 0;
    const harness = createSchedulerHarness({
      enabled: false,
      runSync: async () => {
        runs += 1;
      },
    });

    await harness.scheduler.request();
    expect(harness.timers).toHaveLength(0);
    expect(runs).toBe(0);
    expect(harness.clearAlarmCalls).toBe(1);
  });
});
