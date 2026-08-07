import { describe, expect, it } from "bun:test";
import { shouldAdvanceConnectorCursor } from "../src/services/connectors/registry";

describe("connector cursor commits", () => {
  it("advances only after every fetched item was pushed or already present", () => {
    expect(shouldAdvanceConnectorCursor({ fetched: 5, pushed: 3, skipped: 2, failed: 0, cancelled: false })).toBe(true);
  });

  it("retains the cursor when an upload failed", () => {
    expect(shouldAdvanceConnectorCursor({ fetched: 5, pushed: 4, skipped: 0, failed: 1, cancelled: false })).toBe(false);
  });

  it("retains the cursor when the user cancels a partial sync", () => {
    expect(shouldAdvanceConnectorCursor({ fetched: 5, pushed: 2, skipped: 0, failed: 0, cancelled: true })).toBe(false);
  });

  it("retains the cursor when the push result does not account for every item", () => {
    expect(shouldAdvanceConnectorCursor({ fetched: 5, pushed: 3, skipped: 1, failed: 0, cancelled: false })).toBe(false);
  });
});
