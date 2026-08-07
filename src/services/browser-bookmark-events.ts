export type BrowserBookmarkEventHandlers = {
  onMutation: () => void;
  onImportBegan: () => void;
  onImportEnded: () => void;
};

export const registerBrowserBookmarkEvents = (
  handlers: BrowserBookmarkEventHandlers
): void => {
  chrome.bookmarks.onCreated.addListener(handlers.onMutation);
  chrome.bookmarks.onChanged.addListener(handlers.onMutation);
  chrome.bookmarks.onMoved.addListener(handlers.onMutation);
  chrome.bookmarks.onRemoved.addListener(handlers.onMutation);
  chrome.bookmarks.onChildrenReordered.addListener(handlers.onMutation);
  chrome.bookmarks.onImportBegan.addListener(handlers.onImportBegan);
  chrome.bookmarks.onImportEnded.addListener(handlers.onImportEnded);
};
