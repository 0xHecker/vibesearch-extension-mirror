import { getDb } from "@src/services/DatabaseService";
import type { FolderDocType } from "@src/schemas/folder_schema";
import type { SpaceDocType } from "@src/schemas/space_schema";
import type { TagDocType } from "@src/schemas/tag_schema";
import {
  execAndReleaseOneShotQuery,
  readIdKeysetPage,
} from "@src/services/rxdb-keyset-pagination";

export const NOTION_EXPORT_BATCH_SIZE = 80;
export const NOTION_EXPORT_MAX_ITEMS = 50_000;

export type NotionExportItem = {
  id: string;
  title: string;
  url: string;
  source: string;
  type?: string;
  spaceName: string;
  folderName: string;
  tags: string[];
  description: string;
  isFavorite: boolean;
  createdAt: number;
  updatedAt: number;
};

export type NotionExportBatch = {
  items: NotionExportItem[];
  nextCursor: string | null;
  hasMore: boolean;
};

export type NotionExportDependencies = {
  getDb?: typeof getDb;
};

const clippedText = (value: string | null | undefined, maxLength: number): string => {
  if (!value) return "";
  // Avoid duplicating an arbitrarily large captured page just to produce a
  // short Notion excerpt.
  const boundedInput = value.length > maxLength * 2 ? value.slice(0, maxLength * 2) : value;
  const normalized = boundedInput.replace(/\r\n?/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
  if (normalized.length <= maxLength) return normalized;
  return `${normalized.slice(0, Math.max(0, maxLength - 1)).trimEnd()}…`;
};

const documentsById = <T>(rows: Map<string, { toMutableJSON(): T }>): Map<string, T> => {
  const result = new Map<string, T>();
  for (const [id, document] of rows) {
    result.set(id, document.toMutableJSON());
  }
  return result;
};

export async function loadNotionExportBatch(payload: {
  afterId?: string;
  limit?: number;
} = {}, dependencies: NotionExportDependencies = {}): Promise<NotionExportBatch> {
  const db = await (dependencies.getDb ?? getDb)();
  const limit = Math.max(1, Math.min(NOTION_EXPORT_BATCH_SIZE, Math.floor(payload.limit || NOTION_EXPORT_BATCH_SIZE)));
  const page = await readIdKeysetPage({
    collection: db.items,
    selector: { deletedAt: { $eq: 0 } },
    pageSize: limit,
    afterId: payload.afterId ?? "",
  });
  const itemRows = page.documents.map((document) => document.toMutableJSON());
  if (itemRows.length === 0) {
    return { items: [], nextCursor: null, hasMore: false };
  }

  const itemIds = itemRows.map((item) => item.id);
  const folderIds = Array.from(new Set(itemRows.map((item) => item.folderId).filter(Boolean)));
  const spaceIds = Array.from(new Set(itemRows.map((item) => item.spaceId).filter(Boolean)));
  const folderQuery = db.folders.findByIds(folderIds);
  const spaceQuery = db.spaces.findByIds(spaceIds);
  const itemTagQuery = db.item_tags.find({ selector: { itemId: { $in: itemIds } } });
  const [folderDocuments, spaceDocuments, itemTagDocuments] = await Promise.all([
    execAndReleaseOneShotQuery(db.folders, folderQuery),
    execAndReleaseOneShotQuery(db.spaces, spaceQuery),
    execAndReleaseOneShotQuery(db.item_tags, itemTagQuery),
  ]);
  const folders = documentsById<FolderDocType>(folderDocuments);
  const spaces = documentsById<SpaceDocType>(spaceDocuments);
  const itemTags = itemTagDocuments.map((document) => document.toMutableJSON());
  const tagIds = Array.from(new Set(itemTags.map((join) => join.tagId).filter(Boolean)));
  const tagQuery = db.tags.findByIds(tagIds);
  const tags = documentsById<TagDocType>(await execAndReleaseOneShotQuery(
    db.tags,
    tagQuery,
  ));
  const tagNamesByItem = new Map<string, string[]>();
  for (const join of itemTags) {
    const name = clippedText(tags.get(join.tagId)?.name, 100);
    if (!name) continue;
    const names = tagNamesByItem.get(join.itemId) || [];
    if (names.length < 20 && !names.includes(name)) names.push(name);
    tagNamesByItem.set(join.itemId, names);
  }

  const items = itemRows.map((item): NotionExportItem => {
    const description = clippedText(
      item.summary || item.ai?.summary || item.textContent || item.ocrText,
      1_800,
    );
    const exportItem: NotionExportItem = {
      id: item.id,
      title: clippedText(item.title || item.url || "Untitled", 600),
      url: clippedText(item.url, 2_000),
      source: clippedText(item.source, 80),
      spaceName: clippedText(spaces.get(item.spaceId)?.name || "Unfiled", 200),
      folderName: clippedText(folders.get(item.folderId)?.name || "Unfiled", 200),
      tags: (tagNamesByItem.get(item.id) || []).sort((left, right) => left.localeCompare(right)),
      description,
      isFavorite: item.isFavorite === true,
      createdAt: Number.isSafeInteger(item.createdAt) ? item.createdAt : 0,
      updatedAt: Number.isSafeInteger(item.updatedAt) ? item.updatedAt : 0,
    };
    if (item.type) exportItem.type = clippedText(item.type, 100);
    return exportItem;
  });
  return {
    items,
    nextCursor: page.nextCursor,
    hasMore: page.hasMore,
  };
}
