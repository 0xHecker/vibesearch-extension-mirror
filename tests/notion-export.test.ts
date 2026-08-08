import { expect, test } from "bun:test";
import {
  buildNotionItemBlock,
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
