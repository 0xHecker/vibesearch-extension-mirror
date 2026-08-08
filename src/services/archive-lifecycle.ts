const ARCHIVE_PURGE_MESSAGE_BATCH = 2_000;

/**
 * Tell the background owner to cancel captures and remove both queued and
 * cached HTML after the corresponding RxDB rows are durably gone.
 * A later startup reconciliation remains the fallback if the worker cannot be
 * reached, so cleanup never turns a committed database deletion into an error.
 */
export const notifyArchivedItemsPurged = async (itemIdsRaw: Iterable<string>): Promise<void> => {
  const itemIds = Array.from(
    new Set(Array.from(itemIdsRaw, (itemId) => itemId.trim()).filter(Boolean)),
  );
  for (let offset = 0; offset < itemIds.length; offset += ARCHIVE_PURGE_MESSAGE_BATCH) {
    try {
      const response = await chrome.runtime.sendMessage({
        target: "background",
        type: "ARCHIVE_ITEMS_PURGED",
        payload: { itemIds: itemIds.slice(offset, offset + ARCHIVE_PURGE_MESSAGE_BATCH) },
      });
      if (!response?.success) {
        console.warn("[archive-lifecycle] background cleanup was deferred", response?.error);
      }
    } catch (error) {
      console.warn("[archive-lifecycle] background cleanup was deferred", error);
    }
  }
};
