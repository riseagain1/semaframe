import { readdir, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

describe("Extension SDK public boundary", () => {
  it("keeps every public SDK module independent of application-internal src modules", async () => {
    const sdkRoot = resolve("src/extensions");
    const files = (await readdir(sdkRoot)).filter((name) => name.endsWith(".ts"));
    expect(files).toContain("index.ts");
    for (const file of files) {
      const source = await readFile(resolve(sdkRoot, file), "utf8");
      const specifiers = [...source.matchAll(/(?:from\s+|import\s*\()(["'])([^"']+)\1/gu)]
        .map((match) => match[2]!);
      expect(
        specifiers.filter((specifier) => specifier.startsWith("../") || specifier.includes("/src/")),
        `${file} imports an application-internal module`,
      ).toEqual([]);
    }
  });
});
