/// <reference lib="webworker" />
import { OpfsHandler } from "@src/services/vector-store/opfs-handler";
import {
  copyCleanVectorRangesInChunks,
  runVectorCompactionWorkerRequest,
  VECTOR_COMPACTION_COPY_CHUNK_SIZE_BYTES,
  type CopyCleanVectorsWorkerPayload,
  type CopyCleanVectorsWorkerRequest,
} from "@src/services/vector-store/compaction-copy";

const copyCleanVectors = async (
  payload: CopyCleanVectorsWorkerPayload
): Promise<{ appendedCount: number }> => {
  if (payload.cleanItems.length === 0) return { appendedCount: 0 };

  const sourceOpfs = new OpfsHandler();
  const destOpfs = new OpfsHandler();
  await sourceOpfs.open(payload.sourceFile, false, false);
  await destOpfs.open(payload.destFile);

  try {
    return await copyCleanVectorRangesInChunks(
      {
        cleanItems: payload.cleanItems,
        destStartIndex: payload.destStartIndex,
        vectorDimension: payload.vectorDimension,
        headerSize: payload.headerSize,
        maxChunkBytes: VECTOR_COMPACTION_COPY_CHUNK_SIZE_BYTES,
      },
      {
        read: (buffer, offset) => sourceOpfs.read(buffer, offset),
        write: (buffer, offset) => destOpfs.write(buffer, offset),
      }
    );
  } finally {
    sourceOpfs.close();
    destOpfs.close();
  }
};

self.onmessage = async (event: MessageEvent<CopyCleanVectorsWorkerRequest>) => {
  const message = event.data;
  if (!message || message.type !== "COPY_CLEAN_VECTORS") return;
  self.postMessage(await runVectorCompactionWorkerRequest(message, copyCleanVectors));
};

export {};
