import type { JsonValue } from "@src/common/json-value";
import { z } from "zod";

import type { TagEntry } from "./model";

const tagEntrySchema: z.ZodType<TagEntry> = z.object({
  id: z.string(),
  name: z.string(),
  color: z.string().nullable().optional(),
});

const tagListResponseSchema = z.object({
  success: z.boolean(),
  error: z.string().optional(),
  payload: z.array(tagEntrySchema).optional(),
});

const commandResponseSchema = z.object({
  success: z.boolean(),
  error: z.string().optional(),
  payload: z.json().optional(),
});

const nestedCommandResultSchema = z.object({
  success: z.boolean(),
  error: z.string().optional(),
});

const ocrPayloadSchema = z.object({
  text: z.string(),
  confidence: z.number().optional(),
});

const ocrResponseSchema = z.object({
  success: z.boolean(),
  payload: ocrPayloadSchema.optional(),
});

export function parseTagListResponse(response: JsonValue): TagEntry[] {
  const parsed = tagListResponseSchema.parse(response);
  if (!parsed.success) {
    throw new Error(parsed.error ?? "Failed to load tags.");
  }
  return parsed.payload ?? [];
}

export function requireCommandSuccess(
  response: JsonValue,
  fallbackError: string,
): void {
  const parsed = commandResponseSchema.parse(response);
  if (!parsed.success) throw new Error(parsed.error ?? fallbackError);

  const nestedResult = nestedCommandResultSchema.safeParse(parsed.payload);
  if (nestedResult.success && !nestedResult.data.success) {
    throw new Error(nestedResult.data.error ?? fallbackError);
  }
}

export function parseOcrResponse(
  response: JsonValue,
): z.infer<typeof ocrPayloadSchema> | null {
  const parsed = ocrResponseSchema.parse(response);
  if (!parsed.success) return null;
  return parsed.payload ?? null;
}
