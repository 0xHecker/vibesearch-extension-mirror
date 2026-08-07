import { parseQueryMode, QUERY_MODE_DEFINITIONS, QUERY_MODES } from "./contracts";
import type {
  AnalyzeQueryInput,
  QueryAnalysis,
  QueryAssistCatalogs,
  QueryDirectives,
  QueryField,
  QueryMode,
  QueryFilters,
  QueryPill,
  QueryScope,
  QuerySortBy,
  QuerySortOrder,
  QuerySuggestion,
  QueryTextExpression,
  QueryToken,
} from "./contracts";
import type { ItemDocType } from "@src/schemas/item_schema";
import { MAX_GRID_QUERY_LIMIT } from "@src/search-core/pagination";

const FIELD_SET: Set<QueryField> = new Set([
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
]);

const SOURCE_SET: Set<ItemDocType["source"]> = new Set([
  "web",
  "twitter",
  "reddit",
  "note",
  "youtube",
  "instagram",
  "tiktok",
  "substack",
  "linkedin",
  "github",
  "article",
]);

const MEDIA_FILTERS: Array<"image" | "video" | "media" | "embed"> = ["image", "video", "embed", "media"];

const DEFAULT_FILTERS = (): QueryFilters => ({
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
});

const DEFAULT_DIRECTIVES = (): QueryDirectives => ({});

const trimQuotes = (value: string): string => {
  if (value.startsWith('"') && value.endsWith('"') && value.length >= 2) {
    return value.slice(1, -1);
  }
  return value;
};

const toStartOfDay = (date: Date) => {
  const clone = new Date(date);
  clone.setHours(0, 0, 0, 0);
  return clone;
};

const toEndOfDay = (date: Date) => {
  const clone = new Date(date);
  clone.setHours(23, 59, 59, 999);
  return clone;
};

const parseDateToMs = (value: string, endOfDay = false): number | undefined => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return undefined;
  const parsed = new Date(`${value}T${endOfDay ? "23:59:59.999" : "00:00:00.000"}`);
  const ms = parsed.getTime();
  return Number.isFinite(ms) ? ms : undefined;
};

const parseRelativeDate = (raw: string): { from?: number; to?: number } | null => {
  const now = new Date();
  const key = raw.toLowerCase();
  if (key === "today") {
    return { from: toStartOfDay(now).getTime(), to: toEndOfDay(now).getTime() };
  }
  if (key === "yesterday") {
    const day = new Date(now.getTime() - 24 * 60 * 60 * 1000);
    return { from: toStartOfDay(day).getTime(), to: toEndOfDay(day).getTime() };
  }
  if (key === "last7d" || key === "last7days") {
    const start = new Date(now.getTime() - 6 * 24 * 60 * 60 * 1000);
    return { from: toStartOfDay(start).getTime(), to: toEndOfDay(now).getTime() };
  }
  if (key === "last30d" || key === "last30days") {
    const start = new Date(now.getTime() - 29 * 24 * 60 * 60 * 1000);
    return { from: toStartOfDay(start).getTime(), to: toEndOfDay(now).getTime() };
  }
  return null;
};

const MONTHS = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

const ordinal = (n: number): string => {
  const v = n % 100;
  const suffix = v >= 11 && v <= 13 ? "th" : ["th", "st", "nd", "rd"][n % 10] || "th";
  return `${n}${suffix}`;
};

export const formatHumanDate = (input: number | string | Date): string => {
  const date =
    typeof input === "string"
      ? new Date(/^\d{4}-\d{2}-\d{2}$/.test(input) ? `${input}T00:00:00` : input)
      : new Date(input);
  if (Number.isNaN(date.getTime())) return String(input);
  return `${ordinal(date.getDate())} ${MONTHS[date.getMonth()]} ${date.getFullYear()}`;
};

const DATE_FIELD_DISPLAY: Record<string, string> = {
  date: "Added",
  added: "Added",
  created: "Added",
  updated: "Updated",
};

const humanizeDateValue = (value: string): string => {
  const v = trimQuotes(value).toLowerCase();
  if (v === "today") return "today";
  if (v === "yesterday") return "yesterday";
  if (v === "last7d" || v === "last7days") return "in the last 7 days";
  if (v === "last30d" || v === "last30days") return "in the last 30 days";
  const op = v.match(/^(on|after|before|between):(.+)$/);
  if (op) {
    if (op[1] === "between") {
      const [a, b] = op[2].split("..");
      return `between ${formatHumanDate(a)} and ${formatHumanDate(b)}`;
    }
    return `${op[1]} ${formatHumanDate(op[2])}`;
  }
  const range = v.split("..");
  if (range.length === 2) return `${formatHumanDate(range[0])} – ${formatHumanDate(range[1])}`;
  const cmp = v.match(/^(>=|>|<=|<)(\d{4}-\d{2}-\d{2})$/);
  if (cmp) return `${cmp[1].startsWith(">") ? "after" : "before"} ${formatHumanDate(cmp[2])}`;
  if (/^\d{4}-\d{2}-\d{2}$/.test(v)) return `on ${formatHumanDate(v)}`;
  return value;
};

const formatDatePillLabel = (field: string, value: string): string =>
  `${DATE_FIELD_DISPLAY[field] ?? "Date"} ${humanizeDateValue(value)}`;

const parseDateExpression = (raw: string): { from?: number; to?: number } | null => {
  const value = trimQuotes(raw).toLowerCase();
  if (!value) return null;

  const relative = parseRelativeDate(value);
  if (relative) return relative;

  const opPrefixed = value.match(/^(on|after|before|between):(.+)$/);
  if (opPrefixed) {
    const rest = opPrefixed[2];
    if (opPrefixed[1] === "between") {
      const [a, b] = rest.split("..");
      const fromMs = parseDateToMs(a, false);
      const toMs = parseDateToMs(b ?? "", true);
      if (fromMs !== undefined || toMs !== undefined) return { from: fromMs, to: toMs };
      return null;
    }
    const startMs = parseDateToMs(rest, false);
    const endMs = parseDateToMs(rest, true);
    if (startMs === undefined || endMs === undefined) return null;
    if (opPrefixed[1] === "after") return { from: startMs };
    if (opPrefixed[1] === "before") return { to: endMs };
    return { from: startMs, to: endMs };
  }

  const between = value.split("..");
  if (between.length === 2) {
    const fromMs = parseDateToMs(between[0], false);
    const toMs = parseDateToMs(between[1], true);
    if (fromMs !== undefined || toMs !== undefined) {
      return { from: fromMs, to: toMs };
    }
    return null;
  }

  const comparator = value.match(/^(>=|<=|>|<)(\d{4}-\d{2}-\d{2})$/);
  if (comparator) {
    const op = comparator[1];
    const dateText = comparator[2];
    const start = parseDateToMs(dateText, false);
    const end = parseDateToMs(dateText, true);
    if (start === undefined || end === undefined) return null;

    if (op === ">=") return { from: start };
    if (op === ">") return { from: end + 1 };
    if (op === "<=") return { to: end };
    if (op === "<") return { to: start - 1 };
  }

  const sameDayStart = parseDateToMs(value, false);
  const sameDayEnd = parseDateToMs(value, true);
  if (sameDayStart !== undefined || sameDayEnd !== undefined) {
    return { from: sameDayStart, to: sameDayEnd };
  }

  return null;
};

const parseNumericRange = (raw: string): { min?: number; max?: number } | null => {
  const value = trimQuotes(raw).trim();
  if (!value) return null;

  const asNumber = (input: string): number | null => {
    const num = Number.parseFloat(input);
    return Number.isFinite(num) ? num : null;
  };

  const between = value.match(/^(-?\d+(?:\.\d+)?)\.\.(-?\d+(?:\.\d+)?)$/);
  if (between) {
    const left = asNumber(between[1]);
    const right = asNumber(between[2]);
    if (left === null || right === null) return null;
    return {
      min: Math.min(left, right),
      max: Math.max(left, right),
    };
  }

  const comparator = value.match(/^(>=|<=|>|<)\s*(-?\d+(?:\.\d+)?)$/);
  if (comparator) {
    const op = comparator[1];
    const numberValue = asNumber(comparator[2]);
    if (numberValue === null) return null;
    if (op === ">=") return { min: numberValue };
    if (op === ">") return { min: numberValue + 1 };
    if (op === "<=") return { max: numberValue };
    if (op === "<") return { max: numberValue - 1 };
  }

  const exact = asNumber(value);
  if (exact !== null) {
    return { min: exact, max: exact };
  }

  return null;
};

const tokenize = (input: string): QueryToken[] => {
  const tokens: QueryToken[] = [];
  let index = 0;

  while (index < input.length) {
    while (index < input.length && /\s/.test(input[index])) {
      index += 1;
    }
    if (index >= input.length) break;

    const start = index;
    let inQuotes = false;
    while (index < input.length) {
      const char = input[index];
      if (char === '"') {
        inQuotes = !inQuotes;
        index += 1;
        continue;
      }
      if (!inQuotes && /\s/.test(char)) {
        break;
      }
      index += 1;
    }

    const text = input.slice(start, index);
    const end = start + text.length;
    tokens.push({
      text,
      normalized: trimQuotes(text).toLowerCase(),
      start,
      end,
    });
  }
  return tokens;
};

export const removePillRangesFromQuery = (
  input: string,
  pills: readonly Pick<QueryPill, "start" | "end">[]
): string => {
  if (pills.length === 0) return input.replace(/\s{2,}/g, " ").trim();
  const ranges = [...pills]
    .map((pill) => ({
      start: Math.max(0, Math.min(input.length, pill.start)),
      end: Math.max(0, Math.min(input.length, pill.end)),
    }))
    .filter((range) => range.end > range.start)
    .sort((left, right) => left.start - right.start);

  const chunks: string[] = [];
  let cursor = 0;
  for (const range of ranges) {
    if (range.start > cursor) chunks.push(input.slice(cursor, range.start));
    cursor = Math.max(cursor, range.end);
  }
  if (cursor < input.length) chunks.push(input.slice(cursor));
  return chunks.join(" ").replace(/\s{2,}/g, " ").trim();
};

const resolveActiveToken = (
  input: string,
  cursor: number,
  tokens: QueryToken[]
): { start: number; end: number; text: string } => {
  const safeCursor = Math.max(0, Math.min(cursor, input.length));

  for (const token of tokens) {
    if (safeCursor >= token.start && safeCursor <= token.end) {
      return { start: token.start, end: token.end, text: token.text };
    }
  }

  let left = safeCursor;
  while (left > 0 && !/\s/.test(input[left - 1])) {
    left -= 1;
  }
  let right = safeCursor;
  while (right < input.length && !/\s/.test(input[right])) {
    right += 1;
  }

  return { start: left, end: right, text: input.slice(left, right) };
};

const addPill = (
  pills: QueryPill[],
  field: QueryField,
  token: QueryToken,
  value: string,
  negated: boolean,
  range?: {
    start: number;
    end: number;
    raw: string;
  },
  labelOverride?: string
) => {
  const displayValue = trimQuotes(value);
  if (!displayValue) return;
  const start = range?.start ?? token.start;
  const end = range?.end ?? token.end;
  const raw = range?.raw ?? token.text;
  pills.push({
    id: `${field}:${start}:${end}`,
    kind:
      field === "sort" || field === "mode" || field === "scope" || field === "limit" || field === "page" || field === "minscore" || field === "score"
        ? "directive"
        : "filter",
    field,
    value: displayValue,
    label: labelOverride ?? `${field}: ${displayValue}`,
    raw,
    negated,
    start,
    end,
  });
};

type ParseTokenResult = {
  consumed: number;
  structured: boolean;
};

const parseTokenIntoState = (
  token: QueryToken,
  nextToken: QueryToken | undefined,
  filters: QueryFilters,
  directives: QueryDirectives,
  pills: QueryPill[]
): ParseTokenResult => {
  const tokenText = token.text;
  const isNegated = tokenText.startsWith("-");
  const withoutNegation = isNegated ? tokenText.slice(1) : tokenText;
  const shorthandScope = withoutNegation.startsWith("/") ? withoutNegation.slice(1).toLowerCase() : "";
  const validScopes: QueryScope[] = ["current", "global", "private", "public"];
  if (shorthandScope && validScopes.includes(shorthandScope as QueryScope)) {
    directives.scope = shorthandScope as QueryScope;
    addPill(pills, "scope", token, shorthandScope, false);
    return { consumed: 1, structured: true };
  }

  const fieldSep = withoutNegation.indexOf(":");
  if (fieldSep <= 0) {
    return { consumed: 1, structured: false };
  }

  const field = withoutNegation.slice(0, fieldSep).toLowerCase() as QueryField;
  const rawValue = withoutNegation.slice(fieldSep + 1);
  if (!FIELD_SET.has(field) || !rawValue) {
    return { consumed: 1, structured: false };
  }

  if (field === "source") {
    const value = trimQuotes(rawValue).toLowerCase() as ItemDocType["source"];
    if (SOURCE_SET.has(value)) {
      if (isNegated) {
        filters.excludeSources.push(value);
      } else {
        filters.sources.push(value);
      }
      addPill(pills, field, token, value, isNegated);
      return { consumed: 1, structured: true };
    }
  }

  if (field === "space") {
    const value = trimQuotes(rawValue);
    if (value) {
      if (isNegated) {
        filters.excludeSpaceIds.push(value);
      } else {
        filters.spaceIds.push(value);
      }
      addPill(pills, field, token, value, isNegated);
      return { consumed: 1, structured: true };
    }
  }

  if (field === "folder") {
    const value = trimQuotes(rawValue);
    if (value) {
      if (isNegated) {
        filters.excludeFolderIds.push(value);
      } else {
        filters.folderIds.push(value);
      }
      addPill(pills, field, token, value, isNegated);
      return { consumed: 1, structured: true };
    }
  }

  if (field === "author") {
    const value = trimQuotes(rawValue).toLowerCase();
    if (value) {
      if (isNegated) {
        filters.excludeAuthors.push(value);
      } else {
        filters.authors.push(value);
      }
      addPill(pills, field, token, value, isNegated);
      return { consumed: 1, structured: true };
    }
  }

  if (field === "tag") {
    const value = trimQuotes(rawValue).toLowerCase();
    if (value) {
      if (isNegated) {
        filters.excludeTagNames.push(value);
      } else {
        filters.tagNames.push(value);
      }
      addPill(pills, field, token, value, isNegated);
      return { consumed: 1, structured: true };
    }
  }

  if (field === "site" || field === "domain") {
    const value = trimQuotes(rawValue).toLowerCase();
    if (value) {
      if (isNegated) {
        filters.excludeDomains.push(value);
      } else {
        filters.domains.push(value);
      }
      addPill(pills, field, token, value, isNegated);
      return { consumed: 1, structured: true };
    }
  }

  if (field === "is") {
    const value = trimQuotes(rawValue).toLowerCase();
    if (value === "favorite" && !isNegated) {
      filters.favoritesOnly = true;
      addPill(pills, field, token, "favorite", false);
      return { consumed: 1, structured: true };
    }
  }

  if (field === "has") {
    const value = trimQuotes(rawValue).toLowerCase() as "image" | "video" | "media" | "embed";
    if (MEDIA_FILTERS.includes(value)) {
      if (isNegated) {
        filters.excludeHasAny.push(value);
      } else {
        filters.hasAny.push(value);
      }
      addPill(pills, field, token, value, isNegated);
      return { consumed: 1, structured: true };
    }
  }

  if (field === "date" || field === "created" || field === "updated" || field === "added") {
    const parsed = parseDateExpression(rawValue);
    if (parsed) {
      if (field === "updated") {
        filters.updatedFrom = parsed.from;
        filters.updatedTo = parsed.to;
      } else {
        filters.dateFrom = parsed.from;
        filters.dateTo = parsed.to;
        filters.createdFrom = parsed.from;
        filters.createdTo = parsed.to;
      }
      addPill(
        pills,
        field,
        token,
        trimQuotes(rawValue),
        false,
        undefined,
        formatDatePillLabel(field, trimQuotes(rawValue))
      );
      return { consumed: 1, structured: true };
    }
  }

  if (field === "likes" || field === "upvotes") {
    const parsed = parseNumericRange(rawValue);
    if (parsed) {
      if (field === "likes") {
        filters.likesMin = parsed.min;
        filters.likesMax = parsed.max;
      } else {
        filters.upvotesMin = parsed.min;
        filters.upvotesMax = parsed.max;
      }
      addPill(pills, field, token, trimQuotes(rawValue), false);
      return { consumed: 1, structured: true };
    }
  }

  if (field === "sort") {
    let value = trimQuotes(rawValue).toLowerCase();
    let consumed = 1;
    if (
      nextToken &&
      !nextToken.text.includes(":") &&
      (nextToken.normalized === "asc" || nextToken.normalized === "desc")
    ) {
      value = `${value} ${nextToken.normalized}`;
      consumed = 2;
    }
    const parts = value.split(/\s+/).filter(Boolean);
    const sortBy = parts[0] as QuerySortBy | undefined;
    const sortOrder = (parts[1] as QuerySortOrder | undefined) ?? "desc";
    const validSortBy: QuerySortBy[] = ["relevance", "createdAt", "updatedAt", "title", "source"];
    const validSortOrder: QuerySortOrder[] = ["asc", "desc"];
    if (sortBy && validSortBy.includes(sortBy)) {
      directives.sortBy = sortBy;
      directives.sortOrder = validSortOrder.includes(sortOrder) ? sortOrder : "desc";
      addPill(
        pills,
        field,
        token,
        `${directives.sortBy} ${directives.sortOrder}`,
        false,
        consumed === 2 && nextToken
          ? {
              start: token.start,
              end: nextToken.end,
              raw: `${token.text} ${nextToken.text}`,
            }
          : undefined
      );
      return { consumed, structured: true };
    }
  }

  if (field === "scope") {
    const value = trimQuotes(rawValue).toLowerCase() as QueryScope;
    const valid: QueryScope[] = ["current", "global", "private", "public"];
    if (valid.includes(value)) {
      directives.scope = value;
      addPill(pills, field, token, value, false);
      return { consumed: 1, structured: true };
    }
  }

  if (field === "mode") {
    const value = trimQuotes(rawValue).toLowerCase();
    const parsedMode = parseQueryMode(value);
    if (parsedMode) {
      directives.mode = parsedMode;
      addPill(pills, field, token, parsedMode, false);
      return { consumed: 1, structured: true };
    }
  }

  if (field === "limit") {
    const value = Number.parseInt(trimQuotes(rawValue), 10);
    if (Number.isFinite(value) && value > 0) {
      directives.limit = Math.min(MAX_GRID_QUERY_LIMIT, value);
      addPill(pills, field, token, String(directives.limit), false);
      return { consumed: 1, structured: true };
    }
  }

  if (field === "page") {
    const value = Number.parseInt(trimQuotes(rawValue), 10);
    if (Number.isFinite(value) && value > 0) {
      directives.page = value;
      addPill(pills, field, token, String(value), false);
      return { consumed: 1, structured: true };
    }
  }

  if (field === "minscore" || field === "score") {
    const value = Number.parseFloat(trimQuotes(rawValue));
    if (Number.isFinite(value)) {
      const clamped = Math.max(0, Math.min(1, value));
      directives.minScore = clamped;
      addPill(pills, field, token, String(clamped), false);
      return { consumed: 1, structured: true };
    }
  }

  return { consumed: 1, structured: false };
};

const pushSuggestions = (
  suggestions: QuerySuggestion[],
  list: Array<Omit<QuerySuggestion, "start" | "end">>,
  start: number,
  end: number
) => {
  for (const item of list) {
    suggestions.push({ ...item, start, end });
  }
};

const buildSuggestions = (
  activeTokenText: string,
  activeStart: number,
  activeEnd: number,
  catalogs: QueryAssistCatalogs,
  forceSuggestions: boolean
): { shouldOpen: boolean; suggestions: QuerySuggestion[] } => {
  const token = activeTokenText.trim();
  const lower = token.toLowerCase();
  const suggestions: QuerySuggestion[] = [];
  const showAssist =
    forceSuggestions ||
    token.startsWith(":") ||
    token.startsWith("/") ||
    /^-?[a-z]+:/.test(token);

  if (!showAssist) {
    return { shouldOpen: false, suggestions: [] };
  }

  const fieldMatch = lower.match(/^(-?)([a-z]+):(.*)$/);
  if (fieldMatch) {
    const negation = fieldMatch[1] || "";
    const field = fieldMatch[2] as QueryField;
    const valuePart = fieldMatch[3] ?? "";

    if (field === "source") {
      const options = catalogs.sources
        .filter((source) => source.includes(valuePart as ItemDocType["source"]))
        .slice(0, 8)
        .map((source) => ({
          id: `source:${source}`,
          category: "Sources" as const,
          label: `source:${source}`,
          description: "Filter by source",
          insertText: `${negation}source:${source}`,
        }));
      pushSuggestions(suggestions, options, activeStart, activeEnd);
    }

    if (field === "space") {
      const options = catalogs.spaces
        .filter((space) => space.name.toLowerCase().includes(valuePart.toLowerCase()))
        .slice(0, 8)
        .map((space) => ({
          id: `space:${space.id}`,
          category: "Spaces" as const,
          label: `space:${space.name}`,
          description: space.isPrivate ? "Private space" : "Filter by space",
          insertText: /\s/.test(space.name)
            ? `${negation}space:"${space.name}"`
            : `${negation}space:${space.name}`,
        }));
      pushSuggestions(suggestions, options, activeStart, activeEnd);
    }

    if (field === "mode") {
      const options = QUERY_MODES as readonly QueryMode[];
      const items = options
        .filter((mode) => mode.includes(valuePart.toLowerCase()))
        .map((mode) => ({
          id: `mode:${mode}`,
          category: "Modes" as const,
          label: `mode:${mode}`,
          description: QUERY_MODE_DEFINITIONS[mode].description,
          insertText: `mode:${mode}`,
        }));
      pushSuggestions(suggestions, items, activeStart, activeEnd);
    }

    if (field === "scope") {
      const items: QueryScope[] = ["current", "global", "private", "public"];
      const scoped = items
        .filter((scope) => scope.includes(valuePart))
        .map((scope) => ({
          id: `scope:${scope}`,
          category: "Refine" as const,
          label: `scope:${scope}`,
          description:
            scope === "global"
              ? "Search across all spaces"
              : scope === "private"
                ? "Search private space only"
                : scope === "public"
                  ? "Search all public spaces"
                  : "Search current space",
          insertText: `scope:${scope}`,
        }));
      pushSuggestions(suggestions, scoped, activeStart, activeEnd);
    }

    if (field === "sort") {
      const sortItems = ["relevance desc", "createdAt desc", "updatedAt desc", "title asc", "source asc"]
        .filter((sort) => sort.includes(valuePart))
        .map((sort) => ({
          id: `sort:${sort}`,
          category: "Sort" as const,
          label: `sort:${sort}`,
          description: "Sort order",
          insertText: `sort:${sort}`,
        }));
      pushSuggestions(suggestions, sortItems, activeStart, activeEnd);
    }

    if (field === "folder") {
      const items = catalogs.folders
        .filter((folder) => folder.name.toLowerCase().includes(valuePart.toLowerCase()))
        .slice(0, 8)
        .map((folder) => ({
          id: `folder:${folder.id}`,
          category: "Folders" as const,
          label: `folder:${folder.name}`,
          description: "Filter by folder",
          insertText: `${negation}folder:"${folder.name}"`,
        }));
      pushSuggestions(suggestions, items, activeStart, activeEnd);
    }

    if (field === "author") {
      const items = catalogs.authors
        .filter((author) => author.includes(valuePart.toLowerCase()))
        .slice(0, 8)
        .map((author) => ({
          id: `author:${author}`,
          category: "Refine" as const,
          label: `author:${author}`,
          description: "Filter by author",
          insertText: `${negation}author:${author}`,
        }));
      pushSuggestions(suggestions, items, activeStart, activeEnd);
    }

    if (field === "tag") {
      const items = catalogs.tags
        .filter((tag) => tag.name.toLowerCase().includes(valuePart.toLowerCase()))
        .slice(0, 10)
        .map((tag) => ({
          id: `tag:${tag.id}`,
          category: "Tags" as const,
          label: `tag:${tag.name}`,
          description: "Filter by tag",
          insertText: /\s/.test(tag.name) ? `${negation}tag:"${tag.name}"` : `${negation}tag:${tag.name}`,
        }));
      pushSuggestions(suggestions, items, activeStart, activeEnd);
    }

    if (field === "site" || field === "domain") {
      const items = catalogs.domains
        .filter((domain) => domain.includes(valuePart.toLowerCase()))
        .slice(0, 10)
        .map((domain) => ({
          id: `site:${domain}`,
          category: "Domains" as const,
          label: `site:${domain}`,
          description: "Filter by domain",
          insertText: `${negation}site:${domain}`,
        }));
      pushSuggestions(suggestions, items, activeStart, activeEnd);
    }

    if (field === "is") {
      pushSuggestions(
        suggestions,
        [
          {
            id: "is:favorite",
            category: "Refine",
            label: "is:favorite",
            description: "Favorites only",
            insertText: "is:favorite",
          },
        ],
        activeStart,
        activeEnd
      );
    }

    if (field === "has") {
      const hasRows = MEDIA_FILTERS.filter((entry) => entry.includes(valuePart)).map((entry) => ({
        id: `has:${entry}`,
        category: "Refine" as const,
        label: `has:${entry}`,
        description: "Media presence filter",
        insertText: `${negation}has:${entry}`,
      }));
      pushSuggestions(suggestions, hasRows, activeStart, activeEnd);
    }

    if (field === "date" || field === "created" || field === "updated" || field === "added") {
      const operatorChosen = /^(on|after|before|between):/.test(valuePart);
      if (!operatorChosen) {
        const q = valuePart.toLowerCase();
        const operatorRows = [
          { op: "on", description: "On a specific day" },
          { op: "after", description: "On or after a chosen date" },
          { op: "before", description: "On or before a chosen date" },
          { op: "between", description: "Within a start and end date" },
        ]
          .filter((row) => row.op.startsWith(q))
          .map((row) => ({
            id: `${field}:${row.op}`,
            category: "Dates" as const,
            label: `${field}:${row.op}`,
            description: row.description,
            insertText: `${field}:${row.op}:`,
          }));

        const presetRows = [
          { key: "today", label: "Today" },
          { key: "yesterday", label: "Yesterday" },
          { key: "last7d", label: "Last 7 days" },
          { key: "last30d", label: "Last 30 days" },
        ]
          .filter((row) => row.label.toLowerCase().includes(q) || row.key.includes(q))
          .map((row) => {
            const range = parseRelativeDate(row.key);
            return {
              id: `${field}:${row.key}`,
              category: "Dates" as const,
              label: row.label,
              description:
                range?.from && range?.to
                  ? `${formatHumanDate(range.from)} – ${formatHumanDate(range.to)}`
                  : "Quick range",
              insertText: `${field}:${row.key}`,
            };
          });

        pushSuggestions(suggestions, [...operatorRows, ...presetRows], activeStart, activeEnd);
      }
    }

    if (field === "likes" || field === "upvotes") {
      pushSuggestions(
        suggestions,
        [
          {
            id: `${field}:gte`,
            category: "Refine",
            label: `${field}:>=10`,
            description: "Minimum value",
            insertText: `${field}:>=10`,
          },
          {
            id: `${field}:between`,
            category: "Refine",
            label: `${field}:10..100`,
            description: "Range",
            insertText: `${field}:10..100`,
          },
        ],
        activeStart,
        activeEnd
      );
    }
  } else {
    const helperRows: Array<Omit<QuerySuggestion, "start" | "end">> = [
      {
        id: "field:space",
        category: "Refine",
        label: "space:",
        description: "Filter by space",
        insertText: "space:",
      },
      {
        id: "field:source",
        category: "Refine",
        label: "source:",
        description: "Filter by source",
        insertText: "source:",
      },
      {
        id: "field:folder",
        category: "Refine",
        label: "folder:",
        description: "Filter by folder",
        insertText: "folder:",
      },
      {
        id: "field:tag",
        category: "Refine",
        label: "tag:",
        description: "Filter by tag",
        insertText: "tag:",
      },
      {
        id: "field:site",
        category: "Refine",
        label: "site:",
        description: "Filter by domain",
        insertText: "site:",
      },
      {
        id: "field:author",
        category: "Refine",
        label: "author:",
        description: "Filter by author",
        insertText: "author:",
      },
      {
        id: "field:has",
        category: "Refine",
        label: "has:image",
        description: "Filter media presence",
        insertText: "has:image",
      },
      {
        id: "field:date",
        category: "Dates",
        label: "date:",
        description: "Filter by date added",
        insertText: "date:",
      },
      {
        id: "field:added",
        category: "Dates",
        label: "added:",
        description: "Filter by date added",
        insertText: "added:",
      },
      {
        id: "field:updated",
        category: "Dates",
        label: "updated:",
        description: "Filter by date updated",
        insertText: "updated:",
      },
      {
        id: "directive:scope",
        category: "Refine",
        label: "scope:global",
        description: "Search all spaces",
        insertText: "scope:global",
      },
      {
        id: "directive:mode",
        category: "Modes",
        label: "mode:keyword+vector",
        description: "Keyword + vector semantic",
        insertText: "mode:keyword+vector",
      },
      {
        id: "directive:sort",
        category: "Sort",
        label: "sort:updatedAt desc",
        description: "Newest updated first",
        insertText: "sort:updatedAt desc",
      },
      {
        id: "helper:or",
        category: "Helpers",
        label: "OR",
        description: "Boolean OR",
        insertText: "OR",
      },
      {
        id: "helper:not",
        category: "Helpers",
        label: "-source:twitter",
        description: "Exclude source",
        insertText: "-source:twitter",
      },
    ];

    const fieldQuery = lower.replace(/^-?[:/]/, "");
    pushSuggestions(
      suggestions,
      fieldQuery
        ? helperRows.filter((row) => row.label.toLowerCase().startsWith(fieldQuery))
        : helperRows,
      activeStart,
      activeEnd
    );

    const recent = catalogs.recentQueries
      .filter((query) => query.toLowerCase().includes(lower.replace(/^[:/]/, "")))
      .slice(0, 5)
      .map((query) => ({
        id: `recent:${query}`,
        category: "Recent" as const,
        label: query,
        description: "Recent query",
        insertText: query,
      }));
    pushSuggestions(suggestions, recent, activeStart, activeEnd);
  }

  return {
    shouldOpen: forceSuggestions || suggestions.length > 0,
    suggestions,
  };
};

type ExpressionToken =
  | { type: "TERM"; value: string }
  | { type: "AND" | "OR" | "NOT" | "LPAREN" | "RPAREN" };

const tokenizeExpression = (freeTokens: string[]): ExpressionToken[] => {
  const input = freeTokens.join(" ");
  const tokens: ExpressionToken[] = [];
  let index = 0;

  const pushTerm = (raw: string) => {
    const trimmed = trimQuotes(raw).trim();
    if (!trimmed) return;
    const upper = trimmed.toUpperCase();
    if (upper === "OR") {
      tokens.push({ type: "OR" });
      return;
    }
    if (upper === "AND") {
      tokens.push({ type: "AND" });
      return;
    }
    if (upper === "NOT") {
      tokens.push({ type: "NOT" });
      return;
    }
    if (trimmed.startsWith("-") && trimmed.length > 1) {
      const term = trimQuotes(trimmed.slice(1)).trim();
      if (term) {
        tokens.push({ type: "NOT" });
        tokens.push({ type: "TERM", value: term });
      }
      return;
    }
    tokens.push({ type: "TERM", value: trimmed });
  };

  while (index < input.length) {
    const char = input[index];
    if (/\s/.test(char)) {
      index += 1;
      continue;
    }

    if (char === "(") {
      tokens.push({ type: "LPAREN" });
      index += 1;
      continue;
    }
    if (char === ")") {
      tokens.push({ type: "RPAREN" });
      index += 1;
      continue;
    }

    if (char === "|" || char === "&") {
      const isOr = char === "|";
      const operatorType = isOr ? "OR" : "AND";
      if (input[index + 1] === char) {
        tokens.push({ type: operatorType });
        index += 2;
      } else {
        tokens.push({ type: operatorType });
        index += 1;
      }
      continue;
    }

    if (char === '"') {
      let end = index + 1;
      while (end < input.length && input[end] !== '"') {
        end += 1;
      }
      const raw = input.slice(index + 1, end);
      pushTerm(raw);
      index = end < input.length ? end + 1 : end;
      continue;
    }

    let end = index;
    let inQuotes = false;
    while (end < input.length) {
      const current = input[end];
      if (current === '"') {
        inQuotes = !inQuotes;
        end += 1;
        continue;
      }
      if (!inQuotes && (/\s/.test(current) || current === "(" || current === ")")) {
        break;
      }
      end += 1;
    }
    pushTerm(input.slice(index, end));
    index = end;
  }

  return tokens;
};

const mergeExpressionNode = (
  type: "AND" | "OR",
  left: QueryTextExpression,
  right: QueryTextExpression
): QueryTextExpression => {
  const children: QueryTextExpression[] = [];
  if (left.type === type) {
    children.push(...left.children);
  } else {
    children.push(left);
  }
  if (right.type === type) {
    children.push(...right.children);
  } else {
    children.push(right);
  }
  return { type, children };
};

const parseExpressionAst = (freeTokens: string[]): QueryTextExpression | undefined => {
  if (freeTokens.length === 0) return undefined;
  const hasExplicitBooleanSyntax = freeTokens.some((token) => {
    const normalized = trimQuotes(token).trim();
    if (!normalized) return false;
    const upper = normalized.toUpperCase();
    return (
      upper === "AND" ||
      upper === "OR" ||
      upper === "NOT" ||
      normalized === "(" ||
      normalized === ")" ||
      normalized.includes("(") ||
      normalized.includes(")") ||
      normalized === "||" ||
      normalized === "|" ||
      normalized === "&&" ||
      normalized === "&" ||
      normalized.startsWith("-")
    );
  });
  if (!hasExplicitBooleanSyntax) return undefined;

  const tokens = tokenizeExpression(freeTokens);
  if (tokens.length === 0) return undefined;

  let cursor = 0;

  const peek = (): ExpressionToken | undefined => tokens[cursor];
  const consume = (): ExpressionToken | undefined => {
    const token = tokens[cursor];
    cursor += 1;
    return token;
  };

  const parsePrimary = (): QueryTextExpression | undefined => {
    const token = peek();
    if (!token) return undefined;

    if (token.type === "LPAREN") {
      consume();
      const inner = parseOr();
      if (peek()?.type === "RPAREN") {
        consume();
      }
      return inner;
    }

    if (token.type === "TERM") {
      consume();
      return { type: "TERM", value: token.value };
    }

    return undefined;
  };

  const parseUnary = (): QueryTextExpression | undefined => {
    const token = peek();
    if (!token) return undefined;

    if (token.type === "NOT") {
      consume();
      const child = parseUnary();
      if (!child) return undefined;
      return { type: "NOT", child };
    }

    return parsePrimary();
  };

  const parseAnd = (): QueryTextExpression | undefined => {
    let left = parseUnary();
    if (!left) return undefined;

    while (true) {
      const next = peek();
      if (!next || next.type === "RPAREN" || next.type === "OR") {
        break;
      }

      if (next.type === "AND") {
        consume();
      }

      const right = parseUnary();
      if (!right) break;
      left = mergeExpressionNode("AND", left, right);
    }

    return left;
  };

  const parseOr = (): QueryTextExpression | undefined => {
    let left = parseAnd();
    if (!left) return undefined;

    while (peek()?.type === "OR") {
      consume();
      const right = parseAnd();
      if (!right) break;
      left = mergeExpressionNode("OR", left, right);
    }

    return left;
  };

  return parseOr();
};

const parseFreeTextExpression = (
  freeTokens: string[]
): { groups: string[][]; excludedTerms: string[]; flatTerms: string[] } => {
  const groups: string[][] = [];
  const excludedTerms: string[] = [];
  let negateNext = false;
  let pendingOperator: "AND" | "OR" | null = null;

  for (const raw of freeTokens) {
    const normalized = trimQuotes(raw).trim();
    if (!normalized) continue;

    const upper = normalized.toUpperCase();
    if (upper === "OR" || normalized === "|" || normalized === "||") {
      pendingOperator = "OR";
      negateNext = false;
      continue;
    }
    if (upper === "AND" || normalized === "&&" || normalized === "&") {
      pendingOperator = "AND";
      continue;
    }
    if (upper === "NOT") {
      negateNext = true;
      continue;
    }

    const unaryNegated = normalized.startsWith("-");
    const value = unaryNegated ? trimQuotes(normalized.slice(1)).trim() : normalized;
    if (!value) {
      negateNext = false;
      continue;
    }

    if (negateNext || unaryNegated) {
      excludedTerms.push(value);
    } else {
      if (pendingOperator === "AND" && groups.length > 0) {
        groups[groups.length - 1].push(value);
      } else {
        groups.push([value]);
      }
    }
    pendingOperator = null;
    negateNext = false;
  }

  const compactGroups = groups.filter((group) => group.length > 0);
  const flatTerms: string[] = [];
  for (const group of compactGroups) {
    for (const term of group) {
      if (!flatTerms.includes(term)) {
        flatTerms.push(term);
      }
    }
  }

  return {
    groups: compactGroups,
    excludedTerms: Array.from(new Set(excludedTerms)),
    flatTerms,
  };
};

export const analyzeQuery = (request: AnalyzeQueryInput): QueryAnalysis => {
  const input = request.input || "";
  const cursor = Number.isFinite(request.cursor) ? request.cursor : input.length;
  const tokens = tokenize(input);
  const active = resolveActiveToken(input, cursor, tokens);

  const filters = DEFAULT_FILTERS();
  const directives = DEFAULT_DIRECTIVES();
  const pills: QueryPill[] = [];
  const freeTokens: string[] = [];

  for (let i = 0; i < tokens.length; ) {
    const result = parseTokenIntoState(tokens[i], tokens[i + 1], filters, directives, pills);
    if (!result.structured) {
      freeTokens.push(tokens[i].text);
    }
    i += result.consumed;
  }

  const expression = parseFreeTextExpression(freeTokens);
  const ast = parseExpressionAst(freeTokens);

  const unique = <T,>(values: T[]) => Array.from(new Set(values));
  filters.spaceIds = unique(filters.spaceIds);
  filters.excludeSpaceIds = unique(filters.excludeSpaceIds);
  filters.sources = unique(filters.sources);
  filters.excludeSources = unique(filters.excludeSources);
  filters.folderIds = unique(filters.folderIds);
  filters.excludeFolderIds = unique(filters.excludeFolderIds);
  filters.tagNames = unique(filters.tagNames);
  filters.excludeTagNames = unique(filters.excludeTagNames);
  filters.domains = unique(filters.domains);
  filters.excludeDomains = unique(filters.excludeDomains);
  filters.authors = unique(filters.authors);
  filters.excludeAuthors = unique(filters.excludeAuthors);
  filters.hasAny = unique(filters.hasAny);
  filters.excludeHasAny = unique(filters.excludeHasAny);

  const { shouldOpen, suggestions } = buildSuggestions(
    active.text,
    active.start,
    active.end,
    request.catalogs,
    request.forceSuggestions === true
  );

  return {
    requestId: request.requestId,
    input,
    freeText: expression.flatTerms.join(" ").trim(),
    textGroups: expression.groups,
    excludedTerms: expression.excludedTerms,
    textExpression: ast,
    tokens,
    pills,
    filters,
    directives,
    activeTokenStart: active.start,
    activeTokenEnd: active.end,
    activeTokenText: active.text,
    shouldOpenSuggestions: shouldOpen,
    suggestions,
  };
};
