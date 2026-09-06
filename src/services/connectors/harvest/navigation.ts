import { jsonFiniteNumber, jsonString } from "@src/common/json-value";
import { collectMediaFallback } from "./media";
import {
  directString,
  entries,
  isObj,
  pickId,
  pickText,
  walk,
  type Json,
  type Obj,
} from "./primitives";

function looksLikeEntry(node: Obj): boolean {
  if (!pickId(node)) return false;
  return pickText(node).length > 0 || collectMediaFallback(node).length > 0;
}

/** Find the response array with the most entry-like elements. */
export function findEntryList(root: Json): Obj[] {
  let best: Obj[] = [];
  let bestScore = -1;
  const seenArrays = new Set<Json>();

  const consider = (values: Json[]) => {
    const entries = values.filter(isObj).filter(looksLikeEntry);
    if (entries.length > bestScore) {
      bestScore = entries.length;
      best = entries;
    }
  };
  const scan = (node: Json) => {
    if (Array.isArray(node)) {
      if (!seenArrays.has(node)) {
        seenArrays.add(node);
        consider(node);
      }
      for (const child of node) scan(child);
      return;
    }
    if (isObj(node)) {
      for (const key of Object.keys(node)) scan(node[key]);
    }
  };

  scan(root);
  return best;
}

function namedEntryList(
  root: Json,
  names: ReadonlySet<string>,
  predicate: (entry: Obj) => boolean = looksLikeEntry,
): Obj[] {
  let best: Obj[] = [];
  for (const { node } of walk(root)) {
    for (const [key, value] of Object.entries(node)) {
      if (!names.has(key) || !Array.isArray(value)) continue;
      const candidates = value.filter(isObj).filter(predicate);
      if (candidates.length > best.length) best = candidates;
    }
  }
  return best;
}

function containsXPost(entry: Obj): boolean {
  const entryId = jsonString(entry.entryId);
  if (entryId && /^tweet-/iu.test(entryId)) return looksLikeEntry(entry);
  for (const { node } of walk(entry)) {
    if (
      (isObj(node.tweet_results) && isObj(node.tweet_results.result)) ||
      (isObj(node.tweetResult) && isObj(node.tweetResult.result))
    ) return true;
  }
  return false;
}

/** X GraphQL timeline entries only; nested media and mentions never compete. */
export function findXEntryList(root: Json): Obj[] {
  const timelineEntries: Obj[] = [];
  for (const { node } of walk(root)) {
    if (!Array.isArray(node.instructions)) continue;
    for (const instruction of node.instructions) {
      if (!isObj(instruction) || !Array.isArray(instruction.entries)) continue;
      timelineEntries.push(...instruction.entries.filter(isObj).filter(containsXPost));
    }
  }
  if (timelineEntries.length) return Array.from(new Set(timelineEntries));
  const timeline = namedEntryList(root, new Set(["entries"]), containsXPost);
  if (timeline.length) return timeline;
  const flat = namedEntryList(root, new Set(["items", "tweets"]));
  return flat.length ? flat : findEntryList(root);
}

/** Reddit listing children only; each child is a post or comment wrapper. */
export function findRedditEntryList(root: Json): Obj[] {
  if (isObj(root) && isObj(root.data) && Array.isArray(root.data.children)) {
    return root.data.children.filter(isObj).filter(looksLikeEntry);
  }
  const children = namedEntryList(root, new Set(["children"]));
  return children.length ? children : findEntryList(root);
}

/** Instagram feed items only; carousel media remains attached to its post. */
export function findInstagramEntryList(root: Json): Obj[] {
  if (isObj(root) && Array.isArray(root.items)) {
    return root.items.filter(isObj).filter((entry) => !!pickId(entry));
  }
  if (isObj(root) && isObj(root.data) && Array.isArray(root.data.items)) {
    return root.data.items.filter(isObj).filter((entry) => !!pickId(entry));
  }
  const items = namedEntryList(root, new Set(["items"]));
  return items.length ? items : findEntryList(root);
}

function findXBottomCursor(root: Json): string | undefined {
  for (const { node } of walk(root)) {
    const cursorType = jsonString(node.cursorType);
    const type = cursorType ?? jsonString(node.entryType);
    const value = jsonString(node.value);
    if ((type === "Bottom" || cursorType === "Bottom") && value !== undefined) return value;
  }
  return undefined;
}

export function findXCursor(root: Json): string | undefined {
  return findXBottomCursor(root) ?? findCursor(root);
}

/** Reddit uses the outer listing cursor, never a nested comment-replies cursor. */
export function findRedditCursor(root: Json): string | undefined {
  if (isObj(root) && isObj(root.data) && Object.hasOwn(root.data, "after")) {
    const after = jsonString(root.data.after);
    return after?.trim() || undefined;
  }
  return findCursor(root);
}

/** `more_available:false` is terminal even if Instagram returns a stale id. */
export function findInstagramCursor(root: Json): string | undefined {
  let page: Obj | undefined;
  if (isObj(root)) page = isObj(root.data) ? root.data : root;
  if (page) {
    const hasKnownPagination = Object.hasOwn(page, "more_available") ||
      Object.hasOwn(page, "moreAvailable") ||
      Object.hasOwn(page, "next_max_id") ||
      Object.hasOwn(page, "nextMaxId");
    if (hasKnownPagination) {
      if (page.more_available === false || page.moreAvailable === false) return undefined;
      const cursor = directString(page, ["next_max_id", "nextMaxId"]);
      return cursor?.trim() || undefined;
    }
  }
  return findCursor(root);
}

/** Generic bounded fallback for a provider response without a known cursor field. */
export function findCursor(root: Json): string | undefined {
  const xBottom = findXBottomCursor(root);
  if (xBottom) return xBottom;
  const cursorKey = /(next_max_id|^max_id$|^after$|next_cursor|min_id|end_cursor|paging_token)/i;
  for (const [key, value] of entries(root)) {
    if (!cursorKey.test(key)) continue;
    const text = jsonString(value);
    if (text?.trim()) return text;
    const number = jsonFiniteNumber(value);
    if (number !== undefined) return String(number);
  }
  return undefined;
}
