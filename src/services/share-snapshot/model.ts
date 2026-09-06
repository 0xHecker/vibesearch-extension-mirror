import type {
  ItemDocType,
  MediaOcrMetadata,
} from "@src/schemas/item_schema";
import type { SpaceGroupDocType } from "@src/schemas/space_group_schema";
import type { getDb } from "@src/services/DatabaseService";

export type ShareSourceKind = "folder" | "folders" | "items";

export type SharedMedia = {
  id?: string;
  type: "image" | "video" | "audio" | "file";
  originalUrl?: string;
  storageType: "hotlink" | "s3";
  s3Url?: string;
  s3ThumbnailUrl?: string;
  embedUrl?: string;
  embedType?: "iframe";
  thumbnailUrl?: string;
  mimeType?: string;
  fileName?: string;
  byteSize?: number;
  contentHash?: string;
  durationSec?: number;
  provider?: string;
  externalId?: string;
  altText?: string;
  titleText?: string;
  ariaLabel?: string;
  pageUrl?: string;
  pageTitle?: string;
  siteName?: string;
  faviconUrl?: string;
  width?: number;
  height?: number;
  capturedAt?: number;
  ocr?: Omit<
    MediaOcrMetadata,
    "sourceHash" | "modelVersion" | "error"
  >;
};

export type SharedItem = {
  id: string;
  title: string;
  textContent?: string;
  ocrText?: string;
  url: string;
  source: ItemDocType["source"];
  folderId?: string;
  spaceId?: string;
  authorUsername?: string;
  likes?: number;
  upvotes?: number;
  media?: SharedMedia[];
  iconUrl?: string;
  displayImageUrl?: string;
  createdAt?: number;
  updatedAt?: number;
  /** Present only in private portable backups, never public shares. */
  isFavorite?: boolean;
  type?: ItemDocType["type"];
  fields?: ItemDocType["fields"];
  blocks?: ItemDocType["blocks"];
  blobs?: ItemDocType["blobs"];
  summary?: ItemDocType["summary"];
  ai?: ItemDocType["ai"];
  parentId?: string | null;
  chunkOrder?: number;
};

export type SharedFolder = {
  id: string;
  name: string;
  spaceId?: string;
  parentId?: string | null;
  type?: "folder" | "tab_group";
  sortOrder?: number;
  isPinned?: boolean;
  isCollapsed?: boolean;
  createdAt?: number;
  updatedAt?: number;
};

export type SharedSpace = {
  id: string;
  name: string;
  slug?: string;
  spaceGroupId?: string | null;
  sortOrder?: number;
  isPrivate?: boolean;
  createdAt?: number;
  updatedAt?: number;
};

export type SharedSpaceGroup = Pick<
  SpaceGroupDocType,
  "id" | "name"
> &
  Partial<
    Pick<
      SpaceGroupDocType,
      | "sortOrder"
      | "isCollapsed"
      | "parentGroupId"
      | "createdAt"
      | "updatedAt"
    >
  >;

export type SharedTag = {
  id: string;
  name: string;
  color?: string | null;
  isFavorite?: boolean;
  createdAt?: number;
  updatedAt?: number;
};

export type SharedItemTag = {
  itemId: string;
  tagId: string;
};

export type ShareSnapshotWarning = {
  code: string;
  itemId?: string;
  detail?: string;
};

export type ShareSnapshotV1 = {
  schemaVersion: 1;
  /** Rich metadata is present only in the user's private backup exporter. */
  backupMetadataVersion?: 1;
  title: string;
  description?: string;
  createdAt: number;
  source: {
    kind: ShareSourceKind;
    ids: string[];
  };
  spaceGroups?: SharedSpaceGroup[];
  spaces: SharedSpace[];
  folders: SharedFolder[];
  items: SharedItem[];
  tags: SharedTag[];
  itemTags: SharedItemTag[];
  warnings?: ShareSnapshotWarning[];
};

export type BuildExportSnapshotPayload = {
  title?: string;
  description?: string;
  source?: {
    kind?: ShareSourceKind;
    ids?: string[];
  };
};

export type BuildLocalExportSnapshotOptions = {
  /** Test/diagnostic override; production never exceeds the Drive limit. */
  maxEstimatedJsonBytes?: number;
  pageSize?: number;
};

export type ShareSnapshotDependencies = {
  getDb?: typeof getDb;
};

export type ImportSharedSnapshotPayload = {
  snapshot: ShareSnapshotV1;
  targetSpaceId?: string;
  rootFolderName?: string;
};

export type ImportSharedSnapshotResult = {
  rootFolderId: string;
  folderCount: number;
  itemCount: number;
  tagCount: number;
};

export type MergeBackupSnapshotResult = {
  spaceCount: number;
  folderCount: number;
  itemCount: number;
  tagCount: number;
  warnings: string[];
};

export type MixedShareSelection = {
  folderIds: Set<string>;
  itemIds: Set<string>;
  spaceIds: Set<string>;
  spaceGroupIds: Set<string>;
};

export type BuildShareFromMixedInput = {
  selection: MixedShareSelection;
  title?: string;
  description?: string;
};
