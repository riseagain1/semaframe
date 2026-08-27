import { describe, expect, it } from "vitest";
import { DEFAULT_COMPONENT_REGISTRY } from "../../../workspace/components";
import { WorkspaceAgentController } from "../../../workspace/agents/WorkspaceAgentController";
import { WorkspaceStoreEngineAdapter } from "../../../workspace/agents/WorkspaceStoreEngineAdapter";
import { WorkspaceStore } from "../../../workspace/state";
import { workspaceBatch } from "../../workspace/helpers";

const placement = (x: number) => ({
  space: "world3d" as const,
  position: { x, y: 0, z: 0 },
  rotation: { x: 0, y: 0, z: 0 },
  scale: { x: 1, y: 1, z: 1 },
});

describe("Workspace Agent SemaFrame Spatial Graph", () => {
  it("inspects live spatial state, preflights collision, rejects overlap, and accepts a suggested correction", async () => {
    const store = new WorkspaceStore();
    store.apply(workspaceBatch(store, "seed_space", [{
      op: "create_component", op_id: "stage", id: "STAGE",
      component_type: DEFAULT_COMPONENT_REGISTRY.ref("stage-3d"), placement: placement(0),
    }, {
      op: "create_component", op_id: "entity", id: "ENTITY_A",
      component_type: DEFAULT_COMPONENT_REGISTRY.ref("spatial-entity"), placement: placement(0),
      props: { assetId: "primitive_box", entityKind: "primitive" },
    }]));
    const controller = new WorkspaceAgentController(new WorkspaceStoreEngineAdapter(store), {
      randomToken: (() => { let counter = 0; return (prefix) => `${prefix}_${String(++counter).padStart(24, "0")}`; })(),
      grantScopes: ({ requestedScopes }) => requestedScopes,
    });
    const instructions = await controller.getWorkspaceInstructions({ client_id: "spatial-e2e" });
    expect(instructions.ok).toBe(true);
    if (!instructions.ok) return;
    const session = {
      session_token: instructions.data.session_token,
      instruction_digest: instructions.data.guide_digest,
    };

    const full = await controller.inspectWorkspaceSpace(session);
    expect(full).toMatchObject({
      ok: true,
      data: {
        workspace_revision: 1,
        spatial_graph: {
          format: "semaframe-spatial-graph",
          version: "3.2",
          dimension_domain: "world3d",
          mode: "full",
          stage: {
            component_id: "STAGE",
            dimensions: { width: 12, height: 4, depth: 10 },
            ground_height: 0,
          },
          nodes: [expect.objectContaining({
            id: "ENTITY_A",
            prim_path: "/World/ENTITY_A",
            collision: expect.objectContaining({ shape: "box", role: "solid" }),
          })],
        },
      },
    });

    const preflight = await controller.querySpatialPlacement({
      ...session,
      candidate: {
        asset_id: "primitive_box",
        entity_kind: "primitive",
        placement: placement(0.2),
      },
    });
    expect(preflight).toMatchObject({
      ok: true,
      data: { placement_check: { valid: false, suggested_placements: expect.any(Array) } },
    });
    if (!preflight.ok) return;
    const suggestions = (preflight.data.placement_check as {
      suggested_placements: Array<ReturnType<typeof placement>>;
    }).suggested_placements;
    expect(suggestions.length).toBeGreaterThan(0);

    const prepared = await controller.beginWorkspaceUpdate({
      ...session,
      intent: "Add a second collision-safe primitive",
      requested_component_ids: 1,
    });
    expect(prepared.ok).toBe(true);
    if (!prepared.ok) return;
    const componentId = prepared.data.reserved_component_ids[0]!;
    const operation = (target: ReturnType<typeof placement>) => ({
      op: "create_component" as const,
      op_id: "create_second",
      id: componentId,
      component_type: DEFAULT_COMPONENT_REGISTRY.ref("spatial-entity"),
      placement: target,
      props: { assetId: "primitive_box", entityKind: "primitive" },
    });
    const overlapping = await controller.submitWorkspaceBatch({
      ...session,
      transaction_token: prepared.data.transaction_token,
      batch: { ...prepared.data.envelope, operations: [operation(placement(0.2))] },
    });
    expect(overlapping).toMatchObject({
      ok: false,
      error: {
        code: "spatial_collision",
        retryable: true,
        required_action: "query_spatial_placement",
      },
    });
    expect(store.getRevision()).toBe(1);

    const corrected = await controller.submitWorkspaceBatch({
      ...session,
      transaction_token: prepared.data.transaction_token,
      batch: { ...prepared.data.envelope, operations: [operation(suggestions[0]!)] },
    });
    if (!corrected.ok) throw new Error(JSON.stringify(corrected.error));
    expect(corrected).toMatchObject({ ok: true, data: { resulting_workspace_revision: 2 } });
    const delta = await controller.inspectWorkspaceSpace({ ...session, since_revision: 1 });
    expect(delta).toMatchObject({
      ok: true,
      data: { spatial_graph: { mode: "delta", since_revision: 1, nodes: [expect.objectContaining({ id: componentId })] } },
    });
  });

  it("exposes an independent ui2d graph, preflights explicit-size panels, and keeps a rejected transaction repairable", async () => {
    const store = new WorkspaceStore();
    const panelPlacement = {
      space: "viewport" as const,
      anchor: "top_left" as const,
      offset: { x: 0, y: 0 },
      size: { width: 320, height: 220 },
      zIndex: 10,
    };
    store.apply(workspaceBatch(store, "seed_layout_domains", [{
      op: "create_component", op_id: "stage", id: "STAGE",
      component_type: DEFAULT_COMPONENT_REGISTRY.ref("stage-3d"), placement: placement(0),
    }, {
      op: "create_component", op_id: "entity", id: "ENTITY_A",
      component_type: DEFAULT_COMPONENT_REGISTRY.ref("spatial-entity"), placement: placement(0),
      props: { assetId: "primitive_box", entityKind: "primitive" },
    }, {
      op: "create_component", op_id: "panel", id: "PANEL_A",
      component_type: DEFAULT_COMPONENT_REGISTRY.ref("panel"), placement: panelPlacement,
    }]));
    const controller = new WorkspaceAgentController(new WorkspaceStoreEngineAdapter(store), {
      randomToken: (() => { let counter = 0; return (prefix) => `${prefix}_${String(++counter).padStart(24, "0")}`; })(),
      grantScopes: ({ requestedScopes }) => requestedScopes,
    });
    const instructions = await controller.getWorkspaceInstructions({ client_id: "layout-e2e" });
    if (!instructions.ok) throw new Error(JSON.stringify(instructions.error));
    const session = {
      session_token: instructions.data.session_token,
      instruction_digest: instructions.data.guide_digest,
    };

    const full = await controller.inspectWorkspaceSpace(session);
    expect(full).toMatchObject({
      ok: true,
      data: {
        spatial_graph: {
          dimension_domain: "world3d",
          nodes: [expect.objectContaining({ id: "ENTITY_A" })],
        },
        layout_graph: {
          format: "semaframe-layout-graph",
          version: "1.0",
          dimension_domain: "ui2d",
          coordinate_system: { units: "logical_px", width: 1440, height: 900, safe_inset: 20 },
          nodes: [expect.objectContaining({
            id: "PANEL_A",
            dimension_domain: "ui2d",
            resolution: "canonical",
            collision_domain: "overlay2d:canonical",
          })],
        },
      },
    });
    if (!full.ok) return;
    const spatialIds = ((full.data.spatial_graph as { nodes: Array<{ id: string }> }).nodes).map(({ id }) => id);
    const layoutIds = ((full.data.layout_graph as { nodes: Array<{ id: string }> }).nodes).map(({ id }) => id);
    expect(spatialIds).not.toContain("PANEL_A");
    expect(layoutIds).not.toContain("ENTITY_A");
    expect(layoutIds).not.toContain("STAGE");

    const candidate = {
      placement: {
        ...panelPlacement,
        offset: { x: 40, y: 30 },
        zIndex: 999,
      },
    };
    const preflight = await controller.queryLayoutPlacement({ ...session, candidate });
    expect(preflight).toMatchObject({
      ok: true,
      data: {
        workspace_revision: 1,
        placement_check: {
          valid: false,
          dimension_domain: "ui2d",
          collision_domain: "overlay2d:canonical",
          mutates_workspace: false,
          conflicts: [expect.objectContaining({
            conflicts_with: "PANEL_A",
            collision_domain: "overlay2d:canonical",
          })],
          suggested_placements: expect.any(Array),
        },
      },
    });
    if (!preflight.ok) return;
    expect(store.getRevision()).toBe(1);
    const suggestions = (preflight.data.placement_check as {
      suggested_placements: Array<typeof panelPlacement>;
    }).suggested_placements;
    expect(suggestions.length).toBeGreaterThan(0);

    expect(await controller.queryLayoutPlacement({
      ...session,
      candidate: { placement: placement(0) },
    })).toMatchObject({
      ok: false,
      error: { code: "invalid_layout_candidate", required_action: "query_layout_placement" },
    });
    expect(await controller.queryLayoutPlacement({
      ...session,
      candidate: { placement: { space: "canvas2d", position: { x: 0, y: 0 } } },
    })).toMatchObject({
      ok: false,
      error: { code: "invalid_layout_candidate", required_action: "query_layout_placement" },
    });

    const prepared = await controller.beginWorkspaceUpdate({
      ...session,
      intent: "Add a second non-overlapping panel",
      requested_component_ids: 1,
    });
    if (!prepared.ok) throw new Error(JSON.stringify(prepared.error));
    const componentId = prepared.data.reserved_component_ids[0]!;
    const operation = (target: typeof panelPlacement) => ({
      op: "create_component" as const,
      op_id: "create_second_panel",
      id: componentId,
      component_type: DEFAULT_COMPONENT_REGISTRY.ref("panel"),
      placement: target,
    });
    const rejected = await controller.submitWorkspaceBatch({
      ...session,
      transaction_token: prepared.data.transaction_token,
      batch: { ...prepared.data.envelope, operations: [operation(candidate.placement)] },
    });
    expect(rejected).toMatchObject({
      ok: false,
      error: { code: "layout_overlap", retryable: true, required_action: "query_layout_placement" },
    });
    expect(store.getRevision()).toBe(1);

    const corrected = await controller.submitWorkspaceBatch({
      ...session,
      transaction_token: prepared.data.transaction_token,
      batch: { ...prepared.data.envelope, operations: [operation(suggestions[0]!)] },
    });
    expect(corrected).toMatchObject({ ok: true, data: { resulting_workspace_revision: 2 } });
    const delta = await controller.inspectWorkspaceSpace({ ...session, since_revision: 1 });
    expect(delta).toMatchObject({
      ok: true,
      data: {
        layout_graph: {
          mode: "delta",
          since_revision: 1,
          nodes: [expect.objectContaining({ id: componentId })],
        },
      },
    });
  });

  it("exposes physical feasibility, stable placement, settle simulation, and enforced atomic rejection", async () => {
    const store = new WorkspaceStore();
    store.apply(workspaceBatch(store, "seed_physics", [{
      op: "create_component", op_id: "stage", id: "STAGE",
      component_type: DEFAULT_COMPONENT_REGISTRY.ref("stage-3d"), placement: placement(0),
    }, {
      op: "create_component", op_id: "floating", id: "FLOATING",
      component_type: DEFAULT_COMPONENT_REGISTRY.ref("spatial-entity"),
      placement: { ...placement(0), position: { x: 0, y: 3, z: 0 } },
      props: {
        assetId: "primitive_box",
        entityKind: "primitive",
        physics: {
          enabled: true,
          bodyType: "dynamic", massKg: 2, centerOfMass: { x: 0, y: 0, z: 0 },
          friction: 0.6, restitution: 0.1, gravityScale: 1, stabilityMode: "report", constraints: [],
        },
      },
    }]));
    const controller = new WorkspaceAgentController(new WorkspaceStoreEngineAdapter(store), {
      randomToken: (() => { let counter = 0; return (prefix) => `${prefix}_${String(++counter).padStart(24, "0")}`; })(),
      grantScopes: ({ requestedScopes }) => requestedScopes,
    });
    const instructions = await controller.getWorkspaceInstructions({ client_id: "physics-e2e" });
    if (!instructions.ok) throw new Error(JSON.stringify(instructions.error));
    const session = { session_token: instructions.data.session_token, instruction_digest: instructions.data.guide_digest };

    expect(await controller.inspectWorkspacePhysics({ ...session, component_ids: ["FLOATING"] })).toMatchObject({
      ok: true,
      data: {
        physics_validation: {
          version: "2.0",
          model: "quasi_static_rigid_support_v2",
          feasible: false,
          bodies: [expect.objectContaining({ component_id: "FLOATING", grounded: false, stability_reason: "unsupported" })],
          issues: [expect.objectContaining({ code: "unsupported", component_id: "FLOATING" })],
        },
      },
    });
    const candidate = {
      asset_id: "primitive_box",
      entity_kind: "primitive",
      placement: { ...placement(4), position: { x: 4, y: 3, z: 0 } },
      physics: {
        enabled: true,
        bodyType: "dynamic", massKg: 2, centerOfMass: { x: 0, y: 0, z: 0 },
        friction: 0.6, restitution: 0.1, gravityScale: 1, stabilityMode: "enforce", constraints: [],
      },
    };
    const stablePlacement = await controller.queryStablePlacement({ ...session, candidate });
    expect(stablePlacement).toMatchObject({ ok: true, data: { stability_check: { valid: false } } });
    if (!stablePlacement.ok) throw new Error(JSON.stringify(stablePlacement.error));
    expect((stablePlacement.data.stability_check as {
      suggested_placements: Array<{ position: { y: number } }>;
    }).suggested_placements[0]?.position.y).toBe(0);
    const disabledPlacement = await controller.queryStablePlacement({
      ...session,
      candidate: { ...candidate, physics: { ...candidate.physics, enabled: false } },
    });
    expect(disabledPlacement).toMatchObject({
      ok: true,
      data: { stability_check: { valid: true, body: { enabled: false, stability_reason: "disabled" }, issues: [] } },
    });
    const simulation = await controller.simulateWorkspacePhysics({ ...session, component_ids: ["FLOATING"], duration_ms: 1_000, time_step_ms: 20 });
    expect(simulation).toMatchObject({
      ok: true,
      data: {
        simulation: {
          version: "2.0",
          model: "quasi_static_vertical_drop_v2",
          mutates_workspace: false,
          modeled_properties: ["gravity_scale", "solid_collision_geometry", "grounded_supports", "fixed_step_time"],
          ignored_properties: ["mass_kg", "friction", "restitution", "angular_motion"],
        },
      },
    });
    if (!simulation.ok) throw new Error(JSON.stringify(simulation.error));
    expect((simulation.data.simulation as {
      proposals: Array<{ component_id: string; settled: boolean; to: { position: { y: number } } }>;
    }).proposals[0]).toMatchObject({ component_id: "FLOATING", settled: true });
    expect((simulation.data.simulation as {
      proposals: Array<{ to: { position: { y: number } } }>;
    }).proposals[0]?.to.position.y).toBe(0);

    const prepared = await controller.beginWorkspaceUpdate({
      ...session, intent: "Create one enforced floating body", requested_component_ids: 1,
    });
    if (!prepared.ok) throw new Error(JSON.stringify(prepared.error));
    const rejected = await controller.submitWorkspaceBatch({
      ...session,
      transaction_token: prepared.data.transaction_token,
      batch: {
        ...prepared.data.envelope,
        operations: [{
          op: "create_component",
          op_id: "create_enforced_float",
          id: prepared.data.reserved_component_ids[0],
          component_type: DEFAULT_COMPONENT_REGISTRY.ref("spatial-entity"),
          placement: { ...placement(8), position: { x: 8, y: 4, z: 0 } },
          props: { assetId: "primitive_box", entityKind: "primitive", physics: candidate.physics },
        }],
      },
    });
    expect(rejected).toMatchObject({
      ok: false,
      error: { code: "physics_validation_failed", retryable: true, required_action: "query_stable_placement" },
    });
    expect(store.getRevision()).toBe(1);
  });
});
