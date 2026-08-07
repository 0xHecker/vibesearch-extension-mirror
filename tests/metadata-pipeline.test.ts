import { describe, expect, test } from "bun:test";
import {
  chunkUrlsForMetadataRequest,
  getMetadataPipelineStats,
  scheduleForProcessing,
  setMetadataProgressListener,
} from "../src/services/metadata-pipeline";

const withFakeChrome = async (
  run: (messages: any[]) => void | Promise<void>
): Promise<void> => {
  const previousChrome = (globalThis as any).chrome;
  const messages: any[] = [];
  (globalThis as any).chrome = {
    runtime: {
      getContexts: async () => [],
      getURL: (path: string) => `chrome-extension://test/${path}`,
      sendMessage: async (message: any) => {
        messages.push(message);
        return { success: true };
      },
    },
    offscreen: {
      createDocument: async () => undefined,
    },
  };

  try {
    await run(messages);
  } finally {
    if (previousChrome === undefined) {
      delete (globalThis as any).chrome;
    } else {
      (globalThis as any).chrome = previousChrome;
    }
  }
};

const withFakeFetch = async (
  fetchImpl: typeof fetch,
  run: () => void | Promise<void>
): Promise<void> => {
  const previousFetch = globalThis.fetch;
  globalThis.fetch = fetchImpl;
  try {
    await run();
  } finally {
    globalThis.fetch = previousFetch;
  }
};

const waitFor = async (condition: () => boolean, timeoutMs = 1000): Promise<void> => {
  const startedAt = Date.now();
  while (!condition()) {
    if (Date.now() - startedAt > timeoutMs) {
      throw new Error("Timed out waiting for condition.");
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
};

describe("metadata pipeline batching safeguards", () => {
  test("keeps a very long URL instead of dropping it for a cache-key limit", () => {
    const normalUrl = "https://example.com/article";
    const oversizedUrl = `https://example.com/search?${"q=".repeat(7_000)}`;
    const batches = chunkUrlsForMetadataRequest([normalUrl, oversizedUrl]);

    expect(batches.flat()).toEqual([normalUrl, oversizedUrl]);
    expect(batches).toEqual([[normalUrl], [oversizedUrl]]);
  });

  test("isolates long URLs so they cannot inflate a normal request batch", () => {
    const urls = [
      "https://example.com/a",
      `https://example.com/search?${"long-param=".repeat(1_500)}`,
      "https://example.com/b",
    ];
    const batches = chunkUrlsForMetadataRequest(urls);

    expect(batches).toEqual([[urls[0]], [urls[1]], [urls[2]]]);
    expect(batches.flat()).toEqual(urls);
  });

  test("skips direct resources while marking matching local records metadata-complete", async () => {
    await withFakeChrome(async (messages) => {
      const before = getMetadataPipelineStats().scheduledUrls;
      scheduleForProcessing([
        "https://cdn.example.com/image.png",
        "https://files.example.com/report.pdf",
      ]);
      await new Promise((resolve) => setTimeout(resolve, 0));

      expect(getMetadataPipelineStats().scheduledUrls).toBe(before);
      expect(messages).toHaveLength(1);
      expect(messages[0].payload.metaMap).toEqual({
        "https://cdn.example.com/image.png": { isMetaFetched: true },
        "https://files.example.com/report.pdf": { isMetaFetched: true },
      });
    });
  });

  test("does not leave omitted URLs pending after an otherwise successful response", async () => {
    const firstUrl = "https://partial-response.example/a";
    const secondUrl = "https://partial-response.example/b";
    const snapshots: Array<{ pending: number }> = [];

    await withFakeChrome(async (messages) => {
      await withFakeFetch(
        async () =>
          new Response(JSON.stringify([{ url: firstUrl, title: "First" }]), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          }),
        async () => {
          setMetadataProgressListener((snapshot) => snapshots.push(snapshot));
          try {
            scheduleForProcessing([firstUrl, secondUrl]);
            await waitFor(() => messages.length > 0);

            const metaMap = messages[0].payload.metaMap;
            expect(metaMap[firstUrl].title).toBe("First");
            expect(metaMap[secondUrl]).toEqual({ isMetaFetched: true });
            expect(snapshots.at(-1)?.pending).toBe(0);
          } finally {
            setMetadataProgressListener(null);
          }
        }
      );
    });
  });

  test("preserves percent-encoded item URLs when saving fetched metadata", async () => {
    const encodedUrl = "https://encoded.example/search?q=a%20b";

    await withFakeChrome(async (messages) => {
      await withFakeFetch(
        async () =>
          new Response(JSON.stringify([{ title: "Encoded URL" }]), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          }),
        async () => {
          scheduleForProcessing([encodedUrl]);
          await waitFor(() => messages.length > 0);

          expect(messages[0].payload.metaMap[encodedUrl].title).toBe("Encoded URL");
          expect(messages[0].payload.metaMap["https://encoded.example/search?q=a b"]).toBeUndefined();
        }
      );
    });
  });
});
