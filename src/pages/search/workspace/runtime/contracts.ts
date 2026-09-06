import type { SearchProcessStatusItem } from "@src/pages/search/components/SearchProcessStatus";
import { z } from "zod";

/** Messages accepted by the mounted search page from extension runtimes. */
const retryActionSchema = z.enum([
  "RETRY_QUERY",
  "TRIGGER_EMBEDDING",
  "TRIGGER_OCR",
  "REBUILD_INDEX",
  "REBUILD_VECTORS",
  "LOCK_PRIVATE_SPACE",
  "RETRY_IMPORT",
]);

const processStatusSchema: z.ZodType<SearchProcessStatusItem> = z.object({
  id: z.string(),
  label: z.string(),
  state: z.enum(["processing", "success", "error"]),
  detail: z.string(),
  updatedAt: z.number(),
  retryAction: retryActionSchema.optional(),
});

const processStatusEventSchema = z.object({
  type: z.literal("PROCESS_STATUS"),
  payload: processStatusSchema,
});

const databaseChangeEventSchema = z.object({
  type: z.literal("DB_CHANGE"),
  scope: z.enum(["items", "folders", "tags", "spaces", "space_groups"]),
  changedItemIds: z.array(z.string()).optional(),
  itemChangeKind: z.enum(["content", "metadata"]).optional(),
});

const searchRuntimeEventSchema = z.discriminatedUnion("type", [
  processStatusEventSchema,
  databaseChangeEventSchema,
]);

export type SearchRuntimeEvent = z.infer<typeof searchRuntimeEventSchema>;

export function parseSearchRuntimeEvent(value: any): SearchRuntimeEvent | null {
  const result = searchRuntimeEventSchema.safeParse(value);
  return result.success ? result.data : null;
}

const sidePanelStorageSchema = z.object({
  sidePanelOpen: z.boolean().optional(),
});

export function parseSidePanelOpen(value: any): boolean | null {
  const result = sidePanelStorageSchema.safeParse(value);
  return result.success ? (result.data.sidePanelOpen ?? null) : null;
}
