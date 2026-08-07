import { describe, expect, test } from "bun:test";
import { Charset, Document } from "flexsearch";
import { LocalSearchIndexService } from "../src/services/local-search-index.service";
import { ItemsController } from "../src/services/controllers/items.controller";
import {
  hasEmbeddableText,
  hasVectorReference,
  isMetadataReadyForEmbedding,
} from "../src/search-core/embedding-state";
import { shouldKeepHybridRankHit } from "../src/search-core/hybrid-ranking";
import { resolveSearchSpaceIds } from "../src/search-core/space-scope";
import { forEachIdKeysetPage } from "../src/services/rxdb-keyset-pagination";
import {
  canNarrowExpressionToPositiveMatches,
  expressionCanMatchWithoutPositiveTerm,
} from "../src/search-core/expression-analysis";
import { RANK_REQUEST_SUPERSEDED } from "../src/services/query-ranker.service";
import { resolveEffectiveQueryChannels } from "../src/search-core/contracts";
import { resolveIncludedTagIds } from "../src/search-core/tag-filter";

describe("search regressions", () => {
  test("recognizes vector-backed records and embeddable records separately", () => {
    expect(hasVectorReference({ vector_index: -1, vector_indexes: [] })).toBe(false);
    expect(hasVectorReference({ vector_index: -1, vector_indexes: [7, 7] })).toBe(true);
    expect(hasEmbeddableText({ title: "Bookmark", textContent: "", ocrText: "", url: "" })).toBe(true);
    expect(hasEmbeddableText({ title: "", textContent: "", ocrText: "", url: "" })).toBe(false);
  });

  test("does not admit an item to embedding until metadata is complete", () => {
    expect(isMetadataReadyForEmbedding({ isMetaFetched: false })).toBe(false);
    expect(isMetadataReadyForEmbedding({ isMetaFetched: true })).toBe(true);
  });

  test("keeps hybrid results from either channel and excludes unrelated records", () => {
    const options = { useLexical: true, useVector: true, hasPositiveTextTerms: true };
    expect(shouldKeepHybridRankHit({ hasLexicalHit: true, hasVectorHit: false }, options)).toBe(true);
    expect(shouldKeepHybridRankHit({ hasLexicalHit: false, hasVectorHit: true }, options)).toBe(true);
    expect(shouldKeepHybridRankHit({ hasLexicalHit: false, hasVectorHit: false }, options)).toBe(false);
  });

  test("falls back to keyword search for a short vector-only query", () => {
    expect(
      resolveEffectiveQueryChannels({
        requested: { keyword: false, fuzzy: false, vector: true },
        query: "ai",
        vectorMinChars: 3,
      })
    ).toEqual({ keyword: true, fuzzy: false, vector: false });

    expect(
      resolveEffectiveQueryChannels({
        requested: { keyword: false, fuzzy: false, vector: true },
        query: "agents",
        vectorMinChars: 3,
      })
    ).toEqual({ keyword: false, fuzzy: false, vector: true });
  });

  test("does not acquire a vector lease for the short-query keyword fallback", async () => {
    const controller = new ItemsController() as any;
    let leaseAttempts = 0;
    controller.vectorStore = {
      acquireQueryLease: async () => {
        leaseAttempts += 1;
        throw new Error("unexpected vector lease");
      },
    };
    controller.queryLocalWithVectorLease = async (
      _payload: unknown,
      _generation: unknown,
      _signal: unknown,
      lease: unknown
    ) => {
      expect(lease).toBeNull();
      return {};
    };

    await controller.queryLocal({
      searchClientId: "short-vector-test",
      query: "ai",
      useKeyword: false,
      useFuzzy: false,
      useVector: true,
    });

    expect(leaseAttempts).toBe(0);
  });

  test("keeps an unresolved included tag restrictive", () => {
    expect(
      resolveIncludedTagIds({
        requestedIds: [],
        requestedNames: ["missing-tag"],
        tags: [{ id: "tag-known", name: "known" }],
      })
    ).toEqual({ tagIds: [], hasUnresolvedName: true });
  });

  test("does not expose stale vector indexes from dirty or unembedded candidates", () => {
    const controller = new ItemsController() as any;
    const candidateFor = (isEmbedded: boolean, isDirty: boolean) => {
      const values: Record<string, unknown> = {
        id: `${isEmbedded}-${isDirty}`,
        media: [],
        url: "",
        source: "web",
        spaceId: "space-a",
        folderId: "folder-a",
        isEmbedded,
        isDirty,
        vector_index: 41,
        vector_indexes: [41, 42],
      };
      return controller.toCandidateLite({
        get: (field: string) => values[field],
      });
    };

    expect(candidateFor(true, false).vectorIndexes).toEqual([41, 42]);
    expect(candidateFor(true, true).vectorIndexes).toEqual([]);
    expect(candidateFor(false, false).vectorIndexes).toEqual([]);
  });

  test("strict FlexSearch phrases do not expand into one-term suggestions", () => {
    const index = new Document({
      tokenize: "forward",
      encoder: Charset.LatinAdvanced,
      document: { id: "id", index: [{ field: "title", tokenize: "forward", resolution: 9 }] },
    });
    index.add({ id: "exact", title: "apple pie" });
    index.add({ id: "partial", title: "apple" });
    index.add({ id: "other", title: "banana pie" });

    expect(index.search("apple pie", { limit: 10, suggest: false })).toEqual([
      { field: "title", result: ["exact"] },
    ]);
  });

  test("uses strict lookup for keyword-only service searches", async () => {
    const index = new Document({
      tokenize: "forward",
      encoder: Charset.LatinAdvanced,
      document: { id: "id", index: [{ field: "title", tokenize: "forward", resolution: 9 }] },
    });
    index.add({ id: "exact", title: "apple pie" });
    index.add({ id: "partial", title: "apple" });
    index.add({ id: "other", title: "banana pie" });

    const service = new LocalSearchIndexService() as any;
    service.index = index;
    service.dirty = false;

    const scores = await service.search({
      query: "apple pie",
      queries: ["apple pie"],
      limit: 10,
      keyword: true,
      fuzzy: false,
    });
    expect(Array.from(scores.keys())).toEqual(["exact"]);
  });

  test("catches up item changes that arrive during a paged index build", async () => {
    const service = new LocalSearchIndexService() as any;
    let buildAttempts = 0;
    const catchUpBatches: string[][] = [];
    service.emitProcessStatus = () => {};
    service.syncItemsIncremental = async (ids: string[]) => {
      catchUpBatches.push(ids);
      return ids.length;
    };
    service.buildIndexWithMode = async () => {
      buildAttempts += 1;
      service.index = { clear: async () => {} };
      service.indexedCount = buildAttempts;
      service.scheduleItemSync([`changed-during-build-${buildAttempts}`]);
    };

    await service.rebuild();

    expect(buildAttempts).toBe(1);
    expect(catchUpBatches).toEqual([["changed-during-build-1"]]);
    expect(service.dirty).toBe(false);
    expect(service.indexedCount).toBe(1);
  });

  test("caps repeated full-rebuild invalidations instead of livelocking", async () => {
    const service = new LocalSearchIndexService() as any;
    let buildAttempts = 0;
    service.emitProcessStatus = () => {};
    service.syncItemsIncremental = async () => 0;
    service.buildIndexWithMode = async () => {
      buildAttempts += 1;
      service.index = { clear: async () => {} };
      service.markDirty();
    };

    await service.rebuild();

    expect(buildAttempts).toBe(2);
    expect(service.dirty).toBe(true);
  });

  test("bounds a 100,000-ID incremental queue and falls back to a full rebuild", () => {
    const service = new LocalSearchIndexService() as any;
    service.dirty = false;
    service.index = {};
    // Keep the debounce path deterministic and prevent a real database sync.
    service.incrementalSyncInFlight = true;

    service.scheduleItemSync(
      Array.from({ length: 100_000 }, (_, index) => `changed-${index}`)
    );

    expect(service.pendingItemIds.size).toBeLessThanOrEqual(5_000);
    expect(service.dirty).toBe(true);
    expect(service.fullRebuildGeneration).toBeGreaterThan(0);
  });

  test("does not repeat the cursor item when its relevance changed between pages", () => {
    const controller = new ItemsController() as any;
    const items = [
      {
        id: "boundary",
        title: "boundary",
        textContent: "",
        ocrText: "",
        url: "",
        source: "web" as const,
        authorUsername: "",
        mediaTypes: [],
        vector_index: -1,
        vector_indexes: [],
        createdAt: 0,
        updatedAt: 0,
      },
      {
        id: "next",
        title: "next",
        textContent: "",
        ocrText: "",
        url: "",
        source: "web" as const,
        authorUsername: "",
        mediaTypes: [],
        vector_index: -1,
        vector_indexes: [],
        createdAt: 0,
        updatedAt: 0,
      },
    ];
    const common = {
      items,
      groups: [] as string[][],
      excludedTerms: [] as string[],
      flatPositiveTerms: ["term"],
      hasTextConstraint: false,
      useLexical: true,
      useVector: false,
      sortBy: "relevance" as const,
      sortOrder: "desc" as const,
      page: 1,
      limit: 1,
      queryHash: "cursor-drift",
      lexicalScores: new Map([
        ["boundary", 10],
        ["next", 5],
      ]),
      lexicalMatchTerms: ["term"],
      lexicalMatchMasksById: new Map<string, number[]>(),
      vectorScoresByIndex: new Map<number, number>(),
    };
    const first = controller.rankLocally(common);
    const driftedCursor = {
      ...first.nextCursor,
      relevance: (first.nextCursor?.relevance || 0) + 0.01,
    };

    const second = controller.rankLocally({ ...common, afterCursor: driftedCursor });

    expect(first.itemIds).toEqual(["boundary"]);
    expect(second.itemIds).toEqual(["next"]);
  });

  test("records the fuzzy query term responsible for each lexical hit", async () => {
    const service = new LocalSearchIndexService() as any;
    const index = service.createIndex(false);
    index.add({
      id: "fuzzy-hit",
      title: "Kubernetes handbook",
      textContent: "",
      ocrText: "",
      url: "",
      author: "",
      tagsText: "",
      source: "web",
      phoneticTitle: "",
      phoneticAuthor: "",
    });
    index.add({
      id: "exact-hit",
      title: "Rust handbook",
      textContent: "",
      ocrText: "",
      url: "",
      author: "",
      tagsText: "",
      source: "web",
      phoneticTitle: "",
      phoneticAuthor: "",
    });
    service.index = index;
    service.dirty = false;

    const result = await service.searchWithStatus({
      query: "kubernets rust",
      queries: ["kubernets", "rust"],
      limit: 20,
      keyword: true,
      fuzzy: true,
      trackTermMatches: true,
    });

    expect(result.terms).toEqual(["kubernets", "rust"]);
    expect((result.termMatchMasksById.get("fuzzy-hit")?.[0] || 0) & 1).toBe(1);
    expect((result.termMatchMasksById.get("exact-hit")?.[0] || 0) & 2).toBe(2);
  });

  test("applies space and folder scope before the global lexical result cap", async () => {
    const service = new LocalSearchIndexService() as any;
    const index = service.createIndex(false);
    const searchableDoc = {
      title: "needle",
      textContent: "",
      ocrText: "",
      url: "",
      author: "",
      tagsText: "",
      source: "web",
      phoneticTitle: "N340",
      phoneticAuthor: "",
    };

    for (let indexNumber = 0; indexNumber < 7_600; indexNumber += 1) {
      index.add({
        ...searchableDoc,
        id: `outside-${indexNumber}`,
        spaceId: "space-outside",
        folderId: "folder-outside",
      });
    }
    index.add({
      ...searchableDoc,
      id: "inside-target",
      spaceId: "space-inside",
      folderId: "folder-inside",
    });
    service.index = index;
    service.dirty = false;

    const scopedScores = await service.search({
      query: "needle",
      queries: ["needle"],
      limit: 2_500,
      keyword: true,
      fuzzy: false,
      allowedIds: new Set(["inside-target"]),
    });
    expect(Array.from(scopedScores.keys())).toEqual(["inside-target"]);
  });

  test("pages past a stale indexed count to find a late scoped hit", async () => {
    const service = new LocalSearchIndexService() as any;
    const index = service.createIndex(false);
    const searchableDoc = {
      title: "late needle",
      textContent: "",
      ocrText: "",
      url: "",
      author: "",
      tagsText: "",
      source: "web",
      phoneticTitle: "",
      phoneticAuthor: "",
    };

    for (let indexNumber = 0; indexNumber < 22_750; indexNumber += 1) {
      index.add({ ...searchableDoc, id: `stale-count-outside-${indexNumber}` });
    }
    index.add({ ...searchableDoc, id: "late-inside-target" });
    service.index = index;
    service.indexedCount = 1;
    service.dirty = false;

    const scopedScores = await service.search({
      query: "late needle",
      queries: ["late needle"],
      limit: 2_500,
      keyword: true,
      fuzzy: false,
      allowedIds: new Set(["late-inside-target"]),
    });

    expect(Array.from(scopedScores.keys())).toEqual(["late-inside-target"]);
  });

  test("stops scoped paging when an index returns the same saturated page", async () => {
    const service = new LocalSearchIndexService() as any;
    let searchCalls = 0;
    const repeatedIds = Array.from({ length: 60 }, (_, index) => `repeat-${index}`);
    service.index = {
      search: () => {
        searchCalls += 1;
        return [{ field: "title", result: repeatedIds }];
      },
    };
    service.indexedCount = 0;
    service.dirty = false;

    const scores = await service.search({
      query: "needle",
      queries: ["needle"],
      limit: 20,
      keyword: true,
      fuzzy: false,
      allowedIds: new Set(["never-returned"]),
    });

    expect(scores.size).toBe(0);
    expect(searchCalls).toBe(2);
  });

  test("does not truncate scoped matches at one full result page", async () => {
    const service = new LocalSearchIndexService() as any;
    const index = service.createIndex(false);
    const allowedIds = new Set<string>();

    for (let indexNumber = 0; indexNumber < 8_000; indexNumber += 1) {
      const id = `allowed-match-${indexNumber}`;
      allowedIds.add(id);
      index.add({
        id,
        title: "complete needle",
        textContent: "",
        ocrText: "",
        url: "",
        author: "",
        tagsText: "",
        source: "web",
        phoneticTitle: "",
        phoneticAuthor: "",
      });
    }
    service.index = index;
    service.indexedCount = 1;
    service.dirty = false;

    const scopedScores = await service.search({
      query: "complete needle",
      queries: ["complete needle"],
      limit: 2_500,
      keyword: true,
      fuzzy: false,
      allowedIds,
    });

    expect(scopedScores.size).toBe(8_000);
  });

  test("keeps fuzzy lexical hits when evaluating an explicit boolean expression", () => {
    const controller = new ItemsController() as any;
    const rankableItem = (id: string, title: string) => ({
      id,
      title,
      textContent: "",
      ocrText: "",
      url: "",
      source: "web" as const,
      authorUsername: "",
      mediaTypes: [],
      vector_index: -1,
      vector_indexes: [],
      createdAt: 1,
      updatedAt: 1,
    });

    const result = controller.rankLocally({
      items: [
        rankableItem("fuzzy-hit", "Kubernetes handbook"),
        rankableItem("exact-hit", "Rust handbook"),
      ],
      expression: {
        type: "OR",
        children: [
          { type: "TERM", value: "kubernets" },
          { type: "TERM", value: "rust" },
        ],
      },
      groups: [["kubernets"], ["rust"]],
      excludedTerms: [],
      flatPositiveTerms: ["kubernets", "rust"],
      hasTextConstraint: true,
      useLexical: true,
      useVector: false,
      sortBy: "relevance",
      sortOrder: "desc",
      page: 1,
      limit: 20,
      queryHash: "boolean-fuzzy",
      lexicalScores: new Map([
        ["fuzzy-hit", 10],
        ["exact-hit", 10],
      ]),
      lexicalMatchTerms: ["kubernets", "rust"],
      lexicalMatchMasksById: new Map([
        ["fuzzy-hit", [1]],
        ["exact-hit", [2]],
      ]),
      vectorScoresByIndex: new Map(),
    });

    expect(new Set(result.itemIds)).toEqual(new Set(["fuzzy-hit", "exact-hit"]));

    const andResult = controller.rankLocally({
      items: [
        rankableItem("fuzzy-hit", "Kubernetes handbook"),
        rankableItem("exact-hit", "Rust handbook"),
        rankableItem("both", "Kubernetes and Rust handbook"),
      ],
      expression: {
        type: "AND",
        children: [
          { type: "TERM", value: "kubernets" },
          { type: "TERM", value: "rust" },
        ],
      },
      groups: [["kubernets", "rust"]],
      excludedTerms: [],
      flatPositiveTerms: ["kubernets", "rust"],
      hasTextConstraint: true,
      useLexical: true,
      useVector: false,
      sortBy: "relevance",
      sortOrder: "desc",
      page: 1,
      limit: 20,
      queryHash: "boolean-fuzzy-and",
      lexicalScores: new Map([
        ["fuzzy-hit", 10],
        ["exact-hit", 10],
        ["both", 10],
      ]),
      lexicalMatchTerms: ["kubernets", "rust"],
      lexicalMatchMasksById: new Map([
        ["fuzzy-hit", [1]],
        ["exact-hit", [2]],
        ["both", [3]],
      ]),
      vectorScoresByIndex: new Map(),
    });

    expect(andResult.itemIds).toEqual(["both"]);
  });

  test("keeps an item that matches only the thirteenth OR term", async () => {
    const terms = Array.from({ length: 13 }, (_, index) => `uniquequery${index + 1}x`);
    const lastTerm = terms[12];
    const service = new LocalSearchIndexService() as any;
    const index = service.createIndex(false);
    index.add({
      id: "term-thirteen-hit",
      title: lastTerm,
      textContent: "",
      ocrText: "",
      url: "",
      author: "",
      tagsText: "",
      source: "web",
      phoneticTitle: "",
      phoneticAuthor: "",
    });
    service.index = index;
    service.dirty = false;

    const lexical = await service.searchWithStatus({
      query: terms.join(" "),
      queries: terms,
      limit: 20,
      keyword: true,
      fuzzy: false,
      trackTermMatches: true,
    });
    const controller = new ItemsController() as any;
    const ranked = controller.rankLocally({
      items: [{
        id: "term-thirteen-hit",
        title: lastTerm,
        textContent: "",
        ocrText: "",
        url: "",
        source: "web",
        authorUsername: "",
        mediaTypes: [],
        vector_index: -1,
        vector_indexes: [],
        createdAt: 1,
        updatedAt: 1,
      }],
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
      sortBy: "relevance",
      sortOrder: "desc",
      page: 1,
      limit: 20,
      queryHash: "thirteen-term-or",
      lexicalScores: lexical.scores,
      lexicalMatchTerms: lexical.terms,
      lexicalMatchMasksById: lexical.termMatchMasksById,
      vectorScoresByIndex: new Map(),
    });

    expect(lexical.terms).toHaveLength(13);
    expect(ranked.itemIds).toEqual(["term-thirteen-hit"]);
  });

  test("tracks explicit query terms across multiple bitset words", async () => {
    const terms = Array.from({ length: 40 }, (_, index) => `bitsetquery${index + 1}z`);
    const service = new LocalSearchIndexService() as any;
    const index = service.createIndex(false);
    index.add({
      id: "bitset-word-two",
      title: terms[39],
      textContent: "",
      ocrText: "",
      url: "",
      author: "",
      tagsText: "",
      source: "web",
      phoneticTitle: "",
      phoneticAuthor: "",
    });
    service.index = index;
    service.dirty = false;

    const lexical = await service.searchWithStatus({
      query: terms.join(" "),
      queries: terms,
      limit: 20,
      keyword: true,
      fuzzy: false,
      trackTermMatches: true,
    });
    const words = lexical.termMatchMasksById.get("bitset-word-two") || [];

    expect(lexical.terms).toHaveLength(40);
    expect((words[1] || 0) & (1 << 7)).not.toBe(0);
  });

  test("does not let a delayed older query replace the current vector controller", async () => {
    const controller = new ItemsController() as any;
    const olderGeneration = controller.beginSearchGeneration();
    let releaseOlder!: () => void;
    const olderGate = new Promise<void>((resolve) => {
      releaseOlder = resolve;
    });
    const delayedOlderPhase = olderGate.then(() =>
      controller.startVectorSearchPhase(olderGeneration)
    );

    const currentGeneration = controller.beginSearchGeneration();
    const currentController = controller.startVectorSearchPhase(currentGeneration);
    releaseOlder();

    await expect(delayedOlderPhase).rejects.toThrow("RANK_REQUEST_SUPERSEDED");
    expect(controller.activeVectorSearchAbortController).toBe(currentController);
    expect(currentController.signal.aborted).toBe(false);

    controller.beginSearchGeneration();
    expect(currentController.signal.aborted).toBe(true);
  });

  test("isolates overlapping search generations by Search page client ID", () => {
    const controller = new ItemsController() as any;
    const olderA = controller.beginSearchGeneration("search-page-a");
    const olderASignal = controller.getSearchSignal(olderA);
    const clientB = controller.beginSearchGeneration("search-page-b");
    const clientBSignal = controller.getSearchSignal(clientB);

    expect(olderASignal.aborted).toBe(false);
    expect(clientBSignal.aborted).toBe(false);
    expect(() => controller.assertSearchGeneration(olderA)).not.toThrow();
    expect(() => controller.assertSearchGeneration(clientB)).not.toThrow();

    const newerA = controller.beginSearchGeneration("search-page-a");
    const newerASignal = controller.getSearchSignal(newerA);
    expect(olderASignal.aborted).toBe(true);
    expect(clientBSignal.aborted).toBe(false);
    expect(newerASignal.aborted).toBe(false);
    expect(() => controller.assertSearchGeneration(olderA)).toThrow(
      RANK_REQUEST_SUPERSEDED
    );
    expect(() => controller.assertSearchGeneration(clientB)).not.toThrow();

    // A stale request's cleanup must not remove its replacement context.
    controller.finishSearchGeneration(olderA);
    expect(() => controller.assertSearchGeneration(newerA)).not.toThrow();
    controller.finishSearchGeneration(clientB);
    expect(() => controller.assertSearchGeneration(newerA)).not.toThrow();
    expect((controller.searchContextsByClient as Map<string, unknown>).size).toBe(1);
    controller.finishSearchGeneration(newerA);
    expect((controller.searchContextsByClient as Map<string, unknown>).size).toBe(0);
  });

  test("a superseding query stops the older lexical page scan", async () => {
    const service = new LocalSearchIndexService() as any;
    const controller = new ItemsController() as any;
    let searchCalls = 0;
    let markFirstPage!: () => void;
    const firstPageStarted = new Promise<void>((resolve) => {
      markFirstPage = resolve;
    });
    service.index = {
      search: (_query: string, options: { offset?: number }) => {
        searchCalls += 1;
        if (searchCalls === 1) markFirstPage();
        const offset = options.offset || 0;
        return [{
          field: "title",
          result: Array.from({ length: 60 }, (_, index) => `page-${offset + index}`),
        }];
      },
    };
    service.dirty = false;

    const generation = controller.beginSearchGeneration();
    const lexicalController = controller.startLexicalSearchPhase(generation);
    const scan = service.searchWithStatus({
      query: "needle",
      queries: ["needle"],
      limit: 20,
      keyword: true,
      fuzzy: false,
      allowedIds: new Set(["not-present"]),
      signal: lexicalController.signal,
    });
    await firstPageStarted;

    controller.beginSearchGeneration();
    await expect(scan).rejects.toThrow("RANK_REQUEST_SUPERSEDED");
    const callsAfterAbort = searchCalls;
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
    expect(searchCalls).toBe(callsAfterAbort);
    expect(searchCalls).toBeLessThan(1024);
  });

  test("a lexical timeout aborts the underlying page scan", async () => {
    const service = new LocalSearchIndexService() as any;
    const controller = new ItemsController() as any;
    let searchCalls = 0;
    service.index = {
      search: async (_query: string, options: { offset?: number }) => {
        searchCalls += 1;
        const offset = options.offset || 0;
        await new Promise<void>((resolve) => setTimeout(resolve, 3));
        return [{
          field: "title",
          result: Array.from({ length: 60 }, (_, index) => `slow-${offset + index}`),
        }];
      },
    };
    service.dirty = false;

    const generation = controller.beginSearchGeneration();
    const lexicalController = controller.startLexicalSearchPhase(generation);
    const timeoutMessage = "LEXICAL_TEST_TIMEOUT";
    const scan = service.searchWithStatus({
      query: "needle",
      queries: ["needle"],
      limit: 20,
      keyword: true,
      fuzzy: false,
      allowedIds: new Set(["not-present"]),
      signal: lexicalController.signal,
    });

    await expect(
      controller.withTimeout(
        scan,
        5,
        timeoutMessage,
        () => lexicalController.abort(new Error(timeoutMessage))
      )
    ).rejects.toThrow(timeoutMessage);
    const callsAfterTimeout = searchCalls;
    await new Promise<void>((resolve) => setTimeout(resolve, 15));
    expect(searchCalls).toBe(callsAfterTimeout);
    expect(searchCalls).toBeLessThan(1024);
    controller.beginSearchGeneration();
  });

  test("a delayed older candidate page cannot supersede the current query", async () => {
    const controller = new ItemsController() as any;
    const olderGeneration = controller.beginSearchGeneration();
    const olderSignal = controller.getSearchSignal(olderGeneration);
    let releasePage!: () => void;
    let markPageStarted!: () => void;
    const pageGate = new Promise<void>((resolve) => {
      releasePage = resolve;
    });
    const pageStarted = new Promise<void>((resolve) => {
      markPageStarted = resolve;
    });
    let findCalls = 0;
    const olderPaging = forEachIdKeysetPage({
      collection: {
        find: () => ({
          exec: async () => {
            findCalls += 1;
            markPageStarted();
            await pageGate;
            return [{ primary: "item-a" }, { primary: "item-b" }];
          },
        }),
      },
      selector: { deletedAt: { $eq: 0 } },
      pageSize: 2,
      signal: olderSignal,
      onPage: () => {},
    });
    await pageStarted;

    const currentGeneration = controller.beginSearchGeneration();
    const currentSignal = controller.getSearchSignal(currentGeneration);
    releasePage();

    await expect(olderPaging).rejects.toThrow("RANK_REQUEST_SUPERSEDED");
    expect(() => controller.assertSearchGeneration(olderGeneration)).toThrow(
      "RANK_REQUEST_SUPERSEDED"
    );
    expect(currentSignal.aborted).toBe(false);
    expect(findCalls).toBe(1);
  });

  test("keeps positive-free OR branches in lexical and hybrid ranking", () => {
    const controller = new ItemsController() as any;
    const item = (id: string, title: string, vectorIndex: number) => ({
      id,
      title,
      textContent: "",
      ocrText: "",
      url: "",
      source: "web" as const,
      authorUsername: "",
      mediaTypes: [],
      vector_index: vectorIndex,
      vector_indexes: [vectorIndex],
      createdAt: 1,
      updatedAt: 1,
    });
    const items = [
      item("alpha", "alpha", 0),
      item("beta", "beta", 1),
      item("gamma", "gamma", 2),
    ];
    const common = {
      items,
      expression: {
        type: "OR" as const,
        children: [
          { type: "TERM" as const, value: "alpha" },
          { type: "NOT" as const, child: { type: "TERM" as const, value: "beta" } },
        ],
      },
      groups: [["alpha"]],
      excludedTerms: [],
      flatPositiveTerms: ["alpha"],
      hasTextConstraint: true,
      sortBy: "relevance" as const,
      sortOrder: "desc" as const,
      page: 1,
      limit: 10,
      queryHash: "positive-free-or",
      lexicalScores: new Map([["alpha", 10]]),
      lexicalMatchTerms: ["alpha"],
      lexicalMatchMasksById: new Map([["alpha", [1]]]),
      includeDebug: true,
    };

    expect(expressionCanMatchWithoutPositiveTerm(common.expression)).toBe(true);
    expect(canNarrowExpressionToPositiveMatches(common.expression)).toBe(false);
    expect(
      canNarrowExpressionToPositiveMatches({
        type: "AND",
        children: [
          { type: "TERM", value: "alpha" },
          { type: "NOT", child: { type: "TERM", value: "beta" } },
        ],
      })
    ).toBe(true);

    const lexical = controller.rankLocally({
      ...common,
      useLexical: true,
      useVector: false,
      vectorScoresByIndex: new Map(),
    });
    const hybrid = controller.rankLocally({
      ...common,
      useLexical: true,
      useVector: true,
      vectorScoresByIndex: new Map([[0, 0.8]]),
    });

    expect(lexical.itemIds).toEqual(["alpha", "gamma"]);
    expect(lexical.total).toBe(2);
    expect(hybrid.itemIds).toEqual(["alpha", "gamma"]);
    expect(hybrid.total).toBe(2);
  });

  test("keeps global search global while constraining a selected space group", () => {
    expect(
      resolveSearchSpaceIds({
        activeSpaceId: "space-current",
        activeSpaceGroupId: null,
        activeSpaceGroupSpaceIds: [],
        requestedScope: "global",
        requestedSpaceIds: [],
      })
    ).toEqual([]);
    expect(
      resolveSearchSpaceIds({
        activeSpaceId: "space-current",
        activeSpaceGroupId: "group-1",
        activeSpaceGroupSpaceIds: ["space-a", "space-b"],
        requestedScope: "global",
        requestedSpaceIds: [],
      })
    ).toEqual(["space-a", "space-b"]);
    expect(
      resolveSearchSpaceIds({
        activeSpaceId: "space-current",
        activeSpaceGroupId: "group-1",
        activeSpaceGroupSpaceIds: ["space-a", "space-b"],
        requestedScope: "global",
        requestedSpaceIds: ["space-b", "space-c"],
      })
    ).toEqual(["space-b"]);
  });
});
