import { expect, test } from "bun:test";
import { transferCompanionBlob, localBlobHash } from "@src/services/local-companion-originals";
import { LocalCompanionOutbox, LOCAL_OUTBOX_MAX_ORIGINAL_BYTES, localOutboxJobsSchema, type LocalOutboxStorage } from "@src/services/local-companion-outbox";
import type { LocalCapture, LocalRequest } from "@src/services/local-companion-protocol";

test("binary transfers resume the durable byte checkpoint and reject an uncommitted final acknowledgment", async () => {
  const bytes = new Uint8Array(140000).fill(19); const blob = new Blob([bytes]); const hash = await localBlobHash(blob);
  let offset = 65536; const sent: number[] = [];
  const result = await transferCompanionBlob(blob, { id: "screenshot", type: "image", mimeType: "image/png", fileName: "screenshot.png" }, async request => {
    if (!request.data) return { contentHash: hash, offset, complete: false };
    sent.push(request.offset); expect(request.offset).toBe(offset); const chunk = Uint8Array.from(atob(request.data), char => char.charCodeAt(0)); expect(chunk).toEqual(bytes.slice(offset, offset + chunk.length)); offset += chunk.length;
    return { contentHash: hash, offset, complete: offset === bytes.length };
  });
  expect(result.contentHash).toBe(hash); expect(sent).toEqual([65536, 131072]);
  await expect(transferCompanionBlob(blob, result, async () => ({ contentHash: hash, offset: blob.size, complete: false }))).rejects.toThrow("INVALID_IMPORT_ACKNOWLEDGEMENT");
});

test("lost binary save acknowledgments preserve the same screenshot and bounded queue capacity without eviction", async () => {
  let stored: unknown = []; const removed: string[] = [];
  const storage: LocalOutboxStorage = { read: async () => localOutboxJobsSchema.parse(structuredClone(stored)), write: async jobs => { stored = structuredClone(jobs); } };
  const sent: LocalRequest[] = []; let lost = true;
  const outbox = new LocalCompanionOutbox({ storage, send: async (request, files) => { sent.push(structuredClone(request)); expect(files[0]?.original).toEqual(request.capture.originals?.[0]); if (lost) throw new Error("COMPANION_UNAVAILABLE"); return { captureId: request.capture.id, itemId: "saved", saved: true, replayed: true, cloudSynced: false }; }, removeFiles: async files => { removed.push(...files.map(file => file.opfsPath)); } });
  const id = crypto.randomUUID(); const original = { id: "screenshot", contentHash: "a".repeat(64), byteSize: LOCAL_OUTBOX_MAX_ORIGINAL_BYTES, type: "image" as const, mimeType: "image/png", fileName: "screenshot.png" };
  const file = { original, opfsPath: `vibesearch-native-snapshots/${id}.png` };
  const capture: LocalCapture = { id, kind: "image", originals: [original], url: "https://example.invalid", title: "Original tab", text: "Snapshot text", capturedAt: 1000, gaps: [] };
  await outbox.enqueue(capture, [file]); await outbox.flush({ force: true });
  expect(await outbox.inspect(id)).toEqual(capture); expect(removed).toEqual([]);
  const otherId = crypto.randomUUID(); const otherOriginal = { ...original, byteSize: 1 }; const otherFile = { original: otherOriginal, opfsPath: `vibesearch-native-snapshots/${otherId}.png` };
  await expect(outbox.enqueue({ ...capture, id: otherId, originals: [otherOriginal] }, [otherFile])).rejects.toThrow("LOCAL_OUTBOX_FULL");
  expect((await outbox.summary()).map(job => job.id)).toEqual([id]);
  lost = false; await outbox.flush({ force: true }); expect(sent[1]).toEqual(sent[0]); expect(removed).toEqual([file.opfsPath]);
  await outbox.enqueue({ ...capture, id: otherId, originals: [otherOriginal] }, [otherFile]); await outbox.dismiss(otherId); expect(removed).toEqual([file.opfsPath, otherFile.opfsPath]);
});
