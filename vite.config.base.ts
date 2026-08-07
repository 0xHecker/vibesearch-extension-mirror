import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import tsconfigPaths from "vite-tsconfig-paths";
import { resolve } from "path";
import { crxI18n } from "./custom-vite-plugins";

const localize = false;

export default defineConfig({
  plugins: [
    tailwindcss(),
    tsconfigPaths(),
    react(),
    crxI18n({ localize, src: "./src/locales" }),
  ],
  optimizeDeps: {
    include: ["@huggingface/transformers", "@paddleocr/paddleocr-js"],
  },
  publicDir: resolve(__dirname, "public"),
  resolve: {
    alias: {
      "@src": resolve(__dirname, "src"),
      "@components/*": resolve(__dirname, "src/components/*"),
      "@icons/*": resolve(__dirname, "src/components/icons/*"),
      "@assets/*": "src/assets/*",
      "@locales/*": "src/locales/*",
      "@pages/*": "src/pages/*",
    },
  },
});
