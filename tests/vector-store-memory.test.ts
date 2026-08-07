import { describe, expect, test } from "bun:test";
import { VECTOR_DIMENSION } from "@src/common/constants";
import {
  VectorStoreService,
  VectorStoreIntegrityError,
  VECTOR_MEMORY_IDLE_RELEASE_MS,
} from "@src/services/vector-store.service";
import { ItemsController } from "@src/services/controllers/items.controller";
import { VECTOR_COMPACTION_COPY_CHUNK_SIZE_BYTES } from "@src/services/vector-store/compaction-copy";
import { invalidatePartiallyCommittedCompaction } from "@src/services/vector-store/compaction-commit";
import type { OpfsHandler } from "@src/services/vector-store/opfs-handler";

type FakeVectorState = {
  vectorCount: number;
  fileSizeOverride?: number;
  openCount: number;
  closeCount: number;
  deleteCount: number;
  readSizes: number[];
  writes: Array<{ offset: number; bytes: number }>;
  onBodyRead?: () => void;
  beforeBodyRead?: () => Promise<void>;
};

class FakeVectorOpfs {
  private opened = false;
  public readonly state: FakeVectorState;

  constructor(vectorCountOrState: number | FakeVectorState) {
    this.state =
      typeof vectorCountOrState === "number"
        ? {
            vectorCount: vectorCountOrState,
            openCount: 0,
            closeCount: 0,
            deleteCount: 0,
            readSizes: [],
            writes: [],
          }
        : vectorCountOrState;
  }

  get vectorCount() {
    return this.state.vectorCount;
  }

  get openCount() {
    return this.state.openCount;
  }

  get closeCount() {
    return this.state.closeCount;
  }

  get readSizes() {
    return this.state.readSizes;
  }

  get writes() {
    return this.state.writes;
  }

  fork() {
    return new FakeVectorOpfs(this.state);
  }

  async open() {
    this.opened = true;
    this.state.openCount += 1;
  }

  async getSize() {
    return (
      this.state.fileSizeOverride ??
      16 + this.state.vectorCount * VECTOR_DIMENSION * Float32Array.BYTES_PER_ELEMENT
    );
  }

  async read(buffer: ArrayBuffer, offset: number) {
    if (!this.opened) throw new Error("File not open");
    this.state.readSizes.push(buffer.byteLength);
    if (offset === 0) {
      const header = new DataView(buffer);
      header.setUint32(0, 0x56494245, true);
      header.setUint32(4, 1, true);
      header.setUint32(8, VECTOR_DIMENSION, true);
      header.setUint32(12, this.state.vectorCount, true);
      return;
    }

    this.state.onBodyRead?.();
    await this.state.beforeBodyRead?.();
    const firstVectorIndex = Math.floor(
      (offset - 16) / (VECTOR_DIMENSION * Float32Array.BYTES_PER_ELEMENT)
    );
    const vectors = new Float32Array(buffer);
    const count = Math.floor(vectors.length / VECTOR_DIMENSION);
    for (let localIndex = 0; localIndex < count; localIndex++) {
      vectors[localIndex * VECTOR_DIMENSION] =
        (firstVectorIndex + localIndex + 1) / Math.max(1, this.state.vectorCount);
    }
  }

  async write(buffer: ArrayBuffer, offset: number) {
    if (!this.opened) throw new Error("File not open");
    this.state.writes.push({ offset, bytes: buffer.byteLength });
    if (offset === 12 && buffer.byteLength === 4) {
      this.state.vectorCount = new DataView(buffer).getUint32(0, true);
      this.state.fileSizeOverride = undefined;
    } else if (offset === 0 && buffer.byteLength >= 16) {
      this.state.vectorCount = new DataView(buffer).getUint32(12, true);
      this.state.fileSizeOverride = undefined;
    }
  }

  async deleteSelf() {
    if (!this.opened) return;
    this.state.deleteCount += 1;
    this.state.vectorCount = 0;
    this.state.fileSizeOverride = undefined;
    this.opened = false;
  }

  close() {
    if (this.opened) this.state.closeCount += 1;
    this.opened = false;
  }
}

describe("VectorStoreService memory lifecycle", () => {
  test("returns an empty result without opening OPFS for an empty query", async () => {
    const opfs = new FakeVectorOpfs(100_000);
    const service = new VectorStoreService({
      opfsHandler: opfs as unknown as OpfsHandler,
      idleReleaseMs: 0,
    });

    await expect(service.search({ query: "   ", topK: 10 })).resolves.toEqual({
      results: [],
      timings: {
        embeddingMs: 0,
        scanMs: 0,
        totalMs: 0,
        scannedCount: 0,
      },
    });
    expect(opfs.openCount).toBe(0);
    expect(opfs.readSizes).toEqual([]);
  });

  test("retains zero vector-body bytes after reading a 100k-vector header", async () => {
    const opfs = new FakeVectorOpfs(100_000);
    const service = new VectorStoreService({
      opfsHandler: opfs as unknown as OpfsHandler,
      opfsFactory: () => opfs.fork() as unknown as OpfsHandler,
      idleReleaseMs: 0,
    });

    await expect(service.getVectorCount()).resolves.toBe(100_000);
    expect(service.getResidentVectorBytes()).toBe(0);
    expect(opfs.readSizes).toEqual([16]);
    await service.releaseMemory();
  });

  test("streams sparse candidates in bounded reads and preserves exact ranking", async () => {
    const opfs = new FakeVectorOpfs(10);
    const service = new VectorStoreService({
      opfsHandler: opfs as unknown as OpfsHandler,
      opfsFactory: () => opfs.fork() as unknown as OpfsHandler,
      idleReleaseMs: 0,
      embeddingGenerator: {
        async generateEmbeddings() {
          const query = new Float32Array(VECTOR_DIMENSION);
          query[0] = 1;
          return query;
        },
      },
    });

    const result = await service.search({
      query: "rank sparse candidates",
      topK: 2,
      candidateIndices: [1, 9, 5, 9],
    });
    expect(result.results.map((entry) => entry.index)).toEqual([9, 5]);
    expect(result.timings.scannedCount).toBe(3);
    expect(Math.max(...opfs.readSizes)).toBeLessThanOrEqual(
      VECTOR_COMPACTION_COPY_CHUNK_SIZE_BYTES
    );
    expect(service.getResidentVectorBytes()).toBe(0);
    await service.releaseMemory();
  });

  test("surfaces a missing vector body and recovery clears refs before retry", async () => {
    const opfs = new FakeVectorOpfs(2);
    opfs.state.fileSizeOverride = 16 + VECTOR_DIMENSION * Float32Array.BYTES_PER_ELEMENT;
    const service = new VectorStoreService({
      opfsHandler: opfs as unknown as OpfsHandler,
      opfsFactory: () => opfs.fork() as unknown as OpfsHandler,
      idleReleaseMs: 0,
    });
    const records = [
      { vector_index: 0, vector_indexes: [0], isEmbedded: true, isDirty: false },
      { vector_index: 1, vector_indexes: [1], isEmbedded: true, isDirty: false },
    ];

    await expect(service.getVectorCount()).rejects.toBeInstanceOf(VectorStoreIntegrityError);
    expect(opfs.state.deleteCount).toBe(0);

    await invalidatePartiallyCommittedCompaction({
      clearVectors: () => service.clearStorage(),
      invalidateItems: async () => {
        for (const record of records) {
          record.vector_index = -1;
          record.vector_indexes = [];
          record.isEmbedded = false;
          record.isDirty = true;
        }
        return records.length;
      },
    });
    expect(opfs.state.deleteCount).toBe(1);
    expect(records.every((record) => record.vector_index === -1 && record.isDirty)).toBe(true);
    await expect(service.getVectorCount()).resolves.toBe(0);
  });

  test("keeps only header state resident and lazily reloads before an exact append", async () => {
    const opfs = new FakeVectorOpfs(2);
    const service = new VectorStoreService({
      opfsHandler: opfs as unknown as OpfsHandler,
      opfsFactory: () => opfs.fork() as unknown as OpfsHandler,
      idleReleaseMs: 5,
      embeddingGenerator: {
        async generateEmbeddings(payload) {
          return new Float32Array(payload.sentences.length * VECTOR_DIMENSION);
        },
      },
    });

    expect(VECTOR_MEMORY_IDLE_RELEASE_MS).toBe(60_000);
    await expect(service.getVectorCount()).resolves.toBe(2);
    expect(service.getResidentVectorBytes()).toBe(0);
    expect(opfs.readSizes).toEqual([16]);

    await Bun.sleep(20);
    expect((service as any).isInitialized).toBe(false);
    expect(opfs.closeCount).toBeGreaterThanOrEqual(1);

    const append = await service.generateAndStoreEmbeddings({
      sentences: ["new vector"],
      priority: "background",
    });
    expect(append).toEqual({ startIndex: 2, appendedCount: 1, totalCount: 3 });
    expect(opfs.vectorCount).toBe(3);
    expect(
      opfs.writes.some(
        (write) => write.offset === 16 + 2 * VECTOR_DIMENSION * 4 && write.bytes === VECTOR_DIMENSION * 4
      )
    ).toBe(true);

    await Bun.sleep(20);
    await expect(service.getVectorCount()).resolves.toBe(3);
    expect(opfs.openCount).toBeGreaterThanOrEqual(3);
    expect(Math.max(...opfs.readSizes)).toBeLessThanOrEqual(
      VECTOR_COMPACTION_COPY_CHUNK_SIZE_BYTES
    );

    await service.releaseMemory();
  });

  test("does not close the header handle while initialization is active", async () => {
    const opfs = new FakeVectorOpfs(2);
    let releaseHeaderRead!: () => void;
    let markHeaderReadStarted!: () => void;
    const headerReadStarted = new Promise<void>((resolve) => {
      markHeaderReadStarted = resolve;
    });
    const allowHeaderRead = new Promise<void>((resolve) => {
      releaseHeaderRead = resolve;
    });
    const baseRead = opfs.read.bind(opfs);
    opfs.read = async (buffer, offset) => {
      if (offset === 0) {
        markHeaderReadStarted();
        await allowHeaderRead;
      }
      await baseRead(buffer, offset);
    };
    const service = new VectorStoreService({
      opfsHandler: opfs as unknown as OpfsHandler,
      idleReleaseMs: 1_000,
    });

    const loading = service.getVectorCount();
    await headerReadStarted;
    await expect(service.releaseMemory()).resolves.toBe(false);
    expect(opfs.closeCount).toBe(0);

    releaseHeaderRead();
    await expect(loading).resolves.toBe(2);
    await expect(service.releaseMemory()).resolves.toBe(true);
    expect(opfs.closeCount).toBe(1);
  });

  test("drains a streaming reader before vector maintenance can enter its swap epoch", async () => {
    const vectorCount = 20_000;
    const opfs = new FakeVectorOpfs(vectorCount);
    const service = new VectorStoreService({
      opfsHandler: opfs as unknown as OpfsHandler,
      opfsFactory: () => opfs.fork() as unknown as OpfsHandler,
      idleReleaseMs: 0,
      embeddingGenerator: {
        async generateEmbeddings() {
          return new Float32Array(VECTOR_DIMENSION);
        },
      },
    });
    let markBodyReadStarted!: () => void;
    let releaseBodyRead!: () => void;
    const bodyReadStarted = new Promise<void>((resolve) => {
      markBodyReadStarted = resolve;
    });
    const allowBodyRead = new Promise<void>((resolve) => {
      releaseBodyRead = resolve;
    });
    opfs.state.onBodyRead = markBodyReadStarted;
    opfs.state.beforeBodyRead = () => allowBodyRead;

    const search = service.search({
      query: "snapshot test",
      topK: 10,
      candidateIndices: Array.from({ length: vectorCount }, (_, index) => index),
    });
    await bodyReadStarted;

    let maintenanceEntered = false;
    const maintenance = service.runWithSearchesPaused(async () => {
      maintenanceEntered = true;
    });
    await Bun.sleep(5);
    expect(maintenanceEntered).toBe(false);
    releaseBodyRead();

    const result = await search;
    expect(result.timings.scannedCount).toBe(vectorCount);
    expect(result.results).toHaveLength(10);
    await maintenance;
    expect(maintenanceEntered).toBe(true);
    await service.releaseMemory();
  });

  test("keeps controller candidate pages and vector scan in one maintenance epoch", async () => {
    const opfs = new FakeVectorOpfs(8);
    const service = new VectorStoreService({
      opfsHandler: opfs as unknown as OpfsHandler,
      opfsFactory: () => opfs.fork() as unknown as OpfsHandler,
      idleReleaseMs: 0,
      embeddingGenerator: {
        async generateEmbeddings() {
          const query = new Float32Array(VECTOR_DIMENSION);
          query[0] = 1;
          return query;
        },
      },
    });
    const controller = new ItemsController() as any;
    controller.vectorStore = service;

    let mappingGeneration = "old";
    let maintenanceEntered = false;
    let maintenance: Promise<void> | null = null;
    const candidatePageGenerations: string[] = [];

    controller.queryLocalWithVectorLease = async (
      _payload: unknown,
      _searchGeneration: number,
      _searchSignal: AbortSignal,
      lease: Awaited<ReturnType<VectorStoreService["acquireQueryLease"]>>
    ) => {
      candidatePageGenerations.push(mappingGeneration);
      const firstPageIndexes = mappingGeneration === "old" ? [1] : [6];

      maintenance = service.runWithSearchesPaused(async () => {
        maintenanceEntered = true;
        mappingGeneration = "new";
      });
      await Bun.sleep(5);
      expect(maintenanceEntered).toBe(false);

      candidatePageGenerations.push(mappingGeneration);
      const secondPageIndexes = mappingGeneration === "old" ? [2] : [7];
      const result = await lease.search({
        query: "controller epoch",
        topK: 2,
        candidateIndices: [...firstPageIndexes, ...secondPageIndexes],
      });
      return { scannedIndexes: result.results.map((entry) => entry.index) };
    };

    const result = await controller.queryLocal({
      query: "controller epoch",
      useKeyword: false,
      useVector: true,
    });

    expect(candidatePageGenerations).toEqual(["old", "old"]);
    expect(result.scannedIndexes).toEqual([2, 1]);
    await maintenance;
    expect(maintenanceEntered).toBe(true);
    expect(mappingGeneration).toBe("new");
    await service.releaseMemory();
  });

  test("does not start a new vector read until the swap-to-DB-remap epoch completes", async () => {
    const opfs = new FakeVectorOpfs(20);
    const service = new VectorStoreService({
      opfsHandler: opfs as unknown as OpfsHandler,
      opfsFactory: () => opfs.fork() as unknown as OpfsHandler,
      idleReleaseMs: 0,
      embeddingGenerator: {
        async generateEmbeddings() {
          return new Float32Array(VECTOR_DIMENSION);
        },
      },
    });
    let finishMaintenance!: () => void;
    let markMaintenanceEntered!: () => void;
    const maintenanceEntered = new Promise<void>((resolve) => {
      markMaintenanceEntered = resolve;
    });
    const maintenanceCanFinish = new Promise<void>((resolve) => {
      finishMaintenance = resolve;
    });
    const maintenance = service.runWithSearchesPaused(async () => {
      markMaintenanceEntered();
      await maintenanceCanFinish;
    });
    await maintenanceEntered;

    let searchSettled = false;
    const search = service
      .search({ query: "wait for remap", topK: 2, candidateIndices: [1, 2] })
      .finally(() => {
        searchSettled = true;
      });
    await Bun.sleep(5);
    expect(searchSettled).toBe(false);
    expect(opfs.readSizes).toEqual([]);

    finishMaintenance();
    await maintenance;
    await expect(search).resolves.toMatchObject({
      timings: { scannedCount: 2 },
    });
    await service.releaseMemory();
  });

  test("time-slices a large exact scan so an AbortSignal can stop it", async () => {
    const opfs = new FakeVectorOpfs(20_000);
    const service = new VectorStoreService({
      opfsHandler: opfs as unknown as OpfsHandler,
      opfsFactory: () => opfs.fork() as unknown as OpfsHandler,
      idleReleaseMs: 0,
      embeddingGenerator: {
        async generateEmbeddings() {
          return new Float32Array(VECTOR_DIMENSION);
        },
      },
    });
    const controller = new AbortController();
    const search = service.search({
      query: "deadline test",
      topK: 10,
      signal: controller.signal,
    });
    setTimeout(() => controller.abort(new Error("superseded vector search")), 0);

    try {
      await search;
      throw new Error("Expected vector search to be aborted.");
    } catch (error) {
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).name).toBe("AbortError");
      expect((error as Error).message).toBe("superseded vector search");
    } finally {
      await service.releaseMemory();
    }
  });
});
