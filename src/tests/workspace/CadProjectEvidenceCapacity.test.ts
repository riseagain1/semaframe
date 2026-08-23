// @vitest-environment node

import { describe, expect, it, vi } from "vitest";
import { DEFAULT_COMPONENT_REGISTRY } from "../../workspace/components";
import type { JSONObject } from "../../workspace/components/componentTypes";
import {
  CAD_EVALUATION_EVIDENCE_FORMAT_VERSION,
  CAD_PART_DEFINITION_FORMAT_VERSION,
  CAD_PART_EVALUATOR_VERSION,
  CAD_SKETCH_SOLVER_VERSION,
  DEFAULT_CAD_SKETCH_PLANE,
  cadLengthExpression,
  cadPartDefinitionDigest,
  type CadEvaluationEvidenceV1,
  type CadPartDefinitionV1,
} from "../../workspace/modeling/cad";
import type { CadKernel } from "../../workspace/modeling/cadKernel";
import type { WorkspaceOperation } from "../../workspace/protocol";
import {
  verifyWorkspaceProjectCadEvidence,
  WorkspaceProjectSerializer,
} from "../../workspace/persistence";
import { WorkspaceStore } from "../../workspace/state";
import { workspaceBatch } from "./helpers";

const placement = {
  space: "world3d" as const,
  position: { x: 0, y: 0, z: 0 },
  rotation: { x: 0, y: 0, z: 0 },
  scale: { x: 1, y: 1, z: 1 },
};

function historicalDefinition(index: number): CadPartDefinitionV1 {
  const partId = `verified_history_${index}`;
  return {
    formatVersion: CAD_PART_DEFINITION_FORMAT_VERSION,
    partId,
    displayName: `Verified historical plate ${index}`,
    units: "metre",
    parameters: [],
    history: [{
      id: "profile",
      name: "Profile",
      kind: "sketch",
      sketch: {
        plane: DEFAULT_CAD_SKETCH_PLANE,
        entities: [
          { id: "bottom", kind: "line", start: { x: 0, y: 0 }, end: { x: 2, y: 0 } },
          { id: "right", kind: "line", start: { x: 2, y: 0 }, end: { x: 2, y: 1 } },
          { id: "top", kind: "line", start: { x: 2, y: 1 }, end: { x: 0, y: 1 } },
          { id: "left", kind: "line", start: { x: 0, y: 1 }, end: { x: 0, y: 0 } },
        ],
        loops: [{ id: "outer", role: "outer", entityIds: ["bottom", "right", "top", "left"] }],
        constraints: [],
      },
    }, {
      id: "extrude",
      name: "Extrude",
      kind: "extrude",
      profile: { sketchFeatureId: "profile", loopIds: ["outer"] },
      distance: cadLengthExpression(0.5),
      operation: "new",
      resultBodyId: "plate",
    }],
    activeBodyIds: ["plate"],
  };
}

function evidenceFor(part: CadPartDefinitionV1): CadEvaluationEvidenceV1 {
  const bounds = {
    min: { x: 0, y: 0, z: 0 },
    max: { x: 2, y: 1, z: 0.5 },
    size: { x: 2, y: 1, z: 0.5 },
    center: { x: 1, y: 0.5, z: 0.25 },
  };
  return {
    formatVersion: CAD_EVALUATION_EVIDENCE_FORMAT_VERSION,
    definitionDigest: cadPartDefinitionDigest(part),
    evaluatorVersion: CAD_PART_EVALUATOR_VERSION,
    sketchSolverVersion: CAD_SKETCH_SOLVER_VERSION,
    exactness: "brep",
    status: "valid",
    bodies: [{
      bodyId: "plate",
      bounds,
      volumeM3: 1,
      surfaceAreaM2: 7,
      centerOfMassM: bounds.center,
      valid: true,
    }],
    overallBounds: bounds,
    diagnostics: [],
  };
}

function cadProps(part: CadPartDefinitionV1): JSONObject {
  return {
    definition: structuredClone(part) as unknown as JSONObject,
    definitionDigest: cadPartDefinitionDigest(part),
    evaluation: structuredClone(evidenceFor(part)) as unknown as JSONObject,
  };
}

describe("CAD project evidence capacity", () => {
  it("saves, verifies, and reopens 257 distinct historical CAD definitions", async () => {
    const store = new WorkspaceStore();
    const first = historicalDefinition(0);
    store.apply(workspaceBatch(store, "create_historical_cad", [{
      op: "create_component",
      op_id: "create_stage",
      id: "STAGE",
      component_type: DEFAULT_COMPONENT_REGISTRY.ref("stage-3d"),
      placement,
    }, {
      op: "create_component",
      op_id: "create_cad",
      id: "CAD",
      component_type: DEFAULT_COMPONENT_REGISTRY.ref("cad-part"),
      placement,
      props: cadProps(first),
    }]));

    // Mirror the Agent admission limit: eight host-evaluated CAD changes per
    // command. Thirty-two retained commands plus the create produce 257 unique
    // historical definitions, crossing the former verifier-only limit of 256.
    for (let batchIndex = 0; batchIndex < 32; batchIndex += 1) {
      const operations: WorkspaceOperation[] = [];
      for (let operationIndex = 0; operationIndex < 8; operationIndex += 1) {
        const index = batchIndex * 8 + operationIndex + 1;
        const part = historicalDefinition(index);
        operations.push({
          op: "update_component",
          op_id: `update_cad_${index}`,
          id: "CAD",
          patch: { props: cadProps(part) },
        });
      }
      store.apply(workspaceBatch(store, `historical_cad_batch_${batchIndex}`, operations));
    }

    const serializer = new WorkspaceProjectSerializer();
    const serialized = serializer.serialize(serializer.fromStore("cad_history_capacity", store));
    const project = serializer.deserialize(serialized);
    const evaluatePart = vi.fn(async (part: CadPartDefinitionV1) => ({
      evidence: evidenceFor(part),
      meshes: [],
    }));
    const dispose = vi.fn(async () => undefined);
    const kernel = { evaluatePart, dispose } as unknown as CadKernel;

    await verifyWorkspaceProjectCadEvidence(project, {
      cadKernelFactory: async () => kernel,
    });
    const reopened = serializer.openStore(project);

    expect(evaluatePart).toHaveBeenCalledTimes(257);
    expect(dispose).toHaveBeenCalledOnce();
    expect(reopened.getCommandHistory()).toHaveLength(33);
    expect(reopened.getState().components.get("CAD")?.props.definitionDigest)
      .toBe(cadPartDefinitionDigest(historicalDefinition(256)));
  });
});
