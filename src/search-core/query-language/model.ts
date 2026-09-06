import type { ItemDocType } from "@src/schemas/item_schema";

import type {
  QueryDirectives,
  QueryField,
  QueryFilters,
  QueryScope,
} from "../contracts";

export type MediaFilter = "image" | "video" | "media" | "embed";

export const QUERY_FIELDS = [
  "space",
  "source",
  "site",
  "domain",
  "tag",
  "folder",
  "author",
  "is",
  "has",
  "date",
  "added",
  "created",
  "updated",
  "likes",
  "upvotes",
  "sort",
  "scope",
  "mode",
  "limit",
  "page",
  "minscore",
  "score",
] satisfies readonly QueryField[];

export const ITEM_SOURCES = [
  "web",
  "twitter",
  "reddit",
  "note",
  "youtube",
  "instagram",
  "tiktok",
  "substack",
  "linkedin",
  "threads",
  "mastodon",
  "bluesky",
  "github",
  "spotify",
  "ytmusic",
  "vimeo",
  "soundcloud",
  "article",
] satisfies readonly ItemDocType["source"][];

export const MEDIA_FILTERS = [
  "image",
  "video",
  "embed",
  "media",
] satisfies readonly MediaFilter[];

export const QUERY_SCOPES = [
  "current",
  "global",
  "private",
  "public",
] satisfies readonly QueryScope[];

export function parseQueryField(value: string): QueryField | null {
  return QUERY_FIELDS.find((field) => field === value) ?? null;
}

export function parseItemSource(value: string): ItemDocType["source"] | null {
  return ITEM_SOURCES.find((source) => source === value) ?? null;
}

export function parseMediaFilter(value: string): MediaFilter | null {
  return MEDIA_FILTERS.find((filter) => filter === value) ?? null;
}

export function parseQueryScope(value: string): QueryScope | null {
  return QUERY_SCOPES.find((scope) => scope === value) ?? null;
}

export function createDefaultFilters(): QueryFilters {
  return {
    spaceIds: [],
    excludeSpaceIds: [],
    sources: [],
    excludeSources: [],
    folderIds: [],
    excludeFolderIds: [],
    tagNames: [],
    excludeTagNames: [],
    domains: [],
    excludeDomains: [],
    authors: [],
    excludeAuthors: [],
    hasAny: [],
    excludeHasAny: [],
    favoritesOnly: false,
  };
}

export function createDefaultDirectives(): QueryDirectives {
  return {};
}

export function trimQuotes(value: string): string {
  if (value.startsWith('"') && value.endsWith('"') && value.length >= 2) {
    return value.slice(1, -1);
  }
  return value;
}
