import { transferCompanionBlob } from "./local-companion-originals";
export { transferCompanionBlob } from "./local-companion-originals";
import { z } from "zod";
import { getDb } from "./DatabaseService";
import { readOpfsFile } from "./media-storage";
import { getOffscreenArchiveCache, getOffscreenArchiveOutboxReader } from "./archive-migration-storage-bridge";
import { ARCHIVE_OUTBOX_MAX_FILE_BYTES } from "./archive-outbox";
import { COMPANION_IMPORT_KEY, runtimeOffscreenStorage } from "./offscreen-storage-bridge";
export { COMPANION_IMPORT_KEY } from "./offscreen-storage-bridge";
import { readIdKeysetPage } from "./rxdb-keyset-pagination";
import { requestLocalNative } from "./local-companion-native";
import { localOriginalSchema, localHttpUrlSchema, localMigrationProgressSchema, sliceLocalText } from "./local-companion-protocol";

const checkpointSchema = localMigrationProgressSchema.extend({ version: z.literal(1), profileId: z.uuid() }).strict();
type Original = z.infer<typeof localOriginalSchema>;
const sha256 = async (bytes: ArrayBuffer) => Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)), byte => byte.toString(16).padStart(2, "0")).join("");
const stableId = async (profileId: string, legacyId: string) => `legacy:${await sha256(await new Blob([`${profileId}:${legacyId}`]).arrayBuffer())}`;

let importInFlight: Promise<z.infer<typeof localMigrationProgressSchema>> | null = null;
export function importLegacyToCompanion(): Promise<z.infer<typeof localMigrationProgressSchema>> {
  if (importInFlight) return importInFlight;
  importInFlight = importBatch().finally(() => { importInFlight = null; });
  return importInFlight;
}
async function importBatch(): Promise<z.infer<typeof localMigrationProgressSchema>> {
  const stored: unknown = (await runtimeOffscreenStorage.get(COMPANION_IMPORT_KEY))[COMPANION_IMPORT_KEY];
  const checkpoint = stored === undefined ? { version: 1 as const, profileId: crypto.randomUUID(), imported: 0, skipped: 0, done: false, lastId: "" } : checkpointSchema.parse(stored);
  // Persist profile identity before any host request; termination cannot mint another library.
  await runtimeOffscreenStorage.set(COMPANION_IMPORT_KEY, checkpoint);
  if (checkpoint.done) return localMigrationProgressSchema.parse({ imported: checkpoint.imported, skipped: checkpoint.skipped, done: checkpoint.done, lastId: checkpoint.lastId });
  const db = await getDb();
  const page = await readIdKeysetPage({ collection: db.items, selector: { deletedAt: 0 }, pageSize: 3, afterId: checkpoint.lastId });
  for (const document of page.documents) {
    const row = document.toMutableJSON();
    const space = row.spaceId ? (await db.spaces.findByIds([row.spaceId]).exec()).get(row.spaceId)?.toMutableJSON() : undefined;
    const chain = [];
    let nextFolder = row.folderId;
    const seen = new Set<string>();
    while (nextFolder) {
      if (seen.has(nextFolder) || chain.length >= 4) throw new Error("IMPORT_FOLDER_HIERARCHY_LIMIT: preserve or simplify this old folder path before retrying.");
      seen.add(nextFolder);
      const folder = (await db.folders.findByIds([nextFolder]).exec()).get(nextFolder)?.toMutableJSON();
      if (!folder) break;
      chain.unshift(folder); nextFolder = folder.parentId ?? "";
    }
    if (space?.isPrivate || chain.some(folder => folder.isLocked)) {
      checkpoint.skipped++; checkpoint.lastId = row.id;
      await runtimeOffscreenStorage.set(COMPANION_IMPORT_KEY, checkpoint); continue;
    }
    const warnings: string[] = [];
    const originals: Original[] = [];
    for (const [index, media] of (row.media ?? []).entries()) {
      if (media.storageType !== "opfs" || !media.opfsPath) { warnings.push(`Media ${index + 1} is remote; no network download was attempted.`); continue; }
      const blob = await readOpfsFile(media.opfsPath);
      if (!blob) throw new Error("IMPORT_ORIGINAL_MISSING: a referenced browser file is unavailable; no item checkpoint was advanced.");
      originals.push(await transferCompanionBlob(blob, { id: `media-${index}`, type: media.type, mimeType: media.mimeType || blob.type || "application/octet-stream", fileName: (media.fileName || `media-${index}`).slice(0, 256) }));
    }
    const pendingArchives = getOffscreenArchiveOutboxReader();
    const pendingArchive = (await pendingArchives.list())
      .filter(entry => entry.itemId === row.id && entry.mode === "upload")
      .sort((left, right) => right.updatedAt - left.updatedAt)[0];
    const pendingBody = pendingArchive?.fileName ? await pendingArchives.read(pendingArchive.fileName) : null;
    if (pendingArchive && (!pendingBody || pendingBody.size !== pendingArchive.byteSize || pendingBody.size < 20 || pendingBody.size > ARCHIVE_OUTBOX_MAX_FILE_BYTES)) {
      throw new Error("IMPORT_ORIGINAL_MISSING: a pending browser archive is unavailable; no item checkpoint was advanced.");
    }
    const archive = pendingBody ?? await getOffscreenArchiveCache().get(row.id);
    if (archive) originals.push(await transferCompanionBlob(archive, { id: "archive", type: "file", mimeType: archive.type || "text/html", fileName: "page-archive.html" }));
    const joinRows = await db.item_tags.find({ selector: { itemId: row.id, deletedAt: 0 } }).exec();
    const userIds = joinRows.map(value => value.toMutableJSON()).filter(value => value.origin !== "automatic").map(value => value.tagId);
    const tags = await db.tags.findByIds(userIds).exec();
    const userTags = [...new Set(Array.from(tags.values()).map(value => value.toMutableJSON().name))];
    const folders = await Promise.all(chain.map(async folder => ({ id: await stableId(checkpoint.profileId, folder.id), name: folder.name.slice(0, 128) || "Imported folder", parentId: folder.parentId ? await stableId(checkpoint.profileId, folder.parentId) : null })));
    const text = [row.textContent, ...(row.blocks ?? []).map(block => block.text ?? ""), row.ocrText ?? ""].filter(Boolean).join("\n\n");
    if (text.length > 500000) warnings.push("Search text is bounded to 500,000 characters. The complete old item remains in the original JSON file.");
    const parsedUrl = localHttpUrlSchema.safeParse(row.url);
    const url = parsedUrl.success ? parsedUrl.data : undefined;
    const source = {
      title: row.title.slice(0, 2000), text: sliceLocalText(text, 500000), kind: "text", canonicalUrl: url,
      metadata: { capturedBy: "legacy-browser", legacyProfileId: checkpoint.profileId, legacyItemId: row.id, legacySpaceId: row.spaceId, legacySpaceName: space?.name ?? "", legacySource: row.source, legacyUpdatedAt: String(row.updatedAt) },
    };
    const payload = { version: 1, profileId: checkpoint.profileId, legacyId: row.id, source,
      user: { title: row.title.slice(0, 4096) || "Imported item", personalNote: "", userTags, archived: space?.isArchived ?? false, favorite: row.isFavorite, folderId: folders.at(-1)?.id ?? null },
      folders, warnings, createdAt: row.createdAt, originalRow: row };
    const sourceBlob = new Blob([JSON.stringify(payload)], { type: "application/json" });
    if (sourceBlob.size > 8 * 1024 * 1024) throw new Error("IMPORT_SOURCE_TOO_LARGE: full browser row exceeds 8 MiB; the browser copy remains intact.");
    const original = await transferCompanionBlob(sourceBlob, { id: "legacy-record", type: "file", mimeType: "application/json", fileName: "legacy-item.json" });
    await requestLocalNative({ version: 1, id: crypto.randomUUID(), action: "import-record", profileId: checkpoint.profileId, legacyId: row.id, source: original, originals });
    checkpoint.imported++; checkpoint.lastId = row.id;
    await runtimeOffscreenStorage.set(COMPANION_IMPORT_KEY, checkpoint);
  }
  checkpoint.done = !page.hasMore;
  await runtimeOffscreenStorage.set(COMPANION_IMPORT_KEY, checkpoint);
  return localMigrationProgressSchema.parse({ imported: checkpoint.imported, skipped: checkpoint.skipped, done: checkpoint.done, lastId: checkpoint.lastId });
}
