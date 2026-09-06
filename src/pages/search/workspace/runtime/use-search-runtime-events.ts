import type { SearchProcessStatusItem } from "@src/pages/search/components/SearchProcessStatus";
import type { FolderLoadContext } from "../library/use-library-data";
import type { SpaceGroupDocType } from "@src/schemas/space_group_schema";
import type { QueryScope } from "@src/search-core/contracts";
import type { SpaceListItem } from "@src/services/spaces/types";
import {
  useEffect,
  type Dispatch,
  type MutableRefObject,
  type SetStateAction,
} from "react";
import {
  parseSearchRuntimeEvent,
  parseSidePanelOpen,
  type SearchRuntimeEvent,
} from "./contracts";

type SearchRuntimeEventsOptions = {
  activeSpaceId: string;
  activeSpaceGroupId: string | null;
  activeSpaceGroupSpaceIds: string[];
  requestedScope: QueryScope;
  visibleItemIds: MutableRefObject<Set<string>>;
  hasConstrainedQuery: MutableRefObject<boolean>;
  setPanelOpen: Dispatch<SetStateAction<boolean>>;
  loadFolders: (context?: FolderLoadContext) => Promise<void>;
  loadSpaces: () => Promise<SpaceListItem[]>;
  loadSpaceGroups: () => Promise<SpaceGroupDocType[]>;
  loadBinContents: () => Promise<void>;
  scheduleTagReload: () => void;
  scheduleQueryRefresh: (priority: "high" | "low") => void;
  queueMetadataItemPatches: (changedItemIds: string[]) => boolean;
  upsertProcessStatus: (status: SearchProcessStatusItem) => void;
};

/** Bridges validated extension runtime events into search workspace refreshes. */
export function useSearchRuntimeEvents({
  activeSpaceId,
  activeSpaceGroupId,
  activeSpaceGroupSpaceIds,
  requestedScope,
  visibleItemIds,
  hasConstrainedQuery,
  setPanelOpen,
  loadFolders,
  loadSpaces,
  loadSpaceGroups,
  loadBinContents,
  scheduleTagReload,
  scheduleQueryRefresh,
  queueMetadataItemPatches,
  upsertProcessStatus,
}: SearchRuntimeEventsOptions): void {
  useEffect(() => {
    chrome.storage.local.get("sidePanelOpen", (value) => {
      const isOpen = parseSidePanelOpen(value);
      if (isOpen !== null) setPanelOpen(isOpen);
    });

    const handleMessage = (value: any): void => {
      const event = parseSearchRuntimeEvent(value);
      if (!event) return;
      if (event.type === "PROCESS_STATUS") {
        upsertProcessStatus(event.payload);
        return;
      }
      handleDatabaseChange(event);
    };

    const reloadFolders = (): void => {
      void loadFolders({
        activeSpaceId,
        searchScope: activeSpaceGroupId ? "global" : requestedScope,
        spaceIds: activeSpaceGroupId ? activeSpaceGroupSpaceIds : undefined,
      });
    };

    const handleDatabaseChange = (
      event: Extract<SearchRuntimeEvent, { type: "DB_CHANGE" }>,
    ): void => {
      if (event.scope === "tags") {
        scheduleTagReload();
        return;
      }

      if (event.scope === "folders") {
        reloadFolders();
        void loadBinContents();
      }
      if (event.scope === "space_groups") {
        void loadSpaceGroups();
        return;
      }
      if (event.scope === "spaces") {
        void loadSpaces();
        void loadSpaceGroups();
        void loadBinContents();
        reloadFolders();
        scheduleQueryRefresh("high");
        return;
      }
      if (event.scope !== "items" && event.scope !== "folders") return;

      if (event.scope === "items" && event.itemChangeKind !== "metadata") {
        void loadBinContents();
      }
      scheduleTagReload();

      const changedIds = event.changedItemIds ?? [];
      if (event.scope === "items" && changedIds.length > 0) {
        if (event.itemChangeKind === "metadata") {
          queueMetadataItemPatches(changedIds);
          if (!hasConstrainedQuery.current) return;
          scheduleQueryRefresh("low");
          return;
        }
        const hasVisibleImpact = changedIds.some((id) =>
          visibleItemIds.current.has(id),
        );
        if (!hasVisibleImpact && hasConstrainedQuery.current) {
          scheduleQueryRefresh("low");
          return;
        }
      }
      scheduleQueryRefresh("high");
    };

    chrome.runtime.onMessage.addListener(handleMessage);
    return () => {
      chrome.runtime.onMessage.removeListener(handleMessage);
    };
  }, [
    activeSpaceGroupId,
    activeSpaceGroupSpaceIds,
    activeSpaceId,
    hasConstrainedQuery,
    loadBinContents,
    loadFolders,
    loadSpaceGroups,
    loadSpaces,
    queueMetadataItemPatches,
    requestedScope,
    scheduleQueryRefresh,
    scheduleTagReload,
    setPanelOpen,
    upsertProcessStatus,
    visibleItemIds,
  ]);
}
