import type { ItemDocType } from "@src/schemas/item_schema";
import type { LocalQueryFilters } from "@src/services/items/search-model";
import type { MangoQuerySelector } from "rxdb";

type NumericRange = {
  $gte?: number;
  $lte?: number;
};

function numericRange(minimum?: number, maximum?: number): NumericRange | undefined {
  if (minimum === undefined && maximum === undefined) return undefined;
  const range: NumericRange = {};
  if (minimum !== undefined) range.$gte = minimum;
  if (maximum !== undefined) range.$lte = maximum;
  return range;
}

export function buildItemQuerySelector(
  allowedSpaceIds: string[],
  filters: LocalQueryFilters,
): MangoQuerySelector<ItemDocType> {
  const selector: MangoQuerySelector<ItemDocType> = {
    deletedAt: { $eq: 0 },
    spaceId: { $in: allowedSpaceIds },
  };
  if (filters.folderIds?.length) {
    selector.folderId = { $in: filters.folderIds.filter(Boolean) };
  }
  if (filters.sources?.length) selector.source = { $in: filters.sources };
  if (filters.favoritesOnly) selector.isFavorite = { $eq: true };

  const createdAt = numericRange(
    filters.createdFrom ?? filters.dateFrom,
    filters.createdTo ?? filters.dateTo,
  );
  if (createdAt) selector.createdAt = createdAt;
  const updatedAt = numericRange(filters.updatedFrom, filters.updatedTo);
  if (updatedAt) selector.updatedAt = updatedAt;
  const likes = numericRange(filters.likesMin, filters.likesMax);
  if (likes) selector.likes = likes;
  const upvotes = numericRange(filters.upvotesMin, filters.upvotesMax);
  if (upvotes) selector.upvotes = upvotes;
  return selector;
}
