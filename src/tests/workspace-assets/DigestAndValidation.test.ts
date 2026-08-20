import { describe, expect, it } from "vitest";
import {
  assetIdFromDigest,
  digestBlobSha256,
  parseRealityAssetCalibration,
  parseRealityAssetCandidate,
  parseRealityAssetDescriptor,
  sha256DigestBytes,
  validateRealityAssetCalibration,
  validateRealityAssetDescriptor,
} from "../../workspace/assets";

const EMPTY_SHA = "sha256:e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";
const ABC_SHA = "sha256:ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad";

function descriptor() {
  const digest = ABC_SHA;
  return {
    version: 1,
    assetId: assetIdFromDigest(digest),
    digest,
    format: "ply",
    formatVersion: 1,
    mediaType: "application/ply",
    byteLength: 3,
    splatCount: 1,
    sphericalHarmonicsDegree: 0,
    model: "gaussian-3d",
    antialiased: null,
    coordinateSystem: { system: "UNKNOWN", provenance: "unknown" },
    engineeringAuthority: "visual_only",
  } as const;
}

describe("Reality asset hashing and durable contracts", () => {
  it("computes canonical SHA-256 incrementally", async () => {
    expect(sha256DigestBytes(new Uint8Array())).toBe(EMPTY_SHA);
    expect(sha256DigestBytes(new TextEncoder().encode("abc"))).toBe(ABC_SHA);
    await expect(digestBlobSha256(new Blob(["abc"]), { chunkBytes: 1024 })).resolves.toBe(ABC_SHA);
  });

  it("honors cancellation without exposing bytes", async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(digestBlobSha256(new Blob(["abc"]), { signal: controller.signal }))
      .rejects.toMatchObject({ code: "aborted" });
  });

  it("strictly validates content address, media type, and visual-only authority", () => {
    expect(validateRealityAssetDescriptor(descriptor())).toEqual([]);
    expect(parseRealityAssetDescriptor(descriptor())).toEqual(descriptor());
    expect(validateRealityAssetDescriptor({ ...descriptor(), extra: "not allowed" }))
      .toEqual(expect.arrayContaining([expect.objectContaining({ code: "unknown_property" })]));
    expect(validateRealityAssetDescriptor({ ...descriptor(), assetId: `ra_${"0".repeat(64)}` }))
      .toEqual(expect.arrayContaining([expect.objectContaining({ code: "inconsistent_value" })]));
    expect(validateRealityAssetDescriptor({ ...descriptor(), engineeringAuthority: "collision" }))
      .toEqual(expect.arrayContaining([expect.objectContaining({ path: "$.engineeringAuthority" })]));
    expect(validateRealityAssetDescriptor({ ...descriptor(), sphericalHarmonicsDegree: "0" }))
      .toEqual(expect.arrayContaining([expect.objectContaining({ path: "$.sphericalHarmonicsDegree" })]));
    expect(validateRealityAssetDescriptor({ ...descriptor(), formatVersion: 2 }))
      .toEqual(expect.arrayContaining([expect.objectContaining({ path: "$.formatVersion" })]));
    expect(() => parseRealityAssetCandidate({ descriptor: descriptor(), warnings: ["private-file-name.ply"] }))
      .toThrow(expect.objectContaining({ code: "invalid_descriptor" }));
  });

  it("keeps metric claims impossible until calibration is coherent", () => {
    const uncalibrated = {
      version: 1,
      status: "uncalibrated",
      sourceCoordinateSystem: "UNKNOWN",
      targetCoordinateSystem: "RUB",
      metersPerSourceUnit: null,
    } as const;
    expect(parseRealityAssetCalibration(uncalibrated)).toEqual(uncalibrated);
    const reference = {
      version: 1,
      status: "reference-distance",
      sourceCoordinateSystem: "RDF",
      targetCoordinateSystem: "RUB",
      metersPerSourceUnit: 2,
      sourceDistance: 3,
      referenceDistanceM: 6,
    } as const;
    expect(parseRealityAssetCalibration(reference)).toEqual(reference);
    expect(validateRealityAssetCalibration({ ...reference, metersPerSourceUnit: 3 }))
      .toEqual(expect.arrayContaining([expect.objectContaining({ code: "inconsistent_value" })]));
    expect(validateRealityAssetCalibration({ ...reference, sourceCoordinateSystem: "UNKNOWN" }))
      .toEqual(expect.arrayContaining([expect.objectContaining({ path: "$.sourceCoordinateSystem" })]));
  });
});
