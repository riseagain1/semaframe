import { describe, expect, it } from "vitest";
import { WorkspaceStoreEngineAdapter } from "../../../workspace/agents/WorkspaceStoreEngineAdapter";
import type { WorkspaceAgentPrincipal } from "../../../workspace/agents/contracts";
import { DEFAULT_COMPONENT_REGISTRY } from "../../../workspace/components";
import { WorkspaceStore } from "../../../workspace/state";
import { workspaceBatch } from "../../workspace/helpers";

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
});
