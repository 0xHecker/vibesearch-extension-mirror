/**
 * Normalizes a query term exactly as the local FlexSearch index does.
 *
 * Keep this separate from display-text normalization: punctuation is a token
 * boundary in the index and must therefore be a token boundary when matching
 * per-term lexical hits during Boolean expression evaluation.
 */
export const normalizeSearchIndexText = (input: string): string =>
  input
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9._:/\-\s]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
