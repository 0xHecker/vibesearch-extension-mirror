export type MutationEntityKind = "space" | "folder" | "item" | "bin";

const mutationQueues = new WeakMap<object, Map<string, Promise<void>>>();

/**
 * Serialize mutations for one persisted entity across every controller
 * instance that shares the same database. This keeps stale UI actions from
 * racing a restore against a permanent delete.
 */
export const withEntityMutationLock = async <Result>(
  database: object,
  kind: MutationEntityKind,
  entityId: string,
  operation: () => Promise<Result>
): Promise<Result> => {
  let queues = mutationQueues.get(database);
  if (!queues) {
    queues = new Map();
    mutationQueues.set(database, queues);
  }

  const key = `${kind}:${entityId}`;
  const previous = queues.get(key) ?? Promise.resolve();
  const waitForPrevious = previous.catch(() => undefined);
  let release = () => {};
  const currentTurn = new Promise<void>((resolve) => {
    release = resolve;
  });
  const queueTail = waitForPrevious.then(() => currentTurn);
  queues.set(key, queueTail);

  await waitForPrevious;
  try {
    return await operation();
  } finally {
    release();
    if (queues.get(key) === queueTail) queues.delete(key);
  }
};

/** Bin restores and destructive purges are intentionally serialized globally. */
export const withBinMutationLock = <Result>(
  database: object,
  operation: () => Promise<Result>
): Promise<Result> => withEntityMutationLock(database, "bin", "global", operation);

export const withSpaceMutationLock = <Result>(
  database: object,
  spaceId: string,
  operation: () => Promise<Result>
): Promise<Result> => withEntityMutationLock(database, "space", spaceId, operation);

/** Acquire multiple space locks in stable order to prevent cross-space deadlocks. */
export const withSpaceMutationLocks = async <Result>(
  database: object,
  spaceIds: Iterable<string>,
  operation: () => Promise<Result>
): Promise<Result> => {
  const ids = Array.from(
    new Set(Array.from(spaceIds, (id) => id.trim()).filter(Boolean))
  ).sort();

  const acquire = (index: number): Promise<Result> =>
    index >= ids.length
      ? operation()
      : withSpaceMutationLock(database, ids[index], () => acquire(index + 1));

  return acquire(0);
};

const normalizeSpaceIds = (spaceIds: Iterable<string>): string[] =>
  Array.from(new Set(Array.from(spaceIds, (id) => id.trim()).filter(Boolean))).sort();

/**
 * Lock a changing set of persisted source/destination spaces safely.
 *
 * Restore operations know their incoming destinations up front, but an
 * existing folder or item with the same id may currently live elsewhere. The
 * preflight discovers those current owners. We then repeat that read under the
 * candidate locks; if a row moved during the lock-acquisition window, the new
 * owner is added and the operation retries before performing any writes.
 */
export const withStableAffectedSpaceLocks = async <Result>(
  database: object,
  initialSpaceIds: Iterable<string>,
  collectCurrentSpaceIds: () => Promise<Iterable<string>>,
  operation: () => Promise<Result>
): Promise<Result> => {
  const affectedSpaceIds = new Set(normalizeSpaceIds(initialSpaceIds));

  // The set grows monotonically. Reaching this guard would require the same
  // restore rows to be moved through many spaces continuously while restoring.
  for (let attempt = 0; attempt < 8; attempt += 1) {
    for (const id of normalizeSpaceIds(await collectCurrentSpaceIds())) {
      affectedSpaceIds.add(id);
    }

    let retry = false;
    let result: Result | undefined;
    await withSpaceMutationLocks(database, affectedSpaceIds, async () => {
      const confirmedIds = normalizeSpaceIds(await collectCurrentSpaceIds());
      for (const id of confirmedIds) {
        if (affectedSpaceIds.has(id)) continue;
        affectedSpaceIds.add(id);
        retry = true;
      }
      if (!retry) result = await operation();
    });

    if (!retry) return result as Result;
  }

  throw new Error("AFFECTED_SPACE_SET_UNSTABLE");
};
