import type { QueryField } from "../contracts";
import { trimQuotes } from "./model";

export type DateRange = {
  from?: number;
  to?: number;
};

const DATE_FIELD_DISPLAY = new Map<QueryField, string>([
  ["date", "Added"],
  ["added", "Added"],
  ["created", "Added"],
  ["updated", "Updated"],
]);

const MONTHS = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
];

export function formatHumanDate(input: number | string | Date): string {
  const exactDate = /^\d{4}-\d{2}-\d{2}$/.test(String(input));
  const date =
    input instanceof Date
      ? new Date(input.getTime())
      : new Date(exactDate ? `${input}T00:00:00` : input);
  if (Number.isNaN(date.getTime())) return String(input);
  return `${ordinal(date.getDate())} ${MONTHS[date.getMonth()]} ${date.getFullYear()}`;
}

export function formatDatePillLabel(field: QueryField, value: string): string {
  return `${DATE_FIELD_DISPLAY.get(field) ?? "Date"} ${humanizeDateValue(value)}`;
}

export function parseRelativeDate(raw: string): DateRange | null {
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
    return {
      from: toStartOfDay(start).getTime(),
      to: toEndOfDay(now).getTime(),
    };
  }
  if (key === "last30d" || key === "last30days") {
    const start = new Date(now.getTime() - 29 * 24 * 60 * 60 * 1000);
    return {
      from: toStartOfDay(start).getTime(),
      to: toEndOfDay(now).getTime(),
    };
  }
  return null;
}

export function parseDateExpression(raw: string): DateRange | null {
  const value = trimQuotes(raw).toLowerCase();
  if (!value) return null;

  const relative = parseRelativeDate(value);
  if (relative) return relative;

  const namedOperator = value.match(/^(on|after|before|between):(.+)$/);
  if (namedOperator) {
    return parseNamedDateOperator(namedOperator[1], namedOperator[2]);
  }

  const between = value.split("..");
  if (between.length === 2) {
    const from = parseDateToMs(between[0], false);
    const to = parseDateToMs(between[1], true);
    return from !== undefined || to !== undefined ? { from, to } : null;
  }

  const comparator = value.match(/^(>=|<=|>|<)(\d{4}-\d{2}-\d{2})$/);
  if (comparator) {
    return parseDateComparator(comparator[1], comparator[2]);
  }

  const from = parseDateToMs(value, false);
  const to = parseDateToMs(value, true);
  return from !== undefined || to !== undefined ? { from, to } : null;
}

function parseNamedDateOperator(
  operator: string,
  rawDate: string,
): DateRange | null {
  if (operator === "between") {
    const [fromText, toText = ""] = rawDate.split("..");
    const from = parseDateToMs(fromText, false);
    const to = parseDateToMs(toText, true);
    return from !== undefined || to !== undefined ? { from, to } : null;
  }

  const from = parseDateToMs(rawDate, false);
  const to = parseDateToMs(rawDate, true);
  if (from === undefined || to === undefined) return null;
  if (operator === "after") return { from };
  if (operator === "before") return { to };
  return { from, to };
}

function parseDateComparator(
  operator: string,
  rawDate: string,
): DateRange | null {
  const from = parseDateToMs(rawDate, false);
  const to = parseDateToMs(rawDate, true);
  if (from === undefined || to === undefined) return null;
  if (operator === ">=") return { from };
  if (operator === ">") return { from: to + 1 };
  if (operator === "<=") return { to };
  if (operator === "<") return { to: from - 1 };
  return null;
}

function humanizeDateValue(value: string): string {
  const normalized = trimQuotes(value).toLowerCase();
  if (normalized === "today") return "today";
  if (normalized === "yesterday") return "yesterday";
  if (normalized === "last7d" || normalized === "last7days") {
    return "in the last 7 days";
  }
  if (normalized === "last30d" || normalized === "last30days") {
    return "in the last 30 days";
  }

  const namedOperator = normalized.match(/^(on|after|before|between):(.+)$/);
  if (namedOperator) {
    if (namedOperator[1] === "between") {
      const [from, to] = namedOperator[2].split("..");
      return `between ${formatHumanDate(from)} and ${formatHumanDate(to)}`;
    }
    return `${namedOperator[1]} ${formatHumanDate(namedOperator[2])}`;
  }

  const range = normalized.split("..");
  if (range.length === 2) {
    return `${formatHumanDate(range[0])} – ${formatHumanDate(range[1])}`;
  }

  const comparator = normalized.match(/^(>=|>|<=|<)(\d{4}-\d{2}-\d{2})$/);
  if (comparator) {
    const direction = comparator[1].startsWith(">") ? "after" : "before";
    return `${direction} ${formatHumanDate(comparator[2])}`;
  }
  if (/^\d{4}-\d{2}-\d{2}$/.test(normalized)) {
    return `on ${formatHumanDate(normalized)}`;
  }
  return value;
}

function parseDateToMs(value: string, endOfDay: boolean): number | undefined {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return undefined;
  const time = endOfDay ? "23:59:59.999" : "00:00:00.000";
  const milliseconds = new Date(`${value}T${time}`).getTime();
  return Number.isFinite(milliseconds) ? milliseconds : undefined;
}

function toStartOfDay(date: Date): Date {
  const clone = new Date(date);
  clone.setHours(0, 0, 0, 0);
  return clone;
}

function toEndOfDay(date: Date): Date {
  const clone = new Date(date);
  clone.setHours(23, 59, 59, 999);
  return clone;
}

function ordinal(value: number): string {
  const finalTwoDigits = value % 100;
  const suffixes = ["th", "st", "nd", "rd"];
  const suffix =
    finalTwoDigits >= 11 && finalTwoDigits <= 13
      ? "th"
      : (suffixes[value % 10] ?? "th");
  return `${value}${suffix}`;
}
