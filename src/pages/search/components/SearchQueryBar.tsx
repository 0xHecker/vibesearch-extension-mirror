import { analyzeQuery, removePillRangesFromQuery } from "@src/search-core/query-language";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Input } from "@src/components/ui/input";
import { Popover, PopoverAnchor, PopoverContent } from "@src/components/ui/popover";
import { cn } from "@src/lib/utils";
import { DatePicker } from "./DatePicker";
import { SearchFilterPills, buildQuickFilters, type QuickFilter } from "./SearchFilterPills";
import {
  ArrowUpDown,
  AtSign,
  Boxes,
  Calendar,
  CornerDownLeft,
  Folder,
  Globe,
  HelpCircle,
  History,
  Image as ImageIcon,
  Layers,
  Search,
  SlidersHorizontal,
  Sparkles,
  Star,
  Tag,
  X,
  type LucideIcon,
} from "lucide-react";
import type {
  AnalyzeQueryRequest,
  AnalyzeQueryResponse,
  QueryAnalysis,
  QueryAssistCatalogs,
  QueryPill,
  QuerySuggestion,
  SetQueryAssistCatalogsRequest,
} from "@src/search-core/contracts";

export type SearchQuerySubmitMeta = {
  requestId: number;
  submittedAt: number;
  uiDebounceWaitMs: number;
};

type SearchQueryBarProps = {
  committedValue?: string;
  onSubmit: (value: string, analysis: QueryAnalysis, meta: SearchQuerySubmitMeta) => void;
  catalogs: QueryAssistCatalogs;
  placeholder?: string;
  availableFilters?: string[];
  onDeleteRecentQuery?: (query: string) => void;
  onClearRecentQueries?: () => void;
};

const fallbackAnalysis: QueryAnalysis = {
  requestId: 0,
  input: "",
  freeText: "",
  textGroups: [],
  excludedTerms: [],
  textExpression: undefined,
  tokens: [],
  pills: [],
  filters: {
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
  },
  directives: {},
  activeTokenStart: 0,
  activeTokenEnd: 0,
  activeTokenText: "",
  shouldOpenSuggestions: false,
  suggestions: [],
};

const GROUP_ORDER = [
  "Refine",
  "Spaces",
  "Sources",
  "Folders",
  "Tags",
  "Domains",
  "Dates",
  "Sort",
  "Modes",
  "Recent",
  "Helpers",
] as const;

const CATEGORY_ICON: Record<string, LucideIcon> = {
  Refine: SlidersHorizontal,
  Spaces: Layers,
  Sources: Boxes,
  Folders: Folder,
  Tags: Tag,
  Domains: Globe,
  Dates: Calendar,
  Sort: ArrowUpDown,
  Modes: Sparkles,
  Recent: History,
  Helpers: HelpCircle,
};

const FIELD_ICON: Record<string, LucideIcon> = {
  date: Calendar,
  added: Calendar,
  created: Calendar,
  updated: Calendar,
  folder: Folder,
  space: Layers,
  tag: Tag,
  source: Boxes,
  site: Globe,
  domain: Globe,
  scope: Globe,
  author: AtSign,
  is: Star,
  has: ImageIcon,
  sort: ArrowUpDown,
  mode: Sparkles,
};

type DateContext = { field: string; operator: string; mode: "single" | "range" };

const getDateContext = (tokenText: string): DateContext | null => {
  const match = tokenText.match(/^-?(date|added|created|updated):(on|after|before|between):(.*)$/i);
  if (!match) return null;
  const operator = match[2].toLowerCase();
  const rest = match[3];
  const complete =
    operator === "between"
      ? /^\d{4}-\d{2}-\d{2}\.\.\d{4}-\d{2}-\d{2}$/.test(rest)
      : /^\d{4}-\d{2}-\d{2}$/.test(rest);
  if (complete) return null;
  return {
    field: match[1].toLowerCase(),
    operator,
    mode: operator === "between" ? "range" : "single",
  };
};

const Kbd = ({ children, className }: { children: React.ReactNode; className?: string }) => (
  <kbd
    className={cn(
      "inline-flex h-5 min-w-[1.25rem] items-center justify-center rounded-md border border-border-neutral-faded",
      "bg-background-neutral-faded px-1.5 font-sans text-[10px] font-medium leading-none tracking-wide text-foreground-secondary",
      className
    )}
  >
    {children}
  </kbd>
);

const normalizeQueryWhitespace = (input: string): string => input.replace(/\s{2,}/g, " ").trim();

const hasOpenQuote = (value: string): boolean => (value.match(/"/g)?.length ?? 0) % 2 === 1;

const QUOTABLE_FIELDS = new Set(["folder", "space", "tag", "author"]);

// On commit, wrap an unquoted multi-word value (e.g. folder:day one) in quotes so it stays one pill.
const autoQuoteValue = (text: string): string => {
  const match = text.match(/^(-?[a-z]+):(.+)$/i);
  if (!match || !QUOTABLE_FIELDS.has(match[1].replace(/^-/, "").toLowerCase())) return text;
  const value = match[2].trim();
  if (value && value.includes(" ") && !value.includes('"') && !/[a-z]+:/i.test(value)) {
    return `${match[1]}:"${value}"`;
  }
  return text;
};

const isDirectiveContextToken = (token: string): boolean => {
  const trimmed = token.trim();
  if (!trimmed) return false;
  return trimmed.startsWith("/") || trimmed.startsWith(":") || /^-?[a-z]+:/i.test(trimmed);
};

const groupSuggestions = (suggestions: QuerySuggestion[]) => {
  const byGroup = new Map<string, QuerySuggestion[]>();
  for (const suggestion of suggestions) {
    const list = byGroup.get(suggestion.category) || [];
    list.push(suggestion);
    byGroup.set(suggestion.category, list);
  }
  return GROUP_ORDER.filter((group) => byGroup.has(group)).map((group) => ({
    group,
    items: byGroup.get(group) || [],
  }));
};

const analyzeOnce = (input: string, catalogs: QueryAssistCatalogs): QueryAnalysis =>
  analyzeQuery({
    type: "ANALYZE_QUERY",
    requestId: 0,
    input,
    cursor: input.length,
    forceSuggestions: false,
    catalogs,
  });

// Split a query string into committed filter tokens (pills) + free text.
const splitQuery = (query: string, catalogs: QueryAssistCatalogs) => {
  const analysis = analyzeOnce(query, catalogs);
  return {
    tokens: analysis.pills.map((pill) => pill.raw),
    text: removePillRangesFromQuery(query, analysis.pills),
  };
};

// Pull any complete filter tokens out of the input text so they can become pills.
const extractFilters = (text: string, catalogs: QueryAssistCatalogs) => {
  const analysis = analyzeOnce(text, catalogs);
  return {
    filters: analysis.pills.map((pill) => pill.raw),
    rest: removePillRangesFromQuery(text, analysis.pills),
  };
};

export const SearchQueryBar = ({
  committedValue = "",
  onSubmit,
  catalogs,
  placeholder = "Search anything\u2026",
  availableFilters = [],
  onDeleteRecentQuery,
  onClearRecentQueries,
}: SearchQueryBarProps) => {
  const initial = useMemo(() => splitQuery(committedValue, catalogs), []);
  const [tokens, setTokens] = useState<string[]>(initial.tokens);
  const [text, setText] = useState(initial.text);
  const [cursor, setCursor] = useState(0);
  const [analysis, setAnalysis] = useState<QueryAnalysis>(fallbackAnalysis);
  const [openAssist, setOpenAssist] = useState(false);
  const [forceAssist, setForceAssist] = useState(false);
  const [activeIndex, setActiveIndex] = useState(0);
  const [focused, setFocused] = useState(false);

  const inputRef = useRef<HTMLInputElement | null>(null);

  // Press "/" anywhere (outside inputs) to jump to the search bar.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "/" || event.metaKey || event.ctrlKey || event.altKey) return;
      const target = event.target as HTMLElement | null;
      const tag = target?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || target?.isContentEditable) return;
      event.preventDefault();
      inputRef.current?.focus();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
  const workerRef = useRef<Worker | null>(null);
  const requestIdRef = useRef(0);
  const lastCommittedValueRef = useRef(committedValue);
  const latestCatalogsRef = useRef(catalogs);
  const forceAssistRef = useRef(forceAssist);
  const lastInputAtRef = useRef(Date.now());
  const pendingCursorRef = useRef<number | null>(null);
  const textRef = useRef(text);

  const isMac = typeof navigator !== "undefined" && navigator.userAgent.includes("Mac");

  const prefix = tokens.join(" ");
  const textStart = prefix ? (text ? prefix.length + 1 : prefix.length) : 0;
  const fullQuery = useMemo(() => [prefix, text].filter(Boolean).join(" "), [prefix, text]);
  const analysisCursor = Math.min(textStart + cursor, fullQuery.length);

  const committedPills = useMemo(
    () => tokens.map((raw) => analyzeOnce(raw, catalogs).pills[0] ?? null),
    [tokens, catalogs]
  );

  const quickFilters = useMemo(() => buildQuickFilters(availableFilters), [availableFilters]);

  // Tokens already committed, as a "field:value" set, for highlighting active pills.
  const activeFilterTokens = useMemo(() => {
    const set = new Set<string>();
    committedPills.forEach((pill) => {
      if (pill && !pill.negated) set.add(`${pill.field}:${pill.value}`);
    });
    return set;
  }, [committedPills]);

  useEffect(() => {
    latestCatalogsRef.current = catalogs;
  }, [catalogs]);

  useEffect(() => {
    forceAssistRef.current = forceAssist;
  }, [forceAssist]);

  useEffect(() => {
    textRef.current = text;
  }, [text]);

  // Apply a programmatic cursor position after a controlled text change.
  useEffect(() => {
    if (pendingCursorRef.current === null) return;
    const pos = pendingCursorRef.current;
    pendingCursorRef.current = null;
    const input = inputRef.current;
    if (!input) return;
    input.focus();
    const bounded = Math.max(0, Math.min(pos, input.value.length));
    input.setSelectionRange(bounded, bounded);
    setCursor(bounded);
  }, [text]);

  useEffect(() => {
    if (committedValue === lastCommittedValueRef.current) return;
    lastCommittedValueRef.current = committedValue;
    const split = splitQuery(committedValue, latestCatalogsRef.current);
    setTokens(split.tokens);
    setText(split.text);
  }, [committedValue]);

  const groupedSuggestions = useMemo(
    () => groupSuggestions(analysis.suggestions),
    [analysis.suggestions]
  );
  const flatSuggestions = useMemo(
    () => groupedSuggestions.flatMap((group) => group.items),
    [groupedSuggestions]
  );
  const indexById = useMemo(() => {
    const map = new Map<string, number>();
    flatSuggestions.forEach((item, index) => map.set(item.id, index));
    return map;
  }, [flatSuggestions]);

  useEffect(() => {
    setActiveIndex(0);
  }, [flatSuggestions, openAssist]);

  useEffect(() => {
    if (!openAssist) return;
    document.getElementById(`vs-sugg-${activeIndex}`)?.scrollIntoView({ block: "nearest" });
  }, [activeIndex, openAssist]);

  useEffect(() => {
    const worker = new Worker(new URL("../workers/query-assist.worker.ts", import.meta.url), {
      type: "module",
    });
    workerRef.current = worker;

    const onMessage = (event: MessageEvent<AnalyzeQueryResponse>) => {
      if (event.data?.type !== "ANALYZE_QUERY_RESULT") return;
      const payload = event.data.payload;
      if (payload.requestId !== requestIdRef.current) return;

      setAnalysis(payload);

      const hasSuggestions = payload.suggestions.length > 0;
      const inDirectiveContext = isDirectiveContextToken(payload.activeTokenText);
      const hasDatePicker = !!getDateContext(payload.activeTokenText);
      const typing = textRef.current.length > 0;
      setOpenAssist(
        (hasSuggestions || hasDatePicker) &&
          (forceAssistRef.current || ((inDirectiveContext || hasDatePicker) && typing))
      );
    };

    const onError = () => setOpenAssist(false);

    worker.addEventListener("message", onMessage as EventListener);
    worker.addEventListener("error", onError as EventListener);
    return () => {
      worker.removeEventListener("message", onMessage as EventListener);
      worker.removeEventListener("error", onError as EventListener);
      worker.terminate();
      workerRef.current = null;
    };
  }, []);

  useEffect(() => {
    const worker = workerRef.current;
    if (!worker) return;
    const message: SetQueryAssistCatalogsRequest = { type: "SET_CATALOGS", catalogs };
    worker.postMessage(message);
  }, [catalogs]);

  useEffect(() => {
    const worker = workerRef.current;
    if (!worker) return;
    requestIdRef.current += 1;
    const message: AnalyzeQueryRequest = {
      type: "ANALYZE_QUERY",
      requestId: requestIdRef.current,
      input: fullQuery,
      cursor: analysisCursor,
      forceSuggestions: forceAssist,
    };
    const timer = window.setTimeout(() => worker.postMessage(message), 70);
    return () => window.clearTimeout(timer);
  }, [fullQuery, analysisCursor, forceAssist]);

  // Global shortcuts: "/" focuses the bar, Cmd/Ctrl+K opens Query assist.
  useEffect(() => {
    const onDocKeyDown = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        inputRef.current?.focus();
        setForceAssist(true);
        setOpenAssist(true);
        return;
      }
      if (event.key === "/" && !event.metaKey && !event.ctrlKey && !event.altKey) {
        const target = event.target as HTMLElement | null;
        const typing =
          !!target &&
          (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable);
        if (typing) return;
        event.preventDefault();
        inputRef.current?.focus();
      }
    };
    document.addEventListener("keydown", onDocKeyDown);
    return () => document.removeEventListener("keydown", onDocKeyDown);
  }, []);

  const dateContext = useMemo(
    () => getDateContext(analysis.activeTokenText),
    [analysis.activeTokenText]
  );

  const submitQuery = useCallback(
    (nextTokens: string[], nextText: string) => {
      const query = normalizeQueryWhitespace(
        [nextTokens.join(" "), nextText].filter(Boolean).join(" ")
      );
      const nextRequestId = requestIdRef.current + 1;
      requestIdRef.current = nextRequestId;
      const snapshot = analyzeQuery({
        type: "ANALYZE_QUERY",
        requestId: nextRequestId,
        input: query,
        cursor: query.length,
        forceSuggestions: false,
        catalogs: latestCatalogsRef.current,
      });
      setAnalysis(snapshot);
      setForceAssist(false);
      setOpenAssist(false);
      onSubmit(query, snapshot, {
        requestId: nextRequestId,
        submittedAt: Date.now(),
        uiDebounceWaitMs: Math.max(0, Date.now() - lastInputAtRef.current),
      });
    },
    [onSubmit]
  );

  // Commit any complete filters found in `nextText` into pills; submit on demand.
  const commitText = (nextText: string, submit: boolean) => {
    const { filters, rest } = hasOpenQuote(nextText)
      ? { filters: [] as string[], rest: nextText }
      : extractFilters(nextText, latestCatalogsRef.current);
    const next = filters.length ? [...tokens, ...filters] : tokens;
    if (filters.length) setTokens(next);
    setText(rest);
    pendingCursorRef.current = rest.length;
    setForceAssist(false);
    setOpenAssist(false);
    if (submit) submitQuery(next, rest);
    return filters.length > 0;
  };

  const applySuggestion = (suggestion: QuerySuggestion) => {
    const start = Math.max(0, suggestion.start - textStart);
    const end = Math.max(start, suggestion.end - textStart);
    const before = text.slice(0, start);
    const after = text.slice(end);
    const needsLead = before.length > 0 && !/\s$/.test(before);
    const insertion = `${needsLead ? " " : ""}${suggestion.insertText.trim()}`;
    commitText(normalizeQueryWhitespace(`${before}${insertion}${after}`), true);
  };

  const handleDateSelect = (value: Date | { from: Date; to: Date }) => {
    if (!dateContext) return;
    const iso = (date: Date) =>
      `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
    const token =
      "from" in value
        ? `${dateContext.field}:between:${iso(value.from)}..${iso(value.to)}`
        : `${dateContext.field}:${dateContext.operator}:${iso(value)}`;
    const start = Math.max(0, analysis.activeTokenStart - textStart);
    const end = Math.max(start, analysis.activeTokenEnd - textStart);
    commitText(normalizeQueryWhitespace(`${text.slice(0, start)}${token}${text.slice(end)}`), true);
  };

  const editPill = (index: number) => {
    const raw = tokens[index];
    setTokens((prev) => prev.filter((_, i) => i !== index));
    const nextText = text ? `${text} ${raw}` : raw;
    setText(nextText);
    pendingCursorRef.current = nextText.length;
  };

  const removePill = (index: number) => {
    const next = tokens.filter((_, i) => i !== index);
    setTokens(next);
    submitQuery(next, text);
    window.requestAnimationFrame(() => inputRef.current?.focus());
  };

  const clearQuery = () => {
    setTokens([]);
    setText("");
    setCursor(0);
    submitQuery([], "");
    window.requestAnimationFrame(() => inputRef.current?.focus());
  };

  // Toggle a quick-filter pill: remove its token if already applied, else append it.
  const toggleQuickFilter = (filter: QuickFilter) => {
    const sep = filter.token.indexOf(":");
    const field = filter.token.slice(0, sep);
    const value = filter.token.slice(sep + 1);
    const existingIndex = tokens.findIndex((raw) => {
      const pill = analyzeOnce(raw, latestCatalogsRef.current).pills[0];
      return !!pill && !pill.negated && pill.field === field && pill.value === value;
    });
    const next =
      existingIndex >= 0
        ? tokens.filter((_, index) => index !== existingIndex)
        : [...tokens, filter.token];
    setTokens(next);
    submitQuery(next, text);
    window.requestAnimationFrame(() => inputRef.current?.focus());
  };

  const handleKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    const hasSuggestions = openAssist && flatSuggestions.length > 0;
    if (hasSuggestions && event.key === "ArrowDown") {
      event.preventDefault();
      setActiveIndex((index) => (index + 1) % flatSuggestions.length);
      return;
    }
    if (hasSuggestions && event.key === "ArrowUp") {
      event.preventDefault();
      setActiveIndex((index) => (index - 1 + flatSuggestions.length) % flatSuggestions.length);
      return;
    }
    if (event.key === "Escape") {
      if (openAssist || forceAssist) {
        event.preventDefault();
        setForceAssist(false);
        setOpenAssist(false);
      } else {
        event.currentTarget.blur();
      }
      return;
    }
    if (event.key === "Backspace" && cursor === 0 && !text && tokens.length > 0) {
      event.preventDefault();
      editPill(tokens.length - 1);
      return;
    }
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      if (hasSuggestions && flatSuggestions[activeIndex]) {
        applySuggestion(flatSuggestions[activeIndex]);
      } else {
        commitText(autoQuoteValue(text.trim()), true);
      }
      return;
    }
    if (event.key === " ") {
      if (!/\s$/.test(text.slice(0, cursor))) return;
      const quoted = autoQuoteValue(text.trim());
      const { filters } = hasOpenQuote(quoted)
        ? { filters: [] as string[] }
        : extractFilters(quoted, latestCatalogsRef.current);
      if (filters.length) {
        event.preventDefault();
        commitText(quoted, true);
      }
    }
  };

  return (
    <div className="w-full">
      <Popover open={openAssist} onOpenChange={setOpenAssist}>
        <div className="relative mx-auto w-full max-w-5xl">
          <PopoverAnchor asChild>
            <div
              onClick={() => inputRef.current?.focus()}
              className={cn(
                "group/field flex items-center gap-3 rounded-3xl bg-background-neutral py-2.5 pl-5 pr-2.5",
                "shadow-[0_0_0_1px_rgba(0,0,0,0.08),0_2px_4px_-1px_rgba(0,0,0,0.06),0_12px_28px_-12px_rgba(0,0,0,0.12)]",
                "transition-[box-shadow] duration-200 ease-out",
                "focus-within:shadow-[0_0_0_1.5px_var(--color-accent),0_2px_4px_-1px_rgba(255,77,77,0.10),0_14px_32px_-12px_rgba(255,77,77,0.22)]"
              )}
            >
              <Search
                size={22}
                strokeWidth={2.25}
                aria-hidden="true"
                className="shrink-0 text-foreground-icon transition-colors duration-200 group-focus-within/field:text-accent"
              />

              <div className="flex min-w-0 flex-1 flex-wrap items-center gap-2">
                {committedPills.map((pill, index) => {
                  if (!pill) return null;
                  const Icon = FIELD_ICON[pill.field] ?? SlidersHorizontal;
                  const isDate = /^(date|added|created|updated)$/.test(pill.field);
                  const display = isDate ? pill.label : pill.label.replace(/^-?[a-z]+:\s*/i, "");
                  return (
                    <span
                      key={`${pill.raw}-${index}`}
                      role="button"
                      tabIndex={0}
                      title="Click to edit"
                      onClick={(event) => {
                        event.stopPropagation();
                        editPill(index);
                      }}
                      onKeyDown={(event) => {
                        if (event.key === "Enter") editPill(index);
                      }}
                      className={cn(
                        "group/pill inline-flex h-8 cursor-pointer items-center rounded-full pl-2.5 pr-2 text-[13px] font-medium",
                        "transition-[background-color,box-shadow] duration-150",
                        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40",
                        pill.negated
                          ? "bg-background-danger/10 text-foreground-danger shadow-[inset_0_0_0_1px_var(--color-border-danger-faded)] hover:bg-background-danger/15"
                          : "bg-background-neutral-faded text-foreground-neutral shadow-[inset_0_0_0_1px_rgba(0,0,0,0.08)] hover:bg-background-highlight hover:shadow-[inset_0_0_0_1px_rgba(0,0,0,0.12)]"
                      )}
                    >
                      <Icon
                        size={13}
                        strokeWidth={2.25}
                        className={cn(
                          "mr-1.5 shrink-0",
                          pill.negated ? "text-foreground-danger/80" : "text-foreground-icon"
                        )}
                      />
                      <span className="max-w-[240px] truncate">
                        {pill.negated && <span className="opacity-60">not </span>}
                        {display}
                      </span>
                      <span className="flex w-0 items-center overflow-hidden opacity-0 transition-[width,opacity] duration-200 ease-out group-hover/pill:w-5 group-hover/pill:opacity-100 group-focus-within/pill:w-5 group-focus-within/pill:opacity-100">
                        <button
                          type="button"
                          aria-label="Remove filter"
                          onClick={(event) => {
                            event.stopPropagation();
                            removePill(index);
                          }}
                          className={cn(
                            "ml-1 grid size-4 place-items-center rounded-full transition-colors",
                            pill.negated
                              ? "text-foreground-danger/70 hover:text-foreground-danger"
                              : "text-foreground-tertiary hover:text-foreground-neutral"
                          )}
                        >
                          <X size={12} />
                        </button>
                      </span>
                    </span>
                  );
                })}

                <Input
                  ref={inputRef}
                  value={text}
                  placeholder={tokens.length === 0 && !text ? placeholder : ""}
                  aria-label="Search"
                  role="combobox"
                  aria-expanded={openAssist}
                  aria-controls="vs-suggestions"
                  aria-autocomplete="list"
                  aria-activedescendant={
                    openAssist && flatSuggestions[activeIndex] ? `vs-sugg-${activeIndex}` : undefined
                  }
                  onChange={(event) => {
                    setText(event.target.value);
                    setCursor(event.target.selectionStart ?? event.target.value.length);
                    lastInputAtRef.current = Date.now();
                  }}
                  onClick={(event) => setCursor(event.currentTarget.selectionStart ?? text.length)}
                  onSelect={(event) =>
                    setCursor((event.currentTarget as HTMLInputElement).selectionStart ?? text.length)
                  }
                  onKeyDown={handleKeyDown}
                  onFocus={() => setFocused(true)}
                  onBlur={() => setFocused(false)}
                  className="h-12 min-w-[140px] flex-1 border-0 bg-transparent px-0 font-serif text-[2rem] italic shadow-none caret-accent selection:bg-accent/15 placeholder:text-foreground-secondary/90 focus-visible:ring-0 focus-visible:ring-offset-0"
                />
              </div>

              <div className="flex shrink-0 items-center gap-2 self-center">
                {(tokens.length > 0 || text.length > 0) && (
                  <button
                    type="button"
                    aria-label="Clear search"
                    title="Clear search"
                    onClick={(event) => {
                      event.stopPropagation();
                      clearQuery();
                    }}
                    className={cn(
                      "grid size-10 shrink-0 place-items-center rounded-full text-foreground-tertiary",
                      "transition-colors hover:bg-background-neutral-faded hover:text-foreground-neutral",
                      "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-border-neutral/70",
                      "animate-in fade-in-0 zoom-in-95 duration-150",
                      "active:scale-[0.96]"
                    )}
                  >
                    <X size={17} />
                  </button>
                )}
                <Kbd className="hidden h-7 px-2 text-xs sm:inline-flex">
                  {isMac ? "\u2318K" : "Ctrl+K"}
                </Kbd>
              </div>
            </div>
          </PopoverAnchor>

          <PopoverContent
            align="start"
            sideOffset={10}
            className={cn(
              "overflow-hidden p-0",
              dateContext ? "w-auto" : "w-(--radix-popover-trigger-width) max-w-[480px]"
            )}
            onOpenAutoFocus={(event) => event.preventDefault()}
            onCloseAutoFocus={(event) => event.preventDefault()}
          >
            {dateContext ? (
              <DatePicker mode={dateContext.mode} onSelect={handleDateSelect} />
            ) : (
              <>
                <div
                  id="vs-suggestions"
                  role="listbox"
                  aria-label="Query suggestions"
                  className="scrollbar-thin max-h-[min(360px,60vh)] overflow-y-auto overflow-x-hidden p-2"
                >
                  {flatSuggestions.length === 0 ? (
                    <div className="px-3 py-6 text-center text-xs text-foreground-secondary">
                      No suggestions yet
                    </div>
                  ) : (
                    groupedSuggestions.map((group) => {
                      const GroupIcon = CATEGORY_ICON[group.group] ?? Search;
                      return (
                        <div
                          key={group.group}
                          role="group"
                          aria-label={group.group}
                          className="pb-1 last:pb-0"
                        >
                          <div className="flex items-center justify-between px-2.5 pb-1 pt-2">
                            <span className="text-[10px] font-semibold uppercase tracking-[0.08em] text-foreground-tertiary">
                              {group.group}
                            </span>
                            {group.group === "Recent" && onClearRecentQueries && (
                              <button
                                type="button"
                                onMouseDown={(e) => e.preventDefault()}
                                onClick={onClearRecentQueries}
                                className="rounded px-1 text-[10px] font-medium text-foreground-tertiary transition-colors hover:text-foreground-danger focus-visible:text-foreground-danger focus-visible:outline-none"
                              >
                                Clear all
                              </button>
                            )}
                          </div>
                          <div className="space-y-0.5">
                            {group.items.map((item) => {
                              const index = indexById.get(item.id) ?? -1;
                              const active = index === activeIndex;
                              const isRecent = item.category === "Recent" && !!onDeleteRecentQuery;
                              return (
                                <div key={item.id} className={cn("relative", isRecent && "group/recent")}>
                                  <button
                                    type="button"
                                    id={`vs-sugg-${index}`}
                                    role="option"
                                    aria-selected={active}
                                    onClick={() => applySuggestion(item)}
                                    onMouseMove={() => {
                                      if (activeIndex !== index) setActiveIndex(index);
                                    }}
                                    className={cn(
                                      "flex w-full items-center gap-3 rounded-md px-2.5 py-2.5 text-left transition-colors duration-100",
                                      isRecent && "pr-9",
                                      active
                                        ? "bg-background-highlight"
                                        : "hover:bg-background-highlight/50"
                                    )}
                                  >
                                    <GroupIcon
                                      size={16}
                                      className={cn(
                                        "shrink-0 transition-colors",
                                        active ? "text-foreground-secondary" : "text-foreground-icon"
                                      )}
                                    />
                                    <div className="min-w-0 flex-1">
                                      <div className="truncate text-sm font-medium text-foreground-neutral">
                                        {item.label}
                                      </div>
                                      {item.description && (
                                        <div className="truncate text-xs text-foreground-secondary">
                                          {item.description}
                                        </div>
                                      )}
                                    </div>
                                    {active && !isRecent && (
                                      <Kbd className="shrink-0">
                                        <CornerDownLeft size={11} />
                                      </Kbd>
                                    )}
                                  </button>
                                  {isRecent && (
                                    <button
                                      type="button"
                                      aria-label={`Remove "${item.label}" from recent searches`}
                                      title="Remove from history"
                                      onMouseDown={(e) => e.preventDefault()}
                                      onClick={(e) => {
                                        e.stopPropagation();
                                        onDeleteRecentQuery?.(item.insertText || item.label);
                                      }}
                                      className="absolute right-1.5 top-1/2 grid size-6 -translate-y-1/2 place-items-center rounded text-foreground-tertiary opacity-0 transition-[opacity,color] hover:bg-background-neutral-faded hover:text-foreground-danger focus-visible:opacity-100 focus-visible:outline-none group-hover/recent:opacity-100"
                                    >
                                      <X size={13} />
                                    </button>
                                  )}
                                </div>
                              );
                            })}
                          </div>
                        </div>
                      );
                    })
                  )}
                </div>
                {flatSuggestions.length > 0 && (
                  <div className="flex items-center justify-between border-t border-border-neutral-faded px-3 py-2 text-[10px] text-foreground-secondary">
                    <span className="flex items-center gap-1.5">
                      <Kbd>↑</Kbd>
                      <Kbd>↓</Kbd>
                      Navigate
                    </span>
                    <span className="flex items-center gap-1.5">
                      <Kbd>esc</Kbd>
                      Dismiss
                    </span>
                  </div>
                )}
              </>
            )}
          </PopoverContent>
        </div>
      </Popover>

      <SearchFilterPills
        filters={quickFilters}
        activeTokens={activeFilterTokens}
        visible={focused && !openAssist}
        onToggle={toggleQuickFilter}
      />
    </div>
  );
};
