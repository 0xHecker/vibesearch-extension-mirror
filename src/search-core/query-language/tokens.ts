import type { QueryField, QueryPill, QueryToken } from "../contracts";
import { trimQuotes } from "./model";

type ActiveToken = {
  start: number;
  end: number;
  text: string;
};

type PillRange = {
  start: number;
  end: number;
  raw: string;
};

const DIRECTIVE_FIELDS = new Set<QueryField>([
  "sort",
  "mode",
  "scope",
  "limit",
  "page",
  "minscore",
  "score",
]);

export function tokenizeQuery(input: string): QueryToken[] {
  const tokens: QueryToken[] = [];
  let index = 0;

  while (index < input.length) {
    while (index < input.length && /\s/.test(input[index])) index += 1;
    if (index >= input.length) break;

    const start = index;
    let inQuotes = false;
    while (index < input.length) {
      const character = input[index];
      if (character === '"') {
        inQuotes = !inQuotes;
        index += 1;
        continue;
      }
      if (!inQuotes && /\s/.test(character)) break;
      index += 1;
    }

    const text = input.slice(start, index);
    tokens.push({
      text,
      normalized: trimQuotes(text).toLowerCase(),
      start,
      end: start + text.length,
    });
  }
  return tokens;
}

export function removePillRangesFromQuery(
  input: string,
  pills: readonly Pick<QueryPill, "start" | "end">[],
): string {
  if (pills.length === 0) return normalizeSpaces(input);
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
  return normalizeSpaces(chunks.join(" "));
}

export function resolveActiveToken(
  input: string,
  cursor: number,
  tokens: QueryToken[],
): ActiveToken {
  const safeCursor = Math.max(0, Math.min(cursor, input.length));
  const containingToken = tokens.find(
    (token) => safeCursor >= token.start && safeCursor <= token.end,
  );
  if (containingToken) {
    return {
      start: containingToken.start,
      end: containingToken.end,
      text: containingToken.text,
    };
  }

  let start = safeCursor;
  while (start > 0 && !/\s/.test(input[start - 1])) start -= 1;
  let end = safeCursor;
  while (end < input.length && !/\s/.test(input[end])) end += 1;
  return { start, end, text: input.slice(start, end) };
}

export function addPill(
  pills: QueryPill[],
  field: QueryField,
  token: QueryToken,
  value: string,
  negated: boolean,
  range?: PillRange,
  labelOverride?: string,
): void {
  const displayValue = trimQuotes(value);
  if (!displayValue) return;
  const start = range?.start ?? token.start;
  const end = range?.end ?? token.end;
  pills.push({
    id: `${field}:${start}:${end}`,
    kind: DIRECTIVE_FIELDS.has(field) ? "directive" : "filter",
    field,
    value: displayValue,
    label: labelOverride ?? `${field}: ${displayValue}`,
    raw: range?.raw ?? token.text,
    negated,
    start,
    end,
  });
}

function normalizeSpaces(value: string): string {
  return value.replace(/\s{2,}/g, " ").trim();
}
