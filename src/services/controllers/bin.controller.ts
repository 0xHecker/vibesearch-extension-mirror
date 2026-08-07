import { SPACE_NOT_BINNED, computeBinPurgeAt } from "@src/common/spaces";
import {
  DEFAULT_BIN_PAGE_SIZE,
  MAX_BIN_PAGE_SIZE,
  compareBinEntries,
  toBinEntryCursor,
  type BinContentsPage,
  type BinContentsRequest,
  type BinEntry,
  type BinEntryCursor,
} from "@src/common/bin";
import { getDb } from "@src/services/DatabaseService";
import { forEachIdKeysetPage } from "@src/services/rxdb-keyset-pagination";

type BinSpace = {
  id: string;
  name: string;
  isPrivate: boolean;
  deletedAt: number;
  purgeAt: number;
};

type BinFolder = {
  id: string;
  name: string;
  spaceId: string;
  parentId: string | null;
  type: "folder" | "tab_group";
  deletedAt: number;
  purgeAt: number;
};

type RxBinDocument = {
  primary?: string;
  get: (field: string) => unknown;
};

const BIN_SCAN_PAGE_SIZE = 200;
const MAX_BIN_LABEL_LENGTH = 512;

const isBinned = (value: number | undefined | null): boolean =>
  typeof value === "number" && value > SPACE_NOT_BINNED;

const numberField = (doc: RxBinDocument, field: string): number => {
  const value = doc.get(field);
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
};

const stringField = (doc: RxBinDocument, field: string): string => {
  const value = doc.get(field);
  return typeof value === "string" ? value : "";
};

const boundedLabel = (value: string, fallback: string): string => {
  const normalized = value.trim() || fallback;
  return normalized.length <= MAX_BIN_LABEL_LENGTH
    ? normalized
    : `${normalized.slice(0, MAX_BIN_LABEL_LENGTH - 1)}…`;
};

const safeLimit = (value: unknown): number => {
  if (typeof value !== "number" || !Number.isFinite(value)) return DEFAULT_BIN_PAGE_SIZE;
  return Math.max(1, Math.min(MAX_BIN_PAGE_SIZE, Math.floor(value)));
};

const validCursor = (value: unknown): value is BinEntryCursor => {
  if (!value || typeof value !== "object") return false;
  const cursor = value as Partial<BinEntryCursor>;
  return (
    typeof cursor.id === "string" &&
    typeof cursor.name === "string" &&
    typeof cursor.purgeAt === "number" &&
    Number.isFinite(cursor.purgeAt) &&
    (cursor.kind === "space" || cursor.kind === "folder" || cursor.kind === "item")
  );
};

/**
 * Retains only the next `limit + 1` entries while the database is scanned.
 * `limit` is capped, so insertion shifts are bounded and the overall scan is
 * linear in the number of binned rows with a small constant factor.
 */
class BoundedBinPage {
  private readonly selected: BinEntry[] = [];
  private total = 0;

  constructor(
    private readonly limit: number,
    private readonly after: BinEntryCursor | null
  ) {}

  offer(entry: BinEntry): void {
    if (!isBinned(entry.deletedAt)) return;
    this.total += 1;
    if (this.after && compareBinEntries(entry, this.after) <= 0) return;

    let low = 0;
    let high = this.selected.length;
    while (low < high) {
      const middle = (low + high) >>> 1;
      if (compareBinEntries(this.selected[middle], entry) <= 0) low = middle + 1;
      else high = middle;
    }
    this.selected.splice(low, 0, entry);
    if (this.selected.length > this.limit + 1) this.selected.pop();
  }

  result(): BinContentsPage {
    const hasMore = this.selected.length > this.limit;
    const entries = this.selected.slice(0, this.limit);
    return {
      entries,
      total: this.total,
      hasMore,
      nextCursor:
        hasMore && entries.length > 0
          ? toBinEntryCursor(entries[entries.length - 1])
          : null,
    };
  }
}

const readSpaces = async (collection: any): Promise<BinSpace[]> => {
  const spaces: BinSpace[] = [];
  await forEachIdKeysetPage({
    collection,
    selector: { deletedAt: { $gt: SPACE_NOT_BINNED } },
    pageSize: BIN_SCAN_PAGE_SIZE,
    onPage: (docs: RxBinDocument[]) => {
      for (const doc of docs) {
        const id = stringField(doc, "id") || doc.primary || "";
        const deletedAt = numberField(doc, "deletedAt");
        if (!id || !isBinned(deletedAt)) continue;
        spaces.push({
          id,
          name: boundedLabel(stringField(doc, "name"), "Untitled space"),
          isPrivate: doc.get("isPrivate") === true,
          deletedAt,
          purgeAt: numberField(doc, "purgeAt"),
        });
      }
    },
  });
  return spaces;
};

const readFolders = async (collection: any): Promise<BinFolder[]> => {
  const folders: BinFolder[] = [];
  await forEachIdKeysetPage({
    collection,
    selector: { deletedAt: { $gt: SPACE_NOT_BINNED } },
    pageSize: BIN_SCAN_PAGE_SIZE,
    onPage: (docs: RxBinDocument[]) => {
      for (const doc of docs) {
        const id = stringField(doc, "id") || doc.primary || "";
        const deletedAt = numberField(doc, "deletedAt");
        if (!id || !isBinned(deletedAt)) continue;
        const parentId = stringField(doc, "parentId") || null;
        folders.push({
          id,
          name: boundedLabel(stringField(doc, "name"), "Untitled folder"),
          spaceId: stringField(doc, "spaceId"),
          parentId,
          type: doc.get("type") === "tab_group" ? "tab_group" : "folder",
          deletedAt,
          purgeAt: numberField(doc, "purgeAt"),
        });
      }
    },
  });
  return folders;
};

const buildFolderForest = (
  folders: BinFolder[],
  binnedSpaceIds: ReadonlySet<string>
): {
  rootByCoveredFolderId: Map<string, string>;
  entriesByRootId: Map<string, BinEntry>;
} => {
  const folderById = new Map<string, BinFolder>();
  const childrenByParentId = new Map<string, string[]>();
  for (const folder of folders) {
    folderById.set(folder.id, folder);
  }
  for (const folder of folders) {
    if (!folder.parentId) continue;
    const parent = folderById.get(folder.parentId);
    // Folder lifecycle operations deliberately stay inside the root's space.
    // A malformed legacy cross-space pointer therefore cannot make this child
    // actionable through that parent; surface it as its own Bin root instead.
    if (!parent || parent.spaceId !== folder.spaceId) continue;
    const children = childrenByParentId.get(folder.parentId);
    if (children) children.push(folder.id);
    else childrenByParentId.set(folder.parentId, [folder.id]);
  }

  const entriesByRootId = new Map<string, BinEntry>();
  const rootByCoveredFolderId = new Map<string, string>();
  for (const folder of folders) {
    if (binnedSpaceIds.has(folder.spaceId)) continue;
    const parent = folder.parentId ? folderById.get(folder.parentId) : undefined;
    if (parent && parent.spaceId === folder.spaceId) continue;

    const label = folder.type === "tab_group" ? "Tab group" : "Folder";
    entriesByRootId.set(folder.id, {
      kind: "folder",
      id: folder.id,
      name: folder.name,
      subtitle: label,
      deletedAt: folder.deletedAt,
      purgeAt: folder.purgeAt || computeBinPurgeAt(folder.deletedAt),
      spaceId: folder.spaceId,
      folderId: folder.parentId,
      itemCount: 0,
    });

    // Iterative traversal avoids stack overflow for deeply nested imports.
    const pending = [folder.id];
    while (pending.length > 0) {
      const folderId = pending.pop() as string;
      if (rootByCoveredFolderId.has(folderId)) continue;
      rootByCoveredFolderId.set(folderId, folder.id);
      const children = childrenByParentId.get(folderId);
      if (children) {
        for (const childId of children) pending.push(childId);
      }
    }
  }

  // A malformed all-cycle component has no top-level root, matching the old
  // behavior. The visited guard above also makes rooted malformed graphs safe.
  return { rootByCoveredFolderId, entriesByRootId };
};

export class BinController {
  [key: string]: any;

  async listContents(request?: BinContentsRequest): Promise<BinContentsPage> {
    const db = await getDb();
    const limit = safeLimit(request?.limit);
    const after = validCursor(request?.after) ? request.after : null;

    // RxDB does not expose result-field projection for find queries. Page the
    // documents instead and read only the fields this view needs with doc.get();
    // full text/media documents are never cloned or retained across pages.
    const [spaces, folders] = await Promise.all([
      readSpaces(db.spaces as any),
      readFolders(db.folders as any),
    ]);
    const binnedSpaceIds = new Set(spaces.map((space) => space.id));
    const { rootByCoveredFolderId, entriesByRootId } = buildFolderForest(
      folders,
      binnedSpaceIds
    );
    // The forest maps contain all fields needed for the item pass. Release the
    // wider folder projections before any item documents are scanned.
    folders.length = 0;
    const page = new BoundedBinPage(limit, after);

    for (const space of spaces) {
      page.offer({
        kind: "space",
        id: space.id,
        name: space.name,
        subtitle: space.isPrivate ? "Private space" : "Space",
        deletedAt: space.deletedAt,
        purgeAt: space.purgeAt || computeBinPurgeAt(space.deletedAt),
        spaceId: space.id,
      });
    }
    spaces.length = 0;

    await forEachIdKeysetPage({
      collection: db.items as any,
      selector: { deletedAt: { $gt: SPACE_NOT_BINNED } },
      pageSize: BIN_SCAN_PAGE_SIZE,
      onPage: (docs: RxBinDocument[]) => {
        for (const doc of docs) {
          const id = stringField(doc, "id") || doc.primary || "";
          const deletedAt = numberField(doc, "deletedAt");
          if (!id || !isBinned(deletedAt)) continue;
          const spaceId = stringField(doc, "spaceId");
          const folderId = stringField(doc, "folderId");
          const coveredRootId = rootByCoveredFolderId.get(folderId);
          if (coveredRootId) {
            const folderEntry = entriesByRootId.get(coveredRootId);
            if (folderEntry) folderEntry.itemCount = (folderEntry.itemCount || 0) + 1;
            continue;
          }
          if (binnedSpaceIds.has(spaceId)) continue;

          const title = stringField(doc, "title");
          const url = stringField(doc, "url");
          page.offer({
            kind: "item",
            id,
            name: boundedLabel(title.trim() ? title : url, "Untitled tab"),
            subtitle: "Saved tab",
            deletedAt,
            purgeAt: computeBinPurgeAt(deletedAt),
            spaceId,
            folderId: folderId || null,
          });
        }
      },
    });

    for (const folderEntry of entriesByRootId.values()) {
      const itemCount = folderEntry.itemCount || 0;
      if (itemCount > 0) {
        const savedTabs = `${itemCount} saved tab${itemCount === 1 ? "" : "s"}`;
        folderEntry.subtitle = `${folderEntry.subtitle} · ${savedTabs}`;
      }
      page.offer(folderEntry);
    }

    return page.result();
  }
}

export const binController = new BinController();
