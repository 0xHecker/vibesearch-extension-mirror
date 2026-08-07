import { countRxQuerySubscribers, uncacheRxQuery } from "rxdb";

type RxDocumentWithId = {
  primary?: string;
  get?: (field: string) => unknown;
};

type KeysetQuery<Document> = {
  exec: () => Promise<Document[]>;
};

type KeysetCollection<Document extends RxDocumentWithId> = {
  _queryCache?: unknown;
  find: (query: {
    selector: Record<string, unknown>;
    sort: Array<{ id: "asc" }>;
    limit: number;
  }) => KeysetQuery<Document>;
};

const releaseOneShotQuery = (collection: KeysetCollection<any>, query: KeysetQuery<any>): void => {
  const queryCache = collection._queryCache;
  if (!queryCache) return;
  try {
    // RxDB's query cache otherwise retains each distinct cursor page and its
    // complete RxDocuments. Keyset scans are one-shot, but never evict a query
    // that another caller happened to subscribe to.
    if (countRxQuerySubscribers(query as any) === 0) {
      uncacheRxQuery(queryCache as any, query as any);
    }
  } catch {
    // Cache eviction is a memory optimization; query correctness must not
    // depend on RxDB's private cache shape or a test double implementing it.
  }
};

export const throwIfOperationAborted = (signal?: AbortSignal): void => {
  if (!signal?.aborted) return;
  const error = new Error(
    signal.reason instanceof Error ? signal.reason.message : "Operation was aborted."
  );
  error.name = "AbortError";
  throw error;
};

const documentId = (document: RxDocumentWithId): string => {
  if (typeof document.primary === "string" && document.primary) return document.primary;
  const id = document.get?.("id");
  return typeof id === "string" ? id : "";
};

const selectorAfterId = (
  selector: Record<string, unknown>,
  afterId: string
): Record<string, unknown> => {
  if (!afterId) return { ...selector };
  if (selector.id === undefined) return { ...selector, id: { $gt: afterId } };
  return { $and: [selector, { id: { $gt: afterId } }] };
};

/**
 * Reads exactly one bounded keyset page and evicts its one-shot RxDB query.
 * `hasMore` is conservative when a page is full; callers may make one final
 * empty request, which keeps both retained documents and message payloads
 * bounded without reading a lookahead document.
 */
export const readIdKeysetPage = async <Document extends RxDocumentWithId>(options: {
  collection: KeysetCollection<Document>;
  selector: Record<string, unknown>;
  pageSize: number;
  afterId?: string;
  signal?: AbortSignal;
}): Promise<{
  documents: Document[];
  nextCursor: string | null;
  hasMore: boolean;
}> => {
  throwIfOperationAborted(options.signal);
  const pageSize = Math.max(1, Math.floor(options.pageSize));
  const afterId = options.afterId || "";
  const query = options.collection.find({
    selector: selectorAfterId(options.selector, afterId),
    sort: [{ id: "asc" }],
    limit: pageSize,
  });
  let documents: Document[];
  try {
    documents = await query.exec();
  } finally {
    releaseOneShotQuery(options.collection, query);
  }
  throwIfOperationAborted(options.signal);

  const nextCursor =
    documents.length > 0 ? documentId(documents[documents.length - 1]) : null;
  if (nextCursor && nextCursor <= afterId) {
    throw new Error("KEYSET_PAGE_DID_NOT_ADVANCE");
  }
  return {
    documents,
    nextCursor,
    hasMore: documents.length === pageSize,
  };
};

/**
 * Iterates an RxDB collection without retaining a full query result in memory.
 * Pages are ordered by primary key and advance with `id > lastId`, so records
 * are neither duplicated nor skipped in a stable snapshot.
 */
export const forEachIdKeysetPage = async <Document extends RxDocumentWithId>(options: {
  collection: KeysetCollection<Document>;
  selector: Record<string, unknown>;
  pageSize: number;
  onPage: (documents: Document[]) => void | Promise<void>;
  signal?: AbortSignal;
}): Promise<number> => {
  const pageSize = Math.max(1, Math.floor(options.pageSize));
  let afterId = "";
  let visited = 0;

  while (true) {
    throwIfOperationAborted(options.signal);
    const selector = selectorAfterId(options.selector, afterId);
    const query = options.collection.find({
      selector,
      sort: [{ id: "asc" }],
      limit: pageSize,
    });
    let documents: Document[];
    try {
      documents = await query.exec();
    } finally {
      releaseOneShotQuery(options.collection, query);
    }
    throwIfOperationAborted(options.signal);
    if (documents.length === 0) break;

    await options.onPage(documents);
    throwIfOperationAborted(options.signal);
    visited += documents.length;

    const nextAfterId = documentId(documents[documents.length - 1]);
    if (!nextAfterId || nextAfterId <= afterId) {
      throw new Error("KEYSET_PAGE_DID_NOT_ADVANCE");
    }
    afterId = nextAfterId;
    if (documents.length < pageSize) break;

    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    throwIfOperationAborted(options.signal);
  }

  return visited;
};
