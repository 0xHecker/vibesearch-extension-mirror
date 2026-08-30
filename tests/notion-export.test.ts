import { expect, test } from "bun:test";
import {
  appendNotionExportItems,
  buildNotionItemBlock,
  createNotionExportPage,
  NOTION_API_VERSION,
  requestNotionJson,
} from "@src/services/notion-export";
import type { NotionExportItem } from "@src/services/notion-export-source";

const item = (overrides: Partial<NotionExportItem> = {}): NotionExportItem => ({
  id: "item-a",
  title: "Example",
  url: "https://example.com/article",
  source: "web",
  spaceName: "Research",
  folderName: "Reading",
  tags: ["design", "systems"],
  description: "A useful saved page.",
  isFavorite: true,
  createdAt: 1,
  updatedAt: Date.UTC(2026, 7, 9),
  ...overrides,
});

test("Notion item blocks preserve the link, organization, tags, and excerpt", () => {
  const block = buildNotionItemBlock(item());
  const richText = block.bulleted_list_item?.rich_text || [];
  expect(richText[0]?.text.link?.url).toBe("https://example.com/article");
  expect(richText.map((entry) => entry.text.content).join(""))
    .toContain("Research › Reading");
  expect(richText.map((entry) => entry.text.content).join(""))
    .toContain("#design #systems");
  expect(richText.map((entry) => entry.text.content).join(""))
    .toContain("A useful saved page.");
});

test("Notion item blocks never turn a non-http URL into a clickable link", () => {
  const block = buildNotionItemBlock(item({ url: "javascript:alert(1)" }));
  expect(block.bulleted_list_item?.rich_text[0]?.text.link).toBeUndefined();
});

test("Notion API retries rate limits using Retry-After and sends the current version", async () => {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const waits: number[] = [];
  const fetcher = (async (input, init) => {
    calls.push({ url: String(input), init });
    if (calls.length === 1) {
      return Response.json({ message: "slow down" }, {
        status: 429,
        headers: { "retry-after": "1" },
      });
    }
    return Response.json({ id: "page-a" });
  }) as typeof fetch;

  const result = await requestNotionJson<{ id: string }>(
    "token",
    "/pages",
    { method: "POST", body: { parent: { workspace: true } } },
    { fetcher, sleep: async (milliseconds) => { waits.push(milliseconds); } },
  );

  expect(result.id).toBe("page-a");
  expect(calls).toHaveLength(2);
  expect(waits).toEqual([1_000]);
  expect((calls[0].init?.headers as Record<string, string>)["Notion-Version"])
    .toBe(NOTION_API_VERSION);
});

test("Notion API rejects an oversized request before starting a fetch", async () => {
  let calls = 0;
  await expect(requestNotionJson(
    "token",
    "/pages",
    { method: "POST", body: { content: "x".repeat(500 * 1024) } },
    { fetcher: (async () => { calls += 1; return Response.json({}); }) as typeof fetch },
  )).rejects.toThrow("NOTION_REQUEST_TOO_LARGE");
  expect(calls).toBe(0);
});

test("Notion API never retries before a long Retry-After window", async () => {
  let calls = 0;
  let waits = 0;
  await expect(requestNotionJson(
    "token",
    "/pages",
    { method: "POST", body: { parent: { workspace: true } } },
    {
      fetcher: (async () => {
        calls += 1;
        return Response.json({ code: "rate_limited" }, {
          status: 429,
          headers: { "retry-after": "45" },
        });
      }) as typeof fetch,
      sleep: async () => { waits += 1; },
    },
  )).rejects.toThrow("NOTION_API_RETRY_AFTER_TOO_LONG");
  expect(calls).toBe(1);
  expect(waits).toBe(0);
});

test("Notion API backs off when a rate-limit response omits Retry-After", async () => {
  let calls = 0;
  const waits: number[] = [];
  const result = await requestNotionJson<{ id: string }>(
    "token",
    "/pages",
    { method: "POST", body: { parent: { workspace: true } } },
    {
      fetcher: (async () => {
        calls += 1;
        return calls === 1
          ? Response.json({ code: "rate_limited" }, { status: 429 })
          : Response.json({ id: "page-a" });
      }) as typeof fetch,
      sleep: async (milliseconds) => { waits.push(milliseconds); },
    },
  );

  expect(result.id).toBe("page-a");
  expect(waits).toEqual([500]);
});

test("Notion API does not replay a mutating request after a server error", async () => {
  let calls = 0;
  await expect(requestNotionJson(
    "token",
    "/pages",
    { method: "POST", body: { parent: { workspace: true } } },
    {
      fetcher: (async () => {
        calls += 1;
        return Response.json({ code: "service_unavailable" }, { status: 503 });
      }) as typeof fetch,
      sleep: async () => { throw new Error("unexpected wait"); },
    },
  )).rejects.toThrow("NOTION_API_503");
  expect(calls).toBe(1);
});

test("Notion append splits multi-byte blocks before the payload ceiling", async () => {
  const originalFetch = globalThis.fetch;
  const bodies: string[] = [];
  globalThis.fetch = (async (_input, init) => {
    bodies.push(String(init?.body));
    return Response.json({ object: "list", results: [] });
  }) as typeof fetch;

  try {
    await appendNotionExportItems(
      "token",
      "12345678-1234-1234-1234-123456789abc",
      Array.from({ length: 80 }, (_, index) => item({
        id: `item-${index}`,
        title: "🥑".repeat(600),
        description: "🥑".repeat(1_800),
        tags: Array.from({ length: 20 }, () => "🥑".repeat(100)),
      })),
    );
  } finally {
    globalThis.fetch = originalFetch;
  }

  expect(bodies.length).toBeGreaterThan(1);
  expect(bodies.every((body) => new TextEncoder().encode(body).byteLength <= 450 * 1024))
    .toBe(true);
  expect(bodies.reduce((total, body) => total + JSON.parse(body).children.length, 0)).toBe(80);
});

test("Notion export creates a private workspace page then appends a bounded item page", async () => {
  const originalFetch = globalThis.fetch;
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  globalThis.fetch = (async (input, init) => {
    calls.push({ url: String(input), init });
    if (String(input).endsWith("/pages")) {
      return Response.json({
        id: "12345678-1234-1234-1234-123456789abc",
        url: "https://www.notion.so/VibeSearch-12345678123412341234123456789abc",
      });
    }
    return Response.json({ object: "list", results: [] });
  }) as typeof fetch;

  try {
    const page = await createNotionExportPage("token", Date.UTC(2026, 7, 9));
    await appendNotionExportItems("token", page.id, [item(), item({ id: "item-b" })]);
    expect(page.url).toStartWith("https://www.notion.so/");
  } finally {
    globalThis.fetch = originalFetch;
  }

  expect(calls.map((call) => new URL(call.url).pathname)).toEqual([
    "/v1/pages",
    "/v1/blocks/12345678-1234-1234-1234-123456789abc/children",
  ]);
  const createBody = JSON.parse(String(calls[0]?.init?.body));
  expect(createBody.parent).toEqual({ type: "workspace", workspace: true });
  expect(createBody.children).toHaveLength(2);
  const appendBody = JSON.parse(String(calls[1]?.init?.body));
  expect(appendBody.children).toHaveLength(2);
});
