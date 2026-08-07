export type BrowserBookmarkEventHandlers = {
  onMutation: () => void;
  onImportBegan: () => void;
  onImportEnded: () => void;
};

// Firefox exposes the ordinary bookmark mutation events, but not Chrome's
// reorder/import lifecycle events. Each supported mutation still schedules a
// debounced source-of-truth tree scan, so imported/reordered data converges.
export const registerBrowserBookmarkEvents = (
  handlers: BrowserBookmarkEventHandlers
): void => {
  chrome.bookmarks.onCreated.addListener(handlers.onMutation);
  chrome.bookmarks.onChanged.addListener(handlers.onMutation);
  chrome.bookmarks.onMoved.addListener(handlers.onMutation);
  chrome.bookmarks.onRemoved.addListener(handlers.onMutation);
};
