import { stableStringify } from "../components/manifestDigest";
import {
  cadPartDefinitionDigest,
  parseCadEvaluationEvidence,
  parseCadPartDefinition,
  type CadEvaluationEvidenceV1,
  type CadPartDefinitionV1,
} from "../modeling/cad";
import {
  CAD_KERNEL_LIMITS,
  createCadWorkerKernel,
  type CadKernel,
} from "../modeling";
import type { WorkspaceProjectFile } from "./WorkspaceProjectSerializer";

export const CAD_PROJECT_EVIDENCE_VERIFICATION_LIMITS = Object.freeze({
  maximumEvidenceRecords: 4_096,
  // Every admitted evidence record may legitimately describe a distinct edit
  // retained in command history. Keeping the distinct-definition ceiling at
  // the record ceiling avoids a lower verifier-only limit that a valid live
  // Store could cross before save.
  maximumUniqueDefinitions: 4_096,
  maximumAggregateBudgetMs: 120_000,
  maximumDefinitionBudgetMs: 30_000,
});

export type VerifyWorkspaceProjectCadEvidenceOptions = Readonly<{
  /** Controlled-test seam. Browser project loading uses a disposable Worker. */
  cadKernelFactory?: () => Promise<CadKernel>;
  /** Controlled-test seam for proving that digest collisions cannot merge definitions. */
  definitionGroupingDigest?: (definition: CadPartDefinitionV1) => string;
}>;

export class WorkspaceCadEvidenceVerificationError extends Error {
  constructor(
    message: string,
    readonly code:
      | "cad_evidence_verification_required"
      | "cad_evidence_verification_unavailable"
      | "cad_evidence_verification_limit"
      | "cad_evidence_mismatch",
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "WorkspaceCadEvidenceVerificationError";
  }
}

/**
 * Successful external verification is bound to the exact canonical project
 * contents that were evaluated. Object identity alone is not evidence because
 * callers retain a mutable reference to a deserialized project.
 */
const verifiedProjectSnapshots = new WeakMap<object, string>();

function projectSnapshot(project: WorkspaceProjectFile): string {
  return stableStringify(project);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function looksLikeCadDefinition(value: unknown): boolean {
  return isRecord(value)
    && value.formatVersion === "1.0"
    && value.units === "metre"
    && Array.isArray(value.history)
    && Array.isArray(value.activeBodyIds);
}

function looksLikeCadEvidence(value: unknown): boolean {
  return isRecord(value)
    && value.formatVersion === "1.0"
    && value.exactness === "brep"
    && value.status === "valid"
    && Array.isArray(value.bodies);
}

type EvidenceClaim = Readonly<{
  path: string;
  definition: CadPartDefinitionV1;
  evidence: CadEvaluationEvidenceV1;
}>;

type EvidenceClaimGroup = Readonly<{
  canonicalDefinition: string;
  claims: EvidenceClaim[];
}>;

function collectEvidenceClaims(project: WorkspaceProjectFile): EvidenceClaim[] {
  const claims: EvidenceClaim[] = [];
  const stack: Array<{ value: unknown; path: string }> = [{ value: project, path: "$" }];
  const visited = new WeakSet<object>();
  while (stack.length) {
    const { value, path } = stack.pop()!;
    if (value === null || typeof value !== "object") continue;
    if (visited.has(value)) continue;
    visited.add(value);
    if (Array.isArray(value)) {
      for (let index = value.length - 1; index >= 0; index -= 1) {
        stack.push({ value: value[index], path: `${path}[${index}]` });
      }
      continue;
    }
    const record = value as Record<string, unknown>;
    const hasDefinition = looksLikeCadDefinition(record.definition);
    const hasEvidence = looksLikeCadEvidence(record.evaluation);
    if (hasEvidence && !hasDefinition) {
      throw new WorkspaceCadEvidenceVerificationError(
        `CAD evidence at ${path}.evaluation is not accompanied by its editable definition`,
        "cad_evidence_mismatch",
      );
    }
    if (hasDefinition) {
      let definition: CadPartDefinitionV1;
      try {
        definition = parseCadPartDefinition(record.definition);
      } catch (error) {
        throw new WorkspaceCadEvidenceVerificationError(
          `CAD definition at ${path}.definition is invalid`,
          "cad_evidence_mismatch",
          { cause: error instanceof Error ? error : new Error(String(error)) },
        );
      }
      const digest = cadPartDefinitionDigest(definition);
      if (record.definitionDigest !== digest) {
        throw new WorkspaceCadEvidenceVerificationError(
          `CAD definition digest at ${path}.definitionDigest does not match ${digest}`,
          "cad_evidence_mismatch",
        );
      }
      if (definition.activeBodyIds.length === 0) {
        if (record.evaluation !== null) {
          throw new WorkspaceCadEvidenceVerificationError(
            `Empty CAD definition at ${path}.definition retains evaluation evidence`,
            "cad_evidence_mismatch",
          );
        }
      } else {
        try {
          const evidence = parseCadEvaluationEvidence(record.evaluation, definition);
          claims.push({ path, definition, evidence });
        } catch (error) {
          throw new WorkspaceCadEvidenceVerificationError(
            `CAD evidence at ${path}.evaluation is invalid`,
            "cad_evidence_mismatch",
            { cause: error instanceof Error ? error : new Error(String(error)) },
          );
        }
      }
    }
    for (const [key, child] of Object.entries(record)) {
      if (key === "definition" || key === "evaluation") continue;
      stack.push({ value: child, path: `${path}.${key}` });
    }
  }
  if (claims.length > CAD_PROJECT_EVIDENCE_VERIFICATION_LIMITS.maximumEvidenceRecords) {
    throw new WorkspaceCadEvidenceVerificationError(
      `Workspace project contains ${claims.length} CAD evidence records; the verification limit is ${CAD_PROJECT_EVIDENCE_VERIFICATION_LIMITS.maximumEvidenceRecords}`,
      "cad_evidence_verification_limit",
    );
  }
  return claims;
}

function groupEvidenceClaims(
  claims: readonly EvidenceClaim[],
  groupingDigest: (definition: CadPartDefinitionV1) => string,
): EvidenceClaimGroup[] {
  const byDigest = new Map<string, EvidenceClaimGroup[]>();
  for (const claim of claims) {
    const digest = groupingDigest(claim.definition);
    const canonicalDefinition = stableStringify(claim.definition);
    const bucket = byDigest.get(digest) ?? [];
    const matching = bucket.find((entry) => entry.canonicalDefinition === canonicalDefinition);
    if (matching) {
      matching.claims.push(claim);
    } else {
      bucket.push({ canonicalDefinition, claims: [claim] });
    }
    byDigest.set(digest, bucket);
  }
  const definitionGroups = [...byDigest.values()].flat();
  if (definitionGroups.length > CAD_PROJECT_EVIDENCE_VERIFICATION_LIMITS.maximumUniqueDefinitions) {
    throw new WorkspaceCadEvidenceVerificationError(
      `Workspace project contains ${definitionGroups.length} unique CAD definitions; the verification limit is ${CAD_PROJECT_EVIDENCE_VERIFICATION_LIMITS.maximumUniqueDefinitions}`,
      "cad_evidence_verification_limit",
    );
  }
  return definitionGroups;
}

/**
 * Apply the same bounded claim admission used by external verification before
 * a project is emitted. This prevents producing a valid-looking save that the
 * loader must later reject solely because its history crossed a private cap.
 */
export function assertWorkspaceProjectCadEvidenceWithinVerificationLimits(
  project: WorkspaceProjectFile,
): void {
  groupEvidenceClaims(collectEvidenceClaims(project), cadPartDefinitionDigest);
}

function projectHasCadEvidence(project: WorkspaceProjectFile): boolean {
  const stack: unknown[] = [project];
  const visited = new WeakSet<object>();
  while (stack.length) {
    const value = stack.pop();
    if (value === null || typeof value !== "object" || visited.has(value)) continue;
    visited.add(value);
    if (Array.isArray(value)) {
      stack.push(...value);
      continue;
    }
    const record = value as Record<string, unknown>;
    if (looksLikeCadDefinition(record.definition) || looksLikeCadEvidence(record.evaluation)) return true;
    stack.push(...Object.values(record));
  }
  return false;
}

/** Prevent a deserialized external project from exposing unverified CAD measurements. */
export function assertWorkspaceProjectCadEvidenceVerified(project: WorkspaceProjectFile): void {
  if (!projectHasCadEvidence(project)) return;
  const verifiedSnapshot = verifiedProjectSnapshots.get(project);
  if (verifiedSnapshot === undefined) {
    throw new WorkspaceCadEvidenceVerificationError(
      "CAD project evidence must be re-evaluated in a disposable Worker before this project can be opened",
      "cad_evidence_verification_required",
    );
  }
  if (projectSnapshot(project) !== verifiedSnapshot) {
    verifiedProjectSnapshots.delete(project);
    throw new WorkspaceCadEvidenceVerificationError(
      "CAD project changed after its evidence was verified; re-evaluate it before opening",
      "cad_evidence_mismatch",
    );
  }
}

/**
 * Rebuild every unique CAD definition in a disposable browser Worker and
 * compare the exact compact evidence before an external project is opened.
 */
export async function verifyWorkspaceProjectCadEvidence(
  project: WorkspaceProjectFile,
  options: VerifyWorkspaceProjectCadEvidenceOptions = {},
): Promise<void> {
  const initialSnapshot = projectSnapshot(project);
  const claims = collectEvidenceClaims(project);
  if (claims.length === 0) {
    if (projectSnapshot(project) !== initialSnapshot) {
      throw new WorkspaceCadEvidenceVerificationError(
        "CAD project changed while its evidence was being verified",
        "cad_evidence_mismatch",
      );
    }
    verifiedProjectSnapshots.set(project, initialSnapshot);
    return;
  }
  const definitionGroups = groupEvidenceClaims(
    claims,
    options.definitionGroupingDigest ?? cadPartDefinitionDigest,
  );
  const factory = options.cadKernelFactory ?? (typeof globalThis.Worker === "function"
    ? createCadWorkerKernel
    : undefined);
  if (!factory) {
    throw new WorkspaceCadEvidenceVerificationError(
      "CAD project verification requires a disposable Worker in this host",
      "cad_evidence_verification_unavailable",
    );
  }
  const startedAt = Date.now();
  const kernel = await factory();
  try {
    for (const group of definitionGroups) {
      const remaining = CAD_PROJECT_EVIDENCE_VERIFICATION_LIMITS.maximumAggregateBudgetMs
        - (Date.now() - startedAt);
      if (remaining < CAD_KERNEL_LIMITS.minimumOperationBudgetMs) {
        throw new WorkspaceCadEvidenceVerificationError(
          "CAD project evidence verification exceeded its aggregate time budget",
          "cad_evidence_verification_limit",
        );
      }
      const result = await kernel.evaluatePart(group.claims[0]!.definition, {
        includeMeshes: false,
        budgetMs: Math.min(
          CAD_PROJECT_EVIDENCE_VERIFICATION_LIMITS.maximumDefinitionBudgetMs,
          remaining,
        ),
      });
      const evaluated = stableStringify(result.evidence);
      for (const claim of group.claims) {
        if (stableStringify(claim.evidence) !== evaluated) {
          throw new WorkspaceCadEvidenceVerificationError(
            `CAD evidence at ${claim.path}.evaluation does not match fresh OCCT evaluation`,
            "cad_evidence_mismatch",
          );
        }
      }
    }
  } catch (error) {
    if (error instanceof WorkspaceCadEvidenceVerificationError) throw error;
    throw new WorkspaceCadEvidenceVerificationError(
      `CAD project evidence could not be re-evaluated: ${error instanceof Error ? error.message : String(error)}`,
      "cad_evidence_mismatch",
      { cause: error instanceof Error ? error : new Error(String(error)) },
    );
  } finally {
    await kernel.dispose();
  }
  if (projectSnapshot(project) !== initialSnapshot) {
    throw new WorkspaceCadEvidenceVerificationError(
      "CAD project changed while its evidence was being verified",
      "cad_evidence_mismatch",
    );
  }
  verifiedProjectSnapshots.set(project, initialSnapshot);
}
