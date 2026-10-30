/**
 * Connector cloud push
 *
 * Extension → Cloud **unidirectional** sync. The extension is the source of
 * truth; this module *forwards* captured/imported content to the web-app backend
 * (`vibesearch-api`). It never pulls. See docs/CONNECTORS.md.
 *
 * Auth and API configuration reuse the primary cloud-sync service. Idempotency is client-side:
 * each item carries a stable `externalId` (e.g. `x:<tweetId>`); we remember which
 * ids we've pushed so a re-sync doesn't duplicate.
 */
import { getCloudAuthConnection, type CloudAuthConnection } from "@src/services/cloud-auth";
import { assertCloudConnectionCurrent, CloudConnectionRetiredError } from "@src/services/cloud-connection";
import {
  jsonObject,
  jsonString,
  tryReadJsonResponse,
} from "@src/common/json-value";
import {
  CLOUD_SYNC_API_BASE_KEY,
  DEFAULT_VIBESEARCH_API_BASE,
  resolveVibeSearchApiBase,
} from "@src/services/cloud-config";
import { z } from "zod";

export class ConnectorCloudAuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConnectorCloudAuthError";
  }
}

const resolveConnectorApiBase = async (): Promise<string> => {
  try {
    const row = await chrome.storage.local.get(CLOUD_SYNC_API_BASE_KEY);
    const configured = jsonString(row?.[CLOUD_SYNC_API_BASE_KEY])?.trim().replace(/\/+$/, "") ?? "";
    return resolveVibeSearchApiBase(configured);
  } catch {
    return DEFAULT_VIBESEARCH_API_BASE;
  }
};

export interface CapturedMedia {
  type: "image" | "video" | "audio" | "file";
  url: string;
  storageType?: "hotlink" | "opfs" | "s3";
  thumbnailUrl?: string;
  id?: string;
  mimeType?: string;
  width?: number;
  height?: number;
  durationSec?: number;
  altText?: string;
  provider?: string;
  externalId?: string;
}

export interface CapturedCreator {
  id?: string;
  name?: string;
  handle?: string;
  avatarUrl?: string;
  url?: string;
  verified?: boolean;
}

export interface CapturedStats {
  likes?: number;
  upvotes?: number;
  replies?: number;
  comments?: number;
  reposts?: number;
  views?: number;
  saves?: number;
  shares?: number;
}

export interface CapturedCommunity {
  id?: string;
  name?: string;
  iconUrl?: string;
  url?: string;
}

export interface CapturedQuotedPost {
  url?: string;
  text?: string;
  author?: CapturedCreator;
}

export interface CapturedInlineImage {
  url: string;
  width?: number;
  height?: number;
  altText?: string;
}

export interface CapturedInlineVideo {
  url: string;
  thumbnailUrl?: string;
  durationSec?: number;
}

export interface CapturedSourceInline {
  id: string;
  title: string;
  description: string;
  author?: CapturedCreator;
  postedAt?: number;
  stats?: CapturedStats;
  community?: CapturedCommunity;
  language?: string;
  hashtags?: string[];
  mentions?: string[];
  quotedPost?: CapturedQuotedPost;
  flair?: string;
  crosspostOrigin?: string;
  domain?: string;
  postKind?: string;
  conversationId?: string;
  location?: { name: string };
  audio?: { title: string };
  mediaKind?: string;
  images?: CapturedInlineImage[];
  videos?: CapturedInlineVideo[];
}

export interface CapturedItemFields {
  externalId: string;
  connector: string;
  postedAt?: number;
  comments?: number;
  replies?: number;
  reposts?: number;
  views?: number;
  saves?: number;
  shares?: number;
  community?: string;
  subredditId?: string;
  hashtags?: string[];
  mentions?: string[];
  flair?: string;
  crosspostOrigin?: string;
  linkedDomain?: string;
  postKind?: string;
  conversationId?: string;
  location?: string;
  originalAudio?: string;
  mediaKind?: string;
}

export interface CapturedSocialMetadata {
  platform: string;
  postId?: string;
  author?: CapturedCreator;
  community?: CapturedCommunity;
  postedAt?: number;
  language?: string;
  stats?: CapturedStats;
  parentUrl?: string;
  quotedPost?: CapturedQuotedPost;
}

export interface CapturedProvenance {
  method?: "extension" | "import";
  importer?: string;
  externalId?: string;
  capturedAt?: number;
  importedAt?: number;
}

export interface CapturedSourceRecord {
  id: string;
  provider: string;
  kind: "api";
  adapterVersion: string;
  canonicalUrl?: string;
  externalId?: string;
  fetchedAt?: number;
  inline: CapturedSourceInline;
}

export interface CapturedItemMetadata {
  schemaVersion: 1;
  social?: CapturedSocialMetadata;
  provenance?: CapturedProvenance;
  sourceRecords?: CapturedSourceRecord[];
}

/** Neutral shape a connector/capture produces; mapped to the API item on push. */
export interface CapturedItem {
  /** Stable cross-run id, e.g. `x:1234567890` — used for dedupe. */
  externalId: string;
  url: string;
  title: string;
  textContent?: string;
  source: string; // twitter | reddit | instagram | web | ...
  type: string; // social | image | video | link | ...
  authorUsername?: string;
  media?: CapturedMedia[];
  likes?: number;
  upvotes?: number;
  /** Provider publication time; root createdAt remains the cloud capture time. */
  postedAt?: number;
  /** @deprecated kept only for callers compiled against the earlier shape. */
  createdAt?: number;
  folderId?: string;
  fields?: CapturedItemFields;
  metadata?: CapturedItemMetadata;
}

export interface CloudPushResult {
  pushed: number;
  skipped: number;
  failed: number;
}

const PUSHED_KEY = "vibesearch:pushedExternalIds";
const PUSHED_CAP = 20000; // keep the dedupe set bounded
const pushedIdsSchema = z.array(z.string());

const pushedKeyForOwner = (userId: string): string => `${PUSHED_KEY}:${encodeURIComponent(userId)}`;

async function loadPushedIds(userId: string): Promise<Set<string>> {
  try {
    const key = pushedKeyForOwner(userId);
    const row = await chrome.storage.local.get(key);
    const parsed = pushedIdsSchema.safeParse(row?.[key]);
    return new Set(parsed.success ? parsed.data : []);
  } catch {
    return new Set();
  }
}

async function savePushedIds(ids: Set<string>, connection: CloudAuthConnection): Promise<void> {
  try {
    const arr = Array.from(ids);
    const trimmed = arr.length > PUSHED_CAP ? arr.slice(arr.length - PUSHED_CAP) : arr;
    await assertCloudConnectionCurrent(connection);
    await chrome.storage.local.set({ [pushedKeyForOwner(connection.userId)]: trimmed });
    await assertCloudConnectionCurrent(connection);
  } catch (error) {
    if (error instanceof CloudConnectionRetiredError || (error instanceof Error && error.message === "LOCAL_ONLY_CLOUD_DISABLED")) throw error;
    /* best-effort */
  }
}

export interface CloudItemMediaBody {
  type: CapturedMedia["type"];
  originalUrl: string;
  storageType: NonNullable<CapturedMedia["storageType"]>;
  thumbnailUrl?: string;
  id?: string;
  mimeType?: string;
  width?: number;
  height?: number;
  durationSec?: number;
  altText?: string;
  provider?: string;
  externalId?: string;
}

export interface CloudItemCreateBody {
  url: string;
  title: string;
  textContent: string;
  source: string;
  type: string;
  authorUsername?: string;
  likes?: number;
  upvotes?: number;
  media: CloudItemMediaBody[];
  folderId: string;
  fields: CapturedItemFields;
  metadata?: CapturedItemMetadata;
}

/** Map a neutral CapturedItem to the `vibesearch-api` item-create body. */
export function toItemBody(item: CapturedItem): CloudItemCreateBody {
  const fields: CapturedItemFields = item.fields
    ? { ...item.fields }
    : { externalId: item.externalId, connector: "capture" };
  fields.externalId = item.externalId;
  if (item.postedAt !== undefined) fields.postedAt = item.postedAt;

  return {
    url: item.url,
    title: item.title,
    textContent: item.textContent ?? "",
    source: item.source,
    type: item.type,
    authorUsername: item.authorUsername,
    likes: item.likes,
    upvotes: item.upvotes,
    media: (item.media ?? []).map((m) => ({
      type: m.type,
      originalUrl: m.url,
      storageType: m.storageType ?? "hotlink",
      thumbnailUrl: m.thumbnailUrl,
      id: m.id,
      mimeType: m.mimeType,
      width: m.width,
      height: m.height,
      durationSec: m.durationSec,
      altText: m.altText,
      provider: m.provider,
      externalId: m.externalId,
    })),
    folderId: item.folderId ?? "",
    fields,
    metadata: item.metadata,
  };
}

/**
 * Push captured items to the cloud (create). Unidirectional. Skips items whose
 * `externalId` was already pushed. Throws `ConnectorCloudAuthError` if not signed in
 * (so callers can prompt sign-in); per-item HTTP failures are counted, not thrown.
 */
export async function pushCapturedItems(
  items: CapturedItem[],
  opts?: { onProgress?: (done: number, total: number) => void; shouldCancel?: () => boolean; connection?: CloudAuthConnection },
): Promise<CloudPushResult> {
  const connection = opts?.connection ?? await getCloudAuthConnection();
  const { token, userId } = connection;
  if (!token || !userId) throw new ConnectorCloudAuthError("Sign in to Vibesearch to sync to the cloud.");
  const base = await resolveConnectorApiBase();
  const pushedIds = await loadPushedIds(userId);
  await assertCloudConnectionCurrent(connection);
  console.log(`[Vibesearch · Cloud] pushing ${items.length} item(s) to ${base}…`);

  let pushed = 0;
  let skipped = 0;
  let failed = 0;
  let done = 0;

  for (const item of items) {
    await assertCloudConnectionCurrent(connection);
    if (opts?.shouldCancel?.()) {
      console.log("[Vibesearch · Cloud] push cancelled by user.");
      break;
    }
    done += 1;
    if (item.externalId && pushedIds.has(item.externalId)) {
      skipped += 1;
      opts?.onProgress?.(done, items.length);
      continue;
    }
    try {
      await assertCloudConnectionCurrent(connection);
      if (opts?.shouldCancel?.()) break;
      const res = await fetch(`${base}/v1/items`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify(toItemBody(item)),
      });
      try { await assertCloudConnectionCurrent(connection); }
      catch (error) { await res.body?.cancel().catch(() => {}); throw error; }
      if (res.status === 401 || res.status === 403) {
        await res.body?.cancel().catch(() => {});
        await savePushedIds(pushedIds, connection);
        await connection.reject?.();
        throw new ConnectorCloudAuthError("Your Vibesearch session expired — sign in again to sync.");
      }
      if (!res.ok) {
        console.warn(`[Vibesearch · Cloud] ✗ ${res.status} for`, item.url);
        failed += 1;
      } else {
        const created = jsonObject(await tryReadJsonResponse(res));
        await assertCloudConnectionCurrent(connection);
        const createdId = jsonString(created?.id) ?? "?";
        console.log(`[Vibesearch · Cloud] ← created ${createdId}`, { title: item.title, url: item.url });
        pushed += 1;
        if (item.externalId) pushedIds.add(item.externalId);
      }
    } catch (err) {
      if (err instanceof ConnectorCloudAuthError || err instanceof CloudConnectionRetiredError || (err instanceof Error && err.message === "LOCAL_ONLY_CLOUD_DISABLED")) throw err;
      failed += 1;
    }
    opts?.onProgress?.(done, items.length);
  }

  await savePushedIds(pushedIds, connection);
  console.log(`[Vibesearch · Cloud] pushed ${pushed} new, ${skipped} already saved, ${failed} failed.`);
  return { pushed, skipped, failed };
}
