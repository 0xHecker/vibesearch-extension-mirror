const SEARCH_PAGE_PATH = "/src/pages/search/index.html";

export const isSearchPageSender = (
  sender: chrome.runtime.MessageSender,
): boolean => {
  const senderUrl = sender.url ?? "";
  if (!senderUrl) return false;
  try {
    return new URL(senderUrl).pathname.endsWith(SEARCH_PAGE_PATH);
  } catch {
    return false;
  }
};

export const isTrustedExtensionSender = (
  sender: chrome.runtime.MessageSender,
): boolean => {
  if (sender.id !== chrome.runtime.id) return false;
  const senderUrl = sender.url ?? "";
  if (!senderUrl) return true;
  try {
    return new URL(senderUrl).href.startsWith(chrome.runtime.getURL(""));
  } catch {
    return false;
  }
};
