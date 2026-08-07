import { describe, expect, test } from "bun:test";
import {
  buildCompactedIndexMap,
  copyCleanVectorRangesInChunks,
  planCandidateVectorReadChunks,
  planContiguousVectorReadChunks,
  runVectorCompactionWorkerRequest,
  VECTOR_COMPACTION_COPY_CHUNK_SIZE_BYTES,
  type CopyCleanVectorsWorkerRequest,
  type CopyCleanVectorsWorkerResponse,
} from "@src/services/vector-store/compaction-copy";
import {
  VectorCompactionWorkerClient,
  type VectorCompactionWorkerLike,
} from "@src/services/vector-store/compaction-worker-client";
import {
  applyCompactedVectorIndexCommit,
  applyVectorInvalidation,
  isEmbeddingStateCommitCurrent,
} from "@src/services/db-manager";
import type { ItemDocType } from "@src/schemas/item_schema";
import { commitCompactionWithRecovery } from "@src/services/vector-store/compaction-commit";

type Listener = (event: any) => void;

class FakeCompactionWorker implements VectorCompactionWorkerLike {
  public terminateCount = 0;
  public sent: CopyCleanVectorsWorkerRequest[] = [];
  private listeners = new Map<string, Listener[]>();

  constructor(
    private readonly respond?: (
      request: CopyCleanVectorsWorkerRequest
    ) => CopyCleanVectorsWorkerResponse | null
  ) {}

  addEventListener(type: string, listener: Listener) {
    const listeners = this.listeners.get(type) || [];
    listeners.push(listener);
    this.listeners.set(type, listeners);
  }

  removeEventListener(type: string, listener: Listener) {
    const listeners = this.listeners.get(type) || [];
    this.listeners.set(
      type,
      listeners.filter((candidate) => candidate !== listener)
    );
  }

  postMessage(message: CopyCleanVectorsWorkerRequest) {
    this.sent.push(message);
    const response = this.respond?.(message) || null;
    if (!response) return;
    queueMicrotask(() => {
      for (const listener of this.listeners.get("message") || []) {
        listener({ data: response });
      }
    });
  }

  terminate() {
    this.terminateCount += 1;
  }
}

describe("bounded vector compaction", () => {
  test("rejects stale embedding completion after an edit or delete", () => {
    const expected = {
      expectedRevision: "1-embedding-snapshot",
      expectedUpdatedAt: 100,
    };

    expect(
      isEmbeddingStateCommitCurrent(
        { deletedAt: 0, updatedAt: 100 },
        "2-content-edit",
        expected
      )
    ).toBe(false);
    expect(
      isEmbeddingStateCommitCurrent(
        { deletedAt: 200, updatedAt: 200 },
        "3-deleted",
        { expectedRevision: "3-deleted", expectedUpdatedAt: 200 }
      )
    ).toBe(false);
    expect(
      isEmbeddingStateCommitCurrent(
        { deletedAt: 0, updatedAt: 100 },
        "1-embedding-snapshot",
        expected
      )
    ).toBe(true);
  });

  test("recovery invalidation preserves a concurrent edit and deleted state", () => {
    const latestAfterConflict = {
      id: "concurrently-edited",
      title: "user edit that won the write conflict",
      deletedAt: 123,
      updatedAt: 456,
      vector_index: 88,
      vector_indexes: [88],
      isEmbedded: true,
      isDirty: false,
    } as unknown as ItemDocType;

    const invalidated = applyVectorInvalidation(latestAfterConflict);
    expect(invalidated.title).toBe("user edit that won the write conflict");
    expect(invalidated.deletedAt).toBe(123);
    expect(invalidated.updatedAt).toBe(456);
    expect(invalidated.vector_index).toBe(-1);
    expect(invalidated.vector_indexes).toEqual([]);
    expect(invalidated.isEmbedded).toBe(false);
    expect(invalidated.isDirty).toBe(true);
  });

  test("invalidates all indexes instead of restoring one file after a later commit batch fails", async () => {
    const items = Array.from({ length: 4 }, (_, index) => ({
      id: `item-${index}`,
      vector_index: index,
      vector_indexes: [index],
      isEmbedded: true,
      isDirty: false,
    }));
    let vectorFile = ["compacted-vector-bytes"];
    let recoveryFinalized = false;

    const operation = commitCompactionWithRecovery({
      commit: async () => {
        // Simulate batch one committing compacted indexes before batch two
        // fails. Restoring the old file here would corrupt item 0 and item 1.
        items[0].vector_index = 100;
        items[0].vector_indexes = [100];
        items[1].vector_index = 101;
        items[1].vector_indexes = [101];
        throw new Error("second commit batch failed");
      },
      clearVectors: async () => {
        vectorFile = [];
      },
      invalidateItems: async () => {
        for (const item of items) {
          item.vector_index = -1;
          item.vector_indexes = [];
          item.isEmbedded = false;
          item.isDirty = true;
        }
        return items.length;
      },
      finalizeRecovery: async (invalidatedCount) => {
        expect(invalidatedCount).toBe(items.length);
        recoveryFinalized = true;
      },
    });

    await expect(operation).rejects.toThrow("second commit batch failed");
    expect(vectorFile).toEqual([]);
    expect(recoveryFinalized).toBe(true);
    expect(items).toEqual(
      items.map((item, index) => ({
        id: `item-${index}`,
        vector_index: -1,
        vector_indexes: [],
        isEmbedded: false,
        isDirty: true,
      }))
    );
  });

  test("remaps but does not bless a vector when the item changed after its snapshot", () => {
    const editedItem = {
      id: "edited-during-compaction",
      title: "new title saved while compaction was running",
      vector_index: 7,
      vector_indexes: [7],
      isEmbedded: false,
      isDirty: true,
      updatedAt: 200,
    } as unknown as ItemDocType;

    const committed = applyCompactedVectorIndexCommit(editedItem, "2-concurrent-edit", {
      id: editedItem.id,
      vector_index: 41,
      vector_indexes: [41, 42],
      expectedRevision: "1-compaction-snapshot",
      isEmbeddedOnMatch: true,
      isDirtyOnMatch: false,
    });

    expect(committed.title).toBe("new title saved while compaction was running");
    expect(committed.vector_index).toBe(41);
    expect(committed.vector_indexes).toEqual([41, 42]);
    expect(committed.isEmbedded).toBe(false);
    expect(committed.isDirty).toBe(true);
  });

  test("marks the compacted vector current when the exact source revision still matches", () => {
    const unchangedItem = {
      id: "unchanged-during-compaction",
      vector_index: 7,
      vector_indexes: [7],
      isEmbedded: false,
      isDirty: true,
    } as unknown as ItemDocType;

    const committed = applyCompactedVectorIndexCommit(unchangedItem, "1-snapshot", {
      id: unchangedItem.id,
      vector_index: 9,
      vector_indexes: [9],
      expectedRevision: "1-snapshot",
      isEmbeddedOnMatch: true,
      isDirtyOnMatch: false,
    });

    expect(committed.vector_index).toBe(9);
    expect(committed.vector_indexes).toEqual([9]);
    expect(committed.isEmbedded).toBe(true);
    expect(committed.isDirty).toBe(false);
  });

  test("preserves a copied vector's pending state when no re-embedding occurred", () => {
    const pendingItem = {
      id: "metadata-still-pending",
      vector_index: 7,
      vector_indexes: [7],
      isEmbedded: false,
      isDirty: true,
    } as unknown as ItemDocType;

    const committed = applyCompactedVectorIndexCommit(pendingItem, "1-snapshot", {
      id: pendingItem.id,
      vector_index: 12,
      vector_indexes: [12],
      expectedRevision: "1-snapshot",
      isEmbeddedOnMatch: false,
      isDirtyOnMatch: true,
    });

    expect(committed.vector_indexes).toEqual([12]);
    expect(committed.isEmbedded).toBe(false);
    expect(committed.isDirty).toBe(true);
  });

  test("copies 100k contiguous vectors without any read exceeding 2 MiB", async () => {
    const vectorDimension = 768;
    const headerSize = 16;
    const sourceStartIndex = 11;
    const cleanItems = Array.from({ length: 100_000 }, (_, index) => ({
      id: `item-${index}`,
      vector_index: sourceStartIndex + index,
    }));
    const readSizes: number[] = [];
    const readOffsets: number[] = [];
    const writeSizes: number[] = [];
    const writeOffsets: number[] = [];

    const result = await copyCleanVectorRangesInChunks(
      {
        cleanItems,
        destStartIndex: 23,
        vectorDimension,
        headerSize,
      },
      {
        async read(buffer, offset) {
          readSizes.push(buffer.byteLength);
          readOffsets.push(offset);
        },
        async write(buffer, offset) {
          writeSizes.push(buffer.byteLength);
          writeOffsets.push(offset);
        },
      }
    );

    expect(result.appendedCount).toBe(100_000);
    expect(readSizes.length).toBeGreaterThan(1);
    expect(Math.max(...readSizes)).toBeLessThanOrEqual(
      VECTOR_COMPACTION_COPY_CHUNK_SIZE_BYTES
    );
    expect(Math.max(...writeSizes)).toBeLessThanOrEqual(
      VECTOR_COMPACTION_COPY_CHUNK_SIZE_BYTES
    );
    expect(readSizes).toEqual(writeSizes);
    expect(readOffsets[0]).toBe(headerSize + sourceStartIndex * vectorDimension * 4);
    expect(writeOffsets[0]).toBe(headerSize + 23 * vectorDimension * 4);

    for (let index = 1; index < readOffsets.length; index += 1) {
      expect(readOffsets[index]).toBe(readOffsets[index - 1] + readSizes[index - 1]);
      expect(writeOffsets[index]).toBe(writeOffsets[index - 1] + writeSizes[index - 1]);
    }
  });

  test("turns an OPFS copy failure into an explicit worker error response", async () => {
    const request: CopyCleanVectorsWorkerRequest = {
      type: "COPY_CLEAN_VECTORS",
      requestId: 7,
      payload: {
        sourceFile: "vectors.bin",
        destFile: "vectors.tmp",
        cleanItems: [{ id: "item", vector_index: 0 }],
        destStartIndex: 0,
        vectorDimension: 768,
        headerSize: 16,
      },
    };

    const response = await runVectorCompactionWorkerRequest(request, async () => {
      throw new Error("OPFS read failed");
    });

    expect(response).toEqual({
      type: "COPY_CLEAN_VECTORS_RESULT",
      requestId: 7,
      ok: false,
      error: "OPFS read failed",
    });
  });

  test("preserves exact offsets and mapping for gapped and duplicate source indexes", async () => {
    const cleanItems = [
      { id: "a", vector_index: 2 },
      { id: "b", vector_index: 3 },
      { id: "c", vector_index: 9 },
      { id: "d", vector_index: 9 },
      { id: "e", vector_index: 10 },
    ];
    const reads: Array<{ offset: number; bytes: number }> = [];
    const writes: Array<{ offset: number; bytes: number }> = [];

    const result = await copyCleanVectorRangesInChunks(
      {
        cleanItems,
        destStartIndex: 5,
        vectorDimension: 2,
        headerSize: 16,
        maxChunkBytes: 16,
      },
      {
        async read(buffer, offset) {
          reads.push({ offset, bytes: buffer.byteLength });
        },
        async write(buffer, offset) {
          writes.push({ offset, bytes: buffer.byteLength });
        },
      }
    );

    expect(result.appendedCount).toBe(5);
    expect(reads).toEqual([
      { offset: 32, bytes: 16 },
      { offset: 88, bytes: 8 },
      { offset: 88, bytes: 16 },
    ]);
    expect(writes).toEqual([
      { offset: 56, bytes: 16 },
      { offset: 72, bytes: 8 },
      { offset: 80, bytes: 16 },
    ]);
    expect(buildCompactedIndexMap(cleanItems, 5)).toEqual([
      { id: "a", vector_index: 5 },
      { id: "b", vector_index: 6 },
      { id: "c", vector_index: 7 },
      { id: "d", vector_index: 8 },
      { id: "e", vector_index: 9 },
    ]);
  });

  test("plans a 100k-vector streamed scan with the same 2 MiB bound", () => {
    const chunks = planContiguousVectorReadChunks({
      vectorCount: 100_000,
      vectorDimension: 768,
      headerSize: 16,
    });

    expect(chunks.length).toBeGreaterThan(1);
    expect(Math.max(...chunks.map((chunk) => chunk.byteLength))).toBeLessThanOrEqual(
      VECTOR_COMPACTION_COPY_CHUNK_SIZE_BYTES
    );
    expect(chunks.reduce((total, chunk) => total + chunk.count, 0)).toBe(100_000);
    expect(chunks.reduce((total, chunk) => total + chunk.byteLength, 0)).toBe(
      100_000 * 768 * 4
    );
  });

  test("groups sparse candidate reads into bounded sorted windows", () => {
    const chunks = planCandidateVectorReadChunks({
      candidateIndices: [900, 2, 3, 500, 900, -1, 100_000],
      vectorCount: 1_000,
      vectorDimension: 768,
      headerSize: 16,
    });

    expect(chunks.flatMap((chunk) => chunk.candidateIndices)).toEqual([2, 3, 500, 900]);
    expect(Math.max(...chunks.map((chunk) => chunk.byteLength))).toBeLessThanOrEqual(
      VECTOR_COMPACTION_COPY_CHUNK_SIZE_BYTES
    );
  });
});

describe("VectorCompactionWorkerClient", () => {
  const payload = {
    sourceFile: "vectors.bin",
    destFile: "vectors.tmp",
    cleanItems: [{ id: "item", vector_index: 0 }],
    destStartIndex: 0,
    vectorDimension: 768,
    headerSize: 16,
  };

  test("settles an explicit worker failure and always terminates the worker", async () => {
    const worker = new FakeCompactionWorker((request) => ({
      type: "COPY_CLEAN_VECTORS_RESULT",
      requestId: request.requestId,
      ok: false,
      error: "OPFS write failed",
    }));
    const client = new VectorCompactionWorkerClient(() => worker, 1_000);

    await expect(client.copyCleanVectors(payload)).rejects.toThrow("OPFS write failed");
    expect(worker.terminateCount).toBe(1);
  });

  test("returns a successful count and terminates the one-shot worker", async () => {
    const worker = new FakeCompactionWorker((request) => ({
      type: "COPY_CLEAN_VECTORS_RESULT",
      requestId: request.requestId,
      ok: true,
      payload: { appendedCount: 1 },
    }));
    const client = new VectorCompactionWorkerClient(() => worker, 1_000);

    await expect(client.copyCleanVectors(payload)).resolves.toEqual({ appendedCount: 1 });
    expect(worker.terminateCount).toBe(1);
  });

  test("times out a non-responsive worker and releases it", async () => {
    const worker = new FakeCompactionWorker();
    const client = new VectorCompactionWorkerClient(() => worker, 5);

    await expect(client.copyCleanVectors(payload)).rejects.toThrow(
      "Vector compaction worker timed out"
    );
    expect(worker.terminateCount).toBe(1);
  });
});
