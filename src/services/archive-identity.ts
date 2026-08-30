/** Keep archive ownership aligned with the shared item/document ID contract. */
export const ARCHIVE_ITEM_ID_MAX_CHARS = 512;

export const normalizeArchiveItemId = (value: unknown): string | null => {
  if (
    typeof value !== "string" ||
    !value.trim() ||
    value.length > ARCHIVE_ITEM_ID_MAX_CHARS ||
    /[\u0000-\u001f\u007f]/u.test(value)
  ) {
    return null;
  }
  // IDs are opaque. Whitespace and reserved URL characters are data, so only
  // validate here; callers encode the exact value at the HTTP boundary.
  return value;
};

export const collectArchiveItemIds = (values: Iterable<unknown>): string[] => {
  const output = new Set<string>();
  for (const value of values) {
    const itemId = normalizeArchiveItemId(value);
    if (itemId) output.add(itemId);
  }
  return [...output];
};
