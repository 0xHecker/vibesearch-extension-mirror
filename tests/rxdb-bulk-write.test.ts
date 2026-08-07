import { describe, expect, test } from "bun:test";
import {
  assertRxBulkWriteSuccess,
  checkedRxBulkWrite,
} from "../src/services/rxdb-bulk-write";

describe("checked RxDB bulk writes", () => {
  test("preserves per-row write errors in an AggregateError", () => {
    const writeError = {
      status: 422,
      documentId: "rejected-row",
      isError: true,
    };

    let caught: unknown = null;
    try {
      assertRxBulkWriteSuccess(
        { success: [], error: [writeError] },
        1,
        "test.rows"
      );
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(AggregateError);
    expect(caught).toMatchObject({
      message: "RXDB_BULK_WRITE_FAILED:test.rows:1",
      errors: [writeError],
    });
  });

  test("rejects an error-free response that did not commit every requested row", async () => {
    await expect(
      checkedRxBulkWrite(
        "test.rows",
        [{ id: "a" }, { id: "b" }],
        async () => ({ success: [{ id: "a" }], error: [] })
      )
    ).rejects.toThrow("RXDB_BULK_WRITE_INCOMPLETE:test.rows:1/2");
  });

  test("accepts only an exact all-success response", async () => {
    await expect(
      checkedRxBulkWrite(
        "test.rows",
        [{ id: "a" }, { id: "b" }],
        async (rows) => ({ success: rows, error: [] })
      )
    ).resolves.toBeUndefined();
  });
});
