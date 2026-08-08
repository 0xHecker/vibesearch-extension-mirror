import { withOpfsMutationLock } from "@src/services/media-storage";
import {
  readLocalDataResetState,
  type LocalDataResetState,
} from "@src/services/large-payload-staging";

export const ARCHIVE_CACHE_STORAGE_KEY = "vibesearch:archiveCache:v1";
export const ARCHIVE_CACHE_DIRECTORY = "archive-cache-v1";
export const ARCHIVE_CACHE_MAX_FILE_BYTES = 28 * 1024 * 1024;
export const ARCHIVE_CACHE_MAX_DISK_BYTES = 256 * 1024 * 1024;
export const ARCHIVE_CACHE_MAX_ENTRIES = 5_000;

export type ArchiveCacheEntry = {
  itemId: string;
  fileName: string;
  byteSize: number;
  mimeType: string;
  updatedAt: number;
  source: "local" | "cloud";
};

export type ArchiveCacheStorage = {
  read(): Promise<unknown>;
  write(entries: ArchiveCacheEntry[]): Promise<void>;
  clear(): Promise<void>;
};

export type ArchiveCacheFiles = {
  write(fileName: string, body: Blob): Promise<void>;
  read(fileName: string): Promise<File | Blob | null>;
  delete(fileName: string): Promise<void>;
  cleanup(keepFileNames: Set<string>): Promise<void>;
  clear(): Promise<void>;
};

export type ArchiveCacheOptions = {
  storage: ArchiveCacheStorage;
  files: ArchiveCacheFiles;
  now?: () => number;
  randomId?: () => string;
  maxFileBytes?: number;
  maxDiskBytes?: number;
  maxEntries?: number;
  readResetState?: () => Promise<LocalDataResetState>;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const normalizeMimeType = (value: unknown): string => {
  const mimeType = typeof value === "string" ? value.trim().toLowerCase() : "";
  return mimeType.startsWith("application/xhtml+xml")
    ? "application/xhtml+xml"
    : "text/html";
};

const normalizeEntry = (value: unknown): ArchiveCacheEntry | null => {
  if (!isRecord(value)) return null;
  const itemId = typeof value.itemId === "string" ? value.itemId.trim().slice(0, 160) : "";
  const fileName = typeof value.fileName === "string" ? value.fileName.trim().slice(0, 200) : "";
  const byteSize = Number.isSafeInteger(value.byteSize) ? Number(value.byteSize) : 0;
  const updatedAt = Number.isSafeInteger(value.updatedAt) && Number(value.updatedAt) >= 0
    ? Number(value.updatedAt)
    : 0;
  if (
    !itemId ||
    !fileName ||
    !/^[A-Za-z0-9._-]+$/.test(fileName) ||
    byteSize <= 0 ||
    byteSize > ARCHIVE_CACHE_MAX_FILE_BYTES
  ) {
    return null;
  }
  return {
    itemId,
    fileName,
    byteSize,
    mimeType: normalizeMimeType(value.mimeType),
    updatedAt,
    source: value.source === "cloud" ? "cloud" : "local",
  };
};

/** Keep one newest cache file per item in deterministic oldest-to-newest order. */
export const normalizeArchiveCache = (value: unknown): ArchiveCacheEntry[] => {
  if (!Array.isArray(value)) return [];
  const byItem = new Map<string, ArchiveCacheEntry>();
  for (const raw of value) {
    const entry = normalizeEntry(raw);
    if (!entry) continue;
    const previous = byItem.get(entry.itemId);
    if (
      !previous ||
      entry.updatedAt > previous.updatedAt ||
      (entry.updatedAt === previous.updatedAt && entry.fileName > previous.fileName)
    ) {
      byItem.set(entry.itemId, entry);
    }
  }
  return Array.from(byItem.values()).sort(
    (left, right) => left.updatedAt - right.updatedAt || left.itemId.localeCompare(right.itemId),
  );
};

export const createChromeArchiveCacheStorage = (): ArchiveCacheStorage => ({
  async read() {
    const row = await chrome.storage.local.get(ARCHIVE_CACHE_STORAGE_KEY);
    return row[ARCHIVE_CACHE_STORAGE_KEY];
  },
  async write(entries) {
    await chrome.storage.local.set({ [ARCHIVE_CACHE_STORAGE_KEY]: entries });
  },
  async clear() {
    await chrome.storage.local.remove(ARCHIVE_CACHE_STORAGE_KEY);
  },
});

const getCacheDirectory = async (create = true): Promise<FileSystemDirectoryHandle> => {
  const root = await navigator.storage.getDirectory();
  return root.getDirectoryHandle(ARCHIVE_CACHE_DIRECTORY, { create });
};

const isNotFoundError = (error: unknown): boolean =>
  error instanceof DOMException && error.name === "NotFoundError";

export const createOpfsArchiveCacheFiles = (): ArchiveCacheFiles => ({
  async write(fileName, body) {
    const directory = await getCacheDirectory();
    const handle = await directory.getFileHandle(fileName, { create: true });
    const writable = await handle.createWritable();
    try {
      await writable.write(body);
      await writable.close();
    } catch (error) {
      await writable.abort().catch(() => {});
      await directory.removeEntry(fileName).catch(() => {});
      throw error;
    }
  },
  async read(fileName) {
    try {
      const directory = await getCacheDirectory(false);
      const handle = await directory.getFileHandle(fileName);
      return await handle.getFile();
    } catch (error) {
      if (isNotFoundError(error)) return null;
      throw error;
    }
  },
  async delete(fileName) {
    try {
      const directory = await getCacheDirectory(false);
      await directory.removeEntry(fileName);
    } catch (error) {
      if (!isNotFoundError(error)) throw error;
    }
  },
  async cleanup(keepFileNames) {
    let directory: FileSystemDirectoryHandle;
    try {
      directory = await getCacheDirectory(false);
    } catch (error) {
      if (isNotFoundError(error)) return;
      throw error;
    }
    const entries = (directory as FileSystemDirectoryHandle & {
      entries(): AsyncIterableIterator<[string, FileSystemHandle]>;
    }).entries();
    for await (const [name, handle] of entries) {
      if (handle.kind === "file" && !keepFileNames.has(name)) {
        try {
          await directory.removeEntry(name);
        } catch (error) {
          if (!isNotFoundError(error)) throw error;
        }
      }
    }
  },
  async clear() {
    try {
      const root = await navigator.storage.getDirectory();
      await root.removeEntry(ARCHIVE_CACHE_DIRECTORY, { recursive: true });
    } catch (error) {
      if (!isNotFoundError(error)) throw error;
    }
  },
});

export class ArchiveCache {
  private readonly storage: ArchiveCacheStorage;
  private readonly files: ArchiveCacheFiles;
  private readonly now: () => number;
  private readonly randomId: () => string;
  private readonly maxFileBytes: number;
  private readonly maxDiskBytes: number;
  private readonly maxEntries: number;
  private readonly readResetState: () => Promise<LocalDataResetState>;

  constructor(options: ArchiveCacheOptions) {
    this.storage = options.storage;
    this.files = options.files;
    this.now = options.now ?? Date.now;
    this.randomId = options.randomId ?? (() => crypto.randomUUID());
    this.maxFileBytes = Math.max(
      1,
      Math.min(ARCHIVE_CACHE_MAX_FILE_BYTES, Math.floor(options.maxFileBytes ?? ARCHIVE_CACHE_MAX_FILE_BYTES)),
    );
    this.maxDiskBytes = Math.max(1, Math.floor(options.maxDiskBytes ?? ARCHIVE_CACHE_MAX_DISK_BYTES));
    this.maxEntries = Math.max(1, Math.floor(options.maxEntries ?? ARCHIVE_CACHE_MAX_ENTRIES));
    this.readResetState = options.readResetState ?? readLocalDataResetState;
  }

  async list(): Promise<ArchiveCacheEntry[]> {
    return normalizeArchiveCache(await this.storage.read());
  }

  async get(itemIdRaw: string): Promise<Blob | null> {
    const itemId = itemIdRaw.trim();
    if (!itemId) return null;
    const entry = (await this.list()).find((candidate) => candidate.itemId === itemId);
    if (!entry) return null;
    const file = await this.files.read(entry.fileName);
    if (!file || file.size !== entry.byteSize || file.size <= 0 || file.size > this.maxFileBytes) {
      await this.deleteEntryIfCurrent(entry).catch(() => {});
      return null;
    }
    return file;
  }

  async put(itemIdRaw: string, body: Blob, updatedAt = this.now()): Promise<ArchiveCacheEntry> {
    return withOpfsMutationLock(() => this.putWithinMutationLock(itemIdRaw, body, updatedAt));
  }

  async putCloud(itemIdRaw: string, body: Blob, updatedAt = this.now()): Promise<ArchiveCacheEntry> {
    return withOpfsMutationLock(() =>
      this.putWithinMutationLock(itemIdRaw, body, updatedAt, { source: "cloud" })
    );
  }

  /**
   * Fill a cache miss without replacing a capture that arrived while the
   * caller was fetching an older cloud copy.
   */
  async putIfAbsent(
    itemIdRaw: string,
    body: Blob,
    updatedAt = this.now(),
  ): Promise<ArchiveCacheEntry> {
    const itemId = itemIdRaw.trim();
    if (!itemId || itemId.length > 160) throw new Error("ARCHIVE_CACHE_ITEM_INVALID");
    return withOpfsMutationLock(async () => {
      const existing = normalizeArchiveCache(await this.storage.read())
        .find((entry) => entry.itemId === itemId);
      if (existing) return existing;
      return this.putWithinMutationLock(itemId, body, updatedAt, { source: "cloud" });
    });
  }

  /**
   * Restore already owns the cross-context OPFS mutation lock while it writes
   * media and database references. Calling this variant avoids recursively
   * requesting the same non-reentrant Web Lock.
   */
  async putWithinMutationLock(
    itemIdRaw: string,
    body: Blob,
    updatedAt = this.now(),
    options: { source?: "local" | "cloud"; replaceCloudNewer?: boolean } = {},
  ): Promise<ArchiveCacheEntry> {
    const itemId = itemIdRaw.trim();
    if (!itemId || itemId.length > 160) throw new Error("ARCHIVE_CACHE_ITEM_INVALID");
    if (!body || body.size <= 0 || body.size > this.maxFileBytes || body.size > this.maxDiskBytes) {
      throw new Error("ARCHIVE_CACHE_FILE_INVALID");
    }

    return (async () => {
      let current = normalizeArchiveCache(await this.storage.read());
      const normalizedUpdatedAt =
        Number.isSafeInteger(updatedAt) && updatedAt >= 0 ? updatedAt : this.now();
      const resetState = await this.readResetState();
      if (
        resetState.inProgress ||
        (options.source === "cloud" && resetState.resetAt > 0 && normalizedUpdatedAt <= resetState.resetAt)
      ) {
        throw new Error("LOCAL_DATA_RESET_IN_PROGRESS");
      }
      const newer = current.find(
        (candidate) =>
          candidate.itemId === itemId &&
          candidate.updatedAt > normalizedUpdatedAt &&
          !(options.replaceCloudNewer === true && candidate.source === "cloud"),
      );
      if (newer) {
        const retainedFile = await this.files.read(newer.fileName);
        if (
          retainedFile &&
          retainedFile.size === newer.byteSize &&
          retainedFile.size > 0 &&
          retainedFile.size <= this.maxFileBytes
        ) {
          return newer;
        }
        // A newer index row without readable bytes is not durable retention.
        // Remove it from this mutation's candidate set and preserve the queued
        // upload body instead of deleting the outbox's only good copy.
        await this.files.delete(newer.fileName);
        current = current.filter((candidate) => candidate.fileName !== newer.fileName);
      }
      const fileName = `${this.randomId()}.html`;
      const entry: ArchiveCacheEntry = {
        itemId,
        fileName,
        byteSize: body.size,
        mimeType: normalizeMimeType(body.type),
        updatedAt: normalizedUpdatedAt,
        source: options.source === "cloud" ? "cloud" : "local",
      };

      await this.files.write(fileName, body);
      const replaced = current.filter((candidate) => candidate.itemId === itemId);
      const candidates = [...current.filter((candidate) => candidate.itemId !== itemId), entry]
        .sort((left, right) => right.updatedAt - left.updatedAt || right.itemId.localeCompare(left.itemId));
      const retainedNewest: ArchiveCacheEntry[] = [];
      let retainedBytes = 0;
      for (const candidate of candidates) {
        if (retainedNewest.length >= this.maxEntries) continue;
        if (retainedBytes + candidate.byteSize > this.maxDiskBytes) continue;
        retainedNewest.push(candidate);
        retainedBytes += candidate.byteSize;
      }
      if (!retainedNewest.some((candidate) => candidate.fileName === fileName)) {
        await this.files.delete(fileName).catch(() => {});
        throw new Error("ARCHIVE_CACHE_CAPACITY");
      }
      const retained = retainedNewest.sort(
        (left, right) => left.updatedAt - right.updatedAt || left.itemId.localeCompare(right.itemId),
      );

      try {
        await this.storage.write(retained);
      } catch (error) {
        await this.files.delete(fileName).catch(() => {});
        throw error;
      }

      const keep = new Set(retained.map((candidate) => candidate.fileName));
      const removedNames = new Set([
        ...replaced.map((candidate) => candidate.fileName),
        ...current.filter((candidate) => !keep.has(candidate.fileName)).map((candidate) => candidate.fileName),
      ]);
      await Promise.all(Array.from(removedNames, (name) => this.files.delete(name)));
      await this.files.cleanup(keep).catch(() => {});
      return entry;
    })();
  }

  async delete(itemIdRaw: string): Promise<void> {
    await this.deleteMany([itemIdRaw]);
  }

  private async deleteEntryIfCurrent(staleEntry: ArchiveCacheEntry): Promise<void> {
    await withOpfsMutationLock(async () => {
      const current = normalizeArchiveCache(await this.storage.read());
      const matching = current.find((entry) =>
        entry.itemId === staleEntry.itemId &&
        entry.fileName === staleEntry.fileName &&
        entry.updatedAt === staleEntry.updatedAt
      );
      if (!matching) return;
      await this.storage.write(current.filter((entry) => entry !== matching));
      await this.files.delete(matching.fileName);
    });
  }

  async deleteMany(itemIdsRaw: Iterable<string>): Promise<void> {
    const itemIds = new Set(
      Array.from(itemIdsRaw, (itemId) => itemId.trim()).filter(Boolean),
    );
    if (itemIds.size === 0) return;
    await withOpfsMutationLock(async () => {
      const current = normalizeArchiveCache(await this.storage.read());
      const removed = current.filter((entry) => itemIds.has(entry.itemId));
      if (removed.length === 0) return;
      const next = current.filter((entry) => !itemIds.has(entry.itemId));
      await this.storage.write(next);
      await Promise.all(removed.map((entry) => this.files.delete(entry.fileName)));
    });
  }

  async listFiles(): Promise<Array<{ entry: ArchiveCacheEntry; file: Blob }>> {
    const output: Array<{ entry: ArchiveCacheEntry; file: Blob }> = [];
    for (const entry of await this.list()) {
      const file = await this.files.read(entry.fileName);
      if (!file || file.size !== entry.byteSize || file.size <= 0 || file.size > this.maxFileBytes) continue;
      output.push({ entry, file });
    }
    return output;
  }

  async cleanup(): Promise<void> {
    await withOpfsMutationLock(async () => {
      const entries = normalizeArchiveCache(await this.storage.read());
      const retained: ArchiveCacheEntry[] = [];
      for (const entry of entries) {
        // The production adapter maps a genuine NotFound to null. Preserve the
        // index and surface transient permission/storage failures instead of
        // misclassifying them as corruption.
        const file = await this.files.read(entry.fileName);
        if (
          file &&
          file.size === entry.byteSize &&
          file.size > 0 &&
          file.size <= this.maxFileBytes
        ) {
          retained.push(entry);
        } else {
          await this.files.delete(entry.fileName);
        }
      }
      await this.storage.write(retained);
      await this.files.cleanup(new Set(retained.map((entry) => entry.fileName)));
    });
  }

  async clear(): Promise<void> {
    await withOpfsMutationLock(async () => {
      await this.storage.clear();
      await this.files.clear();
    });
  }
}

let defaultArchiveCache: ArchiveCache | null = null;

export const getArchiveCache = (): ArchiveCache => {
  defaultArchiveCache ??= new ArchiveCache({
    storage: createChromeArchiveCacheStorage(),
    files: createOpfsArchiveCacheFiles(),
  });
  return defaultArchiveCache;
};
