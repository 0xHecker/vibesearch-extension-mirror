import { RxJsonSchema } from "rxdb";

export type ItemTagDocType = {
  id: string;
  itemId: string;
  tagId: string;
  userId: string | null;
  createdAt: number;
  updatedAt: number;
  deletedAt: number;
  origin?: "automatic";
  automaticKey?: string;
};

export const itemTagSchema: RxJsonSchema<ItemTagDocType> = {
  title: "item-tag join schema",
  version: 1,
  description: "Joins items and tags",
  primaryKey: {
    key: "id",
    fields: ["itemId", "tagId"],
    separator: "|",
  },
  type: "object",
  properties: {
    id: { type: "string", maxLength: 1025 },
    itemId: { type: "string", ref: "items", maxLength: 512 },
    tagId: { type: "string", ref: "tags", maxLength: 512 },
    userId: { type: "string", default: null, maxLength: 1000 },
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
    deletedAt: {
      type: "integer",
      minimum: 0,
      maximum: Number.MAX_SAFE_INTEGER - 1,
      multipleOf: 1,
      default: 0,
    },
    origin: { type: "string", enum: ["automatic"] },
    automaticKey: { type: "string", maxLength: 512 },
  },
  required: ["itemId", "tagId", "userId", "createdAt", "updatedAt", "deletedAt"],
  indexes: ["itemId", "tagId", "userId"],
};

const validTimestamp = (value: unknown): value is number =>
  Number.isSafeInteger(value) && (value as number) >= 0;

const normalizeLegacyItemTag = (oldDoc: ItemTagDocType): ItemTagDocType => {
  const row = oldDoc as ItemTagDocType & Record<string, unknown>;
  const createdAt = validTimestamp(row.createdAt) ? row.createdAt : 0;
  const updatedAt = validTimestamp(row.updatedAt) ? row.updatedAt : createdAt;
  const deletedAt = validTimestamp(row.deletedAt) ? row.deletedAt : 0;
  row.createdAt = Math.min(createdAt, updatedAt, deletedAt || updatedAt);
  row.updatedAt = Math.max(updatedAt, deletedAt);
  row.deletedAt = deletedAt;
  return row;
};

export const itemTagMigrationStrategies = {
  1: normalizeLegacyItemTag,
};
