import { jsonObject, jsonString, parseJsonValue } from "@src/common/json-value";
import {
  normalizeImportSettings,
  type ImportSettings,
} from "@src/common/import-settings";
import {
  reconcileLiveImportLruFolders,
  resolveLiveImportFolderTarget,
  type ImportLruFolderEntry,
  type LiveImportFolderTarget,
  type LiveImportSpaceSnapshot,
} from "@src/common/import-lru";
import type { FolderDocType } from "@src/schemas/folder_schema";
import type {
  FailedImportAttempt,
  ImportDraft,
  TabSnapshot,
} from "@src/workers/background/import-types";
import { sendForwardedToOffscreen } from "@src/workers/background/runtime";
import { z } from "zod";

const IMPORT_SETTINGS_KEY = "vs_import_settings_v1";
const IMPORT_DRAFTS_KEY = "vs_import_drafts_v1";
const IMPORT_LRU_FOLDERS_KEY = "vs_import_lru_folders_v1";
const IMPORT_LRU_LIMIT = 5;
const IMPORT_DRAFT_LIMIT = 24;
const FAILED_ATTEMPT_LIMIT = 20;

const importSettingsSchema = z
  .object({
    reviewBeforeSave: z.boolean().optional(),
    closeTabsAfterSave: z.boolean().optional(),
  })
  .partial();
const lruFolderSchema: z.ZodType<ImportLruFolderEntry> = z.object({
  folderId: z.string().min(1),
  spaceId: z.string().min(1),
  folderName: z.string(),
  spaceName: z.string(),
  usedAt: z.number().finite(),
});

type ImportStorageValue =
  | ImportSettings
  | ImportDraft[]
  | ImportLruFolderEntry[];
export type QuickSaveFolder = Pick<
  ImportLruFolderEntry,
  "folderId" | "spaceId" | "folderName"
>;

const failedAttempts = new Map<string, FailedImportAttempt>();

async function readStorageJson(key: string) {
  const row = await chrome.storage.local.get(key);
  if (!(key in row)) return undefined;
  try {
    return parseJsonValue(row[key]);
  } catch {
    return undefined;
  }
}

async function writeStorageValue(
  key: string,
  value: ImportStorageValue,
): Promise<void> {
  await chrome.storage.local.set({ [key]: value });
}

export async function getImportSettings(): Promise<ImportSettings> {
  const parsed = importSettingsSchema.safeParse(
    jsonObject(await readStorageJson(IMPORT_SETTINGS_KEY)),
  );
  return normalizeImportSettings(parsed.success ? parsed.data : undefined);
}

export async function setImportSettings(
  patch: Partial<ImportSettings>,
): Promise<ImportSettings> {
  const current = await getImportSettings();
  const next = normalizeImportSettings({ ...current, ...patch });
  await writeStorageValue(IMPORT_SETTINGS_KEY, next);
  return next;
}

export async function loadDrafts(): Promise<ImportDraft[]> {
  const stored = await readStorageJson(IMPORT_DRAFTS_KEY);
  if (!Array.isArray(stored)) return [];
  return stored
    .flatMap((value) => {
      const record = jsonObject(value);
      if (!jsonString(record?.id)) return [];
      // SAFETY: Drafts are written only by saveDrafts after construction through
      // the typed import workflow. We reject non-object and identifier-less rows
      // here; schema-versioning this private cache is tracked separately.
      return [record as ImportDraft];
    })
    .sort((left, right) => right.createdAt - left.createdAt)
    .slice(0, IMPORT_DRAFT_LIMIT);
}

export async function saveDrafts(drafts: ImportDraft[]): Promise<void> {
  const retained = [...drafts]
    .sort((left, right) => right.createdAt - left.createdAt)
    .slice(0, IMPORT_DRAFT_LIMIT);
  await writeStorageValue(IMPORT_DRAFTS_KEY, retained);
}

export async function getLruFolders(): Promise<ImportLruFolderEntry[]> {
  const stored = await readStorageJson(IMPORT_LRU_FOLDERS_KEY);
  const parsed = z.array(lruFolderSchema).safeParse(stored);
  if (!parsed.success) return [];
  return parsed.data
    .sort((left, right) => right.usedAt - left.usedAt)
    .slice(0, IMPORT_LRU_LIMIT);
}

export async function recordLruFolder(
  entry: ImportLruFolderEntry,
): Promise<void> {
  const current = await getLruFolders();
  const retained = current.filter(
    (candidate) => candidate.folderId !== entry.folderId,
  );
  retained.unshift(entry);
  await writeStorageValue(
    IMPORT_LRU_FOLDERS_KEY,
    retained.slice(0, IMPORT_LRU_LIMIT),
  );
}

export async function loadLiveImportSpaces(): Promise<
  LiveImportSpaceSnapshot[]
> {
  const spaces = await sendForwardedToOffscreen<LiveImportSpaceSnapshot[]>({
    service: "spaces",
    type: "listSpaces",
    payload: {},
  });
  return spaces.filter((space) => Boolean(space.id));
}

export function loadImportFolder(
  folderId: string,
): Promise<FolderDocType | null> {
  return sendForwardedToOffscreen<FolderDocType | null>({
    service: "folders",
    type: "getById",
    payload: { id: folderId, skipLockCheck: true },
  });
}

export async function resolveFreshLiveImportFolder(
  folderId: string,
): Promise<LiveImportFolderTarget | null> {
  try {
    const [folder, liveSpaces] = await Promise.all([
      loadImportFolder(folderId),
      loadLiveImportSpaces(),
    ]);
    return resolveLiveImportFolderTarget(folder, liveSpaces);
  } catch {
    return null;
  }
}

function sameLruEntry(
  left: ImportLruFolderEntry,
  right: ImportLruFolderEntry,
): boolean {
  return (
    left.folderId === right.folderId &&
    left.spaceId === right.spaceId &&
    left.folderName === right.folderName &&
    left.spaceName === right.spaceName &&
    left.usedAt === right.usedAt
  );
}

export async function pruneLruFolders(): Promise<ImportLruFolderEntry[]> {
  const lru = await getLruFolders();
  if (lru.length === 0) return [];
  let liveSpaces: LiveImportSpaceSnapshot[];
  try {
    liveSpaces = await loadLiveImportSpaces();
  } catch {
    return [];
  }
  const folders = await Promise.all(
    lru.map((entry) => loadImportFolder(entry.folderId).catch(() => null)),
  );
  const alive = reconcileLiveImportLruFolders(lru, folders, liveSpaces).slice(
    0,
    IMPORT_LRU_LIMIT,
  );
  if (
    alive.length !== lru.length ||
    alive.some((entry, index) => !sameLruEntry(entry, lru[index]))
  ) {
    await writeStorageValue(IMPORT_LRU_FOLDERS_KEY, alive);
  }
  return alive;
}

export async function resolveQuickSaveFolder(): Promise<QuickSaveFolder | null> {
  const [first] = await pruneLruFolders();
  return first
    ? {
        folderId: first.folderId,
        spaceId: first.spaceId,
        folderName: first.folderName,
      }
    : null;
}

export function buildLruEntryFromFolder(
  folder: { id: string; spaceId: string; name: string },
  spaceName: string,
): ImportLruFolderEntry {
  return {
    folderId: folder.id,
    spaceId: folder.spaceId,
    folderName: folder.name,
    spaceName,
    usedAt: Date.now(),
  };
}

export async function fetchSpaceName(spaceId: string): Promise<string> {
  try {
    const spaces = await loadLiveImportSpaces();
    return spaces.find((space) => space.id === spaceId)?.name || "Space";
  } catch {
    return "Space";
  }
}

export function toTabSnapshot(tab?: chrome.tabs.Tab): TabSnapshot | undefined {
  if (!tab) return undefined;
  return { id: tab.id, windowId: tab.windowId, url: tab.url, title: tab.title };
}

export function rememberFailedImportAttempt(
  statusId: string,
  attempt: FailedImportAttempt,
): void {
  failedAttempts.set(statusId, attempt);
  const ordered = [...failedAttempts.entries()].sort(
    (left, right) => left[1].createdAt - right[1].createdAt,
  );
  while (ordered.length > FAILED_ATTEMPT_LIMIT) {
    const oldest = ordered.shift();
    if (!oldest) return;
    failedAttempts.delete(oldest[0]);
  }
}

export function getFailedImportAttempt(
  statusId: string,
): FailedImportAttempt | null {
  return failedAttempts.get(statusId) || null;
}

export function deleteFailedImportAttempt(statusId: string): void {
  failedAttempts.delete(statusId);
}

export function clearFailedImportAttempts(): void {
  failedAttempts.clear();
}

export async function resolveRetryTab(
  snapshot?: TabSnapshot,
): Promise<chrome.tabs.Tab | undefined> {
  if (!snapshot) return undefined;
  if (snapshot.id !== undefined) {
    try {
      return await chrome.tabs.get(snapshot.id);
    } catch {
      // The original tab may have closed; retain its URL/title snapshot below.
    }
  }
  // SAFETY: Import retries only read the shared optional Tab fields captured in
  // TabSnapshot. Chrome accepts this structural subset in the existing flow.
  return snapshot as chrome.tabs.Tab;
}

export async function clearImportStorage(): Promise<void> {
  await chrome.storage.local.remove([
    IMPORT_DRAFTS_KEY,
    IMPORT_LRU_FOLDERS_KEY,
  ]);
  clearFailedImportAttempts();
}
