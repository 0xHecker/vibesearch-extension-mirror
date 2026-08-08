import type { NotionExportItem } from "@src/services/notion-export-source";

export const NOTION_API_VERSION = "2026-03-11";
export const NOTION_BLOCKS_PER_REQUEST = 80;
const NOTION_API_BASE = "https://api.notion.com/v1";
const NOTION_REQUEST_TIMEOUT_MS = 45_000;
const NOTION_RESPONSE_MAX_BYTES = 256 * 1024;
const NOTION_REQUEST_MAX_BYTES = 450 * 1024;
const NOTION_MAX_ATTEMPTS = 4;

type NotionText = {
  type: "text";
  text: { content: string; link?: { url: string } | null };
  annotations?: { bold?: boolean; italic?: boolean; color?: string };
};

export type NotionBlock = {
  object: "block";
  type: "paragraph" | "divider" | "bulleted_list_item";
  paragraph?: { rich_text: NotionText[] };
  divider?: Record<string, never>;
  bulleted_list_item?: { rich_text: NotionText[] };
};

export type NotionExportPage = {
  id: string;
  url: string;
};

export type NotionRequestDependencies = {
  fetcher?: typeof fetch;
  sleep?: (milliseconds: number) => Promise<void>;
};

const sleep = (milliseconds: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, milliseconds));

const clipped = (value: string, maxLength: number): string => {
  const normalized = value.trim();
  if (normalized.length <= maxLength) return normalized;
  return `${normalized.slice(0, Math.max(0, maxLength - 1)).trimEnd()}…`;
};

const validHttpUrl = (value: string): string => {
  try {
    const url = new URL(value);
    const normalized = url.toString();
    return (url.protocol === "http:" || url.protocol === "https:") && normalized.length <= 2_000
      ? normalized
      : "";
  } catch {
    return "";
  }
};

const safeIsoDate = (value: number): string => {
  if (!Number.isSafeInteger(value) || value <= 0 || value > 8_640_000_000_000_000) return "";
  try {
    return new Date(value).toISOString().slice(0, 10);
  } catch {
    return "";
  }
};

const readBoundedText = async (
  response: Response,
  signal: AbortSignal,
  maxBytes: number,
): Promise<string> => {
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maxBytes) {
    await response.body?.cancel().catch(() => {});
    throw new Error("NOTION_API_RESPONSE_TOO_LARGE");
  }
  if (!response.body) {
    const buffer = await response.arrayBuffer();
    if (buffer.byteLength > maxBytes) throw new Error("NOTION_API_RESPONSE_TOO_LARGE");
    return new TextDecoder().decode(buffer);
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let byteSize = 0;
  try {
    while (true) {
      if (signal.aborted) throw new DOMException("Aborted", "AbortError");
      const { done, value } = await reader.read();
      if (done) break;
      if (!value?.byteLength) continue;
      byteSize += value.byteLength;
      if (byteSize > maxBytes) {
        await reader.cancel().catch(() => {});
        throw new Error("NOTION_API_RESPONSE_TOO_LARGE");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const merged = new Uint8Array(byteSize);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(merged);
};

const retryDelayMs = (response: Response, attempt: number): number => {
  const raw = response.headers.get("retry-after")?.trim() || "";
  const seconds = Number(raw);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.min(30_000, seconds * 1_000);
  const date = Date.parse(raw);
  if (Number.isFinite(date)) return Math.max(0, Math.min(30_000, date - Date.now()));
  return Math.min(8_000, 500 * 2 ** attempt);
};

export async function requestNotionJson<T extends Record<string, unknown>>(
  token: string,
  path: string,
  init: { method: "POST" | "PATCH"; body: Record<string, unknown> },
  dependencies: NotionRequestDependencies = {},
): Promise<T> {
  const fetcher = dependencies.fetcher || fetch;
  const wait = dependencies.sleep || sleep;
  const serialized = JSON.stringify(init.body);
  if (new TextEncoder().encode(serialized).byteLength > NOTION_REQUEST_MAX_BYTES) {
    throw new Error("NOTION_REQUEST_TOO_LARGE");
  }

  for (let attempt = 0; attempt < NOTION_MAX_ATTEMPTS; attempt += 1) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), NOTION_REQUEST_TIMEOUT_MS);
    try {
      const response = await fetcher(`${NOTION_API_BASE}${path}`, {
        method: init.method,
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
          "Notion-Version": NOTION_API_VERSION,
        },
        body: serialized,
        signal: controller.signal,
        credentials: "omit",
        cache: "no-store",
      });
      const raw = await readBoundedText(response, controller.signal, NOTION_RESPONSE_MAX_BYTES);
      if (
        [429, 500, 502, 503, 504, 529].includes(response.status) &&
        attempt + 1 < NOTION_MAX_ATTEMPTS
      ) {
        await wait(retryDelayMs(response, attempt));
        continue;
      }
      let payload: unknown = {};
      try {
        payload = raw ? JSON.parse(raw) : {};
      } catch {
        throw new Error("NOTION_API_INVALID_RESPONSE");
      }
      if (!response.ok) {
        const message = payload && typeof payload === "object" && !Array.isArray(payload)
          ? clipped(String((payload as Record<string, unknown>).message || ""), 500)
          : "";
        if (response.status === 401) throw new Error("NOTION_AUTH_EXPIRED");
        throw new Error(`NOTION_API_${response.status}${message ? `: ${message}` : ""}`);
      }
      if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
        throw new Error("NOTION_API_INVALID_RESPONSE");
      }
      return payload as T;
    } catch (error) {
      if (controller.signal.aborted) throw new Error("NOTION_API_TIMEOUT");
      throw error;
    } finally {
      clearTimeout(timeout);
    }
  }
  throw new Error("NOTION_API_RETRY_EXHAUSTED");
}

export const buildNotionItemBlock = (item: NotionExportItem): NotionBlock => {
  const url = validHttpUrl(item.url);
  const title: NotionText = {
    type: "text",
    text: {
      content: clipped(item.title || item.url || "Untitled", 600),
      ...(url ? { link: { url } } : {}),
    },
    annotations: { bold: true },
  };
  const metadata = [
    [item.spaceName, item.folderName].filter(Boolean).join(" › "),
    item.source,
    item.type,
    item.isFavorite ? "★ favorite" : "",
    item.tags.length > 0 ? item.tags.map((tag) => `#${tag}`).join(" ") : "",
    safeIsoDate(item.updatedAt),
  ].filter(Boolean).join(" · ");
  const richText: NotionText[] = [title];
  if (metadata) {
    richText.push({
      type: "text",
      text: { content: `\n${clipped(metadata, 1_900)}` },
      annotations: { color: "gray" },
    });
  }
  if (item.description) {
    richText.push({
      type: "text",
      text: { content: `\n${clipped(item.description, 1_800)}` },
    });
  }
  return {
    object: "block",
    type: "bulleted_list_item",
    bulleted_list_item: { rich_text: richText },
  };
};

export async function createNotionExportPage(
  token: string,
  createdAt = Date.now(),
): Promise<NotionExportPage> {
  const date = new Date(createdAt);
  const title = `VibeSearch export — ${date.toISOString().slice(0, 10)}`;
  const result = await requestNotionJson<Record<string, unknown>>(token, "/pages", {
    method: "POST",
    body: {
      parent: { type: "workspace", workspace: true },
      properties: {
        title: {
          type: "title",
          title: [{ type: "text", text: { content: title } }],
        },
      },
      children: [
        {
          object: "block",
          type: "paragraph",
          paragraph: {
            rich_text: [{
              type: "text",
              text: { content: `Exported from VibeSearch on ${date.toLocaleString()}. Links, organization, tags, favorites, and a readable content excerpt are included.` },
            }],
          },
        },
        { object: "block", type: "divider", divider: {} },
      ],
    },
  });
  const id = typeof result.id === "string" ? result.id : "";
  if (!id) throw new Error("NOTION_PAGE_ID_MISSING");
  const url = typeof result.url === "string" && result.url
    ? result.url
    : `https://www.notion.so/${id.replace(/-/g, "")}`;
  return { id, url };
}

export async function appendNotionExportItems(
  token: string,
  pageId: string,
  items: NotionExportItem[],
): Promise<void> {
  if (items.length === 0) return;
  if (items.length > NOTION_BLOCKS_PER_REQUEST) throw new Error("NOTION_EXPORT_BATCH_TOO_LARGE");
  await requestNotionJson<Record<string, unknown>>(
    token,
    `/blocks/${encodeURIComponent(pageId)}/children`,
    {
      method: "PATCH",
      body: { children: items.map(buildNotionItemBlock) },
    },
  );
}
