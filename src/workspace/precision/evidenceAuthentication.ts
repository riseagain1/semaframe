import { inspectCaptureBundle } from "../../reconstruction/captureBundle";
import { readPortableBlobRange } from "../persistence/portable/crc32";
import { parsePrecisionEvidenceRef, PRECISION_EVIDENCE_LIMITS, verifyPrecisionEvidence, type PrecisionEvidenceVault } from "./evidenceVault";
import { importMeasurementGeometry, MEASUREMENT_IMPORT_LIMITS, type MeasurementImportFormat } from "./geometryImport";
import { parsePrecisionStudy } from "./validation";

export class PrecisionEvidenceAuthenticationError extends Error {
  constructor(readonly code: "precision_source_unavailable" | "precision_source_geometry_mismatch" | "precision_source_capacity_exceeded", message: string) {
    super(message);
    this.name = "PrecisionEvidenceAuthenticationError";
  }
}

/** Authenticate retained bytes separately from the caller's physical measurement claims. */
export async function authenticatePrecisionEvidence(document: unknown, referencesInput: unknown, vault: PrecisionEvidenceVault) {
  if (referencesInput !== undefined && !Array.isArray(referencesInput)) {
    throw new PrecisionEvidenceAuthenticationError("precision_source_unavailable", "Declared source evidence references are malformed.");
  }
  let references;
  try { references = (Array.isArray(referencesInput) ? referencesInput : []).map(parsePrecisionEvidenceRef); } catch {
    throw new PrecisionEvidenceAuthenticationError("precision_source_unavailable", "Declared source evidence references are malformed.");
  }
  if (references.length > PRECISION_EVIDENCE_LIMITS.maximumReferences
    || new Set(references.map((ref) => ref.digest)).size !== references.length
    || references.reduce((total, ref) => total + ref.byteLength, 0) > 512 * 1024 * 1024) {
    throw new PrecisionEvidenceAuthenticationError("precision_source_capacity_exceeded", "Declared source evidence exceeds the bounded verification capacity; no evidence was silently skipped.");
  }
  const study = document === null ? null : parsePrecisionStudy(document);
  let sourceBound = false;
  for (const ref of references) {
    let blob: Blob;
    let format: MeasurementImportFormat | undefined;
    let meshDigest = ref.digest;
    try {
      blob = await vault.open(ref);
      await verifyPrecisionEvidence(ref, blob);
      if (ref.kind === "capture-bundle") {
        const capture = await inspectCaptureBundle(blob, { expectedSha256: ref.digest });
        meshDigest = capture.manifest.files.find((file) => file.path === capture.manifest.geometryPath)!.sha256;
        blob = capture.mesh;
        format = "obj";
      }
    } catch {
      throw new PrecisionEvidenceAuthenticationError("precision_source_unavailable", "Declared evidence is missing, corrupt, or no longer digest-verifiable. Relink the exact evidence bytes before requesting a precision report.");
    }
    if (!study || meshDigest !== study.geometry.source.sha256) continue;
    if (blob.size > MEASUREMENT_IMPORT_LIMITS.maximumBytes) {
      throw new PrecisionEvidenceAuthenticationError("precision_source_capacity_exceeded", "The claimed matching geometry source exceeds the bounded parser capacity; full geometry correspondence cannot be authenticated without explicit separate processing.");
    }
    if (!["obj", "ply", "xyz-csv"].includes(study.geometry.source.format)
      || (format && study.geometry.source.format !== format)) {
      throw new PrecisionEvidenceAuthenticationError("precision_source_geometry_mismatch", "The normalized document claims a retained source with an incompatible geometry format.");
    }
    try {
      const restored = importMeasurementGeometry({ data: await readPortableBlobRange(blob, 0, blob.size),
        format: format ?? study.geometry.source.format as MeasurementImportFormat, geometryId: study.geometry.geometryId,
        units: study.geometry.units, coordinateBasis: study.geometry.coordinateBasis, provenance: study.geometry.source.provenance });
      if (JSON.stringify(restored.positions) !== JSON.stringify(study.geometry.positions)
        || JSON.stringify(restored.triangles ?? []) !== JSON.stringify(study.geometry.triangles ?? [])) {
        throw new Error("Changed normalized geometry");
      }
    } catch {
      throw new PrecisionEvidenceAuthenticationError("precision_source_geometry_mismatch", "The normalized positions or topology do not exactly reproduce the claimed retained source. Keep raw measurement geometry unchanged and put calibration in the separate transform/control fields.");
    }
    sourceBound = true;
  }
  return {
    status: sourceBound ? "available" as const : "embedded-only" as const,
    sourceBound,
    reasons: sourceBound ? [] : ["Embedded geometry is caller-authored; no retained source correspondence was independently authenticated."],
    retainedReferences: references.length,
    retainedBytes: references.reduce((total, ref) => total + ref.byteLength, 0),
    retainedBytesStatus: references.length ? "all-declared-references-verified" : "no-retained-references",
    normalizedGeometryStatus: sourceBound ? "exact-retained-source-correspondence" : "embedded-geometry-only",
    sourceBytesAuthenticated: sourceBound,
    authority: sourceBound ? "byte-integrity-and-raw-geometry-correspondence-only" : "caller-authored-geometry-source-claims-not-independently-authenticated",
    unitsAxesAndObservations: "caller-declared-not-instrument-certified",
    physicalAccuracyCertified: false,
  };
}
