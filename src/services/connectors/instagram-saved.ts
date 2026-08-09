/**
 * connectors/instagram-saved.ts — Instagram **saved** posts connector.
 *
 * Uses the logged-in instagram.com session (`sessionid`/`ds_user_id` cookies +
 * the web `X-IG-App-ID`). Response shapes are extracted dynamically via the
 * harvester — no hardcoded field paths. IG's internal endpoints are the most
 * brittle of the three; this fails soft and the heartbeat toggles the switch off.
 */
import type { CapturedItem } from "../cloud-sync.service";
import type { ConnectorAccount, ConnectorModule, FetchSavedResult } from "./types";
import { findInstagramCursor, findInstagramEntryList, normalizeEntry, politeDelay } from "./harvest";

const IG_APP_ID = "936619743392459"; // Instagram web app id (public, sent by the web client)

async function readCookie(name: string): Promise<string | null> {
  try {
    const c = await chrome.cookies.get({ url: "https://www.instagram.com", name });
    return c?.value ?? null;
  } catch {
    return null;
  }
}

async function igFetch(path: string): Promise<Response | null> {
  const csrf = (await readCookie("csrftoken")) ?? "";
  try {
    return await fetch(`https://www.instagram.com${path}`, {
      credentials: "include",
      headers: { "X-IG-App-ID": IG_APP_ID, "X-CSRFToken": csrf, Accept: "*/*" },
      signal: AbortSignal.timeout(20000),
    });
  } catch {
    return null;
  }
}

async function detectAccount(): Promise<ConnectorAccount | null> {
  const dsUserId = await readCookie("ds_user_id");
  const sessionId = await readCookie("sessionid");
  if (!dsUserId || !sessionId) return null;
  let handle = dsUserId;
  let displayName: string | undefined;
  let avatarUrl: string | undefined;
  const res = await igFetch("/api/v1/accounts/current_user/");
  if (res && res.ok) {
    const data = (await res.json().catch(() => null)) as
      | { user?: { username?: string; full_name?: string; profile_pic_url?: string } }
      | null;
    if (data?.user?.username) handle = data.user.username;
    displayName = data?.user?.full_name;
    avatarUrl = data?.user?.profile_pic_url;
  }
  return { platform: "instagram", accountId: dsUserId, handle, displayName, avatarUrl };
}

async function fetchSaved(opts: { sinceId?: string; cursor?: string; maxPages?: number; onProgress?: (d: string) => void; shouldCancel?: () => boolean }): Promise<FetchSavedResult> {
  const account = await detectAccount();
  if (!account) throw new Error("You're not logged in to Instagram in this browser. Open instagram.com and sign in.");
  console.log("[Vibesearch · Instagram] fetching saved for @" + account.handle, { sinceId: opts.sinceId ?? null });
  const items: CapturedItem[] = [];
  const maxPages = Math.max(1, Math.min(opts.maxPages ?? 10, 50));
  let maxId = opts.cursor;
  let nextCursor = opts.cursor;
  let newestId: string | undefined;
  let reachedKnown = false;
  let complete = false;

  for (let page = 0; page < maxPages; page++) {
    if (opts.shouldCancel?.()) {
      console.log("[Vibesearch · Instagram] cancelled by user.");
      break;
    }
    const qs = new URLSearchParams();
    if (maxId) qs.set("max_id", maxId);
    const res = await igFetch(`/api/v1/feed/saved/posts/?${qs.toString()}`);
    if (!res || !res.ok) {
      if (page === 0) throw new Error("Instagram didn't return saved posts (session may be invalid or rate-limited).");
      nextCursor = maxId;
      break;
    }
    const raw = await res.json().catch(() => null);
    if (!raw) {
      if (page === 0) throw new Error("Instagram returned an invalid saved-posts response.");
      nextCursor = maxId;
      break;
    }
    const entries = findInstagramEntryList(raw);
    console.log(`[Vibesearch · Instagram] page ${page + 1}: found ${entries.length} saved post(s)`);
    for (const el of entries) {
      const item = normalizeEntry(el, {
        source: "instagram",
        idPrefix: "ig",
        connector: "instagram-saved",
        defaultType: "social",
        origin: "https://www.instagram.com",
        buildUrl: ({ code }) => (code ? `https://www.instagram.com/p/${code}/` : "https://www.instagram.com/"),
      });
      if (!item) continue;
      const rawId = item.externalId.slice("ig:".length);
      if (!newestId) newestId = rawId;
      if (opts.sinceId && rawId === opts.sinceId) {
        reachedKnown = true;
        break;
      }
      items.push(item);
    }
    const next = findInstagramCursor(raw);
    console.log(`[Vibesearch · Instagram] collected ${items.length} saved post(s) so far${next ? " — more pages…" : " — last page."}`);
    opts.onProgress?.(`Read ${items.length} saved post${items.length === 1 ? "" : "s"}${next ? " so far…" : "."}`);
    if (reachedKnown || !next || next === maxId || entries.length === 0) {
      complete = true;
      nextCursor = undefined;
      break;
    }
    nextCursor = next;
    if (page + 1 >= maxPages) break;
    maxId = next;
    await politeDelay();
  }
  console.log(`[Vibesearch · Instagram] done — ${items.length} saved post(s) ready to sync.`);
  return { items, newestId, nextCursor, complete };
}

export const instagramConnector: ConnectorModule = {
  platform: "instagram",
  label: "Instagram",
  origins: ["https://www.instagram.com/*"],
  detectAccount,
  checkAlive: async (accountId) => {
    const account = await detectAccount();
    return account !== null && (!accountId || account.accountId === accountId);
  },
  fetchSaved,
};
