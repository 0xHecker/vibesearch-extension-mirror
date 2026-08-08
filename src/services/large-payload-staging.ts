import { withOpfsMutationLock } from "@src/services/media-storage";

export const LARGE_PAYLOAD_STAGING_DIRECTORY = "large-payload-staging-v1";
export const LOCAL_DATA_RESET_STORAGE_KEY = "vibesearch:localDataResetInProgress:v1";
export const LOCAL_DATA_RESET_EPOCH_STORAGE_KEY = "vibesearch:localDataResetEpoch:v1";
const LARGE_PAYLOAD_MAX_AGE_MS = 60 * 60 * 1000;
const SAFE_STAGED_FILE_NAME = /^[A-Za-z0-9._-]{1,220}$/;

const isNotFoundError = (error: unknown): boolean =>
  error instanceof DOMException && error.name === "NotFoundError";

export type LocalDataResetState = {
  inProgress: boolean;
  resetAt: number;
};

/**
 * Read the durable reset barrier without assuming an extension runtime exists.
 * Unit tests and non-extension tooling can safely import storage services, while
 * production callers share one persisted barrier across the Search page,
 * background worker, and offscreen document.
 */
export const readLocalDataResetState = async (): Promise<LocalDataResetState> => {
  const extensionChrome = (globalThis as typeof globalThis & { chrome?: typeof chrome }).chrome;
  if (!extensionChrome?.storage?.local?.get) return { inProgress: false, resetAt: 0 };
  const row = await extensionChrome.storage.local.get([
    LOCAL_DATA_RESET_STORAGE_KEY,
    LOCAL_DATA_RESET_EPOCH_STORAGE_KEY,
  ]);
  const resetAt = Number(row[LOCAL_DATA_RESET_EPOCH_STORAGE_KEY]);
  return {
    inProgress: row[LOCAL_DATA_RESET_STORAGE_KEY] === true,
    resetAt: Number.isSafeInteger(resetAt) && resetAt >= 0 ? resetAt : 0,
  };
};

const getStagingDirectory = async (create = true): Promise<FileSystemDirectoryHandle> => {
  const root = await navigator.storage.getDirectory();
  return root.getDirectoryHandle(LARGE_PAYLOAD_STAGING_DIRECTORY, { create });
};

const assertSafeFileName = (fileName: string): string => {
  if (!SAFE_STAGED_FILE_NAME.test(fileName)) throw new Error("STAGED_FILE_NAME_INVALID");
  return fileName;
};

const cleanupStagedPayloadsUnlocked = async (now = Date.now()): Promise<void> => {
  let directory: FileSystemDirectoryHandle;
  try {
    directory = await getStagingDirectory(false);
  } catch (error) {
    if (isNotFoundError(error)) return;
    throw error;
  }
  const entries = (directory as FileSystemDirectoryHandle & {
    entries(): AsyncIterableIterator<[string, FileSystemHandle]>;
  }).entries();
  for await (const [name, handle] of entries) {
    if (handle.kind !== "file") continue;
    try {
      const file = await (handle as FileSystemFileHandle).getFile();
      if (now - file.lastModified > LARGE_PAYLOAD_MAX_AGE_MS) {
        await directory.removeEntry(name);
      }
    } catch (error) {
      if (!isNotFoundError(error)) {
        await directory.removeEntry(name).catch((removeError) => {
          if (!isNotFoundError(removeError)) throw removeError;
        });
      }
    }
  }
};

export const cleanupStagedPayloads = async (now = Date.now()): Promise<void> =>
  withOpfsMutationLock(() => cleanupStagedPayloadsUnlocked(now));

export const clearStagedPayloads = async (): Promise<void> =>
  withOpfsMutationLock(async () => {
    try {
      const root = await navigator.storage.getDirectory();
      await root.removeEntry(LARGE_PAYLOAD_STAGING_DIRECTORY, { recursive: true });
    } catch (error) {
      if (!isNotFoundError(error)) throw error;
    }
  });

export const stagePayloadFile = async (
  body: Blob,
  prefix: "local-export" | "local-import" | "drive-export" | "drive-import",
): Promise<string> => {
  return withOpfsMutationLock(async () => {
    const resetState = await readLocalDataResetState();
    if (resetState.inProgress) {
      throw new Error("LOCAL_DATA_RESET_IN_PROGRESS");
    }
    await cleanupStagedPayloadsUnlocked();
    const fileName = `${prefix}-${crypto.randomUUID()}.json`;
    const directory = await getStagingDirectory();
    const handle = await directory.getFileHandle(fileName, { create: true });
    const writable = await handle.createWritable();
    try {
      await writable.write(body);
      await writable.close();
      return fileName;
    } catch (error) {
      await writable.abort().catch(() => {});
      await directory.removeEntry(fileName).catch(() => {});
      throw error;
    }
  });
};

export const readStagedPayloadFile = async (fileNameRaw: string): Promise<File> => {
  const fileName = assertSafeFileName(fileNameRaw);
  const directory = await getStagingDirectory(false);
  return (await directory.getFileHandle(fileName)).getFile();
};

export const deleteStagedPayloadFile = async (fileNameRaw: string): Promise<void> => {
  const fileName = assertSafeFileName(fileNameRaw);
  try {
    const directory = await getStagingDirectory(false);
    await directory.removeEntry(fileName);
  } catch (error) {
    if (!(error instanceof DOMException) || error.name !== "NotFoundError") throw error;
  }
};

export const takeStagedPayloadFile = async (fileName: string): Promise<File> => {
  const file = await readStagedPayloadFile(fileName);
  await deleteStagedPayloadFile(fileName);
  return file;
};
