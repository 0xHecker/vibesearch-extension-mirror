import { z } from "zod";
import { localPendingSummarySchema } from "./local-companion-outbox";
import { localMigrationProgressSchema, localOriginalResultSchema, localCaptureSchema, localReadResultSchema, localCommandSchema, localSaveResultSchema, localSearchResultSchema, localStatusResultSchema, type LocalCommand, type LocalReadResult, type LocalCapture, type LocalSearchResult } from "./local-companion-protocol";

export const localViewStatusSchema = z.object({
  companion: z.discriminatedUnion("state", [
    z.object({ state: z.literal("disabled") }).strict(),
    z.object({ state: z.literal("available"), details: localStatusResultSchema }).strict(),
    z.object({ state: z.literal("unavailable"), error: z.string() }).strict(),
  ]),
  pending: z.array(localPendingSummarySchema),
}).strict();
export type LocalViewStatus = z.infer<typeof localViewStatusSchema>;
export const localSaveOutcomeSchema = z.discriminatedUnion("state", [
  z.object({ state: z.literal("saved"), receipt: localSaveResultSchema, gaps: z.array(z.string()) }).strict(),
  z.object({ state: z.literal("pending"), captureId: z.uuid(), gaps: z.array(z.string()) }).strict(),
  z.object({ state: z.literal("blocked"), captureId: z.uuid(), gaps: z.array(z.string()), error: z.string() }).strict(),
]);
export type LocalSaveOutcome = z.infer<typeof localSaveOutcomeSchema>;
export type LocalCommandResult = LocalViewStatus | LocalSaveOutcome | LocalSearchResult | LocalReadResult | LocalCapture | z.infer<typeof localMigrationProgressSchema> | z.infer<typeof localOriginalResultSchema>;
const responseSchema = z.discriminatedUnion("ok", [
  z.object({ ok: z.literal(true), result: z.unknown() }).strict(),
  z.object({ ok: z.literal(false), error: z.string() }).strict(),
]);

async function callLocal<Result>(command: LocalCommand, schema: z.ZodType<Result>): Promise<Result> {
  const response: unknown = await chrome.runtime.sendMessage(localCommandSchema.parse(command));
  const parsed = responseSchema.parse(response);
  if (!parsed.ok) throw new Error(parsed.error);
  return schema.parse(parsed.result);
}
export const localClient = {
  async importLegacy() { return callLocal({ target: "local-companion", action: "import-legacy" }, localMigrationProgressSchema); },
  async original(itemId: string, mediaId: string, offset = 0) { return callLocal({ target: "local-companion", action: "read-original", itemId, mediaId, offset }, localOriginalResultSchema); },
  async queuedOriginal(captureId: string, mediaId: string, offset = 0) { return callLocal({ target: "local-companion", action: "inspect-outbox-original", captureId, mediaId, offset }, localOriginalResultSchema); },
  async screenshot(tabId: number, mode: "visible" | "region" = "visible") { return callLocal({ target: "local-companion", action: "save-screenshot", tabId, mode }, localSaveOutcomeSchema); },
  async status() { return callLocal({ target: "local-companion", action: "status" }, localViewStatusSchema); },
  async saveTab(tabId: number) { return callLocal({ target: "local-companion", action: "save-tab", tabId }, localSaveOutcomeSchema); },
  async retry() { return callLocal({ target: "local-companion", action: "retry" }, localViewStatusSchema); },
  async search(query: string, cursor?: string) { return callLocal({ target: "local-companion", action: "search", query, cursor, limit: 20 }, localSearchResultSchema); },
  async read(itemId: string, options: { partId?: string; sourceHash?: string; start?: number } = {}) { return callLocal({ target: "local-companion", action: "read", itemId, start: 0, maxChars: 8000, ...options }, localReadResultSchema); },
  async inspect(captureId: string) { return callLocal({ target: "local-companion", action: "inspect-outbox", captureId }, localCaptureSchema); },
  async dismiss(captureId: string) { return callLocal({ target: "local-companion", action: "dismiss-outbox", captureId }, localViewStatusSchema); },
  async repair(captureId: string) { return callLocal({ target: "local-companion", action: "repair-outbox", captureId }, localViewStatusSchema); },
};

export function describeLocalError(cause: unknown): string {
  const code = cause instanceof Error ? cause.message : "LOCAL_OPERATION_FAILED";
  switch (code) {
    case "LOCAL_PERMISSION_REQUIRED": return "Enable the local companion permission to continue.";
    case "LOCAL_OUTBOX_FULL": return "The local queue is full. Retry saves or export and dismiss captures in the local library to make room.";
    case "LOCAL_OUTBOX_UNREADABLE": return "The local queue could not be read. Your pending captures were preserved.";
    case "LOCAL_PAGE_UNAVAILABLE": return "Open an HTTP or HTTPS page and try saving it again.";
    case "LOCAL_CAPTURE_FAILED": return "This browser page cannot be captured. Open a normal web page and try again.";
    case "SEARCH_REFRESH_REQUIRED": return "The library changed. Search again to continue with current results.";
    case "SOURCE_CHANGED": return "The source changed. Open the saved item again.";
    case "INDEX_UPGRADING": return "Your local library is updating its search index. Pending saves are preserved. Check the connection again shortly.";
    case "INDEX_UPGRADE_FAILED": return "The search index update could not finish. Your saved sources and pending captures are preserved. Run the companion doctor, then restart it.";
    case "COMPANION_UNAVAILABLE":
    case "COMPANION_TIMEOUT": return "The local companion is unavailable. Follow the setup steps, then retry.";
    default: return `The local operation could not finish (${code}).`;
  }
}
