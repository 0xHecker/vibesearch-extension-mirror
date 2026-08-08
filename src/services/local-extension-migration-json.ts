import type { LocalExtensionMigrationBundle } from "@src/services/local-extension-migration";

/** Serialize large binary arrays as separate Blob parts to reduce peak heap. */
export const createLocalMigrationJsonBlob = (
  bundle: LocalExtensionMigrationBundle,
): Blob => {
  const parts: BlobPart[] = [
    `{"format":${JSON.stringify(bundle.format)},`,
    `"version":${bundle.version},`,
    `"createdAt":${bundle.createdAt},`,
    `"collections":${JSON.stringify(bundle.collections)},`,
    '"opfsFiles":[',
  ];
  bundle.opfsFiles.forEach((file, index) => {
    if (index > 0) parts.push(",");
    // Keep the already-large base64 payload as its own Blob part. Serializing
    // the whole object would allocate a second library-sized JS string before
    // Blob construction.
    parts.push(
      `{"opfsPath":${JSON.stringify(file.opfsPath)},"mimeType":${JSON.stringify(file.mimeType)},"base64":"`,
      file.base64,
      '"}',
    );
  });
  parts.push('],"archiveFiles":[');
  bundle.archiveFiles.forEach((file, index) => {
    if (index > 0) parts.push(",");
    parts.push(
      `{"itemId":${JSON.stringify(file.itemId)},"mimeType":${JSON.stringify(file.mimeType)},"updatedAt":${file.updatedAt},"base64":"`,
      file.base64,
      '"}',
    );
  });
  parts.push(`],"warnings":${JSON.stringify(bundle.warnings)}}`);
  return new Blob(parts, { type: "application/json" });
};
