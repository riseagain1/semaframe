import { sha256DigestBytes } from "../assets/digest";
import { parseMeasurementGeometrySource } from "./geometryImport";
import { parsePrecisionStudy } from "./validation";
import { evaluatePrecisionStudy } from "./verification";
import type { MeasurementGeometry, PrecisionReport, PrecisionStudyV1 } from "./types";

export type MeasurementGeometryExport = Readonly<{
  format: "obj" | "ply";
  mediaType: "model/obj" | "application/ply";
  text: string;
  sha256: `sha256:${string}`;
  units: MeasurementGeometry["units"];
  coordinateBasis: "RUB";
  sourceSha256: string;
  /** OBJ/PLY comments are not an interoperable unit contract; the sidecar is authoritative. */
  requiresMetadataSidecar: true;
}>;

function validateExportGeometry(geometry: MeasurementGeometry): void {
  if (geometry.coordinateBasis !== "RUB" || !["unknown", "metre", "millimetre", "centimetre", "inch"].includes(geometry.units)
    || !/^sha256:[0-9a-f]{64}$/u.test(geometry.source.sha256)
    || !/^[A-Za-z][A-Za-z0-9._:-]{0,127}$/u.test(geometry.geometryId)
    || geometry.positions.length < 3 || geometry.positions.length > 25_000
    || geometry.positions.some((point) => point.length !== 3 || point.some((value) => !Number.isFinite(value) || Math.abs(value) > 1e9))
    || (geometry.triangles?.length ?? 0) > 50_000) throw new Error("Invalid measurement geometry for export");
}

/** Exports the measurement coordinates, never renderer LOD or visual splat centers. */
export function exportMeasurementGeometry(geometry: MeasurementGeometry, format: "obj" | "ply"): MeasurementGeometryExport {
  validateExportGeometry(geometry);
  if (format !== "obj" && format !== "ply") throw new Error("Unsupported measurement export format");
  const triangles = geometry.triangles ?? [];
  let text: string;
  if (format === "obj") {
    text = [
      "# SemaFrame measurement geometry; use the precision JSON sidecar for units and validation scope.",
      `# units ${geometry.units}`, "# coordinate_basis RUB", `# source_sha256 ${geometry.source.sha256}`,
      ...geometry.positions.map((point) => `v ${point.join(" ")}`),
      ...triangles.map((triangle) => `f ${triangle.map((index) => index + 1).join(" ")}`), "",
    ].join("\n");
  } else {
    text = [
      "ply", "format ascii 1.0", "comment SemaFrame measurement geometry; precision JSON sidecar required",
      `comment units ${geometry.units}`, "comment coordinate_basis RUB", `comment source_sha256 ${geometry.source.sha256}`,
      `element vertex ${geometry.positions.length}`, "property double x", "property double y", "property double z",
      ...(triangles.length ? [`element face ${triangles.length}`, "property list uchar int vertex_indices"] : []),
      "end_header", ...geometry.positions.map((point) => point.join(" ")),
      ...triangles.map((triangle) => `3 ${triangle.join(" ")}`), "",
    ].join("\n");
  }
  // The real parser checks indices, degeneracy, output caps, and float64 text round-trip.
  const reread = parseMeasurementGeometrySource(text, format);
  if (JSON.stringify(reread.positions) !== JSON.stringify(geometry.positions)
    || JSON.stringify(reread.triangles) !== JSON.stringify(triangles)) throw new Error("Measurement geometry export failed exact numeric round-trip");
  return { format, mediaType: format === "obj" ? "model/obj" : "application/ply", text,
    sha256: sha256DigestBytes(new TextEncoder().encode(text)), units: geometry.units,
    coordinateBasis: "RUB", sourceSha256: geometry.source.sha256, requiresMetadataSidecar: true };
}

export type PrecisionEvidenceBundleV1 = Readonly<{
  format: "semaframe-precision-bundle";
  version: 1;
  study: PrecisionStudyV1;
  report: PrecisionReport;
  measurementPly: MeasurementGeometryExport;
  limitations: readonly string[];
}>;

/** Self-contained inspectable geometry and declared observations; raw attachments stay in portable projects. */
export function exportPrecisionEvidenceBundle(input: unknown): PrecisionEvidenceBundleV1 {
  const study = parsePrecisionStudy(input);
  return {
    format: "semaframe-precision-bundle", version: 1, study,
    report: evaluatePrecisionStudy(study), measurementPly: exportMeasurementGeometry(study.geometry, "ply"),
    limitations: [
      "Source PLY carries the stored measurement coordinates and declared source units; calibration is in the study document, not silently baked into the file.",
      "This bundle includes inspectable geometry and declared observations, not original input file or capture attachment bytes; use portable project export to preserve those originals.",
      "The embedded report is a convenience snapshot, not trusted authority. Import re-evaluates the study and regenerates the geometry export.",
    ],
  };
}

/** Never trusts an imported pass label. Derived outputs are recomputed and source geometry is hash checked. */
export function importPrecisionEvidenceBundle(input: unknown): PrecisionEvidenceBundleV1 {
  const value: unknown = typeof input === "string"
    ? input.length > 32 * 1024 * 1024 ? (() => { throw new Error("Precision bundle exceeds 32 MiB"); })() : JSON.parse(input)
    : input;
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid precision bundle");
  const bundle = value as Record<string, unknown>;
  if (bundle.format !== "semaframe-precision-bundle" || bundle.version !== 1
    || Object.keys(bundle).some((key) => !["format", "version", "study", "report", "measurementPly", "limitations"].includes(key))) throw new Error("Unsupported precision bundle");
  const regenerated = exportPrecisionEvidenceBundle(bundle.study);
  if (!bundle.measurementPly || typeof bundle.measurementPly !== "object" || Array.isArray(bundle.measurementPly)) throw new Error("Missing measurement geometry export");
  const supplied = bundle.measurementPly as Record<string, unknown>;
  if (supplied.sha256 !== regenerated.measurementPly.sha256 || supplied.text !== regenerated.measurementPly.text
    || supplied.units !== regenerated.measurementPly.units || supplied.coordinateBasis !== "RUB"
    || supplied.sourceSha256 !== regenerated.measurementPly.sourceSha256 || supplied.format !== "ply") throw new Error("Precision bundle measurement geometry does not match its study");
  return regenerated;
}
