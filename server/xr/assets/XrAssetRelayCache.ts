import { createHash, timingSafeEqual } from "node:crypto";
import {
  XR_ASSET_LIMITS,
  XR_ASSET_RUNTIME_LIMITS,
  type XrAssetDescriptor,
  type XrAssetDigest,
  type XrAssetReadRequest,
} from "../../../src/xr/assets/contracts";
import { assertXrAssetContentSignature } from "../../../src/xr/assets/signature";
import {
  XrAssetValidationError,
  createXrAssetDescriptor,
  parseXrAssetDigest,
  parseXrAssetPutRequest,
  parseXrAssetReadRequest,
} from "../../../src/xr/assets/validation";

const DEFAULT_MAXIMUM_ASSET_BYTES = XR_ASSET_RUNTIME_LIMITS.relayMaximumAssetBytes;
const DEFAULT_MAXIMUM_AGGREGATE_BYTES = XR_ASSET_RUNTIME_LIMITS.relayMaximumAggregateBytes;
const DEFAULT_MAXIMUM_ASSETS = 128;
const DEFAULT_MAXIMUM_TTL_MS = 24 * 60 * 60_000;
const DEFAULT_STORAGE_CHUNK_BYTES = 256 * 1024;
const DEFAULT_MAXIMUM_SOURCE_CHUNKS = 65_536;
const ABSOLUTE_MAXIMUM_AGGREGATE_BYTES = 8 * 1024 * 1024 * 1024;
const ABSOLUTE_MAXIMUM_ASSETS = 2_048;
const ABSOLUTE_MAXIMUM_TTL_MS = 7 * 24 * 60 * 60_000;
const ABSOLUTE_MAXIMUM_SOURCE_CHUNKS = 1_000_000;
const MAXIMUM_SIGNATURE_BYTES = 64 * 1024;

export type XrAssetByteSource =
  | Uint8Array
  | Iterable<Uint8Array>
  | AsyncIterable<Uint8Array>;

export type XrAssetRelayCacheOptions = Readonly<{
  maximumAssetBytes?: number;
  maximumAggregateBytes?: number;
  maximumAssets?: number;
  maximumTtlMs?: number;
  storageChunkBytes?: number;
  maximumSourceChunks?: number;
  now?: () => number;
}>;

export type XrAssetRelayOperationOptions = Readonly<{
  signal?: AbortSignal;
}>;

export type XrAssetRelayMetadata = Readonly<{
  descriptor: XrAssetDescriptor;
  createdAtMs: number;
  expiresAtMs: number;
}>;

export type XrAssetRelayPutResult = XrAssetRelayMetadata & Readonly<{
  deduplicated: boolean;
  evictedDigests: readonly XrAssetDigest[];
}>;

export type XrAssetRelayReadResult = XrAssetRelayMetadata & Readonly<{
  status: "full" | "partial";
  etag: string;
  cacheControl: "private, max-age=31536000, immutable";
  acceptRanges: "bytes";
  contentLength: number;
  range: Readonly<{ start: number; endExclusive: number; totalBytes: number }>;
  stream(): AsyncIterable<Uint8Array>;
}>;

type AssetRecord = {
  descriptor: XrAssetDescriptor;
  chunks: readonly Uint8Array[];
  createdAtMs: number;
  expiresAtMs: number;
  accessOrdinal: number;
};

export class XrAssetRelayError extends Error {
  constructor(
    readonly code:
      | "aborted"
      | "invalid_byte_source"
      | "source_chunk_limit_exceeded"
      | "asset_too_large"
      | "byte_length_mismatch"
      | "digest_mismatch"
      | "metadata_conflict"
      | "not_found"
      | "range_not_satisfiable",
    message: string,
    options: { cause?: unknown } = {},
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = "XrAssetRelayError";
  }
}

function checkedInteger(
  value: number | undefined,
  fallback: number,
  minimum: number,
  maximum: number,
  label: string,
): number {
  const result = value ?? fallback;
  if (!Number.isSafeInteger(result) || result < minimum || result > maximum) {
    throw new RangeError(`${label} must be a safe integer between ${minimum} and ${maximum}`);
  }
  return result;
}

function checkedNow(now: () => number): number {
  const value = now();
  if (!Number.isSafeInteger(value) || value < 0) throw new Error("XR asset relay clock returned an invalid time");
  return value;
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new XrAssetRelayError("aborted", "XR asset relay operation was aborted");
}

function isIterable(value: unknown): value is Iterable<unknown> {
  return typeof value === "object" && value !== null
    && typeof (value as { [Symbol.iterator]?: unknown })[Symbol.iterator] === "function";
}

function isAsyncIterable(value: unknown): value is AsyncIterable<unknown> {
  return typeof value === "object" && value !== null
    && typeof (value as { [Symbol.asyncIterator]?: unknown })[Symbol.asyncIterator] === "function";
}

async function* sourceChunks(source: XrAssetByteSource): AsyncIterable<unknown> {
  if (source instanceof Uint8Array) {
    yield source;
    return;
  }
  if (isAsyncIterable(source)) {
    for await (const chunk of source) yield chunk;
    return;
  }
  if (isIterable(source)) {
    for (const chunk of source) yield chunk;
    return;
  }
  throw new XrAssetRelayError("invalid_byte_source", "XR asset bytes must be a byte array or byte-chunk iterable");
}

function prefixBytes(chunks: readonly Uint8Array[], byteLength: number): Uint8Array {
  const length = Math.min(byteLength, MAXIMUM_SIGNATURE_BYTES);
  const result = new Uint8Array(length);
  let written = 0;
  for (const chunk of chunks) {
    if (written >= length) break;
    const count = Math.min(chunk.byteLength, length - written);
    result.set(chunk.subarray(0, count), written);
    written += count;
  }
  return result;
}

function metadata(record: AssetRecord): XrAssetRelayMetadata {
  return Object.freeze({
    descriptor: record.descriptor,
    createdAtMs: record.createdAtMs,
    expiresAtMs: record.expiresAtMs,
  });
}

function sameMetadata(left: XrAssetDescriptor, right: XrAssetDescriptor): boolean {
  return left.digest === right.digest
    && left.format === right.format
    && left.byteLength === right.byteLength;
}

async function* immutableRangeStream(
  chunks: readonly Uint8Array[],
  start: number,
  endExclusive: number,
): AsyncIterable<Uint8Array> {
  let chunkStart = 0;
  for (const chunk of chunks) {
    const chunkEnd = chunkStart + chunk.byteLength;
    if (chunkEnd > start && chunkStart < endExclusive) {
      const localStart = Math.max(0, start - chunkStart);
      const localEnd = Math.min(chunk.byteLength, endExclusive - chunkStart);
      yield chunk.slice(localStart, localEnd);
    }
    chunkStart = chunkEnd;
    if (chunkStart >= endExclusive) return;
  }
}

/**
 * Bounded in-memory content relay. It exposes transport-neutral metadata plus
 * a range stream; an HTTP adapter may map those fields to immutable responses.
 */
export class XrAssetRelayCache {
  readonly #maximumAssetBytes: number;
  readonly #maximumAggregateBytes: number;
  readonly #maximumAssets: number;
  readonly #maximumTtlMs: number;
  readonly #storageChunkBytes: number;
  readonly #maximumSourceChunks: number;
  readonly #now: () => number;
  readonly #records = new Map<XrAssetDigest, AssetRecord>();
  #aggregateBytes = 0;
  #accessOrdinal = 0;

  constructor(options: XrAssetRelayCacheOptions = {}) {
    this.#maximumAssetBytes = checkedInteger(
      options.maximumAssetBytes,
      DEFAULT_MAXIMUM_ASSET_BYTES,
      1,
      XR_ASSET_LIMITS.maximumAssetBytes,
      "maximumAssetBytes",
    );
    this.#maximumAggregateBytes = checkedInteger(
      options.maximumAggregateBytes,
      DEFAULT_MAXIMUM_AGGREGATE_BYTES,
      1,
      ABSOLUTE_MAXIMUM_AGGREGATE_BYTES,
      "maximumAggregateBytes",
    );
    if (this.#maximumAssetBytes > this.#maximumAggregateBytes) {
      throw new RangeError("maximumAssetBytes cannot exceed maximumAggregateBytes");
    }
    this.#maximumAssets = checkedInteger(
      options.maximumAssets,
      DEFAULT_MAXIMUM_ASSETS,
      1,
      ABSOLUTE_MAXIMUM_ASSETS,
      "maximumAssets",
    );
    this.#maximumTtlMs = checkedInteger(
      options.maximumTtlMs,
      DEFAULT_MAXIMUM_TTL_MS,
      1,
      ABSOLUTE_MAXIMUM_TTL_MS,
      "maximumTtlMs",
    );
    this.#storageChunkBytes = checkedInteger(
      options.storageChunkBytes,
      DEFAULT_STORAGE_CHUNK_BYTES,
      1,
      1024 * 1024,
      "storageChunkBytes",
    );
    this.#maximumSourceChunks = checkedInteger(
      options.maximumSourceChunks,
      DEFAULT_MAXIMUM_SOURCE_CHUNKS,
      1,
      ABSOLUTE_MAXIMUM_SOURCE_CHUNKS,
      "maximumSourceChunks",
    );
    this.#now = options.now ?? Date.now;
    checkedNow(this.#now);
  }

  async put(
    requestValue: unknown,
    source: XrAssetByteSource,
    options: XrAssetRelayOperationOptions = {},
  ): Promise<XrAssetRelayPutResult> {
    const request = parseXrAssetPutRequest(requestValue, this.#maximumTtlMs);
    if (request.byteLength > this.#maximumAssetBytes || request.byteLength > this.#maximumAggregateBytes) {
      throw new XrAssetRelayError("asset_too_large", "XR asset exceeds the relay cache byte budget");
    }
    throwIfAborted(options.signal);
    const hash = createHash("sha256");
    const chunks: Uint8Array[] = [];
    let pending = new Uint8Array(this.#storageChunkBytes);
    let pendingLength = 0;
    let receivedBytes = 0;
    let receivedChunks = 0;

    try {
      for await (const rawChunk of sourceChunks(source)) {
        throwIfAborted(options.signal);
        receivedChunks += 1;
        if (receivedChunks > this.#maximumSourceChunks) {
          throw new XrAssetRelayError(
            "source_chunk_limit_exceeded",
            "XR asset source exceeded the bounded chunk count",
          );
        }
        if (!(rawChunk instanceof Uint8Array)) {
          throw new XrAssetRelayError("invalid_byte_source", "XR asset source yielded a non-byte chunk");
        }
        if (rawChunk.byteLength === 0) continue;
        receivedBytes += rawChunk.byteLength;
        if (!Number.isSafeInteger(receivedBytes)
          || receivedBytes > request.byteLength
          || receivedBytes > this.#maximumAssetBytes) {
          throw new XrAssetRelayError("asset_too_large", "XR asset source exceeded its declared byte budget");
        }
        hash.update(rawChunk);
        let sourceOffset = 0;
        while (sourceOffset < rawChunk.byteLength) {
          const count = Math.min(this.#storageChunkBytes - pendingLength, rawChunk.byteLength - sourceOffset);
          pending.set(rawChunk.subarray(sourceOffset, sourceOffset + count), pendingLength);
          pendingLength += count;
          sourceOffset += count;
          if (pendingLength === this.#storageChunkBytes) {
            chunks.push(pending);
            pending = new Uint8Array(this.#storageChunkBytes);
            pendingLength = 0;
          }
        }
      }
    } catch (error) {
      if (error instanceof XrAssetRelayError || error instanceof XrAssetValidationError) throw error;
      // Do not propagate iterator messages: an upstream stream error may contain
      // request credentials and this core must remain safe for ordinary logging.
      throw new XrAssetRelayError("invalid_byte_source", "XR asset byte stream failed");
    }
    throwIfAborted(options.signal);
    if (receivedBytes !== request.byteLength) {
      throw new XrAssetRelayError("byte_length_mismatch", "XR asset source did not match its declared byte length");
    }
    if (pendingLength > 0) chunks.push(pending.slice(0, pendingLength));
    const actual = hash.digest();
    const expected = Buffer.from(request.digest.slice("sha256:".length), "hex");
    if (actual.byteLength !== expected.byteLength || !timingSafeEqual(actual, expected)) {
      throw new XrAssetRelayError("digest_mismatch", "XR asset source did not match its declared SHA-256");
    }
    assertXrAssetContentSignature(request.format, prefixBytes(chunks, receivedBytes), receivedBytes);
    const descriptor = createXrAssetDescriptor(request);

    const now = checkedNow(this.#now);
    this.#sweepAt(now);
    const existing = this.#records.get(request.digest);
    if (existing) {
      if (!sameMetadata(existing.descriptor, descriptor)) {
        throw new XrAssetRelayError("metadata_conflict", "XR asset identity conflicts with stored metadata");
      }
      existing.expiresAtMs = Math.max(existing.expiresAtMs, now + request.ttlMs);
      existing.accessOrdinal = ++this.#accessOrdinal;
      return Object.freeze({
        ...metadata(existing),
        deduplicated: true,
        evictedDigests: Object.freeze([]),
      });
    }

    const evictedDigests = this.#makeCapacity(request.byteLength);
    const record: AssetRecord = {
      descriptor,
      chunks: Object.freeze(chunks),
      createdAtMs: now,
      expiresAtMs: now + request.ttlMs,
      accessOrdinal: ++this.#accessOrdinal,
    };
    this.#records.set(request.digest, record);
    this.#aggregateBytes += request.byteLength;
    return Object.freeze({
      ...metadata(record),
      deduplicated: false,
      evictedDigests: Object.freeze(evictedDigests),
    });
  }

  head(digestValue: unknown): XrAssetRelayMetadata | undefined {
    const digest = parseXrAssetDigest(digestValue);
    this.#sweepAt(checkedNow(this.#now));
    const record = this.#records.get(digest);
    if (!record) return undefined;
    record.accessOrdinal = ++this.#accessOrdinal;
    return metadata(record);
  }

  open(requestValue: unknown): XrAssetRelayReadResult {
    const request = parseXrAssetReadRequest(requestValue);
    this.#sweepAt(checkedNow(this.#now));
    const record = this.#records.get(request.digest);
    if (!record) throw new XrAssetRelayError("not_found", "XR asset is not present in the relay cache");
    const { start, endExclusive } = this.#resolveRange(request, record.descriptor.byteLength);
    record.accessOrdinal = ++this.#accessOrdinal;
    const responseMetadata = metadata(record);
    const responseRange = Object.freeze({
      start,
      endExclusive,
      totalBytes: record.descriptor.byteLength,
    });
    return Object.freeze({
      ...responseMetadata,
      status: request.range ? "partial" : "full",
      etag: `"${record.descriptor.digest}"`,
      cacheControl: "private, max-age=31536000, immutable",
      acceptRanges: "bytes",
      contentLength: endExclusive - start,
      range: responseRange,
      stream: () => immutableRangeStream(record.chunks, start, endExclusive),
    });
  }

  delete(digestValue: unknown): boolean {
    const digest = parseXrAssetDigest(digestValue);
    const record = this.#records.get(digest);
    if (!record) return false;
    this.#deleteRecord(record);
    return true;
  }

  sweep(): readonly XrAssetDigest[] {
    return Object.freeze(this.#sweepAt(checkedNow(this.#now)));
  }

  /** Bounded reconciliation view for sidecar authorization metadata. */
  residentDigests(): readonly XrAssetDigest[] {
    this.#sweepAt(checkedNow(this.#now));
    return Object.freeze([...this.#records.keys()]);
  }

  stats(): Readonly<{
    assetCount: number;
    aggregateBytes: number;
    maximumAssetBytes: number;
    maximumAggregateBytes: number;
    maximumAssets: number;
  }> {
    this.#sweepAt(checkedNow(this.#now));
    return Object.freeze({
      assetCount: this.#records.size,
      aggregateBytes: this.#aggregateBytes,
      maximumAssetBytes: this.#maximumAssetBytes,
      maximumAggregateBytes: this.#maximumAggregateBytes,
      maximumAssets: this.#maximumAssets,
    });
  }

  #resolveRange(request: XrAssetReadRequest, totalBytes: number): { start: number; endExclusive: number } {
    const start = request.range?.start ?? 0;
    const endExclusive = request.range?.endExclusive ?? totalBytes;
    if (start >= totalBytes || endExclusive > totalBytes) {
      throw new XrAssetRelayError("range_not_satisfiable", "Requested XR asset byte range is not satisfiable");
    }
    return { start, endExclusive };
  }

  #makeCapacity(incomingBytes: number): XrAssetDigest[] {
    const evicted: XrAssetDigest[] = [];
    while (this.#records.size >= this.#maximumAssets
      || this.#aggregateBytes + incomingBytes > this.#maximumAggregateBytes) {
      const oldest = [...this.#records.values()]
        .sort((left, right) => left.accessOrdinal - right.accessOrdinal)[0];
      if (!oldest) break;
      evicted.push(oldest.descriptor.digest);
      this.#deleteRecord(oldest);
    }
    return evicted;
  }

  #sweepAt(now: number): XrAssetDigest[] {
    const removed: XrAssetDigest[] = [];
    for (const record of this.#records.values()) {
      if (record.expiresAtMs <= now) {
        removed.push(record.descriptor.digest);
        this.#deleteRecord(record);
      }
    }
    return removed;
  }

  #deleteRecord(record: AssetRecord): void {
    if (!this.#records.delete(record.descriptor.digest)) return;
    this.#aggregateBytes -= record.descriptor.byteLength;
  }
}

export function isXrAssetValidationError(error: unknown): error is XrAssetValidationError {
  return error instanceof XrAssetValidationError;
}
