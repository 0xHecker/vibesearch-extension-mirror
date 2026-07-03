/**
 * cloud-sync.service.ts
 *
 * Extension → Cloud **unidirectional** sync. The extension is the source of
 * truth; this module *forwards* captured/imported content to the web-app backend
 * (`vibesearch-api`). It never pulls. See docs/CONNECTORS.md.
 *
 * Auth reuses the Firebase ID token stored by the sign-in flow
 * (`archive.service.ts` → `AUTH_TOKEN_STORAGE_KEY`). Idempotency is client-side:
 * each item carries a stable `externalId` (e.g. `x:<tweetId>`); we remember which
 * ids we've pushed so a re-sync doesn't duplicate.
 */
import {
  resolveArchiveApiBase,
  ArchiveAuthError,
} from "./archive.service";
import { getValidIdToken } from "./cloud-auth.service";

export interface CapturedMedia {
  type: string; // photo | video | gif | image | audio
  url: string;
  thumbnailUrl?: string;
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
  createdAt?: number;
  folderId?: string;
  fields?: Record<string, unknown>;
}

export interface CloudPushResult {
  pushed: number;
  skipped: number;
  failed: number;
}

const PUSHED_KEY = "vibesearch:pushedExternalIds";
const PUSHED_CAP = 20000; // keep the dedupe set bounded

async function loadPushedIds(): Promise<Set<string>> {
  try {
    const row = await chrome.storage.local.get(PUSHED_KEY);
    const arr = row?.[PUSHED_KEY];
    return new Set(Array.isArray(arr) ? (arr as string[]) : []);
  } catch {
    return new Set();
  }
}

async function savePushedIds(ids: Set<string>): Promise<void> {
  try {
    const arr = Array.from(ids);
    const trimmed = arr.length > PUSHED_CAP ? arr.slice(arr.length - PUSHED_CAP) : arr;
    await chrome.storage.local.set({ [PUSHED_KEY]: trimmed });
  } catch {
    /* best-effort */
  }
}

/** Map a neutral CapturedItem to the `vibesearch-api` item-create body. */
function toItemBody(item: CapturedItem): Record<string, unknown> {
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
      thumbnailUrl: m.thumbnailUrl,
    })),
    folderId: item.folderId ?? "",
    fields: { ...(item.fields ?? {}), externalId: item.externalId },
    ...(item.createdAt ? { createdAt: item.createdAt } : {}),
  };
}

/**
 * Push captured items to the cloud (create). Unidirectional. Skips items whose
 * `externalId` was already pushed. Throws `ArchiveAuthError` if not signed in
 * (so callers can prompt sign-in); per-item HTTP failures are counted, not thrown.
 */
export async function pushCapturedItems(
  items: CapturedItem[],
  opts?: { onProgress?: (done: number, total: number) => void; shouldCancel?: () => boolean },
): Promise<CloudPushResult> {
  const token = await getValidIdToken();
  if (!token) throw new ArchiveAuthError("Sign in to Vibesearch to sync to the cloud.");
  const base = resolveArchiveApiBase();
  const pushedIds = await loadPushedIds();
  console.log(`[Vibesearch · Cloud] pushing ${items.length} item(s) to ${base}…`);

  let pushed = 0;
  let skipped = 0;
  let failed = 0;
  let done = 0;

  for (const item of items) {
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
      const res = await fetch(`${base}/v1/items`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify(toItemBody(item)),
      });
      if (res.status === 401 || res.status === 403) {
        await savePushedIds(pushedIds);
        throw new ArchiveAuthError("Your Vibesearch session expired — sign in again to sync.");
      }
      if (!res.ok) {
        console.warn(`[Vibesearch · Cloud] ✗ ${res.status} for`, item.url);
        failed += 1;
      } else {
        const created = (await res.json().catch(() => null)) as { id?: string } | null;
        console.log(`[Vibesearch · Cloud] ← created ${created?.id ?? "?"}`, { title: item.title, url: item.url });
        pushed += 1;
        if (item.externalId) pushedIds.add(item.externalId);
      }
    } catch (err) {
      if (err instanceof ArchiveAuthError) throw err;
      failed += 1;
    }
    opts?.onProgress?.(done, items.length);
  }

  await savePushedIds(pushedIds);
  console.log(`[Vibesearch · Cloud] pushed ${pushed} new, ${skipped} already saved, ${failed} failed.`);
  return { pushed, skipped, failed };
}

/** Whether a cloud session token is present (drives the connectors UI state). */
export async function isCloudConnected(): Promise<boolean> {
  return (await getValidIdToken()) != null;
}

/**
 * Push a single captured item and return the created **cloud item id** (so a
 * snapshot can be attached to it via the archive endpoint). Returns null if not
 * signed in or the create failed. Records the `externalId` as pushed (dedupe).
 */
export async function pushSingleItem(item: CapturedItem): Promise<{ id: string } | null> {
  const token = await getValidIdToken();
  if (!token) return null;
  const base = resolveArchiveApiBase();
  try {
    const res = await fetch(`${base}/v1/items`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify(toItemBody(item)),
    });
    if (!res.ok) return null;
    const data = (await res.json().catch(() => null)) as { id?: string } | null;
    if (item.externalId) {
      const ids = await loadPushedIds();
      ids.add(item.externalId);
      await savePushedIds(ids);
    }
    return data?.id ? { id: data.id } : null;
  } catch {
    return null;
  }
}
