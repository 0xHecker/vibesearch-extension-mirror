import { preserveLocalSnapshot, readLocalSnapshot, removeLocalSnapshots, readSnapshotWindow, transferCompanionBlob } from "@src/services/local-companion-originals";
import type { LocalOutboxFile } from "@src/services/local-companion-outbox";
import { captureScreenshotBlob, collectContextFromTab } from "./import-context";
import { selectScreenshotRegion } from "./import-ui";
import { cropLocalSnapshot } from "@src/services/local-snapshot-crop";
import { sendForwardedToOffscreen } from "./runtime";
import { captureLocalVisibleText } from "@src/content/local-visible-text";
import { localViewStatusSchema, type LocalCommandResult, type LocalSaveOutcome, type LocalViewStatus } from "@src/services/local-companion-client";
import { requestLocalNative } from "@src/services/local-companion-native";
import { LOCAL_COMPANION_RETRY_ALARM as RETRY_ALARM, LOCAL_OUTBOX_STORAGE_KEY, LocalCompanionOutbox, localOutboxJobsSchema } from "@src/services/local-companion-outbox";
import { z } from "zod";
import type { ImportClickContext } from "./import-types";
import type { LocalCapture } from "@src/services/local-companion-protocol";
import { isLocalCompanionSender } from "@src/services/local-companion-security";
import { fitLocalCapture, LocalCompanionError, localCommandSchema, localHttpUrlSchema, localSearchResultSchema, localReadResultSchema, localOriginalResultSchema, localMigrationProgressSchema, localStatusResultSchema, type LocalCommand } from "@src/services/local-companion-protocol";

const outbox = new LocalCompanionOutbox({
  storage: {
    async read() {
      const raw: unknown = (await chrome.storage.local.get(LOCAL_OUTBOX_STORAGE_KEY))[LOCAL_OUTBOX_STORAGE_KEY];
      if (raw === undefined) return [];
      const parsed = localOutboxJobsSchema.safeParse(raw);
      if (!parsed.success) throw new LocalCompanionError("LOCAL_OUTBOX_UNREADABLE");
      return parsed.data;
    },
    async write(jobs) { await chrome.storage.local.set({ [LOCAL_OUTBOX_STORAGE_KEY]: jobs }); },
  },
  async send(request, files) {
    for (const file of files) { const blob = await readLocalSnapshot(file); await transferCompanionBlob(blob, file.original); }
    return requestLocalNative(request);
  },
  removeFiles: removeLocalSnapshots,
});
const hasPermission = () => chrome.permissions.contains({ permissions: ["nativeMessaging"] });

async function scheduleRetry(): Promise<void> {
  const pending = (await outbox.summary()).filter((job) => job.state === "pending");
  if (!pending.length || !(await hasPermission())) { await chrome.alarms.clear(RETRY_ALARM); return; }
  const next = Math.min(...pending.map((job) => job.nextAttemptAt));
  await chrome.alarms.create(RETRY_ALARM, { when: Math.max(Date.now() + 60000, next) });
}

async function status(): Promise<LocalViewStatus> {
  const pending = await outbox.summary();
  if (!(await hasPermission())) return { companion: { state: "disabled" }, pending };
  try {
    const details = localStatusResultSchema.parse(await requestLocalNative({ version: 1, id: crypto.randomUUID(), action: "status" }));
    return { companion: { state: "available", details }, pending };
  } catch (error) {
    return { companion: { state: "unavailable", error: error instanceof LocalCompanionError ? error.code : "INVALID_COMPANION_RESPONSE" }, pending };
  }
}

export async function saveLocalTab(tabId: number): Promise<LocalSaveOutcome> {
  const tab = await chrome.tabs.get(tabId).catch(() => undefined);
  if (!tab || !localHttpUrlSchema.safeParse(tab.url).success) throw new LocalCompanionError("LOCAL_PAGE_UNAVAILABLE");
  let snapshot: ReturnType<typeof captureLocalVisibleText>;
  try {
    const results = await chrome.scripting.executeScript({ target: { tabId }, func: captureLocalVisibleText });
    const captured = results[0]?.result;
    if (!captured) throw new Error("EMPTY_CAPTURE");
    snapshot = captured;
  } catch { throw new LocalCompanionError("LOCAL_CAPTURE_FAILED"); }
  const capture = fitLocalCapture({ ...snapshot, id: crypto.randomUUID(), capturedAt: Date.now() });
  return saveLocalCapture(capture);
}

export async function saveLocalScreenshot(tabId: number, mode: "visible" | "region" = "visible"): Promise<LocalSaveOutcome> {
  const tab = await chrome.tabs.get(tabId);
  const url = localHttpUrlSchema.parse(tab.url);
  const active = async () => {
    const [current] = await chrome.tabs.query({ active: true, windowId: tab.windowId });
    const same = await chrome.tabs.get(tabId);
    if (current?.id !== tabId || same.url !== url) throw new LocalCompanionError("LOCAL_TAB_CHANGED");
  };
  await active();
  const selection = mode === "region" ? await selectScreenshotRegion(tab) : null;
  if (selection && selection.status !== "selected") throw new LocalCompanionError(selection.status === "cancelled" ? "LOCAL_CAPTURE_CANCELLED" : "LOCAL_REGION_UNAVAILABLE");
  await active();
  const snapshot = (await chrome.scripting.executeScript({ target: { tabId }, func: captureLocalVisibleText }))[0]?.result;
  if (!snapshot || snapshot.url !== url) throw new LocalCompanionError("LOCAL_TAB_CHANGED");
  // Region overlays finish before pixels are captured; an unavailable crop never saves the whole tab.
  if (selection) await new Promise(resolve => setTimeout(resolve, 150));
  const captured = await captureScreenshotBlob(collectContextFromTab(tab), tab);
  await active();
  const blob = selection?.status === "selected" ? await cropLocalSnapshot(captured.blob, selection.selection) : captured.blob;
  const id = crypto.randomUUID();
  const file = await preserveLocalSnapshot(id, blob);
  const capture = fitLocalCapture({ ...snapshot, id, kind: "image", capturedAt: Date.now(), originals: [file.original],
    gaps: [...snapshot.gaps.slice(0, 14), mode === "region" ? "Original image contains only the selected region." : "Original image contains the visible tab viewport.", "Image OCR was not requested; page text accompanies the original pixels."] });
  return saveLocalCapture(capture, [file]);
}

export async function saveLocalContext(context: ImportClickContext, tab?: chrome.tabs.Tab): Promise<LocalSaveOutcome> {
  if (!context.selectionText && !context.linkUrl && !context.mediaUrl && tab?.id !== undefined) return saveLocalTab(tab.id);
  const url = localHttpUrlSchema.parse(context.mediaUrl || context.linkUrl || context.frameUrl || context.pageUrl || context.tabUrl);
  return saveLocalCapture(fitLocalCapture({ id: crypto.randomUUID(), url, title: context.tabTitle.slice(0, 2000),
    text: context.selectionText.slice(0, 120000), capturedAt: Date.now(),
    gaps: [context.selectionText ? "Only the selected text was captured." : "The selected link or media URL was saved; its content has not been extracted."] }));
}

async function saveLocalCapture(capture: LocalCapture, files: LocalOutboxFile[] = []): Promise<LocalSaveOutcome> {
  try { await outbox.enqueue(capture, files); } catch (error) { if (!(await outbox.summary()).some(job => job.id === capture.id)) await removeLocalSnapshots(files).catch(() => {}); throw error; }
  // Schedule before opening the native port so browser termination cannot strand a new job.
  await scheduleRetry();
  const receipts = await outbox.flush({ captureId: capture.id, force: true, limit: 1 });
  await scheduleRetry();
  const receipt = receipts[0];
  if (receipt) return { state: "saved", receipt, gaps: capture.gaps };
  const job = (await outbox.summary()).find((entry) => entry.id === capture.id);
  if (job?.state === "blocked") return { state: "blocked", captureId: capture.id, gaps: capture.gaps, error: job.lastError };
  return { state: "pending", captureId: capture.id, gaps: capture.gaps };
}

async function dispatch(command: LocalCommand): Promise<LocalCommandResult> {
  if (command.action === "status") return localViewStatusSchema.parse(await status());
  if (command.action === "inspect-outbox-original") { const file = (await outbox.files(command.captureId)).find(value => value.original.id === command.mediaId); if (!file) throw new LocalCompanionError("LOCAL_ORIGINAL_MISSING"); return readSnapshotWindow(file, command.offset); }
  if (command.action === "inspect-outbox") return outbox.inspect(command.captureId);
  if (command.action === "dismiss-outbox") { await outbox.dismiss(command.captureId); await scheduleRetry(); return status(); }
  if (command.action === "repair-outbox") { await outbox.repair(command.captureId); if (await hasPermission()) await outbox.flush({ captureId: command.captureId, force: true, limit: 1 }); await scheduleRetry(); return status(); }
  if (!(await hasPermission())) throw new LocalCompanionError("LOCAL_PERMISSION_REQUIRED");
  switch (command.action) {
    case "save-screenshot": return saveLocalScreenshot(command.tabId, command.mode);
    case "save-tab": return saveLocalTab(command.tabId);
    case "retry":
      await outbox.flush({ force: true, limit: 4 });
      await scheduleRetry();
      return status();
    case "import-legacy": return localMigrationProgressSchema.parse(await sendForwardedToOffscreen({ service: "companionMigration", type: "importBatch" }));
    case "read-original": { const { target, ...options } = command; return localOriginalResultSchema.parse(await requestLocalNative({ version: 1, id: crypto.randomUUID(), ...options })); }
    case "read": { const { target, ...options } = command; return localReadResultSchema.parse(await requestLocalNative({ version: 1, id: crypto.randomUUID(), ...options })); }
    case "search": return localSearchResultSchema.parse(await requestLocalNative({ version: 1, id: crypto.randomUUID(), action: "search", query: command.query, limit: command.limit, cursor: command.cursor }));
  }
}

const localTargetSchema = z.object({ target: z.literal("local-companion") });
chrome.runtime.onMessage.addListener((raw, sender, sendResponse) => {
  if (!localTargetSchema.safeParse(raw).success) return;
  const parsed = localCommandSchema.safeParse(raw);
  if (!parsed.success) { sendResponse({ ok: false, error: "INVALID_LOCAL_COMMAND" }); return; }
  if (!isLocalCompanionSender(sender, parsed.data, chrome.runtime.id, chrome.runtime.getURL(""))) { sendResponse({ ok: false, error: "UNAUTHORIZED_LOCAL_CONTEXT" }); return; }
  void dispatch(parsed.data).then((result) => sendResponse({ ok: true, result })).catch((error) => sendResponse({ ok: false, error: error instanceof Error ? error.message.slice(0, 512) : "LOCAL_OPERATION_FAILED" }));
  return true;
});

async function resumePending(): Promise<void> {
  try {
    if (await hasPermission()) await outbox.flush({ limit: 4 });
    await scheduleRetry();
  } catch { /* Preserve the outbox when browser storage is temporarily unavailable. */ }
}
chrome.alarms.onAlarm.addListener((alarm) => { if (alarm.name === RETRY_ALARM) void resumePending(); });
chrome.runtime.onStartup.addListener(() => { void resumePending(); });
chrome.runtime.onInstalled.addListener(() => { void scheduleRetry().catch(() => undefined); });
chrome.permissions.onAdded.addListener((permissions) => { if (permissions.permissions?.includes("nativeMessaging")) void resumePending(); });
chrome.permissions.onRemoved.addListener((permissions) => { if (permissions.permissions?.includes("nativeMessaging")) void chrome.alarms.clear(RETRY_ALARM); });
void scheduleRetry().catch(() => undefined);
