type ArchiveRecoveryTabPort = {
  create(properties: { url: string; active: false }): Promise<chrome.tabs.Tab>;
  remove(tabId: number): Promise<void>;
  onUpdated: {
    addListener(
      listener: (
        tabId: number,
        changeInfo: chrome.tabs.TabChangeInfo,
        tab: chrome.tabs.Tab,
      ) => void,
    ): void;
    removeListener(
      listener: (
        tabId: number,
        changeInfo: chrome.tabs.TabChangeInfo,
        tab: chrome.tabs.Tab,
      ) => void,
    ): void;
  };
};

type TemporaryArchiveTabOptions = {
  tabs?: ArchiveRecoveryTabPort;
  timeoutMs?: number;
};

const waitForComplete = (
  created: chrome.tabs.Tab,
  tabs: ArchiveRecoveryTabPort,
  timeoutMs: number,
): Promise<chrome.tabs.Tab> => {
  if (created.status === "complete") return Promise.resolve(created);
  const tabId = created.id;
  if (tabId === undefined) return Promise.reject(new Error("ARCHIVE_RECOVERY_TAB_MISSING"));

  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (callback: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      tabs.onUpdated.removeListener(onUpdated);
      callback();
    };
    const onUpdated = (
      updatedTabId: number,
      changeInfo: chrome.tabs.TabChangeInfo,
      tab: chrome.tabs.Tab,
    ) => {
      if (updatedTabId !== tabId || changeInfo.status !== "complete") return;
      finish(() => resolve(tab));
    };
    const timeout = setTimeout(
      () => finish(() => reject(new Error("ARCHIVE_RECOVERY_TAB_TIMEOUT"))),
      timeoutMs,
    );
    tabs.onUpdated.addListener(onUpdated);
  });
};

/**
 * Pick an already-open tab that can actually answer a capture request.
 *
 * A discarded tab still reports its URL to `tabs.query` but runs no content
 * script, so preferring one strands the recovery on a tab that can never
 * respond. Tabs that merely have no id are equally unusable.
 */
export function pickLiveArchiveCaptureTab<
  Tab extends Pick<chrome.tabs.Tab, "id" | "url" | "discarded">,
>(
  tabs: Tab[],
  sourceUrl: string,
  normalizeUrl: (value: string | null | undefined) => string | null,
): Tab | null {
  const target = normalizeUrl(sourceUrl);
  if (!target) return null;
  return tabs.find((tab) =>
    tab.id !== undefined &&
    tab.discarded !== true &&
    normalizeUrl(tab.url) === target) ?? null;
}

/**
 * Load a page in the user's browser session, capture it, then close only the
 * temporary tab created for recovery. This is the reliable fallback for sites
 * that reject server-side bots but load normally for the signed-in user.
 */
export async function withTemporaryArchiveTab<T>(
  url: string,
  capture: (tab: chrome.tabs.Tab) => Promise<T>,
  options: TemporaryArchiveTabOptions = {},
): Promise<T> {
  const tabs = options.tabs ?? chrome.tabs;
  const timeoutMs = Math.max(1_000, Math.floor(options.timeoutMs ?? 30_000));
  const created = await tabs.create({ url, active: false });
  const tabId = created.id;
  if (tabId === undefined) throw new Error("ARCHIVE_RECOVERY_TAB_MISSING");
  try {
    const loaded = await waitForComplete(created, tabs, timeoutMs);
    return await capture(loaded);
  } finally {
    await tabs.remove(tabId).catch(() => undefined);
  }
}
