#!/usr/bin/env node

const endpoint = process.env.BRAVE_CDP_ENDPOINT || "http://127.0.0.1:9224";
const sourceUrl = process.env.BRAVE_ARCHIVE_RECOVERY_URL ||
  "https://github.com/Cooper-io/speedy-gonzales/pull/272";

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
    close: () => socket.close(),
  };
};

const targets = await fetch(`${endpoint}/json/list`).then((response) => response.json());
const extensionTarget = targets.find((target) =>
  (target.type === "service_worker" || target.type === "background_page") &&
  target.url.startsWith("chrome-extension://")
) || targets.find((target) => target.url.includes("/src/pages/offscreen/offscreen.html"));
if (!extensionTarget) throw new Error("No loaded Vibesearch extension target found.");

const extensionId = new URL(extensionTarget.url).hostname;
const searchUrl = `chrome-extension://${extensionId}/src/pages/search/index.html`;
const searchTarget = await fetch(
  `${endpoint}/json/new?${encodeURIComponent(searchUrl)}`,
  { method: "PUT" },
).then((response) => response.json());
const client = await connect(searchTarget);
const worker = await connect(extensionTarget);
const workerLogs = [];
worker.onEvent((message) => {
  if (message.method !== "Runtime.consoleAPICalled") return;
  const type = message.params?.type;
  if (type !== "warning" && type !== "error") return;
  workerLogs.push((message.params?.args || [])
    .map((argument) => argument.value || argument.description || "")
    .join(" "));
});
try {
  await client.send("Runtime.enable");
  await worker.send("Runtime.enable");
  await new Promise((resolve) => setTimeout(resolve, 4_000));
  const result = await client.send("Runtime.evaluate", {
    expression: `(async () => {
      const itemId = "brave-archive-recovery-" + Date.now();
      const sourceUrl = ${JSON.stringify(sourceUrl)};
      const beforeTabs = (await chrome.tabs.query({})).map((tab) => tab.id).filter(Number.isInteger);
      const capture = await chrome.runtime.sendMessage({
        target: "background",
        type: "ARCHIVE_CAPTURE_NOW",
        payload: { itemId, url: sourceUrl },
      });
      const storage = await chrome.storage.local.get([
        "vibesearch:archiveDeviceKey",
        "vibesearch:apiBaseUrl",
      ]);
      const deviceKey = storage["vibesearch:archiveDeviceKey"];
      const apiBase = String(storage["vibesearch:apiBaseUrl"] ||
        "https://vibesearch-api.watermelons.workers.dev").replace(/\\/+$/, "");
      const archiveUrl = apiBase + "/v1/items/" + encodeURIComponent(itemId) + "/archive";
      const headers = { "x-vs-device-key": deviceKey };
      const archive = await fetch(archiveUrl, { headers, cache: "no-store" });
      const html = archive.ok ? await archive.text() : "";
      const deletion = await fetch(archiveUrl, { method: "DELETE", headers });
      const deletionBody = await deletion.json().catch(() => null);
      const afterDelete = await fetch(archiveUrl, { headers, cache: "no-store" });
      const afterTabs = (await chrome.tabs.query({})).map((tab) => tab.id).filter(Number.isInteger);
      return {
        capture,
        archiveStatus: archive.status,
        archiveContentType: archive.headers.get("content-type"),
        hasGitHubContent: /speedy-gonzales|refactor language preference|github/i.test(html),
        sourceBytes: new Blob([html]).size,
        deletionStatus: deletion.status,
        deletionBody,
        afterDeleteStatus: afterDelete.status,
        leakedTabIds: afterTabs.filter((id) => !beforeTabs.includes(id)),
      };
    })()`,
    awaitPromise: true,
    returnByValue: true,
  });
  const value = result.result?.value;
  const ok = value?.capture?.success === true &&
    value.capture.payload?.captured === true &&
    value.archiveStatus === 200 &&
    value.archiveContentType?.startsWith("text/html") &&
    value.hasGitHubContent === true &&
    value.sourceBytes > 1_000 &&
    value.deletionStatus === 200 &&
    value.deletionBody?.removed === true &&
    value.afterDeleteStatus === 404 &&
    value.leakedTabIds?.length === 0;
  if (!ok) {
    console.error("FAIL", JSON.stringify({ ...value, workerLogs }, null, 2));
    process.exitCode = 1;
  } else {
    console.log(
      `PASS browser-session archive recovery captured ${value.sourceBytes} bytes, ` +
      "served the GitHub snapshot, closed its temporary tab, and deleted the test copy.",
    );
  }
} finally {
  client.close();
  worker.close();
  await fetch(`${endpoint}/json/close/${searchTarget.id}`).catch(() => undefined);
}
