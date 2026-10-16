import { describe, expect, it } from "vitest";
import { WorkspaceStoreEngineAdapter } from "../../../workspace/agents/WorkspaceStoreEngineAdapter";
import type { WorkspaceAgentPrincipal } from "../../../workspace/agents/contracts";
import { DEFAULT_COMPONENT_REGISTRY } from "../../../workspace/components";
import { WorkspaceStore } from "../../../workspace/state";
import { workspaceBatch } from "../../workspace/helpers";
import { WORKSPACE_MODELING_QUICKSTART, WORKSPACE_NEW_PRIMITIVE_PREFLIGHT } from "../../../workspace/agents/guide";

const reader: WorkspaceAgentPrincipal = {
  sessionId: "spatial_session", clientId: "spatial_client", clientName: "Spatial tests", scopes: ["workspace:read"],
};
const world = (z = 0) => ({
  space: "world3d" as const, position: { x: 0, y: 0, z },
  rotation: { x: 0, y: 0, z: 0 }, scale: { x: 1, y: 1, z: 1 },
});
function furniture() {
  const store = new WorkspaceStore();
  store.apply(workspaceBatch(store, "chair", [
    { op: "create_component", op_id: "stage", id: "STAGE",
      component_type: DEFAULT_COMPONENT_REGISTRY.ref("stage-3d"), placement: world() },
    { op: "create_component", op_id: "chair", id: "CHAIR",
      component_type: DEFAULT_COMPONENT_REGISTRY.ref("model-assembly"), placement: world(1.1),
      props: { collisionPolicy: "all" } },
    { op: "create_component", op_id: "seat", id: "SEAT", parent_id: "CHAIR",
      component_type: DEFAULT_COMPONENT_REGISTRY.ref("spatial-primitive"), placement: world(),
      props: { geometry: { kind: "box", sizeM: { x: 0.44, y: 0.05, z: 0.44 } } } },
  ]));
  return store;
}

describe("Spatial agent operation clarity", () => {
  it("executes the documented new primitive preflight and rejects guessed shape/position aliases", async () => {
    const store = furniture();
    const adapter = new WorkspaceStoreEngineAdapter(store);
    const revision = store.getRevision();
    expect(WORKSPACE_MODELING_QUICKSTART).toMatchObject({
      new_primitive_preflight: { candidate: WORKSPACE_NEW_PRIMITIVE_PREFLIGHT },
    });
    await expect(adapter.querySpatialPlacement(WORKSPACE_NEW_PRIMITIVE_PREFLIGHT, reader))
      .resolves.toMatchObject({ placementCheck: { valid: true, mutates_workspace: false } });
    for (const field of ["shape", "position", "world_transform"]) {
      await expect(adapter.querySpatialPlacement({ ...WORKSPACE_NEW_PRIMITIVE_PREFLIGHT, [field]: {} }, reader))
        .rejects.toMatchObject({ code: "invalid_spatial_candidate", options: { details: { unsupported_fields: [field] } } });
    }
    expect(store.getRevision()).toBe(revision);
    expect(store.getState().components.size).toBe(3);
  });

  it("reports local placement references and world-space results without mutating an existing assembly", async () => {
    const store = furniture();
    const adapter = new WorkspaceStoreEngineAdapter(store);
    await expect(adapter.inspectComponent("SEAT", reader)).resolves.toMatchObject({
      component: { parent_id: "CHAIR", placement: world(), placement_reference: {
        frame: "parent_local", component_id: "CHAIR", units: "meters", angles: "radians",
      } },
    });
    await expect(adapter.inspectSpace(undefined, reader)).resolves.toMatchObject({
      spatialGraph: { nodes: expect.arrayContaining([
        expect.objectContaining({ id: "SEAT", local_placement: world(), placement_reference: { frame: "parent_local", component_id: "CHAIR" }, world_transform: expect.objectContaining({ position: { x: 0, y: 0, z: 1.1 } }) }),
      ]) },
    });
    await expect(adapter.querySpatialPlacement({ component_id: "CHAIR", placement: world(1.45) }, reader))
      .resolves.toMatchObject({ placementCheck: {
        valid: true, candidate_id: "CHAIR", input_coordinate_frame: "world", checked_component_ids: ["CHAIR", "SEAT"],
        candidate_world_transform: { position: { x: 0, y: 0, z: 1.45 } }, mutates_workspace: false,
      } });
    await expect(adapter.querySpatialPlacement({ component_id: "SEAT", placement: world(0.35) }, reader))
      .resolves.toMatchObject({ placementCheck: {
        valid: true, input_coordinate_frame: "parent_local", reference_component_id: "CHAIR",
        candidate_world_transform: { position: { x: 0, y: 0, z: expect.closeTo(1.45) } },
      } });
    expect(store.getRevision()).toBe(1);
    expect(store.getState().components.get("SEAT")?.placement).toEqual(world());
  });

  it("returns actionable candidate-form and collider errors without guessing or applying a repair", async () => {
    const store = furniture();
    const adapter = new WorkspaceStoreEngineAdapter(store);
    await expect(adapter.querySpatialPlacement({ component_type: "model-assembly", placement: world() }, reader))
      .rejects.toMatchObject({ code: "invalid_spatial_candidate", message: expect.stringContaining("existing object or model-assembly"),
        options: { details: { unsupported_fields: ["component_type"] } } });
    await expect(adapter.querySpatialPlacement({ component_id: "SEAT", placement: world(), collision: { shape: "box", half_extents: { x: 1, y: 1, z: 1 } } }, reader))
      .rejects.toMatchObject({ code: "invalid_spatial_candidate", message: expect.stringContaining("use full size, not half_extents") });
    for (const [snake, camel] of [["component_id", "componentId"], ["asset_id", "assetId"], ["entity_kind", "entityKind"]]) {
      await expect(adapter.querySpatialPlacement({ [snake!]: "A", [camel!]: "B", placement: world() }, reader))
        .rejects.toMatchObject({ code: "invalid_spatial_candidate", message: expect.stringContaining(`must not provide both ${snake} and ${camel}`) });
    }
    expect(store.getRevision()).toBe(1);
  });

  it("keeps move/resize separation enforced and tells the caller the valid atomic sequence", () => {
    const store = new WorkspaceStore();
    const original = { space: "canvas2d" as const, position: { x: 0, y: 0 }, size: { width: 320, height: 220 } };
    store.apply(workspaceBatch(store, "panel", [{ op: "create_component", op_id: "panel", id: "PANEL",
      component_type: DEFAULT_COMPONENT_REGISTRY.ref("panel"), placement: original } ]));
    expect(() => store.apply(workspaceBatch(store, "invalid_resize", [{ op: "place_component", op_id: "move", id: "PANEL",
      placement: { ...original, size: { width: 400, height: 220 } } } ])))
      .toThrowError(expect.objectContaining({ code: "resize_requires_resize_component", message: expect.stringContaining("place_component then resize_component") }));
    expect(store.getRevision()).toBe(1);
    expect(store.getState().components.get("PANEL")?.placement).toEqual(original);
  });

  it("explains the real lamp/tabletop margin conflict without changing safety or the scene", async () => {
    const store = new WorkspaceStore();
    const contact = { enabled: true, role: "solid", shape: "asset_bounds", margin: 0 };
    const at = (x: number, y: number) => ({ ...world(), position: { x, y, z: 0 } });
    store.apply(workspaceBatch(store, "table", [
      { op: "create_component", op_id: "stage", id: "STAGE",
        component_type: DEFAULT_COMPONENT_REGISTRY.ref("stage-3d"), placement: world() },
      { op: "create_component", op_id: "table", id: "TABLE",
        component_type: DEFAULT_COMPONENT_REGISTRY.ref("model-assembly"), placement: world(), props: { collisionPolicy: "all" } },
      { op: "create_component", op_id: "top", id: "TOP", parent_id: "TABLE",
        component_type: DEFAULT_COMPONENT_REGISTRY.ref("spatial-primitive"), placement: at(0, 0.725),
        props: { geometry: { kind: "box", sizeM: { x: 1.6, y: 0.05, z: 0.8 } }, collision: contact } },
    ]));
    const adapter = new WorkspaceStoreEngineAdapter(store);
    const candidate = { geometry: { kind: "cylinder", radiusM: 0.07, heightM: 0.02, axis: "y" }, placement: at(0.62, 0.76) };
    const before = store.getState();
    const check = (await adapter.querySpatialPlacement(candidate, reader)).placementCheck;
    expect(check).toMatchObject({
      valid: false,
      candidate_world_bounds: { min: { y: expect.closeTo(0.75) }, max: { y: expect.closeTo(0.77) } },
      collision_evidence: expect.arrayContaining([
        expect.objectContaining({
          component_id: "__SPATIAL_CANDIDATE__", config_source: "default", feasibility_enabled: true,
          effective_collision: { enabled: true, role: "solid", shape: "asset_bounds", margin: 0.02 },
          resolved_source: "parametric_bounds",
          collision_world_bounds: expect.objectContaining({ min: { x: expect.closeTo(0.53), y: expect.closeTo(0.73), z: expect.closeTo(-0.09) },
            size: { x: expect.closeTo(0.18), y: expect.closeTo(0.06), z: expect.closeTo(0.18) } }),
        }),
        expect.objectContaining({ component_id: "TOP", config_source: "existing_component", effective_collision: contact }),
      ]),
      collision_conflict_details: [expect.objectContaining({ kind: "safety_margin_only" })],
      collision_assessment_basis: "oriented_box_colliders_not_exact_mesh_or_static_stability",
      mutates_workspace: false,
    });
    const lamp = {
      op: "create_component" as const, op_id: "lamp", id: "BASE",
      component_type: DEFAULT_COMPONENT_REGISTRY.ref("spatial-primitive"), placement: candidate.placement,
      props: { geometry: candidate.geometry },
    };
    expect(() => store.apply(workspaceBatch(store, "padded_lamp", [lamp])))
      .toThrowError(expect.objectContaining({ code: "spatial_collision" }));
    expect(store.getState()).toEqual(before);

    await expect(adapter.querySpatialPlacement({ ...candidate, collision: contact }, reader)).resolves.toMatchObject({ placementCheck: {
      valid: true, conflicts: [], collision_conflict_details: [], collision_evidence: [expect.objectContaining({
        config_source: "candidate_override", effective_collision: contact,
        collision_world_bounds: expect.objectContaining({ min: expect.objectContaining({ y: expect.closeTo(0.75) }) }),
      })],
    } });
    await expect(adapter.queryStablePlacement({ ...candidate, collision: contact }, reader)).resolves.toMatchObject({ stabilityCheck: {
      collision_check: { valid: true, collision_evidence: [expect.objectContaining({ config_source: "candidate_override", effective_collision: contact })] },
    } });
    // An actual 5 mm overlap still fails with no margin: no disabled collisions,
    // shifted tabletop, or weakened validation are needed for intended contact.
    await expect(adapter.querySpatialPlacement({ ...candidate, placement: at(0.62, 0.755), collision: contact }, reader))
      .resolves.toMatchObject({ placementCheck: { valid: false, collision_conflict_details: [expect.objectContaining({ kind: "collider_penetration" })] } });
    expect(store.getState()).toEqual(before);
    store.apply(workspaceBatch(store, "contact_lamp", [{ ...lamp, props: { ...lamp.props, collision: contact } }]));
    expect(store.getRevision()).toBe(2);
    expect(store.getState().components.get("TOP")).toEqual(before.components.get("TOP"));
    await expect(adapter.querySpatialPlacement({ component_id: "BASE", placement: candidate.placement }, reader)).resolves.toMatchObject({ placementCheck: {
      valid: true, collision_evidence: [expect.objectContaining({ component_id: "BASE", config_source: "existing_component", effective_collision: contact })],
    } });
    await expect(adapter.querySpatialPlacement({ component_id: "TOP", placement: at(0, 0.725), collision: { ...contact, margin: 0.02 } }, reader))
      .resolves.toMatchObject({ placementCheck: {
        valid: false, collision_conflict_details: [expect.objectContaining({ kind: "safety_margin_only" })],
        collision_evidence: expect.arrayContaining([
          expect.objectContaining({ component_id: "TOP", config_source: "candidate_override", effective_collision: { ...contact, margin: 0.02 } }),
          expect.objectContaining({ component_id: "BASE", config_source: "existing_component", effective_collision: contact }),
        ]),
      } });
    expect(store.getRevision()).toBe(2);
  });
});
