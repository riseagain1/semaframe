/// <reference types="vitest/config" />
import { defineConfig } from "vite";
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
    setupFiles: ["src/tests/setup.ts"],
    coverage: {
      provider: "v8",
      reportsDirectory: "coverage",
      reporter: ["text-summary", "json-summary", "lcov"],
      thresholds: {
        // Ratchet from the first complete core report (85.71 / 79.49 /
        // 95.05 / 85.71). Keep a small runner/version margin while making
        // any material coverage regression fail CI.
        statements: 84,
        branches: 78,
        functions: 94,
        lines: 84,
      },
      include: [
        "src/app/agentExperience.ts",
        "src/app/lifecycle/**/*.ts",
        "src/app/recovery/**/*.ts",
        "src/app/validation/**/*.ts",
        "src/app/workspaceSourceAtomicCreate.ts",
        "src/app/components/workspace/workspaceSourceWizard.ts",
        "src/workspace/agents/**/*.ts",
        "src/workspace/persistence/**/*.ts",
        "src/workspace/protocol/**/*.ts",
        "src/workspace/security/**/*.ts",
        "src/workspace/state/**/*.ts",
        "src/xr/authority/**/*.ts",
        "src/xr/network/**/*.ts",
        "server/agent/**/*.ts",
        "server/feed/**/*.ts",
        "server/xr/**/*.ts",
      ],
      exclude: [
        "**/*.d.ts",
        "**/*.test.{ts,tsx}",
        "**/fixtures/**",
        "src/tests/**",
      ],
    },
  }
});
