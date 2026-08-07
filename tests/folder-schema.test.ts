import { describe, expect, test } from "bun:test";
import { folderMigrationStrategies, folderSchema } from "../src/schemas/folder_schema";
import { requireDexieIndexFields } from "../src/services/rxdb-dexie-required-indexes";

describe("folder schema bin fields", () => {
  test("requires indexed bin fields for Dexie RxStorage", () => {
    expect(folderSchema.version).toBe(7);
    expect(folderSchema.indexes).toContain("deletedAt");
    expect(folderSchema.indexes).toContain("purgeAt");
    expect(folderSchema.required).toContain("deletedAt");
    expect(folderSchema.required).toContain("purgeAt");
  });

  test("normalizes legacy schemas whose indexed bin fields were not required", () => {
    const legacySchema = {
      ...folderSchema,
      required: folderSchema.required?.filter((field) => field !== "deletedAt" && field !== "purgeAt"),
    };

    const normalized = requireDexieIndexFields(legacySchema);

    expect(normalized.required).toContain("deletedAt");
    expect(normalized.required).toContain("purgeAt");
  });

  test("normalizes legacy filled schemas even when index fields are absent from properties", () => {
    const { deletedAt: _deletedAt, purgeAt: _purgeAt, ...propertiesWithoutBinFields } = folderSchema.properties as Record<string, unknown>;
    const legacySchema = {
      ...folderSchema,
      properties: propertiesWithoutBinFields,
      required: folderSchema.required?.filter((field) => field !== "deletedAt" && field !== "purgeAt"),
    };

    const normalized = requireDexieIndexFields(legacySchema);

    expect(normalized.required).toContain("deletedAt");
    expect(normalized.required).toContain("purgeAt");
  });

  test("normalizes records from the released pre-reset schema lineage", () => {
    const migrated = folderMigrationStrategies[7]({
      id: "legacy-folder",
      name: "Legacy",
      createdAt: 1,
      updatedAt: 1,
    } as any);

    expect(migrated).toMatchObject({
      userId: "",
      spaceId: "space_public_default",
      parentId: null,
      type: "folder",
      sortOrder: 0,
      isPinned: false,
      isCollapsed: false,
      deletedAt: 0,
      purgeAt: 0,
      isDirty: false,
    });
  });
});
