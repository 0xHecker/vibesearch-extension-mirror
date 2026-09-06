import type { AnalyzeQueryInput, QueryAnalysis, QueryPill } from "./contracts";
import { parseTokenIntoState } from "./query-language/filter-parser";
import {
  createDefaultDirectives,
  createDefaultFilters,
} from "./query-language/model";
import { buildSuggestions } from "./query-language/suggestions";
import {
  parseExpressionAst,
  parseFreeTextExpression,
} from "./query-language/text-expression";
import { resolveActiveToken, tokenizeQuery } from "./query-language/tokens";

export { formatHumanDate } from "./query-language/date-filters";
export { removePillRangesFromQuery } from "./query-language/tokens";

export function analyzeQuery(request: AnalyzeQueryInput): QueryAnalysis {
  const input = request.input || "";
  const cursor = Number.isFinite(request.cursor)
    ? request.cursor
    : input.length;
  const tokens = tokenizeQuery(input);
  const activeToken = resolveActiveToken(input, cursor, tokens);
  const filters = createDefaultFilters();
  const directives = createDefaultDirectives();
  const pills: QueryPill[] = [];
  const freeTokens: string[] = [];

  for (let index = 0; index < tokens.length;) {
    const token = tokens[index];
    const result = parseTokenIntoState(
      token,
      tokens[index + 1],
      filters,
      directives,
      pills,
    );
    if (!result.structured) freeTokens.push(token.text);
    index += result.consumed;
  }

  const freeText = parseFreeTextExpression(freeTokens);
  const textExpression = parseExpressionAst(freeTokens);
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

  const suggestionResult = buildSuggestions(
    activeToken.text,
    activeToken.start,
    activeToken.end,
    request.catalogs,
    request.forceSuggestions === true,
  );

  return {
    requestId: request.requestId,
    input,
    freeText: freeText.flatTerms.join(" ").trim(),
    textGroups: freeText.groups,
    excludedTerms: freeText.excludedTerms,
    textExpression,
    tokens,
    pills,
    filters,
    directives,
    activeTokenStart: activeToken.start,
    activeTokenEnd: activeToken.end,
    activeTokenText: activeToken.text,
    shouldOpenSuggestions: suggestionResult.shouldOpen,
    suggestions: suggestionResult.suggestions,
  };
}

function unique<Value>(values: Value[]): Value[] {
  return Array.from(new Set(values));
}
