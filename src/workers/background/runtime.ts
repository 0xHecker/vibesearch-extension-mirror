import { setupOffscreenDocument } from "@src/services/offscreen-helper";
import { z } from "zod";

const offscreenResponseSchema = z
  .object({
    success: z.boolean().optional(),
    payload: z.unknown().optional(),
    error: z.string().optional(),
  })
  .passthrough();

export type OffscreenRequest = {
  service: string;
  type: string;
  payload?: object | string | number | boolean | null;
};

let resetInProgress = false;
let resetRecoveryRequired = true;
const backgroundDataJobs = new Set<Promise<unknown>>();
const offscreenRequests = new Set<Promise<unknown>>();

function trackWork<T>(
  set: Set<Promise<unknown>>,
  work: Promise<T>,
): Promise<T> {
  set.add(work);
  void work.finally(() => set.delete(work)).catch(() => undefined);
  return work;
}

export function isLocalDataResetBlocked(): boolean {
  return resetInProgress || resetRecoveryRequired;
}

export function beginLocalDataReset(): void {
  if (resetInProgress) throw new Error("LOCAL_DATA_RESET_IN_PROGRESS");
  resetInProgress = true;
}

export function finishLocalDataReset(recoveryRequired: boolean): void {
  resetRecoveryRequired = recoveryRequired;
  resetInProgress = false;
}

export function setLocalDataResetRecoveryRequired(required: boolean): void {
  resetRecoveryRequired = required;
}

export async function settleTrackedDataJobs(): Promise<void> {
  await Promise.allSettled([...backgroundDataJobs, ...offscreenRequests]);
}

export function trackOffscreenRequest<T>(work: Promise<T>): Promise<T> {
  return trackWork(offscreenRequests, work);
}

export function runBackgroundDataJob<T>(work: () => Promise<T>): Promise<T> {
  if (isLocalDataResetBlocked()) {
    return Promise.reject(new Error("LOCAL_DATA_RESET_IN_PROGRESS"));
  }
  return trackWork(backgroundDataJobs, work());
}

export async function sendForwardedToOffscreen<T>(
  request: OffscreenRequest,
): Promise<T> {
  const isResetControlRequest =
    (request.service === "dbManager" && request.type === "deleteAllData") ||
    (request.service === "cloudSync" && request.type === "cancelAndClear");
  if (isLocalDataResetBlocked() && !isResetControlRequest) {
    throw new Error("LOCAL_DATA_RESET_IN_PROGRESS");
  }

  return trackOffscreenRequest(
    (async () => {
      await setupOffscreenDocument();
      const rawResponse = await chrome.runtime.sendMessage({
        ...request,
        target: "offscreen",
        isForwarded: true,
      });
      const response = offscreenResponseSchema.parse(rawResponse);
      if (!response.success) {
        throw new Error(
          response.error || `${request.service}.${request.type} failed`,
        );
      }
      // SAFETY: The caller's generic is the registered offscreen method's return
      // contract. The transport envelope and JSON payload were parsed above; the
      // router owns method-to-payload compatibility until typed RPC is introduced.
      return response.payload as T;
    })(),
  );
}
