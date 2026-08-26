// @vitest-environment node

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  XR_STANDALONE_CONTENT_SECURITY_POLICY,
  XR_STANDALONE_SECURITY_HEADERS,
} from "../../../vite.xr.config";

function directive(policy: string, name: string): string {
  return policy.split(";")
    .map((value) => value.trim())
    .find((value) => value.startsWith(`${name} `)) ?? "";
}

describe("XR standalone shell hardening", () => {
  it("ships an external-script CSP and effective anti-framing headers", () => {
    const html = readFileSync(resolve(process.cwd(), "xr.html"), "utf8");
    const metaPolicy = html.match(/http-equiv="Content-Security-Policy"\s+content="([^"]+)"/u)?.[1];
    expect(metaPolicy).toBe(XR_STANDALONE_CONTENT_SECURITY_POLICY);

    const scriptPolicy = directive(XR_STANDALONE_CONTENT_SECURITY_POLICY, "script-src");
    expect(scriptPolicy).toBe("script-src 'self' 'wasm-unsafe-eval'");
    expect(scriptPolicy).not.toContain("'unsafe-inline'");
    expect(directive(XR_STANDALONE_CONTENT_SECURITY_POLICY, "frame-ancestors"))
      .toBe("frame-ancestors 'none'");
    expect(XR_STANDALONE_SECURITY_HEADERS["Content-Security-Policy"])
      .toBe(XR_STANDALONE_CONTENT_SECURITY_POLICY);
    expect(XR_STANDALONE_SECURITY_HEADERS["X-Frame-Options"]).toBe("DENY");

    const scripts = [...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gu)];
    expect(scripts).toHaveLength(1);
    expect(scripts[0]?.[1]).toContain('src="/src/xr-main.tsx"');
    expect(scripts[0]?.[2].trim()).toBe("");
  });

  it("defines a narrow-screen breakpoint for both pairing and connected layouts", () => {
    const css = readFileSync(resolve(process.cwd(), "src/xr.css"), "utf8");
    const narrow = css.match(/@media\s*\(max-width:\s*640px\)\s*\{([\s\S]+)\}\s*$/u)?.[1] ?? "";
    expect(narrow).toContain(".xr-viewer-pairing-row");
    expect(narrow).toContain("flex-direction: column");
    expect(narrow).toContain(".xr-viewer-connected");
    expect(narrow).toContain("grid-template-columns: minmax(0, 1fr)");
    expect(narrow).toContain(".xr-viewer-panels");
    expect(narrow).toContain("border-left: 0");
  });
});
