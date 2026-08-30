#!/usr/bin/env node

const endpoint = process.env.BRAVE_CDP_ENDPOINT || "http://127.0.0.1:9224";
const liveCaptureUrl = process.env.BRAVE_ARCHIVE_SANITIZER_CAPTURE_URL || "";

const connect = async (target) => {
  const socket = new WebSocket(target.webSocketDebuggerUrl);
  const pending = new Map();
  const listeners = new Set();
  let sequence = 0;
  socket.addEventListener("message", (event) => {
    const message = JSON.parse(String(event.data));
    if (message.id) {
      const request = pending.get(message.id);
      if (!request) return;
      pending.delete(message.id);
      if (message.error) request.reject(new Error(message.error.message));
      else request.resolve(message.result);
      return;
    }
    for (const listener of listeners) listener(message);
  });
  await new Promise((resolve, reject) => {
    socket.addEventListener("open", resolve, { once: true });
    socket.addEventListener("error", reject, { once: true });
  });
  return {
    onEvent(listener) { listeners.add(listener); },
    send(method, params = {}) {
      return new Promise((resolve, reject) => {
        const id = ++sequence;
        pending.set(id, { resolve, reject });
        socket.send(JSON.stringify({ id, method, params }));
      });
    },
    close() { socket.close(); },
  };
};

const initialTargets = await fetch(`${endpoint}/json/list`).then((response) => response.json());
const extensionTarget = initialTargets.find((target) =>
  (target.type === "service_worker" || target.type === "background_page") &&
  target.url.startsWith("chrome-extension://")
) || initialTargets.find((target) => target.url.includes("/src/pages/offscreen/offscreen.html"));
if (!extensionTarget) throw new Error("No loaded Vibesearch extension target found.");

const extensionId = new URL(extensionTarget.url).hostname;
const searchUrl = `chrome-extension://${extensionId}/src/pages/search/index.html`;
const searchTarget = await fetch(
  `${endpoint}/json/new?${encodeURIComponent(searchUrl)}`,
  { method: "PUT" },
).then((response) => response.json());
const search = await connect(searchTarget);
const violations = [];
const networkLoads = [];
search.onEvent((message) => {
  if (message.method === "Log.entryAdded") {
    const entry = message.params?.entry;
    if (entry?.level === "error" && /Content Security Policy|Blocked script execution/i.test(entry.text)) {
      violations.push(entry.text);
    }
  }
  if (message.method === "Network.requestWillBeSent") {
    const url = message.params?.request?.url || "";
    if (/fonts\.googleapis\.com|cdn\.example|tracker\.example/i.test(url)) networkLoads.push(url);
  }
});

try {
  await search.send("Page.enable");
  await search.send("Runtime.enable");
  await search.send("Log.enable");
  await search.send("Network.enable");
  await new Promise((resolve) => setTimeout(resolve, 4_000));

  const restored = await search.send("Runtime.evaluate", {
    expression: `(async () => {
      const now = Date.now();
      const itemId = "brave-archive-sanitizer-item";
      const html = '<!doctype html><html><head>' +
        '<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Lato">' +
        '<style>@import url("https://fonts.googleapis.com/css2?family=Joan");' +
        '.remote{background:url(https://cdn.example/hero.png)}' +
        '.embedded{background:url(data:image/png;base64,AA==)}</style>' +
        '</head><body style="overflow:hidden" onload="fetch(\\'https://tracker.example\\')">' +
        '<div id="__vibesearch_picker_root__">Saved - move to...?</div>' +
        '<script>globalThis.archiveScriptRan=true</script>' +
        '<img id="remote" src="https://cdn.example/photo.png">' +
        '<img id="embedded" src="data:image/png;base64,AA==">' +
        '<a id="source" href="https://example.com/original">Original</a>' +
        '<main style="min-height:300vh">Sanitized archive fixture</main>' +
        '</body></html>';
      const emptyCollections = {
        space_groups: [], spaces: [], folders: [], items: [], tags: [],
        item_tags: [], search_history: [], flashcards: [], deleted_items: [],
      };
      const bundle = {
        format: "vibesearch-local-extension-migration",
        version: 2,
        createdAt: now,
        collections: {
          ...emptyCollections,
          folders: [{
            id: "archive-sanitizer-group", userId: "", name: "Archive audit",
            spaceId: "space_public_default", parentId: null, type: "tab_group",
            sortOrder: 0, isLocked: false, isPinned: false, isCollapsed: false,
            deletedAt: 0, purgeAt: 0, isDirty: false, serverVersion: 0,
            createdAt: now, updatedAt: now,
          }],
          items: [{
            id: itemId, userId: "", title: "Archive sanitizer fixture",
            textContent: "Sanitized archive fixture", ocrStatus: "skipped",
            ocrModelVersion: "", ocrUpdatedAt: 0,
            url: "https://example.com/original", source: "web", folderId: "archive-sanitizer-group",
            spaceId: "space_public_default", isFavorite: false, parentId: null,
            vector_index: -1, vector_indexes: [], isEmbedded: false,
            isMetaFetched: true, isDirty: false, serverVersion: 0,
            createdAt: now, updatedAt: now, deletedAt: 0,
          }],
        },
        opfsFiles: [],
        archiveFiles: [{
          itemId, mimeType: "text/html", updatedAt: now,
          base64: btoa(html),
        }],
        warnings: [],
      };
      const root = await navigator.storage.getDirectory();
      const staging = await root.getDirectoryHandle("large-payload-staging-v1", { create: true });
      const fileName = "archive-sanitizer-audit.json";
      const handle = await staging.getFileHandle(fileName, { create: true });
      const writable = await handle.createWritable();
      await writable.write(new Blob([JSON.stringify(bundle)], { type: "application/json" }));
      await writable.close();
      const staged = await chrome.runtime.sendMessage({
        target: "background", type: "LOCAL_BACKUP_STAGE_FILE", payload: { fileName },
      });
      if (!staged?.success) return staged;
      return chrome.runtime.sendMessage({
        target: "background", type: "LOCAL_BACKUP_RESTORE_STAGED",
        payload: { stageId: staged.payload?.stageId },
      });
    })()`,
    awaitPromise: true,
    returnByValue: true,
  });
  if (restored.result?.value?.success !== true) {
    throw new Error(`Fixture restore failed: ${JSON.stringify(restored)}`);
  }

  let captureValue = null;
  if (liveCaptureUrl) {
    const capture = await search.send("Runtime.evaluate", {
      expression: `(async () => {
        const startedAt = performance.now();
        const result = await chrome.runtime.sendMessage({
          target: "background",
          type: "ARCHIVE_CAPTURE_NOW",
          payload: {
            itemId: "brave-archive-sanitizer-item",
            url: ${JSON.stringify(liveCaptureUrl)},
          },
        });
        return { result, elapsedMs: Math.round(performance.now() - startedAt) };
      })()`,
      awaitPromise: true,
      returnByValue: true,
    });
    captureValue = capture.result?.value;
    if (captureValue?.result?.success !== true || captureValue.result?.payload?.captured !== true) {
      throw new Error(`Live browser capture failed: ${JSON.stringify(captureValue)}`);
    }
  }

  await search.send("Page.reload", { ignoreCache: true });
  let opened;
  const previewStartedAt = Date.now();
  for (let attempt = 0; attempt < 20; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 1_000));
    opened = await search.send("Runtime.evaluate", {
    expression: `(() => {
      const button = document.querySelector('button[aria-label="View archived copy"]');
      if (!button) return {
        clicked: false,
        text: document.body?.innerText?.slice(0, 500),
        labels: [...document.querySelectorAll("button")]
          .map((candidate) => candidate.getAttribute("aria-label") || candidate.textContent?.trim())
          .filter(Boolean).slice(0, 50),
      };
      button.click();
      return { clicked: true };
    })()`,
    returnByValue: true,
    });
    if (opened.result?.value?.clicked === true) break;
  }
  if (opened?.result?.value?.clicked !== true) {
    throw new Error(`Eye icon was not rendered: ${JSON.stringify(opened.result?.value)}`);
  }
  const findArchiveFrame = (node) => {
    if (node?.frame?.url?.startsWith("blob:")) return node.frame;
    for (const child of node?.childFrames || []) {
      const match = findArchiveFrame(child);
      if (match) return match;
    }
    return null;
  };
  let archiveFrame = null;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const frameTree = await search.send("Page.getFrameTree");
    archiveFrame = findArchiveFrame(frameTree.frameTree);
    if (archiveFrame) break;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  const previewOpenMs = Date.now() - previewStartedAt;
  if (!archiveFrame) throw new Error("The eye icon did not open an archive iframe.");
  await new Promise((resolve) => setTimeout(resolve, 500));
  const world = await search.send("Page.createIsolatedWorld", {
    frameId: archiveFrame.id,
    worldName: "vibesearch-archive-sanitizer-audit",
  });
  const frameRect = await search.send("Runtime.evaluate", {
    expression: `(() => {
      const rect = document.querySelector('iframe[title^="Archived copy of"]')?.getBoundingClientRect();
      return rect ? { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 } : null;
    })()`,
    returnByValue: true,
  });
  if (frameRect.result?.value) {
    await search.send("Input.dispatchMouseEvent", {
      type: "mouseWheel",
      x: frameRect.result.value.x,
      y: frameRect.result.value.y,
      deltaX: 0,
      deltaY: 700,
    });
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
  const inspection = await search.send("Runtime.evaluate", {
    contextId: world.executionContextId,
    expression: `({
      scriptCount: document.scripts.length,
      linkCount: document.querySelectorAll("link").length,
      eventAttributeCount: document.querySelectorAll("[onload],[onclick],[onerror]").length,
      extensionOverlayCount: document.querySelectorAll('[id^="__vibesearch_"]').length,
      remoteImage: document.getElementById("remote")?.getAttribute("src") || null,
      embeddedImage: document.getElementById("embedded")?.getAttribute("src") || null,
      sourceLink: document.getElementById("source")?.getAttribute("href") || null,
      sourceLinkPointerEvents: document.getElementById("source")
        ? getComputedStyle(document.getElementById("source")).pointerEvents
        : null,
      sourceLinkTabIndex: document.getElementById("source")?.tabIndex ?? null,
      scriptRan: globalThis.archiveScriptRan === true,
      resourceUrls: performance.getEntriesByType("resource").map((entry) => entry.name),
      inert: document.documentElement.hasAttribute("inert"),
      bodyText: (document.body?.innerText || "").slice(0, 20000),
      scrollY: window.scrollY,
    })`,
    returnByValue: true,
  });
  const value = inspection.result?.value || {};
  const expectedContent = liveCaptureUrl
    ? /speedy-gonzales|refactor language preference|github/i.test(value.bodyText || "")
    : value.embeddedImage?.startsWith("data:image/png") &&
      value.sourceLink === "https://example.com/original" &&
      value.bodyText.includes("Sanitized archive fixture");
  const ok = value.scriptCount === 0 && value.linkCount === 0 &&
    value.eventAttributeCount === 0 && value.extensionOverlayCount === 0 &&
    value.remoteImage === null && value.scrollY > 0 &&
    value.scriptRan === false && value.inert === false &&
    (!value.sourceLink || (value.sourceLinkPointerEvents === "none" && value.sourceLinkTabIndex === -1)) &&
    expectedContent &&
    !(value.resourceUrls || []).some((url) => /fonts\.googleapis\.com|cdn\.example|tracker\.example/i.test(url)) &&
    networkLoads.length === 0 && violations.length === 0;
  if (!ok) {
    console.error("FAIL", JSON.stringify({ ...value, captureValue, previewOpenMs, networkLoads, violations }, null, 2));
    process.exitCode = 1;
  } else {
    const captureSummary = captureValue
      ? ` after a ${captureValue.elapsedMs}ms browser-session capture of the live GitHub page`
      : "";
    console.log(`PASS eye-icon preview opened in ${previewOpenMs}ms${captureSummary}, removed active/network markup, retained safe content, and emitted no CSP or sandbox violations.`);
  }

  if (liveCaptureUrl) {
    await search.send("Runtime.evaluate", {
      expression: `(async () => {
        const storage = await chrome.storage.local.get([
          "vibesearch:archiveDeviceKey", "vibesearch:apiBaseUrl",
        ]);
        const apiBase = String(storage["vibesearch:apiBaseUrl"] ||
          "https://vibesearch-api.watermelons.workers.dev").replace(/\\/+$/, "");
        return fetch(apiBase + "/v1/items/brave-archive-sanitizer-item/archive", {
          method: "DELETE",
          headers: { "x-vs-device-key": storage["vibesearch:archiveDeviceKey"] },
        }).then((response) => response.status);
      })()`,
      awaitPromise: true,
      returnByValue: true,
    });
  }
} finally {
  search.close();
  await fetch(`${endpoint}/json/close/${searchTarget.id}`).catch(() => undefined);
}
