import { OpfsHandler } from "./vector-store/opfs-handler";
import { VECTOR_DIMENSION } from "@src/common/constants";
import { embeddingService } from "./embedding.service";
import { dotProduct } from "./vector-store/dot-product";
import type { ItemDocType } from "@src/schemas/item_schema";
import { composeEmbeddingTexts, composeQueryEmbeddingText } from "@src/search-core/embedding-text";
import { VectorCompactionWorkerClient } from "./vector-store/compaction-worker-client";
import {
  buildCompactedIndexMap,
  copyCleanVectorRangesInChunks,
  normalizeCleanVectorItems,
  planCandidateVectorReadChunks,
  planContiguousVectorReadChunks,
  VECTOR_COMPACTION_COPY_CHUNK_SIZE_BYTES,
  type CopyCleanVectorsWorkerResult,
  type VectorIndexMapEntry,
} from "./vector-store/compaction-copy";

export interface SearchResult {
  index: number;
  score: number;
}

export type VectorSearchTimings = {
  embeddingMs: number;
  scanMs: number;
  totalMs: number;
  scannedCount: number;
};

export type VectorSearchResponse = {
  results: SearchResult[];
  timings: VectorSearchTimings;
};

export type VectorSearchPayload = {
  query: string;
  topK: number;
  candidateIndices?: number[];
  signal?: AbortSignal;
};

export type VectorQueryLease = {
  search(payload: VectorSearchPayload): Promise<VectorSearchResponse>;
  release(): void;
};

type VectorQueryLeaseToken = symbol;

type EmbeddingAppendResult = {
  startIndex: number;
  appendedCount: number;
  totalCount: number;
};
type RebuildProgress = {
  completedItems: number;
  totalItems: number;
};
type VectorFileReadSnapshot = {
  opfs: OpfsHandler;
  vectorCount: number;
};

type RebuildEmbeddingItem = Pick<
  ItemDocType,
  "id" | "title" | "textContent" | "ocrText" | "url" | "source" | "authorUsername" | "media"
>;
type RebuildEmbeddingItemSnapshot = {
  item: RebuildEmbeddingItem;
  revision: string;
};
type RebuildEmbeddingItemLoader = (
  itemIds: string[]
) => Promise<RebuildEmbeddingItemSnapshot[]>;
type RebuildCleanVectorItem = VectorIndexMapEntry & { snapshotRevision: string };
type CopyCleanVectorsResult = CopyCleanVectorsWorkerResult & {
  newIndexMap: VectorIndexMapEntry[];
};
type EmbeddingGenerator = Pick<typeof embeddingService, "generateEmbeddings">;
type VectorStoreServiceOptions = {
  opfsHandler?: OpfsHandler;
  opfsFactory?: () => OpfsHandler;
  compactionWorker?: VectorCompactionWorkerClient;
  embeddingGenerator?: EmbeddingGenerator;
  idleReleaseMs?: number;
};

export const VECTOR_MEMORY_IDLE_RELEASE_MS = 60_000;
const VECTOR_SCAN_YIELD_CHECK_INTERVAL = 256;
const VECTOR_SCAN_TIME_SLICE_MS = 8;

export class VectorStoreIntegrityError extends Error {
  public readonly code = "VECTOR_STORE_INTEGRITY_ERROR";

  constructor(message: string) {
    super(message);
    this.name = "VectorStoreIntegrityError";
  }
}

export const isVectorStoreIntegrityError = (
  error: unknown
): error is VectorStoreIntegrityError =>
  error instanceof VectorStoreIntegrityError ||
  (error instanceof Error && error.name === "VectorStoreIntegrityError");

class TopKMinHeap {
  private heap: SearchResult[] = [];
  constructor(private readonly capacity: number) {}

  private swap(i: number, j: number) {
    const tmp = this.heap[i];
    this.heap[i] = this.heap[j];
    this.heap[j] = tmp;
  }

  private bubbleUp(index: number) {
    let i = index;
    while (i > 0) {
      const parent = Math.floor((i - 1) / 2);
      if (this.heap[parent].score <= this.heap[i].score) break;
      this.swap(parent, i);
      i = parent;
    }
  }

  private bubbleDown(index: number) {
    let i = index;
    const n = this.heap.length;
    while (true) {
      const left = i * 2 + 1;
      const right = left + 1;
      let smallest = i;

      if (left < n && this.heap[left].score < this.heap[smallest].score) smallest = left;
      if (right < n && this.heap[right].score < this.heap[smallest].score) smallest = right;
      if (smallest === i) break;

      this.swap(i, smallest);
      i = smallest;
    }
  }

  push(result: SearchResult) {
    if (this.capacity <= 0) return;

    if (this.heap.length < this.capacity) {
      this.heap.push(result);
      this.bubbleUp(this.heap.length - 1);
      return;
    }

    if (result.score <= this.heap[0].score) return;
    this.heap[0] = result;
    this.bubbleDown(0);
  }

  toSortedDesc(): SearchResult[] {
    return [...this.heap].sort((a, b) => b.score - a.score);
  }
}

// --- Base64 Conversion Utility ---
function arrayBufferToBase64(buffer: ArrayBuffer): string {
  let binary = "";
  const bytes = new Uint8Array(buffer);
  const len = bytes.byteLength;
  for (let i = 0; i < len; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return window.btoa(binary);
}

export class VectorStoreService {
  [key: string]: any;
  private opfsHandler: OpfsHandler;
  private opfsFactory: () => OpfsHandler;
  private compactionWorker: VectorCompactionWorkerClient;
  private embeddingGenerator: EmbeddingGenerator;
  private isInitialized = false;
  private initializePromise: Promise<void> | null = null;
  private lockPromise: Promise<void> = Promise.resolve();
  private readonly COPY_CHUNK_SIZE_BYTES = VECTOR_COMPACTION_COPY_CHUNK_SIZE_BYTES;
  private readonly REBUILD_EMBEDDING_ITEM_BATCH_SIZE = 20;
  private readonly QUERY_EMBEDDING_CACHE_LIMIT = 64;
  private readonly idleReleaseMs: number;
  private queryEmbeddingCache = new Map<string, Float32Array>();
  private activeMemoryUsers = 0;
  private memoryIdleTimer: ReturnType<typeof setTimeout> | null = null;
  private activeVectorReaders = 0;
  private vectorReaderWaiters: Array<() => void> = [];
  private activeVectorQueryLeases = new Set<VectorQueryLeaseToken>();
  private vectorActivityWaiters: Array<() => void> = [];
  private searchPausePromise: Promise<void> | null = null;
  private resumePausedSearches: (() => void) | null = null;
  private vectorSearchBlockedError: Error | null = null;

  // Vector file properties
  private vectorCount = 0;
  private readonly MAGIC_NUMBER = 0x56494245; // "VIBE"
  private readonly VERSION = 1;
  private readonly HEADER_SIZE = 16;

  constructor(options: VectorStoreServiceOptions = {}) {
    this.opfsHandler = options.opfsHandler ?? new OpfsHandler();
    this.opfsFactory = options.opfsFactory ?? (() => new OpfsHandler());
    this.compactionWorker = options.compactionWorker ?? new VectorCompactionWorkerClient();
    this.embeddingGenerator = options.embeddingGenerator ?? embeddingService;
    this.idleReleaseMs = Math.max(0, options.idleReleaseMs ?? VECTOR_MEMORY_IDLE_RELEASE_MS);
  }

  private cancelMemoryIdleRelease() {
    if (this.memoryIdleTimer === null) return;
    clearTimeout(this.memoryIdleTimer);
    this.memoryIdleTimer = null;
  }

  private scheduleMemoryIdleRelease() {
    this.cancelMemoryIdleRelease();
    if (this.idleReleaseMs <= 0 || this.activeMemoryUsers > 0 || !this.isInitialized) return;
    this.memoryIdleTimer = setTimeout(() => {
      this.memoryIdleTimer = null;
      void this.releaseMemory().catch((error) => {
        console.warn("[VectorStore] Failed to release idle vector memory.", error);
      });
    }, this.idleReleaseMs);
  }

  private async withMemoryActivity<T>(operation: () => Promise<T>): Promise<T> {
    this.cancelMemoryIdleRelease();
    this.activeMemoryUsers += 1;
    try {
      return await operation();
    } finally {
      this.activeMemoryUsers = Math.max(0, this.activeMemoryUsers - 1);
      if (this.activeMemoryUsers === 0) this.scheduleMemoryIdleRelease();
    }
  }

  /** Drop the OPFS mirror after idle; the next operation reloads it lazily. */
  public async releaseMemory(): Promise<boolean> {
    this.cancelMemoryIdleRelease();
    return this.withLock(async () => {
      if (this.activeMemoryUsers > 0) {
        this.scheduleMemoryIdleRelease();
        return false;
      }
      this.opfsHandler.close();
      this.isInitialized = false;
      this.vectorCount = 0;
      this.queryEmbeddingCache.clear();
      return true;
    });
  }

  /** Header/query-cache bytes only; vector bodies are streamed per search. */
  public getResidentVectorBytes(): number {
    return 0;
  }

  private resolveVectorActivityWaiters() {
    if (this.activeVectorReaders === 0) {
      const readerWaiters = this.vectorReaderWaiters.splice(0);
      for (const resolve of readerWaiters) resolve();
    }
    if (this.activeVectorReaders !== 0 || this.activeVectorQueryLeases.size !== 0) return;
    const activityWaiters = this.vectorActivityWaiters.splice(0);
    for (const resolve of activityWaiters) resolve();
  }

  private releaseVectorReader() {
    this.activeVectorReaders = Math.max(0, this.activeVectorReaders - 1);
    this.resolveVectorActivityWaiters();
  }

  private releaseVectorQueryLease(token: VectorQueryLeaseToken) {
    if (!this.activeVectorQueryLeases.delete(token)) return;
    this.resolveVectorActivityWaiters();
  }

  private waitForVectorReaders(): Promise<void> {
    if (this.activeVectorReaders === 0) return Promise.resolve();
    return new Promise<void>((resolve) => this.vectorReaderWaiters.push(resolve));
  }

  private waitForVectorActivity(): Promise<void> {
    if (this.activeVectorReaders === 0 && this.activeVectorQueryLeases.size === 0) {
      return Promise.resolve();
    }
    return new Promise<void>((resolve) => this.vectorActivityWaiters.push(resolve));
  }

  /**
   * Pause new vector readers and drain existing ones across file swap + DB
   * remap/recovery. Searches wait outside the vector lock, so mutation work can
   * still acquire it without deadlocking.
   */
  public async runWithSearchesPaused<T>(
    operation: () => Promise<T>,
    options?: { blockSearchesOnError?: boolean }
  ): Promise<T> {
    let resume!: () => void;
    await this.withLock(async () => {
      if (this.searchPausePromise) {
        throw new Error("Vector searches are already paused for maintenance.");
      }
      this.searchPausePromise = new Promise<void>((resolve) => {
        resume = resolve;
      });
      this.resumePausedSearches = resume;
    });

    try {
      // Wait outside the vector lock. A controller lease admitted before this
      // pause may still need that lock to open its matching vector snapshot.
      await this.waitForVectorActivity();
      const result = await operation();
      this.vectorSearchBlockedError = null;
      return result;
    } catch (error) {
      if (options?.blockSearchesOnError) {
        this.vectorSearchBlockedError = new Error(
          error instanceof Error
            ? `Vector search is blocked until maintenance recovery succeeds: ${error.message}`
            : "Vector search is blocked until maintenance recovery succeeds."
        );
      }
      throw error;
    } finally {
      const release = this.resumePausedSearches;
      this.searchPausePromise = null;
      this.resumePausedSearches = null;
      release?.();
    }
  }

  private async waitForSearchPause(pause: Promise<void>, signal?: AbortSignal): Promise<void> {
    if (!signal) {
      await pause;
      return;
    }
    this.throwIfVectorSearchAborted(signal);
    await new Promise<void>((resolve, reject) => {
      const onAbort = () => {
        signal.removeEventListener("abort", onAbort);
        try {
          this.throwIfVectorSearchAborted(signal);
        } catch (error) {
          reject(error);
        }
      };
      signal.addEventListener("abort", onAbort, { once: true });
      pause.then(
        () => {
          signal.removeEventListener("abort", onAbort);
          resolve();
        },
        (error) => {
          signal.removeEventListener("abort", onAbort);
          reject(error);
        }
      );
    });
  }

  private assertActiveQueryLease(token: VectorQueryLeaseToken): void {
    if (this.activeVectorQueryLeases.has(token)) return;
    throw new Error("Vector query lease is no longer active.");
  }

  /**
   * Admit a controller query into the current vector generation before it
   * snapshots candidate indexes from IndexedDB. Maintenance pauses new leases
   * and drains admitted leases before swapping vectors or remapping rows.
   */
  public acquireQueryLease = async (signal?: AbortSignal): Promise<VectorQueryLease> => {
    while (true) {
      let pause: Promise<void> | null = null;
      let token: VectorQueryLeaseToken | null = null;
      await this.withLock(async () => {
        this.throwIfVectorSearchAborted(signal);
        if (this.vectorSearchBlockedError) throw this.vectorSearchBlockedError;
        if (this.searchPausePromise) {
          pause = this.searchPausePromise;
          return;
        }
        token = Symbol("vector-query-lease");
        this.activeVectorQueryLeases.add(token);
      });
      if (pause) {
        await this.waitForSearchPause(pause, signal);
        continue;
      }
      if (!token) throw new Error("Failed to acquire a vector query lease.");

      const leaseToken = token;
      let released = false;
      return {
        search: (payload) => {
          this.assertActiveQueryLease(leaseToken);
          return this.searchWithQueryLease(payload, leaseToken);
        },
        release: () => {
          if (released) return;
          released = true;
          this.releaseVectorQueryLease(leaseToken);
        },
      };
    }
  };

  private async getSearchableVectorCount(
    signal?: AbortSignal,
    leaseToken?: VectorQueryLeaseToken
  ): Promise<number> {
    while (true) {
      let pause: Promise<void> | null = null;
      let count: number | null = null;
      await this.withLock(async () => {
        this.throwIfVectorSearchAborted(signal);
        if (leaseToken) this.assertActiveQueryLease(leaseToken);
        if (this.vectorSearchBlockedError) throw this.vectorSearchBlockedError;
        if (this.searchPausePromise && !leaseToken) {
          pause = this.searchPausePromise;
          return;
        }
        await this.initialize();
        count = this.vectorCount;
      });
      if (pause) {
        await this.waitForSearchPause(pause, signal);
        continue;
      }
      return count ?? 0;
    }
  }

  private async acquireVectorReadSnapshot(
    signal?: AbortSignal,
    leaseToken?: VectorQueryLeaseToken
  ): Promise<VectorFileReadSnapshot> {
    while (true) {
      let pause: Promise<void> | null = null;
      let snapshot: VectorFileReadSnapshot | null = null;
      await this.withLock(async () => {
        this.throwIfVectorSearchAborted(signal);
        if (leaseToken) this.assertActiveQueryLease(leaseToken);
        if (this.vectorSearchBlockedError) throw this.vectorSearchBlockedError;
        if (this.searchPausePromise && !leaseToken) {
          pause = this.searchPausePromise;
          return;
        }
        await this.initialize();
        const opfs = this.opfsFactory();
        await opfs.open("vectors.bin", false, false);
        this.activeVectorReaders += 1;
        snapshot = { opfs, vectorCount: this.vectorCount };
      });
      if (pause) {
        await this.waitForSearchPause(pause, signal);
        continue;
      }
      if (!snapshot) throw new Error("Failed to acquire a vector file reader.");
      return snapshot;
    }
  }

  private toArrayBuffer(view: Float32Array): ArrayBuffer {
    if (view.byteOffset === 0 && view.byteLength === view.buffer.byteLength) {
      return view.buffer as ArrayBuffer;
    }
    return view.buffer.slice(view.byteOffset, view.byteOffset + view.byteLength) as ArrayBuffer;
  }

  private async deleteFileUnlocked(fileName: string): Promise<void> {
    const opfsHandler = this.opfsFactory();
    try {
      await opfsHandler.open(fileName, false, false);
      await opfsHandler.deleteSelf();
    } catch {
      // Ignore missing file cleanup.
    } finally {
      opfsHandler.close();
    }
  }

  private async copyFileUnlocked(
    sourceFile: string,
    destFile: string,
    options?: { truncateDest?: boolean; chunkSizeBytes?: number }
  ): Promise<void> {
    const sourceOpfs = this.opfsFactory();
    const destOpfs = this.opfsFactory();
    const truncateDest = options?.truncateDest ?? true;
    const chunkSize = Math.max(64 * 1024, options?.chunkSizeBytes ?? this.COPY_CHUNK_SIZE_BYTES);

    try {
      await sourceOpfs.open(sourceFile, false, false);
      await destOpfs.open(destFile, truncateDest);

      const size = await sourceOpfs.getSize();
      let offset = 0;
      while (offset < size) {
        const bytesToCopy = Math.min(chunkSize, size - offset);
        const chunk = new ArrayBuffer(bytesToCopy);
        await sourceOpfs.read(chunk, offset);
        await destOpfs.write(chunk, offset);
        offset += bytesToCopy;
      }
    } finally {
      sourceOpfs.close();
      destOpfs.close();
    }
  }

  private async copyCleanVectorRangesInProcess(payload: {
    sourceFile: string;
    destFile: string;
    cleanItems: VectorIndexMapEntry[];
    destStartIndex: number;
  }): Promise<CopyCleanVectorsResult> {
    if (payload.cleanItems.length === 0) return { newIndexMap: [], appendedCount: 0 };

    const sourceOpfs = this.opfsFactory();
    const destOpfs = this.opfsFactory();
    await sourceOpfs.open(payload.sourceFile, false, false);
    await destOpfs.open(payload.destFile);

    try {
      const copied = await copyCleanVectorRangesInChunks(
        {
          cleanItems: payload.cleanItems,
          destStartIndex: payload.destStartIndex,
          vectorDimension: VECTOR_DIMENSION,
          headerSize: this.HEADER_SIZE,
          maxChunkBytes: VECTOR_COMPACTION_COPY_CHUNK_SIZE_BYTES,
        },
        {
          read: (buffer, offset) => sourceOpfs.read(buffer, offset),
          write: (buffer, offset) => destOpfs.write(buffer, offset),
        }
      );
      return {
        ...copied,
        newIndexMap: buildCompactedIndexMap(payload.cleanItems, payload.destStartIndex),
      };
    } finally {
      sourceOpfs.close();
      destOpfs.close();
    }
  }

  private async copyCleanVectors(payload: {
    sourceFile: string;
    destFile: string;
    cleanItems: VectorIndexMapEntry[];
    destStartIndex: number;
  }): Promise<CopyCleanVectorsResult> {
    const normalized = normalizeCleanVectorItems(payload.cleanItems);
    if (normalized.length === 0) {
      return { newIndexMap: [], appendedCount: 0 };
    }

    try {
      const copied = await this.compactionWorker.copyCleanVectors({
        sourceFile: payload.sourceFile,
        destFile: payload.destFile,
        cleanItems: normalized,
        destStartIndex: payload.destStartIndex,
        vectorDimension: VECTOR_DIMENSION,
        headerSize: this.HEADER_SIZE,
      });
      if (copied.appendedCount !== normalized.length) {
        throw new Error(
          `Vector compaction copied ${copied.appendedCount} of ${normalized.length} vectors.`
        );
      }
      return {
        ...copied,
        newIndexMap: buildCompactedIndexMap(normalized, payload.destStartIndex),
      };
    } catch (error) {
      console.warn(
        "[VectorStore] Compaction worker unavailable, falling back to in-process clean vector copy.",
        error
      );
      return this.copyCleanVectorRangesInProcess({
        sourceFile: payload.sourceFile,
        destFile: payload.destFile,
        cleanItems: normalized,
        destStartIndex: payload.destStartIndex,
      });
    }
  }

  private async initialize(): Promise<void> {
    if (this.isInitialized) return;
    if (this.initializePromise) {
      await this.initializePromise;
      return;
    }

    const initialization = (async () => {
      try {
        let created = false;
        try {
          await this.opfsHandler.open("vectors.bin", false, false);
        } catch (error) {
          if (!(error instanceof DOMException) || error.name !== "NotFoundError") throw error;
          await this.opfsHandler.open("vectors.bin", true, true);
          await this.writeVectorHeader(this.opfsHandler, 0);
          created = true;
        }

        if (!created) await this.loadVectorFile(await this.opfsHandler.getSize());
        this.isInitialized = true;
        console.log(`VectorStoreService Initialized. Count: ${this.vectorCount}, resident bytes: 0`);
      } catch (error) {
        this.opfsHandler.close();
        this.isInitialized = false;
        this.vectorCount = 0;
        throw error;
      }
    })();
    this.initializePromise = initialization;
    try {
      await initialization;
    } finally {
      if (this.initializePromise === initialization) this.initializePromise = null;
    }
  }

  private async writeVectorHeader(opfsHandler: OpfsHandler, vectorCount: number): Promise<void> {
    const header = new ArrayBuffer(this.HEADER_SIZE);
    const headerView = new DataView(header);
    headerView.setUint32(0, this.MAGIC_NUMBER, true);
    headerView.setUint32(4, this.VERSION, true);
    headerView.setUint32(8, VECTOR_DIMENSION, true);
    headerView.setUint32(12, vectorCount, true);
    await opfsHandler.write(header, 0);
  }

  public async createNewVectorFile(fileName = "vectors.bin"): Promise<void> {
    console.log(`Creating new vector file: ${fileName}`);
    const opfsHandler = this.opfsFactory();
    try {
      await opfsHandler.open(fileName, true);
      await this.writeVectorHeader(opfsHandler, 0);
    } finally {
      opfsHandler.close();
    }

    // If we are creating the main file, reset the in-memory state
    if (fileName === "vectors.bin") {
      this.opfsHandler.close();
      this.isInitialized = false;
      this.vectorCount = 0;
    }
  }

  private async loadVectorFile(fileSize: number): Promise<void> {
    console.log("Loading existing vector file.");
    if (fileSize < this.HEADER_SIZE) {
      throw new VectorStoreIntegrityError(
        `Vector file is truncated: expected at least ${this.HEADER_SIZE} header bytes, found ${fileSize}.`
      );
    }
    const header = new ArrayBuffer(this.HEADER_SIZE);
    await this.opfsHandler.read(header, 0);
    const headerView = new DataView(header);
    if (headerView.getUint32(0, true) !== this.MAGIC_NUMBER) {
      throw new VectorStoreIntegrityError("Vector file has an invalid magic header.");
    }
    if (headerView.getUint32(4, true) !== this.VERSION) {
      throw new VectorStoreIntegrityError("Vector file version is unsupported or corrupt.");
    }
    if (headerView.getUint32(8, true) !== VECTOR_DIMENSION) {
      throw new VectorStoreIntegrityError("Vector file dimension does not match the current model.");
    }

    this.vectorCount = headerView.getUint32(12, true);
    const bodySize = this.vectorCount * VECTOR_DIMENSION * 4;
    const expectedSize = this.HEADER_SIZE + bodySize;
    if (fileSize < expectedSize) {
      throw new VectorStoreIntegrityError(
        `Vector file body is truncated: header declares ${this.vectorCount} vectors (${expectedSize} bytes), found ${fileSize}.`
      );
    }
    const extraBytes = fileSize - expectedSize;
    const vectorSizeBytes = VECTOR_DIMENSION * Float32Array.BYTES_PER_ELEMENT;
    if (extraBytes % vectorSizeBytes !== 0) {
      throw new VectorStoreIntegrityError(
        `Vector file has an incomplete ${extraBytes}-byte tail beyond its committed count.`
      );
    }
  }

  private async withLock<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.lockPromise.then(fn, fn);
    this.lockPromise = run.then(
      () => undefined,
      () => undefined
    );
    return run;
  }

  /**
   * Appends a new set of vectors to the end of the `vectors.bin` file.
   * This is an "append-only" operation, used for adding new or updated items
   * quickly without rebuilding the entire file. This operation is protected by a lock
   * to prevent race conditions with the rebuild process.
   */
  private async addVectors(newVectorsBuffer: Float32Array): Promise<EmbeddingAppendResult> {
    return this.withLock(async () => {
      const newVectorCount = Math.floor(newVectorsBuffer.length / VECTOR_DIMENSION);
      if (!Number.isFinite(newVectorCount) || newVectorCount <= 0) {
        return {
          startIndex: this.vectorCount,
          appendedCount: 0,
          totalCount: this.vectorCount,
        };
      }
      if (newVectorCount * VECTOR_DIMENSION !== newVectorsBuffer.length) {
        throw new Error("Invalid vector payload length for append.");
      }

      const startIndex = this.vectorCount;
      const appendOffset = this.HEADER_SIZE + this.vectorCount * VECTOR_DIMENSION * 4;
      await this.opfsHandler.write(this.toArrayBuffer(newVectorsBuffer), appendOffset);

      const newTotalCount = this.vectorCount + newVectorCount;
      const countBuffer = new ArrayBuffer(4);
      new DataView(countBuffer).setUint32(0, newTotalCount, true);
      await this.opfsHandler.write(countBuffer, 12);

      this.vectorCount = newTotalCount;

      return {
        startIndex,
        appendedCount: newVectorCount,
        totalCount: newTotalCount,
      };
    });
  }

  // --- Public Service Methods ---

  private getClockNow(): number {
    return typeof performance !== "undefined" && typeof performance.now === "function"
      ? performance.now()
      : Date.now();
  }

  private throwIfVectorSearchAborted(signal?: AbortSignal) {
    if (!signal?.aborted) return;
    const error = new Error(
      signal.reason instanceof Error ? signal.reason.message : "Vector search was aborted."
    );
    error.name = "AbortError";
    throw error;
  }

  private getQueryEmbeddingCacheKey(query: string): string {
    return query.trim().toLowerCase();
  }

  private normalizeQueryEmbeddingInput(query: string): string {
    const composed = composeQueryEmbeddingText(query || "");
    const normalized = composed.trim();
    if (normalized) {
      return normalized;
    }
    return (query || "").trim();
  }

  private readCachedQueryEmbedding(key: string): Float32Array | null {
    const cached = this.queryEmbeddingCache.get(key);
    if (!cached) return null;
    this.queryEmbeddingCache.delete(key);
    this.queryEmbeddingCache.set(key, cached);
    return cached;
  }

  private cacheQueryEmbedding(key: string, embedding: Float32Array) {
    this.queryEmbeddingCache.set(key, embedding);
    while (this.queryEmbeddingCache.size > this.QUERY_EMBEDDING_CACHE_LIMIT) {
      const oldestKey = this.queryEmbeddingCache.keys().next().value;
      if (!oldestKey) break;
      this.queryEmbeddingCache.delete(oldestKey);
    }
  }

  private async getQueryEmbedding(query: string, signal?: AbortSignal): Promise<Float32Array> {
    const normalizedQuery = this.normalizeQueryEmbeddingInput(query);
    const key = this.getQueryEmbeddingCacheKey(normalizedQuery);
    const cached = this.readCachedQueryEmbedding(key);
    if (cached) return cached;
    const generated = await this.embeddingGenerator.generateEmbeddings({
      sentences: [normalizedQuery],
      priority: "interactive",
      signal,
    });
    this.throwIfVectorSearchAborted(signal);
    const snapshot = new Float32Array(generated);
    this.cacheQueryEmbedding(key, snapshot);
    return snapshot;
  }

  public getVectorCount = async (): Promise<number> => {
    return this.withMemoryActivity(async () => {
      await this.initialize();
      return this.vectorCount;
    });
  };

  public getAllVectors = async (): Promise<string | null> => {
    return this.withMemoryActivity(async () => {
      await this.initialize();
      if (this.vectorCount <= 0) return null;
      const bodySize = this.vectorCount * VECTOR_DIMENSION * 4;
      const body = new ArrayBuffer(bodySize);
      await this.opfsHandler.read(body, this.HEADER_SIZE);
      return arrayBufferToBase64(body);
    });
  };

  public downloadFile = async (): Promise<string | null> => {
    return this.withMemoryActivity(async () => {
      await this.initialize();
      const fileSize = await this.opfsHandler.getSize();
      if (fileSize > 0) {
        const fileBuffer = new ArrayBuffer(fileSize);
        await this.opfsHandler.read(fileBuffer, 0);
        return arrayBufferToBase64(fileBuffer);
      }
      return null;
    });
  };

  public clearStorage = async (): Promise<void> => {
    await this.withMemoryActivity(() =>
      this.withLock(async () => {
        await this.waitForVectorReaders();
        this.opfsHandler.close();
        await this.opfsHandler.open("vectors.bin", false, true);
        await this.opfsHandler.deleteSelf();
        this.isInitialized = false;
        this.vectorCount = 0;
        await this.initialize();
      })
    );
  };

  public generateAndStoreEmbeddings = async (payload: {
    sentences: string[];
    priority?: "interactive" | "background";
  }): Promise<EmbeddingAppendResult> => {
    return this.withMemoryActivity(async () => {
      await this.initialize();
      const embeddings = await this.embeddingGenerator.generateEmbeddings(payload);
      return this.addVectors(embeddings);
    });
  };

  /**
   * Rebuilds the vector store from scratch. It re-embeds dirty items and copies
   * vectors for clean items into a new, compacted file. This is a key part of the
   * garbage collection process. This operation is protected by a lock to prevent
   * race conditions with the append-only `addVectors` operation.
   */
  public rebuildVectors = async (
    destFile: string,
    dirtyItemIds: string[],
    loadDirtyItems: RebuildEmbeddingItemLoader,
    cleanItems: RebuildCleanVectorItem[],
    onProgress?: (progress: RebuildProgress) => void
  ): Promise<{
    newIndexMap: VectorIndexMapEntry[];
    sourceRevisionByItemId: Map<string, string>;
  }> => {
    return this.withLock(async () => {
      const newIndexMap: VectorIndexMapEntry[] = [];
      const sourceRevisionByItemId = new Map<string, string>();
      let newVectorCount = 0;
      const vectorSizeBytes = VECTOR_DIMENSION * 4;

      // Re-embed dirty items
      if (dirtyItemIds.length > 0) {
        const destOpfs = this.opfsFactory();
        await destOpfs.open(destFile);
        try {
          for (
            let start = 0;
            start < dirtyItemIds.length;
            start += this.REBUILD_EMBEDDING_ITEM_BATCH_SIZE
          ) {
            const batchIds = dirtyItemIds.slice(
              start,
              start + this.REBUILD_EMBEDDING_ITEM_BATCH_SIZE
            );
            const loadedItems = await loadDirtyItems(batchIds);
            const loadedById = new Map(
              loadedItems.map((snapshot) => [snapshot.item.id, snapshot])
            );
            const itemBatch = batchIds
              .map((itemId) => loadedById.get(itemId) || null)
              .filter((snapshot): snapshot is RebuildEmbeddingItemSnapshot => !!snapshot);
            const entries = itemBatch.flatMap((snapshot) =>
              composeEmbeddingTexts(snapshot.item).map((text) => ({
                id: snapshot.item.id,
                text,
                revision: snapshot.revision,
              }))
            );
            if (entries.length > 0) {
              const embeddings = await this.embeddingGenerator.generateEmbeddings({
                sentences: entries.map((entry) => entry.text),
                priority: "background",
              });
              const destOffset = this.HEADER_SIZE + newVectorCount * vectorSizeBytes;
              await destOpfs.write(this.toArrayBuffer(embeddings), destOffset);
              for (const entry of entries) {
                newIndexMap.push({ id: entry.id, vector_index: newVectorCount });
                sourceRevisionByItemId.set(entry.id, entry.revision);
                newVectorCount += 1;
              }
            }
            onProgress?.({
              completedItems: Math.min(start + batchIds.length, dirtyItemIds.length),
              totalItems: dirtyItemIds.length,
            });
            if (start + batchIds.length < dirtyItemIds.length) {
              await new Promise<void>((resolve) => window.setTimeout(resolve, 0));
            }
          }
        } finally {
          destOpfs.close();
        }
      }

      // Copy clean vectors (worker-first with in-process fallback)
      if (cleanItems.length > 0) {
        const copied = await this.copyCleanVectors({
          sourceFile: "vectors.bin",
          destFile,
          cleanItems,
          destStartIndex: newVectorCount,
        });
        if (copied.newIndexMap.length > 0) {
          newIndexMap.push(...copied.newIndexMap);
          newVectorCount += copied.appendedCount;
          for (const item of cleanItems) {
            sourceRevisionByItemId.set(item.id, item.snapshotRevision);
          }
        }
      }

      // Write the new count to the header
      const destOpfs = this.opfsFactory();
      await destOpfs.open(destFile);
      const countBuffer = new ArrayBuffer(4);
      new DataView(countBuffer).setUint32(0, newVectorCount, true);
      await destOpfs.write(countBuffer, 12);
      destOpfs.close();

      return { newIndexMap, sourceRevisionByItemId };
    });
  };

  public copyFile = async (
    sourceFile: string,
    destFile: string,
    options?: { truncateDest?: boolean; chunkSizeBytes?: number }
  ): Promise<void> => {
    await this.withLock(() => this.copyFileUnlocked(sourceFile, destFile, options));
  };

  public fileExists = async (fileName: string): Promise<boolean> => {
    const opfs = this.opfsFactory();
    try {
      await opfs.open(fileName, false, false);
      return true;
    } catch {
      return false;
    } finally {
      opfs.close();
    }
  };

  public renameFile = async (oldName: string, newName: string): Promise<void> => {
    await this.withLock(async () => {
      if (oldName === newName) {
        return;
      }
      if (newName === "vectors.bin" || oldName === "vectors.bin") {
        await this.waitForVectorReaders();
      }
      // OPFS doesn't have a direct rename. We have to copy and delete.
      await this.copyFileUnlocked(oldName, newName, { truncateDest: true });

      await this.deleteFileUnlocked(oldName);

      if (newName === "vectors.bin") {
        this.opfsHandler.close();
        this.isInitialized = false;
        this.vectorCount = 0;
      }
    });
  };

  public deleteFile = async (fileName: string): Promise<void> => {
    await this.withLock(() => this.deleteFileUnlocked(fileName));
  };

  private searchWithQueryLease = async (
    payload: VectorSearchPayload,
    leaseToken: VectorQueryLeaseToken
  ): Promise<VectorSearchResponse> => {
    this.assertActiveQueryLease(leaseToken);
    const query = (payload.query || "").trim();
    const topK = Math.max(1, Math.floor(payload.topK || 20));
    if (!query) {
      return {
        results: [],
        timings: {
          embeddingMs: 0,
          scanMs: 0,
          totalMs: 0,
          scannedCount: 0,
        },
      };
    }

    return this.withMemoryActivity(async () => {
      this.throwIfVectorSearchAborted(payload.signal);
      if ((await this.getSearchableVectorCount(payload.signal, leaseToken)) <= 0) {
        return {
          results: [],
          timings: {
            embeddingMs: 0,
            scanMs: 0,
            totalMs: 0,
            scannedCount: 0,
          },
        };
      }
      const startedAt = this.getClockNow();

      // 1. Generate and normalize query vector
      const embeddingStartedAt = this.getClockNow();
      const queryVector = await this.getQueryEmbedding(query, payload.signal);
      this.throwIfVectorSearchAborted(payload.signal);
      const embeddingMs = this.getClockNow() - embeddingStartedAt;
      const snapshot = await this.acquireVectorReadSnapshot(payload.signal, leaseToken);
      try {
        this.throwIfVectorSearchAborted(payload.signal);
        if (snapshot.vectorCount <= 0) {
          return {
            results: [],
            timings: {
              embeddingMs,
              scanMs: 0,
              totalMs: this.getClockNow() - startedAt,
              scannedCount: 0,
            },
          };
        }

        // 2. Stream requested vectors (or the whole file) through a bounded
        // buffer. No vector body is retained by the service after this scan.
        const heap = new TopKMinHeap(topK);
        const scanStartedAt = this.getClockNow();
        let lastYieldAt = scanStartedAt;
        let scannedCount = 0;

        const yieldForScanDeadline = async () => {
          this.throwIfVectorSearchAborted(payload.signal);
          const currentTime = this.getClockNow();
          if (currentTime - lastYieldAt < VECTOR_SCAN_TIME_SLICE_MS) return;
          await new Promise<void>((resolve) => setTimeout(resolve, 0));
          lastYieldAt = this.getClockNow();
          this.throwIfVectorSearchAborted(payload.signal);
        };

        if (payload.candidateIndices !== undefined) {
          const chunks = planCandidateVectorReadChunks({
            candidateIndices: payload.candidateIndices,
            vectorCount: snapshot.vectorCount,
            vectorDimension: VECTOR_DIMENSION,
            headerSize: this.HEADER_SIZE,
            maxChunkBytes: VECTOR_COMPACTION_COPY_CHUNK_SIZE_BYTES,
          });
          for (const chunk of chunks) {
            this.throwIfVectorSearchAborted(payload.signal);
            const buffer = new ArrayBuffer(chunk.byteLength);
            await snapshot.opfs.read(buffer, chunk.byteOffset);
            this.throwIfVectorSearchAborted(payload.signal);
            const vectors = new Float32Array(buffer);
            for (const index of chunk.candidateIndices) {
              const offset = (index - chunk.startIndex) * VECTOR_DIMENSION;
              const storedVector = vectors.subarray(offset, offset + VECTOR_DIMENSION);
              heap.push({ index, score: dotProduct(queryVector, storedVector) });
              scannedCount += 1;
              if (scannedCount % VECTOR_SCAN_YIELD_CHECK_INTERVAL === 0) {
                await yieldForScanDeadline();
              }
            }
          }
        } else {
          const chunks = planContiguousVectorReadChunks({
            vectorCount: snapshot.vectorCount,
            vectorDimension: VECTOR_DIMENSION,
            headerSize: this.HEADER_SIZE,
            maxChunkBytes: VECTOR_COMPACTION_COPY_CHUNK_SIZE_BYTES,
          });
          for (const chunk of chunks) {
            this.throwIfVectorSearchAborted(payload.signal);
            const buffer = new ArrayBuffer(chunk.byteLength);
            await snapshot.opfs.read(buffer, chunk.byteOffset);
            this.throwIfVectorSearchAborted(payload.signal);
            const vectors = new Float32Array(buffer);
            for (let localIndex = 0; localIndex < chunk.count; localIndex++) {
              const offset = localIndex * VECTOR_DIMENSION;
              const storedVector = vectors.subarray(offset, offset + VECTOR_DIMENSION);
              heap.push({
                index: chunk.startIndex + localIndex,
                score: dotProduct(queryVector, storedVector),
              });
              scannedCount += 1;
              if (scannedCount % VECTOR_SCAN_YIELD_CHECK_INTERVAL === 0) {
                await yieldForScanDeadline();
              }
            }
          }
        }

        const scanMs = this.getClockNow() - scanStartedAt;
        return {
          results: heap.toSortedDesc(),
          timings: {
            embeddingMs,
            scanMs,
            totalMs: this.getClockNow() - startedAt,
            scannedCount,
          },
        };
      } finally {
        snapshot.opfs.close();
        this.releaseVectorReader();
      }
    });
  };

  public search = async (payload: VectorSearchPayload): Promise<VectorSearchResponse> => {
    if (!(payload.query || "").trim()) {
      return {
        results: [],
        timings: {
          embeddingMs: 0,
          scanMs: 0,
          totalMs: 0,
          scannedCount: 0,
        },
      };
    }

    const lease = await this.acquireQueryLease(payload.signal);
    try {
      return await lease.search(payload);
    } finally {
      lease.release();
    }
  };
}

export const vectorStoreService = new VectorStoreService();
