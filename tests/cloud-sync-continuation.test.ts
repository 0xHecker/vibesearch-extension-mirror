import { expect, test } from "bun:test";
import { shouldScheduleCloudSyncContinuation } from "@src/services/cloud-sync-continuation";

test("cloud sync continuation only follows a successful bounded upload", () => {
  expect(shouldScheduleCloudSyncContinuation({ remaining: 1 })).toBe(true);
  expect(shouldScheduleCloudSyncContinuation({ remaining: 1, reason: "network-error" })).toBe(false);
  expect(shouldScheduleCloudSyncContinuation({ remaining: 1, reason: "missing-token" })).toBe(false);
  expect(shouldScheduleCloudSyncContinuation({ remaining: 0 })).toBe(false);
  expect(shouldScheduleCloudSyncContinuation({ pull: { hasMore: true } })).toBe(false);
});
