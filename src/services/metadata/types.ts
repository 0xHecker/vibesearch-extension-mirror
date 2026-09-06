import type { JsonObject } from "@src/common/json-value";
import type { ItemDocType } from "@src/schemas/item_schema";

export type MetadataEntry = JsonObject;

export type MetadataFetchResult = {
  metadata: Record<string, Partial<ItemDocType>>;
  successfulUrls: Set<string>;
  failedUrls: Set<string>;
  queuedUrls: Set<string>;
  queuedRetryDelays: Map<string, number>;
  failedRetryDelays: Map<string, number>;
};

export type MetadataFetchRuntime = {
  generation: number;
  isCurrentGeneration(generation: number): boolean;
  activeControllers: Set<AbortController>;
};

export type MetadataImageAsset = {
  url: string;
  width?: number;
  height?: number;
};

export type MetadataVideoAsset = {
  url: string;
  embedUrl?: string;
  embedType?: "iframe";
  width?: number;
  height?: number;
};
