import type { XrAssetFormat } from "./contracts";
import { XrAssetValidationError } from "./validation";

const MAXIMUM_PLY_HEADER_BYTES = 64 * 1024;

function startsWith(bytes: Uint8Array, expected: readonly number[]): boolean {
  return expected.every((value, index) => bytes[index] === value);
}

function invalidSignature(): never {
  throw new XrAssetValidationError(
    "inconsistent_value",
    "$.bytes",
    "content signature does not match the declared format",
  );
}

/**
 * Validates transport-level format identity without trusting a supplied MIME.
 * Full GLB length and bounded PLY header checks are included; format-specific
 * semantic preflight remains the renderer/importer's responsibility.
 */
export function assertXrAssetContentSignature(
  format: XrAssetFormat,
  bytes: Uint8Array,
  totalByteLength = bytes.byteLength,
): void {
  if (!Number.isSafeInteger(totalByteLength) || totalByteLength < 1 || bytes.byteLength > totalByteLength) {
    invalidSignature();
  }
  switch (format) {
    case "mesh-glb": { // glTF binary header: magic, version 2, total length.
      if (bytes.byteLength < 12 || !startsWith(bytes, [0x67, 0x6c, 0x54, 0x46])) invalidSignature();
      const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
      if (view.getUint32(4, true) !== 2 || view.getUint32(8, true) !== totalByteLength) invalidSignature();
      return;
    }
    case "gaussian-spz-v4": {
      if (bytes.byteLength < 8) invalidSignature();
      const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
      if (view.getUint32(0, true) !== 0x5053474e || view.getUint32(4, true) !== 4) invalidSignature();
      return;
    }
    case "gaussian-ply": {
      if (!startsWith(bytes, [0x70, 0x6c, 0x79, 0x0a])
        && !startsWith(bytes, [0x70, 0x6c, 0x79, 0x0d, 0x0a])) {
        invalidSignature();
      }
      const header = new TextDecoder("ascii", { fatal: false })
        .decode(bytes.subarray(0, Math.min(bytes.byteLength, MAXIMUM_PLY_HEADER_BYTES)));
      if (!/(?:^|\r?\n)end_header\r?\n/u.test(header)) invalidSignature();
      return;
    }
    case "gaussian-sog-v2": {
      if (bytes.byteLength < 4 || !startsWith(bytes, [0x50, 0x4b, 0x03, 0x04])) invalidSignature();
      return;
    }
  }
}
