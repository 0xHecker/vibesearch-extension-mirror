// Drive snapshots are JSON-stringified in the offscreen document. Bounding the
// staged file prevents a single backup from multiplying into hundreds of MiB
// across the object graph, JSON string and Blob backing store.
export const GOOGLE_BACKUP_MAX_BYTES = 64 * 1024 * 1024;
export const GOOGLE_BACKUP_REQUEST_TIMEOUT_MS = 60_000;
export const GOOGLE_BACKUP_MULTIPART_MAX_BYTES = 5 * 1024 * 1024;
export const GOOGLE_BACKUP_UPLOAD_TIMEOUT_MS = 5 * 60_000;
