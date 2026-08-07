import { PUBLIC_SPACE_ID } from "@src/common/spaces";
import {
  withSpaceMutationLock,
  withSpaceMutationLocks,
} from "@src/services/entity-mutation-lock";

export const DESTINATION_SPACE_NOT_FOUND = "DESTINATION_SPACE_NOT_FOUND";
export const DESTINATION_SPACE_NOT_LIVE = "DESTINATION_SPACE_NOT_LIVE";
export const DESTINATION_FOLDER_NOT_FOUND = "DESTINATION_FOLDER_NOT_FOUND";
export const DESTINATION_FOLDER_NOT_LIVE = "DESTINATION_FOLDER_NOT_LIVE";
export const DESTINATION_FOLDER_CHANGED = "DESTINATION_FOLDER_CHANGED";

type DestinationDocument = {
  get: (field: string) => unknown;
};

export type LiveFolderDestination = {
  folderDoc: DestinationDocument;
  spaceDoc: DestinationDocument;
  spaceId: string;
};

export const requireLiveSpaceDestination = async (
  db: any,
  rawSpaceId: string
): Promise<DestinationDocument> => {
  const spaceId = rawSpaceId.trim() || PUBLIC_SPACE_ID;
  const spaceDoc = await db.spaces.findOne(spaceId).exec();
  if (!spaceDoc) throw new Error(DESTINATION_SPACE_NOT_FOUND);
  if (spaceDoc.get("deletedAt") !== 0 || spaceDoc.get("isArchived") === true) {
    throw new Error(DESTINATION_SPACE_NOT_LIVE);
  }
  return spaceDoc;
};

export const requireLiveFolderDestination = async (
  db: any,
  folderId: string,
  expectedSpaceId?: string
): Promise<LiveFolderDestination> => {
  const folderDoc = await db.folders.findOne(folderId).exec();
  if (!folderDoc) throw new Error(DESTINATION_FOLDER_NOT_FOUND);
  if (folderDoc.get("deletedAt") !== 0) {
    throw new Error(DESTINATION_FOLDER_NOT_LIVE);
  }
  const spaceId =
    ((folderDoc.get("spaceId") as string | undefined) || PUBLIC_SPACE_ID).trim() ||
    PUBLIC_SPACE_ID;
  if (expectedSpaceId && spaceId !== expectedSpaceId) {
    throw new Error(DESTINATION_FOLDER_CHANGED);
  }
  const spaceDoc = await requireLiveSpaceDestination(db, spaceId);

  const visited = new Set<string>([folderId]);
  let parentId = (folderDoc.get("parentId") as string | null | undefined) || null;
  while (parentId) {
    if (visited.has(parentId)) throw new Error(DESTINATION_FOLDER_NOT_LIVE);
    visited.add(parentId);
    const parentDoc = await db.folders.findOne(parentId).exec();
    if (!parentDoc || parentDoc.get("deletedAt") !== 0) {
      throw new Error(DESTINATION_FOLDER_NOT_LIVE);
    }
    const parentSpaceId =
      ((parentDoc.get("spaceId") as string | undefined) || PUBLIC_SPACE_ID).trim() ||
      PUBLIC_SPACE_ID;
    if (parentSpaceId !== spaceId) throw new Error(DESTINATION_FOLDER_CHANGED);
    parentId = (parentDoc.get("parentId") as string | null | undefined) || null;
  }
  return { folderDoc, spaceDoc, spaceId };
};

export const withLiveSpaceDestination = async <Result>(
  db: any,
  rawSpaceId: string,
  operation: (spaceDoc: DestinationDocument, spaceId: string) => Promise<Result>
): Promise<Result> => {
  const spaceId = rawSpaceId.trim() || PUBLIC_SPACE_ID;
  return withSpaceMutationLock(db, spaceId, async () => {
    const spaceDoc = await requireLiveSpaceDestination(db, spaceId);
    return operation(spaceDoc, spaceId);
  });
};

export const withLiveFolderDestination = async <Result>(
  db: any,
  folderId: string,
  operation: (destination: LiveFolderDestination) => Promise<Result>
): Promise<Result> => {
  const initialFolder = await db.folders.findOne(folderId).exec();
  if (!initialFolder) throw new Error(DESTINATION_FOLDER_NOT_FOUND);
  const initialSpaceId =
    ((initialFolder.get("spaceId") as string | undefined) || PUBLIC_SPACE_ID).trim() ||
    PUBLIC_SPACE_ID;
  return withSpaceMutationLock(db, initialSpaceId, async () => {
    const destination = await requireLiveFolderDestination(db, folderId, initialSpaceId);
    return operation(destination);
  });
};

export const withLiveSpaceDestinations = async <Result>(
  db: any,
  spaceIds: Iterable<string>,
  operation: () => Promise<Result>
): Promise<Result> => {
  const ids = Array.from(
    new Set(Array.from(spaceIds, (id) => id.trim() || PUBLIC_SPACE_ID))
  );
  return withSpaceMutationLocks(db, ids, async () => {
    for (const spaceId of ids) await requireLiveSpaceDestination(db, spaceId);
    return operation();
  });
};
