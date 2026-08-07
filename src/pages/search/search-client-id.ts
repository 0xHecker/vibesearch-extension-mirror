export type SearchClientIdHolder = { current: string | null };

let fallbackSequence = 0;

export const createSearchClientId = (): string => {
  try {
    if (typeof globalThis.crypto?.randomUUID === "function") {
      return `search-${globalThis.crypto.randomUUID()}`;
    }
  } catch {}

  fallbackSequence += 1;
  return `search-${Date.now().toString(36)}-${fallbackSequence.toString(36)}-${Math.random()
    .toString(36)
    .slice(2, 10)}`;
};

/** Resolve once per mounted Search page so backend supersession stays page-local. */
export const getOrCreateSearchClientId = (
  holder: SearchClientIdHolder,
  createId: () => string = createSearchClientId
): string => {
  if (!holder.current) holder.current = createId();
  return holder.current;
};
