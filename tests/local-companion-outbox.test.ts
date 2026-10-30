import { expect, test } from "bun:test";
import { LocalCompanionOutbox, LOCAL_OUTBOX_MAX_JOBS, localOutboxJobsSchema, type LocalOutboxJob, type LocalOutboxStorage } from "@src/services/local-companion-outbox";
import { LocalCompanionError, type LocalCapture, type LocalRequest, type LocalSaveResult } from "@src/services/local-companion-protocol";

const capture = (): LocalCapture => ({ id: crypto.randomUUID(), url: "https://example.com", title: "Original page", text: "Original rendered text", capturedAt: 1000, gaps: ["Frame content omitted"] });
class MemoryStorage implements LocalOutboxStorage {
  value: unknown = undefined;
  failNextWrite = false;
  async read() {
    const raw = structuredClone(this.value);
    if (raw === undefined) return [];
    const parsed = localOutboxJobsSchema.safeParse(raw);
    if (!parsed.success) throw new LocalCompanionError("LOCAL_OUTBOX_UNREADABLE");
    return parsed.data;
  }
  async write(jobs: LocalOutboxJob[]) { if (this.failNextWrite) { this.failNextWrite = false; throw new Error("Storage interrupted"); } this.value = structuredClone(jobs); }
}
const receipt = (request: LocalRequest): LocalSaveResult => {
  if (request.action !== "save") throw new Error("Unexpected request");
  return { captureId: request.capture.id, itemId: "item", saved: true, replayed: false, cloudSynced: false };
};

test("lost acknowledgement survives worker restart and retries the same entire snapshot", async () => {
  const storage = new MemoryStorage();
  const original = capture();
  const sent: LocalRequest[] = [];
  const first = new LocalCompanionOutbox({ storage, now: () => 1000, send: async (request) => { sent.push(structuredClone(request)); throw new LocalCompanionError("COMPANION_UNAVAILABLE"); } });
  await first.enqueue(original);
  expect(await first.flush()).toEqual([]);
  const restarted = new LocalCompanionOutbox({ storage, now: () => 100000, send: async (request) => { sent.push(structuredClone(request)); return { ...receipt(request), replayed: true }; } });
  const acknowledged = await restarted.flush();
  expect(sent).toHaveLength(2);
  expect(sent[1]).toEqual(sent[0]);
  expect(acknowledged[0]?.replayed).toBe(true);
  expect(await restarted.summary()).toEqual([]);
});

test("storage interruption after host acknowledgement cannot lose the capture", async () => {
  const storage = new MemoryStorage();
  const original = capture();
  const sent: LocalRequest[] = [];
  const outbox = new LocalCompanionOutbox({ storage, now: () => 1000, send: async (request) => { sent.push(structuredClone(request)); if (sent.length === 1) storage.failNextWrite = true; return receipt(request); } });
  await outbox.enqueue(original);
  expect(await outbox.flush()).toEqual([]);
  expect((await outbox.summary())[0]?.id).toBe(original.id);
  await outbox.flush({ force: true });
  expect(sent[1]).toEqual(sent[0]);
  expect(await outbox.summary()).toEqual([]);
});

test("an index upgrade retains the snapshot and retries the same identity after readiness", async () => {
  const storage = new MemoryStorage();
  const original = capture();
  const sent: LocalRequest[] = [];
  const upgrading = new LocalCompanionOutbox({ storage, now: () => 1000, send: async (request) => {
    sent.push(structuredClone(request));
    throw new LocalCompanionError("INDEX_UPGRADING");
  } });
  await upgrading.enqueue(original);
  expect(await upgrading.flush()).toEqual([]);
  expect((await upgrading.summary())[0]).toMatchObject({ id: original.id, state: "pending", lastError: "INDEX_UPGRADING" });
  const ready = new LocalCompanionOutbox({ storage, now: () => 100000, send: async (request) => {
    sent.push(structuredClone(request));
    return receipt(request);
  } });
  expect(await ready.flush()).toHaveLength(1);
  expect(sent[1]).toEqual(sent[0]);
  expect(await ready.summary()).toEqual([]);
});

test("permanent invalid/conflicting captures are preserved as blocked without automatic retries", async () => {
  for (const code of ["NATIVE_INVALID_REQUEST", "NATIVE_CAPTURE_ID_CONFLICT"]) {
    const storage = new MemoryStorage();
    let sends = 0;
    const outbox = new LocalCompanionOutbox({ storage, send: async () => { sends++; throw new LocalCompanionError(code); } });
    await outbox.enqueue(capture());
    await outbox.flush({ force: true });
    expect((await outbox.summary())[0]?.state).toBe("blocked");
    await outbox.flush({ force: true });
    expect(sends).toBe(1);
  }
});

test("concurrent saves serialize durable writes and a full queue never evicts earlier captures", async () => {
  const storage = new MemoryStorage();
  const outbox = new LocalCompanionOutbox({ storage, send: async (request) => receipt(request) });
  const captures = Array.from({ length: LOCAL_OUTBOX_MAX_JOBS }, capture);
  await Promise.all(captures.map((value) => outbox.enqueue(value)));
  expect(await outbox.summary()).toHaveLength(LOCAL_OUTBOX_MAX_JOBS);
  await expect(outbox.enqueue(capture())).rejects.toThrow("LOCAL_OUTBOX_FULL");
  expect((await outbox.summary()).map((job) => job.id)).toEqual(captures.map((value) => value.id));
});

test("a malformed or wrong capture acknowledgement remains pending and corrupt storage is preserved", async () => {
  const storage = new MemoryStorage();
  const outbox = new LocalCompanionOutbox({ storage, send: async (request) => ({ ...receipt(request), captureId: crypto.randomUUID() }) });
  await outbox.enqueue(capture());
  await outbox.flush({ force: true });
  expect((await outbox.summary())[0]?.lastError).toBe("INVALID_COMPANION_RESPONSE");
  storage.value = { corrupted: true };
  await expect(outbox.summary()).rejects.toThrow("LOCAL_OUTBOX_UNREADABLE");
  expect(storage.value).toEqual({ corrupted: true });
});

test("blocked snapshots can be inspected, explicitly repaired and dismissed without identity mutation or eviction", async () => {
  const storage = new MemoryStorage();
  let refused = true;
  const sent: LocalRequest[] = [];
  const outbox = new LocalCompanionOutbox({ storage, send: async request => { sent.push(structuredClone(request)); if (refused) throw new LocalCompanionError("NATIVE_INVALID_REQUEST"); return receipt(request); } });
  const originals = Array.from({ length: LOCAL_OUTBOX_MAX_JOBS }, capture);
  for (const original of originals) await outbox.enqueue(original);
  await outbox.flush({ captureId: originals[0]!.id, force: true });
  const exported = await outbox.inspect(originals[0]!.id);
  expect(exported).toEqual(originals[0]);
  exported.text = "Mutating an inspection cannot mutate the preserved snapshot";
  expect(await outbox.inspect(originals[0]!.id)).toEqual(originals[0]);
  await expect(outbox.enqueue(capture())).rejects.toThrow("LOCAL_OUTBOX_FULL");
  await outbox.repair(originals[0]!.id);
  refused = false;
  await outbox.flush({ captureId: originals[0]!.id, force: true });
  expect(sent[1]).toEqual(sent[0]);
  const newCapture = capture(); await outbox.enqueue(newCapture);
  await outbox.dismiss(originals[1]!.id);
  expect((await outbox.summary()).map(job => job.id)).toEqual([...originals.slice(2).map(value => value.id), newCapture.id]);
  await expect(outbox.inspect(originals[1]!.id)).rejects.toThrow("LOCAL_CAPTURE_NOT_FOUND");
});
