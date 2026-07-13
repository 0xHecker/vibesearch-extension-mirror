import { RxJsonSchema } from "rxdb";

export type MediaOcrMetadata = {
  status: "pending" | "processing" | "done" | "error" | "skipped";
  text?: string;
  confidence?: number | null;
  lineCount?: number;
  modelVersion?: string;
  sourceHash?: string;
  error?: string;
  extractedAt?: number;
  language?: string;
  engine?: string;
};

export type ContentFieldValue = string | number | boolean | string[] | null;
export type ContentFields = Record<string, ContentFieldValue>;

export type ContentBlock = {
  id: string;
  kind: "text" | "markdown" | "html" | "code" | "quote" | "richtext";
  label?: string;
  text?: string;
  json?: unknown;
  r2Key?: string;
  language?: string;
  searchable?: boolean;
  createdAt?: number;
};

export type BlobRef = {
  key: string;
  kind: "html" | "pdf" | "json" | "text" | "archive" | "other";
  contentType?: string;
  byteSize?: number;
  label?: string;
  hash?: string;
  capturedAt?: number;
};

export type AiExtraction = {
  status: "pending" | "processing" | "done" | "error" | "skipped";
  modelVersion?: string;
  summary?: string;
  autoTags?: string[];
  suggestedFolderPath?: string[];
  suggestedType?: string;
  extractedFields?: ContentFields;
  image?: Record<string, unknown>;
  images?: Record<string, unknown>[];
  video?: Record<string, unknown>;
  error?: string;
  updatedAt?: number;
};

export type ItemDocType = {
  id: string;
  userId: string | null;
  title: string;
  textContent: string;
  ocrText?: string;
  ocrStatus: "pending" | "processing" | "done" | "error" | "skipped";
  ocrError?: string;
  ocrModelVersion: string;
  ocrSourceHash?: string;
  ocrUpdatedAt: number;
  ocrConfidence?: number | null;
  ocrLineCount?: number;
  url: string;
  source:
    | "web"
    | "twitter"
    | "reddit"
    | "note"
    | "youtube"
    | "instagram"
    | "tiktok"
    | "substack"
    | "linkedin"
    | "github"
    | "article";
  type?: string;
  fields?: ContentFields;
  folderId: string;
  spaceId: string;
  isFavorite: boolean;
  authorUsername?: string;
  likes?: number;
  upvotes?: number;
  media?: {
    type: "image" | "video" | "audio";
    originalUrl: string;
    storageType: "hotlink" | "opfs" | "s3";
    opfsPath?: string;
    s3Url?: string;
    embedUrl?: string;
    embedType?: "iframe";
    thumbnailUrl?: string;
    expiresAt?: number;
    altText?: string;
    titleText?: string;
    ariaLabel?: string;
    pageUrl?: string;
    pageTitle?: string;
    siteName?: string;
    faviconUrl?: string;
    width?: number;
    height?: number;
    capturedAt?: number;
    ocr?: MediaOcrMetadata;
  }[];
  blocks?: ContentBlock[];
  blobs?: BlobRef[];
  iconUrl?: string;
  displayImageUrl?: string;
  summary?: string;
  ai?: AiExtraction;
  parentId: string | null;
  chunkOrder?: number;
  vector_index?: number;
  vector_indexes?: number[];
  isEmbedded: boolean;
  isMetaFetched: boolean;
  isDirty: boolean;
  serverVersion: number;
  createdAt: number;
  updatedAt: number;
  deletedAt: number;
};

export const itemSchema: RxJsonSchema<ItemDocType> = {
  title: "item schema",
  version: 1,
  description: "Describes a single saved item (bookmark, note, social media post)",
  primaryKey: "id",
  type: "object",
  properties: {
    id: { type: "string", maxLength: 100 },
    userId: { type: "string", default: "", maxLength: 1000 },
    title: { type: "string" },
    textContent: { type: "string" },
    ocrText: { type: "string" },
    ocrStatus: {
      type: "string",
      enum: ["pending", "processing", "done", "error", "skipped"],
      default: "pending",
      maxLength: 20,
    },
    ocrError: { type: "string" },
    ocrModelVersion: { type: "string", default: "", maxLength: 100 },
    ocrSourceHash: { type: "string", maxLength: 100 },
    ocrUpdatedAt: {
      type: "integer",
      default: 0,
      minimum: 0,
      maximum: Number.MAX_SAFE_INTEGER - 1,
      multipleOf: 1,
    },
    ocrConfidence: { type: ["number", "null"], default: null, minimum: 0, maximum: 1 },
    ocrLineCount: {
      type: "integer",
      minimum: 0,
      maximum: Number.MAX_SAFE_INTEGER - 1,
      multipleOf: 1,
    },
    url: { type: "string" },
    source: {
      type: "string",
      enum: [
        "web",
        "twitter",
        "reddit",
        "note",
        "youtube",
        "instagram",
        "tiktok",
        "substack",
        "linkedin",
        "github",
        "article",
      ],
      maxLength: 20,
    },
    type: { type: "string", maxLength: 200 },
    fields: {
      type: "object",
      additionalProperties: true,
    },
    folderId: { type: "string", ref: "folders", maxLength: 1000 },
    spaceId: { type: "string", default: "space_public_default", maxLength: 1000 },
    isFavorite: { type: "boolean", default: false },
    // Social media specific fields
    authorUsername: { type: "string" },
    likes: { type: "number" },
    upvotes: { type: "number" },
    media: {
      type: "array",
      items: {
        type: "object",
        properties: {
          type: { type: "string", enum: ["image", "video", "audio"] },
          originalUrl: { type: "string" },
          storageType: {
            type: "string",
            enum: ["hotlink", "opfs", "s3"],
          },
          opfsPath: { type: "string" },
          s3Url: { type: "string" },
          embedUrl: { type: "string" },
          embedType: { type: "string", enum: ["iframe"] },
          thumbnailUrl: { type: "string" },
          expiresAt: { type: "number" },
          altText: { type: "string" },
          titleText: { type: "string" },
          ariaLabel: { type: "string" },
          pageUrl: { type: "string" },
          pageTitle: { type: "string" },
          siteName: { type: "string" },
          faviconUrl: { type: "string" },
          width: { type: "number" },
          height: { type: "number" },
          capturedAt: { type: "number" },
          ocr: {
            type: "object",
            properties: {
              status: {
                type: "string",
                enum: ["pending", "processing", "done", "error", "skipped"],
              },
              text: { type: "string" },
              confidence: { type: ["number", "null"], minimum: 0, maximum: 1 },
              lineCount: {
                type: "integer",
                minimum: 0,
                maximum: Number.MAX_SAFE_INTEGER - 1,
                multipleOf: 1,
              },
              modelVersion: { type: "string", maxLength: 100 },
              sourceHash: { type: "string", maxLength: 100 },
              error: { type: "string" },
              extractedAt: {
                type: "integer",
                minimum: 0,
                maximum: Number.MAX_SAFE_INTEGER - 1,
                multipleOf: 1,
              },
              language: { type: "string" },
              engine: { type: "string" },
            },
          },
        },
      },
    },
    blocks: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          id: { type: "string", maxLength: 200 },
          kind: {
            type: "string",
            enum: ["text", "markdown", "html", "code", "quote", "richtext"],
          },
          label: { type: "string" },
          text: { type: "string" },
          json: { type: ["object", "array", "string", "number", "boolean", "null"] },
          r2Key: { type: "string" },
          language: { type: "string", maxLength: 200 },
          searchable: { type: "boolean" },
          createdAt: {
            type: "integer",
            minimum: 0,
            maximum: Number.MAX_SAFE_INTEGER - 1,
            multipleOf: 1,
          },
        },
        required: ["id", "kind"],
      },
    },
    blobs: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          key: { type: "string" },
          kind: {
            type: "string",
            enum: ["html", "pdf", "json", "text", "archive", "other"],
          },
          contentType: { type: "string", maxLength: 500 },
          byteSize: {
            type: "integer",
            minimum: 0,
            maximum: Number.MAX_SAFE_INTEGER - 1,
            multipleOf: 1,
          },
          label: { type: "string" },
          hash: { type: "string", maxLength: 256 },
          capturedAt: {
            type: "integer",
            minimum: 0,
            maximum: Number.MAX_SAFE_INTEGER - 1,
            multipleOf: 1,
          },
        },
        required: ["key", "kind"],
      },
    },
    // Content Chunking
    parentId: { type: ["string", "null"], ref: "items", default: null, maxLength: 100 },
    chunkOrder: { type: "number" },
    vector_index: {
      type: "number",
      multipleOf: 1,
      minimum: -1,
      maximum: 10000000,
    },
    vector_indexes: {
      type: "array",
      items: {
        type: "number",
        multipleOf: 1,
        minimum: 0,
        maximum: 10000000,
      },
    },
    // AI and Sync fields
    isEmbedded: { type: "boolean", default: false },
    isMetaFetched: { type: "boolean", default: false },
    isDirty: { type: "boolean", default: false },
    serverVersion: { type: "number", default: 0 },
    iconUrl: { type: "string" },
    displayImageUrl: { type: "string" },
    summary: { type: "string" },
    ai: {
      type: "object",
      additionalProperties: true,
    },
    // Timestamps
    createdAt: {
      type: "integer",
      minimum: 0,
      maximum: Number.MAX_SAFE_INTEGER - 1,
      multipleOf: 1,
    },
    updatedAt: {
      type: "integer",
      minimum: 0,
      maximum: Number.MAX_SAFE_INTEGER - 1,
      multipleOf: 1,
    },
    deletedAt: {
      type: "number",
      default: 0,
      multipleOf: 1,
      minimum: 0,
      maximum: Number.MAX_SAFE_INTEGER - 1,
    },
  },
  required: [
    "id",
    "source",
    "createdAt",
    "updatedAt",
    "isFavorite",
    "isEmbedded",
    "isMetaFetched",
    "isDirty",
    "ocrStatus",
    "ocrModelVersion",
    "ocrUpdatedAt",
    "folderId",
    "spaceId",
    "vector_index",
    "userId",
    "deletedAt",
  ],
  indexes: [
    "createdAt",
    "updatedAt",
    "source",
    "folderId",
    "spaceId",
    "isFavorite",
    "isEmbedded",
    "isMetaFetched",
    "isDirty",
    "userId",
    "vector_index",
    "deletedAt",
  ],
  attachments: {},
};

// v1 declares the polymorphic content captured locally and uploaded to cloud.
// Existing v0 rows remain valid and gain fields on their next local update.
export const itemMigrationStrategies = {
  1: (oldDoc: ItemDocType): ItemDocType => oldDoc,
};
