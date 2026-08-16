import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

describe("embedded content Content Security Policy", () => {
  it("admits HTTPS website panels while excluding insecure frames and plugin content", () => {
    const html = readFileSync(resolve(process.cwd(), "index.html"), "utf8");
    const document = new DOMParser().parseFromString(html, "text/html");
    const policy = document
      .querySelector('meta[http-equiv="Content-Security-Policy"]')
      ?.getAttribute("content") ?? "";

    expect(policy).toContain("frame-src https:");
    expect(policy).toContain("media-src 'self' blob: https:");
    expect(policy).toContain("object-src 'none'");
    expect(policy).not.toMatch(/frame-src[^;]*(?:\*|http:|data:|blob:)(?:\s|;|$)/u);
  });
});
