#!/usr/bin/env node

import { ArchivePreviewSession } from "../src/services/archive-preview.ts";

const endpoint = process.env.BRAVE_CDP_ENDPOINT || "http://127.0.0.1:9223";
let generatedArchive = null;
const previewSession = new ArchivePreviewSession({
  cache: {
    get: async () => new Blob([
      `<style>body{min-height:300vh}</style><html><body>` +
      `<a id="external" href="https://example.com/archive-navigation-probe">Open source</a>` +
      `</body></html>`,
    ], { type: "text/html" }),
    put: async () => {},
  },
  getConnection: async () => {
    throw new Error("The local archive probe must not touch auth or network.");
  },
  createObjectUrl: (blob) => {
    generatedArchive = blob;
    return "blob:vibesearch-archive-audit";
  },
  revokeObjectUrl: () => {},
});
await previewSession.load("brave-archive-audit");
const archiveHtml = await generatedArchive.text();
previewSession.dispose();
if (!archiveHtml.includes("<html data-vs-archive-document>")) {
  throw new Error("The production archive document is missing its safety marker.");
}

const page = await fetch(`${endpoint}/json/new?${encodeURIComponent("about:blank")}`, {
  method: "PUT",
}).then((response) => response.json());
if (!page?.webSocketDebuggerUrl) throw new Error("No Brave page target is available.");

const socket = new WebSocket(page.webSocketDebuggerUrl);
const pending = new Map();
let sequence = 0;
socket.addEventListener("message", (event) => {
  const message = JSON.parse(String(event.data));
  if (!message.id) return;
  const request = pending.get(message.id);
  if (!request) return;
  pending.delete(message.id);
  if (message.error) request.reject(new Error(message.error.message));
  else request.resolve(message.result);
});
await new Promise((resolve, reject) => {
  socket.addEventListener("open", resolve, { once: true });
  socket.addEventListener("error", reject, { once: true });
});

const send = (method, params = {}) => new Promise((resolve, reject) => {
  const id = ++sequence;
  pending.set(id, { resolve, reject });
  socket.send(JSON.stringify({ id, method, params }));
});

await send("Page.enable");
await send("Runtime.enable");
await send("Page.navigate", { url: "https://example.com/" });
await new Promise((resolve) => setTimeout(resolve, 1_000));
const setup = await send("Runtime.evaluate", {
  expression: `(() => {
    document.body.replaceChildren();
    const frame = document.createElement("iframe");
    frame.id = "archive";
    frame.setAttribute("sandbox", "");
    const html = ${JSON.stringify(archiveHtml)};
    frame.src = URL.createObjectURL(new Blob([html], { type: "text/html" }));
    document.body.append(frame);
  })()`,
});
if (setup.exceptionDetails) {
  throw new Error(setup.exceptionDetails.exception?.description || setup.exceptionDetails.text);
}
await new Promise((resolve) => setTimeout(resolve, 1_000));

const frameTargets = await fetch(`${endpoint}/json/list`).then((response) => response.json());
const frameTarget = frameTargets.find((target) =>
  target.type === "iframe" && target.parentId === page.id
);
if (!frameTarget?.webSocketDebuggerUrl) throw new Error("Archive iframe did not load.");

const frameSocket = new WebSocket(frameTarget.webSocketDebuggerUrl);
const framePending = new Map();
let frameSequence = 0;
frameSocket.addEventListener("message", (event) => {
  const message = JSON.parse(String(event.data));
  if (!message.id) return;
  const request = framePending.get(message.id);
  if (!request) return;
  framePending.delete(message.id);
  if (message.error) request.reject(new Error(message.error.message));
  else request.resolve(message.result);
});
await new Promise((resolve, reject) => {
  frameSocket.addEventListener("open", resolve, { once: true });
  frameSocket.addEventListener("error", reject, { once: true });
});
const sendFrame = (method, params = {}) => new Promise((resolve, reject) => {
  const id = ++frameSequence;
  framePending.set(id, { resolve, reject });
  frameSocket.send(JSON.stringify({ id, method, params }));
});
await sendFrame("Runtime.enable");
await sendFrame("Runtime.evaluate", {
  expression: "document.body.focus()",
  returnByValue: true,
});
await sendFrame("Input.dispatchKeyEvent", {
  type: "rawKeyDown",
  key: "Tab",
  code: "Tab",
  windowsVirtualKeyCode: 9,
});
await sendFrame("Input.dispatchKeyEvent", {
  type: "keyUp",
  key: "Tab",
  code: "Tab",
  windowsVirtualKeyCode: 9,
});
const naturalFocus = await sendFrame("Runtime.evaluate", {
  expression: "document.activeElement?.id || ''",
  returnByValue: true,
});
await sendFrame("Input.dispatchMouseEvent", {
  type: "mouseWheel",
  x: 20,
  y: 20,
  deltaX: 0,
  deltaY: 500,
});
await new Promise((resolve) => setTimeout(resolve, 500));
const afterTargets = await fetch(`${endpoint}/json/list`).then((response) => response.json());
const navigatedUrl = afterTargets.find((target) => target.id === frameTarget.id)?.url || "";
const scroll = await sendFrame("Runtime.evaluate", {
  expression: "window.scrollY",
  returnByValue: true,
});

frameSocket.close();
socket.close();
await fetch(`${endpoint}/json/close/${page.id}`);
if (naturalFocus.result?.value === "external") {
  console.error("FAIL archived live link remained keyboard-focusable");
  process.exitCode = 1;
} else if (navigatedUrl.startsWith("https://example.com/")) {
  console.error(`FAIL archive iframe navigated to the live network: ${navigatedUrl}`);
  process.exitCode = 1;
} else if (!(Number(scroll.result?.value) > 0)) {
  console.error("FAIL sanitized archive viewport did not remain scrollable");
  process.exitCode = 1;
} else {
  console.log(`PASS archive iframe stayed read-only and scrolled to ${scroll.result.value}px`);
}
