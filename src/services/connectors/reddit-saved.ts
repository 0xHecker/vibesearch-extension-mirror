/**
 * connectors/reddit-saved.ts — Reddit **saved** posts/comments connector.
 *
 * Uses the logged-in reddit.com session (`credentials:"include"`). Response shapes
 * are extracted dynamically via the harvester — no hardcoded field paths. Fails
 * soft; the heartbeat flips the switch off if the session/endpoint stops working.
 */
import type { CapturedItem } from "../cloud-sync.service";
import type { ConnectorAccount, ConnectorModule, FetchSavedResult } from "./types";
import { findEntryList, normalizeEntry, findCursor, politeDelay } from "./harvest";

async function fetchJson(url: string): Promise<unknown | null> {
  try {
    const res = await fetch(url, {
      credentials: "include",
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(20000),
    });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

async function detectAccount(): Promise<ConnectorAccount | null> {
  const me = (await fetchJson("https://www.reddit.com/api/me.json?raw_json=1")) as
    | { data?: { name?: string; id?: string } }
    | null;
  const name = me?.data?.name;
  if (!name) return null;
  return {
    platform: "reddit",
    accountId: me?.data?.id ? `t2_${me.data.id}` : name,
    handle: name,
    displayName: `u/${name}`,
  };
}

async function fetchSaved(opts: { sinceId?: string; maxPages?: number; onProgress?: (d: string) => void; shouldCancel?: () => boolean }): Promise<FetchSavedResult> {
  const account = await detectAccount();
  if (!account) throw new Error("You're not logged in to Reddit in this browser. Open reddit.com and sign in.");
  console.log("[Vibesearch · Reddit] fetching saved for u/" + account.handle, { sinceId: opts.sinceId ?? null });
  const items: CapturedItem[] = [];
  const maxPages = opts.maxPages ?? 20;
  let after: string | undefined;
  let newestId: string | undefined;
  let reachedKnown = false;

  for (let page = 0; page < maxPages; page++) {
    if (opts.shouldCancel?.()) {
      console.log("[Vibesearch · Reddit] cancelled by user.");
      break;
    }
    const qs = new URLSearchParams({ limit: "100", raw_json: "1" });
    if (after) qs.set("after", after);
    const raw = await fetchJson(
      `https://www.reddit.com/user/${encodeURIComponent(account.handle)}/saved.json?${qs.toString()}`,
    );
    if (!raw) {
      if (page === 0) throw new Error("Reddit didn't return saved items (session may be invalid).");
      break;
    }
    console.log(`[Vibesearch · Reddit] response (page ${page + 1}) ↓`, raw);
    const entries = findEntryList(raw);
    console.log(`[Vibesearch · Reddit] page ${page + 1}: found ${entries.length} saved item(s)`);
    for (const el of entries) {
      const item = normalizeEntry(el, {
        source: "reddit",
        idPrefix: "reddit",
        connector: "reddit-saved",
        defaultType: "link",
        origin: "https://www.reddit.com",
        buildUrl: ({ id }) => `https://www.reddit.com/${id}`,
      });
      if (!item) continue;
      const rawId = item.externalId.slice("reddit:".length);
      if (!newestId) newestId = rawId;
      if (opts.sinceId && rawId === opts.sinceId) {
        reachedKnown = true;
        break;
      }
      items.push(item);
    }
    after = findCursor(raw);
    console.log(`[Vibesearch · Reddit] collected ${items.length} saved item(s) so far${after ? " — more pages…" : " — last page."}`);
    opts.onProgress?.(`Read ${items.length} saved item${items.length === 1 ? "" : "s"}${after ? " so far…" : "."}`);
    if (reachedKnown || !after || entries.length === 0) break;
    await politeDelay();
  }
  console.log(`[Vibesearch · Reddit] done — ${items.length} saved item(s) ready to sync.`);
  return { items, newestId };
}

export const redditConnector: ConnectorModule = {
  platform: "reddit",
  label: "Reddit",
  origins: ["https://www.reddit.com/*", "https://oauth.reddit.com/*"],
  detectAccount,
  checkAlive: async () => (await detectAccount()) != null,
  fetchSaved,
};
