import { useDraggable, useDroppable, type DragEndEvent } from "@dnd-kit/core";
import {
  useOrganizeDnd,
  type ConfirmRequest,
} from "@src/components/dnd/OrganizeDndProvider";
import type { FolderDocType } from "@src/schemas/folder_schema";
import type { SpaceGroupDocType } from "@src/schemas/space_group_schema";
import { useEffect, useRef, type ReactNode } from "react";
import { z } from "zod";

import type { SidebarSpace } from "./sidebar-sort";
import type { SidebarHandlers } from "./sidebar-types";

const sidebarDndDataSchema = z.object({
  surface: z.literal("sidebar"),
  kind: z.enum(["folder", "space", "spaceGroup", "root", "ungrouped"]),
  id: z.string().optional(),
  name: z.string().optional(),
  spaceId: z.string().optional(),
  parentId: z.string().nullable().optional(),
  spaceGroupId: z.string().nullable().optional(),
  collapsed: z.boolean().optional(),
  springId: z.string().optional(),
});

const itemDragDataSchema = z.object({
  type: z.literal("item"),
  item: z.object({
    id: z.string(),
    spaceId: z.string().optional(),
  }),
  selectedIds: z.array(z.string()).optional(),
});

const folderDragDataSchema = z.object({
  type: z.literal("folder"),
  folder: z.object({
    id: z.string(),
    name: z.string().optional(),
    spaceId: z.string().optional(),
  }),
});

const pointerEventSchema = z.object({ clientY: z.number() });

export type SidebarDndData = z.infer<typeof sidebarDndDataSchema>;

type SidebarDndRender = {
  setNodeRef: (node: HTMLElement | null) => void;
  listeners: ReturnType<typeof useDraggable>["listeners"];
  attributes: ReturnType<typeof useDraggable>["attributes"];
  isOver: boolean;
  isDragging: boolean;
};

type SidebarDndProps = {
  id: string;
  data: SidebarDndData;
  disabled?: boolean;
  children: (props: SidebarDndRender) => ReactNode;
};

export function SidebarDnd({
  id,
  data,
  disabled = false,
  children,
}: SidebarDndProps) {
  const draggable = useDraggable({ id, data, disabled });
  const droppable = useDroppable({ id, data });
  const setNodeRef = (node: HTMLElement | null) => {
    draggable.setNodeRef(node);
    droppable.setNodeRef(node);
  };

  return (
    <>
      {children({
        setNodeRef,
        listeners: draggable.listeners,
        attributes: draggable.attributes,
        isOver: droppable.isOver,
        isDragging: draggable.isDragging,
      })}
    </>
  );
}

type SidebarDropZoneProps = {
  id: string;
  data: SidebarDndData;
  children: (props: {
    setNodeRef: (node: HTMLElement | null) => void;
    isOver: boolean;
  }) => ReactNode;
};

export function SidebarDropZone({ id, data, children }: SidebarDropZoneProps) {
  const { setNodeRef, isOver } = useDroppable({ id, data });
  return <>{children({ setNodeRef, isOver })}</>;
}

type SidebarDropResolverOptions = {
  activeSpaceId: string;
  activeSpaceGroupId: string | null;
  sortedSpaces: SidebarSpace[];
  sortedSpaceGroups: SpaceGroupDocType[];
  ungroupedSpaces: SidebarSpace[];
  spacesByGroupId: Map<string, SidebarSpace[]>;
  folderChildren: Map<string | null, FolderDocType[]>;
  handlers: SidebarHandlers;
};

type DropContext = SidebarDropResolverOptions & {
  requestConfirmation: (request: ConfirmRequest) => void;
};

export function useSidebarDropResolver(
  options: SidebarDropResolverOptions,
): void {
  const { registerResolver, requestConfirmation } = useOrganizeDnd();
  const context = { ...options, requestConfirmation };
  const resolverRef = useRef<(event: DragEndEvent) => boolean>(() => false);
  resolverRef.current = (event) => resolveSidebarDrop(event, context);

  useEffect(
    () => registerResolver((event) => resolverRef.current(event)),
    [registerResolver],
  );
}

function resolveSidebarDrop(
  event: DragEndEvent,
  context: DropContext,
): boolean {
  const overResult = sidebarDndDataSchema.safeParse(event.over?.data.current);
  if (!overResult.success) return false;
  const target = overResult.data;

  const sidebarDragResult = sidebarDndDataSchema.safeParse(
    event.active.data.current,
  );
  if (!sidebarDragResult.success) {
    return resolveExternalDrop(event, target, context);
  }

  const dragged = sidebarDragResult.data;
  const zone = computeSidebarZone(event);
  if (dragged.kind === "folder") {
    return resolveFolderDrop(dragged, target, zone, context);
  }
  if (dragged.kind === "space") {
    return resolveSpaceDrop(dragged, target, zone, context);
  }
  if (dragged.kind === "spaceGroup") {
    return resolveSpaceGroupDrop(dragged, target, zone, context);
  }
  return false;
}

function resolveExternalDrop(
  event: DragEndEvent,
  target: SidebarDndData,
  context: DropContext,
): boolean {
  const itemResult = itemDragDataSchema.safeParse(event.active.data.current);
  if (itemResult.success) {
    return resolveExternalItemDrop(itemResult.data, target, context);
  }

  const folderResult = folderDragDataSchema.safeParse(
    event.active.data.current,
  );
  if (folderResult.success) {
    return resolveExternalFolderDrop(folderResult.data.folder, target, context);
  }
  return false;
}

function resolveExternalItemDrop(
  drag: z.infer<typeof itemDragDataSchema>,
  target: SidebarDndData,
  context: DropContext,
): boolean {
  const itemIds =
    drag.selectedIds && drag.selectedIds.length > 0
      ? drag.selectedIds
      : [drag.item.id];
  const count = itemIds.length;
  const itemLabel = count === 1 ? "this tab" : `${count} tabs`;

  if (target.kind === "folder" && target.id) {
    const targetFolderId = target.id;
    const crossSpace = Boolean(
      target.spaceId &&
      drag.item.spaceId &&
      target.spaceId !== drag.item.spaceId,
    );
    confirmMaybe(
      context,
      count > 20 || crossSpace,
      count === 1 ? "Move this tab?" : `Move ${count} tabs?`,
      `Move ${itemLabel} into this tab group${crossSpace ? " in another space" : ""}.`,
      () => moveItemsToFolder(itemIds, targetFolderId),
    );
    return true;
  }

  if (target.kind === "space" && target.id) {
    const targetSpaceId = target.id;
    const crossSpace = Boolean(
      drag.item.spaceId && target.id !== drag.item.spaceId,
    );
    confirmMaybe(
      context,
      count > 20 || crossSpace,
      count === 1 ? "Move this tab?" : `Move ${count} tabs?`,
      `Move ${itemLabel} to this space.`,
      () => moveItemsToSpace(itemIds, targetSpaceId),
    );
    return true;
  }

  // Space-group and root targets do not own a concrete destination space.
  return true;
}

function resolveExternalFolderDrop(
  folder: z.infer<typeof folderDragDataSchema>["folder"],
  target: SidebarDndData,
  context: DropContext,
): boolean {
  const folderName = folder.name ?? "tab group";

  if (target.kind === "space" && target.id) {
    const targetSpaceId = target.id;
    const crossSpace = Boolean(folder.spaceId && target.id !== folder.spaceId);
    confirmMaybe(
      context,
      crossSpace,
      `Move "${folderName}"?`,
      `Move the tab group "${folderName}" to this space.`,
      () => void context.handlers.moveFolderToSpace(folder.id, targetSpaceId),
    );
    return true;
  }

  if (target.kind === "spaceGroup" && target.id) {
    const targetGroupId = target.id;
    confirmMaybe(
      context,
      true,
      `Move "${folderName}"?`,
      `Move the tab group "${folderName}" into this space group.`,
      () =>
        void context.handlers.moveFolderToSpaceGroup(folder.id, targetGroupId),
    );
    return true;
  }

  if (target.kind === "folder" && target.id && target.id !== folder.id) {
    const targetFolderId = target.id;
    confirmMaybe(
      context,
      true,
      `Merge "${folderName}" into "${target.name ?? "the target"}"?`,
      `All tabs from "${folderName}" move into "${target.name ?? "the target group"}". "${folderName}" is then removed.`,
      () => mergeFolders(folder.id, targetFolderId),
    );
    return true;
  }

  return true;
}

type SidebarDropZone = "before" | "after" | "onto";

function resolveFolderDrop(
  dragged: SidebarDndData,
  target: SidebarDndData,
  zone: SidebarDropZone,
  context: DropContext,
): boolean {
  const folderId = dragged.id;
  if (!folderId) return false;
  const folderParentId = dragged.parentId ?? null;
  const folderSpaceId = dragged.spaceId;

  if (target.kind === "folder" && target.id) {
    const targetFolderId = target.id;
    if (targetFolderId === folderId) return true;
    if (zone === "onto") {
      confirmMaybe(
        context,
        true,
        `Merge "${dragged.name ?? "this tab group"}" into "${target.name ?? "the target"}"?`,
        `All tabs from "${dragged.name ?? "the dragged group"}" move into "${target.name ?? "the target group"}". The dragged group is then removed.`,
        () => mergeFolders(folderId, targetFolderId),
      );
      return true;
    }

    reorderFolderAtTarget(
      folderId,
      folderParentId,
      folderSpaceId,
      target,
      targetFolderId,
      zone,
      context,
    );
    return true;
  }

  if (target.kind === "space" && target.id) {
    void context.handlers.moveFolderToSpace(folderId, target.id);
    return true;
  }
  if (target.kind === "spaceGroup" && target.id) {
    void context.handlers.moveFolderToSpaceGroup(folderId, target.id);
    return true;
  }
  if (target.kind === "root") {
    moveFolderToActiveRoot(folderId, folderParentId, folderSpaceId, context);
    return true;
  }
  return false;
}

function reorderFolderAtTarget(
  folderId: string,
  currentParentId: string | null,
  currentSpaceId: string | undefined,
  target: SidebarDndData,
  targetId: string,
  zone: Exclude<SidebarDropZone, "onto">,
  context: DropContext,
): void {
  const targetParentId = target.parentId ?? null;
  const siblings = context.folderChildren.get(targetParentId) ?? [];
  const siblingIds = siblings.map((folder) => folder.id);
  const orderedIds =
    currentParentId === targetParentId
      ? siblingIds.filter((id) => id !== folderId)
      : siblingIds.slice();
  const targetIndex = orderedIds.indexOf(targetId);
  if (targetIndex === -1) return;

  const insertAt = zone === "before" ? targetIndex : targetIndex + 1;
  orderedIds.splice(insertAt, 0, folderId);
  const targetSpaceId = target.spaceId ?? currentSpaceId;
  if (!targetSpaceId) return;

  if (currentParentId === targetParentId) {
    void context.handlers.reorderFolders(
      orderedIds,
      targetSpaceId,
      targetParentId,
    );
    return;
  }

  void (async () => {
    await context.handlers.moveFolderToParent(folderId, targetParentId);
    await context.handlers.reorderFolders(
      orderedIds,
      targetSpaceId,
      targetParentId,
    );
  })();
}

function moveFolderToActiveRoot(
  folderId: string,
  currentParentId: string | null,
  currentSpaceId: string | undefined,
  context: DropContext,
): void {
  const groupSpace = context.activeSpaceGroupId
    ? context.spacesByGroupId.get(context.activeSpaceGroupId)?.[0]
    : undefined;
  const activeSpace =
    groupSpace ??
    context.sortedSpaces.find((space) => space.id === context.activeSpaceId);
  if (!activeSpace) return;

  void (async () => {
    if (currentSpaceId !== activeSpace.id) {
      await context.handlers.moveFolderToSpace(folderId, activeSpace.id);
    }
    if (currentParentId !== null) {
      await context.handlers.moveFolderToParent(folderId, null);
    }
  })();
}

function resolveSpaceDrop(
  dragged: SidebarDndData,
  target: SidebarDndData,
  zone: SidebarDropZone,
  context: DropContext,
): boolean {
  const spaceId = dragged.id;
  if (!spaceId) return false;
  const currentGroupId = dragged.spaceGroupId ?? null;
  if (target.kind === "space" && target.id) {
    if (target.id === spaceId) return true;
    const targetGroupId = target.spaceGroupId ?? null;
    const targetSiblings = targetGroupId
      ? context.spacesByGroupId.get(targetGroupId)
      : context.ungroupedSpaces;
    const orderedIds = (targetSiblings ?? [])
      .filter((space) => space.id !== spaceId)
      .map((space) => space.id);
    const targetIndex = orderedIds.indexOf(target.id);
    if (targetIndex === -1) return true;
    const insertAt = zone === "before" ? targetIndex : targetIndex + 1;
    orderedIds.splice(insertAt, 0, spaceId);

    void (async () => {
      if (currentGroupId !== targetGroupId) {
        await context.handlers.moveSpaceToGroup(spaceId, targetGroupId);
      }
      await context.handlers.reorderSpaces(orderedIds, targetGroupId);
    })();
    return true;
  }

  if (target.kind === "spaceGroup" && target.id) {
    if (currentGroupId !== target.id) {
      void context.handlers.moveSpaceToGroup(spaceId, target.id);
    }
    return true;
  }
  if (target.kind === "ungrouped") {
    if (currentGroupId !== null) {
      void context.handlers.moveSpaceToGroup(spaceId, null);
    }
    return true;
  }
  return false;
}

function resolveSpaceGroupDrop(
  dragged: SidebarDndData,
  target: SidebarDndData,
  zone: SidebarDropZone,
  context: DropContext,
): boolean {
  const groupId = dragged.id;
  if (!groupId) return false;
  if (target.kind !== "spaceGroup" || !target.id) return false;
  if (target.id === groupId) return true;

  const orderedIds = context.sortedSpaceGroups
    .filter((group) => group.id !== groupId)
    .map((group) => group.id);
  const targetIndex = orderedIds.indexOf(target.id);
  if (targetIndex === -1) return true;
  const insertAt = zone === "before" ? targetIndex : targetIndex + 1;
  orderedIds.splice(insertAt, 0, groupId);
  void context.handlers.reorderSpaceGroups(orderedIds);
  return true;
}

function computeSidebarZone(event: DragEndEvent): SidebarDropZone {
  const overRect = event.over?.rect;
  if (!overRect?.height) return "onto";

  const pointerResult = pointerEventSchema.safeParse(event.activatorEvent);
  let pointerY = overRect.top + overRect.height / 2;
  if (pointerResult.success) {
    pointerY = pointerResult.data.clientY + event.delta.y;
  } else {
    const activeRect = event.active.rect.current.translated;
    if (activeRect) pointerY = activeRect.top + activeRect.height / 2;
  }

  const relativePosition = (pointerY - overRect.top) / overRect.height;
  if (relativePosition < 0.25) return "before";
  if (relativePosition > 0.75) return "after";
  return "onto";
}

function confirmMaybe(
  context: DropContext,
  needsConfirmation: boolean,
  title: string,
  description: string,
  run: () => void,
): void {
  if (!needsConfirmation) {
    run();
    return;
  }
  context.requestConfirmation({
    title,
    description,
    confirmLabel: "Move",
    variant: "warning",
    onConfirm: run,
  });
}

function moveItemsToFolder(itemIds: string[], targetFolderId: string): void {
  void chrome.runtime
    .sendMessage({
      service: "items",
      type: "moveToFolder",
      target: "offscreen",
      payload: { itemIds, targetFolderId },
    })
    .catch((error) =>
      console.error("[Sidebar] move tabs to folder failed", error),
    );
}

function moveItemsToSpace(itemIds: string[], targetSpaceId: string): void {
  void chrome.runtime
    .sendMessage({
      service: "items",
      type: "moveToSpace",
      target: "offscreen",
      payload: { itemIds, targetSpaceId },
    })
    .catch((error) =>
      console.error("[Sidebar] move tabs to space failed", error),
    );
}

function mergeFolders(sourceFolderId: string, targetFolderId: string): void {
  void chrome.runtime
    .sendMessage({
      service: "folders",
      type: "mergeInto",
      target: "offscreen",
      payload: { sourceFolderId, targetFolderId },
    })
    .catch((error) =>
      console.error("[Sidebar] merge tab groups failed", error),
    );
}
