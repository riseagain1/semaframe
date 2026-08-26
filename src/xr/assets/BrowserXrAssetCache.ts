import { digestBlobSha256, sha256DigestBytes } from "../../workspace/assets/digest";
import { readBlobRange } from "../../workspace/assets/blobIO";
import {
  XR_ASSET_RUNTIME_LIMITS,
  type XrAssetDescriptor,
  type XrAssetDigest,
  type XrAssetReadRequest,
} from "./contracts";
import { assertXrAssetContentSignature } from "./signature";
import {
  XrAssetValidationError,
  parseXrAssetDescriptor,
  parseXrAssetDigest,
  parseXrAssetReadRequest,
} from "./validation";

const DEFAULT_MAXIMUM_BYTES = XR_ASSET_RUNTIME_LIMITS.browserCacheMaximumBytes;
const DEFAULT_MAXIMUM_ENTRIES = 64;
const ABSOLUTE_MAXIMUM_CACHE_BYTES = 1024 * 1024 * 1024;
const ABSOLUTE_MAXIMUM_CACHE_ENTRIES = 2_048;

type CacheEntry = {
  descriptor: XrAssetDescriptor;
  blob: Blob;
  /** Present only for the legacy synchronous byte API. */
  bytes?: Uint8Array;
  accessOrdinal: number;
};

export type BrowserXrAssetCacheOptions = Readonly<{
  maximumBytes?: number;
  maximumEntries?: number;
}>;

export type BrowserXrAssetCachePutResult = Readonly<{
  cached: boolean;
  deduplicated: boolean;
  reason?: "entry_exceeds_cache_budget";
  evictedDigests: readonly XrAssetDigest[];
}>;

export type BrowserXrAssetCacheReadResult = Readonly<{
  descriptor: XrAssetDescriptor;
  bytes: Uint8Array;
  range: Readonly<{ start: number; endExclusive: number; totalBytes: number }>;
}>;

export type BrowserXrAssetCacheBlobReadResult = Readonly<{
  descriptor: XrAssetDescriptor;
  blob: Blob;
  range: Readonly<{ start: number; endExclusive: number; totalBytes: number }>;
}>;

function checkedOption(value: number | undefined, fallback: number, maximum: number, label: string): number {
  const result = value ?? fallback;
  if (!Number.isSafeInteger(result) || result < 1 || result > maximum) {
    throw new RangeError(`${label} must be a positive bounded safe integer`);
  }
  return result;
}

function immutableBytes(value: Uint8Array | ArrayBuffer): Uint8Array {
  if (value instanceof Uint8Array) return value.slice();
  if (value instanceof ArrayBuffer) return new Uint8Array(value.slice(0));
  throw new XrAssetValidationError("invalid_type", "$.bytes", "must be a Uint8Array or ArrayBuffer");
}

function descriptorMatches(left: XrAssetDescriptor, right: XrAssetDescriptor): boolean {
  return left.digest === right.digest
    && left.format === right.format
    && left.byteLength === right.byteLength;
}

/** A network-free browser cache; callers provide already received bytes. */
export class BrowserXrAssetCache {
  readonly #maximumBytes: number;
  readonly #maximumEntries: number;
  readonly #entries = new Map<XrAssetDigest, CacheEntry>();
  #totalBytes = 0;
  #peakRetainedBytes = 0;
  #ordinal = 0;

  constructor(options: BrowserXrAssetCacheOptions = {}) {
    this.#maximumBytes = checkedOption(
      options.maximumBytes,
      DEFAULT_MAXIMUM_BYTES,
      ABSOLUTE_MAXIMUM_CACHE_BYTES,
      "maximumBytes",
    );
    this.#maximumEntries = checkedOption(
      options.maximumEntries,
      DEFAULT_MAXIMUM_ENTRIES,
      ABSOLUTE_MAXIMUM_CACHE_ENTRIES,
      "maximumEntries",
    );
  }

  put(descriptorValue: unknown, byteValue: Uint8Array | ArrayBuffer): BrowserXrAssetCachePutResult {
    const descriptor = parseXrAssetDescriptor(descriptorValue);
    const bytes = immutableBytes(byteValue);
    if (bytes.byteLength !== descriptor.byteLength) {
      throw new XrAssetValidationError("inconsistent_value", "$.bytes", "byte length does not match the descriptor");
    }
    const actualDigest = sha256DigestBytes(bytes) as XrAssetDigest;
    if (actualDigest !== descriptor.digest) {
      throw new XrAssetValidationError("inconsistent_value", "$.bytes", "SHA-256 does not match the descriptor");
    }
    assertXrAssetContentSignature(descriptor.format, bytes, bytes.byteLength);

    const blobBuffer = bytes.buffer.slice(
      bytes.byteOffset,
      bytes.byteOffset + bytes.byteLength,
    ) as ArrayBuffer;
    return this.#store(descriptor, new Blob([blobBuffer], { type: descriptor.mediaType }), bytes);
  }

  /**
   * Verifies and retains a network Blob without materializing the full payload
   * as a second Uint8Array. Digest/signature reads are bounded chunks.
   */
  async putBlob(
    descriptorValue: unknown,
    blobValue: Blob,
    signal?: AbortSignal,
  ): Promise<BrowserXrAssetCachePutResult> {
    const descriptor = parseXrAssetDescriptor(descriptorValue);
    if (!(blobValue instanceof Blob)) {
      throw new XrAssetValidationError("invalid_type", "$.blob", "must be a Blob");
    }
    if (blobValue.size !== descriptor.byteLength) {
      throw new XrAssetValidationError("inconsistent_value", "$.blob", "byte length does not match the descriptor");
    }
    if (blobValue.type && blobValue.type.toLowerCase() !== descriptor.mediaType) {
      throw new XrAssetValidationError("inconsistent_value", "$.blob", "media type does not match the descriptor");
    }
    if (descriptor.byteLength > this.#maximumBytes) return this.#oversized();
    if (signal?.aborted) throw new DOMException("XR asset caching was cancelled.", "AbortError");
    const digestMaximumBytes = Math.max(this.#maximumBytes, 1024);
    const actualDigest = await digestBlobSha256(blobValue, {
      ...(signal ? { signal } : {}),
      maximumBytes: digestMaximumBytes,
      chunkBytes: Math.min(1024 * 1024, digestMaximumBytes),
    });
    if (actualDigest !== descriptor.digest) {
      throw new XrAssetValidationError("inconsistent_value", "$.blob", "SHA-256 does not match the descriptor");
    }
    const prefix = await readBlobRange(
      blobValue,
      0,
      Math.min(blobValue.size, 64 * 1024),
      signal,
    );
    assertXrAssetContentSignature(descriptor.format, prefix, descriptor.byteLength);
    return this.#store(descriptor, blobValue);
  }

  has(digestValue: unknown): boolean {
    return this.#entries.has(parseXrAssetDigest(digestValue));
  }

  read(requestValue: unknown): BrowserXrAssetCacheReadResult | undefined {
    const request = parseXrAssetReadRequest(requestValue);
    const entry = this.#entries.get(request.digest);
    if (!entry?.bytes) return undefined;
    const { start, endExclusive } = this.#resolveRange(request, entry.descriptor.byteLength);
    entry.accessOrdinal = ++this.#ordinal;
    return Object.freeze({
      descriptor: entry.descriptor,
      bytes: entry.bytes.slice(start, endExclusive),
      range: Object.freeze({ start, endExclusive, totalBytes: entry.descriptor.byteLength }),
    });
  }

  readBlob(requestValue: unknown): BrowserXrAssetCacheBlobReadResult | undefined {
    const request = parseXrAssetReadRequest(requestValue);
    const entry = this.#entries.get(request.digest);
    if (!entry) return undefined;
    const { start, endExclusive } = this.#resolveRange(request, entry.descriptor.byteLength);
    entry.accessOrdinal = ++this.#ordinal;
    return Object.freeze({
      descriptor: entry.descriptor,
      blob: entry.blob.slice(start, endExclusive, entry.descriptor.mediaType),
      range: Object.freeze({ start, endExclusive, totalBytes: entry.descriptor.byteLength }),
    });
  }

  delete(digestValue: unknown): boolean {
    const digest = parseXrAssetDigest(digestValue);
    const entry = this.#entries.get(digest);
    if (!entry) return false;
    this.#entries.delete(digest);
    this.#totalBytes -= entry.descriptor.byteLength;
    return true;
  }

  clear(): void {
    this.#entries.clear();
    this.#totalBytes = 0;
  }

  stats(): Readonly<{
    entryCount: number;
    totalBytes: number;
    peakRetainedBytes: number;
    maximumBytes: number;
    maximumEntries: number;
  }> {
    return Object.freeze({
      entryCount: this.#entries.size,
      totalBytes: this.#totalBytes,
      peakRetainedBytes: this.#peakRetainedBytes,
      maximumBytes: this.#maximumBytes,
      maximumEntries: this.#maximumEntries,
    });
  }

  #oversized(): BrowserXrAssetCachePutResult {
    return Object.freeze({
      cached: false,
      deduplicated: false,
      reason: "entry_exceeds_cache_budget",
      evictedDigests: Object.freeze([]),
    });
  }

  #store(
    descriptor: XrAssetDescriptor,
    blob: Blob,
    bytes?: Uint8Array,
  ): BrowserXrAssetCachePutResult {
    const existing = this.#entries.get(descriptor.digest);
    if (existing) {
      if (!descriptorMatches(existing.descriptor, descriptor)) {
        throw new XrAssetValidationError(
          "inconsistent_value",
          "$.descriptor",
          "content identity conflicts with cached metadata",
        );
      }
      existing.accessOrdinal = ++this.#ordinal;
      return Object.freeze({ cached: true, deduplicated: true, evictedDigests: Object.freeze([]) });
    }
    if (descriptor.byteLength > this.#maximumBytes) return this.#oversized();
    const evicted: XrAssetDigest[] = [];
    while (this.#entries.size >= this.#maximumEntries
      || this.#totalBytes + descriptor.byteLength > this.#maximumBytes) {
      const oldest = [...this.#entries.values()]
        .sort((left, right) => left.accessOrdinal - right.accessOrdinal)[0];
      if (!oldest) break;
      this.#entries.delete(oldest.descriptor.digest);
      this.#totalBytes -= oldest.descriptor.byteLength;
      evicted.push(oldest.descriptor.digest);
    }
    this.#entries.set(descriptor.digest, {
      descriptor,
      blob,
      ...(bytes ? { bytes } : {}),
      accessOrdinal: ++this.#ordinal,
    });
    this.#totalBytes += descriptor.byteLength;
    this.#peakRetainedBytes = Math.max(this.#peakRetainedBytes, this.#totalBytes);
    return Object.freeze({
      cached: true,
      deduplicated: false,
      evictedDigests: Object.freeze(evicted),
    });
  }

  #resolveRange(request: XrAssetReadRequest, totalBytes: number): { start: number; endExclusive: number } {
    const start = request.range?.start ?? 0;
    const endExclusive = request.range?.endExclusive ?? totalBytes;
    if (start >= totalBytes || endExclusive > totalBytes) {
      throw new XrAssetValidationError("invalid_value", "$.range", "is not satisfiable for this asset");
    }
    return { start, endExclusive };
  }
}
