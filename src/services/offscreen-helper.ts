export const OFFSCREEN_DOCUMENT_PATH = "src/pages/offscreen/offscreen.html";
export const FIREFOX_RUNTIME_FRAME_ID = "vibesearch-firefox-runtime";

let creating: Promise<void> | null = null;

const waitForFirefoxRuntimeFrame = async (
  frame: HTMLIFrameElement
): Promise<void> => {
  if (frame.contentDocument?.readyState === "complete") return;

  await new Promise<void>((resolve, reject) => {
    let settled = false;
    let timeout = 0;
    const cleanup = () => {
      frame.removeEventListener("load", onLoad);
      window.clearTimeout(timeout);
    };
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (error) reject(error);
      else resolve();
    };
    const onLoad = () => {
      finish();
    };
    timeout = window.setTimeout(() => {
      finish(new Error("Firefox local runtime frame did not initialize."));
    }, 15_000);
    frame.addEventListener("load", onLoad);

    // Close the small race between the ready-state check above and listener
    // registration: the frame may have completed while this promise was made.
    if (frame.contentDocument?.readyState === "complete") finish();
  });
};

export async function setupOffscreenDocument(): Promise<void> {
  // Firefox MV3 runs a DOM-backed event page. Its hidden child frame hosts the
  // same database/search runtime that Chrome keeps in an offscreen document.
  const firefoxRuntimeFrame =
    typeof document !== "undefined"
      ? document.getElementById(FIREFOX_RUNTIME_FRAME_ID)
      : null;
  if (
    typeof HTMLIFrameElement !== "undefined" &&
    firefoxRuntimeFrame instanceof HTMLIFrameElement
  ) {
    await waitForFirefoxRuntimeFrame(firefoxRuntimeFrame);
    return;
  }

  const getContexts = (chrome.runtime as any).getContexts;
  const offscreenApi = (chrome as any).offscreen;
  if (typeof getContexts !== "function" || !offscreenApi?.createDocument) {
    throw new Error("No local extension runtime host is available.");
  }

  const existingContexts = await getContexts({
    contextTypes: ["OFFSCREEN_DOCUMENT"],
    documentUrls: [chrome.runtime.getURL(OFFSCREEN_DOCUMENT_PATH)],
  });

  if (existingContexts.length > 0) {
    return;
  }

  if (creating) {
    await creating;
  } else {
    creating = offscreenApi.createDocument({
      url: OFFSCREEN_DOCUMENT_PATH,
      reasons: ["WORKERS"],
      justification: "Persistent OPFS access for vector processing",
    });
    try {
      await creating;
    } finally {
      creating = null;
    }
  }
}
