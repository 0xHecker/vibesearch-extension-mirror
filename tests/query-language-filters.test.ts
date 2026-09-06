import { describe, expect, test } from "bun:test";
import {
  analyzeQuery,
  removePillRangesFromQuery,
} from "../src/search-core/query-language";
import type { QueryAssistCatalogs } from "../src/search-core/contracts";

const catalogs: QueryAssistCatalogs = {
  sources: [],
  spaces: [],
  folders: [],
  tags: [],
  domains: [],
  authors: [],
  recentQueries: [],
};

const analyze = (input: string) =>
  analyzeQuery({
    type: "ANALYZE_QUERY",
    requestId: 1,
    input,
    cursor: input.length,
    catalogs,
    forceSuggestions: false,
  });

describe("query language filters (UI ↔ typing share one state)", () => {
  test("has:embed and has:video parse into hasAny media filters", () => {
    const analysis = analyze("songs has:embed has:video");
    expect(analysis.filters.hasAny).toContain("embed");
    expect(analysis.filters.hasAny).toContain("video");
    expect(analysis.freeText).toBe("songs");
  });

  test("mode + scope directives resolve (chips read these)", () => {
    const analysis = analyze("mode:hybrid scope:private");
    expect(analysis.directives.mode).toBe("keyword+vector");
    expect(analysis.directives.scope).toBe("private");
  });

  test("all current source families are valid structured filters", () => {
    const analysis = analyze(
      "source:threads source:mastodon source:bluesky source:spotify source:ytmusic source:vimeo source:soundcloud",
    );
    expect(analysis.filters.sources).toEqual([
      "threads",
      "mastodon",
      "bluesky",
      "spotify",
      "ytmusic",
      "vimeo",
      "soundcloud",
    ]);
    expect(analysis.freeText).toBe("");
  });

  test("score directives and camel-case sort fields remain structured", () => {
    const analysis = analyze("minscore:0.42 sort:updatedAt desc");
    expect(analysis.directives.minScore).toBe(0.42);
    expect(analysis.directives.sortBy).toBe("updatedAt");
    expect(analysis.directives.sortOrder).toBe("desc");
    expect(analysis.freeText).toBe("");
  });

  test("multi-space, tag and site filters accumulate", () => {
    const analysis = analyze(
      'tag:music site:youtube.com space:Work space:"Side Projects"',
    );
    expect(analysis.filters.tagNames).toContain("music");
    expect(analysis.filters.domains).toContain("youtube.com");
    expect(analysis.filters.spaceIds).toEqual(["Work", "Side Projects"]);
  });

  test("a directive pill carries its source range so the UI can toggle it", () => {
    const analysis = analyze("has:embed");
    const pill = analysis.pills.find(
      (entry) => entry.field === "has" && entry.value === "embed",
    );
    expect(pill).toBeTruthy();
    expect(pill?.start).toBe(0);
    expect(pill?.end).toBe("has:embed".length);
  });

  test("boolean AND remains an explicit text expression", () => {
    const analysis = analyze("logo AND design");

    expect(analysis.freeText).toBe("logo design");
    expect(analysis.textExpression).toEqual({
      type: "AND",
      children: [
        { type: "TERM", value: "logo" },
        { type: "TERM", value: "design" },
      ],
    });
  });

  test("NOT and dash exclusions remain visible while producing exclusions", () => {
    const notAnalysis = analyze("design NOT logo");
    expect(notAnalysis.excludedTerms).toEqual(["logo"]);
    expect(
      removePillRangesFromQuery("design NOT logo", notAnalysis.pills),
    ).toBe("design NOT logo");

    const dashAnalysis = analyze('-"some word"');
    expect(dashAnalysis.excludedTerms).toEqual(["some word"]);
    expect(dashAnalysis.textExpression).toEqual({
      type: "NOT",
      child: { type: "TERM", value: "some word" },
    });
    expect(removePillRangesFromQuery('-"some word"', dashAnalysis.pills)).toBe(
      '-"some word"',
    );
  });

  test("query bar text splitting only removes structured pill ranges", () => {
    const analysis = analyze("source:web design NOT logo");
    expect(analysis.pills.map((pill) => pill.raw)).toEqual(["source:web"]);
    expect(
      removePillRangesFromQuery("source:web design NOT logo", analysis.pills),
    ).toBe("design NOT logo");
  });
});
