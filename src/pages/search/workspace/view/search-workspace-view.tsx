import { BulkActionsBar } from "@src/components/TabGroups/BulkActionsBar";
import { SelectionProvider } from "@src/components/TabGroups/SelectionContext";
import { TabGroups } from "@src/components/TabGroups/TabGroups";
import { OrganizeDndProvider } from "@src/components/dnd/OrganizeDndProvider";
import { ChevronRight } from "@src/components/icons/chevron-right";
import SidePanel from "@src/components/ui/SidePanel";
import { Button } from "@src/components/ui/button";
import { cn } from "@src/lib/utils";
import { SearchControlsBar } from "@src/pages/search/components/SearchControls";
import { SearchProcessStatus } from "@src/pages/search/components/SearchProcessStatus";
import { SearchQueryBar } from "@src/pages/search/components/SearchQueryBar";
import { SearchResults } from "@src/pages/search/components/SearchResults";
import {
  Sidebar,
  type SidebarProps,
} from "@src/pages/search/components/Sidebar/Sidebar";
import { SettingsModal } from "@src/pages/search/components/settings/SettingsModal";
import { ImportSharedDialog } from "@src/pages/search/components/share/ImportSharedDialog";
import { ShareDialog } from "@src/pages/search/components/share/ShareDialog";
import type { SearchResultMeta } from "../query/model";
import type { MixedShareSelection } from "@src/services/share-snapshot";
import { ArrowLeft, Globe2, Settings, Shield, XIcon } from "lucide-react";
import type { ComponentProps } from "react";
import { Toaster } from "sonner";
import { BrowserBookmarksImportDialog } from "../dialogs/browser-bookmarks-import-dialog";
import { ChangePrivatePasswordDialog } from "../dialogs/change-private-password-dialog";
import { CreateSpaceDialog } from "../dialogs/create-space-dialog";
import { CreateSpaceGroupDialog } from "../dialogs/create-space-group-dialog";
import { GitHubStarsImportDialog } from "../dialogs/github-stars-import-dialog";
import { PrivateSpaceAccessDialog } from "../dialogs/private-space-access-dialog";

type SharingView = {
  shareDialog: ComponentProps<typeof ShareDialog>;
  importDialog: ComponentProps<typeof ImportSharedDialog>;
};

type NavigationView = {
  panelOpen: boolean;
  onTogglePanel: () => void;
  sidebar: SidebarProps;
};

type QueryContextView = {
  activeSpaceName: string;
  isPrivateSpaceActive: boolean;
  isPrivateUnlocked: boolean;
  onChangePassword: () => void;
  debugAvailable: boolean;
  debugEnabled: boolean;
  onToggleDebug: () => void;
};

type QueryView = {
  bar: ComponentProps<typeof SearchQueryBar>;
  context: QueryContextView;
  processStatus: ComponentProps<typeof SearchProcessStatus>;
  controls: ComponentProps<typeof SearchControlsBar>;
};

type ResultSummaryView = {
  loading: boolean;
  resultMeta: SearchResultMeta;
  error: string | null;
  debugEnabled: boolean;
  requestedScope: string;
  showsVectorStats: boolean;
  topVectorScore: number | null;
  staleSuppressedCount: number;
  previousDisabled: boolean;
  nextDisabled: boolean;
  onPreviousPage: () => void;
  onNextPage: () => void;
};

type DialogsView = {
  privateAccess: ComponentProps<typeof PrivateSpaceAccessDialog>;
  changePassword: ComponentProps<typeof ChangePrivatePasswordDialog>;
  createSpace: ComponentProps<typeof CreateSpaceDialog>;
  createSpaceGroup: ComponentProps<typeof CreateSpaceGroupDialog>;
  browserBookmarks: ComponentProps<typeof BrowserBookmarksImportDialog>;
  githubStars: ComponentProps<typeof GitHubStarsImportDialog>;
};

type ResultContentView = {
  showEmptyState: boolean;
  queryHasText: boolean;
  onClearQuery: () => void;
  hasActiveQuery: boolean;
  searchResults: Omit<ComponentProps<typeof SearchResults>, "onCopy">;
  tabGroups: Omit<
    ComponentProps<typeof TabGroups>,
    "onShareSelectedItems" | "onShareFolder"
  >;
  bulkActions: Omit<
    ComponentProps<typeof BulkActionsBar>,
    "onShareSelectedItems"
  >;
  onShare: (selection: MixedShareSelection) => void;
  showReturnToResults: boolean;
  onReturnToResults: () => void;
  onDismissReturn: () => void;
};

export type SearchWorkspaceViewProps = {
  sharing: SharingView;
  navigation: NavigationView;
  settings: ComponentProps<typeof SettingsModal>;
  query: QueryView;
  summary: ResultSummaryView;
  dialogs: DialogsView;
  content: ResultContentView;
};

export function SearchWorkspaceView({
  sharing,
  navigation,
  settings,
  query,
  summary,
  dialogs,
  content,
}: SearchWorkspaceViewProps) {
  return (
    <SelectionProvider>
      <OrganizeDndProvider>
        <div
          id="search-results"
          data-theme="light"
          className={cn(
            "min-h-dvh bg-background-page relative transition-[padding] duration-400 ease-in-out",
            navigation.panelOpen && "md:pl-[272px]",
          )}
        >
          <ShareDialog {...sharing.shareDialog} />
          <ImportSharedDialog {...sharing.importDialog} />
          <NavigationPanel {...navigation} />
          <SettingsLauncher settings={settings} />
          <SearchHeader {...query} />
          <ResultSummary {...summary} />
          <WorkspaceDialogs {...dialogs} />
          <ResultContent {...content} />
          <WorkspaceToaster />
        </div>
      </OrganizeDndProvider>
    </SelectionProvider>
  );
}

function NavigationPanel({
  panelOpen,
  onTogglePanel,
  sidebar,
}: NavigationView) {
  return (
    <>
      <div
        className={cn(
          "fixed top-28 h-[70%] z-50 transition-transform duration-400 ease-in-out peer/sidepanel",
          {
            "left-4": panelOpen,
            "-translate-x-[calc(100%+8px)] left-0": !panelOpen,
          },
        )}
      >
        <SidePanel className="rounded-xl shadow-sm shadow-foreground-muted/60">
          <Sidebar {...sidebar} />
        </SidePanel>
      </div>
      <div
        className={cn("peer/bar", {
          "left-[calc(1rem+240px)] fixed top-30 h-[40%] w-8": panelOpen,
        })}
      />
      <button
        type="button"
        onClick={onTogglePanel}
        aria-label={panelOpen ? "Close sidebar" : "Open sidebar"}
        className={cn(
          "fixed top-34 p-1 z-50 shadow-sm shadow-foreground-muted/60 rounded-semi bg-background-page-secondary transition-all duration-400 ease-in-out group cursor-pointer hover:bg-background-highlight focus-visible:ring-2 focus-visible:ring-border-neutral/80 focus-visible:ring-offset-1",
          {
            "left-[calc(1rem+240px+8px)]": panelOpen,
            "left-2": !panelOpen,
            "opacity-100": !panelOpen,
            "opacity-0 hover:opacity-100 peer-hover/sidepanel:opacity-100 peer-hover/bar:opacity-100":
              panelOpen,
          },
        )}
      >
        <ChevronRight
          className={cn(
            "h-5 w-5 transition-all duration-300 text-foreground-tertiary group-hover:text-foreground-secondary",
            panelOpen && "rotate-180",
          )}
        />
      </button>
    </>
  );
}

function SettingsLauncher({
  settings,
}: {
  settings: ComponentProps<typeof SettingsModal>;
}) {
  return (
    <>
      <button
        type="button"
        onClick={() => settings.onOpenChange(true)}
        aria-label="Open settings"
        title="Settings"
        className="group fixed bottom-5 left-5 z-40 grid size-10 place-items-center rounded-full border border-border-neutral-faded bg-background-neutral text-foreground-secondary shadow-lg shadow-black/10 backdrop-blur transition-[transform,color,box-shadow] duration-150 hover:text-foreground-neutral focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-border-neutral/80 focus-visible:ring-offset-1 cursor-pointer"
      >
        <Settings className="size-[18px] transition-transform duration-300 group-hover:rotate-45" />
      </button>
      <SettingsModal {...settings} />
    </>
  );
}

function SearchHeader({ bar, context, processStatus, controls }: QueryView) {
  return (
    <div className="mt-3">
      <SearchQueryBar {...bar} />
      <div className="w-full max-w-5xl mx-auto mt-4 px-1">
        <div className="flex items-center justify-between gap-3 text-[11px] text-foreground-tertiary">
          <div className="flex items-center gap-2">
            <span className="inline-flex items-center gap-1 rounded-full border border-border-neutral-faded px-2 py-1 text-foreground-secondary">
              {context.isPrivateSpaceActive ? (
                <Shield size={12} />
              ) : (
                <Globe2 size={12} />
              )}
              {context.activeSpaceName}
            </span>
            {context.isPrivateSpaceActive && context.isPrivateUnlocked && (
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="h-6 rounded-full px-2 text-[11px]"
                onClick={context.onChangePassword}
              >
                Change password
              </Button>
            )}
            {context.debugAvailable && (
              <Button
                type="button"
                variant={context.debugEnabled ? "secondary" : "ghost"}
                size="sm"
                className="h-6 rounded-full px-2 text-[11px]"
                onClick={context.onToggleDebug}
              >
                {context.debugEnabled ? "Debug on" : "Debug off"}
              </Button>
            )}
          </div>
          <SearchProcessStatus {...processStatus} />
        </div>
        <div className="mt-2.5">
          <SearchControlsBar {...controls} />
        </div>
      </div>
    </div>
  );
}

function ResultSummary({
  loading,
  resultMeta,
  error,
  debugEnabled,
  requestedScope,
  showsVectorStats,
  topVectorScore,
  staleSuppressedCount,
  previousDisabled,
  nextDisabled,
  onPreviousPage,
  onNextPage,
}: ResultSummaryView) {
  return (
    <div className="w-full max-w-5xl mx-auto mt-3 px-1">
      <div className="mt-2 flex items-center justify-between gap-3 text-xs text-foreground-secondary">
        <div className="flex min-w-0 items-center">
          {loading ? (
            <span className="text-foreground-tertiary">
              Searching local data…
            </span>
          ) : (
            <>
              <span className="shrink-0 font-medium tabular-nums text-foreground-neutral">
                {resultMeta.total.toLocaleString()}
                {resultMeta.totalIsExact ? "" : "+"} result
                {resultMeta.total === 1 && resultMeta.totalIsExact ? "" : "s"}
              </span>
              <span className="truncate text-foreground-tertiary">
                {` · Page ${resultMeta.page}`}
                {resultMeta.hasMore ? " · more available" : ""}
                {debugEnabled
                  ? debugSummary({
                      requestedScope,
                      resultMeta,
                      showsVectorStats,
                      topVectorScore,
                      staleSuppressedCount,
                    })
                  : ""}
              </span>
              {resultMeta.vectorError ? (
                <span
                  className="shrink-0 text-foreground-danger"
                  title={resultMeta.vectorError}
                >
                  {" · vector error"}
                </span>
              ) : null}
              {error ? (
                <span className="shrink-0 text-foreground-danger" title={error}>
                  {" · error"}
                </span>
              ) : null}
            </>
          )}
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={previousDisabled}
            onClick={onPreviousPage}
            className="h-7 px-2 text-xs"
          >
            Prev
          </Button>
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={nextDisabled}
            onClick={onNextPage}
            className="h-7 px-2 text-xs"
          >
            Next
          </Button>
        </div>
      </div>
    </div>
  );
}

function debugSummary(options: {
  requestedScope: string;
  resultMeta: SearchResultMeta;
  showsVectorStats: boolean;
  topVectorScore: number | null;
  staleSuppressedCount: number;
}): string {
  const vector = options.showsVectorStats
    ? ` · ${options.resultMeta.vectorHits} vector`
    : "";
  const topScore =
    options.topVectorScore === null
      ? ""
      : ` · top ${options.topVectorScore.toFixed(3)}`;
  return ` · ${options.requestedScope} · ${options.resultMeta.mode} · ${options.resultMeta.lexicalHits} lexical${vector}${topScore} · stale ${options.staleSuppressedCount}`;
}

function WorkspaceDialogs({
  privateAccess,
  changePassword,
  createSpace,
  createSpaceGroup,
  browserBookmarks,
  githubStars,
}: DialogsView) {
  return (
    <>
      <PrivateSpaceAccessDialog {...privateAccess} />
      <ChangePrivatePasswordDialog {...changePassword} />
      <CreateSpaceDialog {...createSpace} />
      <CreateSpaceGroupDialog {...createSpaceGroup} />
      <BrowserBookmarksImportDialog {...browserBookmarks} />
      <GitHubStarsImportDialog {...githubStars} />
    </>
  );
}

function ResultContent({
  showEmptyState,
  queryHasText,
  onClearQuery,
  hasActiveQuery,
  searchResults,
  tabGroups,
  bulkActions,
  onShare,
  showReturnToResults,
  onReturnToResults,
  onDismissReturn,
}: ResultContentView) {
  return (
    <>
      {showEmptyState ? (
        <EmptySearchState
          queryHasText={queryHasText}
          onClearQuery={onClearQuery}
        />
      ) : hasActiveQuery ? (
        <SearchResults {...searchResults} onCopy={ignoreResultCopy} />
      ) : (
        <TabGroups
          {...tabGroups}
          onShareSelectedItems={(itemIds) => onShare(itemSelection(itemIds))}
          onShareFolder={(folderId) => onShare(folderSelection(folderId))}
        />
      )}
      <BulkActionsBar
        {...bulkActions}
        onShareSelectedItems={(itemIds) => onShare(itemSelection(itemIds))}
      />
      {showReturnToResults && (
        <ReturnToResults
          onReturn={onReturnToResults}
          onDismiss={onDismissReturn}
        />
      )}
    </>
  );
}

function EmptySearchState({
  queryHasText,
  onClearQuery,
}: {
  queryHasText: boolean;
  onClearQuery: () => void;
}) {
  return (
    <div className="w-full max-w-5xl mx-auto mt-10 rounded-xl border border-border-neutral-faded bg-background-page-secondary/80 px-6 py-8 text-center">
      <p className="text-base font-semibold text-foreground-neutral">
        No matching results
      </p>
      <p className="mt-1 text-sm text-foreground-secondary">
        Try a broader query, change scope, or remove a few filters.
      </p>
      {queryHasText && (
        <div className="mt-4 flex justify-center">
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={onClearQuery}
          >
            Clear query
          </Button>
        </div>
      )}
    </div>
  );
}

function ReturnToResults({
  onReturn,
  onDismiss,
}: {
  onReturn: () => void;
  onDismiss: () => void;
}) {
  return (
    <div className="fixed bottom-5 left-1/2 z-50 -translate-x-1/2">
      <div className="flex items-center gap-0.5 rounded-full border border-border-neutral-faded bg-background-neutral/95 px-1.5 py-1 shadow-lg shadow-black/10 backdrop-blur">
        <button
          type="button"
          onClick={onReturn}
          className="inline-flex items-center gap-1.5 rounded-full px-3 py-1 text-sm font-medium text-foreground-secondary transition-colors hover:bg-background-neutral-faded hover:text-foreground-neutral"
        >
          <ArrowLeft size={14} />
          Back to results
        </button>
        <button
          type="button"
          onClick={onDismiss}
          aria-label="Dismiss"
          className="grid size-7 place-items-center rounded-full text-foreground-tertiary transition-colors hover:bg-background-neutral-faded hover:text-foreground-neutral"
        >
          <XIcon size={14} />
        </button>
      </div>
    </div>
  );
}

function WorkspaceToaster() {
  return (
    <Toaster
      position="bottom-right"
      duration={2800}
      offset="16px"
      gap={8}
      closeButton
      className="vibe-toaster"
      icons={{ close: <XIcon size={14} strokeWidth={2.25} /> }}
      toastOptions={{
        style: {
          background: "var(--background-neutral)",
          color: "var(--foreground-neutral)",
          border: "1px solid var(--border-neutral-faded)",
          borderRadius: "10px",
          boxShadow: "var(--shadow-modal)",
          fontFamily: "var(--font-sans)",
          fontSize: "13px",
          lineHeight: "1.4",
          padding: "10px 14px",
          width: "320px",
        },
      }}
    />
  );
}

function ignoreResultCopy(): void {}

function itemSelection(itemIds: string[]): MixedShareSelection {
  return {
    folderIds: new Set(),
    itemIds: new Set(itemIds),
    spaceIds: new Set(),
    spaceGroupIds: new Set(),
  };
}

function folderSelection(folderId: string): MixedShareSelection {
  return {
    folderIds: new Set([folderId]),
    itemIds: new Set(),
    spaceIds: new Set(),
    spaceGroupIds: new Set(),
  };
}
