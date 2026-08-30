#!/usr/bin/env node

const endpoint = process.env.BRAVE_CDP_ENDPOINT || "http://127.0.0.1:9224";
const extensionDirectory = process.env.BRAVE_EXTENSION_DIR ||
  new URL("../dist_chrome/", import.meta.url).pathname;
const manifest = await Bun.file(`${extensionDirectory.replace(/\/$/, "")}/manifest.json`).json();

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
    onEvent(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    send(method, params = {}) {
      return new Promise((resolve, reject) => {
        const id = ++sequence;
        pending.set(id, { resolve, reject });
        socket.send(JSON.stringify({ id, method, params }));
      });
    },
    close() {
      socket.close();
    },
  };
};

const initialTargets = await fetch(`${endpoint}/json/list`).then((response) => response.json());
let serviceWorker = initialTargets.find((target) =>
  target.type === "service_worker" && target.url.startsWith("chrome-extension://")
);
let offscreen = initialTargets.find((target) =>
  target.url.includes("/src/pages/offscreen/offscreen.html")
);
const extensionTarget = serviceWorker || offscreen;
if (!extensionTarget?.url) {
  throw new Error("No loaded production extension target was found.");
}

const extensionId = new URL(extensionTarget.url).hostname;
const searchUrl = `chrome-extension://${extensionId}/src/pages/search/index.html`;
const searchTarget = await fetch(
  `${endpoint}/json/new?${encodeURIComponent(searchUrl)}`,
  { method: "PUT" },
).then((response) => response.json());
if (!searchTarget?.webSocketDebuggerUrl) throw new Error("Could not open the production Search page.");

const failures = [];
const search = await connect(searchTarget);
search.onEvent((message) => {
  if (message.method === "Runtime.exceptionThrown") {
    failures.push(`Search exception: ${message.params?.exceptionDetails?.text || "unknown"}`);
  }
  if (message.method === "Log.entryAdded" && message.params?.entry?.level === "error") {
    failures.push(`Search log: ${message.params.entry.text}`);
  }
  if (
    message.method === "Runtime.consoleAPICalled" &&
    (message.params?.type === "error" || message.params?.type === "assert")
  ) {
    const text = (message.params.args || []).map((arg) => arg.value || arg.description || "").join(" ");
    failures.push(`Search console: ${text}`);
  }
});
await search.send("Page.enable");
await search.send("Runtime.enable");
await search.send("Log.enable");
await search.send("Page.reload", { ignoreCache: true });
await new Promise((resolve) => setTimeout(resolve, 4_000));
const searchState = await search.send("Runtime.evaluate", {
  expression: `(async () => ({
    readyState: document.readyState,
    title: document.title,
    bodyText: (document.body?.innerText || "").slice(0, 500),
    runtimeId: chrome.runtime.id,
    hasOpfs: typeof navigator.storage?.getDirectory === "function",
    persisted: await navigator.storage.persisted(),
  }))()`,
  awaitPromise: true,
  returnByValue: true,
});
const state = searchState.result?.value || {};
if (state.readyState !== "complete") failures.push(`Search readyState is ${state.readyState || "missing"}.`);
if (state.runtimeId !== extensionId) failures.push("Search page has the wrong extension identity.");
if (!state.hasOpfs) failures.push("OPFS is unavailable in the Search page.");
if (!state.bodyText.trim()) failures.push("Search page rendered no readable UI.");

const archiveFixtureEnabled = process.env.BRAVE_AUDIT_ARCHIVE_FIXTURE === "1";
if (archiveFixtureEnabled) {
  const fixtureRestore = await search.send("Runtime.evaluate", {
    expression: `(async () => {
      const now = Date.now();
      const itemId = "brave-audit-archive-item";
      const pendingItemId = "brave-audit-pending-archive-item";
      const html = "<!doctype html><html><body>Brave archive backup fixture</body></html>";
      const pendingHtml = "<!doctype html><html><body>Brave pending outbox fixture</body></html>";
      const createItem = (id, title, url) => ({
        id,
        userId: "",
        title,
        textContent: "Browser-tested local archive backup",
        ocrStatus: "skipped",
        ocrModelVersion: "",
        ocrUpdatedAt: 0,
        url,
        source: "web",
        folderId: "",
        spaceId: "space_public_default",
        isFavorite: false,
        parentId: null,
        vector_index: -1,
        vector_indexes: [],
        isEmbedded: false,
        isMetaFetched: true,
        isDirty: false,
        serverVersion: 0,
        createdAt: now,
        updatedAt: now,
        deletedAt: 0,
      });
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
          items: [
            createItem(itemId, "Brave archive backup fixture", "https://example.com/brave-archive-fixture"),
            createItem(pendingItemId, "Brave pending archive fixture", "https://example.com/brave-pending-fixture"),
          ],
        },
        opfsFiles: [],
        archiveFiles: [{
          itemId,
          mimeType: "text/html",
          updatedAt: now,
          base64: btoa(html),
        }],
        warnings: [],
      };
      const root = await navigator.storage.getDirectory();
      const staging = await root.getDirectoryHandle("large-payload-staging-v1", { create: true });
      const fileName = "local-import-brave-audit-fixture.json";
      const handle = await staging.getFileHandle(fileName, { create: true });
      const writable = await handle.createWritable();
      await writable.write(new Blob([JSON.stringify(bundle)], { type: "application/json" }));
      await writable.close();
      const staged = await chrome.runtime.sendMessage({
        target: "background",
        type: "LOCAL_BACKUP_STAGE_FILE",
        payload: { fileName },
      });
      if (!staged?.success) return { error: staged?.error || "fixture staging failed" };
      const restored = await chrome.runtime.sendMessage({
        target: "background",
        type: "LOCAL_BACKUP_RESTORE_STAGED",
        payload: { stageId: staged.payload?.stageId },
      });
      if (!restored?.success) return { restored, itemId, html };

      const outbox = await root.getDirectoryHandle("archive-outbox-v1", { create: true });
      const outboxFileName = "brave-audit-pending.html";
      const outboxHandle = await outbox.getFileHandle(outboxFileName, { create: true });
      const outboxWritable = await outboxHandle.createWritable();
      await outboxWritable.write(new Blob([pendingHtml], { type: "text/html" }));
      await outboxWritable.close();
      await chrome.storage.local.set({
        "vibesearch:archiveOutbox:v1": [{
          id: "brave-audit-pending-job",
          itemId: pendingItemId,
          mode: "upload",
          sourceUrl: "https://example.com/brave-pending-fixture",
          fileName: outboxFileName,
          byteSize: new Blob([pendingHtml]).size,
          createdAt: now,
          updatedAt: now + 1,
          attempts: 0,
          nextAttemptAt: now + 60_000,
        }],
      });
      return { restored, itemId, html, pendingItemId, pendingHtml };
    })()`,
    awaitPromise: true,
    returnByValue: true,
  });
  const fixtureValue = fixtureRestore.result?.value || {};
  if (!fixtureValue.restored?.success || fixtureValue.restored?.payload?.restoredArchiveFileCount !== 1) {
    failures.push(`Archive fixture restore failed: ${fixtureValue.restored?.error || fixtureValue.error || "unknown"}`);
  }
}

const backupRoundTrip = await search.send("Runtime.evaluate", {
  expression: `(async () => {
    const exported = await chrome.runtime.sendMessage({
      target: "background",
      type: "LOCAL_BACKUP_BUILD_DOWNLOAD",
    });
    if (!exported?.success) return { error: exported?.error || "export failed" };
    const fileName = exported.payload?.fileName || "";
    const root = await navigator.storage.getDirectory();
    const staging = await root.getDirectoryHandle("large-payload-staging-v1");
    const file = await (await staging.getFileHandle(fileName)).getFile();
    const bundle = JSON.parse(await file.text());
    const staged = await chrome.runtime.sendMessage({
      target: "background",
      type: "LOCAL_BACKUP_STAGE_FILE",
      payload: { fileName },
    });
    let stagedFileRemoved = false;
    try {
      await staging.getFileHandle(fileName);
    } catch (error) {
      stagedFileRemoved = error instanceof DOMException && error.name === "NotFoundError";
    }
    if (!staged?.success) return { error: staged?.error || "staging failed", stagedFileRemoved };
    const restored = await chrome.runtime.sendMessage({
      target: "background",
      type: "LOCAL_BACKUP_RESTORE_STAGED",
      payload: { stageId: staged.payload?.stageId },
    });
    return {
      exported: exported.payload,
      bundle: {
        format: bundle.format,
        version: bundle.version,
        collections: Object.fromEntries(
          Object.entries(bundle.collections || {}).map(([name, rows]) => [name, rows.length]),
        ),
        opfsFileCount: bundle.opfsFiles?.length,
        archiveFileCount: bundle.archiveFiles?.length,
        archiveFixtureHtml: atob(
          bundle.archiveFiles?.find((entry) => entry.itemId === "brave-audit-archive-item")?.base64 || "",
        ),
        pendingArchiveFixtureHtml: atob(
          bundle.archiveFiles?.find((entry) => entry.itemId === "brave-audit-pending-archive-item")?.base64 || "",
        ),
      },
      staged: staged.payload,
      stagedFileRemoved,
      restored,
    };
  })()`,
  awaitPromise: true,
  returnByValue: true,
});
const backupValue = backupRoundTrip.result?.value || {};
if (backupValue.error) failures.push(`Local backup round trip: ${backupValue.error}`);
if (backupValue.bundle?.format !== "vibesearch-local-extension-migration") {
  failures.push("Local backup has the wrong format marker.");
}
if (backupValue.bundle?.version !== 2) failures.push("Local backup is not migration version 2.");
if (Object.keys(backupValue.bundle?.collections || {}).length !== 9) {
  failures.push("Local backup does not contain all nine collections.");
}
if (
  archiveFixtureEnabled &&
  backupValue.bundle?.archiveFixtureHtml !==
    "<!doctype html><html><body>Brave archive backup fixture</body></html>"
) {
  failures.push("Local backup did not preserve the browser-restored archive bytes.");
}
if (
  archiveFixtureEnabled &&
  backupValue.bundle?.pendingArchiveFixtureHtml !==
    "<!doctype html><html><body>Brave pending outbox fixture</body></html>"
) {
  failures.push("Local backup did not preserve the authoritative pending outbox bytes.");
}
if (!backupValue.stagedFileRemoved) failures.push("Restore staging did not remove its OPFS handoff file.");
if (!backupValue.restored?.success) {
  failures.push(`Local backup restore failed: ${backupValue.restored?.error || "unknown"}`);
}
if (
  backupValue.restored?.payload?.collections?.items !==
  backupValue.exported?.summary?.collections?.items
) {
  failures.push("Local backup restore item count differs from its export summary.");
}

let resetValue = null;
if (process.env.BRAVE_AUDIT_DELETE_ALL === "1") {
  const resetRoundTrip = await search.send("Runtime.evaluate", {
    expression: `(async () => {
      const deleted = await chrome.runtime.sendMessage({
        target: "background",
        type: "DELETE_ALL_LOCAL_DATA",
      });
      const storage = await chrome.storage.local.get([
        "vibesearch:localDataResetInProgress:v1",
        "vibesearch:archiveCache:v1",
        "vibesearch:archiveOutbox:v1",
      ]);
      const root = await navigator.storage.getDirectory();
      const rootEntries = [];
      const rootEntryChildren = {};
      for await (const [name, handle] of root.entries()) {
        rootEntries.push(name);
        if (handle.kind !== "directory") continue;
        let count = 0;
        for await (const _entry of handle.entries()) count += 1;
        rootEntryChildren[name] = count;
      }
      const exported = await chrome.runtime.sendMessage({
        target: "background",
        type: "LOCAL_BACKUP_BUILD_DOWNLOAD",
      });
      let bundle = null;
      if (exported?.success) {
        const staging = await root.getDirectoryHandle("large-payload-staging-v1");
        const fileName = exported.payload?.fileName || "";
        const file = await (await staging.getFileHandle(fileName)).getFile();
        bundle = JSON.parse(await file.text());
        await staging.removeEntry(fileName);
      }
      return {
        deleted,
        storage,
        rootEntries,
        rootEntryChildren,
        exported: exported?.success,
        collections: Object.fromEntries(
          Object.entries(bundle?.collections || {}).map(([name, rows]) => [name, rows.length]),
        ),
        opfsFileCount: bundle?.opfsFiles?.length,
        archiveFileCount: bundle?.archiveFiles?.length,
      };
    })()`,
    awaitPromise: true,
    returnByValue: true,
  });
  resetValue = resetRoundTrip.result?.value || {};
  if (!resetValue.deleted?.success || resetValue.deleted?.payload?.deletedCollections !== 9) {
    failures.push(`Delete-all failed: ${resetValue.deleted?.error || "unknown"}`);
  }
  const retainedStorage = { ...(resetValue.storage || {}) };
  if (Array.isArray(retainedStorage["vibesearch:archiveOutbox:v1"]) &&
      retainedStorage["vibesearch:archiveOutbox:v1"].length === 0) {
    delete retainedStorage["vibesearch:archiveOutbox:v1"];
  }
  if (Object.keys(retainedStorage).length !== 0) {
    failures.push(
      `Delete-all retained a reset marker or archive metadata: ${JSON.stringify(retainedStorage)}.`,
    );
  }
  const forbiddenDirectories = new Set([
    "media",
    "archive-cache-v1",
    "large-payload-staging-v1",
  ]);
  if ((resetValue.rootEntries || []).some((name) => forbiddenDirectories.has(name))) {
    failures.push(
      `Delete-all retained a media, archive, or staging OPFS directory: ` +
      `${JSON.stringify(resetValue.rootEntries)}.`,
    );
  }
  if ((resetValue.rootEntryChildren?.["archive-outbox-v1"] || 0) !== 0) {
    failures.push("Delete-all retained an archive outbox payload.");
  }
  if (!resetValue.exported || Object.keys(resetValue.collections || {}).length !== 9) {
    failures.push("Delete-all verification backup was not a complete v2 export.");
  }
  if (Object.values(resetValue.collections || {}).some((count) => count !== 0)) {
    failures.push(
      `Delete-all left rows in a local collection: ${JSON.stringify(resetValue.collections)}.`,
    );
  }
  if (resetValue.opfsFileCount !== 0 || resetValue.archiveFileCount !== 0) {
    failures.push("Delete-all verification backup retained binary payloads.");
  }
}

const activeTargets = await fetch(`${endpoint}/json/list`).then((response) => response.json());
serviceWorker = activeTargets.find((target) =>
  target.type === "service_worker" && target.url.startsWith(`chrome-extension://${extensionId}/`)
);
offscreen = activeTargets.find((target) =>
  target.url.startsWith(`chrome-extension://${extensionId}/`) &&
  target.url.includes("/src/pages/offscreen/offscreen.html")
);
if (!serviceWorker?.webSocketDebuggerUrl) {
  throw new Error("The production service worker did not wake for the backup round trip.");
}
if (!offscreen?.webSocketDebuggerUrl) {
  throw new Error("The production offscreen document did not load for the backup round trip.");
}

const worker = await connect(serviceWorker);
await worker.send("Runtime.enable");
const workerState = await worker.send("Runtime.evaluate", {
  expression: `({
    runtimeId: chrome.runtime.id,
    name: chrome.runtime.getManifest().name,
    version: chrome.runtime.getManifest().version,
    hasOpfs: typeof navigator.storage?.getDirectory === "function",
  })`,
  returnByValue: true,
});
const workerValue = workerState.result?.value || {};
if (workerValue.runtimeId !== extensionId) failures.push("Service worker has the wrong extension identity.");
if (workerValue.name !== "Vibesearch") failures.push(`Production manifest name is ${workerValue.name}.`);
if (workerValue.version !== manifest.version) failures.push("Service worker and built manifest versions differ.");
if (!workerValue.hasOpfs) failures.push("OPFS is unavailable in the service worker.");

const offscreenClient = await connect(offscreen);
await offscreenClient.send("Runtime.enable");
const offscreenState = await offscreenClient.send("Runtime.evaluate", {
  expression: `({
    readyState: document.readyState,
    runtimeId: chrome.runtime.id,
    hasIndexedDb: typeof indexedDB !== "undefined",
    hasOpfs: typeof navigator.storage?.getDirectory === "function",
  })`,
  returnByValue: true,
});
const offscreenValue = offscreenState.result?.value || {};
if (offscreenValue.readyState !== "complete") failures.push("Offscreen document is not complete.");
if (offscreenValue.runtimeId !== extensionId) failures.push("Offscreen document has the wrong extension identity.");
if (!offscreenValue.hasIndexedDb || !offscreenValue.hasOpfs) {
  failures.push("Offscreen storage primitives are unavailable.");
}

search.close();
worker.close();
offscreenClient.close();
await fetch(`${endpoint}/json/close/${searchTarget.id}`);

if (manifest.name !== "Vibesearch" || manifest.manifest_version !== 3) {
  failures.push("dist_chrome does not contain the production MV3 manifest.");
}
if (!manifest.permissions?.includes("offscreen") || !manifest.permissions?.includes("unlimitedStorage")) {
  failures.push("dist_chrome is missing required Chromium storage/offscreen permissions.");
}

if (failures.length > 0) {
  console.error(failures.map((failure) => `FAIL ${failure}`).join("\n"));
  process.exitCode = 1;
} else {
  const backupSummary = `backup v${backupValue.bundle.version} covered ` +
    `${Object.keys(backupValue.bundle.collections).length} collections and restored successfully`;
  const fixtureSummary = archiveFixtureEnabled
    ? "; cached and pending-outbox archive bytes round-tripped"
    : "";
  const resetSummary = resetValue ? "; destructive reset passed" : "";
  console.log(
    `PASS Brave loaded Vibesearch ${manifest.version} (${extensionId}); ` +
    `service worker, offscreen storage host, and Search UI are healthy; ` +
    `${backupSummary}${fixtureSummary}${resetSummary}.`,
  );
}
