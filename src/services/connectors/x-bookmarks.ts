/**
 * connectors/x-bookmarks.ts — X (Twitter) bookmarks connector.
 *
 * Reads the user's own logged-in session cookies (`auth_token` + `ct0`) via
 * `chrome.cookies` and calls X's internal GraphQL Bookmarks endpoint. We do NOT
 * hardcode the tweet shape — each raw page is handed to the shape-agnostic
 * harvester (`findEntryList` + `normalizeEntry` + `findCursor`), so field/nesting
 * changes don't break extraction. Only the endpoint + auth + cursor param are here.
 */
import type { CapturedItem } from "../cloud-sync.service";
import type { ConnectorAccount, ConnectorModule, FetchSavedResult } from "./types";
import { findXCursor, findXEntryList, normalizeEntry, politeDelay } from "./harvest";

const BEARER =
  "AAAAAAAAAAAAAAAAAAAAANRILgAAAAAAnNwIzUejRCOuH5E6I8xnZz4puTs%3D1Zv7ttfk8LF81IUq16cHjhLTvJu4FA33AGWWjCpTnA";

const FEATURES = JSON.stringify({
  graphql_timeline_v2_bookmark_timeline: true,
  responsive_web_graphql_exclude_directive_enabled: true,
  verified_phone_label_enabled: false,
  creator_subscriptions_tweet_preview_api_enabled: true,
  responsive_web_graphql_timeline_navigation_enabled: true,
  responsive_web_graphql_skip_user_profile_image_extensions_enabled: false,
  tweetypie_unmention_optimization_enabled: true,
  responsive_web_edit_tweet_api_enabled: true,
  graphql_is_translatable_rweb_tweet_is_translatable_enabled: true,
  view_counts_everywhere_api_enabled: true,
  longform_notetweets_consumption_enabled: true,
  responsive_web_twitter_article_tweet_consumption_enabled: true,
  tweet_awards_web_tipping_enabled: false,
  freedom_of_speech_not_reach_fetch_enabled: true,
  standardized_nudges_misinfo: true,
  tweet_with_visibility_results_prefer_gql_limited_actions_policy_enabled: true,
  longform_notetweets_rich_text_read_enabled: true,
  longform_notetweets_inline_media_enabled: true,
  responsive_web_enhance_cards_enabled: false,
});

// X's internal Bookmarks GraphQL query id (update if it starts 400ing).
const QUERY_ID = "xLjCVTqYWz8CGSprLU349w";

export interface XCredentials {
  authToken: string;
  ct0: string;
}

async function readCookie(url: string, name: string): Promise<string | null> {
  try {
    const cookie = await chrome.cookies.get({ url, name });
    return cookie?.value ? cookie.value : null;
  } catch {
    return null;
  }
}

/** Read the logged-in X session cookies (x.com, then twitter.com). */
export async function readXCredentials(): Promise<XCredentials | null> {
  const authToken =
    (await readCookie("https://x.com", "auth_token")) ??
    (await readCookie("https://twitter.com", "auth_token"));
  const ct0 =
    (await readCookie("https://x.com", "ct0")) ?? (await readCookie("https://twitter.com", "ct0"));
  if (!authToken || !ct0) return null;
  return { authToken, ct0 };
}

async function fetchPage(creds: XCredentials, cursor?: string): Promise<unknown> {
  const variables = JSON.stringify({ count: 100, includePromotedContent: false, ...(cursor ? { cursor } : {}) });
  const url = `https://x.com/i/api/graphql/${QUERY_ID}/Bookmarks?variables=${encodeURIComponent(
    variables,
  )}&features=${encodeURIComponent(FEATURES)}`;
  let res: Response;
  try {
    res = await fetch(url, {
      signal: AbortSignal.timeout(20000),
      credentials: "include",
      headers: {
        Authorization: `Bearer ${BEARER}`,
        "X-Csrf-Token": creds.ct0,
        "X-Twitter-Auth-Type": "OAuth2Session",
        "X-Twitter-Active-User": "yes",
        "X-Twitter-Client-Language": "en",
        Accept: "*/*",
      },
    });
  } catch (err) {
    const name = err instanceof Error ? err.name : "";
    if (name === "TimeoutError" || name === "AbortError") throw new Error("X request timed out — check your connection and retry.");
    throw new Error("Couldn't reach X. Are you online + logged in to x.com?");
  }
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    if (res.status === 401 || res.status === 403) throw new Error("X session expired — open x.com, log in, and retry.");
    if (res.status === 429) throw new Error("X is rate-limiting requests — pausing this sync; it'll resume on the next scheduled run.");
    throw new Error(`X API ${res.status}: ${text.slice(0, 160)}`);
  }
  return res.json();
}

export interface XSyncOptions {
  sinceId?: string;
  cursor?: string;
  maxPages?: number;
  onProgress?: (detail: string) => void;
  shouldCancel?: () => boolean;
}

/** Fetch X bookmarks as normalized items via the dynamic harvester. */
export async function fetchXBookmarks(
  opts: XSyncOptions = {},
): Promise<FetchSavedResult & { reachedKnown: boolean }> {
  const creds = await readXCredentials();
  if (!creds) throw new Error("You're not logged in to X in this browser. Open x.com, sign in, then retry.");
  console.log("[Vibesearch · X] fetching bookmarks…", { sinceId: opts.sinceId ?? null });
  const items: CapturedItem[] = [];
  const maxPages = Math.max(1, Math.min(opts.maxPages ?? 10, 50));
  let cursor = opts.cursor;
  let nextCursor = opts.cursor;
  let newestId: string | undefined;
  let reachedKnown = false;
  let complete = false;

  for (let page = 0; page < maxPages; page++) {
    if (opts.shouldCancel?.()) {
      console.log("[Vibesearch · X] cancelled by user.");
      break;
    }
    let raw: unknown;
    try {
      raw = await fetchPage(creds, cursor);
    } catch (error) {
      if (page === 0) throw error;
      nextCursor = cursor;
      break;
    }
    const entries = findXEntryList(raw);
    console.log(`[Vibesearch · X] page ${page + 1}: found ${entries.length} entries`);
    for (const el of entries) {
      const item = normalizeEntry(el, {
        source: "twitter",
        idPrefix: "x",
        connector: "x-bookmarks",
        defaultType: "social",
        buildUrl: ({ id, handle }) => `https://x.com/${handle || "i"}/status/${id}`,
      });
      if (!item) continue;
      const rawId = item.externalId.slice("x:".length);
      if (!newestId) newestId = rawId;
      if (opts.sinceId && rawId === opts.sinceId) {
        reachedKnown = true;
        break;
      }
      items.push(item);
    }
    const next = findXCursor(raw);
    console.log(`[Vibesearch · X] collected ${items.length} bookmark(s) so far${next ? " — more pages…" : " — last page."}`);
    opts.onProgress?.(`Read ${items.length} bookmark${items.length === 1 ? "" : "s"}${next ? " so far…" : "."}`);
    if (reachedKnown || !next || next === cursor || entries.length === 0) {
      complete = true;
      nextCursor = undefined;
      break;
    }
    nextCursor = next;
    if (page + 1 >= maxPages) break;
    cursor = next;
    await politeDelay();
  }
  console.log(`[Vibesearch · X] done — ${items.length} bookmark(s) ready to sync.`);
  return { items, newestId, nextCursor, complete, reachedKnown };
}

// ── account detection + heartbeat ────────────────────────────────────────────

async function detectXAccount(): Promise<ConnectorAccount | null> {
  const twid = (await readCookie("https://x.com", "twid")) ?? (await readCookie("https://twitter.com", "twid"));
  const creds = await readXCredentials();
  if (!twid || !creds) return null;
  const accountId = decodeURIComponent(twid).replace(/^u=/, "") || twid;
  let handle = `id:${accountId}`;
  try {
    const res = await fetch("https://api.x.com/1.1/account/settings.json", {
      credentials: "include",
      headers: {
        Authorization: `Bearer ${BEARER}`,
        "X-Csrf-Token": creds.ct0,
        "X-Twitter-Auth-Type": "OAuth2Session",
      },
    });
    if (res.ok) {
      const data = (await res.json().catch(() => null)) as { screen_name?: string } | null;
      if (data?.screen_name) handle = data.screen_name;
    }
  } catch {
    /* keep id fallback */
  }
  console.log("[Vibesearch · X] detected account", { accountId, handle });
  return { platform: "x", accountId, handle, displayName: handle.startsWith("id:") ? undefined : `@${handle}` };
}

async function checkXAlive(accountId?: string): Promise<boolean> {
  // Lightweight: the account/settings probe in detectXAccount, not a full
  // bookmarks fetch — keeps heartbeats cheap so we don't hammer X.
  try {
    const account = await detectXAccount();
    return account !== null && (!accountId || account.accountId === accountId);
  } catch {
    return false;
  }
}

export const xConnector: ConnectorModule = {
  platform: "x",
  label: "X (Twitter)",
  origins: ["https://x.com/*", "https://twitter.com/*", "https://api.x.com/*"],
  detectAccount: detectXAccount,
  checkAlive: checkXAlive,
  fetchSaved: async (opts): Promise<FetchSavedResult> => {
    return fetchXBookmarks(opts);
  },
};
