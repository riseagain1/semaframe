import { describe, expect, it } from "vitest";
import { sha256DigestBytes } from "../../workspace/assets/digest";
import {
  BrowserXrAssetCache,
  createXrAssetDescriptor,
  type XrAssetDigest,
} from "../../xr/assets";

function glb(size: number, fill = 0): Uint8Array {
  const bytes = new Uint8Array(size);
  bytes.set([0x67, 0x6c, 0x54, 0x46]);
  const view = new DataView(bytes.buffer);
  view.setUint32(4, 2, true);
  view.setUint32(8, size, true);
  bytes.fill(fill, 12);
  return bytes;
}

function descriptor(bytes: Uint8Array) {
  return createXrAssetDescriptor({
    digest: sha256DigestBytes(bytes) as XrAssetDigest,
    format: "mesh-glb",
    byteLength: bytes.byteLength,
  });
}

describe("BrowserXrAssetCache", () => {
  it("verifies content identities, returns copies, and supports bounded ranges", () => {
    const bytes = glb(20, 4);
    const original = bytes.slice();
    const cache = new BrowserXrAssetCache({ maximumBytes: 40, maximumEntries: 2 });
    expect(cache.put(descriptor(bytes), bytes)).toMatchObject({ cached: true, deduplicated: false });
    bytes[12] = 99;
    const full = cache.read({ digest: descriptor(original).digest });
    expect(full?.bytes).toEqual(original);
    if (!full) throw new Error("expected cached bytes");
    full.bytes[12] = 88;
    expect(cache.read({ digest: descriptor(original).digest })?.bytes).toEqual(original);
    expect(cache.read({
      digest: descriptor(original).digest,
      range: { start: 8, endExclusive: 14 },
    })).toMatchObject({
      bytes: original.slice(8, 14),
      range: { start: 8, endExclusive: 14, totalBytes: 20 },
    });
    expect(cache.put(descriptor(original), original)).toMatchObject({ cached: true, deduplicated: true });
  });

  it("evicts least-recently-used content and degrades cleanly when an entry cannot fit", () => {
    const first = glb(16, 1);
    const second = glb(16, 2);
    const third = glb(16, 3);
    const cache = new BrowserXrAssetCache({ maximumBytes: 32, maximumEntries: 2 });
    cache.put(descriptor(first), first);
    cache.put(descriptor(second), second);
    cache.read({ digest: descriptor(first).digest });
    expect(cache.put(descriptor(third), third).evictedDigests).toEqual([descriptor(second).digest]);
    expect(cache.has(descriptor(first).digest)).toBe(true);
    expect(cache.has(descriptor(second).digest)).toBe(false);

    const oversized = glb(40, 8);
    expect(cache.put(descriptor(oversized), oversized)).toEqual({
      cached: false,
      deduplicated: false,
      reason: "entry_exceeds_cache_budget",
      evictedDigests: [],
    });
    expect(cache.stats()).toMatchObject({ entryCount: 2, totalBytes: 32 });
  });

  it("rejects digest, derived-MIME, signature, and range inconsistencies", () => {
    const bytes = glb(16, 6);
    const cache = new BrowserXrAssetCache({ maximumBytes: 32 });
    expect(() => cache.put({ ...descriptor(bytes), digest: `sha256:${"0".repeat(64)}` }, bytes))
      .toThrow(/SHA-256/u);
    expect(() => cache.put({ ...descriptor(bytes), mediaType: "text/html" }, bytes))
      .toThrow(/media type derived/u);
    const invalid = new Uint8Array(16).fill(7);
    expect(() => cache.put(descriptor(invalid), invalid)).toThrow(/signature/u);
    cache.put(descriptor(bytes), bytes);
    expect(() => cache.read({
      digest: descriptor(bytes).digest,
      range: { start: 15, endExclusive: 17 },
    })).toThrow(/not satisfiable/u);
    expect(() => cache.read({ digest: descriptor(bytes).digest, url: "https://example.invalid" }))
      .toThrow(/unknown field/u);
  });

  it("retains verified Blobs without a full Uint8Array copy and reports a bounded peak", async () => {
    const first = glb(20, 1);
    const second = glb(20, 2);
    const cache = new BrowserXrAssetCache({ maximumBytes: 24, maximumEntries: 1 });
    const firstBlob = new Blob([
      first.buffer.slice(first.byteOffset, first.byteOffset + first.byteLength) as ArrayBuffer,
    ], { type: "model/gltf-binary" });
    const secondBlob = new Blob([
      second.buffer.slice(second.byteOffset, second.byteOffset + second.byteLength) as ArrayBuffer,
    ], { type: "model/gltf-binary" });

    await expect(cache.putBlob(descriptor(first), firstBlob)).resolves.toMatchObject({
      cached: true,
      deduplicated: false,
    });
    const retained = cache.readBlob({ digest: descriptor(first).digest });
    expect(retained?.blob.size).toBe(first.byteLength);
    // Blob-backed runtime entries intentionally do not materialize the legacy
    // synchronous byte-copy API.
    expect(cache.read({ digest: descriptor(first).digest })).toBeUndefined();

    await expect(cache.putBlob(descriptor(second), secondBlob)).resolves.toMatchObject({
      cached: true,
      evictedDigests: [descriptor(first).digest],
    });
    expect(cache.stats()).toEqual({
      entryCount: 1,
      totalBytes: 20,
      peakRetainedBytes: 20,
      maximumBytes: 24,
      maximumEntries: 1,
    });
    expect(cache.stats().peakRetainedBytes).toBeLessThanOrEqual(cache.stats().maximumBytes);
  });
});
