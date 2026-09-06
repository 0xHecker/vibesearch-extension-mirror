import type { QueryTextExpression } from "../contracts";
import { trimQuotes } from "./model";

type FreeTextParseResult = {
  groups: string[][];
  excludedTerms: string[];
  flatTerms: string[];
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
      if (
        !inQuotes &&
        (/\s/.test(current) || current === "(" || current === ")")
      ) {
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
  right: QueryTextExpression,
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

export const parseExpressionAst = (
  freeTokens: string[],
): QueryTextExpression | undefined => {
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

export const parseFreeTextExpression = (
  freeTokens: string[],
): FreeTextParseResult => {
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
    const value = unaryNegated
      ? trimQuotes(normalized.slice(1)).trim()
      : normalized;
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
