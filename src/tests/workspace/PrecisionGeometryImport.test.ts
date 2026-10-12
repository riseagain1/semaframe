// @vitest-environment node
import { describe, expect, it } from "vitest";
import { importMeasurementGeometry, parseMeasurementGeometrySource } from "../../workspace/precision/geometryImport";
import { exportMeasurementGeometry, exportPrecisionEvidenceBundle, importPrecisionEvidenceBundle } from "../../workspace/precision/geometryExport";
import { createPrecisionStudy } from "../../workspace/precision/validation";

describe("bounded measurement geometry import", () => {
  it("preserves OBJ positions, deterministically triangulates convex faces and hashes exact bytes", () => {
    const source = "mtllib ../../private/file.mtl\nv 0 0 0\nv 2 0 0\nv 2 1 0\nv 0 1 0\nf -4 -3 -2 -1\n";
    const geometry = parseMeasurementGeometrySource(source, "obj");
    expect(geometry.positions).toEqual([[0, 0, 0], [2, 0, 0], [2, 1, 0], [0, 1, 0]]);
    expect(geometry.triangles).toEqual([[0, 1, 2], [0, 2, 3]]);
    expect(geometry.sourceDigest).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(geometry.sourceDigest).toBe(parseMeasurementGeometrySource(source, "obj").sourceDigest);
    expect(geometry.warnings.join(" ")).toContain("no paths or URLs were loaded");
  });

  it.each([
    "v 0 0 0\nv NaN 0 0\nv 0 1 0\nf 1 2 3",
    "v 0 0 0\nv 1 0 0\nv 0 1 0\nf 0 2 3",
    "v 0 0 0\nv 1 0 0\nv 0 1 0\nf 1 2 4",
    "v 0 0 0\nv 1 0 0\nv 0 1 0\nf 1 1 2",
    "v 0 0 0\nv 1 0 0\nv 1 1 1\nv 0 1 0\nf 1 2 3 4",
    "v 0 0 0\nv 2 0 0\nv 1 0.1 0\nv 2 2 0\nv 0 2 0\nf 1 2 3 4 5",
    "v 0 0 0\nv 1 0 0\nv 0 1 0\ncall https://example.com/code",
  ])("rejects malformed/unsupported OBJ without repairing the measurement silently", (source) => {
    expect(() => parseMeasurementGeometrySource(source, "obj")).toThrow();
  });

  it("parses ordinary ASCII mesh PLY and refuses Gaussian properties", () => {
    const source = "ply\nformat ascii 1.0\nelement vertex 3\nproperty double x\nproperty double y\nproperty double z\nelement face 1\nproperty list uchar int vertex_indices\nend_header\n0 0 0\n1 0 0\n0 1 0\n3 0 1 2\n";
    expect(parseMeasurementGeometrySource(source, "ply").triangles).toEqual([[0, 1, 2]]);
    expect(() => parseMeasurementGeometrySource(source.replace("property double z", "property double z\nproperty float f_dc_0"), "ply")).toThrow(/Gaussian/);
    expect(() => parseMeasurementGeometrySource(source + "extra", "ply")).toThrow(/trailing/);
    expect(() => parseMeasurementGeometrySource(source.replace("3 0 1 2", "255 0 1 2"), "ply")).toThrow(/face size/);
  });

  it.each([true, false])("preserves binary float64 PLY without converting coordinates to float32 (little=%s)", (little) => {
    const header = new TextEncoder().encode(`ply\nformat binary_${little ? "little" : "big"}_endian 1.0\nelement vertex 3\nproperty double x\nproperty double y\nproperty double z\nend_header\n`);
    const bytes = new Uint8Array(header.length + 9 * 8); bytes.set(header);
    const values = [1_000_000.00001, 0, 0, 1_000_000.00002, 0, 0, 1_000_000.00001, 0.00001, 0];
    const view = new DataView(bytes.buffer);
    values.forEach((value, index) => view.setFloat64(header.length + index * 8, value, little));
    const geometry = parseMeasurementGeometrySource(bytes, "ply");
    expect(geometry.positions[0]![0]).toBe(values[0]);
    expect(geometry.positions[1]![0]).toBe(values[3]);
    expect(() => parseMeasurementGeometrySource(bytes.subarray(0, bytes.length - 1), "ply")).toThrow(/Truncated/);
  });

  it("accepts typed XYZ CSV, refuses formulas, unknown columns and silent downsampling", () => {
    expect(parseMeasurementGeometrySource("x,y,z\n0,0,0\n1,0,0\n0,1,0", "xyz-csv").positions).toHaveLength(3);
    expect(() => parseMeasurementGeometrySource("x,y,z\n=1,0,0\n1,0,0\n0,1,0", "xyz-csv")).toThrow();
    expect(() => parseMeasurementGeometrySource("x,y,z,intensity\n0,0,0,1", "xyz-csv")).toThrow();
    expect(() => parseMeasurementGeometrySource("x,y,z\n" + "0,0,0\n".repeat(25_001), "xyz-csv")).toThrow(/no automatic downsampling/);
  });

  it("requires a declared coordinate basis and never invents a metric scale", () => {
    const input = { data: "x,y,z\n0,0,0\n1,0,0\n0,1,0", format: "xyz-csv" as const, geometryId: "source", coordinateBasis: "RUB" as const, provenance: "Imported scanner data; basis supplied by scanner operator" };
    expect(importMeasurementGeometry(input).units).toBe("unknown");
    expect(importMeasurementGeometry({ ...input, units: "millimetre" }).positions[1]).toEqual([1, 0, 0]);
    expect(() => importMeasurementGeometry({ ...input, coordinateBasis: "UNKNOWN" as "RUB" })).toThrow(/coordinate basis/);
  });

  it.each(["obj", "ply"] as const)("exports %s exact coordinates and a provenance sidecar contract", (format) => {
    const geometry = importMeasurementGeometry({ data: "v 0 0 0\nv 0.12345678901234 0 0\nv 0 1 0\nf 1 2 3", format: "obj", geometryId: "source", coordinateBasis: "RUB", units: "metre", provenance: "Known fixture" });
    const exported = exportMeasurementGeometry(geometry, format);
    const reread = parseMeasurementGeometrySource(exported.text, format);
    expect(reread.positions).toEqual(geometry.positions);
    expect(reread.triangles).toEqual(geometry.triangles);
    expect(exported.requiresMetadataSidecar).toBe(true);
    expect(exported.sourceSha256).toBe(geometry.source.sha256);
    expect(() => exportMeasurementGeometry({ ...geometry, triangles: [[0, 1, 999]] }, format)).toThrow();
  });

  it("rejects self-intersecting star polygons even when all local turns agree", () => {
    const points = Array.from({ length: 5 }, (_, index) => `v ${Math.cos(index / 5 * 2 * Math.PI)} ${Math.sin(index / 5 * 2 * Math.PI)} 0`);
    expect(() => parseMeasurementGeometrySource([...points, "f 1 3 5 2 4"].join("\n"), "obj")).toThrow(/Self-intersecting/);
  });

  it("round-trips self-contained measurement evidence but never trusts an imported pass label", () => {
    const geometry = importMeasurementGeometry({ data: "x,y,z\n0,0,0\n1,0,0\n0,1,0", format: "xyz-csv", geometryId: "source", coordinateBasis: "RUB", units: "metre", provenance: "Known fixture" });
    const bundle = exportPrecisionEvidenceBundle(createPrecisionStudy(geometry));
    expect(importPrecisionEvidenceBundle(JSON.stringify(bundle))).toEqual(bundle);
    expect(importPrecisionEvidenceBundle({ ...bundle, report: { status: "pass_for_scope" } }).report.status).toBe("unverified");
    expect(() => importPrecisionEvidenceBundle({ ...bundle, measurementPly: { ...bundle.measurementPly, text: bundle.measurementPly.text + "garbage" } })).toThrow(/does not match/);
    expect(() => importPrecisionEvidenceBundle({ ...bundle, study: { ...bundle.study, geometry: { ...geometry, positions: [[0, 0, 0], [2, 0, 0], [0, 1, 0]] } } })).toThrow(/does not match/);
  });
});
