import type { ItemDocType } from "@src/schemas/item_schema";
import {
  deleteAllMediaForItem,
  deleteMediaFromOpfs,
  type OpfsFileIdentity,
  withOpfsMutationLock,
} from "@src/services/media-storage";
import { forEachIdKeysetPage } from "@src/services/rxdb-keyset-pagination";

const REFERENCE_SCAN_PAGE_SIZE = 200;

export const requestOpfsMediaReconciliation = (): void => {
  try {
    void chrome.runtime.sendMessage({
      target: "background",
      type: "OPFS_MEDIA_RECONCILE_REQUESTED",
    })?.catch?.(() => {});
  } catch {}
};

type OpfsFileDeletion = {
  opfsPath: string;
  expectedIdentity?: OpfsFileIdentity;
};

const itemDirectoryIdFromPath = (opfsPath: string): string | null => {
  const parts = opfsPath.split("/").filter(Boolean);
  return parts.length >= 3 && parts[0] === "media" && parts[1] ? parts[1] : null;
};

const scanRetainedReferences = async (
  db: any,
  onPath: (opfsPath: string) => void
): Promise<void> => {
  await forEachIdKeysetPage({
    collection: db.items,
    // Bin rows are retained data too: deleting their aliased file would make a
    // later restore incomplete. Rows are removed before cleanup is called, so
    // scanning every remaining item protects both live and recoverable media.
    selector: {},
    pageSize: REFERENCE_SCAN_PAGE_SIZE,
    onPage: async (documents: any[]) => {
      for (const document of documents) {
        const media = (document.get("media") as ItemDocType["media"] | undefined) || [];
        for (const entry of media) {
          if (typeof entry?.opfsPath === "string" && entry.opfsPath) {
            onPath(entry.opfsPath);
          }
        }
        const displayImageUrl = document.get("displayImageUrl");
        if (
          typeof displayImageUrl === "string" &&
          displayImageUrl.startsWith("media/")
        ) {
          onPath(displayImageUrl);
        }
      }
    },
  });
};

/** Delete exact files only after proving no retained item still points at them. */
export const deleteUnreferencedOpfsFiles = async (
  db: any,
  files: readonly OpfsFileDeletion[],
  options?: { deleteMediaFromOpfs?: typeof deleteMediaFromOpfs }
): Promise<string[]> => {
  const candidates = new Map<string, OpfsFileIdentity | undefined>();
  for (const file of files) {
    const opfsPath = typeof file?.opfsPath === "string" ? file.opfsPath : "";
    if (opfsPath) candidates.set(opfsPath, file.expectedIdentity);
  }
  if (candidates.size === 0) return [];

  return withOpfsMutationLock(async () => {
    await scanRetainedReferences(db, (opfsPath) => candidates.delete(opfsPath));
    const deleted: string[] = [];
    const deleteFile = options?.deleteMediaFromOpfs || deleteMediaFromOpfs;
    for (const [opfsPath, expectedIdentity] of candidates) {
      if (await deleteFile(opfsPath, expectedIdentity)) deleted.push(opfsPath);
    }
    return deleted;
  });
};

/**
 * Delete item-owned directories in one reference scan. Legacy shallow copies
 * can point into another item's directory, so any retained reference protects the
 * entire directory until that alias is migrated or removed.
 */
export const deleteUnreferencedOpfsItemDirectories = async (
  db: any,
  itemIds: Iterable<string>,
  options?: { deleteAllMediaForItem?: typeof deleteAllMediaForItem }
): Promise<string[]> => {
  const candidates = new Set(Array.from(itemIds, (id) => (id || "").trim()).filter(Boolean));
  if (candidates.size === 0) return [];

  return withOpfsMutationLock(async () => {
    await scanRetainedReferences(db, (opfsPath) => {
      const ownerId = itemDirectoryIdFromPath(opfsPath);
      if (ownerId) candidates.delete(ownerId);
    });
    const deleted: string[] = [];
    const deleteDirectory = options?.deleteAllMediaForItem || deleteAllMediaForItem;
    for (const itemId of candidates) {
      await deleteDirectory(itemId);
      deleted.push(itemId);
    }
    return deleted;
  });
};
