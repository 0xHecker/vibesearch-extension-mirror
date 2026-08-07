import {
  FIREFOX_RUNTIME_FRAME_ID,
  OFFSCREEN_DOCUMENT_PATH,
} from "@src/services/offscreen-helper";

// Firefox MV3 background scripts execute in a DOM-backed event page. Create a
// separate frame for the database/search runtime so runtime.sendMessage keeps
// the same trusted parent <-> runtime boundary used by Chrome's offscreen page.
let runtimeFrame = document.getElementById(
  FIREFOX_RUNTIME_FRAME_ID
) as HTMLIFrameElement | null;

if (!runtimeFrame) {
  runtimeFrame = document.createElement("iframe");
  runtimeFrame.id = FIREFOX_RUNTIME_FRAME_ID;
  runtimeFrame.src = chrome.runtime.getURL(OFFSCREEN_DOCUMENT_PATH);
  runtimeFrame.title = "Vibesearch local data runtime";
  runtimeFrame.hidden = true;
  runtimeFrame.setAttribute("aria-hidden", "true");
  (document.body || document.documentElement).appendChild(runtimeFrame);
}
