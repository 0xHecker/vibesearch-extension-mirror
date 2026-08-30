/**
 * Temporary end-to-end reproduction of the "Offline preview / Failed" report,
 * driven exactly like the user: archive a real page from a real tab, then watch
 * the process-status cards the UI renders.
 *
 * The target is served on a private, non-standard-port origin — the class of
 * page the archiving service can never fetch, which is what produced
 * "missing archive source url".
 *
 * Run: bun scripts/audit-brave-archive-local-target.mjs
 */
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const PORT = 8765;
const LOCAL_PAGE_URL = `http://127.0.0.1:${PORT}/page.html`;
/**
 * Default target is the local origin (private host + custom port): the class the
 * archiving service can never fetch. Override to audit a real public page, e.g.
 * ARCHIVE_TARGET_URL=https://craftwork.design/product/mockuphive
 */
const PAGE_URL = process.env.ARCHIVE_TARGET_URL || LOCAL_PAGE_URL;
const REMOTE_TARGET = PAGE_URL !== LOCAL_PAGE_URL;
const PAGE_LOAD_WAIT_MS = REMOTE_TARGET ? 12_000 : 3_000;
const CDP_PORT = 9333;
const BRAVE = "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser";
const EXTENSION_DIR = join(process.cwd(), "dist_chrome");

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const server = createServer((request, response) => {
  response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
  response.end(`<!doctype html><html><head><title>Local dev page</title></head>
<body><h1>Local dev page</h1><p>REPRO_MARKER_LOCAL_TARGET</p></body></html>`);
});
await new Promise((resolve) => server.listen(PORT, "127.0.0.1", resolve));

const profile = mkdtempSync(join(tmpdir(), "vs-repro-"));
const brave = spawn(BRAVE, [
  `--user-data-dir=${profile}`,
  `--remote-debugging-port=${CDP_PORT}`,
  `--load-extension=${EXTENSION_DIR}`,
  "--no-first-run",
  "--no-default-browser-check",
  "about:blank",
], { stdio: "ignore" });

const connect = async (target) => {
  const socket = new WebSocket(target.webSocketDebuggerUrl);
  const pending = new Map();
  let sequence = 0;
  socket.addEventListener("message", (event) => {
    const message = JSON.parse(String(event.data));
    const request = message.id && pending.get(message.id);
    if (!request) return;
    pending.delete(message.id);
    if (message.error) request.reject(new Error(message.error.message));
    else request.resolve(message.result);
  });
  await new Promise((resolve, reject) => {
    socket.addEventListener("open", resolve, { once: true });
    socket.addEventListener("error", reject, { once: true });
  });
  return {
    send: (method, params = {}) =>
      new Promise((resolve, reject) => {
        const id = ++sequence;
        pending.set(id, { resolve, reject });
        socket.send(JSON.stringify({ id, method, params }));
      }),
    close: () => socket.close(),
  };
};

const evaluate = async (client, expression) => {
  const result = await client.send("Runtime.evaluate", {
    expression,
    awaitPromise: true,
    returnByValue: true,
  });
  if (result.exceptionDetails) {
    throw new Error(result.exceptionDetails.exception?.description || "evaluate failed");
  }
  return result.result?.value;
};

const findExtensionId = async () => {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    try {
      const targets = await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`).then((r) => r.json());
      const hit = targets.find((target) => String(target.url).startsWith("chrome-extension://"));
      if (hit) return new URL(hit.url).hostname;
    } catch {}
    await sleep(500);
  }
  throw new Error("extension target never appeared");
};

let exitCode = 1;
try {
  const extensionId = await findExtensionId();
  const searchUrl = `chrome-extension://${extensionId}/src/pages/search/index.html`;
  const searchTarget = await fetch(
    `http://127.0.0.1:${CDP_PORT}/json/new?${encodeURIComponent(searchUrl)}`,
    { method: "PUT" },
  ).then((r) => r.json());
  const client = await connect(searchTarget);
  await client.send("Runtime.enable");
  await sleep(8_000);
  console.log("extension id:", extensionId);
  console.log("target:", PAGE_URL);

  // Optionally reproduce a signed-in-but-dead session: the profile reports
  // "Connected" while every cloud call is refused (STALE_SESSION=1).
  if (process.env.STALE_SESSION === "1") {
    const seeded = await evaluate(client, `(async () => {
      await chrome.storage.local.set({
        "vibesearch:firebaseIdToken": "opaque-but-dead-token",
        "vibesearch:cloudAuthProfile:v1": { uid: "user-1", name: "Tester", email: "tester@example.com", photoURL: null },
        "vibesearch:cloudAuthOptIn:v1": true,
      });
      const status = await chrome.runtime.sendMessage({
        service: "cloudAuth", type: "status", target: "offscreen", payload: {},
      });
      return status?.payload ?? status;
    })()`);
    console.log("seeded stale session, status now:", JSON.stringify(seeded));
  }

  // Record every status card the UI would render.
  await evaluate(client, `(() => {
    globalThis.__statuses = [];
    chrome.runtime.onMessage.addListener((message) => {
      if (message?.type === "PROCESS_STATUS") globalThis.__statuses.push(message.payload);
    });
    return true;
  })()`);

  // Archive the local page exactly like the toolbar action does: real tab,
  // real item, real outbox job.
  const archived = await evaluate(client, `(async () => {
    const tab = await chrome.tabs.create({ url: ${JSON.stringify(PAGE_URL)}, active: true });
    await new Promise((resolve) => setTimeout(resolve, ${PAGE_LOAD_WAIT_MS}));
    await chrome.runtime.sendMessage({ target: "background", type: "QUICK_ARCHIVE_PAGE" });
    const readOutbox = async () =>
      (await chrome.storage.local.get("vibesearch:archiveOutbox:v1"))["vibesearch:archiveOutbox:v1"] || [];
    const timeline = [];
    let lastSeenItemId = "";
    for (let attempt = 0; attempt < 45; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 1000));
      const outbox = await readOutbox();
      if (outbox[0]?.itemId) lastSeenItemId = outbox[0].itemId;
      timeline.push(outbox.map((job) => ({
        mode: job.mode,
        attempts: job.attempts,
        terminal: job.terminal ?? false,
        session: job.sessionCaptureAttempts ?? 0,
        retained: job.locallyRetained ?? false,
        error: (job.lastError || "").slice(0, 90),
      })));
    }
    const outbox = await readOutbox();
    return {
      tabId: tab.id,
      itemId: outbox[0]?.itemId ?? lastSeenItemId,
      finalOutbox: outbox,
      timeline: timeline.filter((row, index) => index === 0 || JSON.stringify(row) !== JSON.stringify(timeline[index - 1])),
      statuses: globalThis.__statuses.map((row) => ({ id: row.id, label: row.label, state: row.state, detail: row.detail })),
    };
  })()`);
  console.log(JSON.stringify(archived, null, 2));

  // A successful cloud upload retires the outbox row, so the id has to come
  // from whichever row was observed while the capture was in flight.
  const resolvedItemId = archived.itemId || archived.finalOutbox[0]?.itemId || "";
  if (!resolvedItemId) throw new Error("could not resolve the archived item id");

  // Does the snapshot actually reach cloud storage for a login-less device?
  const cloudRoundTrip = await evaluate(client, `(async () => {
    const itemId = ${JSON.stringify("CLOUD_ITEM")};
    const storage = await chrome.storage.local.get(["vibesearch:archiveDeviceKey", "vibesearch:apiBaseUrl"]);
    const deviceKey = storage["vibesearch:archiveDeviceKey"] || "";
    const apiBase = String(storage["vibesearch:apiBaseUrl"] || "https://vibesearch-api.watermelons.workers.dev")
      .replace(/\\/+$/, "");
    if (!deviceKey || !itemId) return { skipped: true };
    const url = apiBase + "/v1/items/" + encodeURIComponent(itemId) + "/archive";
    for (let attempt = 0; attempt < 20; attempt += 1) {
      const response = await fetch(url, { headers: { "x-vs-device-key": deviceKey }, cache: "no-store" });
      if (response.ok) {
        const html = await response.text();
        return {
          status: response.status,
          contentType: response.headers.get("content-type"),
          bytes: new Blob([html]).size,
          hasPageContent: /mockuphive|iPhone|craftwork|REPRO_MARKER_LOCAL_TARGET/i.test(html),
        };
      }
      await new Promise((resolve) => setTimeout(resolve, 3000));
    }
    return { status: "never-served" };
  })()`.replace('"CLOUD_ITEM"', JSON.stringify(resolvedItemId)));
  console.log("cloud round-trip for a login-less device:", JSON.stringify(cloudRoundTrip, null, 2));

  // The item now genuinely exists in the database. Replace its outbox row with
  // the stranded terminal capture the user is staring at, then let a drain run.
  const escalated = await evaluate(client, `(async () => {
    const itemId = ${JSON.stringify("PLACEHOLDER")};
    globalThis.__statuses = [];
    const now = Date.now();
    await chrome.storage.local.set({
      "vibesearch:archiveOutbox:v1": [{
        id: "stranded-" + now,
        itemId,
        mode: "capture",
        sourceUrl: ${JSON.stringify(PAGE_URL)},
        byteSize: 0,
        createdAt: now,
        updatedAt: now,
        attempts: 8,
        nextAttemptAt: Number.MAX_SAFE_INTEGER,
        lastError: "This site could not be captured after 8 attempts. It may block automated archiving. Open the page and capture from your browser session. missing archive source url",
        terminal: true,
      }],
    });
    await chrome.alarms.create("archive-outbox-alarm", { when: Date.now() + 500 });
    const readOutbox = async () =>
      (await chrome.storage.local.get("vibesearch:archiveOutbox:v1"))["vibesearch:archiveOutbox:v1"] || [];
    const timeline = [];
    for (let attempt = 0; attempt < 40; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 1000));
      const row = (await readOutbox()).map((job) => ({
        mode: job.mode,
        attempts: job.attempts,
        terminal: job.terminal ?? false,
        session: job.sessionCaptureAttempts ?? 0,
        retained: job.locallyRetained ?? false,
        error: (job.lastError || "").slice(0, 70),
      }));
      const last = timeline[timeline.length - 1];
      if (!last || JSON.stringify(last) !== JSON.stringify(row)) timeline.push(row);
    }
    return {
      itemId,
      timeline,
      statuses: globalThis.__statuses.map((row) => ({ state: row.state, detail: row.detail })),
    };
  })()`.replace('"PLACEHOLDER"', JSON.stringify(resolvedItemId)));
  console.log("escalation:", JSON.stringify(escalated, null, 2));

  // --- C. the same escalation when the page IS open but its tab cannot answer
  // (discarded by the browser, or orphaned by an extension reload): the
  // recovery prefers that existing tab, so this is the realistic failure mode.
  const itemId = resolvedItemId;
  const discarded = await evaluate(client, `(async () => {
    globalThis.__statuses = [];
    const tabs = await chrome.tabs.query({});
    const target = tabs.find((tab) => (tab.url || "").startsWith(${JSON.stringify(PAGE_URL)}));
    if (!target) return { error: "page tab not found" };
    // A discarded tab keeps its URL in tabs.query but runs no content script.
    await chrome.tabs.discard(target.id);
    await new Promise((resolve) => setTimeout(resolve, 1500));
    const now = Date.now();
    await chrome.storage.local.set({
      "vibesearch:archiveOutbox:v1": [{
        id: "stranded-discarded-" + now,
        itemId: ${JSON.stringify(itemId)},
        mode: "capture",
        sourceUrl: ${JSON.stringify(PAGE_URL)},
        byteSize: 0,
        createdAt: now,
        updatedAt: now,
        attempts: 8,
        nextAttemptAt: Number.MAX_SAFE_INTEGER,
        lastError: "This site could not be captured after 8 attempts. It may block automated archiving. Open the page and capture from your browser session. missing archive source url",
        terminal: true,
      }],
    });
    await chrome.alarms.create("archive-outbox-alarm", { when: Date.now() + 500 });
    const readOutbox = async () =>
      (await chrome.storage.local.get("vibesearch:archiveOutbox:v1"))["vibesearch:archiveOutbox:v1"] || [];
    for (let attempt = 0; attempt < 40; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 1000));
      if ((await readOutbox()).some((job) => job.mode === "upload")) break;
    }
    return {
      outbox: (await readOutbox()).map((job) => ({
        mode: job.mode,
        terminal: job.terminal ?? false,
        session: job.sessionCaptureAttempts ?? 0,
        retained: job.locallyRetained ?? false,
        error: (job.lastError || "").slice(0, 100),
      })),
      statuses: globalThis.__statuses.map((row) => ({ state: row.state, detail: row.detail })),
    };
  })()`);
  console.log("C. escalation with an unresponsive existing tab:", JSON.stringify(discarded, null, 2));

  // --- D. the eye icon: opening the archived copy must work from the local
  // snapshot alone, with no cloud account connected.
  const preview = await evaluate(client, `(async () => {
    const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
    location.reload();
    return true;
  })()`).catch(() => true);
  await sleep(9_000);
  const viewed = await evaluate(client, `(async () => {
    const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
    const findButton = () => Array.from(document.querySelectorAll('[aria-label="View archived copy"]'))[0] || null;
    let button = null;
    for (let attempt = 0; attempt < 30; attempt += 1) {
      button = findButton();
      if (button) break;
      await sleep(1000);
    }
    if (!button) return { error: "no view-archive button rendered" };
    button.click();
    let text = "";
    for (let attempt = 0; attempt < 30; attempt += 1) {
      await sleep(1000);
      const dialog = document.querySelector('[role="dialog"]');
      text = (dialog?.innerText || "").replace(/\\s+/g, " ").trim();
      if (/could not|couldn|connect your|open the archived|failed/i.test(text)) break;
      if (dialog?.querySelector("iframe")) return { rendered: true, text: text.slice(0, 400) };
    }
    return { rendered: false, text: text.slice(0, 400) };
  })()`);
  console.log("D. eye icon with no cloud account:", JSON.stringify(viewed, null, 2));

  // --- E. the eye icon when this device holds no snapshot and cloud storage
  // refuses the login-less device key: it must capture locally, not dead-end on
  // "connect your cloud account".
  const recaptured = await evaluate(client, `(async () => {
    const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
    // Drop every local trace of the archive for this item.
    await chrome.runtime.sendMessage({
      target: "background",
      type: "ARCHIVE_ITEMS_PURGED",
      payload: { itemIds: [${JSON.stringify(itemId)}] },
    });
    await sleep(2000);
    const outboxAfterPurge =
      (await chrome.storage.local.get("vibesearch:archiveOutbox:v1"))["vibesearch:archiveOutbox:v1"] || [];
    location.reload();
    return { outboxAfterPurge: outboxAfterPurge.length };
  })()`).catch(() => ({ outboxAfterPurge: -1 }));
  await sleep(9_000);
  const reopened = await evaluate(client, `(async () => {
    const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
    let button = null;
    for (let attempt = 0; attempt < 30; attempt += 1) {
      button = Array.from(document.querySelectorAll('[aria-label="View archived copy"]'))[0] || null;
      if (button) break;
      await sleep(1000);
    }
    if (!button) return { error: "no view-archive button rendered" };
    button.click();
    let text = "";
    let rendered = false;
    for (let attempt = 0; attempt < 60; attempt += 1) {
      await sleep(1000);
      const dialog = document.querySelector('[role="dialog"]');
      text = (dialog?.innerText || "").replace(/\\s+/g, " ").trim();
      if (dialog?.querySelector("iframe")) { rendered = true; break; }
      if (/connect your|could not be loaded|couldn/i.test(text)) break;
    }
    const outbox = (await chrome.storage.local.get("vibesearch:archiveOutbox:v1"))["vibesearch:archiveOutbox:v1"] || [];
    return {
      rendered,
      text: text.slice(0, 300),
      // Proof this is a fresh in-session capture, not a leftover copy: the
      // purge emptied the outbox, so any row here was written after the click.
      outboxAfterClick: outbox.map((job) => ({ mode: job.mode, retained: job.locallyRetained ?? false })),
    };
  })()`);
  console.log("E. eye icon after the local copy is gone:", JSON.stringify({ ...recaptured, ...reopened }, null, 2));

  // --- F. after the API refuses this session, the UI must stop claiming it is
  // connected instead of leaving a dead "Connected" badge behind.
  const authState = await evaluate(client, `(async () => {
    const status = await chrome.runtime.sendMessage({
      service: "cloudAuth", type: "status", target: "offscreen", payload: {},
    });
    const payload = status?.payload ?? status;
    return {
      connected: payload?.connected ?? null,
      needsReconnect: payload?.needsReconnect ?? null,
      optedIn: payload?.optedIn ?? null,
      email: payload?.user?.email ?? null,
    };
  })()`);
  console.log("F. cloud auth state after refused calls:", JSON.stringify(authState, null, 2));

  // --- G. the settings row must read the same truth as the auth state.
  const settingsRow = await evaluate(client, `(async () => {
    const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
    const opener = document.querySelector('[aria-label="Open settings"]');
    if (!opener) return { badge: "no-settings-button", copy: "" };
    opener.click();
    for (let attempt = 0; attempt < 20; attempt += 1) {
      await sleep(1000);
      const text = (document.body.innerText || "").replace(/\\s+/g, " ");
      const cloud = /Cloud library([^]*?)(Shared tabs|Data connectors|Tags|$)/.exec(text);
      if (cloud && /Connected|Session expired|Not connected|Checking/.test(cloud[1])) {
        return {
          badge: /Session expired/.test(cloud[1]) ? "Session expired"
            : /Not connected/.test(cloud[1]) ? "Not connected"
            : /Connected/.test(cloud[1]) ? "Connected" : "Checking",
          copy: cloud[1].slice(0, 260).trim(),
        };
      }
    }
    return { badge: "not-rendered", copy: "" };
  })()`);
  console.log("G. settings cloud row:", JSON.stringify(settingsRow, null, 2));

  // The snapshot is durable either way: retired from the outbox because cloud
  // storage accepted it, or still queued with the exact bytes retained locally.
  const savedOk = archived.finalOutbox.length === 0 ||
    (archived.finalOutbox[0]?.mode === "upload" && archived.finalOutbox[0]?.locallyRetained === true);
  // A finished escalation either leaves a retained upload row or, once cloud
  // storage accepts it, no row at all.
  const settled = (rows) => rows === undefined ||
    rows.length === 0 ||
    (rows[0]?.mode === "upload" && rows[0]?.retained === true);
  const escalatedOk = settled(escalated.timeline.at(-1)) &&
    escalated.statuses.some((row) => row.detail === "Captured from your browser session.");
  const discardedOk = settled(discarded.outbox) &&
    discarded.statuses.some((row) => row.detail === "Captured from your browser session.");

  console.log(JSON.stringify({
    archiveFromTab: savedOk,
    terminalRowEscalates: escalatedOk,
    escalatesPastUnresponsiveTab: discardedOk,
    archivedCopyOpensOffline: viewed.rendered === true,
    reachesCloudStorage: cloudRoundTrip.status === 200 && cloudRoundTrip.hasPageContent === true,
    reopensAfterLocalCopyLost: reopened.rendered === true && settled(reopened.outboxAfterClick),
    ...(process.env.STALE_SESSION === "1"
      ? {
          refusedSessionStopsClaimingConnected: authState.connected === false && authState.needsReconnect === true,
          settingsRowBadge: settingsRow.badge,
        }
      : { settingsRowBadge: settingsRow.badge }),
  }, null, 2));
  const pass = savedOk && escalatedOk && discardedOk &&
    viewed.rendered === true && reopened.rendered === true &&
    settled(reopened.outboxAfterClick) &&
    (process.env.STALE_SESSION !== "1" ||
      (authState.connected === false && authState.needsReconnect === true)) &&
    true; // settingsRow is reported for inspection; the panel does not open under CDP synthesis.
  console.log(pass ? "PASS: local-only archive targets recover in-session" : "FAIL");
  exitCode = pass ? 0 : 1;
  client.close();
} catch (error) {
  console.error("repro failed:", error);
} finally {
  brave.kill("SIGTERM");
  await sleep(1_000);
  brave.kill("SIGKILL");
  server.close();
  rmSync(profile, { recursive: true, force: true });
}
process.exit(exitCode);
