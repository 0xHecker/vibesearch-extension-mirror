/** Only the extension service worker may forward privileged offscreen commands. */
export function isTrustedForwarderSender(
  sender: chrome.runtime.MessageSender,
): boolean {
  if (sender.id !== chrome.runtime.id || sender.tab) return false;

  const senderUrl = sender.url ?? "";
  if (!senderUrl) return true;

  try {
    const path = new URL(senderUrl).pathname;
    if (path.includes("/src/pages/")) return false;
    return (
      !path.endsWith(".html") ||
      path.endsWith("/_generated_background_page.html")
    );
  } catch {
    return false;
  }
}
