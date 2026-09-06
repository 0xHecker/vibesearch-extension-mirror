export type DatabaseChangeScope =
  | "items"
  | "folders"
  | "tags"
  | "spaces"
  | "space_groups";

export type ItemChangeKind = "content" | "metadata";

const CHANGE_FLUSH_DELAY_MS = 160;
const MAX_PUBLISHED_ITEM_IDS = 4_000;

/** Coalesces noisy RxDB events into bounded UI refresh notifications. */
export class DatabaseChangePublisher {
  private flushTimer: number | null = null;
  private readonly pendingScopes = new Set<DatabaseChangeScope>();
  private readonly pendingItemIds = new Set<string>();
  private pendingItemKind: ItemChangeKind | null = null;
  private suppressionDepth = 0;
  private readonly deferredScopes = new Set<DatabaseChangeScope>();

  schedule(
    scope: DatabaseChangeScope,
    changedItemIds: readonly string[] = [],
    itemChangeKind: ItemChangeKind = "content",
  ): void {
    if (this.suppressionDepth > 0) {
      this.deferredScopes.add(scope);
      return;
    }

    this.pendingScopes.add(scope);
    if (scope === "items") {
      for (const itemId of changedItemIds) {
        if (itemId) this.pendingItemIds.add(itemId);
      }
      this.pendingItemKind =
        this.pendingItemKind === "content" || itemChangeKind === "content"
          ? "content"
          : "metadata";
    }

    if (this.flushTimer !== null) return;
    this.flushTimer = window.setTimeout(
      () => this.flush(),
      CHANGE_FLUSH_DELAY_MS,
    );
  }

  async whileSuppressed<Result>(
    operation: () => Promise<Result>,
  ): Promise<Result> {
    this.suppressionDepth += 1;
    try {
      return await operation();
    } finally {
      this.suppressionDepth = Math.max(0, this.suppressionDepth - 1);
      if (this.suppressionDepth === 0) this.publishDeferredScopes();
    }
  }

  private publishDeferredScopes(): void {
    const scopes = [...this.deferredScopes];
    this.deferredScopes.clear();
    for (const scope of scopes) this.schedule(scope);
  }

  private flush(): void {
    this.flushTimer = null;
    const scopes = [...this.pendingScopes];
    const changedItemIds = [...this.pendingItemIds].slice(
      0,
      MAX_PUBLISHED_ITEM_IDS,
    );
    const itemChangeKind = this.pendingItemKind ?? "content";

    this.pendingScopes.clear();
    this.pendingItemIds.clear();
    this.pendingItemKind = null;

    for (const scope of scopes) {
      try {
        void chrome.runtime.sendMessage({
          type: "DB_CHANGE",
          scope,
          changedItemIds: scope === "items" ? changedItemIds : undefined,
          itemChangeKind: scope === "items" ? itemChangeKind : undefined,
          isCoalesced: true,
        });
      } catch {
        // Database writes remain valid when no extension page is listening.
      }
    }
  }
}
