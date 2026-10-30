import { z } from "zod";

export const LOCAL_COMPANION_HOST = "app.vibesearch.local";
export const LOCAL_MESSAGE_MAX_BYTES = 256 * 1024;
export const LOCAL_LIBRARY_PATH = "src/pages/local/index.html";

export const localHttpUrlSchema = z.string().max(8192).refine((value) => {
  try {
    const url = new URL(value);
    return (url.protocol === "http:" || url.protocol === "https:") && !url.username && !url.password;
  } catch {
    return false;
  }
}, "A credential-free HTTP(S) URL is required.");

export const localOriginalSchema = z.object({ id: z.string().min(1).max(256), contentHash: z.string().regex(/^[a-f0-9]{64}$/u), byteSize: z.number().int().nonnegative().max(128 * 1024 * 1024), type: z.enum(["file", "image", "audio", "video"]), mimeType: z.string().min(1).max(256), fileName: z.string().min(1).max(256) }).strict();
export const localCaptureSchema = z.object({
  id: z.uuid(),
  url: localHttpUrlSchema,
  title: z.string().max(2000),
  text: z.string().max(120000),
  capturedAt: z.number().int().min(0).max(8640000000000000),
  kind: z.enum(["web", "image"]).optional(),
  originals: z.array(localOriginalSchema).max(63).optional(),
  gaps: z.array(z.string().max(512)).max(16),
}).strict();
export type LocalCapture = z.infer<typeof localCaptureSchema>;

export const localImportChunkResultSchema = z.object({ contentHash: z.string().length(64), offset: z.number().int().nonnegative(), complete: z.boolean() }).strict();
export const localImportRecordResultSchema = z.object({ captureId: z.uuid(), itemId: z.string(), imported: z.literal(true), replayed: z.boolean() }).strict();
export const localOriginalResultSchema = z.object({ mediaId: z.string(), fileName: z.string(), mimeType: z.string(), contentHash: z.string().length(64), byteSize: z.number().int().nonnegative(), offset: z.number().int().nonnegative(), data: z.string().max(87384), nextOffset: z.number().int().nonnegative().nullable() }).strict();
export const localMigrationProgressSchema = z.object({ imported: z.number().int().nonnegative(), skipped: z.number().int().nonnegative(), done: z.boolean(), lastId: z.string() }).strict();
export const localRequestSchema = z.discriminatedUnion("action", [
  z.object({ version: z.literal(1), id: z.uuid(), action: z.literal("status") }).strict(),
  z.object({ version: z.literal(1), id: z.uuid(), action: z.literal("save"), capture: localCaptureSchema }).strict(),
  z.object({ version: z.literal(1), id: z.uuid(), action: z.literal("search"), query: z.string().trim().min(1).max(1024), limit: z.number().int().min(1).max(30), cursor: z.string().max(2048).optional() }).strict(),
  z.object({ version: z.literal(1), id: z.uuid(), action: z.literal("read"), itemId: z.string().min(1).max(512), partId: z.string().max(512).optional(), sourceHash: z.string().regex(/^[a-f0-9]{64}$/u).optional(), start: z.number().int().nonnegative().default(0), maxChars: z.number().int().min(1).max(16000).default(8000) }).strict(),
  z.object({ version: z.literal(1), id: z.uuid(), action: z.literal("import-chunk"), contentHash: z.string().regex(/^[a-f0-9]{64}$/u), byteSize: z.number().int().nonnegative().max(128 * 1024 * 1024), offset: z.number().int().nonnegative(), data: z.string().max(87384).regex(/^[A-Za-z0-9+/]*={0,2}$/u) }).strict(),
  z.object({ version: z.literal(1), id: z.uuid(), action: z.literal("import-record"), profileId: z.uuid(), legacyId: z.string().min(1).max(512), source: localOriginalSchema, originals: z.array(localOriginalSchema).max(63) }).strict(),
  z.object({ version: z.literal(1), id: z.uuid(), action: z.literal("read-original"), itemId: z.string().min(1).max(512), mediaId: z.string().min(1).max(256), offset: z.number().int().nonnegative().default(0) }).strict(),
]);
export type LocalRequest = z.infer<typeof localRequestSchema>;
export type LocalStatusRequest = Extract<LocalRequest, { action: "status" }>;
export type LocalSaveRequest = Extract<LocalRequest, { action: "save" }>;
export type LocalSearchRequest = Extract<LocalRequest, { action: "search" }>;
export type LocalReadRequest = Extract<LocalRequest, { action: "read" }>;

export const localStatusResultSchema = z.object({
  ready: z.literal(true), mode: z.literal("local"), transport: z.literal("native-messaging"),
  items: z.number().int().nonnegative(), passages: z.number().int().nonnegative(), generation: z.number().int().nonnegative(),
  accountRequired: z.literal(false), cloudSync: z.literal("optional_explicit"),
}).strict();
export const localSaveResultSchema = z.object({
  captureId: z.uuid(), itemId: z.string(), saved: z.literal(true), replayed: z.boolean(), cloudSynced: z.boolean(),
}).strict();
export const localSearchResultSchema = z.object({
  hits: z.array(z.object({ itemId: z.string(), title: z.string().max(240), url: localHttpUrlSchema.nullable(), snippet: z.string().max(340), gaps: z.array(z.string().max(512)).max(3) }).strict()).max(30),
  generation: z.number().int().nonnegative(), network: z.literal("local"), mode: z.literal("text"),
  nextCursor: z.string().max(2048).nullable().default(null),
}).strict();
export const localReadResultSchema = z.object({
  itemId: z.string(), title: z.string().max(2000), url: localHttpUrlSchema.nullable(),
  parts: z.array(z.object({ partId: z.string(), label: z.string(), kind: z.string(), coverage: z.string(), sourceHash: z.string().length(64), length: z.number().int().nonnegative() }).strict()).max(50),
  originals: z.array(z.object({ mediaId: z.string(), fileName: z.string(), mimeType: z.string(), byteSize: z.number().int().nonnegative().nullable(), local: z.boolean() })).max(64),
  partsTruncated: z.boolean(), partId: z.string().nullable(), sourceHash: z.string().nullable(), text: z.string().max(16000), start: z.number().int().nonnegative(),
  nextCursor: z.number().int().nonnegative().nullable(), totalChars: z.number().int().nonnegative(), coverage: z.string(), gaps: z.array(z.string().max(512)).max(16), network: z.literal("local"),
}).strict();
export type LocalStatusResult = z.infer<typeof localStatusResultSchema>;
export type LocalSaveResult = z.infer<typeof localSaveResultSchema>;
export type LocalSearchResult = z.infer<typeof localSearchResultSchema>;
export type LocalReadResult = z.infer<typeof localReadResultSchema>;
export type LocalNativeResult = LocalStatusResult | LocalSaveResult | LocalSearchResult | LocalReadResult | z.infer<typeof localImportChunkResultSchema> | z.infer<typeof localImportRecordResultSchema> | z.infer<typeof localOriginalResultSchema>;

export const localResponseSchema = z.discriminatedUnion("ok", [
  z.object({ version: z.literal(1), id: z.uuid(), ok: z.literal(true), result: z.unknown() }).strict(),
  z.object({ version: z.literal(1), id: z.uuid().optional(), ok: z.literal(false), error: z.string().min(1).max(512) }).strict(),
]);

export const localRequestBytes = (request: LocalRequest): number => new TextEncoder().encode(JSON.stringify(request)).byteLength;

export function sliceLocalText(text: string, limit: number): string {
  let end = Math.min(limit, text.length);
  const last = text.charCodeAt(end - 1);
  if (last >= 0xd800 && last <= 0xdbff) end -= 1;
  return text.slice(0, end);
}

export function fitLocalCapture(rawCapture: LocalCapture): LocalCapture {
  let capture = localCaptureSchema.parse(rawCapture);
  const request = () => ({ version: 1, id: capture.id, action: "save", capture } satisfies LocalRequest);
  if (localRequestBytes(request()) <= LOCAL_MESSAGE_MAX_BYTES) return capture;
  const gap = "Text was shortened to fit the local companion message limit.";
  capture = { ...capture, gaps: [...capture.gaps.slice(0, 15), gap] };
  while (localRequestBytes(request()) > LOCAL_MESSAGE_MAX_BYTES) {
    capture = { ...capture, text: sliceLocalText(capture.text, Math.max(0, capture.text.length - 4096)) };
    if (!capture.text && localRequestBytes(request()) > LOCAL_MESSAGE_MAX_BYTES) throw new Error("LOCAL_CAPTURE_TOO_LARGE");
  }
  return capture;
}

export class LocalCompanionError extends Error {
  constructor(public readonly code: string) { super(code); }
}

export const localCommandSchema = z.discriminatedUnion("action", [
  z.object({ target: z.literal("local-companion"), action: z.literal("save-screenshot"), tabId: z.number().int().nonnegative(), mode: z.enum(["visible", "region"]).default("visible") }).strict(),
  z.object({ target: z.literal("local-companion"), action: z.literal("inspect-outbox-original"), captureId: z.uuid(), mediaId: z.string().min(1).max(256), offset: z.number().int().nonnegative().default(0) }).strict(),
  z.object({ target: z.literal("local-companion"), action: z.literal("import-legacy") }).strict(),
  z.object({ target: z.literal("local-companion"), action: z.literal("read-original"), itemId: z.string().min(1).max(512), mediaId: z.string().min(1).max(256), offset: z.number().int().nonnegative().default(0) }).strict(),
  z.object({ target: z.literal("local-companion"), action: z.literal("status") }).strict(),
  z.object({ target: z.literal("local-companion"), action: z.literal("save-tab"), tabId: z.number().int().nonnegative() }).strict(),
  z.object({ target: z.literal("local-companion"), action: z.literal("retry") }).strict(),
  z.object({ target: z.literal("local-companion"), action: z.literal("search"), query: z.string().trim().min(1).max(1024), limit: z.number().int().min(1).max(30), cursor: z.string().max(2048).optional() }).strict(),
  z.object({ target: z.literal("local-companion"), action: z.literal("read"), itemId: z.string().min(1).max(512), partId: z.string().max(512).optional(), sourceHash: z.string().regex(/^[a-f0-9]{64}$/u).optional(), start: z.number().int().nonnegative().default(0), maxChars: z.number().int().min(1).max(16000).default(8000) }).strict(),
  z.object({ target: z.literal("local-companion"), action: z.literal("inspect-outbox"), captureId: z.uuid() }).strict(),
  z.object({ target: z.literal("local-companion"), action: z.literal("dismiss-outbox"), captureId: z.uuid() }).strict(),
  z.object({ target: z.literal("local-companion"), action: z.literal("repair-outbox"), captureId: z.uuid() }).strict(),
]);
export type LocalCommand = z.infer<typeof localCommandSchema>;
