import {
  QUERY_REFRESH_DEBOUNCE_IDLE_MS,
  QUERY_REFRESH_DEBOUNCE_LOW_PRIORITY_MS,
  QUERY_REFRESH_DEBOUNCE_PROCESSING_MS,
} from "./model";
import { useCallback, useEffect, useRef } from "react";

export type QueryRefreshPriority = "high" | "low";

type QueryRefreshSchedulerOptions = {
  hasBackgroundProcessing: boolean;
  refreshResults: () => void;
};

/** Coalesces noisy database events without making active search status blink. */
export function useQueryRefreshScheduler({
  hasBackgroundProcessing,
  refreshResults,
}: QueryRefreshSchedulerOptions) {
  const timer = useRef<number | null>(null);

  useEffect(
    () => () => {
      if (timer.current !== null) window.clearTimeout(timer.current);
    },
    [],
  );

  return useCallback(
    (priority: QueryRefreshPriority = "high"): void => {
      if (timer.current !== null) window.clearTimeout(timer.current);
      timer.current = window.setTimeout(
        () => {
          timer.current = null;
          refreshResults();
        },
        refreshDelay(priority, hasBackgroundProcessing),
      );
    },
    [hasBackgroundProcessing, refreshResults],
  );
}

function refreshDelay(
  priority: QueryRefreshPriority,
  hasBackgroundProcessing: boolean,
): number {
  if (priority === "low") return QUERY_REFRESH_DEBOUNCE_LOW_PRIORITY_MS;
  if (hasBackgroundProcessing) return QUERY_REFRESH_DEBOUNCE_PROCESSING_MS;
  return QUERY_REFRESH_DEBOUNCE_IDLE_MS;
}
