type ItemElementLike = {
  getAttribute(name: string): string | null;
};

type ItemElementRoot<Element extends ItemElementLike> = {
  querySelectorAll(selector: string): ArrayLike<Element>;
};

/** Find a rendered item without interpolating a persisted ID into a CSS selector. */
export const findItemElementByDataId = <Element extends ItemElementLike>(
  root: ItemElementRoot<Element>,
  itemId: string
): Element | null => {
  const itemElements = root.querySelectorAll("[data-item-id]");
  for (let index = 0; index < itemElements.length; index += 1) {
    const element = itemElements[index];
    if (element.getAttribute("data-item-id") === itemId) return element;
  }
  return null;
};

/** Resolve the live record at click time; an empty lookup means it was removed
 * or moved into Bin and must not be revealed using stale search-result data. */
export const revalidateRevealItem = async <Item extends { id: string }>(
  staleItem: Item,
  loadCurrentItems: (itemId: string) => Promise<readonly Item[]>
): Promise<Item | null> => {
  const currentItems = await loadCurrentItems(staleItem.id);
  return currentItems.find((item) => item.id === staleItem.id) || null;
};
