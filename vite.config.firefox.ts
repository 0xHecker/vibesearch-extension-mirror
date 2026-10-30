import { defineConfig, mergeConfig } from "vite";
import { crx, ManifestV3Export } from "@crxjs/vite-plugin";
import { resolve } from "path";

import baseConfig from "./vite.config.base";
import baseManifest from "./manifest.base.json";
import firefoxManifest from "./manifest.firefox.json";
import hostPermissions from "./manifest.host-permissions.json";
import pkg from "./package.json";
import { createFirefoxManifest } from "./extension-manifest-config";

const isDev = process.env.NODE_ENV !== "production";

const manifestConfig = createFirefoxManifest(
  baseManifest,
  firefoxManifest,
  hostPermissions,
  pkg.version
);

if (isDev) {
  manifestConfig.name = "Vibesearch (Dev)";
}

const manifest = manifestConfig as unknown as ManifestV3Export;

const firefoxConfig = defineConfig({
  build: {
    target: "firefox142",
    outDir: resolve(__dirname, "dist_firefox"),
    sourcemap: isDev,
    emptyOutDir: !isDev,
    assetsInlineLimit: 0,
    rollupOptions: {
      input: {
        local: resolve(__dirname, "src/pages/local/index.html"),
        search: resolve(__dirname, "src/pages/search/index.html"),
        offscreen: resolve(__dirname, "src/pages/offscreen/offscreen.html"),
      },
    },
  },
  optimizeDeps: {
    exclude: ["@paddleocr/paddleocr-js"],
  },
  resolve: {
    // Firefox MV3 does not implement Chrome's manifest sandbox pages. Replace
    // the unsafe-eval PaddleOCR implementation so the Gecko package remains
    // loadable and AMO-reviewable.
    alias: [
      {
        // The app never enables FlexSearch's optional nested worker. Its compact
        // build omits the worker factory and the string-eval code it carries.
        find: "flexsearch",
        replacement: resolve(
          __dirname,
          "node_modules/flexsearch/dist/flexsearch.compact.module.min.js"
        ),
      },
      {
        // Transformers imports the WebGPU superset even when the model selects
        // `device: \"wasm\"`. Firefox uses ORT's smaller WASM-only bundle whose
        // embedded standard factory does not require string evaluation.
        find: "onnxruntime-web/webgpu",
        replacement: resolve(
          __dirname,
          "node_modules/onnxruntime-web/dist/ort.wasm.bundle.min.mjs"
        ),
      },
      {
        find: "@src/services/embedding-wasm-assets",
        replacement: resolve(
          __dirname,
          "src/services/embedding-wasm-assets.firefox.ts"
        ),
      },
      {
        find: "@src/services/google-auth",
        replacement: resolve(__dirname, "src/services/google-auth.firefox.ts"),
      },
      {
        find: "@src/services/browser-bookmark-events",
        replacement: resolve(
          __dirname,
          "src/services/browser-bookmark-events.firefox.ts"
        ),
      },
      {
        find: "@src/services/ocr.service",
        replacement: resolve(__dirname, "src/services/ocr.service.firefox.ts"),
      },
    ],
  },
  plugins: [
    crx({
      manifest,
      browser: "firefox",
    }),
  ],
});

export default mergeConfig(baseConfig, firefoxConfig);
