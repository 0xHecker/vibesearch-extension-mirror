const CSS_DATA_URL = /url\(\s*(['"]?)data:([^)]*)\1\s*\)/gi;

const hasUsableEmbeddedCssResource = (css: string): boolean => {
  CSS_DATA_URL.lastIndex = 0;
  for (const match of css.matchAll(CSS_DATA_URL)) {
    const payload = (match[2] ?? "").trim();
    if (payload && payload !== ",") return true;
  }
  return false;
};

/**
 * Keep SingleFile's readable data URI rule last, while retaining the original
 * network rule for the API to complete when the page-level fetch was blocked.
 */
export const mergeCapturedCssWithOriginal = (
  original: string,
  captured: string | null | undefined,
  kind: "declaration" | "stylesheet",
): string => {
  const current = captured?.trim() ?? "";
  if (!current || current === original.trim() || !hasUsableEmbeddedCssResource(current)) return original;
  if (!original.trim()) return current;
  if (kind === "stylesheet") return `${original}\n${current}`;
  const prefix = original.trimEnd().endsWith(";") ? original.trimEnd() : `${original.trimEnd()};`;
  return `${prefix}${current}`;
};
