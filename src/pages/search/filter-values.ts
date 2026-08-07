type NamedEntity = {
  id: string;
  name: string;
};

/** Resolve query-language names to the IDs expected by the local-query API. */
export const resolveNamedFilterValues = (
  values: readonly string[],
  entities: readonly NamedEntity[]
): string[] => {
  if (values.length === 0) return [];

  const entityIds = new Set(entities.map((entity) => entity.id));
  const idsByName = new Map<string, string[]>();
  for (const entity of entities) {
    const normalizedName = entity.name.toLowerCase();
    const ids = idsByName.get(normalizedName) || [];
    ids.push(entity.id);
    idsByName.set(normalizedName, ids);
  }

  const resolvedIds: string[] = [];
  for (const value of values) {
    if (!value) continue;
    if (entityIds.has(value)) {
      resolvedIds.push(value);
      continue;
    }

    const namedIds = idsByName.get(value.toLowerCase());
    if (namedIds?.length) {
      resolvedIds.push(...namedIds);
      continue;
    }

    // The backend expects IDs. Keeping an unknown name as an impossible ID
    // intentionally returns zero rows; dropping it would silently remove the
    // user's filter and expose unrelated results.
    resolvedIds.push(value);
  }

  return Array.from(new Set(resolvedIds));
};

/**
 * Sidebar folder selection belongs to browse navigation, not to the search
 * expression. Once a query is active, only explicit `folder:` filters may
 * constrain it.
 */
export const resolveSearchFolderFilterIds = (input: {
  hasActiveQuery: boolean;
  parsedFolderIds: readonly string[];
  selectedFolderId: string;
}): string[] => {
  const explicitIds = Array.from(new Set(input.parsedFolderIds.filter(Boolean)));
  if (
    input.hasActiveQuery ||
    !input.selectedFolderId ||
    input.selectedFolderId === "all"
  ) {
    return explicitIds;
  }
  return Array.from(new Set([...explicitIds, input.selectedFolderId]));
};
