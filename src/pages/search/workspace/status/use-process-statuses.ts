import type { SearchProcessStatusItem } from "@src/pages/search/components/SearchProcessStatus";
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  PROCESS_STATUS_MAX_ENTRIES,
  PROCESS_STATUS_PRUNE_INTERVAL_MS,
  isProcessStatusFresh,
} from "../query/model";

/** Maintains the bounded, expiring process feed shown above search results. */
export function useProcessStatuses() {
  const [statusById, setStatusById] = useState<
    Record<string, SearchProcessStatusItem>
  >({});
  const [retryingId, setRetryingId] = useState<string | null>(null);

  const statuses = useMemo(
    () =>
      Object.values(statusById).sort(
        (left, right) => right.updatedAt - left.updatedAt,
      ),
    [statusById],
  );

  const hasBackgroundProcessing = useMemo(
    () =>
      statuses.some(
        (status) =>
          status.state === "processing" && status.id !== "search-query",
      ),
    [statuses],
  );

  const upsert = useCallback((status: SearchProcessStatusItem): void => {
    setStatusById((current) => {
      const next = { ...current, [status.id]: status };
      const now = Date.now();
      const entries = Object.values(next)
        .filter((row) => isProcessStatusFresh(row, now))
        .sort((left, right) => right.updatedAt - left.updatedAt)
        .slice(0, PROCESS_STATUS_MAX_ENTRIES);
      return Object.fromEntries(entries.map((row) => [row.id, row]));
    });
  }, []);

  const clear = useCallback((statusId: string): void => {
    setStatusById((current) => {
      if (!(statusId in current)) return current;
      const next = { ...current };
      delete next[statusId];
      return next;
    });
  }, []);

  const prune = useCallback((): void => {
    setStatusById((current) => {
      const now = Date.now();
      const entries = Object.values(current).filter((row) =>
        isProcessStatusFresh(row, now),
      );
      if (entries.length === Object.keys(current).length) return current;
      return Object.fromEntries(entries.map((row) => [row.id, row]));
    });
  }, []);

  useEffect(() => {
    const timer = window.setInterval(prune, PROCESS_STATUS_PRUNE_INTERVAL_MS);
    return () => window.clearInterval(timer);
  }, [prune]);

  return {
    statuses,
    hasBackgroundProcessing,
    upsert,
    clear,
    retryingId,
    setRetryingId,
  };
}
