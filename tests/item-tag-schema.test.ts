import { describe, expect, test } from "bun:test";
import {
  itemTagMigrationStrategies,
  itemTagSchema,
  type ItemTagDocType,
} from "@src/schemas/item_tag_schema";

describe("itemTagSchema shared sync contract", () => {
  test("stores the server-required relationship clocks", () => {
    expect(itemTagSchema.version).toBeGreaterThan(0);
    expect(itemTagSchema.required).toEqual(expect.arrayContaining([
      "createdAt",
      "updatedAt",
      "deletedAt",
    ]));
    const properties = itemTagSchema.properties as Record<string, unknown>;
    expect(properties).toHaveProperty("origin");
    expect(properties).toHaveProperty("automaticKey");
  });

  test("migrates legacy joins to a valid deterministic live relationship", () => {
    const legacy = {
      id: "item-1|tag-1",
      itemId: "item-1",
      tagId: "tag-1",
      userId: "user1",
    } as ItemTagDocType;

    expect(itemTagMigrationStrategies[itemTagSchema.version](legacy)).toEqual({
      ...legacy,
      createdAt: 0,
      updatedAt: 0,
      deletedAt: 0,
    });
  });
});
