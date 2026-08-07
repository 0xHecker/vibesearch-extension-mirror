import { describe, expect, test } from "bun:test";
import {
  findItemElementByDataId,
  revalidateRevealItem,
} from "../src/pages/search/reveal-target";

describe("search reveal target lookup", () => {
  test("matches imported IDs containing CSS selector punctuation literally", () => {
    const targetId = 'imported"] [data-item-id="other';
    const elements = [
      { getAttribute: () => "ordinary-id" },
      { getAttribute: () => targetId },
    ];
    const root = {
      querySelectorAll: (selector: string) => {
        expect(selector).toBe("[data-item-id]");
        return elements;
      },
    };

    expect(findItemElementByDataId(root, targetId)).toBe(elements[1]);
  });

  test("returns null while the requested item has not rendered", () => {
    const root = {
      querySelectorAll: () => [{ getAttribute: () => "visible-id" }],
    };

    expect(findItemElementByDataId(root, "pending-id")).toBeNull();
  });

  test("uses the item's click-time location when it moved after search", async () => {
    const stale = { id: "item-a", spaceId: "space-old", folderId: "folder-old" };
    const fresh = { id: "item-a", spaceId: "space-new", folderId: "folder-new" };
    const requestedIds: string[] = [];

    const resolved = await revalidateRevealItem(stale, async (itemId) => {
      requestedIds.push(itemId);
      return [fresh];
    });

    expect(requestedIds).toEqual(["item-a"]);
    expect(resolved).toBe(fresh);
  });

  test("does not reveal a result that entered Bin before it was clicked", async () => {
    const stale = { id: "item-a", spaceId: "space-old", folderId: "folder-old" };

    expect(await revalidateRevealItem(stale, async () => [])).toBeNull();
  });
});
