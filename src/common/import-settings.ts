export type ImportSettings = {
  reviewBeforeSave: boolean;
  closeTabsAfterSave: boolean;
};

export const DEFAULT_IMPORT_SETTINGS: ImportSettings = {
  reviewBeforeSave: false,
  closeTabsAfterSave: true,
};

export const normalizeImportSettings = (
  raw?: Partial<ImportSettings> | null
): ImportSettings => ({
  reviewBeforeSave: raw?.reviewBeforeSave === true,
  closeTabsAfterSave: raw?.closeTabsAfterSave !== false,
});

export const importSettingsPatchFromPayload = (
  payload: unknown
): Partial<ImportSettings> => {
  if (!payload || typeof payload !== "object") return {};

  const record = payload as Record<string, unknown>;
  const patch: Partial<ImportSettings> = {};

  if ("reviewBeforeSave" in record) {
    patch.reviewBeforeSave = record.reviewBeforeSave === true;
  }

  if ("closeTabsAfterSave" in record) {
    patch.closeTabsAfterSave = record.closeTabsAfterSave === true;
  }

  return patch;
};
