import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import manifest from "../manifest.base.json";
import chromeManifest from "../manifest.chrome.json";
import firefoxManifest from "../manifest.firefox.json";
import hostPermissions from "../manifest.host-permissions.json";
import pkg from "../package.json";
import {
  createChromeManifest,
  createFirefoxManifest,
} from "../extension-manifest-config";

describe("extension CSP", () => {
  test("allows bundled local WASM data in the extension and OCR sandbox", () => {
    const csp = manifest.content_security_policy;

    expect(csp.extension_pages).toContain("connect-src 'self' data:");
    expect(csp.extension_pages).toContain("frame-src 'self'");
    expect(csp.sandbox).toContain("connect-src 'self' data:");
  });
});

describe("extension storage durability", () => {
  test("protects the local-first IndexedDB from browser quota eviction", () => {
    expect(manifest.permissions).toContain("unlimitedStorage");
  });

  test("keeps a stable extension identity so upgrades reopen the same IndexedDB", async () => {
    expect(typeof manifest.key).toBe("string");
    expect(manifest.key.length).toBeGreaterThan(100);

    for (const configPath of ["vite.config.chrome.ts", "vite.config.firefox.ts"]) {
      const source = await Bun.file(new URL(`../${configPath}`, import.meta.url)).text();
      expect(source).not.toContain("delete (manifest as any).key");
    }
  });
});

describe("browser-specific production manifests", () => {
  test("ships social connector hosts through the shared browser manifest input", () => {
    expect(hostPermissions).toEqual(expect.arrayContaining([
      "https://x.com/*",
      "https://twitter.com/*",
      "https://api.x.com/*",
      "https://*.reddit.com/*",
      "https://www.instagram.com/*",
    ]));
    expect(manifest.permissions).toContain("cookies");
    expect(manifest.permissions).not.toContain("downloads");
  });

  test("keeps the Chrome service worker, public identity key, and offscreen host", () => {
    const chrome = createChromeManifest(
      manifest,
      chromeManifest,
      hostPermissions,
      pkg.version
    ) as any;

    expect(chrome.background.service_worker).toBe("src/workers/background.ts");
    expect(chrome.background.type).toBe("module");
    expect(chrome.key).toBe(manifest.key);
    expect(chrome.permissions).toContain("offscreen");
    expect(chrome.sandbox.pages).toContain("src/pages/ocr-sandbox/index.html");
    expect(chrome.host_permissions).toEqual(hostPermissions);
  });

  test("pins the production Chrome ID and Drive-only OAuth contract", () => {
    const chrome = createChromeManifest(
      manifest,
      chromeManifest,
      hostPermissions,
      pkg.version
    ) as any;
    const digest = createHash("sha256")
      .update(Buffer.from(chrome.key, "base64"))
      .digest()
      .subarray(0, 16);
    const extensionId = Array.from(digest, (byte) =>
      String.fromCharCode(97 + (byte >> 4), 97 + (byte & 0x0f))
    ).join("");

    expect(extensionId).toBe("heembgihcngbcadkkpcmkhhlldkidoph");
    expect(chrome.permissions).toContain("identity");
    expect(chrome.oauth2).toEqual({
      client_id: "400575856806-8ie45ter3reqjm1f51adflijaan5rgta.apps.googleusercontent.com",
      scopes: ["https://www.googleapis.com/auth/drive.file"],
    });
    expect(chrome.host_permissions).toContain("https://accounts.google.com/*");
    expect(chrome.host_permissions).toContain("https://www.googleapis.com/*");
    expect(chrome.content_security_policy.extension_pages).toContain("https://accounts.google.com");
    expect(chrome.content_security_policy.extension_pages).toContain("https://www.googleapis.com");
  });

  test("emits a genuine Gecko MV3 background page and signing identity", () => {
    const firefox = createFirefoxManifest(
      manifest,
      firefoxManifest,
      hostPermissions,
      pkg.version
    ) as any;

    expect(firefox.manifest_version).toBe(3);
    expect(firefox.background).toEqual({
      scripts: ["src/workers/background.firefox.ts"],
      type: "module",
    });
    expect(firefox.background.service_worker).toBeUndefined();
    expect(firefox.description).not.toContain("OCR");
    expect(firefox.key).toBeUndefined();
    expect(firefox.permissions).not.toContain("offscreen");
    expect(firefox.permissions).toContain("unlimitedStorage");
    expect(firefox.sandbox).toBeUndefined();
    expect(firefox.content_security_policy.sandbox).toBeUndefined();
    expect(firefox.content_security_policy.extension_pages).toContain(
      "frame-src 'self'"
    );
    expect(firefox.host_permissions).toEqual(hostPermissions);

    const gecko = firefox.browser_specific_settings.gecko;
    expect(gecko.id).toBe("vibesearch@vibesearch.app");
    expect(Number.parseInt(gecko.strict_min_version, 10)).toBeGreaterThanOrEqual(142);
    expect(gecko.data_collection_permissions.required).toEqual([
      "authenticationInfo",
      "bookmarksInfo",
      "browsingActivity",
      "websiteContent",
    ]);
  });

  test("targets CRXJS Firefox mode and hosts the local runtime in a child frame", async () => {
    const [
      configSource,
      backgroundEntry,
      runtimeHost,
      firefoxGoogleAuth,
      firefoxBookmarkEvents,
      firefoxEmbeddingAssets,
      ocrStub,
    ] = await Promise.all([
      Bun.file(new URL("../vite.config.firefox.ts", import.meta.url)).text(),
      Bun.file(
        new URL("../src/workers/background.firefox.ts", import.meta.url)
      ).text(),
      Bun.file(
        new URL("../src/workers/firefox-runtime-host.ts", import.meta.url)
      ).text(),
      Bun.file(
        new URL("../src/services/google-auth.firefox.ts", import.meta.url)
      ).text(),
      Bun.file(
        new URL("../src/services/browser-bookmark-events.firefox.ts", import.meta.url)
      ).text(),
      Bun.file(
        new URL(
          "../src/services/embedding-wasm-assets.firefox.ts",
          import.meta.url
        )
      ).text(),
      Bun.file(
        new URL("../src/services/ocr.service.firefox.ts", import.meta.url)
      ).text(),
    ]);

    expect(configSource).toContain('browser: "firefox"');
    expect(configSource).toContain('target: "firefox142"');
    expect(configSource).not.toContain('browser: "chrome"');
    expect(configSource).toContain("manifest.firefox.json");
    expect(configSource).not.toContain("manifest.chrome.json");
    expect(backgroundEntry).toContain('import "@src/workers/firefox-runtime-host"');
    expect(backgroundEntry).toContain('import "@src/workers/background"');
    expect(backgroundEntry).not.toContain("await import");
    expect(runtimeHost).toContain("FIREFOX_RUNTIME_FRAME_ID");
    expect(runtimeHost).toContain("OFFSCREEN_DOCUMENT_PATH");
    expect(firefoxGoogleAuth).toContain("launchWebAuthFlow");
    expect(firefoxGoogleAuth).not.toContain("getAuthToken");
    expect(firefoxGoogleAuth).not.toContain("removeCachedAuthToken");
    expect(firefoxGoogleAuth).not.toContain("clearAllCachedAuthTokens");
    expect(firefoxBookmarkEvents).not.toContain("onChildrenReordered");
    expect(firefoxBookmarkEvents).not.toContain("onImportBegan.addListener");
    expect(firefoxBookmarkEvents).not.toContain("onImportEnded.addListener");
    expect(configSource).toContain("flexsearch.compact.module.min.js");
    expect(configSource).toContain("ort.wasm.bundle.min.mjs");
    expect(firefoxEmbeddingAssets).toContain("ort-wasm-simd-threaded.wasm?url");
    expect(firefoxEmbeddingAssets).not.toContain("asyncify");
    expect(ocrStub).toContain("export const OCR_SUPPORTED = false");
    expect(ocrStub).not.toContain("@paddleocr/paddleocr-js");
  });
});
