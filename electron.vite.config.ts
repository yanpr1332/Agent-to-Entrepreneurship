import { defineConfig, externalizeDepsPlugin } from "electron-vite";
import react from "@vitejs/plugin-react";
import { resolve } from "node:path";

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    build: {
      rollupOptions: {
        // Keep the fixed, offline-only Node worker inside packaged out/main.
        // Do NOT allow dynamically supplied JS modules or executable paths.
        input: {
          index: resolve("src/main/index.ts"),
          "knowledge-word-vector-worker": resolve("src/main/knowledge-word-vector-worker.ts"),
        },
      },
    },
  },
  preload: { plugins: [externalizeDepsPlugin()] },
  renderer: {
    resolve: { alias: { "@": resolve("src/renderer/src"), "@shared": resolve("src/shared") } },
    plugins: [react()],
  },
});
