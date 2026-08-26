import { readFileSync } from "node:fs";
import react from "@vitejs/plugin-react";
import { defineConfig, loadEnv, type ServerOptions } from "vite";
import { externalizeReplicadOpenCascadeWasm } from "./vite.shared";

function port(value: string | undefined, fallback: number): number {
  const parsed = Number(value?.trim() || fallback);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > 65_535) {
    throw new Error("SEMAFRAME_XR_VITE_PORT must be an integer from 1 through 65535.");
  }
  return parsed;
}

function gatewayOrigin(value: string | undefined): string {
  const url = new URL(value?.trim() || "http://127.0.0.1:8788");
  if ((url.protocol !== "http:" && url.protocol !== "https:")
    || url.username
    || url.password
    || (url.pathname !== "/" && url.pathname !== "")
    || url.search
    || url.hash) {
    throw new Error("SEMAFRAME_AGENT_GATEWAY_URL must be an HTTP(S) origin without credentials, a path, a query, or a fragment.");
  }
  return url.origin;
}

export function xrGatewayProxy(target: string): Readonly<{
  target: string;
  changeOrigin: true;
}> {
  return {
    target,
    // The gateway is deliberately loopback-only and rejects forwarded LAN
    // Host headers. Quest reaches this Vite origin by LAN IP, so normalize the
    // upstream Host header while preserving Origin for renderer CORS checks.
    changeOrigin: true,
  };
}

function httpsOptions(environment: Record<string, string>): ServerOptions["https"] {
  const certificatePath = environment.SEMAFRAME_XR_HTTPS_CERT?.trim();
  const keyPath = environment.SEMAFRAME_XR_HTTPS_KEY?.trim();
  if (Boolean(certificatePath) !== Boolean(keyPath)) {
    throw new Error("SEMAFRAME_XR_HTTPS_CERT and SEMAFRAME_XR_HTTPS_KEY must be configured together.");
  }
  if (!certificatePath || !keyPath) return undefined;
  return {
    cert: readFileSync(certificatePath),
    key: readFileSync(keyPath),
  };
}

export const XR_STANDALONE_CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  "base-uri 'none'",
  "connect-src 'self' https: wss:",
  "frame-src https:",
  "img-src 'self' blob: data: https:",
  "media-src 'self' blob: https:",
  "object-src 'none'",
  "script-src 'self' 'wasm-unsafe-eval'",
  // The current React viewer and renderer-neutral panel fallback use style
  // properties. Script execution is still strict; this allowance is CSS-only.
  "style-src 'self' 'unsafe-inline'",
  "worker-src 'self' blob:",
  "form-action 'none'",
  // This directive is effective in the HTTP header below. Its duplicate in
  // xr.html is defense-in-depth only because meta-delivered CSP ignores it.
  "frame-ancestors 'none'",
].join("; ");

const XR_STANDALONE_DEVELOPMENT_CONTENT_SECURITY_POLICY = XR_STANDALONE_CONTENT_SECURITY_POLICY
  .replace("script-src 'self' 'wasm-unsafe-eval'", "script-src 'self' 'unsafe-inline' 'wasm-unsafe-eval'");

export const XR_STANDALONE_SECURITY_HEADERS = Object.freeze({
  "Cache-Control": "no-store",
  "Content-Security-Policy": XR_STANDALONE_CONTENT_SECURITY_POLICY,
  "Permissions-Policy": "fullscreen=(self), microphone=(self), xr-spatial-tracking=(self)",
  "Referrer-Policy": "no-referrer",
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
});

export default defineConfig(({ mode }) => {
  const environment = loadEnv(mode, process.cwd(), "");
  const xrPort = port(environment.SEMAFRAME_XR_VITE_PORT, 4174);
  const gatewayTarget = gatewayOrigin(environment.SEMAFRAME_AGENT_GATEWAY_URL);
  const https = httpsOptions(environment);

  return {
    plugins: [externalizeReplicadOpenCascadeWasm(), react()],
    worker: {
      format: "es",
      plugins: () => [externalizeReplicadOpenCascadeWasm()],
    },
    server: {
      host: environment.SEMAFRAME_XR_VITE_HOST?.trim() || "0.0.0.0",
      port: xrPort,
      strictPort: true,
      https,
      headers: mode === "development"
        ? {
          ...XR_STANDALONE_SECURITY_HEADERS,
          "Content-Security-Policy": XR_STANDALONE_DEVELOPMENT_CONTENT_SECURITY_POLICY,
        }
        : XR_STANDALONE_SECURITY_HEADERS,
      proxy: {
        // The renderer origin receives only XR relay routes. In particular it
        // never receives the browser-authority bootstrap header used by the
        // main app's /api/agent and authority-side /api/xr routes.
        "/api/xr": xrGatewayProxy(gatewayTarget),
      },
    },
    preview: {
      host: environment.SEMAFRAME_XR_VITE_HOST?.trim() || "0.0.0.0",
      port: xrPort,
      strictPort: true,
      https,
      headers: XR_STANDALONE_SECURITY_HEADERS,
      proxy: {
        "/api/xr": xrGatewayProxy(gatewayTarget),
      },
    },
    build: {
      target: "es2022",
      sourcemap: true,
      outDir: "dist-xr",
      emptyOutDir: true,
      rollupOptions: { input: "xr.html" },
    },
  };
});
