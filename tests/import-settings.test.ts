import { describe, expect, test } from "bun:test";
import {
  importSettingsPatchFromPayload,
  normalizeImportSettings,
} from "../src/common/import-settings";

describe("import settings", () => {
  test("defaults to closing tabs after save", () => {
    expect(normalizeImportSettings({})).toEqual({
      reviewBeforeSave: false,
      closeTabsAfterSave: true,
    });
  });

  test("preserves an explicit close-tabs opt out", () => {
    expect(normalizeImportSettings({ closeTabsAfterSave: false })).toMatchObject({
      closeTabsAfterSave: false,
    });
  });

  test("builds partial patches without forcing absent settings", () => {
    expect(importSettingsPatchFromPayload({ reviewBeforeSave: true })).toEqual({
      reviewBeforeSave: true,
    });
    expect(importSettingsPatchFromPayload({ closeTabsAfterSave: false })).toEqual({
      closeTabsAfterSave: false,
    });
  });
});
