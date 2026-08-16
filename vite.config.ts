import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: {
    port: 4173,
    strictPort: true,
    proxy: {
      "/api/agent": process.env.SEMAFRAME_AGENT_GATEWAY_URL ?? "http://127.0.0.1:8788",
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
