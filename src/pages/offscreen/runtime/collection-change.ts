import type { JsonValue } from "@src/common/json-value";
import { z } from "zod";

const changedDocumentSchema = z
  .object({
    id: z.string().optional(),
    itemId: z.string().optional(),
    name: z.string().optional(),
  })
  .passthrough();

const changeRecordSchema = z
  .object({
    operation: z.string().optional(),
    documentId: z.string().optional(),
    documentData: changedDocumentSchema.optional(),
    previousDocumentData: changedDocumentSchema.optional(),
  })
  .passthrough();

type ChangeRecord = z.infer<typeof changeRecordSchema>;

const changeEnvelopeSchema = z
  .object({ events: z.array(changeRecordSchema) })
  .passthrough();

function recordsFrom(change: JsonValue): ChangeRecord[] {
  const envelope = changeEnvelopeSchema.safeParse(change);
  if (envelope.success) return envelope.data.events;

  const record = changeRecordSchema.safeParse(change);
  return record.success ? [record.data] : [];
}

export function collectChangedItemIds(change: JsonValue): string[] {
  const ids = new Set<string>();
  for (const event of recordsFrom(change)) {
    const candidates = [
      event.documentId,
      event.documentData?.id,
      event.previousDocumentData?.id,
    ];
    for (const id of candidates) {
      if (id) ids.add(id);
    }
  }
  return [...ids];
}

export function collectItemIdsFromTagLinks(change: JsonValue): string[] {
  const ids = new Set<string>();
  for (const event of recordsFrom(change)) {
    const candidates = [
      event.documentData?.itemId,
      event.previousDocumentData?.itemId,
    ];
    for (const id of candidates) {
      if (id) ids.add(id);
    }
  }
  return [...ids];
}

export function didTagNameChange(change: JsonValue): boolean {
  return recordsFrom(change).some((event) => {
    if (event.operation === "DELETE") return true;
    if (event.operation !== "UPDATE") return false;
    return (
      (event.documentData?.name ?? "") !==
      (event.previousDocumentData?.name ?? "")
    );
  });
}
