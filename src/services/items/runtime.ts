import { PRIVATE_SPACE_ID } from "@src/common/spaces";
import { spaceSessionService } from "@src/services/space-session.service";
import { z } from "zod";

const directConflictSchema = z.object({ status: z.literal(409) }).passthrough();
const rxdbConflictSchema = z.object({
  rxdb: z.object({ status: z.literal(409) }).passthrough(),
}).passthrough();
const nestedConflictSchema = z.object({
  parameters: z.object({
    writeError: z.object({ status: z.literal(409) }).passthrough(),
  }).passthrough(),
}).passthrough();

export type BackgroundProcessingType = "TRIGGER_EMBEDDING" | "TRIGGER_OCR";

export { notifyDatabaseChanged } from "@src/services/database/notifications";

export function assertSpaceUnlocked(spaceId: string): void {
  if (spaceId === PRIVATE_SPACE_ID && !spaceSessionService.isUnlocked(PRIVATE_SPACE_ID)) {
    throw new Error("PRIVATE_SPACE_LOCKED");
  }
}

/** Parse the few RxDB conflict shapes observed at the library boundary. */
export function isWriteConflict(error: any): boolean {
  return (
    directConflictSchema.safeParse(error).success ||
    rxdbConflictSchema.safeParse(error).success ||
    nestedConflictSchema.safeParse(error).success
  );
}

export function triggerBackgroundProcessing(type: BackgroundProcessingType): void {
  try {
    void Promise.resolve(
      chrome.runtime.sendMessage({ type, target: "background" }),
    ).catch(() => undefined);
  } catch {
    // Background processing will be retried by the normal extension lifecycle.
  }
}
