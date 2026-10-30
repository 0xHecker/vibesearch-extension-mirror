import { LOCAL_LIBRARY_PATH, type LocalCommand } from "./local-companion-protocol";

export function isLocalCompanionSender(sender: Pick<chrome.runtime.MessageSender, "id" | "url">, command: LocalCommand, extensionId: string, extensionRoot: string): boolean {
  if (sender.id !== extensionId || !sender.url) return false;
  try {
    const url = new URL(sender.url);
    if (!url.href.startsWith(extensionRoot)) return false;
    if (command.action === "save-tab" || command.action === "save-screenshot") return url.pathname === "/src/pages/popup/index.html";
    return [`/${LOCAL_LIBRARY_PATH}`, "/src/pages/popup/index.html"].includes(url.pathname);
  } catch { return false; }
}
