import { MAX_GRID_QUERY_LIMIT } from "@src/search-core/pagination";

import { parseQueryMode } from "../contracts";
import type {
  QueryDirectives,
  QueryFilters,
  QueryPill,
  QuerySortBy,
  QuerySortOrder,
  QueryToken,
} from "../contracts";
import { formatDatePillLabel, parseDateExpression } from "./date-filters";
import {
  parseItemSource,
  parseMediaFilter,
  parseQueryField,
  parseQueryScope,
  trimQuotes,
} from "./model";
import { parseNumericRange } from "./numeric-filters";
import { addPill } from "./tokens";

export type ParseTokenResult = {
  consumed: number;
  structured: boolean;
};

const SORT_OPTIONS = [
  { input: "relevance", value: "relevance" },
  { input: "createdat", value: "createdAt" },
  { input: "updatedat", value: "updatedAt" },
  { input: "title", value: "title" },
  { input: "source", value: "source" },
] satisfies readonly { input: string; value: QuerySortBy }[];

const SORT_ORDERS = ["asc", "desc"] satisfies readonly QuerySortOrder[];

export function parseTokenIntoState(
  token: QueryToken,
  nextToken: QueryToken | undefined,
  filters: QueryFilters,
  directives: QueryDirectives,
  pills: QueryPill[],
): ParseTokenResult {
  const isNegated = token.text.startsWith("-");
  const tokenText = isNegated ? token.text.slice(1) : token.text;
  const shorthandScope = tokenText.startsWith("/")
    ? parseQueryScope(tokenText.slice(1).toLowerCase())
    : null;
  if (shorthandScope) {
    directives.scope = shorthandScope;
    addPill(pills, "scope", token, shorthandScope, false);
    return structuredToken();
  }

  const separatorIndex = tokenText.indexOf(":");
  if (separatorIndex <= 0) return freeTextToken();
  const field = parseQueryField(
    tokenText.slice(0, separatorIndex).toLowerCase(),
  );
  const rawValue = tokenText.slice(separatorIndex + 1);
  if (!field || !rawValue) return freeTextToken();

  if (field === "source") {
    const source = parseItemSource(trimQuotes(rawValue).toLowerCase());
    if (source) {
      addToIncludedOrExcluded(
        filters.sources,
        filters.excludeSources,
        source,
        isNegated,
      );
      addPill(pills, field, token, source, isNegated);
      return structuredToken();
    }
  }

  if (field === "space") {
    return parseTextFilter(
      rawValue,
      filters.spaceIds,
      filters.excludeSpaceIds,
      isNegated,
      field,
      token,
      pills,
    );
  }

  if (field === "folder") {
    return parseTextFilter(
      rawValue,
      filters.folderIds,
      filters.excludeFolderIds,
      isNegated,
      field,
      token,
      pills,
    );
  }

  if (field === "author") {
    return parseTextFilter(
      rawValue.toLowerCase(),
      filters.authors,
      filters.excludeAuthors,
      isNegated,
      field,
      token,
      pills,
    );
  }

  if (field === "tag") {
    return parseTextFilter(
      rawValue.toLowerCase(),
      filters.tagNames,
      filters.excludeTagNames,
      isNegated,
      field,
      token,
      pills,
    );
  }

  if (field === "site" || field === "domain") {
    return parseTextFilter(
      rawValue.toLowerCase(),
      filters.domains,
      filters.excludeDomains,
      isNegated,
      field,
      token,
      pills,
    );
  }

  if (field === "is") {
    const value = trimQuotes(rawValue).toLowerCase();
    if (value === "favorite" && !isNegated) {
      filters.favoritesOnly = true;
      addPill(pills, field, token, "favorite", false);
      return structuredToken();
    }
  }

  if (field === "has") {
    const mediaFilter = parseMediaFilter(trimQuotes(rawValue).toLowerCase());
    if (mediaFilter) {
      addToIncludedOrExcluded(
        filters.hasAny,
        filters.excludeHasAny,
        mediaFilter,
        isNegated,
      );
      addPill(pills, field, token, mediaFilter, isNegated);
      return structuredToken();
    }
  }

  if (isDateField(field)) {
    const parsedDate = parseDateExpression(rawValue);
    if (parsedDate) {
      applyDateFilter(filters, field, parsedDate);
      const value = trimQuotes(rawValue);
      addPill(
        pills,
        field,
        token,
        value,
        false,
        undefined,
        formatDatePillLabel(field, value),
      );
      return structuredToken();
    }
  }

  if (field === "likes" || field === "upvotes") {
    const range = parseNumericRange(rawValue);
    if (range) {
      if (field === "likes") {
        filters.likesMin = range.min;
        filters.likesMax = range.max;
      } else {
        filters.upvotesMin = range.min;
        filters.upvotesMax = range.max;
      }
      addPill(pills, field, token, trimQuotes(rawValue), false);
      return structuredToken();
    }
  }

  if (field === "sort") {
    return parseSortDirective(rawValue, token, nextToken, directives, pills);
  }

  if (field === "scope") {
    const scope = parseQueryScope(trimQuotes(rawValue).toLowerCase());
    if (scope) {
      directives.scope = scope;
      addPill(pills, field, token, scope, false);
      return structuredToken();
    }
  }

  if (field === "mode") {
    const mode = parseQueryMode(trimQuotes(rawValue).toLowerCase());
    if (mode) {
      directives.mode = mode;
      addPill(pills, field, token, mode, false);
      return structuredToken();
    }
  }

  if (field === "limit") {
    const value = Number.parseInt(trimQuotes(rawValue), 10);
    if (Number.isFinite(value) && value > 0) {
      directives.limit = Math.min(MAX_GRID_QUERY_LIMIT, value);
      addPill(pills, field, token, String(directives.limit), false);
      return structuredToken();
    }
  }

  if (field === "page") {
    const value = Number.parseInt(trimQuotes(rawValue), 10);
    if (Number.isFinite(value) && value > 0) {
      directives.page = value;
      addPill(pills, field, token, String(value), false);
      return structuredToken();
    }
  }

  if (field === "minscore" || field === "score") {
    const value = Number.parseFloat(trimQuotes(rawValue));
    if (Number.isFinite(value)) {
      directives.minScore = Math.max(0, Math.min(1, value));
      addPill(pills, field, token, String(directives.minScore), false);
      return structuredToken();
    }
  }

  return freeTextToken();
}

function parseTextFilter(
  rawValue: string,
  included: string[],
  excluded: string[],
  negated: boolean,
  field: "space" | "folder" | "author" | "tag" | "site" | "domain",
  token: QueryToken,
  pills: QueryPill[],
): ParseTokenResult {
  const value = trimQuotes(rawValue);
  if (!value) return freeTextToken();
  addToIncludedOrExcluded(included, excluded, value, negated);
  addPill(pills, field, token, value, negated);
  return structuredToken();
}

function addToIncludedOrExcluded<Value>(
  included: Value[],
  excluded: Value[],
  value: Value,
  negated: boolean,
): void {
  if (negated) excluded.push(value);
  else included.push(value);
}

function isDateField(
  field: string,
): field is "date" | "created" | "updated" | "added" {
  return (
    field === "date" ||
    field === "created" ||
    field === "updated" ||
    field === "added"
  );
}

function applyDateFilter(
  filters: QueryFilters,
  field: "date" | "created" | "updated" | "added",
  range: { from?: number; to?: number },
): void {
  if (field === "updated") {
    filters.updatedFrom = range.from;
    filters.updatedTo = range.to;
    return;
  }
  filters.dateFrom = range.from;
  filters.dateTo = range.to;
  filters.createdFrom = range.from;
  filters.createdTo = range.to;
}

function parseSortDirective(
  rawValue: string,
  token: QueryToken,
  nextToken: QueryToken | undefined,
  directives: QueryDirectives,
  pills: QueryPill[],
): ParseTokenResult {
  let value = trimQuotes(rawValue).toLowerCase();
  let consumed = 1;
  if (
    nextToken &&
    !nextToken.text.includes(":") &&
    parseSortOrder(nextToken.normalized)
  ) {
    value = `${value} ${nextToken.normalized}`;
    consumed = 2;
  }

  const [rawSortBy = "", rawSortOrder = "desc"] = value
    .split(/\s+/)
    .filter(Boolean);
  const sortBy = parseSortBy(rawSortBy);
  if (!sortBy) return freeTextToken();
  const sortOrder = parseSortOrder(rawSortOrder) ?? "desc";
  directives.sortBy = sortBy;
  directives.sortOrder = sortOrder;

  const range =
    consumed === 2 && nextToken
      ? {
          start: token.start,
          end: nextToken.end,
          raw: `${token.text} ${nextToken.text}`,
        }
      : undefined;
  addPill(pills, "sort", token, `${sortBy} ${sortOrder}`, false, range);
  return { consumed, structured: true };
}

function parseSortBy(value: string): QuerySortBy | null {
  return SORT_OPTIONS.find((option) => option.input === value)?.value ?? null;
}

function parseSortOrder(value: string): QuerySortOrder | null {
  return SORT_ORDERS.find((order) => order === value) ?? null;
}

function structuredToken(): ParseTokenResult {
  return { consumed: 1, structured: true };
}

function freeTextToken(): ParseTokenResult {
  return { consumed: 1, structured: false };
}
