import { cn } from "@src/lib/utils";
import type { ItemDocType } from "@src/schemas/item_schema";
import { Globe, Image as ImageIcon, Newspaper, Star, StickyNote, type LucideIcon } from "lucide-react";
import type { IconType } from "react-icons";
import { FaLinkedin } from "react-icons/fa6";
import { SiGithub, SiInstagram, SiReddit, SiSubstack, SiTiktok, SiX, SiYoutube } from "react-icons/si";

type Source = ItemDocType["source"];

// Lucide (outline) and react-icons (filled brand glyphs) both render via
// `currentColor` and accept `size`/`className`, so they're interchangeable here.
type IconComponent = LucideIcon | IconType;

/**
 * A quick-filter descriptor. `token` is the query fragment the pill toggles
 * (e.g. "source:web", "has:image"). The shape is intentionally open: to add
 * non-filter pills later (e.g. a "New note" action that opens the rich-text
 * editor), add a `kind`/`onAction` field here and branch in `onToggle`.
 */
export type QuickFilter = {
  id: string;
  label: string;
  icon: IconComponent;
  token: string;
};

// Exact brand logos for sources; generic lucide marks for non-brand concepts.
const SOURCE_META = {
  web: { label: "Web Pages", icon: Globe },
  article: { label: "Articles", icon: Newspaper },
  note: { label: "Notes", icon: StickyNote },
  twitter: { label: "X Posts", icon: SiX },
  reddit: { label: "Reddit", icon: SiReddit },
  youtube: { label: "YouTube", icon: SiYoutube },
  github: { label: "GitHub", icon: SiGithub },
  linkedin: { label: "LinkedIn", icon: FaLinkedin },
  instagram: { label: "Instagram", icon: SiInstagram },
  tiktok: { label: "TikTok", icon: SiTiktok },
  substack: { label: "Substack", icon: SiSubstack },
} satisfies Partial<Record<Source, { label: string; icon: IconComponent }>>;

// Curated order: most-reached-for first, then sources by likely usefulness.
const SOURCE_ORDER = [
  "web",
  "article",
  "note",
  "twitter",
  "reddit",
  "youtube",
  "github",
  "linkedin",
  "instagram",
  "tiktok",
  "substack",
] as const satisfies readonly Source[];

// Universal filters that aren't tied to a single source.
const ALL_FILTERS: QuickFilter[] = [
  { id: "is:favorite", label: "Favorites", icon: Star, token: "is:favorite" },
  { id: "has:image", label: "Images", icon: ImageIcon, token: "has:image" },
  ...SOURCE_ORDER.map((source) => ({
    id: `source:${source}`,
    label: SOURCE_META[source].label,
    icon: SOURCE_META[source].icon,
    token: `source:${source}`,
  })),
];

// Content-aware: only surface filters whose token actually exists in the saved items.
export const buildQuickFilters = (availableTokens: Iterable<string>): QuickFilter[] => {
  const present = new Set(availableTokens);
  return ALL_FILTERS.filter((filter) => present.has(filter.token));
};

type SearchFilterPillsProps = {
  filters: QuickFilter[];
  activeTokens: Set<string>;
  visible: boolean;
  onToggle: (filter: QuickFilter) => void;
};

const EASE = "cubic-bezier(0.2,0,0,1)";

export const SearchFilterPills = ({
  filters,
  activeTokens,
  visible,
  onToggle,
}: SearchFilterPillsProps) => {
  if (filters.length === 0) return null;

  return (
    <div
      aria-hidden={!visible}
      className={cn(
        "mx-auto grid w-full max-w-5xl px-1 ease-[var(--vs-ease)] transition-[grid-template-rows,opacity,margin] duration-300",
        visible ? "mt-3 grid-rows-[1fr] opacity-100" : "pointer-events-none mt-0 grid-rows-[0fr] opacity-0"
      )}
      style={{ ["--vs-ease" as string]: EASE }}
    >
      <div className="min-h-0 overflow-hidden">
        {/* preventDefault on pointer-down keeps the input focused so the row stays open on click */}
        <div
          onMouseDown={(event) => event.preventDefault()}
          className={cn(
            "flex flex-nowrap items-center gap-2 overflow-x-auto py-1.5 [-ms-overflow-style:none] [scrollbar-width:none]",
            "[mask-image:linear-gradient(to_right,transparent,#000_16px,#000_calc(100%-16px),transparent)]",
            "[&::-webkit-scrollbar]:hidden"
          )}
        >
          {filters.map((filter, index) => {
            const Icon = filter.icon;
            const active = activeTokens.has(filter.token);
            return (
              <span
                key={filter.id}
                style={{ transitionDelay: visible ? `${Math.min(index * 24, 240)}ms` : "0ms" }}
                className={cn(
                  "inline-flex shrink-0 ease-[var(--vs-ease)] transition-[opacity,transform,filter] duration-300",
                  visible ? "translate-y-0 opacity-100 blur-0" : "translate-y-1 opacity-0 blur-[3px]"
                )}
              >
                <button
                  type="button"
                  aria-pressed={active}
                  aria-label={active ? `Remove ${filter.label} filter` : `Filter by ${filter.label}`}
                  tabIndex={visible ? 0 : -1}
                  onClick={() => onToggle(filter)}
                  className={cn(
                    "inline-flex h-9 items-center gap-2 rounded-full pl-3 pr-3.5 text-[13px] font-medium whitespace-nowrap",
                    "transition-[background-color,box-shadow,color,transform] duration-150 ease-out",
                    "active:scale-[0.96] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40",
                    active
                      ? "bg-background-inverse text-white shadow-[0_2px_10px_-3px_rgba(0,0,0,0.30)]"
                      : "bg-background-neutral text-foreground-neutral shadow-[inset_0_0_0_1px_rgba(0,0,0,0.08),0_1px_2px_rgba(0,0,0,0.04)] hover:bg-background-neutral-faded hover:shadow-[inset_0_0_0_1px_rgba(0,0,0,0.12),0_4px_10px_-4px_rgba(0,0,0,0.12)]"
                  )}
                >
                  <Icon
                    size={15}
                    aria-hidden="true"
                    className={cn("shrink-0", active ? "text-white" : "text-foreground-icon")}
                  />
                  {filter.label}
                </button>
              </span>
            );
          })}
        </div>
      </div>
    </div>
  );
};
