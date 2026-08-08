import { expect, test } from "bun:test";
import {
  ARCHIVE_PREVIEW_DOCUMENT_CSP,
  ArchivePreviewSession,
} from "@src/services/archive-preview";

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
        },
      });
    },
    createObjectUrl: (blob) => {
      previewBlob = blob;
      return "blob:archive-preview";
    },
    revokeObjectUrl: (url) => revoked.push(url),
  });

  const preview = await session.load("item / one");

  expect(preview).toMatchObject({
    url: "blob:archive-preview",
    sourceByteSize: 51,
  });
  expect(requests).toHaveLength(1);
  expect(requests[0].url).toBe("https://api.example/v1/items/item%20%2F%20one/archive");
  expect(requests[0].init?.method).toBe("GET");
  expect(new Headers(requests[0].init?.headers).get("authorization")).toBe("Bearer cloud-token");
  expect(requests[0].init?.cache).toBe("no-store");
  expect(requests[0].init?.credentials).toBe("omit");
  expect(cached).toEqual([
    { itemId: "item / one", html: "<!doctype html><html><body>saved page</body></html>" },
  ]);

  const html = await (previewBlob as unknown as Blob).text();
  expect(html).toContain(ARCHIVE_PREVIEW_DOCUMENT_CSP);
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
