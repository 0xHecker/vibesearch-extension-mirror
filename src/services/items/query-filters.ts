import { resolveIncludedTagIds } from "@src/search-core/tag-filter";
import type { MyDatabase } from "@src/services/DatabaseService";
import type {
  CandidateLite,
  LocalQueryFilters,
} from "@src/services/items/search-model";

function applyPropertyFilters(
  candidates: CandidateLite[],
  filters: LocalQueryFilters,
): CandidateLite[] {
  let filtered = candidates;
  if (filters.excludeFolderIds?.length) {
    const excluded = new Set(filters.excludeFolderIds.filter(Boolean));
    filtered = filtered.filter((item) => !excluded.has(item.folderId));
  }
  if (filters.excludeSources?.length) {
    const excluded = new Set(filters.excludeSources);
    filtered = filtered.filter((item) => !excluded.has(item.source));
  }
  if (filters.authors?.length) {
    const included = new Set(filters.authors.map((author) => author.toLowerCase()));
    filtered = filtered.filter(
      (item) => item.authorUsername.length > 0 && included.has(item.authorUsername),
    );
  }
  if (filters.excludeAuthors?.length) {
    const excluded = new Set(filters.excludeAuthors.map((author) => author.toLowerCase()));
    filtered = filtered.filter(
      (item) => item.authorUsername.length === 0 || !excluded.has(item.authorUsername),
    );
  }
  if (filters.domains?.length) {
    const included = new Set(filters.domains.map((domain) => domain.toLowerCase()));
    filtered = filtered.filter((item) => Boolean(item.domain) && included.has(item.domain || ""));
  }
  if (filters.excludeDomains?.length) {
    const excluded = new Set(filters.excludeDomains.map((domain) => domain.toLowerCase()));
    filtered = filtered.filter((item) => !item.domain || !excluded.has(item.domain));
  }
  if (filters.hasAny?.length) {
    const required = new Set(filters.hasAny);
    filtered = filtered.filter((item) => {
      if (required.has("media") && !item.hasMedia) return false;
      if (required.has("image") && !item.mediaTypes.includes("image")) return false;
      if (required.has("video") && !item.mediaTypes.includes("video")) return false;
      if (required.has("embed") && !item.hasEmbed) return false;
      return true;
    });
  }
  if (filters.excludeHasAny?.length) {
    const excluded = new Set(filters.excludeHasAny);
    filtered = filtered.filter((item) => {
      if (excluded.has("media") && item.hasMedia) return false;
      if (excluded.has("image") && item.mediaTypes.includes("image")) return false;
      if (excluded.has("video") && item.mediaTypes.includes("video")) return false;
      if (excluded.has("embed") && item.hasEmbed) return false;
      return true;
    });
  }
  return filtered;
}

async function resolveTagFilters(
  db: MyDatabase,
  filters: LocalQueryFilters,
): Promise<{ includedTagIds: string[]; excludedTagIds: string[]; unresolved: boolean }> {
  const requestedIds = (filters.tagIds || []).filter(Boolean);
  const requestedNames = (filters.tagNames || [])
    .map((name) => name.toLowerCase())
    .filter(Boolean);
  const excludedNames = (filters.excludeTagNames || [])
    .map((name) => name.toLowerCase())
    .filter(Boolean);
  const tags = requestedNames.length > 0 || excludedNames.length > 0
    ? await db.tags.find().exec()
    : [];

  let includedTagIds = requestedIds;
  let unresolved = false;
  if (requestedNames.length > 0) {
    const resolution = resolveIncludedTagIds({
      requestedIds,
      requestedNames,
      tags: tags.map((tag) => ({ id: tag.get("id"), name: tag.get("name") })),
    });
    includedTagIds = resolution.tagIds;
    unresolved = resolution.hasUnresolvedName;
  }
  const excludedNameSet = new Set(excludedNames);
  const excludedTagIds = tags
    .filter((tag) => excludedNameSet.has(tag.get("name").toLowerCase()))
    .map((tag) => tag.get("id"));
  return { includedTagIds, excludedTagIds, unresolved };
}

async function keepItemsWithAllTags(
  db: MyDatabase,
  candidates: CandidateLite[],
  tagIds: string[],
): Promise<CandidateLite[]> {
  if (tagIds.length === 0) return candidates;
  const uniqueTagIds = Array.from(new Set(tagIds));
  const joins = await db.item_tags.find({
    selector: { tagId: { $in: uniqueTagIds } },
  }).exec();
  const tagsByItem = new Map<string, Set<string>>();
  for (const join of joins) {
    const itemId = join.get("itemId");
    const itemTags = tagsByItem.get(itemId) || new Set<string>();
    itemTags.add(join.get("tagId"));
    tagsByItem.set(itemId, itemTags);
  }
  return candidates.filter((item) => {
    const itemTags = tagsByItem.get(item.id);
    return itemTags ? uniqueTagIds.every((tagId) => itemTags.has(tagId)) : false;
  });
}

async function removeItemsWithTags(
  db: MyDatabase,
  candidates: CandidateLite[],
  tagIds: string[],
): Promise<CandidateLite[]> {
  if (tagIds.length === 0) return candidates;
  const joins = await db.item_tags.find({
    selector: { tagId: { $in: Array.from(new Set(tagIds)) } },
  }).exec();
  const excludedItems = new Set(joins.map((join) => join.get("itemId")));
  return candidates.filter((item) => !excludedItems.has(item.id));
}

export async function applyItemQueryFilters(
  db: MyDatabase,
  candidates: CandidateLite[],
  filters: LocalQueryFilters,
): Promise<CandidateLite[]> {
  const propertyFiltered = applyPropertyFilters(candidates, filters);
  const tagFilters = await resolveTagFilters(db, filters);
  if (tagFilters.unresolved) return [];
  const included = await keepItemsWithAllTags(
    db,
    propertyFiltered,
    tagFilters.includedTagIds,
  );
  return removeItemsWithTags(db, included, tagFilters.excludedTagIds);
}
