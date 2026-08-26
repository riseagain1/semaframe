// @vitest-environment node

import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  XrAssetRelayCache,
  XrAssetRelayError,
  type XrAssetByteSource,
} from "../../../server/xr/assets";
import {
  XR_ASSET_CONTRACT_VERSION,
  XrAssetValidationError,
  type XrAssetDigest,
  type XrAssetFormat,
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

function digest(bytes: Uint8Array): XrAssetDigest {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

function request(bytes: Uint8Array, ttlMs = 100, format: XrAssetFormat = "mesh-glb") {
  return {
    version: XR_ASSET_CONTRACT_VERSION,
    digest: digest(bytes),
    format,
    byteLength: bytes.byteLength,
    ttlMs,
  } as const;
}

async function collect(source: AsyncIterable<Uint8Array>): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  let length = 0;
  for await (const chunk of source) {
    chunks.push(chunk);
    length += chunk.byteLength;
  }
  const result = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return result;
}

describe("XrAssetRelayCache", () => {
  it("verifies streamed SHA-256 bytes and exposes immutable full/range reads", async () => {
    const bytes = glb(31, 7);
    const relay = new XrAssetRelayCache({
      maximumAssetBytes: 64,
      maximumAggregateBytes: 128,
      storageChunkBytes: 5,
      maximumTtlMs: 1_000,
      now: () => 100,
    });
    async function* stream() {
      yield bytes.subarray(0, 2);
      yield bytes.subarray(2, 13);
      yield bytes.subarray(13);
    }
    const stored = await relay.put(request(bytes), stream());
    expect(stored).toMatchObject({
      deduplicated: false,
      createdAtMs: 100,
      expiresAtMs: 200,
      descriptor: {
        digest: digest(bytes),
        mediaType: "model/gltf-binary",
        representation: "mesh",
      },
    });

    const full = relay.open({ digest: digest(bytes) });
    expect(full).toMatchObject({
      status: "full",
      acceptRanges: "bytes",
      contentLength: bytes.byteLength,
      cacheControl: "private, max-age=31536000, immutable",
      range: { start: 0, endExclusive: bytes.byteLength, totalBytes: bytes.byteLength },
    });
    const returned = await collect(full.stream());
    expect(returned).toEqual(bytes);
    returned[12] = 255;
    expect(await collect(relay.open({ digest: digest(bytes) }).stream())).toEqual(bytes);

    const partial = relay.open({
      digest: digest(bytes),
      range: { start: 10, endExclusive: 19 },
    });
    expect(partial).toMatchObject({ status: "partial", contentLength: 9 });
    expect(await collect(partial.stream())).toEqual(bytes.slice(10, 19));
  });

  it("fails closed on exact-input, length, digest, signature, chunk, and abort violations", async () => {
    const bytes = glb(20, 3);
    const relay = new XrAssetRelayCache({
      maximumAssetBytes: 24,
      maximumAggregateBytes: 48,
      maximumSourceChunks: 2,
      maximumTtlMs: 1_000,
    });
    const secret = "raw-secret-must-not-appear";
    let exactError: unknown;
    try {
      await relay.put({ ...request(bytes), sourceUrl: "https://example.invalid", bearerToken: secret }, bytes);
    } catch (error) {
      exactError = error;
    }
    expect(exactError).toBeInstanceOf(XrAssetValidationError);
    expect(String(exactError)).not.toContain(secret);
    expect(relay.stats().assetCount).toBe(0);

    await expect(relay.put({ ...request(bytes), byteLength: 21 }, bytes))
      .rejects.toMatchObject({ code: "byte_length_mismatch" });
    await expect(relay.put({ ...request(bytes), digest: `sha256:${"0".repeat(64)}` }, bytes))
      .rejects.toMatchObject({ code: "digest_mismatch" });

    const badMagic = new Uint8Array(20).fill(1);
    await expect(relay.put(request(badMagic), badMagic)).rejects.toBeInstanceOf(XrAssetValidationError);

    const threeChunks: XrAssetByteSource = [bytes.subarray(0, 1), bytes.subarray(1, 2), bytes.subarray(2)];
    await expect(relay.put(request(bytes), threeChunks))
      .rejects.toMatchObject({ code: "source_chunk_limit_exceeded" });

    const invalidChunks = [bytes.subarray(0, 1), "not bytes"] as unknown as XrAssetByteSource;
    await expect(relay.put(request(bytes), invalidChunks))
      .rejects.toMatchObject({ code: "invalid_byte_source" });

    async function* failedStream() {
      throw new Error(secret);
      yield bytes;
    }
    let streamError: unknown;
    try {
      await relay.put(request(bytes), failedStream());
    } catch (error) {
      streamError = error;
    }
    expect(streamError).toMatchObject({ code: "invalid_byte_source" });
    expect(String(streamError)).not.toContain(secret);

    const controller = new AbortController();
    controller.abort();
    await expect(relay.put(request(bytes), bytes, { signal: controller.signal }))
      .rejects.toMatchObject({ code: "aborted" });

    const tooLarge = glb(25);
    await expect(relay.put(request(tooLarge), tooLarge)).rejects.toMatchObject({ code: "asset_too_large" });
    expect(relay.stats().assetCount).toBe(0);
  });

  it("derives the approved Gaussian media types from validated signatures", async () => {
    const spz = new Uint8Array(32);
    new DataView(spz.buffer).setUint32(0, 0x5053474e, true);
    new DataView(spz.buffer).setUint32(4, 4, true);
    const ply = new TextEncoder().encode("ply\nformat ascii 1.0\nelement vertex 1\nend_header\n0 0 0\n");
    const sog = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 1, 2, 3, 4]);
    const relay = new XrAssetRelayCache({
      maximumAssetBytes: 128,
      maximumAggregateBytes: 256,
      maximumTtlMs: 1_000,
    });
    await relay.put(request(spz, 100, "gaussian-spz-v4"), spz);
    await relay.put(request(ply, 100, "gaussian-ply"), ply);
    await relay.put(request(sog, 100, "gaussian-sog-v2"), sog);
    expect(relay.head(digest(spz))?.descriptor).toMatchObject({
      representation: "gaussian_splat",
      mediaType: "application/x-spz",
    });
    expect(relay.head(digest(ply))?.descriptor.mediaType).toBe("application/ply");
    expect(relay.head(digest(sog))?.descriptor.mediaType).toBe("model/vnd.sog");
  });

  it("enforces aggregate/count quotas with LRU eviction", async () => {
    const first = glb(16, 1);
    const second = glb(16, 2);
    const third = glb(16, 3);
    const relay = new XrAssetRelayCache({
      maximumAssetBytes: 16,
      maximumAggregateBytes: 32,
      maximumAssets: 2,
      maximumTtlMs: 1_000,
      now: () => 100,
    });
    await relay.put(request(first), first);
    await relay.put(request(second), second);
    relay.open({ digest: digest(first) }); // First becomes most recently used.
    const result = await relay.put(request(third), third);
    expect(result.evictedDigests).toEqual([digest(second)]);
    expect(relay.head(digest(first))).toBeDefined();
    expect(relay.head(digest(second))).toBeUndefined();
    expect(relay.head(digest(third))).toBeDefined();
    expect(relay.stats()).toMatchObject({ assetCount: 2, aggregateBytes: 32 });
  });

  it("expires entries, extends verified duplicates, and rejects unsatisfiable ranges", async () => {
    let now = 10;
    const bytes = glb(20, 5);
    const relay = new XrAssetRelayCache({
      maximumAssetBytes: 20,
      maximumAggregateBytes: 40,
      maximumTtlMs: 100,
      now: () => now,
    });
    await relay.put(request(bytes, 10), bytes);
    now = 15;
    const duplicate = await relay.put(request(bytes, 20), bytes);
    expect(duplicate).toMatchObject({ deduplicated: true, expiresAtMs: 35 });
    now = 30;
    expect(relay.sweep()).toEqual([]);
    expect(() => relay.open({
      digest: digest(bytes),
      range: { start: 19, endExclusive: 21 },
    })).toThrowError(XrAssetRelayError);
    now = 35;
    expect(relay.sweep()).toEqual([digest(bytes)]);
    expect(() => relay.open({ digest: digest(bytes) })).toThrowError(XrAssetRelayError);
    expect(relay.stats()).toMatchObject({ assetCount: 0, aggregateBytes: 0 });
  });
});
