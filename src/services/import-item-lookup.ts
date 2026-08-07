import { countRxQuerySubscribers, uncacheRxQuery } from "rxdb";

type ImportItemDocument = {
  get: (field: string) => unknown;
};

type ImportItemQuery<Document extends ImportItemDocument> = {
  exec: () => Promise<Document[]>;
};

type ImportItemCollection<Document extends ImportItemDocument> = {
  _queryCache?: unknown;
  find: (query: {
    selector: { id: { $in: string[] } };
    limit: number;
  }) => ImportItemQuery<Document>;
};

const releaseOneShotQuery = (
  collection: ImportItemCollection<ImportItemDocument>,
  query: ImportItemQuery<ImportItemDocument>
): void => {
  if (!collection._queryCache) return;
  try {
    if (countRxQuerySubscribers(query as any) === 0) {
      uncacheRxQuery(collection._queryCache as any, query as any);
    }
  } catch {
    // Query-cache eviction is only a memory optimization. Test doubles and
    // future RxDB versions may not expose the private cache in the same shape.
  }
};

/**
 * Resolves deterministic importer ids regardless of their current space.
 * A user may move an imported item outside the managed source tree; a
 * space-scoped reconciliation lookup must not then mistake that id for a new
 * row and overwrite it. Queries stay bounded and are released immediately so
 * a large reimport does not pin every resolved document in RxDB's query cache.
 */
export const findImportItemIdsByIds = async <Document extends ImportItemDocument>(
  collection: ImportItemCollection<Document>,
  ids: Iterable<string>,
  batchSize = 200
): Promise<Set<string>> => {
  const uniqueIds = Array.from(new Set(ids)).filter(Boolean);
  const foundIds = new Set<string>();
  const boundedBatchSize = Math.max(1, Math.floor(batchSize));

  for (let start = 0; start < uniqueIds.length; start += boundedBatchSize) {
    const batch = uniqueIds.slice(start, start + boundedBatchSize);
    const query = collection.find({
      selector: { id: { $in: batch } },
      limit: batch.length,
    });
    try {
      for (const document of await query.exec()) {
        const id = document.get("id");
        if (typeof id === "string" && id) foundIds.add(id);
      }
    } finally {
      releaseOneShotQuery(
        collection as ImportItemCollection<ImportItemDocument>,
        query as ImportItemQuery<ImportItemDocument>
      );
    }
  }

  return foundIds;
};
