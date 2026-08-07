import { describe, expect, test } from "bun:test";
import {
  forEachIdKeysetPage,
  readIdKeysetPage,
} from "../src/services/rxdb-keyset-pagination";

describe("RxDB keyset pagination", () => {
  test("returns one bounded cursor page without retaining a lookahead document", async () => {
    const documents = Array.from({ length: 125 }, (_, index) => ({
      primary: `item-${String(index).padStart(4, "0")}`,
    }));
    const requestedLimits: number[] = [];
    const collection = {
      find: (query: {
        selector: Record<string, any>;
        sort: Array<{ id: "asc" }>;
        limit: number;
      }) => ({
        exec: async () => {
          requestedLimits.push(query.limit);
          const afterId = query.selector.id?.$gt || "";
          return documents
            .filter((document) => document.primary > afterId)
            .slice(0, query.limit);
        },
      }),
    };

    const first = await readIdKeysetPage({
      collection,
      selector: { deletedAt: { $eq: 0 } },
      pageSize: 50,
    });
    const second = await readIdKeysetPage({
      collection,
      selector: { deletedAt: { $eq: 0 } },
      pageSize: 50,
      afterId: first.nextCursor || undefined,
    });
    const third = await readIdKeysetPage({
      collection,
      selector: { deletedAt: { $eq: 0 } },
      pageSize: 50,
      afterId: second.nextCursor || undefined,
    });

    expect(first.documents).toHaveLength(50);
    expect(first.nextCursor).toBe("item-0049");
    expect(first.hasMore).toBe(true);
    expect(second.documents).toHaveLength(50);
    expect(second.nextCursor).toBe("item-0099");
    expect(second.hasMore).toBe(true);
    expect(third.documents).toHaveLength(25);
    expect(third.nextCursor).toBe("item-0124");
    expect(third.hasMore).toBe(false);
    expect(requestedLimits).toEqual([50, 50, 50]);
  });

  test("uses bounded ascending-ID queries without losing a page", async () => {
    const documents = Array.from({ length: 1_005 }, (_, index) => ({
      primary: `item-${String(index).padStart(4, "0")}`,
    }));
    const queries: Array<{
      selector: Record<string, any>;
      sort: Array<{ id: "asc" }>;
      limit: number;
    }> = [];
    const visitedIds: string[] = [];
    const collection = {
      find: (query: (typeof queries)[number]) => {
        queries.push(query);
        return {
          exec: async () => {
            const afterId = (query.selector.id as { $gt?: string } | undefined)?.$gt || "";
            return documents
              .filter((document) => document.primary > afterId)
              .slice(0, query.limit);
          },
        };
      },
    };

    const visited = await forEachIdKeysetPage({
      collection,
      selector: { deletedAt: { $eq: 0 } },
      pageSize: 137,
      onPage: (page) => {
        visitedIds.push(...page.map((document) => document.primary));
      },
    });

    expect(visited).toBe(documents.length);
    expect(visitedIds).toEqual(documents.map((document) => document.primary));
    expect(new Set(visitedIds).size).toBe(documents.length);
    expect(queries.every((query) => query.limit === 137)).toBe(true);
    expect(queries.every((query) => query.sort[0]?.id === "asc")).toBe(true);
    expect(queries.length).toBe(8);
  });

  test("evicts each unsubscribed one-shot page from the RxDB query cache", async () => {
    const documents = Array.from({ length: 450 }, (_, index) => ({
      primary: `item-${String(index).padStart(4, "0")}`,
    }));
    const queryCache = { _map: new Map<string, any>() };
    const createdQueries: any[] = [];
    const collection = {
      _queryCache: queryCache,
      find: (query: {
        selector: Record<string, any>;
        sort: Array<{ id: "asc" }>;
        limit: number;
      }) => {
        const key = JSON.stringify(query);
        const rxQuery = {
          uncached: false,
          refCount$: { observers: [] },
          toString: () => key,
          exec: async () => {
            const afterId = Array.isArray(query.selector.$and)
              ? query.selector.$and[1]?.id?.$gt || ""
              : query.selector.id?.$gt || "";
            return documents
              .filter((document) => document.primary > afterId)
              .slice(0, query.limit);
          },
        };
        queryCache._map.set(key, rxQuery);
        createdQueries.push(rxQuery);
        return rxQuery;
      },
    };

    await forEachIdKeysetPage({
      collection,
      selector: { deletedAt: { $gt: 0 } },
      pageSize: 100,
      onPage: () => {},
    });

    expect(createdQueries).toHaveLength(5);
    expect(createdQueries.every((query) => query.uncached === true)).toBe(true);
    expect(queryCache._map.size).toBe(0);
  });

  test("does not evict an identical query that has a live subscriber", async () => {
    const queryCache = { _map: new Map<string, any>() };
    const key = "subscribed-page";
    const subscribedQuery = {
      uncached: false,
      refCount$: { observers: [{}] },
      toString: () => key,
      exec: async () => [{ primary: "item-0001" }],
    };
    queryCache._map.set(key, subscribedQuery);
    const collection = {
      _queryCache: queryCache,
      find: () => subscribedQuery,
    };

    await forEachIdKeysetPage({
      collection,
      selector: { deletedAt: { $gt: 0 } },
      pageSize: 100,
      onPage: () => {},
    });

    expect(subscribedQuery.uncached).toBe(false);
    expect(queryCache._map.get(key)).toBe(subscribedQuery);
  });
});
