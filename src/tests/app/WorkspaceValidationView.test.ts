import { beforeEach, describe, expect, it, vi } from "vitest";
import { buildWorkspaceValidationView } from "../../app/validation/buildWorkspaceValidationView";
import { DEFAULT_COMPONENT_REGISTRY } from "../../workspace/components";
import type { ComponentInstance } from "../../workspace/components/componentTypes";
import { WORKSPACE_PHYSICS_VERSION, type PhysicsBodyReport, type PhysicsValidationReport } from "../../workspace/physics";
import { WorkspaceStore, type WorkspaceState } from "../../workspace/state";

const buildLayoutGraph = vi.hoisted(() => vi.fn());
vi.mock("../../workspace/layout", () => ({ buildSemaFrameLayoutGraph: buildLayoutGraph }));

beforeEach(() => {
  buildLayoutGraph.mockReset();
  buildLayoutGraph.mockReturnValue({ overlapConflicts: [], overlapConflictsTruncated: false });
});

function body(componentId: string, stabilityMode: "report" | "enforce"): PhysicsBodyReport {
  return {
    componentId,
    enabled: true,
    bodyType: "dynamic",
    massKg: 1,
    massSource: "explicit",
    centerOfMassWorld: { x: 0, y: 0, z: 0 },
    friction: 0.6,
    restitution: 0.1,
    gravityScale: 1,
    stabilityMode,
    stable: false,
    grounded: false,
    stabilityReason: "unsupported",
    supportPolygon: [],
    stabilityMarginM: null,
    supports: [],
    constraints: [],
  };
}

function physicsReport(
  workspace: Readonly<WorkspaceState>,
  overrides: Partial<PhysicsValidationReport> = {},
): PhysicsValidationReport {
  return {
    format: "workspace-physics-report",
    version: WORKSPACE_PHYSICS_VERSION,
    model: "quasi_static_rigid_support_v2",
    workspaceId: workspace.workspaceId,
    workspaceRevision: workspace.revision,
    feasible: true,
    bodies: [],
    issues: [],
    ...overrides,
  };
}

function realityComponent(id: string, patch: Record<string, unknown> = {}): ComponentInstance {
  return {
    id,
    type: DEFAULT_COMPONENT_REGISTRY.ref("gaussian-splat"),
    label: "Captured room",
    props: {
      assetRef: { assetId: "ra_test", digest: `sha256:${"a".repeat(64)}` },
      calibration: {
        version: 1,
        status: "uncalibrated",
        sourceCoordinateSystem: "UNKNOWN",
        targetCoordinateSystem: "RUB",
        metersPerSourceUnit: null,
      },
      quality: "auto",
      semanticProxyIds: [],
      ...patch,
    },
    durableState: {},
    placement: {
      space: "world3d",
      position: { x: 0, y: 0, z: 0 },
      rotation: { x: 0, y: 0, z: 0 },
      scale: { x: 1, y: 1, z: 1 },
    },
    bindings: [],
    tags: [],
    visibility: "visible",
    locks: {
      placement: false,
      resize: false,
      visualEffects: false,
      props: false,
      deletion: false,
      actions: false,
    },
    provenance: { createdRevision: 1, createdBy: "user" },
  };
}

function withComponents(base: Readonly<WorkspaceState>, components: readonly ComponentInstance[]): WorkspaceState {
  return { ...base, components: new Map(components.map((component) => [component.id, component])) };
}

describe("buildWorkspaceValidationView", () => {
  it("deduplicates symmetric collisions and applies enforce/report physics severity", () => {
    const workspace = new WorkspaceStore().getState();
    const report = physicsReport(workspace, {
      feasible: false,
      bodies: [body("FLOAT_REPORT", "report"), body("FLOAT_ENFORCE", "enforce")],
      issues: [{
        code: "collision",
        componentId: "B",
        relatedComponentId: "A",
        message: "B intersects A",
      }, {
        code: "collision",
        componentId: "A",
        relatedComponentId: "B",
        message: "A intersects B",
      }, {
        code: "unsupported",
        componentId: "FLOAT_REPORT",
        message: "FLOAT_REPORT is unsupported",
      }, {
        code: "unsupported",
        componentId: "FLOAT_ENFORCE",
        message: "FLOAT_ENFORCE is unsupported",
      }],
    });

    const view = buildWorkspaceValidationView({ workspace, physicsReport: report });
    expect(view.issues.filter((issue) => issue.code === "collision")).toEqual([
      expect.objectContaining({ id: "spatial:collision:A:B", severity: "blocking" }),
    ]);
    expect(view.issues.find((issue) => issue.id.includes("FLOAT_REPORT"))?.severity).toBe("warning");
    expect(view.issues.find((issue) => issue.id.includes("FLOAT_ENFORCE"))?.severity).toBe("blocking");
    expect(view.counts).toEqual({ blocking: 2, warning: 1, info: 0, total: 3 });
  });

  it("projects Reality availability, calibration, and broken proxy references without mutating state", () => {
    const base = new WorkspaceStore().getState();
    const reality = realityComponent("REALITY", { semanticProxyIds: ["MISSING_PROXY"] });
    const workspace = withComponents(base, [reality]);
    const before = structuredClone(reality.props);

    const view = buildWorkspaceValidationView({
      workspace,
      physicsReport: physicsReport(workspace),
      realityAvailability: { ra_test: "missing" },
    });

    expect(view.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "asset_unavailable", severity: "blocking" }),
      expect.objectContaining({ code: "semantic_proxy_missing", severity: "blocking" }),
      expect.objectContaining({ code: "uncalibrated", severity: "warning" }),
    ]));
    expect(reality.props).toEqual(before);
    expect(view.revision).toBe(workspace.revision);
  });

  it("combines binding and source diagnostics with deterministic navigation targets", () => {
    const workspace = new WorkspaceStore().getState();
    const view = buildWorkspaceValidationView({
      workspace,
      physicsReport: physicsReport(workspace),
      bindingDiagnostics: [{
        bindingId: "BIND_PRICE",
        componentId: "CHART",
        resourceId: "PRICES",
        targetProp: "series",
        code: "source_path_not_found",
        severity: "error",
        message: "Binding path $.series does not exist",
      }],
      sources: [{
        id: "PRICES",
        label: "Market prices",
        status: "stale",
        automationPaused: true,
      }],
    });

    expect(view.issues.map((issue) => issue.id)).toEqual([
      "data:binding:BIND_PRICE:source_path_not_found:CHART:PRICES",
      "data:source-stale:PRICES",
      "data:automation-paused:PRICES",
    ]);
    expect(view.issues[0]?.target).toEqual({
      surface: "sources",
      componentId: "CHART",
      resourceId: "PRICES",
      section: "bindings",
    });
    expect(view.counts).toEqual({ blocking: 1, warning: 1, info: 1, total: 3 });
  });

  it("reports each canonical 2D overlap once and exposes truncated coverage", () => {
    const workspace = new WorkspaceStore().getState();
    buildLayoutGraph.mockReturnValue({
      overlapConflicts: [{ componentId: "PANEL_B", conflictsWith: "PANEL_A", overlap: { area: 1200.25 } }, {
        componentId: "PANEL_A",
        conflictsWith: "PANEL_B",
        overlap: { area: 1200.25 },
      }],
      overlapConflictsTruncated: true,
    });

    const view = buildWorkspaceValidationView({ workspace, physicsReport: physicsReport(workspace) });

    expect(view.issues).toEqual([
      expect.objectContaining({
        id: "layout:overlap:PANEL_A:PANEL_B",
        domain: "layout",
        severity: "blocking",
        code: "layout_overlap",
        target: { surface: "inspector", componentId: "PANEL_A", section: "layout" },
      }),
      expect.objectContaining({
        id: "layout:overlap-capacity",
        domain: "layout",
        severity: "warning",
        code: "layout_overlap_capacity",
      }),
    ]);
    expect(view.counts).toEqual({ blocking: 1, warning: 1, info: 0, total: 2 });
    expect(view.coverage.join(" ")).toMatch(/1440.900 authoring plane/iu);
    expect(view.limitations.join(" ")).toMatch(/projection-dependent panels.*not persistent hard layout judgments/iu);
  });

  it("uses honest bounded language for an empty result", () => {
    const workspace = new WorkspaceStore().getState();
    const view = buildWorkspaceValidationView({ workspace, physicsReport: physicsReport(workspace) });

    expect(view).toMatchObject({ bounded: true, issues: [], counts: { total: 0 } });
    expect(view.limitations.join(" ")).toMatch(/not structural.*certification/iu);
    expect(view.coverage).toHaveLength(5);
  });
});
