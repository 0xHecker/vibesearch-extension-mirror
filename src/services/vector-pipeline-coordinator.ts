type PipelineOperation = "embedding" | "compaction" | "deletion";

class VectorPipelineCoordinator {
  private tail: Promise<void> = Promise.resolve();
  private activeOperation: PipelineOperation | null = null;
  private generation = 0;

  public getActiveOperation(): PipelineOperation | null {
    return this.activeOperation;
  }

  public async runExclusive<T>(
    operation: PipelineOperation,
    task: () => Promise<T> | T
  ): Promise<T> {
    const expectedGeneration = this.generation;
    const run = this.tail.then(async () => {
      if (expectedGeneration !== this.generation) {
        throw new Error("VECTOR_PIPELINE_INVALIDATED");
      }
      this.activeOperation = operation;
      try {
        return await task();
      } finally {
        this.activeOperation = null;
      }
    });

    this.tail = run.then(
      () => undefined,
      () => undefined
    );

    return run;
  }

  /**
   * Invalidates work queued before or during a destructive reset, waits for an
   * already-running vector mutation, then runs the reset as the sole writer.
   */
  public async runResetExclusive<T>(task: () => Promise<T> | T): Promise<T> {
    this.generation += 1;
    const run = this.tail.then(async () => {
      this.activeOperation = "deletion";
      try {
        return await task();
      } finally {
        this.generation += 1;
        this.activeOperation = null;
      }
    });
    this.tail = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }
}

export const vectorPipelineCoordinator = new VectorPipelineCoordinator();
export type { PipelineOperation };
