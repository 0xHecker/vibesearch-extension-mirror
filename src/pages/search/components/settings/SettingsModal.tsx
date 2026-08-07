import * as React from "react";
import { Command, Database, History, MessageSquare, Plug, Search as SearchIcon, Share2, SlidersHorizontal, Star, Tag, X } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "@src/components/ui/dialog";
import { cn } from "@src/lib/utils";
import { DataSection } from "./sections/DataSection";
import { TokensSection } from "./sections/TokensSection";
import { SharedTabsSection } from "./sections/SharedTabsSection";
import { SearchHistorySection } from "./sections/SearchHistorySection";
import { SearchSettingsSection } from "./sections/SearchSettingsSection";
import { TagsSection } from "./sections/TagsSection";
import { MiscSection } from "./sections/MiscSection";
import { ShortcutsSection } from "./sections/ShortcutsSection";
import { FeedbackSection } from "./sections/FeedbackSection";
import { AUTHOR_GITHUB_URL, AUTHOR_NAME, REPO_URL } from "./links";

export type SettingsSectionId =
  | "data"
  | "tokens"
  | "shared"
  | "tags"
  | "search"
  | "history"
  | "misc"
  | "shortcuts"
  | "feedback";

type SectionDef = {
  id: SettingsSectionId;
  label: string;
  icon: LucideIcon;
  keywords: string;
};

const SECTIONS: SectionDef[] = [
  { id: "data", label: "Data", icon: Database, keywords: "import export backup restore bookmarks github stars google drive json delete" },
  { id: "tokens", label: "Connectors", icon: Plug, keywords: "data connectors github token personal access google connect api credentials" },
  { id: "shared", label: "Shared tabs", icon: Share2, keywords: "share revoke link snapshot public owner rotate views" },
  { id: "tags", label: "Tags", icon: Tag, keywords: "tags color favorite rename delete count organize" },
  { id: "search", label: "Search", icon: SearchIcon, keywords: "search mode scope default hybrid keyword semantic vector fuzzy everywhere global collection folder results" },
  { id: "history", label: "Search history", icon: History, keywords: "history clear recent queries bin recently deleted privacy" },
  { id: "misc", label: "Misc", icon: SlidersHorizontal, keywords: "clipboard format markdown json html plain new tab open close tabs after saving preferences" },
  { id: "shortcuts", label: "Shortcuts", icon: Command, keywords: "keyboard shortcuts keys hotkeys popup screenshot save organize search" },
  { id: "feedback", label: "Feedback", icon: MessageSquare, keywords: "feedback open source github issue bug author star x twitter contact" },
];

export interface SettingsModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  initialSection?: SettingsSectionId;
  onImportBrowserBookmarks: () => void;
  onImportGitHubStars: () => void;
  onImportSharedLink: () => void;
  onDataChanged: () => void;
  recentQueryCount: number;
  onClearSearchHistory: () => Promise<void> | void;
  onOpenBin: () => void;
}

export function SettingsModal({
  open,
  onOpenChange,
  initialSection = "data",
  onImportBrowserBookmarks,
  onImportGitHubStars,
  onImportSharedLink,
  onDataChanged,
  recentQueryCount,
  onClearSearchHistory,
  onOpenBin,
}: SettingsModalProps) {
  const [active, setActive] = React.useState<SettingsSectionId>(initialSection);
  const [filter, setFilter] = React.useState("");
  const searchRef = React.useRef<HTMLInputElement>(null);

  // Reset to the requested section + clear the filter each time it opens.
  React.useEffect(() => {
    if (open) {
      setActive(initialSection);
      setFilter("");
    }
  }, [open, initialSection]);

  const version = React.useMemo(() => {
    try {
      return chrome.runtime.getManifest().version;
    } catch {
      return "";
    }
  }, []);

  const query = filter.trim().toLowerCase();
  const visibleSections = query
    ? SECTIONS.filter(
        (s) => s.label.toLowerCase().includes(query) || s.keywords.includes(query)
      )
    : SECTIONS;

  // Close the modal before opening one of the existing full dialogs / the bin,
  // so they don't stack on top of the settings surface.
  const runAndClose = (fn: () => void) => {
    onOpenChange(false);
    window.setTimeout(fn, 0);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        showCloseButton={false}
        className="w-[940px] max-w-[calc(100vw-2rem)] sm:max-w-[calc(100vw-2rem)] gap-0 overflow-hidden p-0"
        onInteractOutside={(event) => {
          // Keep Settings open when the interaction is with a nested dialog,
          // popover, select, or toast that portals outside this content.
          const target = event.detail.originalEvent.target as HTMLElement | null;
          if (
            target?.closest(
              "[role='dialog'],[role='alertdialog'],[data-radix-popper-content-wrapper],[data-sonner-toaster]"
            )
          ) {
            event.preventDefault();
          }
        }}
      >
        <DialogTitle className="sr-only">Settings</DialogTitle>
        <DialogDescription className="sr-only">
          Manage data, connectors, shared tabs, tags, search history, shortcuts, and feedback.
        </DialogDescription>

        <div className="flex h-[78vh] max-h-[640px] min-h-[460px]">
          {/* Left: navigation */}
          <nav className="flex w-[224px] shrink-0 flex-col border-r border-border-neutral-faded bg-background-page-secondary/40">
            <div className="p-3">
              <div className="relative">
                <SearchIcon className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-foreground-tertiary" />
                <input
                  ref={searchRef}
                  value={filter}
                  onChange={(e) => setFilter(e.target.value)}
                  placeholder="Search settings…"
                  aria-label="Search settings"
                  className="h-8 w-full rounded-md border border-border-neutral-faded bg-background-neutral pl-8 pr-2 text-[13px] text-foreground-neutral outline-none placeholder:text-foreground-tertiary focus-visible:ring-2 focus-visible:ring-border-neutral/60"
                />
              </div>
            </div>

            <ul className="flex-1 space-y-0.5 overflow-y-auto scrollbar-subtle px-2 pb-2">
              {visibleSections.map((section) => {
                const Icon = section.icon;
                const isActive = section.id === active;
                return (
                  <li key={section.id}>
                    <button
                      type="button"
                      onClick={() => setActive(section.id)}
                      aria-current={isActive ? "page" : undefined}
                      className={cn(
                        "relative flex w-full items-center gap-2.5 rounded-md px-2.5 py-2 text-left text-[13px] font-medium outline-none transition-colors duration-100 focus-visible:ring-2 focus-visible:ring-border-neutral/60",
                        isActive
                          ? "bg-accent-faded/60 text-foreground-neutral"
                          : "text-foreground-secondary hover:bg-background-neutral-faded hover:text-foreground-neutral"
                      )}
                    >
                      {isActive && (
                        <span className="absolute left-0 top-1/2 h-5 w-0.5 -translate-y-1/2 rounded-full bg-accent" />
                      )}
                      <Icon className={cn("size-4 shrink-0", isActive ? "text-accent" : "text-foreground-icon")} />
                      {section.label}
                    </button>
                  </li>
                );
              })}
              {visibleSections.length === 0 && (
                <li className="px-2.5 py-2 text-[13px] text-foreground-tertiary">No settings match “{filter}”.</li>
              )}
            </ul>

            <div className="space-y-1 border-t border-border-neutral-faded px-3.5 py-2.5">
              <a
                href={REPO_URL}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1.5 text-[11px] text-foreground-tertiary outline-none transition-colors hover:text-accent focus-visible:text-accent"
              >
                <Star className="size-3" />
                Star on GitHub
              </a>
              <div className="text-[11px] text-foreground-tertiary">
                by{" "}
                <a
                  href={AUTHOR_GITHUB_URL}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="outline-none transition-colors hover:text-foreground-secondary hover:underline focus-visible:text-foreground-secondary"
                >
                  {AUTHOR_NAME}
                </a>
                {version ? ` · v${version}` : ""}
              </div>
            </div>
          </nav>

          {/* Right: content */}
          <div className="relative flex min-w-0 flex-1 flex-col bg-background-neutral">
            <button
              type="button"
              onClick={() => onOpenChange(false)}
              aria-label="Close settings"
              className="absolute right-3 top-3 z-10 grid size-7 place-items-center rounded-full text-foreground-tertiary outline-none transition-colors hover:bg-background-neutral-faded hover:text-foreground-neutral focus-visible:ring-2 focus-visible:ring-border-neutral/60"
            >
              <X className="size-4" />
            </button>
            <div className="min-h-0 flex-1 overflow-y-auto scrollbar-subtle px-6 py-5">
              {active === "data" && (
                <DataSection
                  onImportBrowserBookmarks={() => runAndClose(onImportBrowserBookmarks)}
                  onImportGitHubStars={() => runAndClose(onImportGitHubStars)}
                  onImportSharedLink={() => runAndClose(onImportSharedLink)}
                  onDataChanged={onDataChanged}
                />
              )}
              {active === "tokens" && <TokensSection />}
              {active === "shared" && <SharedTabsSection />}
              {active === "history" && (
                <SearchHistorySection
                  recentQueryCount={recentQueryCount}
                  onClearHistory={onClearSearchHistory}
                  onOpenBin={() => runAndClose(onOpenBin)}
                />
              )}
              {active === "tags" && <TagsSection />}
              {active === "search" && <SearchSettingsSection />}
              {active === "misc" && <MiscSection />}
              {active === "shortcuts" && <ShortcutsSection />}
              {active === "feedback" && <FeedbackSection />}
            </div>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

export default SettingsModal;
