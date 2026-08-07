import { RxJsonSchema } from "rxdb";

export type FolderDocType = {
  id: string;
  name: string;
  spaceId: string;
  parentId: string | null;
  type: "folder" | "tab_group";
  sortOrder: number;
  isLocked: boolean;
  isPinned: boolean;
  isCollapsed: boolean;
  encryptionKey?: string;
  deletedAt: number;
  purgeAt: number;
  isDirty: boolean;
  serverVersion: number;
  createdAt: number;
  updatedAt: number;
  userId: string;
};

export const folderSchema: RxJsonSchema<FolderDocType> = {
  title: "folder schema",
  version: 7,
  description: "Describes a folder for organizing items or a group of tabs",
  primaryKey: "id",
  type: "object",
  properties: {
    id: { type: "string", maxLength: 100 },
    userId: { type: "string", default: "", maxLength: 1000 },
    name: { type: "string" },
    spaceId: { type: "string", default: "space_public_default", maxLength: 1000 },
    parentId: {
      type: ["string", "null"],
      ref: "folders",
      default: null,
      maxLength: 1000,
    },
    isPinned: { type: "boolean", default: false },
    isCollapsed: { type: "boolean", default: false },
    type: {
      type: "string",
      enum: ["folder", "tab_group"],
      default: "folder",
      maxLength: 50,
    },
    sortOrder: {
      type: "integer",
      multipleOf: 1,
      minimum: 0,
      maximum: Number.MAX_SAFE_INTEGER - 1,
      default: 0,
    },
    // Security
    isLocked: { type: "boolean", default: false },
    encryptionKey: { type: "string" }, // Stores a derived key, not the raw password
    deletedAt: {
      type: "integer",
      minimum: 0,
      maximum: Number.MAX_SAFE_INTEGER - 1,
      multipleOf: 1,
      default: 0,
    },
    purgeAt: {
      type: "integer",
      minimum: 0,
      maximum: Number.MAX_SAFE_INTEGER - 1,
      multipleOf: 1,
      default: 0,
    },
    // Sync fields
    isDirty: { type: "boolean", default: false },
    serverVersion: { type: "number", default: 0 },
    // Timestamps
    createdAt: {
      type: "integer",
      minimum: 0,
      maximum: Number.MAX_SAFE_INTEGER - 1,
      multipleOf: 1,
    },
    updatedAt: {
      type: "integer",
      minimum: 0,
      maximum: Number.MAX_SAFE_INTEGER - 1,
      multipleOf: 1,
    },
  },
  required: [
    "id",
    "name",
    "spaceId",
    "type",
    "createdAt",
    "updatedAt",
    "isDirty",
    "parentId",
    "userId",
    "isPinned",
    "isCollapsed",
    "sortOrder",
    "deletedAt",
    "purgeAt",
  ],
  indexes: [
    "isDirty",
    "userId",
    "spaceId",
    "type",
    "isPinned",
    "isCollapsed",
    "sortOrder",
    "deletedAt",
    "purgeAt",
  ],
};

const keepLegacyFolder = (oldDoc: FolderDocType): FolderDocType => oldDoc;

const normalizeLegacyFolder = (oldDoc: FolderDocType): FolderDocType => {
  const row = oldDoc as FolderDocType & Record<string, unknown>;
  row.userId = typeof row.userId === "string" ? row.userId : "";
  row.spaceId = typeof row.spaceId === "string" && row.spaceId ? row.spaceId : "space_public_default";
  row.parentId = typeof row.parentId === "string" ? row.parentId : null;
  row.type = row.type === "tab_group" ? "tab_group" : "folder";
  row.sortOrder = Number.isSafeInteger(row.sortOrder) && row.sortOrder >= 0 ? row.sortOrder : 0;
  row.isPinned = row.isPinned === true;
  row.isCollapsed = row.isCollapsed === true;
  row.deletedAt = Number.isSafeInteger(row.deletedAt) && row.deletedAt >= 0 ? row.deletedAt : 0;
  row.purgeAt = Number.isSafeInteger(row.purgeAt) && row.purgeAt >= 0 ? row.purgeAt : 0;
  row.isDirty = row.isDirty === true;
  row.serverVersion = Number.isFinite(row.serverVersion) ? row.serverVersion : 0;
  row.createdAt = Number.isSafeInteger(row.createdAt) && row.createdAt >= 0 ? row.createdAt : 0;
  row.updatedAt = Number.isSafeInteger(row.updatedAt) && row.updatedAt >= 0 ? row.updatedAt : row.createdAt;
  return row;
};

export const folderMigrationStrategies = {
  1: keepLegacyFolder,
  2: keepLegacyFolder,
  3: keepLegacyFolder,
  4: keepLegacyFolder,
  5: keepLegacyFolder,
  6: keepLegacyFolder,
  7: normalizeLegacyFolder,
};
