import type { JsonValue } from "@src/common/json-value";
import type { ItemDocType } from "@src/schemas/item_schema";
import type {
  QueryDebugPayload,
  QueryRankDebugScore,
  QueryVectorStatsDebug,
  QueryVectorTopHitDebug,
  RankQueryCursor,
} from "@src/search-core/contracts";
import { z } from "zod";
import type { SearchQueryDiagnostics, SearchQueryPayload } from "./model";

const itemSourceSchema: z.ZodType<ItemDocType["source"]> = z.enum([
  "web",
  "twitter",
  "reddit",
  "note",
  "youtube",
  "instagram",
  "tiktok",
  "substack",
  "linkedin",
  "threads",
  "mastodon",
  "bluesky",
  "github",
  "spotify",
  "ytmusic",
  "vimeo",
  "soundcloud",
  "article",
]);

const mediaSchema = z
  .object({
    type: z.enum(["image", "video", "audio", "file"]),
    originalUrl: z.string(),
    storageType: z.enum(["hotlink", "opfs", "s3"]),
  })
  .passthrough();

const itemSchema: z.ZodType<ItemDocType> = z
  .object({
    id: z.string(),
    userId: z.string().nullable(),
    title: z.string(),
    textContent: z.string(),
    ocrText: z.string().optional(),
    ocrStatus: z.enum(["pending", "processing", "done", "error", "skipped"]),
    ocrModelVersion: z.string(),
    ocrUpdatedAt: z.number().int().nonnegative(),
    url: z.string(),
    source: itemSourceSchema,
    folderId: z.string(),
    spaceId: z.string(),
    isFavorite: z.boolean(),
    authorUsername: z.string().optional(),
    media: z.array(mediaSchema).optional(),
    parentId: z.string().nullable(),
    vector_index: z.number().int().optional(),
    vector_indexes: z.array(z.number().int()).optional(),
    isEmbedded: z.boolean(),
    isMetaFetched: z.boolean(),
    isDirty: z.boolean(),
    serverVersion: z.number(),
    createdAt: z.number().int().nonnegative(),
    updatedAt: z.number().int().nonnegative(),
    deletedAt: z.number().int().nonnegative(),
  })
  .passthrough();

const rankCursorSchema: z.ZodType<RankQueryCursor> = z.object({
  queryHash: z.string(),
  id: z.string(),
  relevance: z.number(),
  createdAt: z.number(),
  updatedAt: z.number(),
  title: z.string(),
  source: itemSourceSchema,
});

const diagnosticsSchema: z.ZodType<SearchQueryDiagnostics> = z.object({
  queryHash: z.string(),
  candidateCount: z.number().int().nonnegative(),
  rankInputCount: z.number().int().nonnegative(),
  usedSimpleSortPath: z.boolean(),
  scoreBudget: z.number().int().nonnegative(),
  supersededCount: z.number().int().nonnegative(),
  fallbackCount: z.number().int().nonnegative(),
  selectorMs: z.number().nonnegative(),
  filterMs: z.number().nonnegative(),
  lexicalMs: z.number().nonnegative(),
  vectorMs: z.number().nonnegative(),
  vectorEmbedMs: z.number().nonnegative(),
  vectorScanMs: z.number().nonnegative(),
  rankMs: z.number().nonnegative(),
  hydrateMs: z.number().nonnegative(),
  totalMs: z.number().nonnegative(),
});

const rankDebugScoreSchema: z.ZodType<QueryRankDebugScore> = z.object({
  itemId: z.string(),
  rank: z.number(),
  lexicalScore: z.number(),
  vectorScore: z.number(),
  fusedScore: z.number(),
  lexicalRank: z.number().optional(),
  vectorRank: z.number().optional(),
  matchedLexical: z.boolean(),
  matchedVector: z.boolean(),
});

const vectorTopHitSchema: z.ZodType<QueryVectorTopHitDebug> = z.object({
  index: z.number().int(),
  score: z.number(),
  itemId: z.string().optional(),
  title: z.string().optional(),
});

const vectorStatsSchema: z.ZodType<QueryVectorStatsDebug> = z.object({
  candidateCount: z.number().int().nonnegative(),
  rawHitCount: z.number().int().nonnegative(),
  keptHitCount: z.number().int().nonnegative(),
  topScore: z.number().nullable(),
  minAcceptedScore: z.number().nullable(),
  mode: z.enum(["vector", "hybrid"]),
});

const debugPayloadSchema: z.ZodType<QueryDebugPayload> = z.object({
  queryHash: z.string(),
  perItem: z.array(rankDebugScoreSchema),
  vectorTopHits: z.array(vectorTopHitSchema),
  vectorStats: vectorStatsSchema.optional(),
});

const queryPayloadSchema: z.ZodType<SearchQueryPayload> = z.object({
  items: z.array(itemSchema),
  total: z.number().int().nonnegative(),
  totalIsExact: z.boolean().optional(),
  vectorHits: z.number().int().nonnegative(),
  lexicalHits: z.number().int().nonnegative(),
  vectorError: z.string().nullable().optional(),
  page: z.number().int().positive(),
  limit: z.number().int().positive(),
  hasMore: z.boolean(),
  nextCursor: rankCursorSchema.nullable().optional(),
  diagnostics: diagnosticsSchema.optional(),
  debug: debugPayloadSchema.optional(),
  superseded: z.boolean().optional(),
});

const queryResponseSchema = z.object({
  success: z.boolean(),
  error: z.string().optional(),
  payload: queryPayloadSchema.optional(),
});

export function parseSearchQueryResponse(response: JsonValue): {
  success: boolean;
  error?: string;
  payload?: SearchQueryPayload;
} {
  return queryResponseSchema.parse(response);
}

const itemListResponseSchema = z.object({
  success: z.boolean(),
  payload: z.array(itemSchema).optional(),
});

type ItemListResponse = {
  success: boolean;
  payload: ItemDocType[];
};

export function parseItemListResponse(response: JsonValue): ItemListResponse {
  const parsed = itemListResponseSchema.parse(response);
  return { success: parsed.success, payload: parsed.payload ?? [] };
}
