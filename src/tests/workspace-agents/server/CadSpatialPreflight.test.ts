// @vitest-environment node

import { describe, expect, it, vi } from "vitest";
import { WorkspaceStoreEngineAdapter } from "../../../workspace/agents/WorkspaceStoreEngineAdapter";
import {
  WorkspaceEngineError,
  type WorkspaceAgentPrincipal,
} from "../../../workspace/agents/contracts";
import { DEFAULT_COMPONENT_REGISTRY } from "../../../workspace/components";
import type { World3DPlacement } from "../../../workspace/components/componentTypes";
import {
  CAD_PART_DEFINITION_FORMAT_VERSION,
  DEFAULT_CAD_SKETCH_PLANE,
  cadLengthExpression,
  type CadFeature,
  type CadPartDefinitionV1,
} from "../../../workspace/modeling/cad";
import { loadCadKernel } from "../../../workspace/modeling/cadKernel";
import { WorkspaceStore } from "../../../workspace/state";
import { workspaceBatch } from "../../workspace/helpers";

const principal: WorkspaceAgentPrincipal = {
  sessionId: "cad_preflight_session",
  clientId: "cad_preflight_agent",
  clientName: "CAD preflight test agent",
  scopes: ["workspace:read"],
};

function placement(x = 0, y = 0, z = 0): World3DPlacement {
  return {
    space: "world3d",
    position: { x, y, z },
    rotation: { x: 0, y: 0, z: 0 },
    scale: { x: 1, y: 1, z: 1 },
  };
}

function rectangleSketch(id: string, originX = 0): Extract<CadFeature, { kind: "sketch" }> {
  return {
    id,
    name: id,
    kind: "sketch",
    sketch: {
      plane: {
        ...DEFAULT_CAD_SKETCH_PLANE,
        originM: { x: originX, y: 0, z: 0 },
      },
      entities: [
        { id: `${id}_bottom`, kind: "line", start: { x: 0, y: 0 }, end: { x: 1, y: 0 } },
        { id: `${id}_right`, kind: "line", start: { x: 1, y: 0 }, end: { x: 1, y: 1 } },
        { id: `${id}_top`, kind: "line", start: { x: 1, y: 1 }, end: { x: 0, y: 1 } },
        { id: `${id}_left`, kind: "line", start: { x: 0, y: 1 }, end: { x: 0, y: 0 } },
      ],
      loops: [{
        id: "outer",
        role: "outer",
        entityIds: [`${id}_bottom`, `${id}_right`, `${id}_top`, `${id}_left`],
      }],
      constraints: [],
    },
  };
}

function extrude(
  id: string,
  sketchFeatureId: string,
  resultBodyId: string,
): Extract<CadFeature, { kind: "extrude" }> {
  return {
    id,
    name: id,
    kind: "extrude",
    profile: { sketchFeatureId, loopIds: ["outer"] },
    distance: cadLengthExpression(1),
    operation: "new",
    resultBodyId,
  };
}

function boxDefinition(): CadPartDefinitionV1 {
  return {
    formatVersion: CAD_PART_DEFINITION_FORMAT_VERSION,
    partId: "preflight_box",
    displayName: "Preflight box",
    units: "metre",
    parameters: [],
    history: [
      rectangleSketch("box_profile"),
      extrude("box_extrude", "box_profile", "box"),
    ],
    activeBodyIds: ["box"],
  };
}

function disjointCutDefinition(): CadPartDefinitionV1 {
  return {
    formatVersion: CAD_PART_DEFINITION_FORMAT_VERSION,
    partId: "disjoint_cut",
    displayName: "Disjoint cut",
    units: "metre",
    parameters: [],
    history: [
      rectangleSketch("left_profile"),
      extrude("left_extrude", "left_profile", "left"),
      rectangleSketch("right_profile", 3),
      extrude("right_extrude", "right_profile", "right"),
      {
        id: "missed_cut",
        name: "Missed cut",
        kind: "boolean",
        operation: "cut",
        leftBodyId: "left",
        rightBodyId: "right",
        resultBodyId: "unchanged_left",
      },
    ],
    activeBodyIds: ["unchanged_left"],
  };
}

async function rejectedEngineError(promise: Promise<unknown>): Promise<WorkspaceEngineError> {
  const error = await promise.catch((cause: unknown) => cause);
  expect(error).toBeInstanceOf(WorkspaceEngineError);
  return error as WorkspaceEngineError;
}

describe("Agent semantic CAD placement preflight", () => {
  it("host-evaluates a valid CAD definition and returns a successful check without mutation", async () => {
    const store = new WorkspaceStore();
    const factory = vi.fn(loadCadKernel);
    const adapter = new WorkspaceStoreEngineAdapter(store, { cadKernelFactory: factory });

    const result = await adapter.querySpatialPlacement({
      cad_definition: boxDefinition(),
      placement: placement(3, 0, 0),
    }, principal);

    expect(result).toMatchObject({
      revision: 0,
      placementCheck: {
        valid: true,
        candidate_id: "__SPATIAL_CANDIDATE__",
        conflicts: [],
      },
    });
    const stable = await adapter.queryStablePlacement({
      cad_definition: boxDefinition(),
      placement: placement(3, 0, 0),
    }, principal);
    expect(stable).toMatchObject({
      revision: 0,
      stabilityCheck: {
        candidate_id: "__SPATIAL_CANDIDATE__",
        body: { center_of_mass_world: { x: 3.5, y: 0.5, z: 0.5 } },
      },
    });
    expect(factory).toHaveBeenCalledTimes(2);
    expect(store.getRevision()).toBe(0);
    expect(store.getCommandHistory()).toEqual([]);
    expect(store.getState().components.size).toBe(0);
  }, 30_000);

  it("uses evaluated CAD bounds to report collision and suggestions without mutation", async () => {
    const store = new WorkspaceStore();
    store.apply(workspaceBatch(store, "seed_cad_preflight_obstacle", [{
      op: "create_component",
      op_id: "create_stage",
      id: "STAGE",
      component_type: DEFAULT_COMPONENT_REGISTRY.ref("stage-3d"),
      placement: placement(),
    }, {
      op: "create_component",
      op_id: "create_obstacle",
      id: "OBSTACLE",
      component_type: DEFAULT_COMPONENT_REGISTRY.ref("spatial-primitive"),
      props: { geometry: { kind: "box", sizeM: { x: 0.2, y: 0.2, z: 0.2 } } },
      // The CAD box is asymmetric about its local origin: [0, 1] on every axis.
      // This obstacle would not intersect an incorrectly origin-centred envelope.
      placement: placement(0.9, 0.5, 0.5),
    }]));
    const before = structuredClone(store.getState());
    const adapter = new WorkspaceStoreEngineAdapter(store, { cadKernelFactory: loadCadKernel });

    const result = await adapter.querySpatialPlacement({
      cad_definition: boxDefinition(),
      placement: placement(),
    }, principal);

    expect(result).toMatchObject({
      revision: 1,
      placementCheck: {
        valid: false,
        conflicts: [expect.objectContaining({
          conflicts_with: "OBSTACLE",
        })],
        suggested_placements: expect.any(Array),
      },
    });
    expect((result.placementCheck as { suggested_placements: unknown[] }).suggested_placements.length)
      .toBeGreaterThan(0);
    expect(store.getState()).toEqual(before);
    expect(store.getRevision()).toBe(1);
    expect(store.getCommandHistory()).toHaveLength(1);
  }, 30_000);

  it("rejects structurally invalid and empty CAD candidates before allocating OCCT", async () => {
    const store = new WorkspaceStore();
    const factory = vi.fn(loadCadKernel);
    const adapter = new WorkspaceStoreEngineAdapter(store, { cadKernelFactory: factory });
    const invalid = { ...boxDefinition(), activeBodyIds: ["missing_body"] };
    const empty: CadPartDefinitionV1 = {
      formatVersion: CAD_PART_DEFINITION_FORMAT_VERSION,
      partId: "empty_candidate",
      displayName: "Empty candidate",
      units: "metre",
      parameters: [],
      history: [],
      activeBodyIds: [],
    };

    const invalidError = await rejectedEngineError(adapter.querySpatialPlacement({
      cad_definition: invalid,
      placement: placement(),
    }, principal));
    expect(invalidError).toMatchObject({ code: "invalid_spatial_candidate" });
    expect(invalidError.options.details).toMatchObject({ validation_code: "unknown_body_reference" });

    const emptyError = await rejectedEngineError(adapter.querySpatialPlacement({
      cad_definition: empty,
      placement: placement(),
    }, principal));
    expect(emptyError).toMatchObject({ code: "invalid_spatial_candidate" });
    expect(emptyError.message).toContain("at least one active body");
    expect(factory).not.toHaveBeenCalled();
    expect(store.getRevision()).toBe(0);
    expect(store.getCommandHistory()).toEqual([]);
  });

  it("fails a geometrically no-op boolean atomically and preserves revision/history", async () => {
    const store = new WorkspaceStore();
    store.apply(workspaceBatch(store, "seed_before_failed_cad_preflight", [{
      op: "create_component",
      op_id: "create_stage",
      id: "STAGE",
      component_type: DEFAULT_COMPONENT_REGISTRY.ref("stage-3d"),
      placement: placement(),
    }, {
      op: "create_component",
      op_id: "create_existing",
      id: "EXISTING",
      component_type: DEFAULT_COMPONENT_REGISTRY.ref("spatial-primitive"),
      props: { geometry: { kind: "sphere", radiusM: 0.25 } },
      placement: placement(5, 0, 0),
    }]));
    const before = structuredClone(store.getState());
    const adapter = new WorkspaceStoreEngineAdapter(store, { cadKernelFactory: loadCadKernel });

    const error = await rejectedEngineError(adapter.querySpatialPlacement({
      cad_definition: disjointCutDefinition(),
      placement: placement(),
    }, principal));

    expect(error).toMatchObject({
      code: "cad_evaluation_failed",
      options: { requiredAction: "query_spatial_placement" },
    });
    expect(error.message).toContain("disjoint");
    expect(store.getState()).toEqual(before);
    expect(store.getRevision()).toBe(1);
    expect(store.getCommandHistory()).toHaveLength(1);
  }, 30_000);
});
