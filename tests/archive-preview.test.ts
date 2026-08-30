import { expect, test } from "bun:test";
import {
  ARCHIVE_PREVIEW_DOCUMENT_CSP,
  ArchivePreviewSession,
  createArchivePreviewLocalCache,
} from "@src/services/archive-preview";

test("the View sheet embeds only the sanitized archive URL with no sandbox capabilities", async () => {
  const source = await Bun.file(
    new URL("../src/components/TabGroups/WebsitePreview.tsx", import.meta.url),
  ).text();

  expect(source).toContain("src={preview.url}");
  expect(source).toContain('sandbox=""');
  expect(source).not.toContain('sandbox="allow-downloads"');
  expect(source).not.toContain("src={url}");
});

test("archive preview uses the durable local cache without touching auth or network", async () => {
  let connectionCalls = 0;
  let fetchCalls = 0;
  let previewBlob: Blob | null = null;
  const session = new ArchivePreviewSession({
    cache: {
      get: async () => new Blob(["<html><body>airplane mode</body></html>"], { type: "text/html" }),
      put: async () => {},
    },
    getConnection: async () => {
      connectionCalls += 1;
      throw new Error("offline");
    },
    fetcher: async () => {
      fetchCalls += 1;
      throw new Error("offline");
    },
    createObjectUrl: (blob) => {
      previewBlob = blob;
      return "blob:offline-preview";
    },
    revokeObjectUrl: () => {},
  });

  await expect(session.load("item-1")).resolves.toMatchObject({
    url: "blob:offline-preview",
    sourceByteSize: 39,
  });
  expect(connectionCalls).toBe(0);
  expect(fetchCalls).toBe(0);
  expect(await (previewBlob as unknown as Blob).text()).toContain("airplane mode");
  session.dispose();
});

test("archive preview prefers a pending device capture over an older acknowledged cache", async () => {
  let previewBlob: Blob | null = null;
  const acknowledged = new Blob(["<html><body>old cloud copy</body></html>"], {
    type: "text/html",
  });
  const pending = new Blob(["<html><body>new local capture</body></html>"], {
    type: "text/html",
  });
  const cache = createArchivePreviewLocalCache(
    {
      get: async () => acknowledged,
      put: async () => {},
    },
    async () => ({
      itemId: "item-1",
      body: pending,
      sourceUrl: "https://example.com/new",
      updatedAt: 2_000,
    }),
  );
  const session = new ArchivePreviewSession({
    cache,
    getConnection: async () => {
      throw new Error("pending local bytes must win without auth");
    },
    fetcher: async () => {
      throw new Error("pending local bytes must win without network");
    },
    createObjectUrl: (blob) => {
      previewBlob = blob;
      return "blob:pending-preview";
    },
    revokeObjectUrl: () => {},
  });

  await expect(session.load("item-1")).resolves.toMatchObject({
    url: "blob:pending-preview",
  });
  expect(await (previewBlob as unknown as Blob).text()).toContain("new local capture");
  expect(await (previewBlob as unknown as Blob).text()).not.toContain("old cloud copy");
  session.dispose();
});

test("device archive preview strips active and network-loading markup before creating its blob URL", async () => {
  let previewBlob: Blob | null = null;
  const source = new Blob([
    `<!doctype html><html style="overflow:hidden"><head>` +
    `<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Lato">` +
    `<style>@import url("https://fonts.googleapis.com/css2?family=Joan");` +
    `.hero{background-image:url(https://cdn.example/hero.png)}` +
    `.embedded{background-image:url(data:image/png;base64,AA==)}</style>` +
    `</head><body style="overflow-y:hidden" onload="fetch('https://tracker.example')">` +
    `<div id="__vibesearch_picker_root__">Saved — move to…?</div>` +
    `<script>globalThis.archiveScriptRan = true</script>` +
    `<img src="https://cdn.example/photo.png">` +
    `<img id="saved" src="data:image/png;base64,AA==">` +
    `<a id="source" href="https://example.com/original">Original</a>` +
    `</body></html>`,
  ], { type: "text/html" });
  const session = new ArchivePreviewSession({
    cache: {
      get: async () => source,
      put: async () => {},
    },
    getConnection: async () => {
      throw new Error("device preview must not touch auth");
    },
    createObjectUrl: (blob) => {
      previewBlob = blob;
      return "blob:sanitized-device-preview";
    },
    revokeObjectUrl: () => {},
  });

  await expect(session.load("item-1")).resolves.toMatchObject({
    url: "blob:sanitized-device-preview",
    sourceByteSize: source.size,
  });
  const html = await (previewBlob as unknown as Blob).text();
  expect(html).toContain(ARCHIVE_PREVIEW_DOCUMENT_CSP);
  expect(html).not.toMatch(/<script\b/i);
  expect(html).not.toMatch(/<link\b/i);
  expect(html).not.toContain("fonts.googleapis.com");
  expect(html).not.toContain("cdn.example");
  expect(html).not.toContain("Saved — move to…?");
  expect(html).not.toMatch(/\sonload\s*=/i);
  expect(html).not.toContain("<html inert");
  expect(html).toContain("overflow-y:auto!important");
  expect(html).toContain("pointer-events:none!important");
  expect(html).toContain("data:image/png;base64,AA==");
  expect(html).toContain("https://example.com/original");
  session.dispose();
});

test("archive preview fetches the latest authenticated snapshot and revokes its object URL", async () => {
  const requests: Array<{ url: string; init?: RequestInit }> = [];
  const revoked: string[] = [];
  let previewBlob: Blob | null = null;
  const cached: Array<{ itemId: string; html: string }> = [];
  const session = new ArchivePreviewSession({
    cache: {
      get: async () => null,
      put: async (itemId, blob) => cached.push({ itemId, html: await blob.text() }),
    },
    getConnection: async (forceRefresh) => {
      expect(forceRefresh).toBe(false);
      return { token: "cloud-token", apiBase: "https://api.example/" };
    },
    fetcher: async (input, init) => {
      requests.push({ url: String(input), init });
      return new Response("<!doctype html><html><body>saved page</body></html>", {
        headers: {
          "content-type": "text/html; charset=utf-8",
          "content-length": "51",
          "x-vs-archive-captured-at": "1700000000000",
        },
      });
    },
    createObjectUrl: (blob) => {
      previewBlob = blob;
      return "blob:archive-preview";
    },
    revokeObjectUrl: (url) => revoked.push(url),
  });

  const preview = await session.load(" item / one ");

  expect(preview).toMatchObject({
    url: "blob:archive-preview",
    sourceByteSize: 51,
    capturedAt: 1_700_000_000_000,
  });
  expect(requests).toHaveLength(1);
  expect(requests[0].url).toBe("https://api.example/v1/items/%20item%20%2F%20one%20/archive");
  expect(requests[0].init?.method).toBe("GET");
  expect(new Headers(requests[0].init?.headers).get("authorization")).toBe("Bearer cloud-token");
  expect(requests[0].init?.cache).toBe("no-store");
  expect(requests[0].init?.credentials).toBe("omit");
  expect(cached).toEqual([
    { itemId: " item / one ", html: "<!doctype html><html><body>saved page</body></html>" },
  ]);

  const html = await (previewBlob as unknown as Blob).text();
  expect(html).toContain(ARCHIVE_PREVIEW_DOCUMENT_CSP);
  expect(html).toContain("<html data-vs-archive-document>");
  expect(html.indexOf(ARCHIVE_PREVIEW_DOCUMENT_CSP)).toBeLessThan(html.indexOf("saved page"));

  session.dispose();
  expect(revoked).toEqual(["blob:archive-preview"]);
});

test("archive preview refreshes expired auth once", async () => {
  const refreshes: boolean[] = [];
  let fetchCount = 0;
  const session = new ArchivePreviewSession({
    getConnection: async (forceRefresh) => {
      refreshes.push(forceRefresh);
      return {
        token: forceRefresh ? "fresh-token" : "expired-token",
        apiBase: "https://api.example",
      };
    },
    fetcher: async (_input, init) => {
      fetchCount += 1;
      if (fetchCount === 1) return new Response("expired", { status: 401 });
      expect(new Headers(init?.headers).get("authorization")).toBe("Bearer fresh-token");
      return new Response("<html><body>archive</body></html>", {
        headers: { "content-type": "text/html" },
      });
    },
    createObjectUrl: () => "blob:fresh-preview",
    revokeObjectUrl: () => {},
  });

  await expect(session.load("item-1")).resolves.toMatchObject({ url: "blob:fresh-preview" });
  expect(refreshes).toEqual([false, true]);
  expect(fetchCount).toBe(2);
  session.dispose();
});

test("archive preview rejects an oversized streamed response before creating a URL", async () => {
  let created = false;
  const session = new ArchivePreviewSession({
    maxBytes: 12,
    getConnection: async () => ({ token: "token", apiBase: "https://api.example" }),
    fetcher: async () => new Response(new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("12345678"));
        controller.enqueue(new TextEncoder().encode("abcdefgh"));
        controller.close();
      },
    }), { headers: { "content-type": "text/html" } }),
    createObjectUrl: () => {
      created = true;
      return "blob:too-large";
    },
    revokeObjectUrl: () => {},
  });

  await expect(session.load("item-1")).rejects.toMatchObject({
    code: "ARCHIVE_PREVIEW_TOO_LARGE",
  });
  expect(created).toBe(false);
  session.dispose();
});

test("disposing an in-flight archive preview aborts the request without leaking a URL", async () => {
  let created = false;
  let markFetchStarted!: () => void;
  const fetchStarted = new Promise<void>((resolve) => {
    markFetchStarted = resolve;
  });
  const session = new ArchivePreviewSession({
    getConnection: async () => ({ token: "token", apiBase: "https://api.example" }),
    fetcher: async (_input, init) => {
      markFetchStarted();
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => {
          reject(new DOMException("aborted", "AbortError"));
        }, { once: true });
      });
    },
    createObjectUrl: () => {
      created = true;
      return "blob:leaked";
    },
    revokeObjectUrl: () => {},
  });

  const loading = session.load("item-1");
  await fetchStarted;
  session.dispose();

  await expect(loading).rejects.toMatchObject({ code: "ARCHIVE_PREVIEW_ABORTED" });
  expect(created).toBe(false);
});

test("disposing during a stalled offline-cache read settles the preview load", async () => {
  let markCacheReadStarted!: () => void;
  const cacheReadStarted = new Promise<void>((resolve) => {
    markCacheReadStarted = resolve;
  });
  const session = new ArchivePreviewSession({
    cache: {
      get: async () => {
        markCacheReadStarted();
        return new Promise<Blob | null>(() => {});
      },
      put: async () => {},
    },
    getConnection: async () => {
      throw new Error("must not reach auth");
    },
    createObjectUrl: () => "blob:must-not-exist",
    revokeObjectUrl: () => {},
  });

  const loading = session.load("item-1");
  await cacheReadStarted;
  session.dispose();

  await expect(
    Promise.race([
      loading,
      new Promise((_, reject) => setTimeout(() => reject(new Error("preview did not settle")), 100)),
    ]),
  ).rejects.toMatchObject({ code: "ARCHIVE_PREVIEW_ABORTED" });
});

test("a newer local capture wins when an older cloud preview finishes later", async () => {
  let cached: Blob | null = null;
  let previewBlob: Blob | null = null;
  let releaseFetch!: () => void;
  let markFetchStarted!: () => void;
  const fetchStarted = new Promise<void>((resolve) => {
    markFetchStarted = resolve;
  });
  const fetchReleased = new Promise<void>((resolve) => {
    releaseFetch = resolve;
  });
  const session = new ArchivePreviewSession({
    cache: {
      get: async () => cached,
      put: async (_itemId, body) => {
        cached = body;
      },
      putIfAbsent: async (_itemId, body) => {
        if (!cached) cached = body;
      },
    },
    getConnection: async () => ({ token: "token", apiBase: "https://api.example" }),
    fetcher: async () => {
      markFetchStarted();
      await fetchReleased;
      return new Response("<html><body>older cloud archive</body></html>", {
        headers: { "content-type": "text/html" },
      });
    },
    createObjectUrl: (blob) => {
      previewBlob = blob;
      return "blob:newer-local-preview";
    },
    revokeObjectUrl: () => {},
  });

  const loading = session.load("item-1");
  await fetchStarted;
  cached = new Blob(["<html><body>newer local capture</body></html>"], { type: "text/html" });
  releaseFetch();
  await loading;

  expect(await (previewBlob as unknown as Blob).text()).toContain("newer local capture");
  expect(await (previewBlob as unknown as Blob).text()).not.toContain("older cloud archive");
  session.dispose();
});

test("an explicit refresh checks cloud and replaces an older readable cache entry", async () => {
  let cached = new Blob(["<html><body>old cached archive</body></html>"], { type: "text/html" });
  let previewBlob: Blob | null = null;
  let fetchCalls = 0;
  const session = new ArchivePreviewSession({
    preferFresh: true,
    cache: {
      get: async () => cached,
      put: async (_itemId, body) => {
        cached = body;
      },
    },
    getConnection: async () => ({ token: "token", apiBase: "https://api.example" }),
    fetcher: async () => {
      fetchCalls += 1;
      return new Response("<html><body>fresh cloud archive</body></html>", {
        headers: { "content-type": "text/html" },
      });
    },
    createObjectUrl: (blob) => {
      previewBlob = blob;
      return "blob:fresh-cloud-preview";
    },
    revokeObjectUrl: () => {},
  });

  await session.load("item-1");

  expect(fetchCalls).toBe(1);
  expect(await cached.text()).toContain("fresh cloud archive");
  expect(await (previewBlob as unknown as Blob).text()).toContain("fresh cloud archive");
  session.dispose();
});

test("login-less previews authenticate with the device key instead of a bearer token", async () => {
  const requests: Array<{ url: string; init?: RequestInit }> = [];
  const session = new ArchivePreviewSession({
    cache: {
      get: async () => null,
      put: async () => {},
    },
    getConnection: async () => ({
      token: "",
      apiBase: "https://api.example",
      deviceKey: "device-secret-123",
    }),
    fetcher: async (input, init) => {
      requests.push({ url: String(input), init });
      return new Response("<!doctype html><html><body>device copy</body></html>", {
        headers: { "content-type": "text/html; charset=utf-8" },
      });
    },
    createObjectUrl: () => "blob:device-preview",
    revokeObjectUrl: () => {},
  });

  await expect(session.load("anon-item-1")).resolves.toMatchObject({ url: "blob:device-preview" });
  expect(requests).toHaveLength(1);
  const headers = new Headers(requests[0].init?.headers);
  expect(headers.get("x-vs-device-key")).toBe("device-secret-123");
  expect(headers.get("authorization")).toBeNull();
  session.dispose();
});

test("a device-key miss is final: no pointless token refresh retry", async () => {
  const fetchCalls: Array<Request | string> = [];
  let connectionCalls = 0;
  const session = new ArchivePreviewSession({
    cache: {
      get: async () => null,
      put: async () => {},
    },
    getConnection: async () => {
      connectionCalls += 1;
      return { token: "", apiBase: "https://api.example", deviceKey: "device-secret-123" };
    },
    fetcher: async (input) => {
      fetchCalls.push(input);
      return new Response("unauthorized", { status: 401 });
    },
    createObjectUrl: () => "blob:unused",
    revokeObjectUrl: () => {},
  });

  await expect(session.load("anon-item-1")).rejects.toMatchObject({
    code: "ARCHIVE_PREVIEW_AUTH_REQUIRED",
  });
  expect(connectionCalls).toBe(1);
  expect(fetchCalls).toHaveLength(1);
  session.dispose();
});

test("a missing cloud copy is reported precisely", async () => {
  const session = new ArchivePreviewSession({
    cache: { get: async () => null, put: async () => {} },
    getConnection: async () => ({
      token: "",
      deviceKey: "device-secret-123",
      apiBase: "https://api.example",
    }),
    fetcher: async () => new Response("missing", { status: 404 }),
    createObjectUrl: () => "blob:unused",
    revokeObjectUrl: () => {},
  });

  await expect(session.load("item-missing")).rejects.toMatchObject({
    code: "ARCHIVE_PREVIEW_NOT_FOUND",
    message: "No snapshot exists yet.",
  });
  session.dispose();
});

test("a missing cloud copy is captured once and reopened in the same preview", async () => {
  let fetchCount = 0;
  const recovered: string[] = [];
  const session = new ArchivePreviewSession({
    cache: { get: async () => null, put: async () => {} },
    getConnection: async () => ({
      token: "",
      deviceKey: "device-secret-123",
      apiBase: "https://api.example",
    }),
    recoverMissing: async (itemId) => {
      recovered.push(itemId);
      return true;
    },
    fetcher: async () => {
      fetchCount += 1;
      if (fetchCount === 1) return new Response("missing", { status: 404 });
      return new Response("<html><body>recovered archive</body></html>", {
        headers: { "content-type": "text/html; charset=utf-8" },
      });
    },
    createObjectUrl: () => "blob:recovered-preview",
    revokeObjectUrl: () => {},
  });

  await expect(session.load("item-missing")).resolves.toMatchObject({
    url: "blob:recovered-preview",
  });
  expect(recovered).toEqual(["item-missing"]);
  expect(fetchCount).toBe(2);
  session.dispose();
});

test("a recovered device copy opens immediately even while its cloud upload is still pending", async () => {
  let localCopy: Blob | null = null;
  let fetchCount = 0;
  const session = new ArchivePreviewSession({
    cache: {
      get: async () => localCopy,
      put: async () => {},
    },
    getConnection: async () => ({
      token: "",
      deviceKey: "device-secret-123",
      apiBase: "https://api.example",
    }),
    recoverMissing: async () => {
      localCopy = new Blob(["<html><body>captured locally; cloud still uploading</body></html>"], {
        type: "text/html",
      });
      return false;
    },
    fetcher: async () => {
      fetchCount += 1;
      return new Response("missing", { status: 404 });
    },
    createObjectUrl: () => "blob:local-recovery-preview",
    revokeObjectUrl: () => {},
  });

  await expect(session.load("item-missing")).resolves.toMatchObject({
    url: "blob:local-recovery-preview",
  });
  expect(fetchCount).toBe(1);
  session.dispose();
});

test("previews without any identity fail with the connect nudge", async () => {
  const session = new ArchivePreviewSession({
    cache: {
      get: async () => null,
      put: async () => {},
    },
    getConnection: async () => ({ token: "", apiBase: "https://api.example" }),
    fetcher: async () => {
      throw new Error("must not fetch without identity");
    },
    createObjectUrl: () => "blob:unused",
    revokeObjectUrl: () => {},
  });

  await expect(session.load("item-1")).rejects.toMatchObject({
    code: "ARCHIVE_PREVIEW_AUTH_REQUIRED",
  });
  session.dispose();
});

test("a login-less device refused by cloud storage captures locally instead of demanding an account", async () => {
  // Exactly what a login-less install sees when the API declines its device
  // key: the copy is not in the cloud *for this device*, which is the same
  // situation as no cloud copy at all. Local-first means capture it here.
  let cached: Blob | null = null;
  let recoveries = 0;
  const session = new ArchivePreviewSession({
    cache: {
      get: async () => cached,
      put: async () => {},
    },
    getConnection: async () => ({
      token: "",
      apiBase: "https://api.example",
      deviceKey: "device-secret-123",
    }),
    fetcher: async () => new Response("unauthorized", { status: 401 }),
    recoverMissing: async () => {
      recoveries += 1;
      cached = new Blob(["<html><body>local capture</body></html>"], { type: "text/html" });
      return true;
    },
    sanitizeSource: async (source) => source,
    createObjectUrl: () => "blob:local",
    revokeObjectUrl: () => {},
  });

  const document = await session.load("anon-item-1");

  expect(recoveries).toBe(1);
  expect(document.url).toBe("blob:local");
  expect(document.sourceByteSize).toBeGreaterThan(0);
  session.dispose();
});

test("a refused token with a device key still opens the local copy instead of nudging to connect", async () => {
  // The signed-in-but-dead state: the bearer token is refused and cannot be
  // refreshed, and cloud storage has nothing for the fallback device identity.
  let cached: Blob | null = null;
  const identities: string[] = [];
  const session = new ArchivePreviewSession({
    cache: { get: async () => cached, put: async () => {} },
    getConnection: async (forceRefresh: boolean) => ({
      token: forceRefresh ? "" : "dead-token",
      apiBase: "https://api.example",
      deviceKey: "device-secret-123",
    }),
    fetcher: async (_input, init) => {
      const headers = new Headers(init?.headers);
      identities.push(headers.get("authorization") ? "bearer" : "device-key");
      return new Response("unauthorized", { status: 401 });
    },
    recoverMissing: async () => {
      cached = new Blob(["<html><body>captured here</body></html>"], { type: "text/html" });
      return true;
    },
    sanitizeSource: async (source) => source,
    createObjectUrl: () => "blob:recovered",
    revokeObjectUrl: () => {},
  });

  await expect(session.load("item-dead-session")).resolves.toMatchObject({ url: "blob:recovered" });
  // Both identities were tried once, then the page was captured locally.
  expect(identities).toEqual(["bearer", "device-key"]);
  session.dispose();
});

test("a device with no identity at all still captures locally before giving up", async () => {
  let cached: Blob | null = null;
  const session = new ArchivePreviewSession({
    cache: {
      get: async () => cached,
      put: async () => {},
    },
    getConnection: async () => ({ token: "", apiBase: "https://api.example" }),
    fetcher: async () => {
      throw new Error("must not fetch without identity");
    },
    recoverMissing: async () => {
      cached = new Blob(["<html><body>offline only</body></html>"], { type: "text/html" });
      return true;
    },
    sanitizeSource: async (source) => source,
    createObjectUrl: () => "blob:offline",
    revokeObjectUrl: () => {},
  });

  await expect(session.load("item-1")).resolves.toMatchObject({ url: "blob:offline" });
  session.dispose();
});
