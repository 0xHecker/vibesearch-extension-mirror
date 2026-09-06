export type DatabaseChangeScope = "items" | "folders" | "spaces" | "tags";

/** Notify live views after a committed write; persistence never depends on messaging. */
export function notifyDatabaseChanged(scope: DatabaseChangeScope): void {
  try {
    void Promise.resolve(chrome.runtime.sendMessage({ type: "DB_CHANGE", scope })).catch(
      () => undefined,
    );
  } catch {
    // Tests and startup contexts may not expose extension runtime messaging.
  }
}
