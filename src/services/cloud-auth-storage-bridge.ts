import { CLOUD_SYNC_TOKEN_KEY } from "./cloud-config";

export const CLOUD_AUTH_EXPIRES_AT_KEY = "vibesearch:firebaseIdTokenExpiresAt";
export const CLOUD_AUTH_PROFILE_KEY = "vibesearch:cloudAuthProfile:v1";
export const CLOUD_AUTH_OPT_IN_KEY = "vibesearch:cloudAuthOptIn:v1";
/**
 * When the API last refused this session. A local expiry claim is not proof of
 * validity — an opaque or unparseable token has no expiry at all — so the
 * server's verdict is persisted and outranks it.
 */
export const CLOUD_AUTH_REJECTED_AT_KEY = "vibesearch:cloudAuthRejectedAt:v1";

export const CLOUD_AUTH_STORAGE_BRIDGE_MESSAGE = "CLOUD_AUTH_STORAGE_BRIDGE";

const CLOUD_AUTH_STORAGE_KEYS = new Set([
  CLOUD_SYNC_TOKEN_KEY,
  CLOUD_AUTH_EXPIRES_AT_KEY,
  CLOUD_AUTH_PROFILE_KEY,
  CLOUD_AUTH_OPT_IN_KEY,
  CLOUD_AUTH_REJECTED_AT_KEY,
]);
const MAX_CLOUD_AUTH_STORAGE_BYTES = 64 * 1024;

type CloudAuthStorageBridgeOperation = "get" | "set" | "remove";

export type CloudAuthStorageBridgePayload = {
  operation?: CloudAuthStorageBridgeOperation;
  keys?: unknown;
  values?: unknown;
};

type StorageArea = Pick<chrome.storage.LocalStorageArea, "get" | "set" | "remove">;

type BridgeResponse<T = unknown> = {
  success?: boolean;
  payload?: T;
  error?: string;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const normalizeKeys = (value: unknown): string[] => {
  const keys = typeof value === "string" ? [value] : Array.isArray(value) ? value : [];
  if (
    keys.length === 0 ||
    keys.some((key) => typeof key !== "string" || !CLOUD_AUTH_STORAGE_KEYS.has(key))
  ) {
    throw new Error("CLOUD_AUTH_STORAGE_KEYS_INVALID");
  }
  return [...new Set(keys)];
};

const normalizeValues = (value: unknown): Record<string, unknown> => {
  if (!isRecord(value)) throw new Error("CLOUD_AUTH_STORAGE_VALUES_INVALID");
  const keys = normalizeKeys(Object.keys(value));
  const values = Object.fromEntries(keys.map((key) => [key, value[key]]));
  if (new TextEncoder().encode(JSON.stringify(values)).byteLength > MAX_CLOUD_AUTH_STORAGE_BYTES) {
    throw new Error("CLOUD_AUTH_STORAGE_VALUES_TOO_LARGE");
  }
  return values;
};

/**
 * Brave offscreen documents expose chrome.runtime but not chrome.storage.
 * This bridge is deliberately limited to the four Cloud Auth rows and accepts
 * requests only from the extension's exact offscreen-document URL.
 */
export const handleCloudAuthStorageBridge = async (
  payload: CloudAuthStorageBridgePayload,
  storage: StorageArea = chrome.storage.local,
): Promise<unknown> => {
  switch (payload?.operation) {
    case "get": {
      const keys = normalizeKeys(payload.keys);
      const row = await storage.get(keys);
      return Object.fromEntries(keys.map((key) => [key, row[key]]));
    }
    case "set": {
      await storage.set(normalizeValues(payload.values));
      return undefined;
    }
    case "remove": {
      await storage.remove(normalizeKeys(payload.keys));
      return undefined;
    }
    default:
      throw new Error("CLOUD_AUTH_STORAGE_OPERATION_INVALID");
  }
};

export const isCloudAuthStorageBridgeSender = (
  sender: Pick<chrome.runtime.MessageSender, "id" | "url" | "tab">,
  runtimeId: string,
  offscreenUrl: string,
): boolean =>
  sender?.id === runtimeId &&
  !sender.tab &&
  typeof sender.url === "string" &&
  sender.url === offscreenUrl;

const requestStorage = async <T>(
  payload: CloudAuthStorageBridgePayload,
): Promise<T> => {
  const response = await chrome.runtime.sendMessage({
    target: "background",
    type: CLOUD_AUTH_STORAGE_BRIDGE_MESSAGE,
    payload,
  }) as BridgeResponse<T>;
  if (!response?.success) {
    throw new Error(response?.error || "CLOUD_AUTH_STORAGE_BRIDGE_FAILED");
  }
  return response.payload as T;
};

export const runtimeCloudAuthStorage = {
  get: (keys: string | string[]) =>
    requestStorage<Record<string, unknown>>({ operation: "get", keys }),
  set: (values: Record<string, unknown>) =>
    requestStorage<void>({ operation: "set", values }),
  remove: (keys: string | string[]) =>
    requestStorage<void>({ operation: "remove", keys }),
};
