import { describe, expect, test } from "bun:test";
import type { ItemDocType } from "../src/schemas/item_schema";
import { groupItemsByFolder } from "../src/components/TabGroups/group-items-by-folder";

const item = (
  id: string,
  folderId: string,
  chunkOrder: number | undefined,
  createdAt: number
) => ({ id, folderId, chunkOrder, createdAt }) as ItemDocType;

describe("groupItemsByFolder", () => {
  test("keeps the existing per-folder sort and ignores items outside visible folders", () => {
    const items = [
      item("later", "folder-a", undefined, 30),
      item("other", "hidden-folder", 0, 40),
      item("second", "folder-a", 2, 10),
      item("first", "folder-a", 1, 20),
      item("earlier", "folder-a", undefined, 5),
    ];

    const grouped = groupItemsByFolder([{ id: "folder-a" }, { id: "folder-b" }] as any, items, false);

    expect(grouped.get("folder-a")?.map((entry) => entry.id)).toEqual([
      "first",
      "second",
      "later",
      "earlier",
    ]);
    expect(grouped.get("folder-b")).toEqual([]);
    expect(items.map((entry) => entry.id)).toEqual(["later", "other", "second", "first", "earlier"]);
  });

  test("retains result order exactly when ranking supplied the order", () => {
    const items = [item("ranked-second", "folder-a", 99, 1), item("ranked-first", "folder-a", 0, 2)];

    const grouped = groupItemsByFolder([{ id: "folder-a" }] as any, items, true);

    expect(grouped.get("folder-a")?.map((entry) => entry.id)).toEqual([
      "ranked-second",
      "ranked-first",
    ]);
  });

  test("keeps an older reveal target inside the first mounted folder page", () => {
    const items = Array.from({ length: 101 }, (_, index) =>
      item(index === 100 ? "reveal-target" : `recent-${index}`, "folder-a", index, 101 - index)
    );

    const grouped = groupItemsByFolder(
      [{ id: "folder-a" }] as any,
      items,
      false,
      "reveal-target"
    );

    expect(grouped.get("folder-a")?.slice(0, 100).map((entry) => entry.id)).toContain(
      "reveal-target"
    );
  });
});
