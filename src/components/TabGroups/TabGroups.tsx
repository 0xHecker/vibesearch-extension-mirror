import { TabGroup } from "@components/TabGroups/TabGroup";
import { FolderDocType } from "@src/schemas/folder_schema";
import { ItemDocType } from "@src/schemas/item_schema";
import { groupItemsByFolder } from "./group-items-by-folder";
import { TooltipProvider } from "../ui/tooltip";
import { memo, useEffect, useMemo, useRef, useState } from "react";
import { ViewToggle } from "./ViewToggle";
import { cn } from "@src/lib/utils";
import { GripVertical } from "lucide-react";
import type { DragEndEvent } from "@dnd-kit/core";
import { SortableContext, arrayMove, verticalListSortingStrategy } from "@dnd-kit/sortable";
import { useOrganizeDnd } from "@src/components/dnd/OrganizeDndProvider";
import { ConfirmDialog } from "../ui/confirm-dialog";
import type { QueryRankDebugScore } from "@src/search-core/contracts";

export type SpaceMoveOption = {
  id: string;
  name: string;
  isPrivate: boolean;
  access?: {
    isUnlocked?: boolean;
  };
};

interface TabGroupsProps {
  folders: FolderDocType[];
  items: ItemDocType[];
  spaces: SpaceMoveOption[];
  preserveInputOrder?: boolean;
  revealItemId?: string;
  debugScoresByItemId?: Record<string, QueryRankDebugScore>;
  showDebugScores?: boolean;
  onShareSelectedItems?: (itemIds: string[]) => void;
  onShareFolder?: (folderId: string) => void;
}

const VIEW_STORAGE_KEY = "vibe-search-view-mode";

const TabGroupsComponent = ({
  folders,
  items,
  spaces,
  preserveInputOrder = false,
  revealItemId,
  debugScoresByItemId,
  showDebugScores = false,
  onShareSelectedItems,
  onShareFolder,
}: TabGroupsProps) => {
  const containerRef = useRef<HTMLDivElement>(null);
  const [sentForFetch, setSentForFetch] = useState(new Set<string>());
  // Drag mode is off by default: rows render statically (no dnd-kit per item).
  // Turning it on swaps rows for their sortable variant so reordering works.
  const [dragMode, setDragMode] = useState(false);
  const [itemsState, setItemsState] = useState<ItemDocType[]>(items);
  const [foldersState, setFoldersState] = useState<FolderDocType[]>(folders);
  const [mergePrompt, setMergePrompt] = useState<
    { sourceId: string; targetId: string; sourceName: string; targetName: string; count: number } | null
  >(null);

  // Drop logic is registered into the shared page-level OrganizeDnd context
  // (one DndContext for the whole page) rather than a context owned here.
  const { registerResolver, requestConfirmation } = useOrganizeDnd();

  // Initialize from localStorage
  const [viewMode, setViewMode] = useState<"list" | "grid">(() => {
    try {
      const stored = localStorage.getItem(VIEW_STORAGE_KEY);
      if (stored === "grid" || stored === "list") return stored;
    } catch {}
    return "grid";
  });

  // Persist view mode to localStorage
  useEffect(() => {
    try {
      localStorage.setItem(VIEW_STORAGE_KEY, viewMode);
    } catch {}
  }, [viewMode]);

  useEffect(() => {
    setItemsState(items);
  }, [items]);

  // Keyboard shortcut: press "O" (no modifiers) to toggle Organize mode.
  // Ignored while typing in inputs/textareas/contenteditable so it never
  // hijacks search or rename fields. Modifier combos pass through to the
  // browser (e.g. Cmd+O), avoiding conflicts with native shortcuts.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      if (event.key !== "o" && event.key !== "O") return;
      const el = document.activeElement as HTMLElement | null;
      if (
        el &&
        (el.tagName === "INPUT" ||
          el.tagName === "TEXTAREA" ||
          el.isContentEditable)
      ) {
        return;
      }
      event.preventDefault();
      setDragMode((value) => !value);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  const itemsNeedingMeta = useMemo(() => {
    return new Set(items.filter((i) => !i.isMetaFetched).map((i) => i.url));
  }, [items]);

  const sortFolders = (list: FolderDocType[]) =>
    [...list].sort((a, b) => {
      if (!!a.isPinned !== !!b.isPinned) return a.isPinned ? -1 : 1;
      const ao = a.sortOrder ?? Number.MAX_SAFE_INTEGER;
      const bo = b.sortOrder ?? Number.MAX_SAFE_INTEGER;
      if (ao !== bo) return ao - bo;
      return a.createdAt - b.createdAt;
    });

  useEffect(() => {
    setFoldersState(sortFolders(folders));
  }, [folders]);

  const orderedFolders = useMemo(() => sortFolders(foldersState), [foldersState]);

  const orderedItemsForFolder = (folderId: string, sourceItems: ItemDocType[] = itemsState) => {
    const folderItems = sourceItems.filter((i) => i.folderId === folderId);
    if (preserveInputOrder) {
      return folderItems;
    }
    return [...folderItems].sort((a, b) => {
      const ao = a.chunkOrder ?? Number.MAX_SAFE_INTEGER;
      const bo = b.chunkOrder ?? Number.MAX_SAFE_INTEGER;
      if (ao !== bo) return ao - bo;
      return b.createdAt - a.createdAt;
    });
  };

  // Memoized per-folder items so TabGroup props stay referentially stable
  // and memo'd TabGroup/FlatItem/GridItem don't re-render on unrelated parent updates.
  const itemsByFolder = useMemo(() => {
    return groupItemsByFolder(
      orderedFolders,
      itemsState,
      preserveInputOrder,
      revealItemId
    );
  }, [orderedFolders, itemsState, preserveInputOrder, revealItemId]);

  const itemCountsByFolderTree = useMemo(() => {
    const childrenByParent = new Map<string | null, FolderDocType[]>();
    for (const folder of orderedFolders) {
      const parentId = folder.parentId ?? null;
      const children = childrenByParent.get(parentId) || [];
      children.push(folder);
      childrenByParent.set(parentId, children);
    }

    const counts = new Map<string, number>();
    const countTree = (folderId: string): number => {
      const cached = counts.get(folderId);
      if (cached !== undefined) return cached;
      let count = itemsByFolder.get(folderId)?.length || 0;
      for (const child of childrenByParent.get(folderId) || []) {
        count += countTree(child.id);
      }
      counts.set(folderId, count);
      return count;
    };

    for (const folder of orderedFolders) {
      countTree(folder.id);
    }
    return counts;
  }, [itemsByFolder, orderedFolders]);

  // Ref to track sent URLs to avoid effect re-runs causing observer churn
  const sentForFetchRef = useRef(sentForFetch);
  sentForFetchRef.current = sentForFetch;

  // Ref so the observer callback always reads the latest needing-meta set
  // without forcing the effect to re-run on every metadata fetch.
  const itemsNeedingMetaRef = useRef(itemsNeedingMeta);
  itemsNeedingMetaRef.current = itemsNeedingMeta;

  useEffect(() => {
    const root = containerRef.current || null;
    if (itemsNeedingMetaRef.current.size === 0) return;

    const observer = new IntersectionObserver(
      (entries) => {
        const newlyVisible: string[] = [];
        const needing = itemsNeedingMetaRef.current;
        for (const entry of entries) {
          const url = (entry.target as HTMLElement).dataset["url"];
          if (!url) continue;

          // Check if the item needs metadata and hasn't been sent for fetching yet.
          if (
            entry.isIntersecting &&
            needing.has(url) &&
            !sentForFetchRef.current.has(url)
          ) {
            newlyVisible.push(url);
          }
        }

        if (newlyVisible.length > 0) {
          // Optimistically mark as sent to prevent re-sending.
          setSentForFetch((prev) => new Set([...prev, ...newlyVisible]));
          try {
            chrome.runtime.sendMessage({
              target: "background",
              type: "FETCH_METADATA",
              payload: { urls: newlyVisible },
            });
          } catch (e) {
            console.warn(
              "Failed to send metadata fetch request, will retry on next visibility.",
              e
            );
            // If sending fails, remove from the sent set so it can be picked up again.
            setSentForFetch((prev) => {
              const next = new Set(prev);
              newlyVisible.forEach((u) => next.delete(u));
              return next;
            });
          }
        }
      },
      { root: root, rootMargin: "600px 0px", threshold: 0.01 }
    );

    const observeItemNodes = (root: Element | Document) => {
      const nodes = root.querySelectorAll<HTMLElement>('[data-observe="item"]');
      nodes.forEach((n) => observer.observe(n));
    };

    observeItemNodes(root || document);

    // Watch for item nodes added after mount (e.g. when a collapsed folder expands
    // and its subtree mounts). Re-observing an already-observed node is a no-op.
    const mutationObserver = new MutationObserver((mutations) => {
      for (const mutation of mutations) {
        for (const node of mutation.addedNodes) {
          if (!(node instanceof HTMLElement)) continue;
          if (node.dataset["observe"] === "item") {
            observer.observe(node);
          }
          const nested = node.querySelectorAll<HTMLElement>('[data-observe="item"]');
          nested.forEach((n) => observer.observe(n));
        }
      }
    });
    mutationObserver.observe(root || document.body, { childList: true, subtree: true });

    return () => {
      observer.disconnect();
      mutationObserver.disconnect();
    };
    // Only tear down when the item count changes (mount/unmount of whole items),
    // not on every metadata fetch — that was the source of the observer churn.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [items.length]);

  const handleFolderReorder = async (activeId: string, overId: string) => {
    let nextIds: string[] = [];
    let spaceId: string | undefined;
    setFoldersState((prev) => {
      const uniqueSpaceIds = new Set(prev.map((folder) => folder.spaceId));
      if (uniqueSpaceIds.size > 1) return prev;
      const ids = prev.map((f) => f.id);
      const oldIndex = ids.indexOf(activeId);
      const newIndex = ids.indexOf(overId);
      if (oldIndex === -1 || newIndex === -1) return prev;
      nextIds = arrayMove(ids, oldIndex, newIndex);
      const lookup = new Map(prev.map((f) => [f.id, f]));
      const first = prev[0];
      spaceId = first?.spaceId;
      return nextIds.map((id) => lookup.get(id)!).filter(Boolean);
    });
    if (nextIds.length > 0) {
      try {
        await chrome.runtime.sendMessage({
          service: "folders",
          type: "reorder",
          target: "offscreen",
          payload: { orderedIds: nextIds, spaceId },
        });
      } catch (e) {
        console.error("Failed to persist folder order", e);
      }
    }
  };

  const persistItemOrder = async (
    foldersToUpdate: { folderId: string; orderedIds: string[] }[]
  ) => {
    if (foldersToUpdate.length === 0) return;
    try {
      await chrome.runtime.sendMessage({
        service: "items",
        type: "reorder",
        target: "offscreen",
        payload: { folders: foldersToUpdate },
      });
    } catch (e) {
      console.error("Failed to persist item order", e);
    }
  };

  const reorderWithinFolder = async (folderId: string, activeId: string, overId: string) => {
    let nextIds: string[] = [];
    setItemsState((prev) => {
      const list = orderedItemsForFolder(folderId, prev);
      const ids = list.map((i) => i.id);
      const oldIndex = ids.indexOf(activeId);
      const newIndex = ids.indexOf(overId);
      if (oldIndex === -1 || newIndex === -1) return prev;
      nextIds = arrayMove(ids, oldIndex, newIndex);
      const orderMap = new Map<string, { folderId: string; chunkOrder: number }>();
      nextIds.forEach((id, idx) => orderMap.set(id, { folderId, chunkOrder: idx }));
      return prev.map((item) => {
        const update = orderMap.get(item.id);
        return update ? { ...item, ...update } : item;
      });
    });
    if (nextIds.length > 0) {
      persistItemOrder([{ folderId, orderedIds: nextIds }]);
    }
  };

  const moveItems = async (
    ids: string[],
    sourceFolderId: string,
    targetFolderId: string,
    overId?: string
  ) => {
    let sourceIds: string[] = [];
    let targetIds: string[] = [];
    setItemsState((prev) => {
      const sourceList = orderedItemsForFolder(sourceFolderId, prev).map((i) => i.id);
      const targetList = orderedItemsForFolder(targetFolderId, prev).map((i) => i.id);
      sourceIds = sourceList.filter((id) => !ids.includes(id));
      targetIds = targetList.filter((id) => !ids.includes(id));
      const insertionIndex =
        overId && targetIds.includes(overId) ? targetIds.indexOf(overId) : targetIds.length;
      targetIds.splice(insertionIndex, 0, ...ids);

      const updates = new Map<string, { folderId: string; chunkOrder: number }>();
      sourceIds.forEach((id, idx) =>
        updates.set(id, { folderId: sourceFolderId, chunkOrder: idx })
      );
      targetIds.forEach((id, idx) =>
        updates.set(id, { folderId: targetFolderId, chunkOrder: idx })
      );

      return prev.map((item) => {
        const update = updates.get(item.id);
        return update ? { ...item, ...update } : item;
      });
    });

    persistItemOrder([
      { folderId: sourceFolderId, orderedIds: sourceIds },
      { folderId: targetFolderId, orderedIds: targetIds },
    ]);
  };

  const resolveTargetFolder = (over: DragEndEvent["over"]) => {
    if (!over) return null;
    const overData = over.data.current as any;
    if (overData?.type === "item") return overData.folderId as string;
    if (overData?.type === "folder-drop") return overData.folderId as string;
    if (overData?.type === "folder") return overData.folder.id as string;
    return null;
  };

  const mergeFolders = async (sourceId: string, targetId: string) => {
    // Optimistic: reassign the source's items to the target and drop the source.
    // The canonical merge (folders.mergeInto) then persists it server-side and
    // a DB_CHANGE reconciles. Same rule everywhere — see docs/drag-and-drop.md.
    setItemsState((prev) =>
      prev.map((item) =>
        item.folderId === sourceId ? { ...item, folderId: targetId } : item
      )
    );
    setFoldersState((prev) => prev.filter((f) => f.id !== sourceId));
    try {
      await chrome.runtime.sendMessage({
        service: "folders",
        type: "mergeInto",
        target: "offscreen",
        payload: { sourceFolderId: sourceId, targetFolderId: targetId },
      });
    } catch (e) {
      console.error("Failed to merge tab groups", e);
    }
  };

  const promptFolderMerge = (sourceId: string, targetId: string) => {
    const source = foldersState.find((f) => f.id === sourceId);
    const target = foldersState.find((f) => f.id === targetId);
    if (!source || !target) return;
    const count = itemsState.filter((i) => i.folderId === sourceId).length;
    setMergePrompt({
      sourceId,
      targetId,
      sourceName: source.name,
      targetName: target.name,
      count,
    });
  };

  const resolveMainAreaDrop = (event: DragEndEvent): boolean => {
    const { active, over } = event;
    if (!over) return false;
    const activeData = active.data.current as any;
    const overData = over.data.current as any;

    if (activeData?.type === "folder") {
      const targetFolderId =
        overData?.type === "folder"
          ? (over.id as string)
          : overData?.type === "folder-drop"
            ? (overData.folderId as string)
            : null;
      if (targetFolderId === (active.id as string)) return true;
      if (!targetFolderId) return false;
      // Center band of the target = MERGE (with confirm); otherwise reorder.
      const overRect = over.rect;
      const activeRect = active.rect.current.translated;
      let relative = 0.5;
      if (activeRect && overRect.height > 0) {
        const activeCenterY = activeRect.top + activeRect.height / 2;
        relative = (activeCenterY - overRect.top) / overRect.height;
      }
      if (relative > 0.3 && relative < 0.7) {
        promptFolderMerge(active.id as string, targetFolderId);
      } else {
        handleFolderReorder(active.id as string, targetFolderId);
      }
      return true;
    }

    if (activeData?.type === "item") {
      const targetFolderId = resolveTargetFolder(over);
      const sourceFolderId = activeData.folderId as string;
      // Not a main-area target — let another surface's resolver (e.g. the
      // sidebar) try to handle this drop.
      if (!targetFolderId) return false;
      const idsToMove =
        Array.isArray(activeData.selectedIds) && activeData.selectedIds.length > 0
          ? Array.from(new Set<string>(activeData.selectedIds))
          : [activeData.item.id as string];

      if (targetFolderId === sourceFolderId && overData?.type === "item") {
        reorderWithinFolder(sourceFolderId, active.id as string, over.id as string);
      } else {
        const overItemId = overData?.type === "item" ? (over.id as string) : undefined;
        const runMove = () => moveItems(idsToMove, sourceFolderId, targetFolderId, overItemId);
        if (idsToMove.length > 20) {
          requestConfirmation({
            title: `Move ${idsToMove.length} tabs?`,
            description: `This moves ${idsToMove.length} tabs into the target tab group.`,
            confirmLabel: "Move",
            variant: "warning",
            onConfirm: runMove,
          });
        } else {
          runMove();
        }
      }
      return true;
    }
    return false;
  };

  // Keep the latest drop logic in a ref so the registration effect subscribes
  // exactly once (and never churns as items/folders state changes mid-session).
  const resolveMainAreaDropRef = useRef(resolveMainAreaDrop);
  resolveMainAreaDropRef.current = resolveMainAreaDrop;

  useEffect(() => {
    return registerResolver((event) => resolveMainAreaDropRef.current(event));
  }, [registerResolver]);

  return (
    <TooltipProvider>
        <div ref={containerRef} className="w-full h-fit max-w-[1090px] mx-auto mt-1 pb-14">
          {/* View toggle (top-right). The Organize/drag toggle is a floating
              control pinned at bottom-left (rendered below) with an "O" shortcut. */}
          <div className="flex items-center justify-end gap-2 mb-4 px-4">
            <ViewToggle view={viewMode} onViewChange={setViewMode} />
          </div>

          <SortableContext
            items={orderedFolders.map((f) => f.id)}
            strategy={verticalListSortingStrategy}
          >
            <div className="flex flex-col gap-4">
              {orderedFolders.map((folder) => {
                const folderItems = itemsByFolder.get(folder.id) || [];
                return (
                  <TabGroup
                    key={folder.id}
                    folder={folder}
                    items={folderItems}
                    allFolders={orderedFolders}
                    treeItemCount={itemCountsByFolderTree.get(folder.id) ?? folderItems.length}
                    spaces={spaces}
                    viewMode={viewMode}
                    debugScoresByItemId={debugScoresByItemId}
                    showDebugScores={showDebugScores}
                    onShareSelectedItems={onShareSelectedItems}
                    onShareFolder={onShareFolder}
                    dragMode={dragMode}
                    revealItemId={revealItemId}
                  />
                );
              })}
            </div>
          </SortableContext>
        </div>

        {/* Floating Organize toggle — pinned bottom-left, with an "O" shortcut.
            Governs drag/reorder for both list and grid (and, later, cross-surface
            moves). Kept out of the content flow so it's always reachable. */}
        <button
          type="button"
          onClick={() => setDragMode((value) => !value)}
          aria-pressed={dragMode}
          title={dragMode ? "Exit Organize mode (O)" : "Organize — drag to reorder & move (O)"}
          className={cn(
            "fixed bottom-5 left-[4.25rem] z-40 inline-flex h-10 items-center gap-2 rounded-full border px-4 text-sm font-medium shadow-lg shadow-black/10 backdrop-blur transition-[background-color,color,box-shadow] duration-200 cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-border-neutral/80 focus-visible:ring-offset-1",
            dragMode
              ? "border-accent/40 bg-accent-faded text-accent"
              : "border-border-neutral-faded bg-background-neutral/95 text-foreground-secondary hover:bg-background-neutral hover:text-foreground-neutral"
          )}
        >
          <GripVertical size={16} />
          {dragMode ? "Done" : "Organize"}
        </button>

        <ConfirmDialog
          open={!!mergePrompt}
          onOpenChange={(open) => {
            if (!open) setMergePrompt(null);
          }}
          title={
            mergePrompt
              ? `Merge "${mergePrompt.sourceName}" into "${mergePrompt.targetName}"?`
              : ""
          }
          description={
            mergePrompt
              ? `This moves ${mergePrompt.count} tab${
                  mergePrompt.count === 1 ? "" : "s"
                } into "${mergePrompt.targetName}" and removes "${mergePrompt.sourceName}". This can't be undone.`
              : ""
          }
          confirmLabel="Merge"
          variant="danger"
          onConfirm={async () => {
            if (!mergePrompt) return;
            const { sourceId, targetId } = mergePrompt;
            setMergePrompt(null);
            await mergeFolders(sourceId, targetId);
          }}
        />
    </TooltipProvider>
  );
};

export const TabGroups = memo(TabGroupsComponent);
