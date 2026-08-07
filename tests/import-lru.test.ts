import { describe, expect, test } from "bun:test";
import {
  reconcileLiveImportLruFolders,
  resolveLiveImportFolderTarget,
  selectQuickSaveFolderTarget,
  type ImportLruFolderEntry,
} from "../src/common/import-lru";

const recent = (folderId: string, usedAt: number): ImportLruFolderEntry => ({
  folderId,
  spaceId: "stale-space",
  folderName: "Old folder name",
  spaceName: "Old space name",
  usedAt,
});

describe("quick-save destination liveness", () => {
  test("rejects binned folders and folders whose owning space is not live", () => {
    const liveSpaces = [{ id: "space-live", name: "Live" }];

    expect(
      resolveLiveImportFolderTarget(
        { id: "folder-binned", name: "Binned", spaceId: "space-live", deletedAt: 42 },
        liveSpaces
      )
    ).toBeNull();
    expect(
      resolveLiveImportFolderTarget(
        { id: "folder-orphaned", name: "Orphaned", spaceId: "space-in-bin", deletedAt: 0 },
        liveSpaces
      )
    ).toBeNull();
  });

  test("prunes stale rows and refreshes the surviving folder and space metadata", () => {
    const entries = [recent("folder-binned", 30), recent("folder-live", 20), recent("folder-orphaned", 10)];
    const folders = [
      { id: "folder-binned", name: "Binned", spaceId: "space-live", deletedAt: 1 },
      { id: "folder-live", name: "Current folder", spaceId: "space-live", deletedAt: 0 },
      { id: "folder-orphaned", name: "Orphaned", spaceId: "space-missing", deletedAt: 0 },
    ];

    expect(
      reconcileLiveImportLruFolders(entries, folders, [
        { id: "space-live", name: "Current space" },
      ])
    ).toEqual([
      {
        folderId: "folder-live",
        spaceId: "space-live",
        folderName: "Current folder",
        spaceName: "Current space",
        usedAt: 20,
      },
    ]);
  });

  test("falls back to the next live recent folder when a requested target is stale", () => {
    const fallback = {
      ...recent("folder-live", 20),
      spaceId: "space-live",
    };
    expect(selectQuickSaveFolderTarget(null, [fallback])).toEqual(fallback);
    expect(selectQuickSaveFolderTarget(null, [])).toBeNull();
  });
});
