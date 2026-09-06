import { PUBLIC_SPACE_ID } from "@src/common/spaces";
import type { MyDatabase } from "@src/services/DatabaseService";
import type { ShareSnapshotV1 } from "@src/services/share-snapshot/model";

const LOOKUP_BATCH_SIZE = 200;

type IdentifiedDocument = {
  get(field: "id"): string;
};

type IdQueryCollection<Document extends IdentifiedDocument> = {
  find(query: {
    selector: { id: { $in: string[] } };
  }): { exec(): Promise<Document[]> };
};

async function findDocsByIds<Document extends IdentifiedDocument>(
  collection: IdQueryCollection<Document>,
  ids: Iterable<string>,
): Promise<Document[]> {
  const uniqueIds = Array.from(new Set(ids)).filter(Boolean);
  const documents: Document[] = [];
  for (
    let offset = 0;
    offset < uniqueIds.length;
    offset += LOOKUP_BATCH_SIZE
  ) {
    const batch = uniqueIds.slice(offset, offset + LOOKUP_BATCH_SIZE);
    const batchSet = new Set(batch);
    const rows = await collection
      .find({ selector: { id: { $in: batch } } })
      .exec();
    // Retain the post-filter for simple test adapters and older query planners
    // that can return a broader result for a large $in expression.
    for (const row of rows) {
      if (batchSet.has(row.get("id"))) documents.push(row);
    }
  }
  return documents;
}

function addSpaceId(spaceIds: Set<string>, value: string | undefined): void {
  const id = value?.trim();
  if (id) spaceIds.add(id);
}

export function incomingBackupSpaceIds(
  snapshot: ShareSnapshotV1,
): Set<string> {
  const ids = new Set<string>([PUBLIC_SPACE_ID]);
  for (const space of snapshot.spaces) addSpaceId(ids, space.id);
  for (const folder of snapshot.folders) addSpaceId(ids, folder.spaceId);
  for (const item of snapshot.items) addSpaceId(ids, item.spaceId);
  return ids;
}

export async function currentBackupSpaceIds(
  snapshot: ShareSnapshotV1,
  db: MyDatabase,
): Promise<Set<string>> {
  const ids = new Set<string>();
  const folderIds = new Set(snapshot.folders.map((folder) => folder.id));
  for (const item of snapshot.items) {
    if (item.folderId) folderIds.add(item.folderId);
  }

  const itemDocs = await findDocsByIds(
    db.items,
    snapshot.items.map((item) => item.id),
  );
  for (const itemDoc of itemDocs) {
    addSpaceId(ids, itemDoc.get("spaceId"));
    const folderId = itemDoc.get("folderId");
    if (folderId) folderIds.add(folderId);
  }

  const folderDocs = await findDocsByIds(db.folders, folderIds);
  for (const folderDoc of folderDocs) {
    addSpaceId(ids, folderDoc.get("spaceId"));
  }
  return ids;
}
