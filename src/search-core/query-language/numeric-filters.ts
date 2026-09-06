import { trimQuotes } from "./model";

export type NumericRange = {
  min?: number;
  max?: number;
};

export function parseNumericRange(raw: string): NumericRange | null {
  const value = trimQuotes(raw).trim();
  if (!value) return null;

  const between = value.match(/^(-?\d+(?:\.\d+)?)\.\.(-?\d+(?:\.\d+)?)$/);
  if (between) {
    const left = parseFiniteNumber(between[1]);
    const right = parseFiniteNumber(between[2]);
    if (left === null || right === null) return null;
    return { min: Math.min(left, right), max: Math.max(left, right) };
  }

  const comparator = value.match(/^(>=|<=|>|<)\s*(-?\d+(?:\.\d+)?)$/);
  if (comparator) {
    return parseComparator(comparator[1], comparator[2]);
  }

  const exact = parseFiniteNumber(value);
  return exact === null ? null : { min: exact, max: exact };
}

function parseComparator(
  operator: string,
  rawValue: string,
): NumericRange | null {
  const value = parseFiniteNumber(rawValue);
  if (value === null) return null;
  if (operator === ">=") return { min: value };
  if (operator === ">") return { min: value + 1 };
  if (operator === "<=") return { max: value };
  if (operator === "<") return { max: value - 1 };
  return null;
}

function parseFiniteNumber(input: string): number | null {
  const value = Number.parseFloat(input);
  return Number.isFinite(value) ? value : null;
}
