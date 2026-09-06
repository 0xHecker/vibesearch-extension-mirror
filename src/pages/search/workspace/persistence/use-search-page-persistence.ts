import { buildSearchSelectionSearch } from "@src/pages/search/selection-state";
import type { SpaceGroupDocType } from "@src/schemas/space_group_schema";
import { useEffect, useRef, type Dispatch, type SetStateAction } from "react";

type SearchPagePersistenceOptions = {
  activeSpaceId: string;
  activeSpaceGroupId: string | null;
  selectedFolderId: string;
  spaceCount: number;
  spaceGroups: SpaceGroupDocType[];
  itemCount: number;
  setActiveSpaceGroupId: Dispatch<SetStateAction<string | null>>;
  setSettingsOpen: Dispatch<SetStateAction<boolean>>;
};

/** Persists route selection and scroll state across extension-page reloads. */
export function useSearchPagePersistence({
  activeSpaceId,
  activeSpaceGroupId,
  selectedFolderId,
  spaceCount,
  spaceGroups,
  itemCount,
  setActiveSpaceGroupId,
  setSettingsOpen,
}: SearchPagePersistenceOptions): void {
  const didValidateSelection = useRef(false);
  const scrollKey = useRef("");
  const scrollRestored = useRef(false);
  scrollKey.current = `vibesearch:scroll:${activeSpaceId}|${activeSpaceGroupId ?? ""}|${selectedFolderId}`;

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent): void => {
      const opensSettings =
        (event.metaKey || event.ctrlKey) &&
        !event.altKey &&
        !event.shiftKey &&
        event.key === ",";
      if (!opensSettings) return;
      event.preventDefault();
      setSettingsOpen(true);
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [setSettingsOpen]);

  useEffect(() => {
    try {
      const search = buildSearchSelectionSearch({
        currentSearch: window.location.search,
        activeSpaceId,
        activeSpaceGroupId,
        selectedFolderId,
      });
      const query = search ? `?${search}` : "";
      window.history.replaceState(
        window.history.state,
        "",
        `${window.location.pathname}${query}${window.location.hash}`,
      );
    } catch {
      // Navigation still works when history state is unavailable.
    }
  }, [activeSpaceGroupId, activeSpaceId, selectedFolderId]);

  useEffect(() => {
    if (didValidateSelection.current) return;
    if (spaceCount === 0 && spaceGroups.length === 0) return;
    didValidateSelection.current = true;
    const groupExists = spaceGroups.some(
      (group) => group.id === activeSpaceGroupId,
    );
    if (activeSpaceGroupId && !groupExists) setActiveSpaceGroupId(null);
  }, [activeSpaceGroupId, setActiveSpaceGroupId, spaceCount, spaceGroups]);

  useEffect(() => {
    window.history.scrollRestoration = "manual";
    let animationFrame = 0;
    const saveScroll = (): void => {
      try {
        sessionStorage.setItem(
          scrollKey.current,
          String(Math.round(window.scrollY)),
        );
      } catch {
        // Scroll restoration is optional when session storage is unavailable.
      }
    };
    const handleScroll = (): void => {
      cancelAnimationFrame(animationFrame);
      animationFrame = requestAnimationFrame(saveScroll);
    };
    window.addEventListener("scroll", handleScroll, { passive: true });
    window.addEventListener("pagehide", saveScroll);
    return () => {
      window.removeEventListener("scroll", handleScroll);
      window.removeEventListener("pagehide", saveScroll);
      cancelAnimationFrame(animationFrame);
    };
  }, []);

  useEffect(() => {
    if (scrollRestored.current || itemCount === 0) return;
    scrollRestored.current = true;
    let savedPosition = 0;
    try {
      savedPosition = Number(sessionStorage.getItem(scrollKey.current) ?? 0);
    } catch {
      return;
    }
    if (!savedPosition || Number.isNaN(savedPosition)) return;
    requestAnimationFrame(() =>
      requestAnimationFrame(() =>
        window.scrollTo({ top: savedPosition, behavior: "auto" }),
      ),
    );
  }, [itemCount]);
}
