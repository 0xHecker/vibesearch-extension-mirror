import { beforeEach, afterEach, expect, test } from "bun:test";
import { CloudAuthService, getCloudAuthConnection, CLOUD_AUTH_PROFILE_KEY, CLOUD_AUTH_OPT_IN_KEY } from "@src/services/cloud-auth";
import { createCloudAuthAuthority } from "@src/services/cloud-auth-authority";
import { assertCloudConnectionCurrent } from "@src/services/cloud-connection";
import { CLOUD_SYNC_API_BASE_KEY, CLOUD_SYNC_TOKEN_KEY } from "@src/services/cloud-config";
import { EXTENSION_POLICY_KEY } from "@src/services/extension-policy";
import { pushCapturedItems, type CapturedItem } from "@src/services/connectors/cloud-push";
import { claimAnonymousArchives } from "@src/services/archive-cloud-claim";
import { ArchiveOutbox, createChromeArchiveOutboxStorage } from "@src/services/archive-outbox";
import { ArchivePreviewSession } from "@src/services/archive-preview";
import { CONNECTOR_MODULES, syncConnector } from "@src/services/connectors/registry";

let previousChrome: PropertyDescriptor | undefined;
let previousFetch: typeof fetch;
beforeEach(() => { previousChrome = Object.getOwnPropertyDescriptor(globalThis, "chrome"); previousFetch = globalThis.fetch; });
afterEach(() => {
  if (previousChrome) Object.defineProperty(globalThis, "chrome", previousChrome);
  else Reflect.deleteProperty(globalThis, "chrome");
  globalThis.fetch = previousFetch;
});

const fixture = () => {
  let owner = "account-one";
  let rotation = 0;
  const values = new Map<string, unknown>([
    [CLOUD_SYNC_TOKEN_KEY, "original"],
    [CLOUD_SYNC_API_BASE_KEY, "https://api.example"],
    [CLOUD_AUTH_PROFILE_KEY, { uid: owner }],
    [CLOUD_AUTH_OPT_IN_KEY, true],
    [EXTENSION_POLICY_KEY, { version: 1, mode: "legacy-browser", legacyCloudEnabled: true }],
  ]);
  const storage = {
    get: async (keys: string | string[]) => Object.fromEntries((Array.isArray(keys) ? keys : [keys]).map((key) => [key, values.get(key)])),
    set: async (entries: Record<string, unknown>) => { for (const [key, value] of Object.entries(entries)) values.set(key, structuredClone(value)); },
    remove: async (keys: string | string[]) => { for (const key of Array.isArray(keys) ? keys : [keys]) values.delete(key); },
  };
  const auth = new CloudAuthService({ storage, autoConnect: false, requestHostedToken: async () => ({
    token: `rotated-${++rotation}`, expiresAt: Date.now() + 3_600_000,
    user: { uid: owner, name: null, email: null, photoURL: null },
  }) });
  const authority = createCloudAuthAuthority(auth);
  const messages: string[] = [];
  Object.defineProperty(globalThis, "chrome", { configurable: true, value: {
    storage: { local: storage },
    offscreen: { createDocument: async () => {} },
    runtime: {
      getURL: (path: string) => `chrome-extension://test/${path}`,
      getContexts: async () => [{}],
      sendMessage: async (message: { service?: string; type?: string; payload?: unknown }) => {
        messages.push(message.type ?? "");
        if (message.service !== "cloudAuth") return { success: true };
        const input: unknown = JSON.parse(JSON.stringify(message.payload));
        let result: unknown;
        switch (message.type) {
          case "connection": result = await authority.connection(input); break;
          case "validateConnection": result = authority.validateConnection(input); break;
          case "rejectConnection": result = await authority.rejectConnection(input); break;
          default: throw new Error("unexpected auth RPC");
        }
        return { success: true, ...(result === undefined ? {} : { payload: JSON.parse(JSON.stringify(result)) }) };
      },
    },
  } });
  return { auth, values, storage, messages, changeOwner: (value: string) => { owner = value; } };
};

const item: CapturedItem = { externalId: "x:1", url: "https://example.com/one", title: "one", source: "web", type: "link" };

test("separate RPC consumers retire after disconnect and same-owner reconnect", async () => {
  const f = fixture();
  const [background, preview] = await Promise.all([getCloudAuthConnection(), getCloudAuthConnection()]);
  expect(await background.validate?.()).toBe(true);
  await f.auth.disconnect();
  await f.auth.connect();
  expect(await background.validate?.()).toBe(false);
  expect(await preview.validate?.()).toBe(false);
  expect(await (await getCloudAuthConnection()).validate?.()).toBe(true);
  expect(f.messages.filter((type) => type === "connection")).toHaveLength(3);
});

test("RPC leases preserve same-owner refresh and reject a refresh to another owner", async () => {
  const f = fixture();
  const original = await getCloudAuthConnection();
  await getCloudAuthConnection(true);
  expect(await original.validate?.()).toBe(true);
  f.changeOwner("account-two");
  const interrupted = await getCloudAuthConnection(true);
  expect(await interrupted.validate?.()).toBe(false);
  expect(await original.validate?.()).toBe(false);
  expect((await getCloudAuthConnection()).userId).toBe("account-two");
});

test("a late rejection of a rotated bearer cannot clear the fresh same-owner token", async () => {
  const f = fixture();
  const old = await getCloudAuthConnection();
  const refreshed = await getCloudAuthConnection(true);
  await old.reject?.();
  expect(await f.auth.status()).toMatchObject({ connected: true, user: { uid: "account-one" } });
  expect(await refreshed.validate?.()).toBe(true);
});

test("a delayed old rejection cannot disconnect the new RPC owner", async () => {
  const f = fixture();
  const old = await getCloudAuthConnection();
  f.changeOwner("account-two");
  await f.auth.connect();
  await old.reject?.();
  expect(await f.auth.status()).toMatchObject({ connected: true, user: { uid: "account-two" } });
  await expect(assertCloudConnectionCurrent(await getCloudAuthConnection())).resolves.toBeUndefined();
});

test("RPC rejection retirement during its storage read preserves the new session", async () => {
  const f = fixture();
  const old = await getCloudAuthConnection();
  let announce!: () => void;
  let release!: () => void;
  const entered = new Promise<void>((resolve) => { announce = resolve; });
  const held = new Promise<void>((resolve) => { release = resolve; });
  const get = f.storage.get;
  let armed = true;
  f.storage.get = async (keys) => {
    if (armed && Array.isArray(keys)) { armed = false; announce(); await held; }
    return get(keys);
  };
  const rejecting = old.reject?.();
  await entered;
  f.changeOwner("account-two");
  await f.auth.connect();
  release();
  await rejecting;
  expect(await f.auth.status()).toMatchObject({ connected: true, user: { uid: "account-two" } });
});

test("an RPC lease is rechecked after an awaited cloud policy read", async () => {
  const f = fixture();
  const connection = await getCloudAuthConnection();
  const get = f.storage.get;
  f.storage.get = async (keys) => {
    if (keys === EXTENSION_POLICY_KEY) await f.auth.disconnect();
    return get(keys);
  };
  await expect(assertCloudConnectionCurrent(connection)).rejects.toThrow("CLOUD_CONNECTION_RETIRED");
});

test("connector retirement during the durable receipt read prevents its first dispatch", async () => {
  const f = fixture();
  const get = f.storage.get;
  f.storage.get = async (keys) => {
    if (typeof keys === "string" && keys.startsWith("vibesearch:pushedExternalIds:")) await f.auth.disconnect();
    return get(keys);
  };
  let requests = 0;
  globalThis.fetch = async () => { requests += 1; return Response.json({ id: "unexpected" }); };
  await expect(pushCapturedItems([item])).rejects.toThrow("CLOUD_CONNECTION_RETIRED");
  expect(requests).toBe(0);
});

test("connector settlement checks the lease after awaiting a successful response body", async () => {
  const f = fixture();
  let requests = 0;
  globalThis.fetch = async () => {
    requests += 1;
    return new Response(new ReadableStream({
      async pull(controller) {
        await f.auth.disconnect();
        controller.enqueue(new TextEncoder().encode('{"id":"old-account-item"}'));
        controller.close();
      },
    }), { headers: { "content-type": "application/json" } });
  };
  await expect(pushCapturedItems([item, { ...item, externalId: "x:2" }])).rejects.toThrow("CLOUD_CONNECTION_RETIRED");
  expect(requests).toBe(1);
  expect(f.values.has("vibesearch:pushedExternalIds:account-one")).toBe(false);
});

test("connector pushes retain successful IDs per destination account", async () => {
  const f = fixture();
  let requests = 0;
  globalThis.fetch = async () => { requests += 1; return Response.json({ id: `cloud-${requests}` }); };
  expect(await pushCapturedItems([item])).toEqual({ pushed: 1, skipped: 0, failed: 0 });
  expect(await pushCapturedItems([item])).toEqual({ pushed: 0, skipped: 1, failed: 0 });
  f.changeOwner("account-two");
  await f.auth.connect();
  expect(await pushCapturedItems([item])).toEqual({ pushed: 1, skipped: 0, failed: 0 });
  expect(requests).toBe(2);
  expect(f.values.get("vibesearch:pushedExternalIds:account-one")).toEqual(["x:1"]);
  expect(f.values.get("vibesearch:pushedExternalIds:account-two")).toEqual(["x:1"]);
});

test("an anonymous RPC lease retires when an account connection begins", async () => {
  const f = fixture();
  await f.auth.disconnect();
  const anonymous = await getCloudAuthConnection();
  expect(anonymous.token).toBe("");
  expect(await anonymous.validate?.()).toBe(true);
  await f.auth.connect();
  expect(await anonymous.validate?.()).toBe(false);
});

test("a late anonymous archive claim body cannot notify the replacement account", async () => {
  const f = fixture();
  f.values.set("vibesearch:archiveDeviceKey", "synthetic-device-key");
  let requests = 0;
  globalThis.fetch = async () => {
    requests += 1;
    return new Response(new ReadableStream({
      async pull(controller) {
        f.changeOwner("account-two");
        await f.auth.connect();
        controller.enqueue(new TextEncoder().encode('{"imported":3}'));
        controller.close();
      },
    }), { headers: { "content-type": "application/json" } });
  };
  await claimAnonymousArchives();
  expect(requests).toBe(1);
  expect(f.messages).not.toContain("DB_CHANGE");
  expect(await f.auth.status()).toMatchObject({ connected: true, user: { uid: "account-two" } });
});

test("the production archive connection preserves both jobs after an RPC account reconnect", async () => {
  const f = fixture();
  let requests = 0;
  const outbox = new ArchiveOutbox({
    storage: createChromeArchiveOutboxStorage(),
    files: {
      create: async () => { throw new Error("capture jobs have no local output"); },
      read: async () => null, delete: async () => {}, cleanup: async () => {},
    },
    ensureItem: async () => ({ ready: true }),
    fetcher: async (_input, init) => {
      expect(new Headers(init?.headers).get("authorization")).toBe("Bearer original");
      requests += 1;
      await f.auth.disconnect();
      await f.auth.connect();
      return new Response(null, { status: 204 });
    },
  });
  await outbox.enqueueServerCapture("one", "https://example.com/one");
  await outbox.enqueueServerCapture("two", "https://example.com/two");
  expect(await outbox.drain(2)).toMatchObject({ uploaded: 0, remaining: 2, reason: "cancelled" });
  expect(requests).toBe(1);
  expect((await outbox.list()).map((job) => job.itemId).sort()).toEqual(["one", "two"]);
});

test("the production preview connection rejects a response from a replaced RPC account", async () => {
  const f = fixture();
  let writes = 0;
  let documents = 0;
  const session = new ArchivePreviewSession({
    cache: { get: async () => null, put: async () => { writes += 1; } },
    fetcher: async () => {
      f.changeOwner("account-two");
      await f.auth.connect();
      return new Response("<html><body>old account</body></html>", { headers: { "content-type": "text/html" } });
    },
    createObjectUrl: () => { documents += 1; return "blob:old-account"; },
    revokeObjectUrl: () => {},
  });
  await expect(session.load("one")).rejects.toMatchObject({ code: "ARCHIVE_PREVIEW_ABORTED" });
  expect(writes).toBe(0);
  expect(documents).toBe(0);
  session.dispose();
});

test("connector harvest checkpoints restart for a different destination account", async () => {
  const f = fixture();
  f.values.set("vibesearch:connectors", { "x:social-account": {
    platform: "x", accountId: "social-account", handle: "synthetic", connected: true, autoSync: true, itemCount: 0,
  } });
  const fetchSaved = CONNECTOR_MODULES.x.fetchSaved;
  const since: Array<string | undefined> = [];
  CONNECTOR_MODULES.x.fetchSaved = async (options) => {
    since.push(options.sinceId);
    return { items: options.sinceId ? [] : [item], newestId: "1", complete: true };
  };
  let requests = 0;
  globalThis.fetch = async () => { requests += 1; return Response.json({ id: "cloud-one" }); };
  try {
    expect(await syncConnector("x", "social-account")).toMatchObject({ pushed: 1 });
    expect(await syncConnector("x", "social-account")).toMatchObject({ fetched: 0 });
    f.changeOwner("account-two");
    await f.auth.connect();
    expect(await syncConnector("x", "social-account")).toMatchObject({ pushed: 1 });
    f.changeOwner("account-one");
    await f.auth.connect();
    expect(await syncConnector("x", "social-account")).toMatchObject({ fetched: 0 });
    expect(since).toEqual([undefined, "1", undefined, "1"]);
    expect(requests).toBe(2);
  } finally { CONNECTOR_MODULES.x.fetchSaved = fetchSaved; }
});

test("an account switch during connector harvesting retains the prior checkpoint", async () => {
  const f = fixture();
  const saved = { "x:social-account": {
    platform: "x", accountId: "social-account", handle: "synthetic", connected: true, autoSync: true,
    itemCount: 1, cloudUserId: "account-one", sinceId: "prior-checkpoint",
  } };
  f.values.set("vibesearch:connectors", structuredClone(saved));
  const fetchSaved = CONNECTOR_MODULES.x.fetchSaved;
  CONNECTOR_MODULES.x.fetchSaved = async () => {
    f.changeOwner("account-two");
    await f.auth.connect();
    return { items: [item], newestId: "new-checkpoint", complete: true };
  };
  let requests = 0;
  globalThis.fetch = async () => { requests += 1; return Response.json({ id: "unexpected" }); };
  try {
    expect(await syncConnector("x", "social-account")).toMatchObject({ cancelled: true });
    expect(requests).toBe(0);
    expect(f.values.get("vibesearch:connectors")).toEqual(saved);
  } finally { CONNECTOR_MODULES.x.fetchSaved = fetchSaved; }
});
