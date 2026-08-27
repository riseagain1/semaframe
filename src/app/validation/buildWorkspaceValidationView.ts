import type { ResourceBindingDiagnostic } from "../../workspace/data/bindingResolver";
import { buildSemaFrameLayoutGraph } from "../../workspace/layout";
import {
  buildPhysicsValidationReport,
  type PhysicsIssue,
  type PhysicsValidationReport,
} from "../../workspace/physics";
import type { WorkspaceState } from "../../workspace/state/workspaceState";

export type WorkspaceValidationSeverity = "blocking" | "warning" | "info";
export type WorkspaceValidationDomain = "spatial" | "layout" | "physics" | "reality" | "data";
export type WorkspaceValidationSurface = "inspector" | "sources" | "reality";

export type WorkspaceValidationTarget = Readonly<{
  surface: WorkspaceValidationSurface;
  componentId?: string;
  resourceId?: string;
  assetId?: string;
  section?: string;
}>;

export type WorkspaceValidationIssue = Readonly<{
  id: string;
  domain: WorkspaceValidationDomain;
  severity: WorkspaceValidationSeverity;
  code: string;
  title: string;
  detail: string;
  target?: WorkspaceValidationTarget;
}>;

export type WorkspaceValidationSource = Readonly<{
  id: string;
  label: string;
  status?: "ready" | "refreshing" | "stale" | "error";
  automationPaused?: boolean;
  lastError?: string;
}>;

export type WorkspaceValidationRealityAvailability = "checking" | "available" | "missing" | "error";

export type WorkspaceValidationInput = Readonly<{
  workspace: Readonly<WorkspaceState>;
  /** Supply an already-computed report to avoid repeating a host render-frame calculation. */
  physicsReport?: PhysicsValidationReport;
  bindingDiagnostics?: readonly ResourceBindingDiagnostic[];
  realityAvailability?: Readonly<Record<string, WorkspaceValidationRealityAvailability>>;
  sources?: readonly WorkspaceValidationSource[];
}>;

export type WorkspaceValidationCounts = Readonly<{
  blocking: number;
  warning: number;
  info: number;
  total: number;
}>;

export type WorkspaceValidationView = Readonly<{
  workspaceId: string;
  revision: number;
  bounded: true;
  issues: readonly WorkspaceValidationIssue[];
  counts: WorkspaceValidationCounts;
  coverage: readonly string[];
  limitations: readonly string[];
}>;

const SEVERITY_ORDER: Readonly<Record<WorkspaceValidationSeverity, number>> = Object.freeze({
  blocking: 0,
  warning: 1,
  info: 2,
});

const DOMAIN_ORDER: Readonly<Record<WorkspaceValidationDomain, number>> = Object.freeze({
  spatial: 0,
  layout: 1,
  physics: 2,
  reality: 3,
  data: 4,
});

const BLOCKING_PHYSICS_CODES = new Set<PhysicsIssue["code"]>([
  "collision",
  "collider_missing",
  "ground_penetration",
  "constraint_target_missing",
  "constraint_anchor_gap",
  "constraint_axis_invalid",
  "constraint_unstable",
]);

function record(value: unknown): Readonly<Record<string, unknown>> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Readonly<Record<string, unknown>>
    : undefined;
}

function cleanMessage(value: string | undefined, fallback: string): string {
  const trimmed = value?.trim();
  return trimmed ? trimmed.slice(0, 500) : fallback;
}

function targetForComponent(componentId: string, section: string): WorkspaceValidationTarget | undefined {
  return componentId === "__workspace__"
    ? undefined
    : Object.freeze({ surface: "inspector", componentId, section });
}

function physicsSeverity(
  issue: PhysicsIssue,
  report: PhysicsValidationReport,
): WorkspaceValidationSeverity {
  if (BLOCKING_PHYSICS_CODES.has(issue.code)) return "blocking";
  if (issue.code === "unsupported" || issue.code === "tip_risk") {
    const mode = report.bodies.find((body) => body.componentId === issue.componentId)?.stabilityMode;
    return mode === "enforce" ? "blocking" : "warning";
  }
  return "warning";
}

function physicsTitle(issue: PhysicsIssue): string {
  switch (issue.code) {
    case "collision": return "Objects intersect";
    case "collider_missing": return "Physics body has no solid collider";
    case "ground_penetration": return "Object penetrates the Stage ground";
    case "unsupported": return "Object is unsupported";
    case "tip_risk": return "Object may tip";
    case "constraint_target_missing": return "Constraint target is missing";
    case "constraint_anchor_gap": return "Constraint anchors do not meet";
    case "constraint_axis_invalid": return "Constraint axis is invalid";
    case "constraint_unstable": return "Constraint does not stabilize this body";
    case "capacity_exceeded": return "Physics check reached its capacity";
    case "settle_incomplete": return "Physics settle did not finish";
  }
}

function appendPhysicsIssues(
  output: WorkspaceValidationIssue[],
  report: PhysicsValidationReport,
): void {
  const seenCollisions = new Set<string>();
  for (const issue of report.issues) {
    if (issue.code === "collision" && issue.relatedComponentId) {
      const pair = [issue.componentId, issue.relatedComponentId].sort((left, right) => left.localeCompare(right));
      const pairKey = `${pair[0]}\u0000${pair[1]}`;
      if (seenCollisions.has(pairKey)) continue;
      seenCollisions.add(pairKey);
      output.push(Object.freeze({
        id: `spatial:collision:${pair[0]}:${pair[1]}`,
        domain: "spatial",
        severity: "blocking",
        code: "collision",
        title: physicsTitle(issue),
        detail: `${pair[0]} intersects ${pair[1]}. Move an object or adjust its collider before relying on the arrangement.`,
        target: Object.freeze({ surface: "inspector", componentId: pair[0], section: "collision" }),
      }));
      continue;
    }
    const target = targetForComponent(issue.componentId, issue.code.startsWith("constraint_") ? "constraints" : "physics");
    output.push(Object.freeze({
      id: `physics:${issue.code}:${issue.componentId}:${issue.relatedComponentId ?? ""}:${issue.constraintId ?? ""}`,
      domain: "physics",
      severity: physicsSeverity(issue, report),
      code: issue.code,
      title: physicsTitle(issue),
      detail: cleanMessage(issue.message, `Physics reported ${issue.code} for ${issue.componentId}.`),
      ...(target ? { target } : {}),
    }));
  }
}

function appendLayoutIssues(
  output: WorkspaceValidationIssue[],
  workspace: Readonly<WorkspaceState>,
): void {
  const snapshot = buildSemaFrameLayoutGraph(workspace);
  const seen = new Set<string>();
  for (const conflict of snapshot.overlapConflicts) {
    const pair = [conflict.componentId, conflict.conflictsWith]
      .sort((left, right) => left.localeCompare(right));
    if (!pair[0] || !pair[1] || pair[0] === pair[1]) continue;
    const pairKey = `${pair[0]}\u0000${pair[1]}`;
    if (seen.has(pairKey)) continue;
    seen.add(pairKey);
    const overlapArea = Number.isFinite(conflict.overlap.area)
      ? Math.max(0, conflict.overlap.area).toLocaleString(undefined, { maximumFractionDigits: 2 })
      : "an unknown area";
    output.push(Object.freeze({
      id: `layout:overlap:${pair[0]}:${pair[1]}`,
      domain: "layout",
      severity: "blocking",
      code: "layout_overlap",
      title: "2D panels overlap",
      detail: `${pair[0]} overlaps ${pair[1]} by ${overlapArea} square authoring-plane pixels. Move or resize a panel on the canonical 1440×900 plane.`,
      target: Object.freeze({ surface: "inspector", componentId: pair[0], section: "layout" }),
    }));
  }
  if (snapshot.overlapConflictsTruncated) {
    output.push(Object.freeze({
      id: "layout:overlap-capacity",
      domain: "layout",
      severity: "warning",
      code: "layout_overlap_capacity",
      title: "2D overlap check reached its capacity",
      detail: "Additional canonical-plane overlaps may exist beyond this bounded result. Reduce the number of 2D panels and run Checks again.",
    }));
  }
}

function appendBindingIssues(
  output: WorkspaceValidationIssue[],
  diagnostics: readonly ResourceBindingDiagnostic[],
): void {
  const seen = new Set<string>();
  for (const diagnostic of diagnostics) {
    const id = `data:binding:${diagnostic.bindingId}:${diagnostic.code}:${diagnostic.componentId}:${diagnostic.resourceId}`;
    if (seen.has(id)) continue;
    seen.add(id);
    output.push(Object.freeze({
      id,
      domain: "data",
      severity: diagnostic.severity === "error" ? "blocking" : "warning",
      code: diagnostic.code,
      title: diagnostic.severity === "error" ? "Data binding cannot be applied" : "Data binding needs attention",
      detail: cleanMessage(diagnostic.message, `Binding ${diagnostic.bindingId} reported ${diagnostic.code}.`),
      target: Object.freeze({
        surface: "sources",
        componentId: diagnostic.componentId,
        resourceId: diagnostic.resourceId,
        section: "bindings",
      }),
    }));
  }
}

function appendSourceIssues(
  output: WorkspaceValidationIssue[],
  sources: readonly WorkspaceValidationSource[],
): void {
  for (const source of [...sources].sort((left, right) => left.id.localeCompare(right.id))) {
    const target = Object.freeze({ surface: "sources" as const, resourceId: source.id, section: "source" });
    if (source.status === "error") {
      output.push(Object.freeze({
        id: `data:source-error:${source.id}`,
        domain: "data",
        severity: "blocking",
        code: "source_error",
        title: `${source.label} is unavailable`,
        detail: cleanMessage(source.lastError, "The latest source refresh failed. The displayed snapshot may not be current."),
        target,
      }));
    } else if (source.status === "stale" || source.lastError?.trim()) {
      output.push(Object.freeze({
        id: `data:source-stale:${source.id}`,
        domain: "data",
        severity: "warning",
        code: "source_stale",
        title: `${source.label} may be stale`,
        detail: cleanMessage(source.lastError, "The source is using its last known snapshot."),
        target,
      }));
    }
    if (source.automationPaused) {
      output.push(Object.freeze({
        id: `data:automation-paused:${source.id}`,
        domain: "data",
        severity: "info",
        code: "automation_paused",
        title: `${source.label} is not refreshing automatically`,
        detail: "Automatic refresh is paused. Existing snapshot data remains available.",
        target,
      }));
    }
  }
}

function appendRealityIssues(
  output: WorkspaceValidationIssue[],
  workspace: Readonly<WorkspaceState>,
  availability: Readonly<Record<string, WorkspaceValidationRealityAvailability>>,
): void {
  const components = [...workspace.components.values()]
    .filter((component) => component.type.typeId === "gaussian-splat")
    .sort((left, right) => left.id.localeCompare(right.id));

  for (const component of components) {
    const assetRef = record(component.props.assetRef);
    const assetId = typeof assetRef?.assetId === "string" ? assetRef.assetId : undefined;
    if (!assetId) {
      output.push(Object.freeze({
        id: `reality:asset-missing:${component.id}`,
        domain: "reality",
        severity: "blocking",
        code: "asset_reference_missing",
        title: `${component.label} has no Reality asset`,
        detail: "Import or relink local Reality bytes before this layer can render.",
        target: Object.freeze({ surface: "reality", componentId: component.id, section: "assets" }),
      }));
    } else {
      const state = availability[assetId];
      if (state === "missing" || state === "error") {
        output.push(Object.freeze({
          id: `reality:asset-unavailable:${component.id}:${assetId}`,
          domain: "reality",
          severity: "blocking",
          code: "asset_unavailable",
          title: `${component.label} cannot load its local bytes`,
          detail: state === "missing"
            ? "The project metadata is intact, but the local Reality bytes must be relinked."
            : "Local Reality storage could not be read. Retry or relink the asset.",
          target: Object.freeze({ surface: "reality", componentId: component.id, assetId, section: "assets" }),
        }));
      } else if (state === "checking") {
        output.push(Object.freeze({
          id: `reality:asset-checking:${component.id}:${assetId}`,
          domain: "reality",
          severity: "info",
          code: "asset_checking",
          title: `${component.label} is checking local bytes`,
          detail: "Availability has not been confirmed yet.",
          target: Object.freeze({ surface: "reality", componentId: component.id, assetId, section: "assets" }),
        }));
      }
    }

    const calibration = record(component.props.calibration);
    if (!calibration || calibration.status === "uncalibrated") {
      output.push(Object.freeze({
        id: `reality:uncalibrated:${component.id}`,
        domain: "reality",
        severity: "warning",
        code: "uncalibrated",
        title: `${component.label} has no metric calibration`,
        detail: "Visual scale is not engineering scale. Declare units or use a known reference distance.",
        target: Object.freeze({ surface: "inspector", componentId: component.id, ...(assetId ? { assetId } : {}), section: "reality-calibration" }),
      }));
    }

    const proxyIds = Array.isArray(component.props.semanticProxyIds)
      ? component.props.semanticProxyIds.filter((value): value is string => typeof value === "string")
      : [];
    if (proxyIds.length === 0) {
      output.push(Object.freeze({
        id: `reality:no-proxies:${component.id}`,
        domain: "reality",
        severity: "info",
        code: "semantic_proxies_missing",
        title: `${component.label} is visual-only`,
        detail: "Add editable semantic proxies before using this capture for collision, physics, CAD, or Agent reasoning.",
        target: Object.freeze({ surface: "inspector", componentId: component.id, section: "reality-proxies" }),
      }));
    } else {
      const missing = [...new Set(proxyIds.filter((id) => !workspace.components.has(id)))].sort();
      for (const missingId of missing) {
        output.push(Object.freeze({
          id: `reality:proxy-missing:${component.id}:${missingId}`,
          domain: "reality",
          severity: "blocking",
          code: "semantic_proxy_missing",
          title: `${component.label} references a missing proxy`,
          detail: `The semantic proxy ${missingId} no longer exists. Replace or remove that reference.`,
          target: Object.freeze({ surface: "inspector", componentId: component.id, section: "reality-proxies" }),
        }));
      }
    }
  }
}

function compareIssues(left: WorkspaceValidationIssue, right: WorkspaceValidationIssue): number {
  return SEVERITY_ORDER[left.severity] - SEVERITY_ORDER[right.severity]
    || DOMAIN_ORDER[left.domain] - DOMAIN_ORDER[right.domain]
    || left.code.localeCompare(right.code)
    || left.id.localeCompare(right.id);
}

/**
 * Purely derives a bounded, navigable Checks view. This function never mutates
 * Workspace state, never performs I/O, and never represents a certification.
 */
export function buildWorkspaceValidationView(input: WorkspaceValidationInput): WorkspaceValidationView {
  const report = input.physicsReport
    && input.physicsReport.workspaceId === input.workspace.workspaceId
    && input.physicsReport.workspaceRevision === input.workspace.revision
    ? input.physicsReport
    : buildPhysicsValidationReport(input.workspace);
  const issues: WorkspaceValidationIssue[] = [];
  appendPhysicsIssues(issues, report);
  appendLayoutIssues(issues, input.workspace);
  appendBindingIssues(issues, input.bindingDiagnostics ?? []);
  appendSourceIssues(issues, input.sources ?? []);
  appendRealityIssues(issues, input.workspace, input.realityAvailability ?? {});
  issues.sort(compareIssues);

  const counts = Object.freeze({
    blocking: issues.filter((issue) => issue.severity === "blocking").length,
    warning: issues.filter((issue) => issue.severity === "warning").length,
    info: issues.filter((issue) => issue.severity === "info").length,
    total: issues.length,
  });

  return Object.freeze({
    workspaceId: input.workspace.workspaceId,
    revision: input.workspace.revision,
    bounded: true as const,
    issues: Object.freeze(issues),
    counts,
    coverage: Object.freeze([
      "Spatial overlaps reported by the current collision model",
      "Persistent 2D panel overlaps on the canonical 1440×900 authoring plane",
      "Enabled rigid-body support, stability, constraints, and Stage penetration",
      "Reality byte availability, metric calibration, and semantic proxy references",
      "Current source freshness and resource-binding diagnostics",
    ]),
    limitations: Object.freeze([
      "Checks use bounded deterministic models and may omit work beyond their published capacity.",
      "Projection-dependent panels are not persistent hard layout judgments; their apparent overlap can vary with viewport and viewer projection.",
      "Reality captures are visual-only; proxies and calibration do not turn them into survey or CAD authority.",
      "A clear result is not structural, safety, regulatory, manufacturing, or engineering certification.",
    ]),
  });
}
