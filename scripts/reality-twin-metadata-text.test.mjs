import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { realityTwinMetadataText } from "./reality-twin-metadata-text.mjs";

test("extracts inert metadata text without decoding entities", () => {
  assert.equal(
    realityTwinMetadataText(" <b>Gift &amp; collection</b> "),
    "Gift &amp; collection",
  );
});

test("keeps encoded markup encoded instead of double-unescaping it", () => {
  assert.equal(
    realityTwinMetadataText("&amp;lt;script&amp;gt;alert(1)&amp;lt;/script&amp;gt;"),
    "&amp;lt;script&amp;gt;alert(1)&amp;lt;/script&amp;gt;",
  );
  assert.equal(
    realityTwinMetadataText("&lt;script&gt;alert(1)&lt;/script&gt;"),
    "&lt;script&gt;alert(1)&lt;/script&gt;",
  );
});

test("removes complete, nested-looking, and incomplete markup fragments", () => {
  assert.equal(realityTwinMetadataText("before <em>middle</em> after"), "before middle after");
  assert.equal(realityTwinMetadataText("<<script>alert(1)</script>safe"), "alert(1)safe");
  assert.equal(realityTwinMetadataText("safe<script"), "safe");
});

test("normalizes whitespace and drops unsafe control bytes", () => {
  assert.equal(realityTwinMetadataText(" A\u0000\n\t B "), "A B");
});

test("the asset preparation entrypoint binds every metadata field to the extractor", () => {
  const source = readFileSync(new URL("./prepare-reality-twin-asset.mjs", import.meta.url), "utf8");
  assert.match(source, /const title = realityTwinMetadataText\(record\.title\);/u);
  assert.match(source, /return realityTwinMetadataText\(entry\.content\);/u);
  assert.doesNotMatch(source, /\bstripHtml\b/u);
});
