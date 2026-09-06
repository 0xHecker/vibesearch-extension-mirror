export const executeScriptInTab = async <
  Result,
  Arguments extends unknown[] = unknown[],
>(
  tab: chrome.tabs.Tab | undefined,
  func: (...args: Arguments) => Result | Promise<Result>,
  args: Arguments,
): Promise<Awaited<Result> | null> => {
  if (tab?.id === undefined) return null;
  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func,
      args,
    });
    // SAFETY: Chrome resolves the injected callback and returns its value in
    // InjectionResult.result; the generic is tied to that callback above.
    return (results[0]?.result ?? null) as Awaited<Result> | null;
  } catch {
    return null;
  }
};
