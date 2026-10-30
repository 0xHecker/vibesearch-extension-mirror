import { readFile, readdir, stat } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

const buildRoot = process.argv[2] ? path.resolve(process.argv[2]) : fileURLToPath(new URL("../dist_firefox/", import.meta.url));

const assert = (condition, message) => {
  if (!condition) throw new Error(`Firefox build validation failed: ${message}`);
};

const walk = async (directory) => {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const absolutePath = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...(await walk(absolutePath)));
    else if (entry.isFile()) files.push(absolutePath);
  }
  return files;
};

const manifest = JSON.parse(
  await readFile(path.join(buildRoot, "manifest.json"), "utf8")
);
const background = manifest.background || {};
const gecko = manifest.browser_specific_settings?.gecko || {};
const permissions = new Set(manifest.permissions || []);

assert(manifest.manifest_version === 3, "manifest_version must be 3");
assert(
  Array.isArray(background.scripts) && background.scripts.length > 0,
  "background.scripts must contain the Firefox event-page entry"
);
assert(!("service_worker" in background), "Chrome service_worker leaked into Firefox");
assert(background.type === "module", "Firefox background scripts must be modules");
assert(gecko.id === "vibesearch@vibesearch.app", "stable Gecko ID is missing");
assert(
  Number.parseInt(gecko.strict_min_version, 10) >= 142,
  "Firefox minimum version must cover built-in data consent and tab groups"
);
assert(!("key" in manifest), "Chrome public key leaked into Firefox");
assert(!permissions.has("offscreen"), "Chrome offscreen permission leaked into Firefox");
assert(!("sandbox" in manifest), "Chrome sandbox pages leaked into Firefox");
assert(
  !manifest.content_security_policy?.sandbox,
  "Chrome sandbox CSP leaked into Firefox"
);

const files = await walk(buildRoot);
const relativeFiles = files.map((file) => path.relative(buildRoot, file));
for (const script of background.scripts) {
  assert(relativeFiles.includes(script), `background script does not exist: ${script}`);
}

assert(
  !relativeFiles.some((file) => /ocr-sandbox|worker-entry|opencv/i.test(file)),
  "Chrome-only OCR runtime was emitted"
);
assert(
  !relativeFiles.some((file) => /asyncify/i.test(file)),
  "eval-dependent ONNX asyncify runtime was emitted"
);

const wasmFiles = relativeFiles.filter((file) =>
  /ort-wasm-simd-threaded-.*\.wasm$/i.test(file)
);
assert(wasmFiles.length === 1, "expected one CSP-safe ONNX WASM binary");
const wasmSize = (await stat(path.join(buildRoot, wasmFiles[0]))).size;
assert(wasmSize < 15_000_000, "unexpected Firefox ONNX binary variant or size");

const sourceFiles = files.filter((file) => /\.(?:js|mjs)$/i.test(file));
const source = (await Promise.all(sourceFiles.map((file) => readFile(file, "utf8")))).join(
  "\n"
);

const forbiddenRuntimePatterns = [
  [
    /identity\.(?:getAuthToken|removeCachedAuthToken|clearAllCachedAuthTokens)/,
    "unsupported Chrome identity API",
  ],
  [
    /bookmarks\.(?:onChildrenReordered|onImportBegan|onImportEnded)/,
    "unsupported Chrome bookmark event",
  ],
  [/offscreen\.closeDocument/, "unsupported Chrome offscreen API"],
  [/\bnew Function\s*\(|\bFunction\s*\(\s*["'`]/, "string evaluation"],
  [/@paddleocr\/paddleocr-js|ocr-sandbox/i, "Chrome-only OCR implementation"],
];

for (const [pattern, label] of forbiddenRuntimePatterns) {
  assert(!pattern.test(source), `${label} leaked into emitted JavaScript`);
}
assert(
  source.includes("vibesearch-firefox-runtime"),
  "Firefox local database/search runtime host is missing"
);

console.log(
  `Validated genuine Firefox MV3 build (${relativeFiles.length} files, ${(wasmSize / 1_000_000).toFixed(1)} MB ONNX WASM).`
);
