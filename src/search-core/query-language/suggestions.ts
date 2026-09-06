import { QUERY_MODE_DEFINITIONS, QUERY_MODES } from "../contracts";
import type { QueryAssistCatalogs, QuerySuggestion } from "../contracts";
import { formatHumanDate, parseRelativeDate } from "./date-filters";
import { MEDIA_FILTERS, QUERY_SCOPES, parseQueryField } from "./model";

type SuggestionResult = {
  shouldOpen: boolean;
  suggestions: QuerySuggestion[];
};

const pushSuggestions = (
  suggestions: QuerySuggestion[],
  list: Array<Omit<QuerySuggestion, "start" | "end">>,
  start: number,
  end: number,
) => {
  for (const item of list) {
    suggestions.push({ ...item, start, end });
  }
};

export const buildSuggestions = (
  activeTokenText: string,
  activeStart: number,
  activeEnd: number,
  catalogs: QueryAssistCatalogs,
  forceSuggestions: boolean,
): SuggestionResult => {
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
    const field = parseQueryField(fieldMatch[2]);
    if (!field) return { shouldOpen: forceSuggestions, suggestions };
    const valuePart = fieldMatch[3] ?? "";

    if (field === "source") {
      const options = catalogs.sources
        .filter((source) => source.includes(valuePart))
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
        .filter((space) =>
          space.name.toLowerCase().includes(valuePart.toLowerCase()),
        )
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
      const options = QUERY_MODES;
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
      const items = QUERY_SCOPES;
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
      const sortItems = [
        "relevance desc",
        "createdAt desc",
        "updatedAt desc",
        "title asc",
        "source asc",
      ]
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
        .filter((folder) =>
          folder.name.toLowerCase().includes(valuePart.toLowerCase()),
        )
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
        .filter((tag) =>
          tag.name.toLowerCase().includes(valuePart.toLowerCase()),
        )
        .slice(0, 10)
        .map((tag) => ({
          id: `tag:${tag.id}`,
          category: "Tags" as const,
          label: `tag:${tag.name}`,
          description: "Filter by tag",
          insertText: /\s/.test(tag.name)
            ? `${negation}tag:"${tag.name}"`
            : `${negation}tag:${tag.name}`,
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
        activeEnd,
      );
    }

    if (field === "has") {
      const hasRows = MEDIA_FILTERS.filter((entry) =>
        entry.includes(valuePart),
      ).map((entry) => ({
        id: `has:${entry}`,
        category: "Refine" as const,
        label: `has:${entry}`,
        description: "Media presence filter",
        insertText: `${negation}has:${entry}`,
      }));
      pushSuggestions(suggestions, hasRows, activeStart, activeEnd);
    }

    if (
      field === "date" ||
      field === "created" ||
      field === "updated" ||
      field === "added"
    ) {
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
          .filter(
            (row) => row.label.toLowerCase().includes(q) || row.key.includes(q),
          )
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

        pushSuggestions(
          suggestions,
          [...operatorRows, ...presetRows],
          activeStart,
          activeEnd,
        );
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
        activeEnd,
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
        ? helperRows.filter((row) =>
            row.label.toLowerCase().startsWith(fieldQuery),
          )
        : helperRows,
      activeStart,
      activeEnd,
    );

    const recent = catalogs.recentQueries
      .filter((query) =>
        query.toLowerCase().includes(lower.replace(/^[:/]/, "")),
      )
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
