import { z } from "zod";
import { requireLegacyBrowser } from "@src/services/extension-policy";
import { setupOffscreenDocument } from "@src/services/offscreen-helper";

export type ProcessingTriggerType = "TRIGGER_EMBEDDING" | "TRIGGER_OCR";

type ProcessingTriggerPayload = {
  itemId?: string;
  force?: boolean;
};

const OffscreenResponseSchema = z.object({
  success: z.boolean(),
  error: z.string().optional(),
});

export const isProcessingTrigger = (
  type: unknown,
): type is ProcessingTriggerType =>
  type === "TRIGGER_EMBEDDING" || type === "TRIGGER_OCR";

export const forwardProcessingTriggerToOffscreen = async (
  type: ProcessingTriggerType,
  payload?: ProcessingTriggerPayload,
): Promise<void> => {
  await requireLegacyBrowser();
  await setupOffscreenDocument();
  const rawResponse = await chrome.runtime.sendMessage({
    type,
    target: "offscreen",
    isForwarded: true,
    payload,
  });
  const response = OffscreenResponseSchema.safeParse(rawResponse);
  if (!response.success || !response.data.success) {
    const detail = response.success ? response.data.error : undefined;
    throw new Error(detail || `${type} failed`);
  }
};
