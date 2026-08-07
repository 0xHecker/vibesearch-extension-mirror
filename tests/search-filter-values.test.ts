import { describe, expect, test } from "bun:test";
import {
  resolveNamedFilterValues,
  resolveSearchFolderFilterIds,
} from "../src/pages/search/filter-values";

describe("search named filter resolution", () => {
  test("expands duplicate names instead of arbitrarily selecting one folder", () => {
    expect(
      resolveNamedFilterValues(
        ["Reading list"],
        [
          { id: "folder-public", name: "Reading list" },
          { id: "folder-work", name: "Reading list" },
        ]
      )
    ).toEqual(["folder-public", "folder-work"]);
  });

  test("keeps an unresolved value restrictive instead of dropping the filter", () => {
    expect(
      resolveNamedFilterValues(
        ["Missing folder"],
        [{ id: "folder-existing", name: "Existing folder" }]
      )
    ).toEqual(["Missing folder"]);
  });

  test("deduplicates direct IDs and exact case-insensitive name matches", () => {
    expect(
      resolveNamedFilterValues(
        ["folder-one", "READING LIST", "folder-one"],
        [{ id: "folder-one", name: "Reading list" }]
      )
    ).toEqual(["folder-one"]);
  });

  test("does not inject the selected browse folder into an active search", () => {
    expect(
      resolveSearchFolderFilterIds({
        hasActiveQuery: true,
        parsedFolderIds: [],
        selectedFolderId: "sidebar-folder",
      })
    ).toEqual([]);

    expect(
      resolveSearchFolderFilterIds({
        hasActiveQuery: true,
        parsedFolderIds: ["query-folder"],
        selectedFolderId: "sidebar-folder",
      })
    ).toEqual(["query-folder"]);
  });

  test("uses the selected folder while browsing without a query", () => {
    expect(
      resolveSearchFolderFilterIds({
        hasActiveQuery: false,
        parsedFolderIds: [],
        selectedFolderId: "sidebar-folder",
      })
    ).toEqual(["sidebar-folder"]);
  });
});
