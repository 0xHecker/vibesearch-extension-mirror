import { expect, test } from "bun:test";
import {
  pickLiveArchiveCaptureTab,
  withTemporaryArchiveTab,
} from "@src/services/archive-tab-recovery";

const normalizeUrl = (value: string | null | undefined): string | null => {
  try {
    const url = new URL(String(value));
    return url.protocol === "http:" || url.protocol === "https:" ? url.toString() : null;
  } catch {
    return null;
  }
};

type Listener = (
  tabId: number,
  changeInfo: { status?: string; url?: string },
  tab: chrome.tabs.Tab,
) => void;

const fakeTabs = () => {
  const listeners = new Set<Listener>();
  const removed: number[] = [];
  const loading = { id: 17, status: "loading", url: "https://example.com/page" } as chrome.tabs.Tab;
  const complete = { ...loading, status: "complete" } as chrome.tabs.Tab;
  return {
    removed,
    port: {
      create: async () => {
        setTimeout(() => {
          for (const listener of listeners) listener(17, { status: "complete" }, complete);
        }, 0);
        return loading;
      },
      get: async () => loading,
      remove: async (tabId: number) => {
        removed.push(tabId);
      },
      onUpdated: {
        addListener: (listener: Listener) => listeners.add(listener),
        removeListener: (listener: Listener) => listeners.delete(listener),
      },
    },
  };
};

test("temporary archive recovery waits for load, captures, and closes the tab", async () => {
  const tabs = fakeTabs();
  const captured: number[] = [];
  await expect(withTemporaryArchiveTab(
    "https://example.com/page",
    async (tab) => {
      captured.push(tab.id!);
      return "captured";
    },
    { tabs: tabs.port },
  )).resolves.toBe("captured");
  expect(captured).toEqual([17]);
  expect(tabs.removed).toEqual([17]);
});

test("temporary archive recovery closes the tab when capture fails", async () => {
  const tabs = fakeTabs();
  await expect(withTemporaryArchiveTab(
    "https://example.com/page",
    async () => {
      throw new Error("capture failed");
    },
    { tabs: tabs.port },
  )).rejects.toThrow("capture failed");
  expect(tabs.removed).toEqual([17]);
});

test("capture tab selection ignores tabs that cannot answer", () => {
  const url = "https://example.com/page";

  // A discarded tab keeps its URL but runs no content script: preferring it
  // strands the recovery on "Receiving end does not exist".
  expect(pickLiveArchiveCaptureTab(
    [{ id: 3, url, discarded: true }],
    url,
    normalizeUrl,
  )).toBeNull();

  expect(pickLiveArchiveCaptureTab(
    [{ id: undefined, url, discarded: false }],
    url,
    normalizeUrl,
  )).toBeNull();

  expect(pickLiveArchiveCaptureTab(
    [
      { id: 3, url, discarded: true },
      { id: 4, url, discarded: false },
    ],
    url,
    normalizeUrl,
  )?.id).toBe(4);

  expect(pickLiveArchiveCaptureTab(
    [{ id: 4, url: "https://example.com/other", discarded: false }],
    url,
    normalizeUrl,
  )).toBeNull();
});
