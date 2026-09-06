import { PUBLIC_SPACE_ID } from "@src/common/spaces";
import type { FolderDocType } from "@src/schemas/folder_schema";
import { getDb } from "@src/services/DatabaseService";
import {
  requireLiveFolderDestination,
  withLiveSpaceDestination,
} from "@src/services/live-destination";
import { notifyDatabaseChanged } from "@src/services/database/notifications";

export type CreateFolderPayload = {
  id: string;
  name: string;
  userId?: string | null;
  parentId?: string | null;
  type?: FolderDocType["type"];
  isLocked?: boolean;
  isPinned?: boolean;
  spaceId?: string;
};

function normalizeSpaceId(spaceId: string | undefined): string {
  return (spaceId || PUBLIC_SPACE_ID).trim() || PUBLIC_SPACE_ID;
}

export async function createFolder(payload: CreateFolderPayload): Promise<FolderDocType> {
  const db = await getDb();
  return withLiveSpaceDestination(
    db,
    normalizeSpaceId(payload.spaceId),
    async (_spaceDocument, spaceId) => {
      if (payload.parentId) {
        await requireLiveFolderDestination(db, payload.parentId, spaceId);
      }
      const now = Date.now();
      const folder: FolderDocType = {
        id: payload.id,
        name: payload.name,
        userId: payload.userId ?? "",
        spaceId,
        parentId: payload.parentId ?? null,
        type: payload.type ?? "folder",
        sortOrder: now,
        isLocked: payload.isLocked ?? false,
        isPinned: payload.isPinned ?? false,
        isCollapsed: false,
        deletedAt: 0,
        purgeAt: 0,
        isDirty: false,
        serverVersion: 0,
        createdAt: now,
        updatedAt: now,
      };
      await db.folders.insert(folder);
      notifyDatabaseChanged("folders");
      return folder;
    },
  );
}

async function updateFolderFlag(
  id: string,
  field: "isPinned" | "isLocked",
  requestedValue: boolean | undefined,
): Promise<void> {
  const db = await getDb();
  const document = await db.folders.findOne(id).exec();
  if (!document) return;
  const folder = document.toMutableJSON();
  const currentValue = field === "isPinned" ? folder.isPinned : folder.isLocked;
  await document.patch({ [field]: requestedValue ?? !currentValue, updatedAt: Date.now() });
  notifyDatabaseChanged("folders");
}

export function toggleFolderPinned(payload: { id: string; value?: boolean }): Promise<void> {
  return updateFolderFlag(payload.id, "isPinned", payload.value);
}

export function toggleFolderLocked(payload: { id: string; value?: boolean }): Promise<void> {
  return updateFolderFlag(payload.id, "isLocked", payload.value);
}

export async function updateFolderName(payload: { id: string; name: string }): Promise<void> {
  const db = await getDb();
  const document = await db.folders.findOne(payload.id).exec();
  if (!document) return;
  await document.patch({ name: payload.name.slice(0, 80), updatedAt: Date.now() });
  notifyDatabaseChanged("folders");
}
