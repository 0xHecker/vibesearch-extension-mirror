export type ImportLruFolderEntry = {
  folderId: string;
  spaceId: string;
  folderName: string;
  spaceName: string;
  usedAt: number;
};

export type ImportLruFolderSnapshot = {
  id: string;
  name?: string;
  spaceId: string;
  deletedAt?: number;
};

export type LiveImportSpaceSnapshot = {
  id: string;
  name?: string;
};

export type LiveImportFolderTarget = {
  folderId: string;
  spaceId: string;
  folderName: string;
  spaceName: string;
};

/**
 * Resolve a folder against a fresh live-space snapshot. A folder document can
 * outlive its owning space in IndexedDB, so existence alone is not enough for
 * a safe quick-save destination.
 */
export const resolveLiveImportFolderTarget = (
  folder: ImportLruFolderSnapshot | null | undefined,
  liveSpaces: readonly LiveImportSpaceSnapshot[]
): LiveImportFolderTarget | null => {
  if (!folder?.id || !folder.spaceId || (folder.deletedAt || 0) > 0) return null;
  const space = liveSpaces.find((candidate) => candidate.id === folder.spaceId);
  if (!space) return null;
  return {
    folderId: folder.id,
    spaceId: folder.spaceId,
    folderName: folder.name?.trim() || "Untitled folder",
    spaceName: space.name?.trim() || "Space",
  };
};

/** Remove stale LRU rows and refresh names/space ids from persisted documents. */
export const reconcileLiveImportLruFolders = (
  entries: readonly ImportLruFolderEntry[],
  folders: readonly (ImportLruFolderSnapshot | null | undefined)[],
  liveSpaces: readonly LiveImportSpaceSnapshot[]
): ImportLruFolderEntry[] => {
  const foldersById = new Map(
    folders.filter((folder): folder is ImportLruFolderSnapshot => !!folder?.id).map((folder) => [folder.id, folder])
  );
  const reconciled: ImportLruFolderEntry[] = [];
  for (const entry of entries) {
    const target = resolveLiveImportFolderTarget(foldersById.get(entry.folderId), liveSpaces);
    if (!target) continue;
    reconciled.push({
      ...entry,
      ...target,
    });
  }
  return reconciled;
};

export const selectQuickSaveFolderTarget = (
  requested: LiveImportFolderTarget | null,
  recent: readonly ImportLruFolderEntry[]
): LiveImportFolderTarget | null => requested || recent[0] || null;
