import { describe, expect, it } from "vitest";
import { WorkspaceStoreEngineAdapter } from "../../../workspace/agents/WorkspaceStoreEngineAdapter";
import type { WorkspaceAgentPrincipal } from "../../../workspace/agents/contracts";
import { WorkspaceStore } from "../../../workspace/state/WorkspaceStore";
import { DEFAULT_COMPONENT_REGISTRY } from "../../../workspace/components";
import { workspaceBatch } from "../../workspace/helpers";

const reader: WorkspaceAgentPrincipal = {
  sessionId: "boundary_session", clientId: "boundary_client", clientName: "Boundary tests", scopes: ["workspace:read"],
};
const world = {
  space: "world3d", position: { x: 0, y: 0, z: 0 },
  rotation: { x: 0, y: 0, z: 0 }, scale: { x: 1, y: 1, z: 1 },
};
const canvas = { space: "canvas2d", position: { x: 0, y: 0 }, size: { width: 320, height: 220 } };
const viewport = { space: "viewport", anchor: "center", offset: { x: 0, y: 0 }, size: { width: 320, height: 220 } };

describe("Agent placement input boundaries", () => {
  const spatialInvalid: unknown[] = [null, [], "world", {}, { placement: [] },
    { placement: world, unexpected: true }, { placement: { ...world, space: "canvas2d" } },
    { placement: { ...world, extra: 1 } }, { placement: world, collision: {} },
    { placement: world, geometry: { kind: "unsupported" } },
    { placement: world, cad_definition: {}, cadDefinition: {} },
    ...["component_id", "asset_id", "entity_kind"].flatMap((key) => ["", 2].map((value) => ({ placement: world, [key]: value }))),
    { placement: world, geometry: { kind: "sphere", radiusM: 1 }, asset_id: "primitive_box" },
    ...["position", "rotation", "scale"].flatMap((key) => [null, [], { x: 0, y: 0, z: 0, extra: 1 },
      { x: "0", y: 0, z: 0 }, { x: NaN, y: 0, z: 0 }, { x: -1_000_001, y: 0, z: 0 },
      { x: 1_000_001, y: 0, z: 0 }].map((value) => ({ placement: { ...world, [key]: value } }))),
  ];
  it.each(spatialInvalid.map((candidate, index) => ({ index, candidate })))("rejects malformed 3D candidate $index without mutating state", async ({ candidate }) => {
    const store = new WorkspaceStore();
    const adapter = new WorkspaceStoreEngineAdapter(store);
    await expect(adapter.querySpatialPlacement(candidate, reader)).rejects.toMatchObject({ code: "invalid_spatial_candidate" });
    expect(store.getRevision()).toBe(0);
    expect(store.getCommandHistory()).toEqual([]);
  });

  const layoutInvalid: unknown[] = [null, [], "panel", {}, { placement: [] },
    { placement: canvas, extra: true }, { placement: canvas, component_id: "A", componentId: "B" },
    ...["", 1, "x".repeat(257)].map((value) => ({ placement: canvas, component_id: value })),
    { placement: { ...canvas, extra: 1 } }, { placement: { ...viewport, extra: 1 } },
    { placement: { ...viewport, anchor: "unknown" } }, { placement: { ...viewport, anchor: 1 } },
    { placement: world },
    ...[null, [], { x: 0, y: 0, z: 0 }, { x: NaN, y: 0 }, { x: 0, y: "0" }, { x: -1_000_001, y: 0 },
      { x: 1_000_001, y: 0 }].flatMap((value) => [
      { placement: { ...canvas, position: value } }, { placement: { ...viewport, offset: value } },
    ]),
    ...[null, [], { width: 320, height: 220, extra: 1 }, { width: 0, height: 220 },
      { width: 320, height: 1_000_001 }, { width: "320", height: 220 }].map((size) => ({ placement: { ...canvas, size } })),
    ...[-10_001, 10_001, 0.5, NaN, "0"].map((zIndex) => ({ placement: { ...canvas, zIndex } })),
    ...[-1_000_001, 1_000_001, NaN, "0"].map((rotationDeg) => ({ placement: { ...canvas, rotationDeg } })),
  ];
  it.each(layoutInvalid.map((candidate, index) => ({ index, candidate })))("rejects malformed 2D candidate $index without mutating state", async ({ candidate }) => {
    const store = new WorkspaceStore();
    await expect(new WorkspaceStoreEngineAdapter(store).queryLayoutPlacement(candidate, reader))
      .rejects.toMatchObject({ code: "invalid_layout_candidate" });
    expect(store.getRevision()).toBe(0);
  });

  it("accepts explicit canonical canvas rotation/z-index and both documented ID spellings", async () => {
    const store = new WorkspaceStore();
    store.apply(workspaceBatch(store, "panel", [{ op: "create_component", op_id: "panel", id: "NEW_PANEL",
      component_type: DEFAULT_COMPONENT_REGISTRY.ref("panel"),
      placement: { space: "canvas2d", position: { x: 0, y: 0 }, size: { width: 320, height: 220 } },
    }]));
    const adapter = new WorkspaceStoreEngineAdapter(store);
    for (const idField of ["component_id", "componentId"]) {
      for (const placement of [{ ...canvas, rotationDeg: 45, zIndex: -2 }, { ...viewport, zIndex: 2 }]) {
        await expect(adapter.queryLayoutPlacement({ [idField]: "NEW_PANEL", placement }, reader, { frame: "canonical" }))
          .resolves.toMatchObject({ revision: 1, placementCheck: { frame: "canonical", valid: true, canonical_valid: true, current_view_valid: null, candidate_id: "NEW_PANEL", mutates_workspace: false } });
      }
    }
  });

  it.each([null, [], "settle", { extra: 1 }, { componentIds: "A" }, { componentIds: Array(101).fill("A") },
    { componentIds: [1] }, { componentIds: [""] }, { componentIds: ["x".repeat(257)] }])("rejects malformed simulation scope %j", async (options) => {
    await expect(new WorkspaceStoreEngineAdapter(new WorkspaceStore()).simulatePhysics(options, reader))
      .rejects.toMatchObject({ code: "invalid_physics_simulation" });
  });

  it("rejects unknown physics components, invalid physics intent, and invalid revision cursors", async () => {
    const adapter = new WorkspaceStoreEngineAdapter(new WorkspaceStore());
    await expect(adapter.simulatePhysics({ componentIds: ["MISSING"] }, reader)).rejects.toMatchObject({ code: "unknown_spatial_component" });
    await expect(adapter.queryStablePlacement({ placement: world, physics: {} }, reader)).rejects.toMatchObject({ code: "invalid_physics_candidate" });
    for (const revision of [-1, 1, 0.5, NaN, Infinity]) {
      await expect(adapter.inspectSpace(revision, reader)).rejects.toMatchObject({ code: "invalid_spatial_revision" });
    }
    await expect(adapter.simulatePhysics({ componentIds: [], durationMs: 100, timeStepMs: 20 }, reader))
      .resolves.toMatchObject({ simulation: { mutates_workspace: false, proposals: [] } });
  });

  it("does not permit read-only spatial operations without read scope", async () => {
    const adapter = new WorkspaceStoreEngineAdapter(new WorkspaceStore());
    const denied = { ...reader, scopes: [] };
    for (const action of [() => adapter.querySpatialPlacement({ placement: world }, denied),
      () => adapter.queryLayoutPlacement({ placement: canvas }, denied),
      () => adapter.simulatePhysics({}, denied), () => adapter.queryStablePlacement({ placement: world }, denied)]) {
      await expect(action()).rejects.toMatchObject({ code: "permission_denied" });
    }
  });
});
