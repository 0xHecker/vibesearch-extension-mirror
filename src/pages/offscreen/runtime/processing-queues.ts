import { EmbeddingQueue } from "./embedding-queue";
import { OcrQueue } from "./ocr-queue";

export type ProcessingQueues = {
  embedding: EmbeddingQueue;
  ocr: OcrQueue;
};

/** Wire the two queues without letting either own the other's lifecycle. */
export function createProcessingQueues(): ProcessingQueues {
  let ocr: OcrQueue | undefined;
  const embedding = new EmbeddingQueue(() => ocr?.scheduleIfNeeded());
  ocr = new OcrQueue({
    isEmbeddingRunning: () => embedding.isRunning(),
    scheduleEmbedding: () => embedding.scheduleIfNeeded(),
  });
  return { embedding, ocr };
}
