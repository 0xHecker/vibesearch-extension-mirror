// Chrome serializes this function for script injection. Keep its dependencies inside it.
export function captureLocalVisibleText() {
  const gaps = new Set<string>(["Only rendered text in the main page is captured. Unloaded content may be missing."]);
  const excludedTags = new Set(["SCRIPT", "STYLE", "NOSCRIPT", "TEMPLATE", "INPUT", "TEXTAREA", "SELECT", "OPTION"]);
  const chunks: string[] = [];
  let length = 0;
  let visited = 0;
  let stopped = false;
  const walker = document.createTreeWalker(document.body || document.documentElement, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      visited += 1;
      if (visited > 50000) { stopped = true; return NodeFilter.FILTER_REJECT; }
      if (node instanceof Element) {
        if (excludedTags.has(node.tagName) || node.hasAttribute("contenteditable") || node.closest("[contenteditable]")) return NodeFilter.FILTER_REJECT;
        const style = getComputedStyle(node);
        if (node.hasAttribute("hidden") || node.getAttribute("aria-hidden") === "true" || style.display === "none" || style.visibility === "hidden" || style.visibility === "collapse" || style.opacity === "0" || style.contentVisibility === "hidden") return NodeFilter.FILTER_REJECT;
        if (node.tagName === "IFRAME" || node.tagName === "FRAME") { gaps.add("Embedded frame content was not captured."); return NodeFilter.FILTER_REJECT; }
        if (node.shadowRoot) gaps.add("Shadow DOM content was not captured.");
      }
      return NodeFilter.FILTER_ACCEPT;
    },
  });
  while (!stopped) {
    const node = walker.nextNode();
    if (!node) break;
    if (node.nodeType !== Node.TEXT_NODE) continue;
    const parent = node.parentElement;
    if (!parent || parent.getClientRects().length === 0) continue;
    const value = (node.textContent || "").replace(/\s+/g, " ").trim();
    if (!value) continue;
    const remaining = 120000 - length - (chunks.length ? 1 : 0);
    if (value.length > remaining) {
      let end = Math.max(0, remaining);
      const last = value.charCodeAt(end - 1);
      if (last >= 0xd800 && last <= 0xdbff) end -= 1;
      if (end) chunks.push(value.slice(0, end));
      gaps.add("Text was shortened at the capture limit.");
      break;
    }
    chunks.push(value);
    length += value.length + (chunks.length > 1 ? 1 : 0);
  }
  if (stopped) gaps.add("Text was shortened at the page traversal limit.");
  if (!chunks.length) gaps.add("No rendered page text was available.");
  let titleEnd = Math.min(document.title.length, 2000);
  const last = document.title.charCodeAt(titleEnd - 1);
  if (last >= 0xd800 && last <= 0xdbff) titleEnd -= 1;
  return { url: location.href, title: document.title.slice(0, titleEnd), text: chunks.join("\n"), gaps: [...gaps] };
}
