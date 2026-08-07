import { RxJsonSchema } from "rxdb";
import {
  DEFAULT_PRIVATE_AUTO_LOCK_MS,
  SPACE_NOT_BINNED,
} from "@src/common/spaces";

// RxDB only permits single-type indexed fields. The empty string represents a
// space without a group in storage; controllers expose it as null to callers.
export const UNGROUPED_SPACE_GROUP_ID = "";

export type SpaceDocType = {
  id: string;
  name: string;
  slug: string;
  spaceGroupId: string;
  isPrivate: boolean;
  passwordSalt?: string;
  passwordHash?: string;
  passwordIterations?: number;
  passwordVersion?: number;
  recoveryQuestion1?: string;
  recoveryQuestion2?: string;
  recoverySalt1?: string;
  recoveryHash1?: string;
  recoveryIterations1?: number;
  recoverySalt2?: string;
  recoveryHash2?: string;
  recoveryIterations2?: number;
  autoLockMs: number;
  sortOrder: number;
  isArchived: boolean;
  deletedAt: number;
  purgeAt: number;
  createdAt: number;
  updatedAt: number;
};

export const spaceSchema: RxJsonSchema<SpaceDocType> = {
  title: "space schema",
  version: 2,
  description: "Describes a space used to scope folders and items",
  primaryKey: "id",
  type: "object",
  properties: {
    id: { type: "string", maxLength: 100 },
    name: { type: "string", maxLength: 80 },
    slug: { type: "string", maxLength: 120 },
    spaceGroupId: { type: "string", default: UNGROUPED_SPACE_GROUP_ID, maxLength: 100 },
    isPrivate: { type: "boolean", default: false },
    passwordSalt: { type: "string" },
    passwordHash: { type: "string" },
    passwordIterations: { type: "number", minimum: 1, maximum: 5_000_000, multipleOf: 1 },
    passwordVersion: { type: "number", minimum: 1, maximum: 1000, multipleOf: 1 },
    recoveryQuestion1: { type: "string", maxLength: 160 },
    recoveryQuestion2: { type: "string", maxLength: 160 },
    recoverySalt1: { type: "string" },
    recoveryHash1: { type: "string" },
    recoveryIterations1: { type: "number", minimum: 1, maximum: 5_000_000, multipleOf: 1 },
    recoverySalt2: { type: "string" },
    recoveryHash2: { type: "string" },
    recoveryIterations2: { type: "number", minimum: 1, maximum: 5_000_000, multipleOf: 1 },
    autoLockMs: {
      type: "integer",
      minimum: 30_000,
      maximum: 24 * 60 * 60 * 1000,
      multipleOf: 1,
      default: DEFAULT_PRIVATE_AUTO_LOCK_MS,
    },
    sortOrder: {
      type: "integer",
      minimum: 0,
      maximum: Number.MAX_SAFE_INTEGER - 1,
      multipleOf: 1,
      default: 0,
    },
    isArchived: { type: "boolean", default: false },
    deletedAt: { type: "integer", minimum: 0, maximum: Number.MAX_SAFE_INTEGER - 1, multipleOf: 1, default: SPACE_NOT_BINNED },
    purgeAt: { type: "integer", minimum: 0, maximum: Number.MAX_SAFE_INTEGER - 1, multipleOf: 1, default: 0 },
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
    "slug",
    "spaceGroupId",
    "isPrivate",
    "autoLockMs",
    "sortOrder",
    "isArchived",
    "deletedAt",
    "purgeAt",
    "createdAt",
    "updatedAt",
  ],
  indexes: ["isPrivate", "sortOrder", "name", "isArchived", "slug", "spaceGroupId", "deletedAt", "purgeAt"],
};

const normalizeLegacySpace = (oldDoc: SpaceDocType): SpaceDocType => {
  const row = oldDoc as SpaceDocType & Record<string, unknown>;
  row.spaceGroupId = typeof row.spaceGroupId === "string" ? row.spaceGroupId : UNGROUPED_SPACE_GROUP_ID;
  row.isPrivate = row.isPrivate === true;
  row.autoLockMs =
    Number.isSafeInteger(row.autoLockMs) && row.autoLockMs >= 30_000
      ? Math.min(row.autoLockMs, 24 * 60 * 60 * 1000)
      : DEFAULT_PRIVATE_AUTO_LOCK_MS;
  row.sortOrder = Number.isSafeInteger(row.sortOrder) && row.sortOrder >= 0 ? row.sortOrder : 0;
  row.isArchived = row.isArchived === true;
  row.deletedAt = Number.isSafeInteger(row.deletedAt) && row.deletedAt >= 0 ? row.deletedAt : SPACE_NOT_BINNED;
  row.purgeAt = Number.isSafeInteger(row.purgeAt) && row.purgeAt >= 0 ? row.purgeAt : 0;
  row.createdAt = Number.isSafeInteger(row.createdAt) && row.createdAt >= 0 ? row.createdAt : 0;
  row.updatedAt = Number.isSafeInteger(row.updatedAt) && row.updatedAt >= 0 ? row.updatedAt : row.createdAt;
  return row;
};

export const spaceMigrationStrategies = {
  1: normalizeLegacySpace,
  2: normalizeLegacySpace,
};
