import { describe, expect, test } from "bun:test";
import type { RankableItem } from "../src/search-core/contracts";
import {
  streamRankCandidates,
  shouldStreamRankCandidates,
  STREAMING_RANK_HYDRATION_BATCH_SIZE,
  type StreamingRankOptions,
} from "../src/services/streaming-query-ranker";
import { ItemsController } from "../src/services/controllers/items.controller";

type Candidate = { id: string; index: number };

const rankable = (candidate: Candidate, textContent: string): RankableItem => ({
  id: candidate.id,
  title: candidate.id,
  textContent,
  ocrText: "",
  url: `https://example.test/${candidate.id}`,
  source: "web",
  authorUsername: "",
  mediaTypes: [],
  vector_index: -1,
  vector_indexes: [],
  createdAt: candidate.index,
  updatedAt: candidate.index,
});

describe("streaming query ranker", () => {
  test("switches away from the single worker request above 1,000 candidates", () => {
    expect(shouldStreamRankCandidates(1_000)).toBe(false);
    expect(shouldStreamRankCandidates(1_001)).toBe(true);
  });

  test("bounds text hydration and retained rank input while keeping exact pages across batches", async () => {
    const candidates = Array.from({ length: 10_037 }, (_, index) => ({
      id: `item-${String(index).padStart(5, "0")}`,
      index,
    }));
    const candidateById = new Map(candidates.map((candidate) => [candidate.id, candidate]));
    const findByIdsBatchSizes: number[] = [];
    const fakeItems = {
      findByIds: (ids: string[]) => {
        findByIdsBatchSizes.push(ids.length);
        return {
          exec: async () =>
            new Map(
              ids.map((id) => {
                const candidate = candidateById.get(id) as Candidate;
                return [
                  id,
                  {
                    get: (field: string) =>
                      field === "textContent"
                        ? candidate.index % 11 === 0
                          ? "contains blocked marker"
                          : "safe searchable text"
                        : "",
                  },
                ];
              })
            ),
        };
      },
    };
    const baseRank: StreamingRankOptions = {
      expression: { type: "NOT", child: { type: "TERM", value: "blocked" } },
      groups: [],
      excludedTerms: [],
      flatPositiveTerms: [],
      hasTextConstraint: true,
      useLexical: false,
      useVector: false,
      queryHash: "large-not-query",
      sortBy: "relevance",
      sortOrder: "desc",
      page: 3,
      limit: 17,
      lexicalScores: new Map(),
      lexicalMatchTerms: [],
      lexicalMatchMasksById: new Map(),
      vectorScoresByIndex: new Map(),
      includeDebug: true,
      // Every synthetic row is older than 180 days, so the existing createdAt
      // tie-break determines a stable descending order.
      nowMs: 2_000_000_000_000,
    };
    const hydrateBatch = async (batch: readonly Candidate[]) => {
      const docs = await fakeItems.findByIds(batch.map((candidate) => candidate.id)).exec();
      return batch.map((candidate) =>
        rankable(candidate, docs.get(candidate.id)?.get("textContent") || "")
      );
    };

    const thirdPage = await streamRankCandidates({
      candidates,
      batchSize: STREAMING_RANK_HYDRATION_BATCH_SIZE,
      rank: baseRank,
      hydrateBatch,
    });
    const expectedIds = candidates
      .filter((candidate) => candidate.index % 11 !== 0)
      .sort((a, b) => b.index - a.index)
      .map((candidate) => candidate.id);

    expect(thirdPage.itemIds).toEqual(expectedIds.slice(34, 51));
    expect(thirdPage.total).toBe(expectedIds.length);
    expect(thirdPage.hasMore).toBe(true);
    expect(thirdPage.debugScores?.map((score) => score.rank)).toEqual(
      Array.from({ length: 17 }, (_, index) => index + 35)
    );
    expect(thirdPage.stats.inputCount).toBe(candidates.length);
    expect(thirdPage.stats.peakBatchInputCount).toBe(STREAMING_RANK_HYDRATION_BATCH_SIZE);
    expect(thirdPage.stats.peakRetainedEntryCount).toBe(51);
    expect(thirdPage.stats.peakResidentRankItemCount).toBeLessThanOrEqual(
      STREAMING_RANK_HYDRATION_BATCH_SIZE + 51
    );
    expect(Math.max(...findByIdsBatchSizes)).toBe(STREAMING_RANK_HYDRATION_BATCH_SIZE);
    expect(findByIdsBatchSizes).toHaveLength(
      Math.ceil(candidates.length / STREAMING_RANK_HYDRATION_BATCH_SIZE)
    );

    findByIdsBatchSizes.length = 0;
    const cursorPage = await streamRankCandidates({
      candidates,
      batchSize: STREAMING_RANK_HYDRATION_BATCH_SIZE,
      rank: {
        ...baseRank,
        page: 1,
        afterCursor: thirdPage.nextCursor,
      },
      hydrateBatch,
    });

    expect(cursorPage.itemIds).toEqual(expectedIds.slice(51, 68));
    expect(cursorPage.total).toBe(expectedIds.length);
    expect(cursorPage.hasMore).toBe(true);
    expect(cursorPage.debugScores?.map((score) => score.rank)).toEqual(
      Array.from({ length: 17 }, (_, index) => index + 1)
    );
    expect(cursorPage.stats.peakRetainedEntryCount).toBe(17);
    expect(Math.max(...findByIdsBatchSizes)).toBe(STREAMING_RANK_HYDRATION_BATCH_SIZE);
  });

  test("honors fuzzy term matches stored in the second bitset word", async () => {
    const terms = Array.from({ length: 40 }, (_, index) => `explicit-term-${index + 1}`);
    const item = rankable({ id: "word-two-hit", index: 1 }, "unrelated literal text");
    const result = await streamRankCandidates({
      candidates: [item],
      batchSize: 1,
      hydrateBatch: async (batch) => [...batch],
      rank: {
        expression: {
          type: "OR",
          children: terms.map((value) => ({ type: "TERM" as const, value })),
        },
        groups: terms.map((term) => [term]),
        excludedTerms: [],
        flatPositiveTerms: terms,
        hasTextConstraint: true,
        useLexical: true,
        useVector: false,
        queryHash: "word-two",
        sortBy: "relevance",
        sortOrder: "desc",
        page: 1,
        limit: 10,
        lexicalScores: new Map([[item.id, 9]]),
        lexicalMatchTerms: terms,
        lexicalMatchMasksById: new Map([[item.id, [0, 1 << 7]]]),
        vectorScoresByIndex: new Map(),
        nowMs: 2_000_000_000_000,
      },
    });

    expect(result.itemIds).toEqual([item.id]);
    expect(result.total).toBe(1);
    expect(result.lexicalHits).toBe(1);
  });

  test("keeps a positive-free Boolean branch without a hybrid channel hit", async () => {
    const items = [
      { ...rankable({ id: "alpha", index: 3 }, "alpha"), vector_index: 0, vector_indexes: [0] },
      { ...rankable({ id: "beta", index: 2 }, "beta"), vector_index: 1, vector_indexes: [1] },
      { ...rankable({ id: "gamma", index: 1 }, "gamma"), vector_index: 2, vector_indexes: [2] },
    ];
    const result = await streamRankCandidates({
      candidates: items,
      batchSize: 1,
      hydrateBatch: async (batch) => [...batch],
      rank: {
        expression: {
          type: "OR",
          children: [
            { type: "TERM", value: "alpha" },
            { type: "NOT", child: { type: "TERM", value: "beta" } },
          ],
        },
        groups: [["alpha"]],
        excludedTerms: [],
        flatPositiveTerms: ["alpha"],
        hasTextConstraint: true,
        useLexical: true,
        useVector: true,
        queryHash: "stream-positive-free-or",
        sortBy: "relevance",
        sortOrder: "desc",
        page: 1,
        limit: 10,
        lexicalScores: new Map([["alpha", 10]]),
        lexicalMatchTerms: ["alpha"],
        lexicalMatchMasksById: new Map([["alpha", [1]]]),
        vectorScoresByIndex: new Map([[0, 0.8]]),
        nowMs: 2_000_000_000_000,
      },
    });

    expect(result.itemIds).toEqual(["alpha", "gamma"]);
    expect(result.total).toBe(2);
    expect(result.lexicalHits).toBe(1);
    expect(result.vectorHits).toBe(1);
  });

  test("matches the existing local/worker ordering on a mixed hybrid fixture", async () => {
    const items = Array.from({ length: 36 }, (_, index): RankableItem => ({
      ...rankable({ id: `hybrid-${String(index).padStart(2, "0")}`, index }, ""),
      vector_index: index,
      vector_indexes: [index],
      createdAt: 1,
      updatedAt: 1,
    }));
    const lexicalScores = new Map<string, number>();
    const vectorScoresByIndex = new Map<number, number>();
    for (let index = 0; index < items.length; index += 1) {
      if (index % 3 !== 1) lexicalScores.set(items[index].id, (index % 9) + 1);
      if (index % 3 !== 0) vectorScoresByIndex.set(index, 0.2 + (index % 11) * 0.06);
    }
    const common = {
      groups: [] as string[][],
      excludedTerms: [] as string[],
      flatPositiveTerms: ["alpha"],
      hasTextConstraint: false,
      useLexical: true,
      useVector: true,
      queryHash: "mixed-hybrid",
      sortBy: "relevance" as const,
      sortOrder: "desc" as const,
      page: 2,
      limit: 7,
      lexicalScores,
      lexicalMatchTerms: ["alpha"],
      lexicalMatchMasksById: new Map<string, number[]>(),
      vectorScoresByIndex,
      includeDebug: true,
    };

    const controller = new ItemsController() as any;
    const local = controller.rankLocally({ items, ...common });
    const streamed = await streamRankCandidates({
      candidates: items,
      batchSize: 5,
      hydrateBatch: async (batch) => [...batch],
      rank: { ...common, nowMs: 2_000_000_000_000 },
    });

    expect(streamed.itemIds).toEqual(local.itemIds);
    expect(streamed.total).toBe(local.total);
    expect(streamed.vectorHits).toBe(local.vectorHits);
    expect(streamed.lexicalHits).toBe(local.lexicalHits);
    expect(streamed.hasMore).toBe(local.hasMore);
    expect(streamed.nextCursor).toEqual(local.nextCursor);
    expect(streamed.debugScores).toEqual(local.debugScores);
    expect(streamed.stats.peakBatchInputCount).toBe(5);
    expect(streamed.stats.peakRetainedEntryCount).toBe(14);
  });

  test("keeps worker-failure fallback and streaming cursors identical for equal field values", async () => {
    const items: RankableItem[] = [
      {
        ...rankable({ id: "a-low-score", index: 1 }, ""),
        title: "Same title",
        source: "web",
        createdAt: 100,
        updatedAt: 200,
      },
      {
        ...rankable({ id: "z-high-score", index: 2 }, ""),
        title: "Same title",
        source: "web",
        createdAt: 100,
        updatedAt: 200,
      },
    ];
    const controller = new ItemsController() as any;
    const lexicalScores = new Map([
      ["a-low-score", 1],
      ["z-high-score", 10],
    ]);

    for (const sortBy of ["title", "source", "createdAt", "updatedAt"] as const) {
      for (const sortOrder of ["asc", "desc"] as const) {
        const queryHash = `equal-${sortBy}-${sortOrder}`;
        const common = {
          groups: [] as string[][],
          excludedTerms: [] as string[],
          flatPositiveTerms: ["alpha"],
          hasTextConstraint: false,
          useLexical: true,
          useVector: false,
          queryHash,
          sortBy,
          sortOrder,
          page: 1,
          limit: 1,
          lexicalScores,
          lexicalMatchTerms: ["alpha"],
          lexicalMatchMasksById: new Map<string, number[]>(),
          vectorScoresByIndex: new Map<number, number>(),
        };

        // rankLocally is the exact path used when the bounded worker request
        // rejects or times out. Equal field values must not jump straight to
        // the id tie-break before relevance is considered.
        const fallbackFirst = controller.rankLocally({ items, ...common });
        const streamedFirst = await streamRankCandidates({
          candidates: items,
          batchSize: 1,
          hydrateBatch: async (batch) => [...batch],
          rank: { ...common, nowMs: 2_000_000_000_000 },
        });

        expect(fallbackFirst.itemIds).toEqual(["z-high-score"]);
        expect(streamedFirst.itemIds).toEqual(fallbackFirst.itemIds);
        expect(streamedFirst.nextCursor).toEqual(fallbackFirst.nextCursor);

        const cursorCommon = {
          ...common,
          afterCursor: fallbackFirst.nextCursor,
        };
        const fallbackSecond = controller.rankLocally({ items, ...cursorCommon });
        const streamedSecond = await streamRankCandidates({
          candidates: items,
          batchSize: 1,
          hydrateBatch: async (batch) => [...batch],
          rank: { ...cursorCommon, nowMs: 2_000_000_000_000 },
        });

        expect(fallbackSecond.itemIds).toEqual(["a-low-score"]);
        expect(streamedSecond.itemIds).toEqual(fallbackSecond.itemIds);
        expect(streamedSecond.hasMore).toBe(false);
        expect(fallbackSecond.hasMore).toBe(false);
      }
    }
  });

  test("does not repeat a cursor identity after its relevance score drifts", async () => {
    const items = [
      rankable({ id: "boundary", index: 2 }, ""),
      rankable({ id: "next", index: 1 }, ""),
    ];
    const common: StreamingRankOptions = {
      groups: [],
      excludedTerms: [],
      flatPositiveTerms: ["term"],
      hasTextConstraint: false,
      useLexical: true,
      useVector: false,
      queryHash: "stream-cursor-drift",
      sortBy: "relevance",
      sortOrder: "desc",
      page: 1,
      limit: 1,
      lexicalScores: new Map([
        ["boundary", 10],
        ["next", 5],
      ]),
      lexicalMatchTerms: ["term"],
      lexicalMatchMasksById: new Map(),
      vectorScoresByIndex: new Map(),
      nowMs: 2_000_000_000_000,
    };
    const first = await streamRankCandidates({
      candidates: items,
      batchSize: 1,
      hydrateBatch: async (batch) => [...batch],
      rank: common,
    });
    const driftedCursor = {
      ...first.nextCursor!,
      relevance: first.nextCursor!.relevance + 0.01,
    };
    const second = await streamRankCandidates({
      candidates: items,
      batchSize: 1,
      hydrateBatch: async (batch) => [...batch],
      rank: { ...common, afterCursor: driftedCursor },
    });

    expect(first.itemIds).toEqual(["boundary"]);
    expect(second.itemIds).toEqual(["next"]);
  });
});
