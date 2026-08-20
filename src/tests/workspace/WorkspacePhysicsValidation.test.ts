import { describe, expect, it } from "vitest";
import { DEFAULT_COMPONENT_REGISTRY } from "../../workspace/components";
import {
  buildPhysicsValidationReport,
  queryStablePlacement,
  simulatePhysicsSettle,
  type SpatialPhysicsConfig,
} from "../../workspace/physics";
import { buildSemaFrameSpatialGraph, querySpatialPlacement } from "../../workspace/spatial";
import { WorkspaceProjectSerializer } from "../../workspace/persistence";
import { WorkspaceStore } from "../../workspace/state";
import { workspaceBatch } from "./helpers";

const placement = (x: number, y = 0, z = 0) => ({
  space: "world3d" as const,
  position: { x, y, z },
  rotation: { x: 0, y: 0, z: 0 },
  scale: { x: 1, y: 1, z: 1 },
});

const physics = (patch: Partial<SpatialPhysicsConfig> = {}): SpatialPhysicsConfig => ({
  enabled: true,
  bodyType: "dynamic",
  massKg: 10,
  centerOfMass: { x: 0, y: 0, z: 0 },
  friction: 0.6,
  restitution: 0.1,
  gravityScale: 1,
  stabilityMode: "report",
  constraints: [],
  ...patch,
});

const stage = () => ({
  op: "create_component" as const,
  op_id: "stage",
  id: "STAGE",
  component_type: DEFAULT_COMPONENT_REGISTRY.ref("stage-3d"),
  placement: placement(0),
});

const spatial = (id: string, x: number, y: number, props: Record<string, unknown> = {}) => ({
  op: "create_component" as const,
  op_id: `create_${id}`,
  id,
  component_type: DEFAULT_COMPONENT_REGISTRY.ref("spatial-entity"),
  placement: placement(x, y),
  props: { assetId: "primitive_box", entityKind: "primitive", ...props },
});

const parametric = (
  id: string,
  x: number,
  y: number,
  props: Record<string, unknown> = {},
  parentId?: string,
) => ({
  op: "create_component" as const,
  op_id: `create_${id}`,
  id,
  component_type: DEFAULT_COMPONENT_REGISTRY.ref("spatial-primitive"),
  ...(parentId ? { parent_id: parentId } : {}),
  placement: placement(x, y),
  props: { geometry: { kind: "sphere", radiusM: 0.5 }, ...props },
});

describe("Workspace deterministic physics validation", () => {
  it("publishes 1.5 switchable rigid-body intent in the SemaFrame Spatial Graph and reports stable support", () => {
    const store = new WorkspaceStore();
    store.apply(workspaceBatch(store, "stable_stack", [
      stage(),
      spatial("BASE", 0, 0),
      spatial("TOP", 0, 1.04, { physics: physics({ stabilityMode: "enforce" }) }),
    ]));

    const manifest = DEFAULT_COMPONENT_REGISTRY.get("spatial-entity")!;
    expect(manifest.version).toBe("1.5.0");
    const spatialGraph = buildSemaFrameSpatialGraph(store.getState());
    expect(spatialGraph.nodes.find((node) => node.id === "TOP")).toMatchObject({
      physics: { enabled: true, bodyType: "dynamic", massKg: 10, stabilityMode: "enforce" },
      collision: { source: "asset_bounds", parts: [expect.objectContaining({ id: "asset_bounds" })] },
    });
    const report = buildPhysicsValidationReport(store.getState());
    expect(report.feasible).toBe(true);
    expect(report.bodies.find((body) => body.componentId === "TOP")).toMatchObject({
      stable: true,
      stabilityReason: "supported",
      supports: [expect.objectContaining({ supportingComponentId: "BASE" })],
    });
  });

  it("rejects enforced instability atomically but permits report-only investigation", () => {
    const enforced = new WorkspaceStore();
    expect(() => enforced.apply(workspaceBatch(enforced, "floating", [
      stage(), spatial("FLOAT", 0, 4, { physics: physics({ stabilityMode: "enforce" }) }),
    ]))).toThrowError(expect.objectContaining({ code: "physics_validation_failed" }));
    expect(enforced.getRevision()).toBe(0);

    const reportOnly = new WorkspaceStore();
    reportOnly.apply(workspaceBatch(reportOnly, "floating_report", [
      stage(), spatial("FLOAT", 0, 4, { physics: physics() }),
    ]));
    expect(buildPhysicsValidationReport(reportOnly.getState())).toMatchObject({
      feasible: false,
      issues: [expect.objectContaining({ code: "unsupported", componentId: "FLOAT" })],
    });
  });

  it("turns stability, constraints, and settling off without weakening independent collision", () => {
    const store = new WorkspaceStore();
    store.apply(workspaceBatch(store, "physics_disabled", [
      stage(),
      spatial("DISABLED", 0, 4, { physics: physics({
        enabled: false,
        stabilityMode: "enforce",
        constraints: [{
          id: "MISSING_TARGET",
          type: "fixed",
          targetId: "DOES_NOT_EXIST",
          anchor: { x: 0, y: 0, z: 0 },
          targetAnchor: { x: 0, y: 0, z: 0 },
          axis: { x: 0, y: 1, z: 0 },
          enabled: true,
        }],
      }) }),
    ]));
    const report = buildPhysicsValidationReport(store.getState());
    expect(report).toMatchObject({ feasible: true, issues: [] });
    expect(report.bodies.find((body) => body.componentId === "DISABLED")).toMatchObject({
      enabled: false,
      stable: true,
      stabilityReason: "disabled",
      supports: [],
    });
    expect(simulatePhysicsSettle(store.getState()).proposals).toEqual([]);
    expect(queryStablePlacement(store.getState(), {
      assetId: "primitive_box",
      entityKind: "primitive",
      placement: placement(3, 8),
      physics: physics({ enabled: false, stabilityMode: "enforce" }),
    })).toMatchObject({ valid: true, body: { enabled: false, stabilityReason: "disabled" }, issues: [] });
    const serializer = new WorkspaceProjectSerializer();
    const reopened = serializer.openStore(serializer.deserialize(serializer.serialize(serializer.fromStore("disabled_physics", store))));
    expect(reopened.getState().components.get("DISABLED")?.props.physics).toMatchObject({
      enabled: false,
      massKg: 10,
      constraints: [expect.objectContaining({ id: "MISSING_TARGET", enabled: true })],
    });
    expect(simulatePhysicsSettle(reopened.getState()).proposals).toEqual([]);

    expect(() => store.apply(workspaceBatch(store, "collision_still_enabled", [
      spatial("OVERLAP", 0, 4, { physics: physics({ enabled: false }) }),
    ]))).toThrowError(expect.objectContaining({ code: "spatial_collision" }));
  });

  it("computes COM tip risk and validates normalized joint anchors", () => {
    const store = new WorkspaceStore();
    store.apply(workspaceBatch(store, "constraint_and_tip", [
      stage(),
      spatial("BASE", 0, 0),
      spatial("HINGED", 0, 1.04, { physics: physics({
        centerOfMass: { x: 0.8, y: 0, z: 0 },
        constraints: [{
          id: "JOINT_hinge",
          type: "hinge",
          targetId: "BASE",
          anchor: { x: 0, y: 0, z: 0 },
          targetAnchor: { x: 0, y: 1.04, z: 0 },
          axis: { x: 0, y: 0, z: 1 },
          enabled: true,
        }],
      }) }),
    ]));
    const report = buildPhysicsValidationReport(store.getState());
    expect(report.issues).toContainEqual(expect.objectContaining({ code: "tip_risk", componentId: "HINGED" }));
    expect(report.issues.some((issue) => issue.code.startsWith("constraint_"))).toBe(false);
  });

  it("runs a bounded non-mutating settle and returns an absolute stable placement", () => {
    const store = new WorkspaceStore();
    store.apply(workspaceBatch(store, "settle", [
      stage(), spatial("FALLING", 0, 4, { physics: physics() }),
    ]));
    const before = structuredClone(store.getState().components.get("FALLING")!.placement);
    const result = simulatePhysicsSettle(store.getState(), { durationMs: 1_000, timeStepMs: 20 });
    expect(result).toMatchObject({ mutatesWorkspace: false, durationMs: 1_000, timeStepMs: 20, appliedSteps: 50 });
    expect(result.proposals[0]).toMatchObject({ componentId: "FALLING", settled: true });
    expect((result.proposals[0]!.to as ReturnType<typeof placement>).position.y).toBeCloseTo(0, 6);
    expect(result.report.bodies.find((body) => body.componentId === "FALLING")?.stable).toBe(true);
    expect(store.getState().components.get("FALLING")!.placement).toEqual(before);
  });

  it("resolves explicit and compound colliders and keeps them through project replay", () => {
    const store = new WorkspaceStore();
    store.apply(workspaceBatch(store, "compound", [stage(), spatial("COMPOUND", 0, 0, {
      collision: {
        enabled: true,
        role: "solid",
        shape: "compound",
        margin: 0,
        parts: [
          { id: "left", center: { x: -1, y: 0.5, z: 0 }, size: { x: 1, y: 1, z: 1 }, rotation: { x: 0, y: 0, z: 0 } },
          { id: "right", center: { x: 1, y: 0.5, z: 0 }, size: { x: 1, y: 1, z: 1 }, rotation: { x: 0, y: 0, z: 0 } },
        ],
      },
    })]));
    expect(buildSemaFrameSpatialGraph(store.getState()).nodes[0]?.collision).toMatchObject({
      shape: "compound",
      source: "compound",
      parts: [{ id: "left" }, { id: "right" }],
    });
    expect(querySpatialPlacement(store.getState(), {
      assetId: "primitive_box",
      entityKind: "primitive",
      placement: placement(1, 0),
    }).valid).toBe(false);
    const serializer = new WorkspaceProjectSerializer();
    const reopened = serializer.openStore(serializer.deserialize(serializer.serialize(serializer.fromStore("physics", store))));
    expect(reopened.getState().components.get("COMPOUND")?.props.collision).toMatchObject({ shape: "compound" });
  });

  it("fails closed on duplicate constraint and compound-part identities", () => {
    const duplicateConstraint = new WorkspaceStore();
    const joint = {
      id: "JOINT_DUP", type: "fixed" as const, targetId: "BASE",
      anchor: { x: 0, y: 0, z: 0 }, targetAnchor: { x: 0, y: 1.04, z: 0 },
      axis: { x: 0, y: 1, z: 0 }, enabled: true,
    };
    expect(() => duplicateConstraint.apply(workspaceBatch(duplicateConstraint, "duplicate_joint", [
      stage(), spatial("BASE", 0, 0),
      spatial("TOP", 0, 1.04, { physics: physics({ constraints: [joint, joint] }) }),
    ]))).toThrowError(expect.objectContaining({ code: "invalid_spatial_physics" }));

    const duplicatePart = new WorkspaceStore();
    const part = { id: "part", center: { x: 0, y: 0.5, z: 0 }, size: { x: 1, y: 1, z: 1 }, rotation: { x: 0, y: 0, z: 0 } };
    expect(() => duplicatePart.apply(workspaceBatch(duplicatePart, "duplicate_part", [stage(), spatial("BOX", 0, 0, {
      collision: { enabled: true, role: "solid", shape: "compound", margin: 0, parts: [part, part] },
    })]))).toThrowError(expect.objectContaining({ code: "invalid_spatial_collision" }));
  });

  it("preflights a dynamic placement and suggests the gravity-settled correction", () => {
    const store = new WorkspaceStore();
    store.apply(workspaceBatch(store, "query", [stage()]));
    const check = queryStablePlacement(store.getState(), {
      assetId: "primitive_box",
      entityKind: "primitive",
      placement: placement(0, 3),
      physics: physics(),
    });
    expect(check.valid).toBe(false);
    expect(check.issues).toContainEqual(expect.objectContaining({ code: "unsupported" }));
    expect(check.suggestedPlacements[0]).toMatchObject({ position: { y: 0 } });
  });

  it("upgrades a pinned 1.3 collider explicitly to 1.5 without changing its geometry", () => {
    const store = new WorkspaceStore();
    const legacyRef = DEFAULT_COMPONENT_REGISTRY.ref("spatial-entity", "1.3.0");
    const currentRef = DEFAULT_COMPONENT_REGISTRY.ref("spatial-entity");
    store.apply(workspaceBatch(store, "legacy_physics", [stage(), {
      op: "create_component", op_id: "legacy_body", id: "LEGACY_BODY",
      component_type: legacyRef,
      placement: placement(2, 0),
      props: { assetId: "primitive_box", entityKind: "primitive" },
    }]));
    const before = structuredClone(store.getState().components.get("LEGACY_BODY")!.placement);
    store.apply(workspaceBatch(store, "upgrade_physics", [{
      op: "upgrade_component_manifest", op_id: "upgrade_body", id: "LEGACY_BODY", component_type: currentRef,
    }]));
    expect(store.getState().components.get("LEGACY_BODY")).toMatchObject({
      type: currentRef,
      placement: before,
      props: { physics: { enabled: true, bodyType: "static", stabilityMode: "report" } },
    });
    store.undo();
    expect(store.getState().components.get("LEGACY_BODY")?.type).toEqual(legacyRef);
    store.redo();
    expect(store.getState().components.get("LEGACY_BODY")?.type).toEqual(currentRef);
  });

  it("migrates a complete 1.4 physics object to the 1.5 master switch without losing tuned values", () => {
    const store = new WorkspaceStore();
    const legacyRef = DEFAULT_COMPONENT_REGISTRY.ref("spatial-entity", "1.4.0");
    const currentRef = DEFAULT_COMPONENT_REGISTRY.ref("spatial-entity");
    const legacyPhysics = {
      bodyType: "dynamic", massKg: 27, centerOfMass: { x: 0.1, y: 0.2, z: 0.3 },
      friction: 0.85, restitution: 0.25, gravityScale: 0.75, stabilityMode: "report", constraints: [],
    };
    store.apply(workspaceBatch(store, "legacy_1_4", [stage(), {
      op: "create_component", op_id: "legacy_1_4_body", id: "LEGACY_1_4",
      component_type: legacyRef, placement: placement(4, 0),
      props: { assetId: "primitive_box", entityKind: "primitive", physics: legacyPhysics },
    }]));
    expect(store.getState().components.get("LEGACY_1_4")?.props.physics).not.toHaveProperty("enabled");
    store.apply(workspaceBatch(store, "upgrade_1_4", [{
      op: "upgrade_component_manifest", op_id: "upgrade_1_4_body", id: "LEGACY_1_4", component_type: currentRef,
    }]));
    expect(store.getState().components.get("LEGACY_1_4")?.props.physics).toEqual({ enabled: true, ...legacyPhysics });
    store.undo();
    expect(store.getState().components.get("LEGACY_1_4")?.props.physics).toEqual(legacyPhysics);
    store.redo();
    expect(store.getState().components.get("LEGACY_1_4")?.props.physics).toEqual({ enabled: true, ...legacyPhysics });
  });

  it("uses exact rotated and compound contact faces instead of envelope AABBs", () => {
    const store = new WorkspaceStore();
    store.apply(workspaceBatch(store, "exact_support_faces", [
      stage(),
      {
        ...spatial("ROTATED", -2, 0, {
          collision: {
            enabled: true,
            role: "solid",
            shape: "box",
            center: { x: 0, y: 0.5, z: 0 },
            size: { x: 4, y: 1, z: 0.4 },
            margin: 0,
          },
          physics: physics({ centerOfMass: { x: 0, y: 0, z: 0.8 } }),
        }),
        placement: { ...placement(-2), rotation: { x: 0, y: Math.PI / 4, z: 0 } },
      },
      spatial("COMPOUND", 2, 0, {
        collision: {
          enabled: true,
          role: "solid",
          shape: "compound",
          margin: 0,
          parts: [
            { id: "ground_foot", center: { x: -2, y: 0.5, z: 0 }, size: { x: 1, y: 1, z: 1 }, rotation: { x: 0, y: 0, z: 0 } },
            { id: "elevated", center: { x: 2, y: 5.5, z: 0 }, size: { x: 1, y: 1, z: 1 }, rotation: { x: 0, y: 0, z: 0 } },
          ],
        },
        physics: physics(),
      }),
    ]));
    const report = buildPhysicsValidationReport(store.getState());
    expect(report.bodies.find((body) => body.componentId === "ROTATED")).toMatchObject({
      stable: false,
      grounded: false,
      stabilityReason: "tip_risk",
    });
    expect(report.bodies.find((body) => body.componentId === "COMPOUND")).toMatchObject({
      stable: false,
      grounded: false,
      stabilityReason: "tip_risk",
    });
    expect(report.issues.filter((issue) => issue.code === "tip_risk").map((issue) => issue.componentId))
      .toEqual(["COMPOUND", "ROTATED"]);
  });

  it("requires a complete grounded load path and excludes disabled bodies from support", () => {
    for (const [requestId, lowerPhysics] of [
      ["floating_chain", physics({ stabilityMode: "report" })],
      ["disabled_support", physics({ enabled: false })],
    ] as const) {
      const store = new WorkspaceStore();
      expect(() => store.apply(workspaceBatch(store, requestId, [
        stage(),
        spatial("LOWER", 0, 4, { physics: lowerPhysics }),
        spatial("UPPER", 0, 5.04, { physics: physics({ stabilityMode: "enforce" }) }),
      ]))).toThrowError(expect.objectContaining({ code: "physics_validation_failed" }));
      expect(store.getRevision()).toBe(0);
    }
  });

  it("lets a valid fixed constraint provide a grounded load path", () => {
    const store = new WorkspaceStore();
    store.apply(workspaceBatch(store, "fixed_load_path", [
      stage(),
      spatial("ANCHOR", 0, 4),
      spatial("FIXED", 0, 5.04, { physics: physics({
        stabilityMode: "enforce",
        constraints: [{
          id: "FIXED_TO_ANCHOR",
          type: "fixed",
          targetId: "ANCHOR",
          anchor: { x: 0, y: 0, z: 0 },
          targetAnchor: { x: 0, y: 1.04, z: 0 },
          axis: { x: 0, y: 1, z: 0 },
          enabled: true,
        }],
      }) }),
    ]));
    expect(buildPhysicsValidationReport(store.getState()).bodies.find((body) => body.componentId === "FIXED"))
      .toMatchObject({ stable: true, grounded: true, stabilityReason: "constrained" });
  });

  it("conservatively resolves remaining joint degrees of freedom", () => {
    const ball = new WorkspaceStore();
    ball.apply(workspaceBatch(ball, "stable_ball_joint", [
      stage(),
      spatial("ANCHOR", 0, 4),
      spatial("PENDULUM", 0, 2, { physics: physics({
        stabilityMode: "enforce",
        constraints: [{
          id: "BALL",
          type: "ball",
          targetId: "ANCHOR",
          anchor: { x: 0, y: 2, z: 0 },
          targetAnchor: { x: 0, y: 0, z: 0 },
          axis: { x: 0, y: 1, z: 0 },
          enabled: true,
        }],
      }) }),
    ]));
    expect(buildPhysicsValidationReport(ball.getState()).bodies.find((body) => body.componentId === "PENDULUM"))
      .toMatchObject({ stable: true, grounded: true, stabilityReason: "constrained" });

    const hinge = new WorkspaceStore();
    expect(() => hinge.apply(workspaceBatch(hinge, "unstable_hinge", [
      stage(),
      spatial("ANCHOR", 0, 4),
      spatial("HINGED_FREE", 0, 2, { physics: physics({
        centerOfMass: { x: 0.5, y: 0, z: 0 },
        stabilityMode: "enforce",
        constraints: [{
          id: "HINGE",
          type: "hinge",
          targetId: "ANCHOR",
          anchor: { x: 0, y: 2, z: 0 },
          targetAnchor: { x: 0, y: 0, z: 0 },
          axis: { x: 0, y: 0, z: 1 },
          enabled: true,
        }],
      }) }),
    ]))).toThrowError(expect.objectContaining({ code: "physics_validation_failed" }));
  });

  it("uses finite Stage bounds and rejects ground penetration", () => {
    const outside = new WorkspaceStore();
    expect(() => outside.apply(workspaceBatch(outside, "outside_stage", [
      stage(),
      spatial("OUTSIDE", 1_000, 0, { physics: physics({ stabilityMode: "enforce" }) }),
    ]))).toThrowError(expect.objectContaining({ code: "physics_validation_failed" }));

    const buried = new WorkspaceStore();
    buried.apply(workspaceBatch(buried, "buried_static", [stage(), spatial("BURIED", 0, -2)]));
    const report = buildPhysicsValidationReport(buried.getState());
    expect(report.feasible).toBe(false);
    expect(report.issues).toContainEqual(expect.objectContaining({ code: "ground_penetration", componentId: "BURIED" }));
    expect(report.bodies.find((body) => body.componentId === "BURIED"))
      .toMatchObject({ stable: false, grounded: false, stabilityReason: "penetrating" });

    const preflightStore = new WorkspaceStore();
    preflightStore.apply(workspaceBatch(preflightStore, "stage_only", [stage()]));
    const preflight = queryStablePlacement(preflightStore.getState(), {
      assetId: "primitive_box",
      entityKind: "primitive",
      placement: placement(1_000, 3),
      physics: physics({ stabilityMode: "enforce" }),
    });
    expect(preflight.valid).toBe(false);
    expect(preflight.suggestedPlacements[0]).toMatchObject({ position: { y: 0 } });
    expect((preflight.suggestedPlacements[0] as ReturnType<typeof placement>).position.x).toBeLessThanOrEqual(6);
  });

  it("uses the requested fixed step and declares the quasi-static model boundary", () => {
    const store = new WorkspaceStore();
    store.apply(workspaceBatch(store, "step_integrator", [
      stage(), spatial("FALL", 0, 10, { physics: physics() }),
    ]));
    const fine = simulatePhysicsSettle(store.getState(), { durationMs: 500, timeStepMs: 4 });
    const coarse = simulatePhysicsSettle(store.getState(), { durationMs: 500, timeStepMs: 100 });
    expect(fine).toMatchObject({
      version: "2.0",
      model: "quasi_static_vertical_drop_v2",
      appliedSteps: 125,
      modeledProperties: ["gravity_scale", "solid_collision_geometry", "grounded_supports", "fixed_step_time"],
      ignoredProperties: ["mass_kg", "friction", "restitution", "angular_motion"],
    });
    expect(coarse.appliedSteps).toBe(5);
    expect(fine.proposals[0]?.dropDistanceM).not.toBe(coarse.proposals[0]?.dropDistanceM);
  });

  it("reports exact parametric volume beside explicit stable-body mass evidence", () => {
    const store = new WorkspaceStore();
    store.apply(workspaceBatch(store, "parametric_mass_evidence", [
      stage(),
      {
        op: "create_component" as const,
        op_id: "create_model",
        id: "MODEL",
        component_type: DEFAULT_COMPONENT_REGISTRY.ref("model-assembly"),
        placement: placement(0),
        props: { collisionPolicy: "external_only" },
      },
      parametric("BALL", 0, 0.52, {
        physics: physics({ bodyType: "static", massKg: 7 }),
      }, "MODEL"),
    ]));

    const expectedVolume = (4 / 3) * Math.PI * 0.5 ** 3;
    const graphBody = buildSemaFrameSpatialGraph(store.getState()).nodes.find((node) => node.id === "BALL")!;
    expect(graphBody.physics).toMatchObject({
      massKg: 7,
      massSource: "explicit",
      geometryVolumeM3: expectedVolume,
    });
    const report = buildPhysicsValidationReport(store.getState());
    expect(report.feasible).toBe(true);
    expect(report.bodies.map((body) => body.componentId)).toEqual(["BALL"]);
    expect(report.bodies[0]).toMatchObject({
      massKg: 7,
      massSource: "explicit",
      geometryVolumeM3: expectedVolume,
      stable: true,
      grounded: true,
      stabilityReason: "anchored",
    });
  });
});
