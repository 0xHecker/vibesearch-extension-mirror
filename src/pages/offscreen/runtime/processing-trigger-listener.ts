import { OCR_SUPPORTED } from "@src/services/ocr.service";
import { z } from "zod";
import { isTrustedForwarderSender } from "./message-security";
import type { ProcessingQueues } from "./processing-queues";

const processingTriggerSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("TRIGGER_EMBEDDING"),
    isForwarded: z.literal(true),
  }),
  z.object({
    type: z.literal("TRIGGER_OCR"),
    isForwarded: z.literal(true),
    payload: z
      .object({
        itemId: z.string().default(""),
        force: z.boolean().default(false),
      })
      .optional(),
  }),
]);

export function listenForProcessingTriggers(queues: ProcessingQueues): void {
  chrome.runtime.onMessage.addListener((rawMessage, sender, sendResponse) => {
    const parsed = processingTriggerSchema.safeParse(rawMessage);
    if (!parsed.success) return;

    if (!isTrustedForwarderSender(sender)) {
      sendResponse({ success: false, error: "UNAUTHORIZED_FORWARDER" });
      return true;
    }

    if (parsed.data.type === "TRIGGER_EMBEDDING") {
      console.log("[Offscreen] Received TRIGGER_EMBEDDING message");
      queues.embedding.trigger();
      sendResponse({ success: true });
      return true;
    }

    if (!OCR_SUPPORTED) {
      sendResponse({
        success: false,
        error: "Local image OCR is unavailable in this browser build.",
      });
      return true;
    }

    const { itemId = "", force = false } = parsed.data.payload ?? {};
    if (itemId) {
      queues.ocr.enqueue(itemId, force);
      queues.ocr.trigger();
      sendResponse({ success: true, payload: { status: "queued" } });
      return true;
    }

    queues.ocr.trigger();
    sendResponse({ success: true });
    return true;
  });
}
