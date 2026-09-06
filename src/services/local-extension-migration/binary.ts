export const LOCAL_MIGRATION_MAX_JSON_BYTES = 192 * 1024 * 1024;
export const LOCAL_MIGRATION_MAX_DECODED_BYTES = 112 * 1024 * 1024;
export const LOCAL_MIGRATION_MAX_MEDIA_FILE_BYTES = 32 * 1024 * 1024;
export const LOCAL_MIGRATION_MAX_ARCHIVE_FILE_BYTES = 40 * 1024 * 1024;
export const LOCAL_MIGRATION_MAX_ARCHIVE_TOTAL_BYTES = 112 * 1024 * 1024;
export const LOCAL_MIGRATION_MAX_BINARY_FILES = 50_000;

const BASE64_ENCODE_CHUNK_SIZE = 0x6000;
const BASE64_DECODE_CHUNK_SIZE = 0x8000;
const utf8Encoder = new TextEncoder();

export const toBase64 = (buffer: ArrayBuffer): string => {
  const bytes = new Uint8Array(buffer);
  const encoded: string[] = [];
  // The chunk size is divisible by three, so concatenated chunks contain no
  // padding in the middle of the payload.
  for (
    let offset = 0;
    offset < bytes.length;
    offset += BASE64_ENCODE_CHUNK_SIZE
  ) {
    const binary = String.fromCharCode(
      ...bytes.subarray(offset, offset + BASE64_ENCODE_CHUNK_SIZE),
    );
    encoded.push(btoa(binary));
  }
  return encoded.join("");
};

export const serializedUtf8ByteLength = (value: any): number =>
  utf8Encoder.encode(JSON.stringify(value)).byteLength;

export const encodedBase64Length = (decodedByteLength: number): number =>
  4 * Math.ceil(decodedByteLength / 3);

export const decodedBase64ByteLength = (value: string): number => {
  if (!value || !/^[A-Za-z0-9+/]*={0,2}$/.test(value)) return -1;
  const firstPadding = value.indexOf("=");
  const paddingLength = value.endsWith("==") ? 2 : value.endsWith("=") ? 1 : 0;
  if (
    firstPadding >= 0 &&
    firstPadding < value.length - paddingLength
  ) {
    return -1;
  }
  const remainder = value.length % 4;
  if (remainder === 1 || (paddingLength > 0 && remainder !== 0)) return -1;

  const dataRemainder = (value.length - paddingLength) % 4;
  if (
    (paddingLength === 1 && dataRemainder !== 3) ||
    (paddingLength === 2 && dataRemainder !== 2)
  ) {
    return -1;
  }
  return Math.floor((value.length * 3) / 4) - paddingLength;
};

export const fromBase64Parts = (value: string): Uint8Array[] => {
  const parts: Uint8Array[] = [];
  for (
    let offset = 0;
    offset < value.length;
    offset += BASE64_DECODE_CHUNK_SIZE
  ) {
    const binary = atob(value.slice(offset, offset + BASE64_DECODE_CHUNK_SIZE));
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) {
      bytes[index] = binary.charCodeAt(index);
    }
    parts.push(bytes);
  }
  return parts;
};

export type ParsedOpfsPath = {
  itemId: string;
  fileName: string;
};

export const parseOpfsPath = (opfsPath: string): ParsedOpfsPath | null => {
  const parts = opfsPath.split("/").filter(Boolean);
  if (parts.length !== 3 || parts[0] !== "media") return null;
  const [, itemId, fileName] = parts;
  if (!itemId || !fileName || itemId.includes("/") || fileName.includes("/")) {
    return null;
  }
  return { itemId, fileName };
};
