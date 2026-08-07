type CompactionInvalidation = {
  clearVectors(): Promise<void>;
  invalidateItems(): Promise<number>;
};

type CompactionCommitWithRecovery = CompactionInvalidation & {
  commit(): Promise<void>;
  finalizeRecovery(invalidatedCount: number): Promise<void>;
};

const errorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : "unknown error";

/**
 * Make a partially committed vector swap harmless. Both safeguards are
 * attempted: an empty vector file prevents wrong-byte reads immediately, and
 * invalidating every active item schedules a consistent rebuild. Callers keep
 * the `swapped` journal phase when this throws so startup can retry.
 */
export const invalidatePartiallyCommittedCompaction = async (
  operations: CompactionInvalidation
): Promise<number> => {
  const failures: string[] = [];
  let invalidatedCount = 0;

  try {
    await operations.clearVectors();
  } catch (error) {
    failures.push(`vector clear failed: ${errorMessage(error)}`);
  }

  try {
    invalidatedCount = await operations.invalidateItems();
  } catch (error) {
    failures.push(`item invalidation failed: ${errorMessage(error)}`);
  }

  if (failures.length > 0) {
    throw new Error(`Compaction recovery incomplete (${failures.join("; ")}).`);
  }
  return invalidatedCount;
};

/**
 * A multi-batch RxDB commit is not transactional. If any later batch fails,
 * never restore only the old vector file: earlier batches may already contain
 * compacted indexes. Invalidate the whole vector state instead.
 */
export const commitCompactionWithRecovery = async (
  operations: CompactionCommitWithRecovery
): Promise<void> => {
  try {
    await operations.commit();
  } catch (commitError) {
    try {
      const invalidatedCount = await invalidatePartiallyCommittedCompaction(operations);
      await operations.finalizeRecovery(invalidatedCount);
    } catch (recoveryError) {
      throw new Error(
        `Vector index commit failed (${errorMessage(commitError)}), and recovery did not finish (${errorMessage(recoveryError)}).`
      );
    }
    throw commitError;
  }
};
