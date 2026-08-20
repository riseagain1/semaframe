// @vitest-environment node

import { describe, expect, it } from "vitest";
import { DEFAULT_COMPONENT_REGISTRY } from "../../workspace/components";
import {
  exportModelDefinitionToCsg,
  exportModelDefinitionCsgArtifact,
  exportModelDefinitionToStep,
  createModelDefinition,
  loadCadKernel,
  modelDefinitionCsgCompatibility,
  modelDefinitionStepCompatibility,
  modelDefinitionToCsgDefinition,
  type CsgNode,
  type ParametricPrimitive,
} from "../../workspace/modeling";
import { WorkspaceStore } from "../../workspace/state";
import { workspaceBatch } from "./helpers";

const world = (x: number, y: number, z: number) => ({
  space: "world3d" as const,
  position: { x, y, z },
  rotation: { x: 0, y: 0, z: 0 },
  scale: { x: 1, y: 1, z: 1 },
});

function publishedModel(primitives: readonly Readonly<{
  id: string;
  geometry: ParametricPrimitive;
  position: Readonly<{ x: number; y: number; z: number }>;
}>[]) {
  const store = new WorkspaceStore();
  store.apply(workspaceBatch(store, "solid_source", [{
    op: "create_component", op_id: "stage", id: "STAGE",
    component_type: DEFAULT_COMPONENT_REGISTRY.ref("stage-3d"), placement: world(0, 0, 0),
  }, {
    op: "create_component", op_id: "assembly", id: "ASSEMBLY",
    component_type: DEFAULT_COMPONENT_REGISTRY.ref("model-assembly"), placement: world(0, 0, 0),
  }, ...primitives.map((entry, index) => ({
    op: "create_component" as const,
    op_id: `primitive_${index}`,
    id: entry.id,
    component_type: DEFAULT_COMPONENT_REGISTRY.ref("spatial-primitive"),
    parent_id: "ASSEMBLY",
    placement: world(entry.position.x, entry.position.y, entry.position.z),
    props: { geometry: entry.geometry },
  }))]));
  store.apply(workspaceBatch(store, "publish_solid", [{
    op: "publish_model", op_id: "publish",
    model_id: "com.semaframe.solid", version: "1.0.0",
    display_name: "Solid fixture", root_id: "ASSEMBLY",
  }]));
  return store.getState().modelDefinitions.get("com.semaframe.solid@1.0.0")!;
}

function boxParts(count: number) {
  return Array.from({ length: count }, (_, index) => ({
    id: `BOX_${String(index).padStart(3, "0")}`,
    geometry: { kind: "box" as const, sizeM: { x: 0.8, y: 0.8, z: 0.8 } },
    position: { x: index, y: 0, z: 0 },
  }));
}

function nestedScaledRotatedModel() {
  const store = new WorkspaceStore();
  store.apply(workspaceBatch(store, "nested_solid_source", [{
    op: "create_component", op_id: "nested_stage", id: "NESTED_STAGE",
    component_type: DEFAULT_COMPONENT_REGISTRY.ref("stage-3d"), placement: world(0, 0, 0),
  }, {
    op: "create_component", op_id: "nested_root", id: "NESTED_ROOT",
    component_type: DEFAULT_COMPONENT_REGISTRY.ref("model-assembly"), placement: world(0, 0, 0),
  }, {
    op: "create_component", op_id: "scaled_parent", id: "SCALED_PARENT",
    component_type: DEFAULT_COMPONENT_REGISTRY.ref("model-assembly"),
    parent_id: "NESTED_ROOT",
    placement: world(0, 0, 0),
  }, {
    op: "create_component", op_id: "rotated_child", id: "ROTATED_CHILD",
    component_type: DEFAULT_COMPONENT_REGISTRY.ref("spatial-primitive"),
    parent_id: "SCALED_PARENT",
    placement: { ...world(0, 0, 0), rotation: { x: 0, y: 0, z: Math.PI / 2 } },
    props: { geometry: { kind: "box", sizeM: { x: 1, y: 1, z: 1 } } },
  }]));
  const components = new Map(store.getState().components);
  const scaledParent = components.get("SCALED_PARENT")!;
  if (scaledParent.placement.space !== "world3d") throw new Error("Expected a world3d fixture");
  components.set("SCALED_PARENT", {
    ...scaledParent,
    placement: { ...scaledParent.placement, scale: { x: 2, y: 1, z: 1 } },
  });
  return createModelDefinition(components, {
    modelId: "com.semaframe.nested-solid",
    version: "1.0.0",
    displayName: "Nested solid fixture",
    rootComponentId: "NESTED_ROOT",
    sourceRevision: store.getState().revision,
  });
}

function csgDepth(node: CsgNode): number {
  return node.kind === "primitive"
    ? 1
    : 1 + Math.max(csgDepth(node.left), csgDepth(node.right));
}

describe("reusable model solid exports", () => {
  it("evaluates a published assembly through real bounded CSG and exports OBJ/STL", async () => {
    const definition = publishedModel([{
      id: "BASE",
      geometry: { kind: "box", sizeM: { x: 2, y: 0.2, z: 1 } },
      position: { x: 0, y: 0.1, z: 0 },
    }, {
      id: "POST",
      geometry: { kind: "cylinder", radiusM: 0.1, heightM: 1.5, axis: "y" },
      position: { x: 0, y: 0.85, z: 0 },
    }]);

    const csg = modelDefinitionToCsgDefinition(definition);
    expect(csg.root.kind).toBe("union");
    const exported = await exportModelDefinitionToCsg(definition, { circularSegments: 24 });
    expect(exported.evaluation.diagnostics).toMatchObject({ manifold: true, watertight: true, empty: false });
    expect(exported.evaluation.volumeM3).toBeCloseTo(0.4 + Math.PI * 0.1 ** 2 * 1.5, 2);
    expect(exported.obj).toContain("# SemaFrame bounded CSG indexed mesh (metres)");
    expect(new DataView(exported.stl.buffer, exported.stl.byteOffset, exported.stl.byteLength).getUint32(80, true))
      .toBe(exported.evaluation.mesh.triangleCount);
  });

  it("materializes only the requested mesh artifact while preserving the combined API", async () => {
    const definition = publishedModel([{
      id: "BLOCK",
      geometry: { kind: "box", sizeM: { x: 1, y: 2, z: 3 } },
      position: { x: 0, y: 1, z: 0 },
    }]);

    const obj = await exportModelDefinitionCsgArtifact(definition, "obj");
    expect(obj).toMatchObject({ format: "obj" });
    expect(obj.obj).toContain("# SemaFrame bounded CSG indexed mesh (metres)");
    expect("stl" in obj).toBe(false);

    const stl = await exportModelDefinitionCsgArtifact(definition, "stl");
    expect(stl).toMatchObject({ format: "stl" });
    expect(new TextDecoder().decode(stl.stl.subarray(0, 80))).toContain("millimetres");
    expect("obj" in stl).toBe(false);
  });

  it("fuses the supported subset in real OpenCascade and exports metre-scaled STEP", async () => {
    const definition = publishedModel([{
      id: "BLOCK_A",
      geometry: { kind: "box", sizeM: { x: 1, y: 1, z: 1 } },
      position: { x: -0.25, y: 0.5, z: 0 },
    }, {
      id: "BLOCK_B",
      geometry: { kind: "box", sizeM: { x: 1, y: 1, z: 1 } },
      position: { x: 0.25, y: 0.5, z: 0 },
    }]);
    const kernel = await loadCadKernel();
    try {
      const exported = await exportModelDefinitionToStep(definition, { kernel, densityKgM3: 1_000 });
      expect(exported.step.text).toMatch(/^ISO-10303-21;/u);
      expect(exported.step.units).toBe("metre");
      expect(exported.properties.volumeM3).toBeCloseTo(1.5, 8);
      expect(exported.properties.massKg).toBeCloseTo(1_500, 6);
      expect(exported.properties.bounds.size.x).toBeCloseTo(1.5, 5);
      expect(exported.properties.bounds.size.y).toBeCloseTo(1, 5);
      expect(exported.properties.bounds.size.z).toBeCloseTo(1, 5);
    } finally {
      await kernel.dispose();
    }
  }, 60_000);

  it("rejects non-solid planes before loading a geometry kernel", () => {
    const definition = publishedModel([{
      id: "PLANE",
      geometry: { kind: "plane", sizeM: { x: 2, y: 2 }, normalAxis: "y" },
      position: { x: 0, y: 0, z: 0 },
    }]);
    expect(() => modelDefinitionToCsgDefinition(definition)).toThrowError(expect.objectContaining({
      code: "non_solid_primitive",
    }));
  });

  it("balances 13 and 64 primitive unions and evaluates the former through real Manifold", async () => {
    const thirteen = publishedModel(boxParts(13));
    const thirteenCsg = modelDefinitionToCsgDefinition(thirteen);
    expect(csgDepth(thirteenCsg.root)).toBe(5);
    expect(modelDefinitionCsgCompatibility(thirteen)).toEqual({ supported: true });
    const thirteenExport = await exportModelDefinitionToCsg(thirteen, { circularSegments: 12 });
    expect(thirteenExport.evaluation.diagnostics).toMatchObject({
      manifold: true,
      watertight: true,
      empty: false,
    });

    const sixtyFour = publishedModel(boxParts(64));
    const sixtyFourCsg = modelDefinitionToCsgDefinition(sixtyFour);
    expect(csgDepth(sixtyFourCsg.root)).toBe(7);
    expect(modelDefinitionCsgCompatibility(sixtyFour)).toEqual({ supported: true });
    expect(modelDefinitionStepCompatibility(sixtyFour)).toEqual({ supported: true });
    const sixtyFourExport = await exportModelDefinitionToCsg(sixtyFour, { circularSegments: 12 });
    expect(sixtyFourExport.evaluation.diagnostics).toMatchObject({
      manifold: true,
      watertight: true,
      empty: false,
    });
  });

  it("fails closed with a visible compatibility reason above the 64-leaf CSG cap", () => {
    const sixtyFive = publishedModel(boxParts(65));
    expect(modelDefinitionCsgCompatibility(sixtyFive)).toEqual({
      supported: false,
      reason: "STL/OBJ export supports at most 64 solid primitives; this model contains 65.",
    });
    expect(() => modelDefinitionToCsgDefinition(sixtyFive)).toThrowError(expect.objectContaining({
      code: "csg_primitive_limit",
    }));
    expect(modelDefinitionStepCompatibility(sixtyFive)).toEqual({
      supported: false,
      reason: "STEP export supports at most 64 solid primitives; this model contains 65.",
    });
  });

  it("fails closed when flattening nested scale and rotation would change rendered geometry", () => {
    const definition = nestedScaledRotatedModel();
    const reason = "Model node ROTATED_CHILD is rotated beneath non-uniform scale from SCALED_PARENT; solid export cannot preserve that affine transform exactly. Use uniform ancestor scale or bake the hierarchy first.";
    expect(modelDefinitionCsgCompatibility(definition)).toEqual({ supported: false, reason });
    expect(modelDefinitionStepCompatibility(definition)).toEqual({ supported: false, reason });
    expect(() => modelDefinitionToCsgDefinition(definition)).toThrowError(expect.objectContaining({
      code: "non_affine_hierarchy_transform",
    }));
  });
});
