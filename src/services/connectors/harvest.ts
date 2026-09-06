/**
 * Stable connector-facing façade for provider JSON harvesting.
 *
 * Navigation selects provider entry boundaries, normalization maps one entry to
 * the cloud contract, and media extraction stays isolated behind normalization.
 */
export {
  findCursor,
  findEntryList,
  findInstagramCursor,
  findInstagramEntryList,
  findRedditCursor,
  findRedditEntryList,
  findXCursor,
  findXEntryList,
} from "./harvest/navigation";
export { normalizeEntry, type NormalizeCtx } from "./harvest/normalize";

/** Jittered pause between provider pages to reduce rate-limit pressure. */
export const politeDelay = (base = 900, jitter = 800): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, base + Math.floor(Math.random() * jitter)));
