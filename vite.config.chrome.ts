import { defineConfig, mergeConfig } from "vite";
import { crx, ManifestV3Export } from "@crxjs/vite-plugin";
import { resolve } from "path";

import baseConfig from "./vite.config.base";
import baseManifest from "./manifest.base.json";
import chromeManifest from "./manifest.chrome.json";
import hostPermissions from "./manifest.host-permissions.json";
import pkg from "./package.json";
import { createChromeManifest } from "./extension-manifest-config";

const isDev = process.env.NODE_ENV !== "production";

const manifestConfig = createChromeManifest(
  baseManifest,
  chromeManifest,
  hostPermissions,
  pkg.version
);

if (isDev) {
  manifestConfig.name = "Vibesearch (Dev)";
}

const manifest = manifestConfig as ManifestV3Export;

// Keep the public manifest key in every build. It pins the extension ID so an
// unpacked/side-loaded update reopens the same extension origin and IndexedDB
// instead of making the user's existing library appear to have disappeared.

const chromeConfig = defineConfig({
  build: {
    outDir: resolve(__dirname, "dist_chrome"),
    sourcemap: isDev,
    emptyOutDir: !isDev,
    assetsInlineLimit: 0,
    rollupOptions: {
      input: {
        search: resolve(__dirname, "src/pages/search/index.html"),
        offscreen: resolve(__dirname, "src/pages/offscreen/offscreen.html"),
        ocrSandbox: resolve(__dirname, "src/pages/ocr-sandbox/index.html"),
      },
    },
  },
  plugins: [
    crx({
      manifest,
      browser: "chrome",
    }),
  ],
});

export default mergeConfig(baseConfig, chromeConfig);
