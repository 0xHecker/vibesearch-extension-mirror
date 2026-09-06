import { z } from "zod";
import { RECENT_QUERIES_KEY } from "../query/model";

const recentQueriesSchema = z.array(z.string());
const MAX_RECENT_QUERIES = 20;

export function readRecentQueries(): string[] {
  try {
    const raw = localStorage.getItem(RECENT_QUERIES_KEY);
    if (!raw) return [];
    const value: unknown = JSON.parse(raw);
    const result = recentQueriesSchema.safeParse(value);
    if (!result.success) return [];
    return result.data
      .map((query) => query.trim())
      .filter(Boolean)
      .slice(0, MAX_RECENT_QUERIES);
  } catch {
    return [];
  }
}

export function writeRecentQueries(queries: string[]): void {
  try {
    localStorage.setItem(
      RECENT_QUERIES_KEY,
      JSON.stringify(queries.slice(0, MAX_RECENT_QUERIES)),
    );
  } catch {
    // Search history is optional when browser storage is unavailable.
  }
}

export function clearRecentQueries(): void {
  try {
    localStorage.removeItem(RECENT_QUERIES_KEY);
  } catch {
    // Search history is optional when browser storage is unavailable.
  }
}
