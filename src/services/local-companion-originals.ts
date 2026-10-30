import { z } from "zod";
import { requestLocalNative } from "./local-companion-native";
import { localOriginalSchema, type LocalRequest } from "./local-companion-protocol";
import { localOutboxFileSchema, type LocalOutboxFile } from "./local-companion-outbox";

export const LOCAL_SNAPSHOT_DIRECTORY = "vibesearch-native-snapshots";
export const LOCAL_SNAPSHOT_MAX_BYTES = 16 * 1024 * 1024;
type Original = z.infer<typeof localOriginalSchema>;
export const localBlobHash = async (blob: Blob) => Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", await blob.arrayBuffer())), byte => byte.toString(16).padStart(2, "0")).join("");
function base64(bytes: Uint8Array): string {
  let text = ""; for (let index = 0; index < bytes.length; index += 8192) text += String.fromCharCode(...bytes.subarray(index, index + 8192));
  return btoa(text);
}
export async function transferCompanionBlob(blob: Blob, details: Pick<Original, "id" | "type" | "mimeType" | "fileName">, send: (request: Extract<LocalRequest, { action: "import-chunk" }>) => Promise<unknown> = requestLocalNative): Promise<Original> {
  if (blob.size > 128 * 1024 * 1024) throw new Error("IMPORT_ORIGINAL_TOO_LARGE: originals are capped at 128 MiB; your browser copy remains intact.");
  const contentHash = await localBlobHash(blob);
  const original = localOriginalSchema.parse({ ...details, contentHash, byteSize: blob.size });
  const responseSchema = z.object({ contentHash: z.literal(contentHash), offset: z.number().int().min(0).max(blob.size), complete: z.boolean() });
  const probe = responseSchema.parse(await send({ version: 1, id: crypto.randomUUID(), action: "import-chunk", contentHash, byteSize: blob.size, offset: 0, data: "" }));
  if (probe.complete) return original;
  let offset = probe.offset;
  let complete: boolean = probe.complete;
  while (offset < blob.size) {
    const bytes = new Uint8Array(await blob.slice(offset, offset + 65536).arrayBuffer());
    const result = responseSchema.parse(await send({ version: 1, id: crypto.randomUUID(), action: "import-chunk", contentHash, byteSize: blob.size, offset, data: base64(bytes) }));
    if (result.offset <= offset) throw new Error("IMPORT_CHECKPOINT_DID_NOT_ADVANCE");
    offset = result.offset;
    complete = result.complete;
    if (result.complete && offset !== blob.size) throw new Error("INVALID_IMPORT_ACKNOWLEDGEMENT");
  }
  if (!complete) throw new Error("INVALID_IMPORT_ACKNOWLEDGEMENT");
  return original;
}
async function snapshotDirectory() {
  return (await navigator.storage.getDirectory()).getDirectoryHandle(LOCAL_SNAPSHOT_DIRECTORY, { create: true });
}
function snapshotFileName(file: LocalOutboxFile): string {
  return localOutboxFileSchema.parse(file).opfsPath.split("/")[1]!;
}
export async function preserveLocalSnapshot(captureId: string, blob: Blob): Promise<LocalOutboxFile> {
  if (blob.size > LOCAL_SNAPSHOT_MAX_BYTES) throw new Error("LOCAL_SNAPSHOT_TOO_LARGE");
  const original = localOriginalSchema.parse({ id: "screenshot", type: "image", mimeType: "image/png", fileName: "screenshot.png", byteSize: blob.size, contentHash: await localBlobHash(blob) });
  const result = localOutboxFileSchema.parse({ original, opfsPath: `${LOCAL_SNAPSHOT_DIRECTORY}/${captureId}.png` });
  const handle = await (await snapshotDirectory()).getFileHandle(snapshotFileName(result), { create: true });
  const writer = await handle.createWritable();
  try { await writer.write(blob); await writer.close(); } catch (error) { await writer.abort().catch(() => {}); throw error; }
  return result;
}
export async function readLocalSnapshot(file: LocalOutboxFile): Promise<File> {
  let blob: File;
  try { blob = await (await (await snapshotDirectory()).getFileHandle(snapshotFileName(file))).getFile(); }
  catch { throw new Error("LOCAL_ORIGINAL_MISSING"); }
  if (blob.size !== file.original.byteSize || await localBlobHash(blob) !== file.original.contentHash) throw new Error("LOCAL_ORIGINAL_CHANGED");
  return blob;
}
export async function removeLocalSnapshots(files: LocalOutboxFile[]): Promise<void> {
  if (!files.length) return;
  const directory = await snapshotDirectory();
  for (const file of files) await directory.removeEntry(snapshotFileName(file)).catch(() => {});
}
export async function readSnapshotWindow(file: LocalOutboxFile, offset: number) {
  const blob = await readLocalSnapshot(file);
  if (offset > blob.size) throw new Error("INVALID_ORIGINAL_OFFSET");
  const bytes = new Uint8Array(await blob.slice(offset, offset + 65536).arrayBuffer());
  const end = offset + bytes.length;
  return { mediaId: file.original.id, fileName: file.original.fileName, mimeType: file.original.mimeType, contentHash: file.original.contentHash, byteSize: file.original.byteSize, offset, data: base64(bytes), nextOffset: end < blob.size ? end : null };
}
