import type { QueryTextExpression } from "@src/search-core/contracts";

/**
 * Returns true when at least one satisfying Boolean branch requires no
 * non-negated term. Such expressions cannot be narrowed to positive lexical or
 * vector hits: `alpha OR NOT beta`, for example, must also consider `gamma`.
 */
export const expressionCanMatchWithoutPositiveTerm = (
  node: QueryTextExpression,
  negated = false
): boolean => {
  if (node.type === "TERM") {
    // Empty terms evaluate true in the rank evaluators; their negation is false.
    if (!node.value?.trim()) return !negated;
    return negated;
  }

  if (node.type === "NOT") {
    return expressionCanMatchWithoutPositiveTerm(node.child, !negated);
  }

  // De Morgan flips AND/OR while descending through a negation. For an OR,
  // one positive-free child is enough; for an AND, every child must have one.
  const effectiveType = negated
    ? node.type === "AND"
      ? "OR"
      : "AND"
    : node.type;
  if (effectiveType === "OR") {
    return node.children.some((child) =>
      expressionCanMatchWithoutPositiveTerm(child, negated)
    );
  }
  return node.children.every((child) =>
    expressionCanMatchWithoutPositiveTerm(child, negated)
  );
};

export const canNarrowExpressionToPositiveMatches = (
  expression?: QueryTextExpression
): boolean => !expression || !expressionCanMatchWithoutPositiveTerm(expression);
