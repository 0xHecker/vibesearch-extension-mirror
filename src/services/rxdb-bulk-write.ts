/**
 * RxDB bulk methods resolve with per-row outcomes instead of rejecting when
 * the storage layer rejects individual documents. Callers must inspect both
 * arrays before reporting success or starting later side effects.
 */
export const assertRxBulkWriteSuccess = (
  result: unknown,
  expectedCount: number,
  operation: string
): void => {
  const writeErrors =
    result &&
    typeof result === "object" &&
    Array.isArray((result as { error?: unknown[] }).error)
      ? (result as { error: unknown[] }).error
      : [];
  if (writeErrors.length > 0) {
    throw new AggregateError(
      writeErrors,
      `RXDB_BULK_WRITE_FAILED:${operation}:${writeErrors.length}`
    );
  }

  const committedCount =
    result &&
    typeof result === "object" &&
    Array.isArray((result as { success?: unknown[] }).success)
      ? (result as { success: unknown[] }).success.length
      : 0;
  if (committedCount !== expectedCount) {
    throw new Error(
      `RXDB_BULK_WRITE_INCOMPLETE:${operation}:${committedCount}/${expectedCount}`,
      { cause: result }
    );
  }
};

export const checkedRxBulkWrite = async <Row>(
  operation: string,
  rows: Row[],
  write: (rows: Row[]) => Promise<unknown>
): Promise<void> => {
  if (rows.length === 0) return;
  const result = await write(rows);
  assertRxBulkWriteSuccess(result, rows.length, operation);
};
