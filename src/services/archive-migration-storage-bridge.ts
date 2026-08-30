import {
  ARCHIVE_CACHE_STORAGE_KEY,
  ARCHIVE_CACHE_MAX_ENTRIES,
  ArchiveCache,
  createOpfsArchiveCacheFiles,
  normalizeArchiveCache,
  type ArchiveCacheEntry,
  type ArchiveCacheStorage,
} from "@src/services/archive-cache";
import {
  ARCHIVE_OUTBOX_STORAGE_KEY,
  ARCHIVE_OUTBOX_MAX_JOBS,
  createOpfsArchiveOutboxFiles,
  normalizeArchiveOutbox,
} from "@src/services/archive-outbox";
import {
  LOCAL_DATA_RESET_EPOCH_STORAGE_KEY,
  LOCAL_DATA_RESET_STORAGE_KEY,
  type LocalDataResetState,
} from "@src/services/large-payload-staging";

export const ARCHIVE_MIGRATION_STORAGE_BRIDGE_MESSAGE =
  "ARCHIVE_MIGRATION_STORAGE_BRIDGE";
export const OFFSCREEN_DOCUMENT_PATH = "src/pages/offscreen/offscreen.html";

type ArchiveMigrationStorageBridgeOperation =
  | "cache-read"
  | "cache-write"
  | "cache-clear"
  | "outbox-read"
  | "outbox-clear"
  | "reset-state-read";

export type ArchiveMigrationStorageBridgePayload = {
  operation?: ArchiveMigrationStorageBridgeOperation;
  entries?: unknown;
};

type StorageArea = Pick<chrome.storage.LocalStorageArea, "get" | "set" | "remove">;

type BridgeResponse<T = unknown> = {
  success?: boolean;
  payload?: T;
  error?: string;
};

type MigrationOutboxEntry = {
  itemId: string;
  mode: "upload" | "capture";
  fileName?: string;
  byteSize: number;
  updatedAt: number;
};

const boundedCacheEntries = (value: unknown): ArchiveCacheEntry[] =>
  normalizeArchiveCache(value).slice(-ARCHIVE_CACHE_MAX_ENTRIES);

const resetStateFromStorage = (row: Record<string, unknown>): LocalDataResetState => {
  const resetAt = Number(row[LOCAL_DATA_RESET_EPOCH_STORAGE_KEY]);
  return {
    inProgress: row[LOCAL_DATA_RESET_STORAGE_KEY] === true,
    resetAt: Number.isSafeInteger(resetAt) && resetAt >= 0 ? resetAt : 0,
  };
};

/**
 * Offscreen documents intentionally expose only chrome.runtime, not
 * chrome.storage. Keep the bridge narrow: migration may read archive metadata,
 * update the cache index it owns, and inspect the reset barrier, but it cannot
 * access unrelated extension settings or credentials.
 */
export const handleArchiveMigrationStorageBridge = async (
  payload: ArchiveMigrationStorageBridgePayload,
  storage: StorageArea = chrome.storage.local,
): Promise<unknown> => {
  switch (payload?.operation) {
    case "cache-read": {
      const row = await storage.get(ARCHIVE_CACHE_STORAGE_KEY);
      return boundedCacheEntries(row[ARCHIVE_CACHE_STORAGE_KEY]);
    }
    case "cache-write": {
      const entries = boundedCacheEntries(payload.entries);
      await storage.set({ [ARCHIVE_CACHE_STORAGE_KEY]: entries });
      return undefined;
    }
    case "cache-clear":
      await storage.remove(ARCHIVE_CACHE_STORAGE_KEY);
      return undefined;
    case "outbox-read": {
      const row = await storage.get(ARCHIVE_OUTBOX_STORAGE_KEY);
      // Backup only needs the file locator/version fields. Do not clone source
      // URLs, error text, retry state, or ids into the offscreen process; the
      // compact projection keeps the largest legal outbox message bounded.
      return normalizeArchiveOutbox(row[ARCHIVE_OUTBOX_STORAGE_KEY])
        .slice(-ARCHIVE_OUTBOX_MAX_JOBS)
        .map(({ itemId, mode, fileName, byteSize, updatedAt }) => ({
          itemId,
          mode,
          fileName,
          byteSize,
          updatedAt,
        }));
    }
    case "outbox-clear":
      await storage.remove(ARCHIVE_OUTBOX_STORAGE_KEY);
      return undefined;
    case "reset-state-read": {
      const row = await storage.get([
        LOCAL_DATA_RESET_STORAGE_KEY,
        LOCAL_DATA_RESET_EPOCH_STORAGE_KEY,
      ]);
      return resetStateFromStorage(row);
    }
    default:
      throw new Error("ARCHIVE_MIGRATION_STORAGE_OPERATION_INVALID");
  }
};

export const isArchiveMigrationStorageBridgeSender = (
  sender: Pick<chrome.runtime.MessageSender, "id" | "url" | "tab">,
  runtimeId: string,
  offscreenUrl: string,
): boolean =>
  sender?.id === runtimeId &&
  !sender.tab &&
  typeof sender.url === "string" &&
  sender.url === offscreenUrl;

const requestStorage = async <T>(
  operation: ArchiveMigrationStorageBridgeOperation,
  entries?: ArchiveCacheEntry[],
): Promise<T> => {
  const response = (await chrome.runtime.sendMessage({
    target: "background",
    type: ARCHIVE_MIGRATION_STORAGE_BRIDGE_MESSAGE,
    payload: { operation, entries },
  })) as BridgeResponse<T>;
  if (!response?.success) {
    throw new Error(response?.error || "ARCHIVE_MIGRATION_STORAGE_BRIDGE_FAILED");
  }
  return response.payload as T;
};

const runtimeArchiveCacheStorage: ArchiveCacheStorage = {
  read: () => requestStorage<ArchiveCacheEntry[]>("cache-read"),
  write: (entries) => requestStorage<void>("cache-write", entries),
  clear: () => requestStorage<void>("cache-clear"),
};

let offscreenArchiveCache: ArchiveCache | null = null;

/** Archive cache adapter for the chrome.storage-less offscreen document. */
export const getOffscreenArchiveCache = (): ArchiveCache => {
  offscreenArchiveCache ??= new ArchiveCache({
    storage: runtimeArchiveCacheStorage,
    files: createOpfsArchiveCacheFiles(),
    readResetState: () => requestStorage<LocalDataResetState>("reset-state-read"),
  });
  return offscreenArchiveCache;
};

/** Pending upload bytes are authoritative until an acknowledgement is durable. */
export const getOffscreenArchiveOutboxReader = () => {
  const files = createOpfsArchiveOutboxFiles();
  return {
    list: () => requestStorage<MigrationOutboxEntry[]>("outbox-read"),
    read: (fileName: string) => files.read(fileName),
  };
};

export const clearOffscreenArchiveOutboxMetadata = (): Promise<void> =>
  requestStorage<void>("outbox-clear");
