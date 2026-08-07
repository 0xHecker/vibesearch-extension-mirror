import { describe, expect, test } from "bun:test";
import {
  buildFolderLoadKey,
  buildSearchSelectionSearch,
  getVisibleSelectionState,
  includePendingRevealItem,
  resolveFolderSelectionContext,
  resolveSearchResultSelectionContext,
} from "../src/pages/search/selection-state";

describe("search selection state", () => {
  test("resolves a clicked folder to its owning space", () => {
    const context = resolveFolderSelectionContext(
      "folder-private",
      [{ id: "folder-private", spaceId: "space_private_default" }],
      [{ id: "space_private_default", spaceGroupId: null }]
    );

    expect(context).toEqual({
      activeSpaceId: "space_private_default",
      activeSpaceGroupId: null,
      selectedFolderId: "folder-private",
    });
  });

  test("revealing a search result selects the result's folder", () => {
    const context = resolveSearchResultSelectionContext(
      { id: "item-target", folderId: "folder-reading", spaceId: "space-research" }
    );

    expect(context).toEqual({
      activeSpaceId: "space-research",
      activeSpaceGroupId: null,
      selectedFolderId: "folder-reading",
    });
  });

  test("keeps an older reveal target alongside a bounded folder page", () => {
    const pageItems = Array.from({ length: 100 }, (_, index) => ({
      id: `recent-${index}`,
      folderId: "folder-reading",
      spaceId: "space-research",
    }));
    const pendingItem = {
      id: "older-target",
      folderId: "folder-reading",
      spaceId: "space-research",
    };

    const items = includePendingRevealItem(pageItems, pendingItem, {
      activeSpaceId: "space-research",
      activeSpaceGroupId: null,
      selectedFolderId: "folder-reading",
    });

    expect(items).toHaveLength(101);
    expect(items[0]).toBe(pendingItem);
    // TabGroup mounts at most 100 cards at once. The reveal target must be in
    // that first mounted window or the follow-up scroll can never find it.
    expect(items.slice(0, 100).some((item) => item.id === pendingItem.id)).toBe(true);
  });

  test("does not inject a pending item into a different browse context", () => {
    const pageItems = [{ id: "visible", folderId: "folder-other", spaceId: "space-research" }];
    const pendingItem = {
      id: "target",
      folderId: "folder-reading",
      spaceId: "space-research",
    };

    expect(
      includePendingRevealItem(pageItems, pendingItem, {
        activeSpaceId: "space-research",
        activeSpaceGroupId: null,
        selectedFolderId: "folder-other",
      })
    ).toBe(pageItems);
  });

  test("keeps an older ungrouped reveal target in the all-items view", () => {
    const pageItems = [
      { id: "new", spaceId: "space-a", folderId: "folder-a" },
    ];
    const pendingItem = { id: "old-ungrouped", spaceId: "space-a", folderId: "" };

    expect(
      includePendingRevealItem(pageItems, pendingItem, {
        activeSpaceId: "space-a",
        activeSpaceGroupId: null,
        selectedFolderId: "all",
      }).map((item) => item.id)
    ).toEqual(["old-ungrouped", "new"]);
  });

  test("serializes folder selection without forcing the default public space param", () => {
    const search = buildSearchSelectionSearch({
      currentSearch: "?space=space_public_default&view=grid",
      activeSpaceId: "space_public_default",
      activeSpaceGroupId: null,
      selectedFolderId: "folder-public",
    });

    expect(new URLSearchParams(search).get("space")).toBe(null);
    expect(new URLSearchParams(search).get("folder")).toBe("folder-public");
    expect(new URLSearchParams(search).get("view")).toBe("grid");
  });

  test("folder load keys include the target space set", () => {
    expect(
      buildFolderLoadKey({
        activeSpaceId: "space-a",
        searchScope: "global",
        spaceIds: ["space-b", "space-a"],
      })
    ).toBe("space-a|global|space-a,space-b");
  });

  test("selection state is scoped to the visible page", () => {
    const pageItems = [{ id: "page-1" }, { id: "page-2" }];

    expect(getVisibleSelectionState(pageItems, new Set(["page-1", "hidden-1"]))).toEqual({
      allVisibleSelected: false,
      someVisibleSelected: true,
    });

    expect(getVisibleSelectionState(pageItems, new Set(["page-1", "page-2", "hidden-1"]))).toEqual({
      allVisibleSelected: true,
      someVisibleSelected: false,
    });
  });
});
