export type SearchTagLike = {
  id: string;
  name: string;
};

/**
 * Resolve inclusive tag names without weakening the filter. If any requested
 * name is unknown, no record can satisfy the full inclusive filter.
 */
export const resolveIncludedTagIds = (input: {
  requestedIds: readonly string[];
  requestedNames: readonly string[];
  tags: readonly SearchTagLike[];
}): { tagIds: string[]; hasUnresolvedName: boolean } => {
  const tagIds = new Set(input.requestedIds.filter(Boolean));
  const idsByName = new Map<string, string[]>();
  for (const tag of input.tags) {
    const normalizedName = tag.name.trim().toLowerCase();
    if (!tag.id || !normalizedName) continue;
    const ids = idsByName.get(normalizedName) || [];
    ids.push(tag.id);
    idsByName.set(normalizedName, ids);
  }

  let hasUnresolvedName = false;
  for (const rawName of new Set(input.requestedNames)) {
    const normalizedName = rawName.trim().toLowerCase();
    if (!normalizedName) continue;
    const matchingIds = idsByName.get(normalizedName);
    if (!matchingIds || matchingIds.length === 0) {
      hasUnresolvedName = true;
      continue;
    }
    for (const tagId of matchingIds) tagIds.add(tagId);
  }

  return { tagIds: Array.from(tagIds), hasUnresolvedName };
};
