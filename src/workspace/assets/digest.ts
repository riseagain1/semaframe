import { RealityAssetError, throwIfRealityAssetAborted } from "./errors";
import { REALITY_ASSET_LIMITS } from "./limits";
import type { RealityAssetDigest } from "./types";
import { readBlobRange } from "./blobIO";

const SHA256_INITIAL = new Uint32Array([
  0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a,
  0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
]);

const SHA256_ROUND_CONSTANTS = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

function rotateRight(value: number, count: number): number {
  return (value >>> count) | (value << (32 - count));
}

/** Small incremental SHA-256 implementation used to avoid buffering a 256 MiB Blob. */
class IncrementalSha256 {
  private readonly state = new Uint32Array(SHA256_INITIAL);
  private readonly block = new Uint8Array(64);
  private readonly schedule = new Uint32Array(64);
  private blockLength = 0;
  private bytesHashed = 0;
  private finalized = false;

  update(input: Uint8Array): void {
    if (this.finalized) throw new Error("SHA-256 has already been finalized");
    this.bytesHashed += input.byteLength;
    let offset = 0;
    while (offset < input.byteLength) {
      const count = Math.min(64 - this.blockLength, input.byteLength - offset);
      this.block.set(input.subarray(offset, offset + count), this.blockLength);
      this.blockLength += count;
      offset += count;
      if (this.blockLength === 64) {
        this.compress(this.block);
        this.blockLength = 0;
      }
    }
  }

  hex(): string {
    if (!this.finalized) this.finalize();
    return [...this.state].map((value) => value.toString(16).padStart(8, "0")).join("");
  }

  private finalize(): void {
    this.finalized = true;
    this.block[this.blockLength] = 0x80;
    this.blockLength += 1;
    if (this.blockLength > 56) {
      this.block.fill(0, this.blockLength);
      this.compress(this.block);
      this.blockLength = 0;
    }
    this.block.fill(0, this.blockLength, 56);
    const bitLength = this.bytesHashed * 8;
    const view = new DataView(this.block.buffer);
    view.setUint32(56, Math.floor(bitLength / 0x1_0000_0000), false);
    view.setUint32(60, bitLength >>> 0, false);
    this.compress(this.block);
    this.blockLength = 0;
  }

  private compress(block: Uint8Array): void {
    const view = new DataView(block.buffer, block.byteOffset, block.byteLength);
    for (let index = 0; index < 16; index += 1) {
      this.schedule[index] = view.getUint32(index * 4, false);
    }
    for (let index = 16; index < 64; index += 1) {
      const left = this.schedule[index - 15] ?? 0;
      const right = this.schedule[index - 2] ?? 0;
      const sigma0 = rotateRight(left, 7) ^ rotateRight(left, 18) ^ (left >>> 3);
      const sigma1 = rotateRight(right, 17) ^ rotateRight(right, 19) ^ (right >>> 10);
      this.schedule[index] = (
        (this.schedule[index - 16] ?? 0) + sigma0 + (this.schedule[index - 7] ?? 0) + sigma1
      ) >>> 0;
    }

    let a = this.state[0] ?? 0;
    let b = this.state[1] ?? 0;
    let c = this.state[2] ?? 0;
    let d = this.state[3] ?? 0;
    let e = this.state[4] ?? 0;
    let f = this.state[5] ?? 0;
    let g = this.state[6] ?? 0;
    let h = this.state[7] ?? 0;

    for (let index = 0; index < 64; index += 1) {
      const sum1 = rotateRight(e, 6) ^ rotateRight(e, 11) ^ rotateRight(e, 25);
      const choose = (e & f) ^ (~e & g);
      const temporary1 = (h + sum1 + choose + (SHA256_ROUND_CONSTANTS[index] ?? 0) + (this.schedule[index] ?? 0)) >>> 0;
      const sum0 = rotateRight(a, 2) ^ rotateRight(a, 13) ^ rotateRight(a, 22);
      const majority = (a & b) ^ (a & c) ^ (b & c);
      const temporary2 = (sum0 + majority) >>> 0;
      h = g;
      g = f;
      f = e;
      e = (d + temporary1) >>> 0;
      d = c;
      c = b;
      b = a;
      a = (temporary1 + temporary2) >>> 0;
    }

    this.state[0] = ((this.state[0] ?? 0) + a) >>> 0;
    this.state[1] = ((this.state[1] ?? 0) + b) >>> 0;
    this.state[2] = ((this.state[2] ?? 0) + c) >>> 0;
    this.state[3] = ((this.state[3] ?? 0) + d) >>> 0;
    this.state[4] = ((this.state[4] ?? 0) + e) >>> 0;
    this.state[5] = ((this.state[5] ?? 0) + f) >>> 0;
    this.state[6] = ((this.state[6] ?? 0) + g) >>> 0;
    this.state[7] = ((this.state[7] ?? 0) + h) >>> 0;
  }
}

export function sha256DigestBytes(bytes: Uint8Array): RealityAssetDigest {
  const digest = new IncrementalSha256();
  digest.update(bytes);
  return `sha256:${digest.hex()}`;
}

export type DigestRealityAssetOptions = Readonly<{
  signal?: AbortSignal;
  maximumBytes?: number;
  chunkBytes?: number;
}>;

export async function digestBlobSha256(
  blob: Blob,
  options: DigestRealityAssetOptions = {},
): Promise<RealityAssetDigest> {
  const maximumBytes = options.maximumBytes ?? REALITY_ASSET_LIMITS.maximumAssetBytes;
  const chunkBytes = options.chunkBytes ?? REALITY_ASSET_LIMITS.digestChunkBytes;
  if (!Number.isSafeInteger(maximumBytes) || maximumBytes < 1) {
    throw new RealityAssetError("invalid_descriptor", "maximumBytes must be a positive integer");
  }
  if (!Number.isSafeInteger(chunkBytes) || chunkBytes < 1024 || chunkBytes > maximumBytes) {
    throw new RealityAssetError("invalid_descriptor", "chunkBytes is outside the allowed range");
  }
  if (blob.size === 0) throw new RealityAssetError("empty_file", "Reality asset file is empty");
  if (blob.size > maximumBytes) {
    throw new RealityAssetError("file_too_large", `Reality asset exceeds the ${maximumBytes} byte limit`);
  }
  throwIfRealityAssetAborted(options.signal);
  const digest = new IncrementalSha256();
  for (let offset = 0; offset < blob.size; offset += chunkBytes) {
    throwIfRealityAssetAborted(options.signal);
    const end = Math.min(blob.size, offset + chunkBytes);
    const bytes = await readBlobRange(blob, offset, end, options.signal);
    throwIfRealityAssetAborted(options.signal);
    digest.update(bytes);
  }
  return `sha256:${digest.hex()}`;
}
