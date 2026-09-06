import {
  RANK_REQUEST_SUPERSEDED,
  SupersededRankRequestError,
} from "@src/services/query-ranker.service";

type SearchRequestContext = {
  clientId: string;
  generation: number;
  queryAbortController: AbortController;
  lexicalAbortController: AbortController | null;
  vectorAbortController: AbortController | null;
};

const DEFAULT_SEARCH_CLIENT_ID = "__legacy_search_client__";
const MAX_SEARCH_CLIENT_ID_LENGTH = 128;

export class ItemSearchSession {
  private searchGeneration = 0;
  readonly searchContextsByClient = new Map<string, SearchRequestContext>();
  private readonly searchContextsByGeneration = new Map<number, SearchRequestContext>();

  // Mirrors retained for the default lane because older callers inspect them.
  activeQueryAbortController: AbortController | null = null;
  activeLexicalSearchAbortController: AbortController | null = null;
  activeVectorSearchAbortController: AbortController | null = null;

  private normalizeClientId(clientId?: string): string {
    const normalized = (clientId || "").trim();
    return normalized
      ? normalized.slice(0, MAX_SEARCH_CLIENT_ID_LENGTH)
      : DEFAULT_SEARCH_CLIENT_ID;
  }

  private abortContext(context: SearchRequestContext): void {
    const reason = new Error(RANK_REQUEST_SUPERSEDED);
    context.queryAbortController.abort(reason);
    context.lexicalAbortController?.abort(reason);
    context.vectorAbortController?.abort(reason);
  }

  begin(clientId?: string): number {
    const normalizedClientId = this.normalizeClientId(clientId);
    const previous = this.searchContextsByClient.get(normalizedClientId);
    if (previous) {
      this.abortContext(previous);
      this.searchContextsByGeneration.delete(previous.generation);
    }

    this.searchGeneration += 1;
    const context: SearchRequestContext = {
      clientId: normalizedClientId,
      generation: this.searchGeneration,
      queryAbortController: new AbortController(),
      lexicalAbortController: null,
      vectorAbortController: null,
    };
    this.searchContextsByClient.set(normalizedClientId, context);
    this.searchContextsByGeneration.set(context.generation, context);
    if (normalizedClientId === DEFAULT_SEARCH_CLIENT_ID) {
      this.activeQueryAbortController = context.queryAbortController;
      this.activeLexicalSearchAbortController = null;
      this.activeVectorSearchAbortController = null;
    }
    return context.generation;
  }

  private getContext(generation: number): SearchRequestContext {
    const context = this.searchContextsByGeneration.get(generation);
    const isCurrent = context && this.searchContextsByClient.get(context.clientId) === context;
    if (!context || !isCurrent || context.queryAbortController.signal.aborted) {
      throw new SupersededRankRequestError();
    }
    return context;
  }

  assertCurrent(generation: number): void {
    this.getContext(generation);
  }

  signal(generation: number): AbortSignal {
    return this.getContext(generation).queryAbortController.signal;
  }

  clientId(generation: number): string {
    return this.getContext(generation).clientId;
  }

  startLexical(generation: number): AbortController {
    const context = this.getContext(generation);
    context.lexicalAbortController?.abort(new Error(RANK_REQUEST_SUPERSEDED));
    const controller = new AbortController();
    context.lexicalAbortController = controller;
    if (context.clientId === DEFAULT_SEARCH_CLIENT_ID) {
      this.activeLexicalSearchAbortController = controller;
    }
    return controller;
  }

  finishLexical(generation: number, controller: AbortController): void {
    const context = this.searchContextsByGeneration.get(generation);
    if (!context || context.lexicalAbortController !== controller) return;
    context.lexicalAbortController = null;
    if (
      context.clientId === DEFAULT_SEARCH_CLIENT_ID &&
      this.activeLexicalSearchAbortController === controller
    ) {
      this.activeLexicalSearchAbortController = null;
    }
  }

  startVector(generation: number): AbortController {
    const context = this.getContext(generation);
    context.vectorAbortController?.abort(new Error(RANK_REQUEST_SUPERSEDED));
    const controller = new AbortController();
    context.vectorAbortController = controller;
    if (context.clientId === DEFAULT_SEARCH_CLIENT_ID) {
      this.activeVectorSearchAbortController = controller;
    }
    return controller;
  }

  finishVector(generation: number, controller: AbortController): void {
    const context = this.searchContextsByGeneration.get(generation);
    if (!context || context.vectorAbortController !== controller) return;
    context.vectorAbortController = null;
    if (
      context.clientId === DEFAULT_SEARCH_CLIENT_ID &&
      this.activeVectorSearchAbortController === controller
    ) {
      this.activeVectorSearchAbortController = null;
    }
  }

  finish(generation: number): void {
    const context = this.searchContextsByGeneration.get(generation);
    if (!context || this.searchContextsByClient.get(context.clientId) !== context) return;
    this.searchContextsByGeneration.delete(generation);
    this.searchContextsByClient.delete(context.clientId);
    context.lexicalAbortController = null;
    context.vectorAbortController = null;

    if (context.clientId !== DEFAULT_SEARCH_CLIENT_ID) return;
    if (this.activeQueryAbortController === context.queryAbortController) {
      this.activeQueryAbortController = null;
    }
    this.activeLexicalSearchAbortController = null;
    this.activeVectorSearchAbortController = null;
  }

  async withTimeout<T>(
    promise: Promise<T>,
    timeoutMs: number,
    message: string,
    onTimeout?: () => void,
  ): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | null = null;
    const timeout = new Promise<T>((_resolve, reject) => {
      timer = setTimeout(() => {
        onTimeout?.();
        reject(new Error(message));
      }, timeoutMs);
    });
    try {
      return await Promise.race([promise, timeout]);
    } finally {
      if (timer !== null) clearTimeout(timer);
    }
  }
}
