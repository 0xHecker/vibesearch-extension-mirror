import { z } from "zod";
import type { JsonValue } from "@src/common/json-value";
import { CLOUD_SYNC_API_BASE_KEY } from "./cloud-config";
import {
  CLOUD_PULL_ENABLED_KEY,
  CLOUD_SYNC_CLIENT_ID_KEY,
  CLOUD_SYNC_PULL_STATE_KEY,
  CLOUD_SYNC_QUEUE_KEY,
} from "./cloud-sync/model";

export const OFFSCREEN_STORAGE_BRIDGE_MESSAGE = "OFFSCREEN_STORAGE_BRIDGE";
export const COMPANION_IMPORT_KEY = "vibesearch.companion-import.v1";
export const EMBEDDING_TEXT_VERSION_KEY = "vibe.search.embeddingTextVersion";
export const EMBEDDING_STATE_REPAIR_KEY = "vibe.search.embeddingStateRepairVersion";

const storageKeySchema = z.enum([
  CLOUD_SYNC_QUEUE_KEY, CLOUD_SYNC_CLIENT_ID_KEY, CLOUD_SYNC_PULL_STATE_KEY,
  CLOUD_PULL_ENABLED_KEY, CLOUD_SYNC_API_BASE_KEY,
  COMPANION_IMPORT_KEY, EMBEDDING_TEXT_VERSION_KEY, EMBEDDING_STATE_REPAIR_KEY,
]);
const requestSchema = z.discriminatedUnion("operation", [
  z.object({ operation: z.literal("get"), key: storageKeySchema }).strict(),
  z.object({ operation: z.literal("set"), key: storageKeySchema, value: z.json() }).strict(),
  z.object({ operation: z.literal("remove"), key: storageKeySchema }).strict(),
]);
type StorageRequest = z.infer<typeof requestSchema>;
type StorageArea = Pick<chrome.storage.LocalStorageArea, "get" | "set" | "remove">;

export async function handleOffscreenStorageBridge(payload: unknown, storage: StorageArea = chrome.storage.local): Promise<unknown> {
  const request = requestSchema.parse(payload);
  switch (request.operation) {
    case "get": return storage.get(request.key);
    case "set": await storage.set({ [request.key]: request.value }); return null;
    case "remove": await storage.remove(request.key); return null;
  }
}

const responseSchema = z.object({ success: z.boolean(), payload: z.unknown().optional(), error: z.string().optional() });
const storageRowSchema = z.record(z.string(), z.unknown());

async function requestStorage(payload: StorageRequest): Promise<unknown> {
  const response = responseSchema.parse(await chrome.runtime.sendMessage({
    target: "background", type: OFFSCREEN_STORAGE_BRIDGE_MESSAGE, payload,
  }));
  if (!response.success) throw new Error(response.error || "OFFSCREEN_STORAGE_BRIDGE_FAILED");
  return response.payload;
}

export const runtimeOffscreenStorage = {
  async get(key: string): Promise<Record<string, unknown>> {
    return storageRowSchema.parse(await requestStorage({ operation: "get", key: storageKeySchema.parse(key) }));
  },
  async set(key: string, value: JsonValue): Promise<void> {
    await requestStorage({ operation: "set", key: storageKeySchema.parse(key), value });
  },
  async remove(key: string): Promise<void> {
    await requestStorage({ operation: "remove", key: storageKeySchema.parse(key) });
  },
};
