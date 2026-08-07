export const VECTOR_COMPACTION_COPY_CHUNK_SIZE_BYTES = 2 * 1024 * 1024;

export type VectorIndexMapEntry = { id: string; vector_index: number };

export type CopyCleanVectorsWorkerPayload = {
  sourceFile: string;
  destFile: string;
  cleanItems: VectorIndexMapEntry[];
  destStartIndex: number;
  vectorDimension: number;
  headerSize: number;
};

export type CopyCleanVectorsWorkerRequest = {
  type: "COPY_CLEAN_VECTORS";
  requestId: number;
  payload: CopyCleanVectorsWorkerPayload;
};

export type CopyCleanVectorsWorkerResult = {
  appendedCount: number;
};

export type CopyCleanVectorsWorkerResponse =
  | {
      type: "COPY_CLEAN_VECTORS_RESULT";
      requestId: number;
      ok: true;
      payload: CopyCleanVectorsWorkerResult;
    }
  | {
      type: "COPY_CLEAN_VECTORS_RESULT";
      requestId: number;
      ok: false;
      error: string;
    };

type VectorCopyIo = {
  read(buffer: ArrayBuffer, offset: number): Promise<void>;
  write(buffer: ArrayBuffer, offset: number): Promise<void>;
};

type CopyCleanVectorRangesInput = Pick<
  CopyCleanVectorsWorkerPayload,
  "cleanItems" | "destStartIndex" | "vectorDimension" | "headerSize"
> & {
  maxChunkBytes?: number;
};

export type VectorReadChunk = {
  startIndex: number;
  count: number;
  byteOffset: number;
  byteLength: number;
};

export type CandidateVectorReadChunk = VectorReadChunk & {
  candidateIndices: number[];
};

const assertNonNegativeInteger = (value: number, label: string) => {
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`${label} must be a non-negative integer.`);
  }
};

const validateSortedCleanItems = (items: readonly VectorIndexMapEntry[]) => {
  let previousIndex = -1;
  for (const item of items) {
    if (!item || typeof item.id !== "string" || item.id.length === 0) {
      throw new Error("Vector compaction received an invalid item id.");
    }
    assertNonNegativeInteger(item.vector_index, "Vector index");
    if (item.vector_index < previousIndex) {
      throw new Error("Vector compaction items must be sorted by vector index.");
    }
    previousIndex = item.vector_index;
  }
};

export const planContiguousVectorReadChunks = (input: {
  vectorCount: number;
  vectorDimension: number;
  headerSize: number;
  maxChunkBytes?: number;
}): VectorReadChunk[] => {
  const {
    vectorCount,
    vectorDimension,
    headerSize,
    maxChunkBytes = VECTOR_COMPACTION_COPY_CHUNK_SIZE_BYTES,
  } = input;
  assertNonNegativeInteger(vectorCount, "Vector count");
  if (!Number.isInteger(vectorDimension) || vectorDimension <= 0) {
    throw new Error("Vector dimension must be a positive integer.");
  }
  assertNonNegativeInteger(headerSize, "Vector header size");
  if (!Number.isInteger(maxChunkBytes) || maxChunkBytes <= 0) {
    throw new Error("Vector read chunk size must be a positive integer.");
  }

  const vectorSizeBytes = vectorDimension * Float32Array.BYTES_PER_ELEMENT;
  const vectorsPerChunk = Math.floor(maxChunkBytes / vectorSizeBytes);
  if (vectorsPerChunk < 1) {
    throw new Error("Vector read chunk size is smaller than one vector.");
  }

  const chunks: VectorReadChunk[] = [];
  for (let startIndex = 0; startIndex < vectorCount; startIndex += vectorsPerChunk) {
    const count = Math.min(vectorsPerChunk, vectorCount - startIndex);
    chunks.push({
      startIndex,
      count,
      byteOffset: headerSize + startIndex * vectorSizeBytes,
      byteLength: count * vectorSizeBytes,
    });
  }
  return chunks;
};

/**
 * Group sorted candidate indexes into bounded byte windows. Sparse candidates
 * within one window share an OPFS read; no window can exceed maxChunkBytes.
 */
export const planCandidateVectorReadChunks = (input: {
  candidateIndices: readonly number[];
  vectorCount: number;
  vectorDimension: number;
  headerSize: number;
  maxChunkBytes?: number;
}): CandidateVectorReadChunk[] => {
  const {
    vectorCount,
    vectorDimension,
    headerSize,
    maxChunkBytes = VECTOR_COMPACTION_COPY_CHUNK_SIZE_BYTES,
  } = input;
  assertNonNegativeInteger(vectorCount, "Vector count");
  if (!Number.isInteger(vectorDimension) || vectorDimension <= 0) {
    throw new Error("Vector dimension must be a positive integer.");
  }
  assertNonNegativeInteger(headerSize, "Vector header size");

  const vectorSizeBytes = vectorDimension * Float32Array.BYTES_PER_ELEMENT;
  const vectorsPerChunk = Math.floor(maxChunkBytes / vectorSizeBytes);
  if (vectorsPerChunk < 1) {
    throw new Error("Vector read chunk size is smaller than one vector.");
  }

  const sorted = Array.from(
    new Set(
      input.candidateIndices.filter(
        (index) => Number.isInteger(index) && index >= 0 && index < vectorCount
      )
    )
  ).sort((left, right) => left - right);
  const chunks: CandidateVectorReadChunk[] = [];

  for (let cursor = 0; cursor < sorted.length; ) {
    const startIndex = sorted[cursor];
    const windowEndExclusive = startIndex + vectorsPerChunk;
    let end = cursor + 1;
    while (end < sorted.length && sorted[end] < windowEndExclusive) end += 1;
    const candidateIndices = sorted.slice(cursor, end);
    const count = candidateIndices[candidateIndices.length - 1] - startIndex + 1;
    chunks.push({
      startIndex,
      count,
      byteOffset: headerSize + startIndex * vectorSizeBytes,
      byteLength: count * vectorSizeBytes,
      candidateIndices,
    });
    cursor = end;
  }

  return chunks;
};

export const normalizeCleanVectorItems = (
  items: readonly VectorIndexMapEntry[]
): VectorIndexMapEntry[] =>
  items
    .filter(
      (item) =>
        typeof item?.id === "string" &&
        item.id.length > 0 &&
        Number.isInteger(item.vector_index) &&
        item.vector_index >= 0
    )
    .map((item) => ({ id: item.id, vector_index: item.vector_index }))
    .sort((left, right) => left.vector_index - right.vector_index);

export const buildCompactedIndexMap = (
  cleanItems: readonly VectorIndexMapEntry[],
  destStartIndex: number
): VectorIndexMapEntry[] => {
  assertNonNegativeInteger(destStartIndex, "Destination start index");
  return cleanItems.map((item, offset) => ({
    id: item.id,
    vector_index: destStartIndex + offset,
  }));
};

/**
 * Copy sorted live vectors while bounding each source read and destination
 * write. A contiguous run may span millions of vectors; it is deliberately
 * split into fixed-size buffers instead of being materialized as one run.
 */
export const copyCleanVectorRangesInChunks = async (
  input: CopyCleanVectorRangesInput,
  io: VectorCopyIo
): Promise<CopyCleanVectorsWorkerResult> => {
  const {
    cleanItems,
    destStartIndex,
    vectorDimension,
    headerSize,
    maxChunkBytes = VECTOR_COMPACTION_COPY_CHUNK_SIZE_BYTES,
  } = input;

  validateSortedCleanItems(cleanItems);
  assertNonNegativeInteger(destStartIndex, "Destination start index");
  if (!Number.isInteger(vectorDimension) || vectorDimension <= 0) {
    throw new Error("Vector dimension must be a positive integer.");
  }
  assertNonNegativeInteger(headerSize, "Vector header size");
  if (!Number.isInteger(maxChunkBytes) || maxChunkBytes <= 0) {
    throw new Error("Vector copy chunk size must be a positive integer.");
  }

  const vectorSizeBytes = vectorDimension * Float32Array.BYTES_PER_ELEMENT;
  const vectorsPerChunk = Math.floor(maxChunkBytes / vectorSizeBytes);
  if (vectorsPerChunk < 1) {
    throw new Error("Vector copy chunk size is smaller than one vector.");
  }

  let cursor = 0;
  let appendedCount = 0;

  while (cursor < cleanItems.length) {
    let runEnd = cursor + 1;
    while (
      runEnd < cleanItems.length &&
      cleanItems[runEnd].vector_index === cleanItems[runEnd - 1].vector_index + 1
    ) {
      runEnd += 1;
    }

    while (cursor < runEnd) {
      const chunkEnd = Math.min(runEnd, cursor + vectorsPerChunk);
      const chunkCount = chunkEnd - cursor;
      const buffer = new ArrayBuffer(chunkCount * vectorSizeBytes);
      const sourceOffset = headerSize + cleanItems[cursor].vector_index * vectorSizeBytes;
      const destOffset = headerSize + (destStartIndex + appendedCount) * vectorSizeBytes;

      await io.read(buffer, sourceOffset);
      await io.write(buffer, destOffset);

      appendedCount += chunkCount;
      cursor = chunkEnd;
    }
  }

  return { appendedCount };
};

export const runVectorCompactionWorkerRequest = async (
  request: CopyCleanVectorsWorkerRequest,
  copy: (payload: CopyCleanVectorsWorkerPayload) => Promise<CopyCleanVectorsWorkerResult>
): Promise<CopyCleanVectorsWorkerResponse> => {
  try {
    return {
      type: "COPY_CLEAN_VECTORS_RESULT",
      requestId: request.requestId,
      ok: true,
      payload: await copy(request.payload),
    };
  } catch (error) {
    return {
      type: "COPY_CLEAN_VECTORS_RESULT",
      requestId: request.requestId,
      ok: false,
      error: error instanceof Error ? error.message : "Vector compaction worker failed.",
    };
  }
};
