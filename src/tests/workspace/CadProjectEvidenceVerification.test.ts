// @vitest-environment node

import { describe, expect, it, vi } from "vitest";
import { DEFAULT_COMPONENT_REGISTRY } from "../../workspace/components";
import type { JSONObject } from "../../workspace/components/componentTypes";
import {
  CAD_PART_DEFINITION_FORMAT_VERSION,
  DEFAULT_CAD_SKETCH_PLANE,
  cadLengthExpression,
  cadPartDefinitionDigest,
  type CadPartEvaluationResultV1,
  type CadPartDefinitionV1,
} from "../../workspace/modeling/cad";
import { loadCadKernel } from "../../workspace/modeling/cadKernel";
import type { WorkspaceOperation } from "../../workspace/protocol";
import {
  type WorkspaceProjectFile,
  verifyWorkspaceProjectCadEvidence,
  workspaceFromSerializable,
  WorkspaceCadEvidenceVerificationError,
  WorkspaceProjectSerializer,
} from "../../workspace/persistence";
import * as workspacePersistence from "../../workspace/persistence";
import { WorkspaceStore } from "../../workspace/state";
import { workspaceBatch } from "./helpers";

const placement = {
  space: "world3d" as const,
  position: { x: 0, y: 0, z: 0 },
  rotation: { x: 0, y: 0, z: 0 },
  scale: { x: 1, y: 1, z: 1 },
};

function definition(
  partId = "verified_project_plate",
  distanceM = 0.5,
): CadPartDefinitionV1 {
  return {
    formatVersion: CAD_PART_DEFINITION_FORMAT_VERSION,
    partId,
    displayName: `Verified project plate ${partId}`,
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
      distance: cadLengthExpression(distanceM),
      operation: "new",
      resultBodyId: "plate",
    }],
    activeBodyIds: ["plate"],
  };
}

async function projectFile(
  parts: readonly CadPartDefinitionV1[] = [definition()],
): Promise<WorkspaceProjectFile> {
  const kernel = await loadCadKernel();
  const evaluated: CadPartEvaluationResultV1[] = [];
  try {
    for (const part of parts) {
      evaluated.push(await kernel.evaluatePart(part, { includeMeshes: false }));
    }
  } finally {
    await kernel.dispose();
  }
  const store = new WorkspaceStore();
  const operations: WorkspaceOperation[] = [{
    op: "create_component",
    op_id: "stage",
    id: "STAGE",
    component_type: DEFAULT_COMPONENT_REGISTRY.ref("stage-3d"),
    placement,
  }, ...parts.map((part, index): WorkspaceOperation => ({
      op: "create_component",
      op_id: `cad_${index}`,
      id: index === 0 ? "CAD" : `CAD_${index}`,
      component_type: DEFAULT_COMPONENT_REGISTRY.ref("cad-part"),
      placement: {
        ...placement,
        position: { x: index * 3, y: 0, z: 0 },
      },
      props: {
        definition: structuredClone(part) as unknown as JSONObject,
        definitionDigest: cadPartDefinitionDigest(part),
        evaluation: structuredClone(evaluated[index]!.evidence) as unknown as JSONObject,
      },
    }))];
  store.apply(workspaceBatch(store, "create_verified_cad_project", operations));
  const serializer = new WorkspaceProjectSerializer();
  return serializer.fromStore("cad_project_verification", store);
}

async function projectJson(parts: readonly CadPartDefinitionV1[] = [definition()]): Promise<string> {
  const serializer = new WorkspaceProjectSerializer();
  return serializer.serialize(await projectFile(parts));
}

describe("external CAD project evidence verification", () => {
  it("requires fresh OCCT evaluation before a deserialized CAD project can open", async () => {
    const serializer = new WorkspaceProjectSerializer();
    const project = serializer.deserialize(await projectJson());
    expect(() => serializer.openStore(project)).toThrowError(expect.objectContaining({
      code: "cad_evidence_verification_required",
    }));

    await verifyWorkspaceProjectCadEvidence(project, { cadKernelFactory: loadCadKernel });
    const reopened = serializer.openStore(project);
    expect(reopened.getState().components.get("CAD")?.props.definitionDigest)
      .toBe(cadPartDefinitionDigest(definition()));
  }, 30_000);

  it("keeps live-Store projects convenient without exposing a public trust bypass", async () => {
    const serializer = new WorkspaceProjectSerializer();
    const project = await projectFile();

    expect(serializer.openStore(project).getState().components.has("CAD")).toBe(true);
    expect(workspacePersistence).not.toHaveProperty("trustWorkspaceProjectCadEvidence");

    const callerAuthored = serializer.create({
      projectId: "caller_authored_cad_project",
      workspace: workspaceFromSerializable(project.workspace),
      checkpoint: workspaceFromSerializable(project.checkpoint),
      checkpointNextComponentSequence: project.checkpointNextComponentSequence,
      nextComponentSequence: project.nextComponentSequence,
      checkpointNextEventCursor: project.checkpointNextEventCursor,
      nextEventCursor: project.nextEventCursor,
      commandHistory: project.commandHistory,
    });
    expect(() => serializer.openStore(callerAuthored)).toThrowError(expect.objectContaining({
      code: "cad_evidence_verification_required",
    }));

    const component = project.workspace.components.find(([id]) => id === "CAD")![1];
    const evaluation = component.props.evaluation as unknown as {
      bodies: Array<{ volumeM3: number }>;
    };
    evaluation.bodies[0]!.volumeM3 *= 2;
    expect(() => serializer.openStore(project)).toThrowError(expect.objectContaining({
      code: "cad_evidence_verification_required",
    }));
  }, 30_000);

  it("invalidates an external verification when its mutable project changes afterward", async () => {
    const serializer = new WorkspaceProjectSerializer();
    const project = serializer.deserialize(await projectJson());
    await verifyWorkspaceProjectCadEvidence(project, { cadKernelFactory: loadCadKernel });

    const component = project.workspace.components.find(([id]) => id === "CAD")![1];
    const evaluation = component.props.evaluation as unknown as {
      bodies: Array<{ volumeM3: number }>;
    };
    evaluation.bodies[0]!.volumeM3 *= 2;

    expect(() => serializer.openStore(project)).toThrowError(expect.objectContaining({
      code: "cad_evidence_mismatch",
    }));
  }, 30_000);

  it("rejects mutation while asynchronous OCCT verification is in flight", async () => {
    const serializer = new WorkspaceProjectSerializer();
    const project = serializer.deserialize(await projectJson());
    const component = project.workspace.components.find(([id]) => id === "CAD")![1];
    const evaluation = component.props.evaluation as unknown as {
      bodies: Array<{ volumeM3: number }>;
    };
    const kernel = await loadCadKernel();
    const evaluatePart = kernel.evaluatePart.bind(kernel);
    vi.spyOn(kernel, "evaluatePart").mockImplementation(async (...args) => {
      const result = await evaluatePart(...args);
      evaluation.bodies[0]!.volumeM3 *= 2;
      return result;
    });

    await expect(verifyWorkspaceProjectCadEvidence(project, {
      cadKernelFactory: async () => kernel,
    })).rejects.toMatchObject({ code: "cad_evidence_mismatch" });
    expect(() => serializer.openStore(project)).toThrowError(expect.objectContaining({
      code: "cad_evidence_verification_required",
    }));
  }, 30_000);

  it("rejects structurally valid but forged measurements before replay", async () => {
    const serializer = new WorkspaceProjectSerializer();
    const project = serializer.deserialize(await projectJson());
    const component = project.workspace.components.find(([id]) => id === "CAD")![1];
    const evaluation = component.props.evaluation as unknown as {
      bodies: Array<{ volumeM3: number }>;
    };
    evaluation.bodies[0]!.volumeM3 *= 2;

    await expect(verifyWorkspaceProjectCadEvidence(project, {
      cadKernelFactory: loadCadKernel,
    })).rejects.toBeInstanceOf(WorkspaceCadEvidenceVerificationError);
    await expect(verifyWorkspaceProjectCadEvidence(project, {
      cadKernelFactory: loadCadKernel,
    })).rejects.toMatchObject({ code: "cad_evidence_mismatch" });
    expect(() => serializer.openStore(project)).toThrowError(expect.objectContaining({
      code: "cad_evidence_verification_required",
    }));
  }, 30_000);

  it("evaluates distinct canonical definitions independently when their grouping digests collide", async () => {
    const serializer = new WorkspaceProjectSerializer();
    const project = serializer.deserialize(await projectJson([
      definition(),
      definition("verified_project_plate_second", 0.75),
    ]));
    const kernel = await loadCadKernel();
    const evaluatePart = vi.spyOn(kernel, "evaluatePart");

    await verifyWorkspaceProjectCadEvidence(project, {
      cadKernelFactory: async () => kernel,
      definitionGroupingDigest: () => "forced-digest-collision",
    });

    expect(evaluatePart).toHaveBeenCalledTimes(2);
    expect(serializer.openStore(project).getState().components.has("CAD_1")).toBe(true);
  }, 30_000);
});
