import { EmbeddingWorkerClient } from "./embedding-worker-client";
import type { EmbeddingRequestPriority } from "./workers/embedding-worker-protocol";

class EmbeddingService {
  private worker = new EmbeddingWorkerClient();

  public generateEmbeddings = async (payload: {
    sentences: string[];
    priority?: EmbeddingRequestPriority;
    signal?: AbortSignal;
  }): Promise<Float32Array> => {
    return this.worker.embed(payload.sentences, payload.priority || "background", payload.signal);
  };
}

export const embeddingService = new EmbeddingService();
