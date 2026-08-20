import { describe, expect, it } from "vitest";
import {
  REALITY_ASSET_LIMITS,
  inspectRealityAsset,
  preflightRealityAssetFormat,
} from "../../workspace/assets";
import { asciiPly, binaryPly, sogV2, spzV4, VALID_ROW } from "./fixtures";

describe("bounded Reality asset format preflight", () => {
  it("sniffs and fully validates ASCII PLY without trusting MIME or extension", async () => {
    const blob = asciiPly([VALID_ROW, [2, -1, 4, ...VALID_ROW.slice(3)]]);
    const candidate = await inspectRealityAsset(blob);
    expect(candidate.descriptor).toMatchObject({
      format: "ply",
      splatCount: 2,
      sphericalHarmonicsDegree: 0,
      sourceBounds: { min: { x: 0, y: -1, z: 0 }, max: { x: 2, y: 0, z: 4 } },
      engineeringAuthority: "visual_only",
    });
    expect(candidate.descriptor).not.toHaveProperty("name");
    expect(candidate.descriptor).not.toHaveProperty("path");
  });

  it("validates binary PLY body size and rejects non-finite vertex values", async () => {
    await expect(preflightRealityAssetFormat(binaryPly([VALID_ROW]))).resolves.toMatchObject({ format: "ply" });
    const invalid: number[] = [...VALID_ROW];
    invalid[0] = Number.NaN;
    await expect(preflightRealityAssetFormat(binaryPly([invalid])))
      .rejects.toMatchObject({ code: "invalid_format" });
  });

  it("rejects PLY splat counts before reading a body", async () => {
    const body = new Blob([
      "ply\nformat ascii 1.0\n",
      `element vertex ${REALITY_ASSET_LIMITS.maximumSplatCount + 1}\n`,
      "property float x\nend_header\n",
    ]);
    await expect(preflightRealityAssetFormat(body)).rejects.toMatchObject({ code: "splat_limit_exceeded" });
  });

  it("checks SPZ v4 header, exact TOC streams, and embedded coordinate extensions", async () => {
    await expect(preflightRealityAssetFormat(spzV4())).resolves.toMatchObject({
      format: "spz-v4",
      splatCount: 1,
      coordinateSystem: { system: "RUB", provenance: "format-default" },
    });
    const coordinateExtension = new Uint8Array(12);
    const view = new DataView(coordinateExtension.buffer);
    view.setUint32(0, 0xadbe0003, true);
    view.setUint32(4, 4, true);
    view.setUint32(8, 6, true);
    await expect(preflightRealityAssetFormat(spzV4({ extensionBytes: coordinateExtension }))).resolves.toMatchObject({
      coordinateSystem: { system: "RDF", provenance: "embedded" },
    });
  });

  it("never silently trusts coordinates when SPZ carries an unknown extension", async () => {
    const extension = new Uint8Array(12);
    const view = new DataView(extension.buffer);
    view.setUint32(0, 0x12340001, true);
    view.setUint32(4, 4, true);
    view.setUint32(8, 42, true);
    await expect(preflightRealityAssetFormat(spzV4({ extensionBytes: extension }))).resolves.toMatchObject({
      coordinateSystem: { system: "UNKNOWN", provenance: "unknown" },
      warnings: expect.arrayContaining(["unknown_spz_extensions"]),
    });
  });

  it("validates a self-contained SOG v2 ZIP and rejects external or stray entries", async () => {
    await expect(preflightRealityAssetFormat(sogV2())).resolves.toMatchObject({
      format: "sog-v2",
      splatCount: 2,
      coordinateSystem: { system: "RUB" },
    });
    const external = sogV2((metadata) => {
      (metadata.means as { files: string[] }).files[0] = "https:external";
    });
    await expect(preflightRealityAssetFormat(external)).rejects.toMatchObject({ code: "invalid_format" });
    await expect(preflightRealityAssetFormat(sogV2(undefined, [{ name: "secret.bin", bytes: new Uint8Array([1]) }])))
      .rejects.toMatchObject({ code: "invalid_format" });
  });

  it("rejects empty, unsupported, legacy, and over-budget inputs before allocation", async () => {
    await expect(preflightRealityAssetFormat(new Blob())).rejects.toMatchObject({ code: "empty_file" });
    await expect(preflightRealityAssetFormat(new Blob(["not an asset"]))).rejects.toMatchObject({ code: "unsupported_format" });
    await expect(preflightRealityAssetFormat(new Blob([new Uint8Array([0x1f, 0x8b])]))).rejects.toMatchObject({ code: "unsupported_format" });
    const oversized = { size: REALITY_ASSET_LIMITS.maximumAssetBytes + 1 } as Blob;
    await expect(preflightRealityAssetFormat(oversized)).rejects.toMatchObject({ code: "file_too_large" });
  });
});
