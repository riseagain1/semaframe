import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import { externalizeReplicadOpenCascadeWasm } from "./vite.shared";

export default defineConfig({
  plugins: [externalizeReplicadOpenCascadeWasm(), react()],
  // Worker graphs have their own plugin pipeline in Vite.
  worker: {
    format: "es",
    plugins: () => [externalizeReplicadOpenCascadeWasm()],
  },
  server: {
    port: 4173,
    strictPort: true,
    ...(process.env.SEMAFRAME_DISABLE_HMR === "1" ? { hmr: false } : {}),
    proxy: {
      "/api/agent": {
        target: process.env.SEMAFRAME_AGENT_GATEWAY_URL ?? "http://127.0.0.1:8788",
        ...(process.env.SEMAFRAME_AGENT_BROWSER_TOKEN ? {
          headers: {
            "x-semaframe-browser-bootstrap": process.env.SEMAFRAME_AGENT_BROWSER_TOKEN,
          },
        } : {}),
      },
      "/api/xr": {
        target: process.env.SEMAFRAME_AGENT_GATEWAY_URL ?? "http://127.0.0.1:8788",
        ...(process.env.SEMAFRAME_AGENT_BROWSER_TOKEN ? {
          headers: {
            "x-semaframe-browser-bootstrap": process.env.SEMAFRAME_AGENT_BROWSER_TOKEN,
          },
        } : {}),
      },
    },
  },
  preview: { port: 4173, strictPort: true },
  build: { target: "es2022", sourcemap: true },
  test: {
    environment: "jsdom",
    include: ["src/tests/**/*.test.ts", "src/tests/**/*.test.tsx"],
    setupFiles: ["src/tests/setup.ts"]
  }
});
