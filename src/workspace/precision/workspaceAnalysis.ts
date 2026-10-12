import { z } from "zod";
import { calibratedGeometry } from "./calibration";
import {
  fitMeasurementCircle,
  fitMeasurementCylinder,
  fitMeasurementPlane,
  measurementGeometryDigest,
  proposeMeasurementPlateCad,
  proposeMeasurementShaftCad,
  type CadFitProposal,
  type CircleFit,
  type CylinderFit,
  type FitEvidence,
  type PlaneFit,
} from "./fitting";
import { parsePrecisionStudy } from "./validation";
import { evaluatePrecisionStudy } from "./verification";
import type { PrecisionReport, PrecisionStudyV1 } from "./types";

export const PRECISION_ANALYSIS_ACTIONS = ["inspect", "prepare_source", "fit_plane", "fit_circle", "fit_cylinder", "propose_shaft", "propose_plate", "compare_cad"] as const;
export type PrecisionAnalysisAction = typeof PRECISION_ANALYSIS_ACTIONS[number];
const PREVIEW_LIMIT = 32;
const toleranceM = z.number().finite().positive().max(1_000).optional();
const partId = z.string().trim().min(1).max(128);
const axisHint = z.object({
  direction: z.tuple([z.number().finite(), z.number().finite(), z.number().finite()]),
  provenance: z.string().trim().min(1).max(2_048),
}).strict().optional();
const optionSchemas = {
  inspect: z.object({}).strict(),
  prepare_source: z.object({
    sourceDigest: z.string().regex(/^sha256:[a-f0-9]{64}$/u), format: z.enum(["obj", "ply", "xyz-csv"]),
    units: z.enum(["metre", "millimetre", "centimetre", "inch", "unknown"]).optional(),
    coordinateBasis: z.literal("RUB"), provenance: z.string().trim().min(1).max(2_048),
  }).strict(),
  fit_plane: z.object({ toleranceM }).strict(),
  fit_circle: z.object({ toleranceM }).strict(),
  fit_cylinder: z.object({ toleranceM, axisHint }).strict(),
  propose_shaft: z.object({ toleranceM, partId, axisHint }).strict(),
  propose_plate: z.object({ toleranceM, partId, thicknessM: z.number().finite().positive().max(1_000),
    thicknessProvenance: z.string().trim().min(1).max(2_048) }).strict(),
  compare_cad: z.object({ targetComponentId: z.string().trim().min(1).max(256) }).strict(),
};

export class PrecisionWorkspaceAnalysisError extends Error {
  constructor(readonly code: "invalid_precision_study" | "invalid_precision_action" | "invalid_precision_options" | "precision_calibration_required" | "precision_fit_failed", message: string) {
    super(message);
    this.name = "PrecisionWorkspaceAnalysisError";
  }
}

function parseDocument(document: unknown): PrecisionStudyV1 {
  try { return parsePrecisionStudy(document); } catch {
    throw new PrecisionWorkspaceAnalysisError("invalid_precision_study", "Precision study is missing or invalid. Supply a schema-valid measurement document before analysis.");
  }
}

export function compactPrecisionReport(report: PrecisionReport) {
  return {
    ...report,
    checks: report.checks.slice(0, PREVIEW_LIMIT),
    checkCount: report.checks.length,
    checksTruncated: report.checks.length > PREVIEW_LIMIT,
    omittedCheckCount: Math.max(0, report.checks.length - PREVIEW_LIMIT),
    // Status always derives from ALL checks, never just the returned preview.
    assessmentUsedAllChecks: true,
  };
}

function evidenceSummary(evidence: FitEvidence) {
  const { inlierIndices, outlierIndices, ...rest } = evidence;
  return {
    ...rest,
    inlierCount: inlierIndices.length,
    outlierCount: outlierIndices.length,
    inlierIndicesPreview: inlierIndices.slice(0, PREVIEW_LIMIT),
    outlierIndicesPreview: outlierIndices.slice(0, PREVIEW_LIMIT),
    indicesTruncated: inlierIndices.length > PREVIEW_LIMIT || outlierIndices.length > PREVIEW_LIMIT,
    fitUsedAllSamples: true,
  };
}

function compactFit(fit: PlaneFit | CircleFit | CylinderFit) {
  return { ...fit, evidence: evidenceSummary(fit.evidence) };
}

function sourceSummary(study: PrecisionStudyV1) {
  return {
    geometryId: study.geometry.geometryId,
    geometryDigest: measurementGeometryDigest(study.geometry),
    originalFileDigest: study.geometry.source.sha256,
    vertexCount: study.geometry.positions.length,
    triangleCount: study.geometry.triangles?.length ?? 0,
    units: study.geometry.units,
    coordinateBasis: study.geometry.coordinateBasis,
    calibrationMode: study.calibration.mode,
    sourceGeometryOnly: true,
    linkedCadCertified: false,
    referenceTruth: "caller_supplied_not_instrument_certified",
  };
}

/** Bounded host-generated evidence; neither stored status flags nor linked CAD receive certification. */
export function analyzePrecisionDocument(document: unknown, action: string = "inspect", options: unknown = {}) {
  if (!PRECISION_ANALYSIS_ACTIONS.includes(action as PrecisionAnalysisAction)) {
    throw new PrecisionWorkspaceAnalysisError("invalid_precision_action", "Unknown precision analysis action.");
  }
  const knownAction = action as PrecisionAnalysisAction;
  if (knownAction === "prepare_source") throw new PrecisionWorkspaceAnalysisError("invalid_precision_action", "Source preparation requires the host's approved, digest-verified evidence vault.");
  const parsedOptions = optionSchemas[knownAction].safeParse(options);
  if (!parsedOptions.success) {
    throw new PrecisionWorkspaceAnalysisError("invalid_precision_options", `Options are invalid for ${knownAction}; no unknown or action-inapplicable options are accepted.`);
  }
  const study = parseDocument(document);
  const base = { source: sourceSummary(study), report: compactPrecisionReport(evaluatePrecisionStudy(study)) };
  if (knownAction === "inspect") return base;
  if (knownAction === "compare_cad") {
    throw new PrecisionWorkspaceAnalysisError("invalid_precision_action", "CAD comparison requires host evaluation of the current target component, not caller-supplied geometry.");
  }
  let geometry;
  try { geometry = calibratedGeometry(study); } catch {
    throw new PrecisionWorkspaceAnalysisError("precision_calibration_required", "Metric fitting requires valid declared units or a solved measured registration. Unknown units cannot be silently treated as metres.");
  }
  const parsed = parsedOptions.data;
  const fitOptions = { toleranceM: "toleranceM" in parsed ? parsed.toleranceM ?? study.policy.toleranceM : study.policy.toleranceM,
    frameId: `${study.geometry.geometryId}:${study.calibration.mode}:RUB` };
  try {
    if (knownAction === "fit_plane") return { ...base, fit: compactFit(fitMeasurementPlane(geometry, fitOptions)) };
    if (knownAction === "fit_circle") return { ...base, fit: compactFit(fitMeasurementCircle(geometry, fitOptions)) };
    const hint = "axisHint" in parsed ? parsed.axisHint : undefined;
    if (knownAction === "fit_cylinder") return { ...base, fit: compactFit(fitMeasurementCylinder(geometry, { ...fitOptions, axisHint: hint })) };
    let proposal: CadFitProposal;
    if (knownAction === "propose_shaft" && "partId" in parsed) {
      proposal = proposeMeasurementShaftCad(geometry, { ...fitOptions, partId: parsed.partId, axisHint: hint });
    } else if (knownAction === "propose_plate" && "thicknessM" in parsed) {
      proposal = proposeMeasurementPlateCad(geometry, { ...fitOptions, partId: parsed.partId,
        thicknessM: parsed.thicknessM, thicknessProvenance: parsed.thicknessProvenance });
    } else throw new Error("Invalid proposal options");
    return {
      ...base,
      proposal: { ...proposal, fit: compactFit(proposal.fit), sourceReportCertifiesProposal: false },
      commit: { mutated: false, requiredWorkflow: "begin_workspace_update_then_submit_workspace_batch",
        guidance: "Apply the proposed CAD definition through ordinary workspace edits and normal CAD evaluation. Validate the resulting CAD separately; source-geometry checks do not certify a fitted proxy." },
    };
  } catch (cause) {
    throw new PrecisionWorkspaceAnalysisError("precision_fit_failed", cause instanceof Error ? cause.message : "Bounded primitive fitting failed.");
  }
}

export function parsePrecisionCadComparisonOptions(options: unknown): { targetComponentId: string } {
  const parsed = optionSchemas.compare_cad.safeParse(options);
  if (!parsed.success) throw new PrecisionWorkspaceAnalysisError("invalid_precision_options", "compare_cad requires only targetComponentId.");
  return parsed.data;
}

export function parsePrecisionSourceOptions(options: unknown) {
  const parsed = optionSchemas.prepare_source.safeParse(options);
  if (!parsed.success) throw new PrecisionWorkspaceAnalysisError("invalid_precision_options", "prepare_source requires sourceDigest, format, explicit coordinateBasis RUB, provenance, and optional units.");
  return parsed.data;
}

/** Empty panels are inspectable; malformed non-null documents still fail explicitly. */
export function precisionInspectionSummary(document: unknown) {
  if (document === null) return { status: "unverified", documentPresent: false, sourceGeometryOnly: true,
    linkedCadCertified: false, reason: "No normalized measurement document. Retained evidence remains unverified source data." };
  return analyzePrecisionDocument(document);
}
