import { expect, test } from "bun:test";
import { fitLocalCapture, LOCAL_MESSAGE_MAX_BYTES, localCaptureSchema, localRequestBytes, localRequestSchema, localSearchResultSchema, sliceLocalText, type LocalCapture } from "@src/services/local-companion-protocol";
import { isLocalCompanionSender } from "@src/services/local-companion-security";

const capture: LocalCapture = { id: "6be26637-0c0c-4f79-85bb-74e0fd8f1c93", url: "https://example.com/page", title: "Page", text: "Saved page text", capturedAt: 1000, gaps: [] };

test("strict local requests reject URL credentials, arbitrary fields, and unbounded queries", () => {
  expect(localCaptureSchema.safeParse({ ...capture, url: "https://user:password@example.com/" }).success).toBe(false);
  expect(localCaptureSchema.safeParse({ ...capture, url: "file:///private" }).success).toBe(false);
  expect(localCaptureSchema.safeParse({ ...capture, capturedAt: 8640000000000001 }).success).toBe(false);
  expect(localRequestSchema.safeParse({ version: 1, id: capture.id, action: "save", capture, upload: true }).success).toBe(false);
  expect(localRequestSchema.safeParse({ version: 1, id: capture.id, action: "search", query: " ", limit: 1 }).success).toBe(false);
  expect(localRequestSchema.safeParse({ version: 1, id: capture.id, action: "search", query: "x", limit: 30 }).success).toBe(true);
  expect(localRequestSchema.safeParse({ version: 1, id: capture.id, action: "search", query: "x", limit: 31 }).success).toBe(false);
});

test("multibyte and JSON-escaped captures fit wire bytes before durable save without splitting surrogate pairs", () => {
  for (const text of ["😀".repeat(60000), "\u0000".repeat(120000), "\\\"".repeat(60000)]) {
    const fitted = fitLocalCapture({ ...capture, text });
    expect(localRequestBytes({ version: 1, id: fitted.id, action: "save", capture: fitted })).toBeLessThanOrEqual(LOCAL_MESSAGE_MAX_BYTES);
    expect(fitted.text).not.toMatch(/[\uD800-\uDBFF]$/);
    if (localRequestBytes({ version: 1, id: capture.id, action: "save", capture: { ...capture, text } }) > LOCAL_MESSAGE_MAX_BYTES) expect(fitted.gaps).toContain("Text was shortened to fit the local companion message limit.");
    expect(fitLocalCapture({ ...capture, text })).toEqual(fitted);
  }
  expect(sliceLocalText("x😀y", 2)).toBe("x");
});

test("search URLs stay complete or null and reject credential-bearing links", () => {
  const result = { hits: [{ itemId: "item", title: "Page", url: "https://example.com/path?key=value", snippet: "Text", gaps: [] }], generation: 1, network: "local", mode: "text" };
  expect(localSearchResultSchema.parse(result).hits[0]?.url).toBe(result.hits[0]?.url);
  expect(localSearchResultSchema.safeParse({ ...result, hits: [{ ...result.hits[0], url: "https://u:p@example.com" }] }).success).toBe(false);
});

test("only the popup may ask to capture a tab and web content cannot use the companion", () => {
  const id = "extension";
  const root = "chrome-extension://extension/";
  const save = { target: "local-companion", action: "save-tab", tabId: 2 } satisfies Parameters<typeof isLocalCompanionSender>[1];
  const status = { target: "local-companion", action: "status" } satisfies Parameters<typeof isLocalCompanionSender>[1];
  expect(isLocalCompanionSender({ id, url: `${root}src/pages/popup/index.html` }, save, id, root)).toBe(true);
  expect(isLocalCompanionSender({ id, url: `${root}src/pages/local/index.html` }, save, id, root)).toBe(false);
  expect(isLocalCompanionSender({ id, url: "https://example.com" }, status, id, root)).toBe(false);
  expect(isLocalCompanionSender({ id, url: `${root}src/pages/search/index.html` }, status, id, root)).toBe(false);
  expect(isLocalCompanionSender({ id, url: "bad-url" }, status, id, root)).toBe(false);
});
