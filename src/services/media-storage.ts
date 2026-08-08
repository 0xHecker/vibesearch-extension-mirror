import type { ItemDocType } from "@src/schemas/item_schema";

const MEDIA_DIR = "media";

export type OpfsFileIdentity = {
  size: number;
  lastModified: number;
  sampleSha256: string;
};

const OPFS_IDENTITY_EDGE_BYTES = 64 * 1024;
const OPFS_MUTATION_LOCK_NAME = "vibesearch:opfs-media-mutation:v1";
let opfsMutationTail: Promise<void> = Promise.resolve();

const isNotFoundError = (error: unknown): boolean =>
  error instanceof DOMException && error.name === "NotFoundError";

/**
 * Serializes DB-reference changes with OPFS overwrites/deletes. Web Locks also
 * coordinate the background worker and offscreen document when both are alive;
 * the promise tail is a deterministic fallback for test/older environments.
 */
export const withOpfsMutationLock = async <T>(work: () => Promise<T>): Promise<T> => {
  const locks = globalThis.navigator?.locks;
  if (locks?.request) {
    return locks.request(OPFS_MUTATION_LOCK_NAME, work);
  }

  const previous = opfsMutationTail;
  let release = () => {};
  opfsMutationTail = new Promise<void>((resolve) => {
    release = resolve;
  });
  await previous;
  try {
    return await work();
  } finally {
    release();
  }
};

const getMediaDir = async () => {
  const root = await navigator.storage.getDirectory();
  return root.getDirectoryHandle(MEDIA_DIR, { create: true });
};

export const listOpfsMediaItemDirectoryIds = async (): Promise<string[]> => {
  let mediaDir: FileSystemDirectoryHandle;
  try {
    const root = await navigator.storage.getDirectory();
    mediaDir = await root.getDirectoryHandle(MEDIA_DIR);
  } catch (error) {
    if (isNotFoundError(error)) return [];
    throw error;
  }
  const ids: string[] = [];
  const entries = (mediaDir as FileSystemDirectoryHandle & {
    entries(): AsyncIterableIterator<[string, FileSystemHandle]>;
  }).entries();
  for await (const [name, handle] of entries) {
    if (handle.kind === "directory" && name) ids.push(name);
  }
  return ids.sort();
};

const getItemDir = async (itemId: string) => {
  const mediaDir = await getMediaDir();
  return mediaDir.getDirectoryHandle(itemId, { create: true });
};

const getFileHandleFromOpfsPath = async (
  opfsPath: string
): Promise<FileSystemFileHandle | null> => {
  const parts = opfsPath.split("/").filter(Boolean);
  if (parts.length < 3) return null;

  const fileName = parts[parts.length - 1];
  const dirParts = parts.slice(0, -1);
  const root = await navigator.storage.getDirectory();
  let dir: FileSystemDirectoryHandle = root;

  for (const part of dirParts) {
    dir = await dir.getDirectoryHandle(part);
  }

  return dir.getFileHandle(fileName);
};

export const saveMediaToOpfs = async (
  itemId: string,
  file: File,
  fileName?: string
): Promise<{ opfsPath: string; size: number }> => {
  const itemDir = await getItemDir(itemId);
  const safeName =
    fileName ||
    `${crypto.randomUUID()}.${file.name.split(".").pop() || "bin"}`;
  const fileHandle = await itemDir.getFileHandle(safeName, { create: true });
  const writable = await fileHandle.createWritable();
  await writable.write(file);
  await writable.close();

  const opfsPath = `${MEDIA_DIR}/${itemId}/${safeName}`;

  // The saved file is already addressable by opfsPath. Creating a blob URL here
  // would retain a duplicate in memory without a consumer to release it.
  return { opfsPath, size: file.size };
};

export const isObjectUrl = (url: string | null | undefined): url is string =>
  typeof url === "string" && url.startsWith("blob:");

export const revokeObjectUrl = (url: string | null | undefined): void => {
  if (!isObjectUrl(url)) return;
  URL.revokeObjectURL(url);
};

/** Owns transient blob URLs and revokes even URLs delivered after cancellation. */
export class ObjectUrlOwner {
  private active = true;
  private readonly urls = new Set<string>();

  constructor(private readonly revoke: (url: string) => void = revokeObjectUrl) {}

  get isActive(): boolean {
    return this.active;
  }

  own(url: string | null | undefined): string | null {
    if (!url) return null;
    if (!this.active) {
      if (isObjectUrl(url)) this.revoke(url);
      return null;
    }
    if (isObjectUrl(url)) this.urls.add(url);
    return url;
  }

  dispose(): void {
    if (!this.active) return;
    this.active = false;
    for (const url of this.urls) this.revoke(url);
    this.urls.clear();
  }
}

export const resolveOpfsMedia = async (
  opfsPath: string
): Promise<string | null> => {
  try {
    const fileHandle = await getFileHandleFromOpfsPath(opfsPath);
    if (!fileHandle) return null;
    const file = await fileHandle.getFile();
    return URL.createObjectURL(file);
  } catch {
    return null;
  }
};

export const deleteMediaFromOpfs = async (
  opfsPath: string,
  expectedIdentity?: OpfsFileIdentity
): Promise<boolean> => {
  try {
    if (expectedIdentity) {
      const currentIdentity = await readOpfsFileIdentity(opfsPath);
      if (!opfsFileIdentitiesEqual(currentIdentity, expectedIdentity)) return false;
    }
    const parts = opfsPath.split("/");
    if (parts.length < 3) return false;
    const root = await navigator.storage.getDirectory();
    const dirPath = parts.slice(0, -1);
    const fileName = parts[parts.length - 1];
    let dir: FileSystemDirectoryHandle = root;
    for (const part of dirPath) {
      dir = await dir.getDirectoryHandle(part);
    }
    await dir.removeEntry(fileName);
    return true;
  } catch (error) {
    if (isNotFoundError(error)) return false;
    throw error;
  }
};

export const deleteAllMediaForItem = async (itemId: string): Promise<void> => {
  try {
    const mediaDir = await getMediaDir();
    await mediaDir.removeEntry(itemId, { recursive: true });
  } catch (error) {
    if (!isNotFoundError(error)) throw error;
  }
};

export const isGifUrl = (url: string): boolean => {
  try {
    const path = new URL(url).pathname.toLowerCase();
    return path.endsWith(".gif");
  } catch {
    return url.toLowerCase().endsWith(".gif");
  }
};

export const inferMediaType = (
  url: string,
  file?: File
): "image" | "video" => {
  if (file) {
    if (file.type.startsWith("video/")) return "video";
    return "image";
  }
  try {
    const path = new URL(url).pathname.toLowerCase();
    if (
      path.endsWith(".mp4") ||
      path.endsWith(".webm") ||
      path.endsWith(".mov") ||
      path.endsWith(".avi") ||
      path.endsWith(".mkv")
    ) {
      return "video";
    }
  } catch {
    if (
      url.toLowerCase().endsWith(".mp4") ||
      url.toLowerCase().endsWith(".webm") ||
      url.toLowerCase().endsWith(".mov")
    ) {
      return "video";
    }
  }
  return "image";
};

export const MEDIA_LIMITS = {
  image: 5,
  gif: 5,
  video: 4,
} as const;

export type MediaCategory = "image" | "gif" | "video";

export const categorizeMedia = (
  entry: { type: string; originalUrl: string }
): MediaCategory => {
  if (entry.type === "video") return "video";
  if (isGifUrl(entry.originalUrl)) return "gif";
  return "image";
};

export const getMediaCounts = (
  media: Array<{ type: string; originalUrl: string }>
): { image: number; gif: number; video: number } => {
  const counts = { image: 0, gif: 0, video: 0 };
  for (const entry of media) {
    counts[categorizeMedia(entry)]++;
  }
  return counts;
};

export const canAddMedia = (
  media: Array<{ type: string; originalUrl: string }>,
  category: MediaCategory
): boolean => {
  const counts = getMediaCounts(media);
  return counts[category] < MEDIA_LIMITS[category];
};

// --- R2 promotion ---

const METADATA_WORKER_BASE_URL = "https://metadata-worker.watermelons.workers.dev";
const IMPORT_MEDIA_ENDPOINT = `${METADATA_WORKER_BASE_URL}/import-media`;
const IMPORT_MEDIA_UPLOAD_TOKEN = import.meta.env.VITE_IMPORT_MEDIA_UPLOAD_TOKEN?.trim() || "";
const IMPORT_MEDIA_UPLOAD_RETRIES = 2;
const IMPORT_MEDIA_UPLOAD_TIMEOUT_MS = 25_000;
const IMPORT_MEDIA_RETRY_BASE_DELAY_MS = 350;

type MediaUploadResponse = { url?: string | null; key?: string; error?: string };
type UploadedMedia = { r2Url: string; key?: string };

const buildImportUploadHeaders = (contentType: string): Headers => {
  if (!IMPORT_MEDIA_UPLOAD_TOKEN) {
    throw new Error("IMPORT_MEDIA_UPLOAD_TOKEN_MISSING");
  }

  const headers = new Headers({ "Content-Type": contentType });
  headers.set("X-VS-Import-Token", IMPORT_MEDIA_UPLOAD_TOKEN);
  return headers;
};

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const isRetryableStatus = (status: number): boolean =>
  status === 408 || status === 409 || status === 425 || status === 429 || status >= 500;

const describeUploadError = (error: unknown): string => {
  if (error instanceof DOMException && error.name === "AbortError") {
    return `request timed out after ${IMPORT_MEDIA_UPLOAD_TIMEOUT_MS / 1000}s`;
  }
  if (error instanceof TypeError && error.message === "Failed to fetch") {
    return "network request failed";
  }
  return error instanceof Error ? error.message : String(error);
};

const fetchWithTimeout = async (endpoint: string, init: RequestInit): Promise<Response> => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), IMPORT_MEDIA_UPLOAD_TIMEOUT_MS);
  try {
    return await fetch(endpoint, {
      credentials: "omit",
      cache: "no-store",
      ...init,
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timer);
  }
};

const postImportMedia = async (
  initFactory: () => RequestInit,
  label: string
): Promise<MediaUploadResponse> => {
  let lastError = "";
  for (let attempt = 0; attempt <= IMPORT_MEDIA_UPLOAD_RETRIES; attempt += 1) {
    try {
      const response = await fetchWithTimeout(IMPORT_MEDIA_ENDPOINT, initFactory());
      const payload = (await response.json().catch(() => ({}))) as MediaUploadResponse;
      if (response.ok) return payload;

      lastError = payload.error || `${label} failed (${response.status})`;
      if (!isRetryableStatus(response.status)) break;
    } catch (error) {
      lastError = describeUploadError(error);
    }

    if (attempt < IMPORT_MEDIA_UPLOAD_RETRIES) {
      await wait(IMPORT_MEDIA_RETRY_BASE_DELAY_MS * 2 ** attempt);
    }
  }

  throw new Error(`${label} failed after ${IMPORT_MEDIA_UPLOAD_RETRIES + 1} attempts: ${lastError || "unknown error"}`);
};

const resolveUploadedMediaUrl = (payload: MediaUploadResponse): string | null => {
  if (payload.key) return `${METADATA_WORKER_BASE_URL}/r2/${encodeURIComponent(payload.key)}`;
  return payload.url || null;
};

const resolveUploadedMedia = (payload: MediaUploadResponse): UploadedMedia | null => {
  const r2Url = resolveUploadedMediaUrl(payload);
  if (!r2Url) return null;
  return { r2Url, key: payload.key };
};

export const readOpfsFile = async (opfsPath: string): Promise<File | null> => {
  try {
    const fileHandle = await getFileHandleFromOpfsPath(opfsPath);
    if (!fileHandle) return null;
    return await fileHandle.getFile();
  } catch (error) {
    if (isNotFoundError(error)) return null;
    throw error;
  }
};

const bytesToHex = (bytes: Uint8Array): string =>
  Array.from(bytes, (value) => value.toString(16).padStart(2, "0")).join("");

const fallbackSampleHash = (bytes: Uint8Array): string => {
  let hash = 0x811c9dc5;
  for (const value of bytes) {
    hash ^= value;
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
};

export const getBlobIdentity = async (
  blob: Blob,
  lastModified = blob instanceof File ? blob.lastModified : 0
): Promise<OpfsFileIdentity> => {
  const edge = OPFS_IDENTITY_EDGE_BYTES;
  const sample =
    blob.size <= edge * 2
      ? blob
      : new Blob([blob.slice(0, edge), blob.slice(blob.size - edge)]);
  const sampleBytes = new Uint8Array(await sample.arrayBuffer());
  const subtle = globalThis.crypto?.subtle;
  const sampleSha256 = subtle
    ? bytesToHex(new Uint8Array(await subtle.digest("SHA-256", sampleBytes)))
    : fallbackSampleHash(sampleBytes);
  return { size: blob.size, lastModified, sampleSha256 };
};

export const readOpfsFileIdentity = async (
  opfsPath: string
): Promise<OpfsFileIdentity | null> => {
  const file = await readOpfsFile(opfsPath);
  return file ? getBlobIdentity(file, file.lastModified) : null;
};

export const opfsFileIdentitiesEqual = (
  left: OpfsFileIdentity | null | undefined,
  right: OpfsFileIdentity | null | undefined
): boolean =>
  !!left &&
  !!right &&
  left.size === right.size &&
  left.lastModified === right.lastModified &&
  left.sampleSha256 === right.sampleSha256;

export const cloneOpfsMediaEntriesForItem = async (
  media: ItemDocType["media"],
  destinationItemId: string,
  options?: {
    readOpfsFile?: typeof readOpfsFile;
    saveMediaToOpfs?: typeof saveMediaToOpfs;
  }
): Promise<{
  media: ItemDocType["media"];
  pathMap: Map<string, string>;
}> => {
  if (!media?.length) return { media, pathMap: new Map() };

  const pathMap = new Map<string, string>();
  const cloned = [] as NonNullable<ItemDocType["media"]>;
  const readFile = options?.readOpfsFile || readOpfsFile;
  const saveFile = options?.saveMediaToOpfs || saveMediaToOpfs;
  for (const entry of media) {
    const sourcePath = typeof entry?.opfsPath === "string" ? entry.opfsPath : "";
    if (!sourcePath) {
      cloned.push({ ...entry });
      continue;
    }

    let destinationPath = pathMap.get(sourcePath);
    if (!destinationPath) {
      const sourceFile = await readFile(sourcePath);
      if (!sourceFile) throw new Error(`OPFS_MEDIA_COPY_SOURCE_MISSING:${sourcePath}`);
      const saved = await saveFile(destinationItemId, sourceFile);
      destinationPath = saved.opfsPath;
      pathMap.set(sourcePath, destinationPath);
    }
    cloned.push({ ...entry, opfsPath: destinationPath, storageType: "opfs" });
  }
  return { media: cloned, pathMap };
};

/** Bounded parallel map that always writes results at the source index. */
export const mapWithConcurrencyStable = async <Input, Output>(
  values: readonly Input[],
  concurrency: number,
  mapper: (value: Input, index: number) => Promise<Output>
): Promise<Output[]> => {
  if (values.length === 0) return [];
  const workerCount = Math.max(1, Math.min(values.length, Math.floor(concurrency) || 1));
  const results = new Array<Output>(values.length);
  let nextIndex = 0;
  await Promise.all(
    Array.from({ length: workerCount }, async () => {
      while (true) {
        const index = nextIndex;
        nextIndex += 1;
        if (index >= values.length) return;
        results[index] = await mapper(values[index], index);
      }
    })
  );
  return results;
};

export type OpfsCleanupFile = {
  opfsPath: string;
  sourceIdentity: OpfsFileIdentity;
};

/**
 * Collects one bounded promotion-run cleanup request. Overflow is deliberately
 * left in OPFS: leaking an orphan is safer than retaining an unbounded path set
 * or triggering another full-library reference scan.
 */
export class BoundedOpfsCleanupBatch {
  private readonly filesByPath = new Map<string, OpfsCleanupFile>();
  private didOverflow = false;

  constructor(private readonly maxFiles: number) {}

  add(file: OpfsCleanupFile): void {
    const opfsPath = typeof file?.opfsPath === "string" ? file.opfsPath : "";
    if (!opfsPath || this.filesByPath.has(opfsPath)) return;
    if (this.filesByPath.size >= Math.max(0, Math.floor(this.maxFiles))) {
      this.didOverflow = true;
      return;
    }
    this.filesByPath.set(opfsPath, file);
  }

  get size(): number {
    return this.filesByPath.size;
  }

  get overflowed(): boolean {
    return this.didOverflow;
  }

  async flush(
    cleanup: (files: OpfsCleanupFile[]) => Promise<void>
  ): Promise<boolean> {
    if (this.filesByPath.size === 0) return false;
    const files = Array.from(this.filesByPath.values());
    this.filesByPath.clear();
    await cleanup(files);
    return true;
  }
}

export const uploadOpfsFileToR2 = async (
  opfsPath: string,
  fileName?: string
): Promise<(UploadedMedia & { sourceIdentity: OpfsFileIdentity }) | null> => {
  const file = await readOpfsFile(opfsPath);
  if (!file) return null;
  const sourceIdentity = await getBlobIdentity(file, file.lastModified);
  const uploaded = await uploadBlobToR2(file, fileName || file.name);
  return uploaded ? { ...uploaded, sourceIdentity } : null;
};

export const uploadBlobToR2 = async (
  blob: Blob,
  fileName?: string,
  options?: { sourcePageUrl?: string | null; label?: string }
): Promise<UploadedMedia | null> => {
  if (blob.size <= 0) throw new Error("IMPORT_MEDIA_EMPTY_FILE");

  const contentType = blob.type || "application/octet-stream";
  const payload = await postImportMedia(
    () => {
      const headers = buildImportUploadHeaders(contentType);
      if (fileName) headers.set("X-VS-File-Name", fileName);
      if (options?.sourcePageUrl) headers.set("X-VS-Source-Url", options.sourcePageUrl);
      // Blob/File bodies are reusable by fetch. Keeping the original object
      // avoids one full-file ArrayBuffer plus another clone on every retry.
      return { method: "POST", headers, body: blob };
    },
    options?.label || "Media upload"
  );
  return resolveUploadedMedia(payload);
};

export const uploadRemoteMediaToR2 = async (
  remoteUrl: string,
  sourcePageUrl?: string | null
): Promise<UploadedMedia | null> => {
  const body = JSON.stringify({ remoteUrl, sourcePageUrl: sourcePageUrl || remoteUrl });
  const payload = await postImportMedia(
    () => ({
      method: "POST",
      headers: buildImportUploadHeaders("application/json"),
      body,
    }),
    "Remote media upload"
  );
  return resolveUploadedMedia(payload);
};
