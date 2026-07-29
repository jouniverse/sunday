import { fileURLToPath, URL } from "node:url";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// Tauri drives the dev server on a fixed port and expects a fixed host.
const host = process.env.TAURI_DEV_HOST;

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
  // Tauri uses a Safari-based webview on macOS; target its supported baseline.
  build: {
    target: "safari17",
    minify: process.env.TAURI_ENV_DEBUG ? false : "esbuild",
    sourcemap: !!process.env.TAURI_ENV_DEBUG,
    outDir: "dist",
  },
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    hmr: host ? { protocol: "ws", host, port: 1421 } : undefined,
    watch: {
      // These directories are large and irrelevant to the app build.
      ignored: ["**/src-tauri/**", "**/notes/**", "**/freezer/**", "**/data/**"],
    },
    proxy: {
      // Browser-dev convenience: reach a manually started solar engine sidecar.
      "/solar-engine": {
        target: "http://127.0.0.1:8787",
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/solar-engine/, ""),
      },
    },
  },
});
