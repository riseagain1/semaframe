// @vitest-environment node

import { describe, expect, it } from "vitest";
import { DEFAULT_COMPONENT_REGISTRY } from "../../workspace/components";
import { deterministicDigest } from "../../workspace/components/manifestDigest";
import {
  LEGACY_MODEL_DEFINITION_FORMAT_VERSION,
  MODEL_DEFINITION_FORMAT_VERSION,
  MODEL_DEFINITION_GENERATOR_VERSION,
  type ModelDefinitionV2,
  type ModelDefinitionV1,
} from "../../workspace/modeling/modelDefinitions";
import {
  createModelDefinitionCadHandoffPackage,
  modelDefinitionCadHandoffCompatibility,
  type CadHandoffManifest,
  type CadHandoffReport,
} from "../../workspace/modeling/cadHandoff";
import { WorkspaceStore } from "../../workspace/state";
import {
  CAD_PART_DEFINITION_FORMAT_VERSION,
  DEFAULT_CAD_SKETCH_PLANE,
  cadLengthExpression,
  cadPartDefinitionDigest,
  type CadFeature,
  type CadPartDefinitionV1,
} from "../../workspace/modeling/cad";
import { workspaceBatch } from "./helpers";
import type { JSONObject } from "../../workspace/components/componentTypes";

function world(
  position = { x: 0, y: 0, z: 0 },
  rotation = { x: 0, y: 0, z: 0 },
  scale = { x: 1, y: 1, z: 1 },
) {
  return { space: "world3d" as const, position, rotation, scale };
}

function nestedColoredModel() {
  const store = new WorkspaceStore();
  store.apply(workspaceBatch(store, "cad_handoff_fixture", [{
    op: "create_component",
    op_id: "stage",
    id: "STAGE",
    component_type: DEFAULT_COMPONENT_REGISTRY.ref("stage-3d"),
    placement: world(),
  }, {
    op: "create_component",
    op_id: "root",
    id: "ROOT",
    component_type: DEFAULT_COMPONENT_REGISTRY.ref("model-assembly"),
    placement: world(),
  }, {
    op: "create_component",
    op_id: "subassembly",
    id: "ARM",
    component_type: DEFAULT_COMPONENT_REGISTRY.ref("model-assembly"),
    parent_id: "ROOT",
    placement: world(
      { x: 1, y: 0, z: 0 },
      { x: 0, y: 0, z: Math.PI / 2 },
      { x: 2, y: 2, z: 2 },
    ),
  }, {
    op: "create_component",
    op_id: "large_part",
    id: "LARGE_BLOCK",
    component_type: DEFAULT_COMPONENT_REGISTRY.ref("spatial-primitive"),
    parent_id: "ARM",
    placement: world({ x: 0.5, y: 0, z: 0 }),
    props: {
      geometry: { kind: "box", sizeM: { x: 1, y: 1, z: 1 } },
      material: {
        baseColor: "#FF4000",
        metallic: 0.1,
        roughness: 0.4,
        opacity: 0.8,
        emissiveColor: "#000000",
        emissiveIntensity: 0,
      },
    },
  }, {
    op: "create_component",
    op_id: "small_part",
    id: "SMALL_BLOCK",
    component_type: DEFAULT_COMPONENT_REGISTRY.ref("spatial-primitive"),
    parent_id: "ROOT",
    placement: world({ x: 5, y: 1, z: 0 }),
    props: {
      geometry: { kind: "box", sizeM: { x: 1, y: 1, z: 1 } },
      material: {
        baseColor: "#0040FF",
        metallic: 0,
        roughness: 0.5,
        opacity: 1,
        emissiveColor: "#000000",
        emissiveIntensity: 0,
      },
    },
  }]));
  store.apply(workspaceBatch(store, "publish_cad_handoff_fixture", [{
    op: "publish_model",
    op_id: "publish",
    model_id: "com.semaframe.cad-handoff-fixture",
    version: "2.0.0",
    display_name: "Nested CAD handoff fixture",
    root_id: "ROOT",
  }]));
  return store.getState().modelDefinitions.get("com.semaframe.cad-handoff-fixture@2.0.0")!;
}

function exactPlateDefinition(): CadPartDefinitionV1 {
  const definition: CadPartDefinitionV1 = {
    formatVersion: CAD_PART_DEFINITION_FORMAT_VERSION,
    partId: "exact_plate",
    displayName: "Exact editable plate",
    units: "metre",
    parameters: [],
    history: [{
      id: "plate_profile",
      name: "Plate profile",
      kind: "sketch",
      sketch: {
        plane: DEFAULT_CAD_SKETCH_PLANE,
        entities: [{ id: "bottom", kind: "line", start: { x: 0, y: 0 }, end: { x: 2, y: 0 } },
          { id: "right", kind: "line", start: { x: 2, y: 0 }, end: { x: 2, y: 1 } },
          { id: "top", kind: "line", start: { x: 2, y: 1 }, end: { x: 0, y: 1 } },
          { id: "left", kind: "line", start: { x: 0, y: 1 }, end: { x: 0, y: 0 } }],
        loops: [{ id: "outer", role: "outer", entityIds: ["bottom", "right", "top", "left"] }],
        constraints: [],
      },
    }, {
      id: "plate_extrude",
      name: "Plate extrude",
      kind: "extrude",
      profile: { sketchFeatureId: "plate_profile", loopIds: ["outer"] },
      distance: cadLengthExpression(0.5),
      operation: "new",
      resultBodyId: "plate_body",
    }],
    activeBodyIds: ["plate_body"],
  };
  return definition;
}

function maximumBodiesCadDefinition(): CadPartDefinitionV1 {
  const base = exactPlateDefinition();
  const sketch = base.history[0]!;
  const sourceExtrude = base.history[1] as Extract<CadFeature, { kind: "extrude" }>;
  const activeBodyIds = Array.from({ length: 64 }, (_, index) => `body_${index}`);
  return {
    ...base,
    partId: "maximum_bodies",
    displayName: "Maximum active bodies",
    history: [sketch, ...activeBodyIds.map((bodyId, index) => ({
      ...sourceExtrude,
      id: `extrude_${index}`,
      name: `Extrude ${index}`,
      resultBodyId: bodyId,
    }))],
    activeBodyIds,
  };
}

function mixedCadModel() {
  const definition = exactPlateDefinition();
  const content: Omit<ModelDefinitionV2, "digest"> = {
    formatVersion: MODEL_DEFINITION_FORMAT_VERSION,
    generatorVersion: MODEL_DEFINITION_GENERATOR_VERSION,
    modelId: "com.semaframe.mixed-cad-handoff",
    version: "1.0.0",
    displayName: "Mixed editable CAD handoff",
    rootNodeId: "MIXED_ROOT",
    sourceRevision: 7,
    nodes: [{
      nodeId: "MIXED_ROOT",
      logicalNodeId: "MIXED_ROOT",
      sourceComponentId: "MIXED_ROOT",
      componentType: DEFAULT_COMPONENT_REGISTRY.ref("model-assembly"),
      label: "Mixed root",
      props: {},
      durableState: {},
      placement: world(),
      tags: [],
      visibility: "visible",
    }, {
      nodeId: "EDITABLE_PLATE",
      logicalNodeId: "EDITABLE_PLATE",
      sourceComponentId: "EDITABLE_PLATE",
      parentNodeId: "MIXED_ROOT",
      componentType: DEFAULT_COMPONENT_REGISTRY.ref("cad-part"),
      label: "Exact editable plate",
      partNumber: "PLATE-001",
      materialName: "Aluminium 6061",
      props: {
        definition: structuredClone(definition) as unknown as JSONObject,
        definitionDigest: cadPartDefinitionDigest(definition),
        material: {
          baseColor: "#B8C2CC",
          metallic: 0.7,
          roughness: 0.25,
          opacity: 1,
          emissiveColor: "#000000",
          emissiveIntensity: 0,
        },
      },
      durableState: {},
      placement: world(
        { x: -3, y: 0, z: 0 },
        { x: 0, y: 0, z: Math.PI / 2 },
        { x: 2, y: 2, z: 2 },
      ),
      tags: [],
      visibility: "visible",
    }, {
      nodeId: "REFERENCE_BLOCK",
      logicalNodeId: "REFERENCE_BLOCK",
      sourceComponentId: "REFERENCE_BLOCK",
      parentNodeId: "MIXED_ROOT",
      componentType: DEFAULT_COMPONENT_REGISTRY.ref("spatial-primitive"),
      label: "Reference block",
      props: { geometry: { kind: "box", sizeM: { x: 1, y: 1, z: 1 } } },
      durableState: {},
      placement: world({ x: 2, y: 0, z: 0 }),
      tags: [],
      visibility: "visible",
    }],
  };
  return Object.freeze({ ...content, digest: deterministicDigest(content) });
}

function textOf(files: readonly Readonly<{ path: string; bytes: Uint8Array }>[], path: string): string {
  const file = files.find((entry) => entry.path === path);
  if (file === undefined) throw new Error(`Missing package file ${path}`);
  return new TextDecoder().decode(file.bytes);
}

function storedZipFiles(bytes: Uint8Array): ReadonlyMap<string, Uint8Array> {
  const files = new Map<string, Uint8Array>();
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let offset = 0;
  while (offset + 4 <= bytes.byteLength && view.getUint32(offset, true) === 0x04034b50) {
    const method = view.getUint16(offset + 8, true);
    const size = view.getUint32(offset + 18, true);
    const nameLength = view.getUint16(offset + 26, true);
    const extraLength = view.getUint16(offset + 28, true);
    if (method !== 0) throw new Error("CAD handoff test expects deterministic stored ZIP entries");
    const nameStart = offset + 30;
    const dataStart = nameStart + nameLength + extraLength;
    const path = new TextDecoder().decode(bytes.subarray(nameStart, nameStart + nameLength));
    files.set(path, Uint8Array.from(bytes.subarray(dataStart, dataStart + size)));
    offset = dataStart + size;
  }
  if (view.getUint32(offset, true) !== 0x02014b50) {
    throw new Error("CAD handoff archive is missing its central directory");
  }
  return files;
}

describe("deterministic CAD handoff package", () => {
  it("fails the side-effect-free compatibility gate before an expanded CAD model exceeds the OCCT part cap", () => {
    const source = mixedCadModel();
    const template = source.nodes.find((node) => node.nodeId === "EDITABLE_PLATE")!;
    const definition = maximumBodiesCadDefinition();
    const added = Array.from({ length: 5 }, (_, index) => ({
      ...structuredClone(template),
      nodeId: `MANY_BODY_PART_${index}`,
      logicalNodeId: `MANY_BODY_PART_${index}`,
      sourceComponentId: `MANY_BODY_PART_${index}`,
      label: `Many body part ${index}`,
      props: {
        ...structuredClone(template.props),
        definition: structuredClone(definition) as unknown as JSONObject,
        definitionDigest: cadPartDefinitionDigest(definition),
      },
    }));
    const { digest: _digest, ...sourceContent } = source;
    const content = { ...sourceContent, nodes: [...source.nodes, ...added] };
    const oversized = { ...content, digest: deterministicDigest(content) } as ModelDefinitionV2;

    expect(modelDefinitionCadHandoffCompatibility(oversized)).toEqual({
      supported: false,
      reason: "CAD handoff supports at most 256 solid parts; this model expands to 322",
    });
  });

  it("packages AP242, USDA, sidecar and a passing OCCT round-trip report", async () => {
    const definition = nestedColoredModel();
    const first = await createModelDefinitionCadHandoffPackage(definition);
    const second = await createModelDefinitionCadHandoffPackage(definition);

    expect(first.files.map((file) => file.path)).toEqual([
      "model.step",
      "model.usda",
      "report.json",
      "semaframe-cad.json",
    ]);
    expect(first.archive.path).toBe("com.semaframe.cad-handoff-fixture-2.0.0.cad-handoff.zip");
    expect(textOf(first.files, "model.step")).toBe(textOf(second.files, "model.step"));
    expect(first.archive.bytes).toEqual(second.archive.bytes);
    expect(first.archive.sha256).toBe(second.archive.sha256);
    expect(first.files.map((file) => file.sha256)).toEqual(second.files.map((file) => file.sha256));
    for (const file of [...first.files, first.archive]) {
      expect(file.byteLength).toBe(file.bytes.byteLength);
      expect(file.sha256).toMatch(/^sha256:[0-9a-f]{64}$/u);
    }

    const step = textOf(first.files, "model.step");
    expect(step).toContain("AP242_MANAGED_MODEL_BASED_3D_ENGINEERING");
    expect(step).toContain("Nested CAD handoff fixture [SF:HANDOFF]");
    expect(step).toContain("SF:PART:");
    expect(step).toContain("SURFACE_STYLE_TRANSPARENT");
    expect(step.match(/NEXT_ASSEMBLY_USAGE_OCCURRENCE\s*\(/gu)).toHaveLength(4);

    const usd = textOf(first.files, "model.usda");
    expect(usd).toContain("metersPerUnit = 1");
    expect(usd).toContain('upAxis = "Y"');
    expect(usd).toContain('string "semaframe:id" = "LARGE_BLOCK"');

    const manifest = JSON.parse(textOf(first.files, "semaframe-cad.json")) as CadHandoffManifest;
    expect(manifest).toMatchObject({
      format: "semaframe-cad-handoff",
      version: "2.0",
      authoritativeGeometry: "model.step",
      sceneDescription: "model.usda",
      units: "metre",
      editability: {
        stepGeometry: "exact-brep-direct-editable",
        assemblyStructure: "xcaf-product-occurrences",
        nativeCadFeatureHistory: false,
      },
    });
    expect(manifest.nodes).toHaveLength(4);
    expect(manifest.nodes.find((node) => node.semaframeNodeId === "LARGE_BLOCK")).toMatchObject({
      parentNodeId: "ARM",
      kind: "part",
      usdPrimPath: expect.stringMatching(/^\/World\//u),
      geometry: { kind: "box" },
    });

    const report = JSON.parse(textOf(first.files, "report.json")) as CadHandoffReport;
    expect(report).toMatchObject({
      outcome: "passed",
      export: {
        schema: "STEP AP242",
        exactBrep: true,
        booleanUnionAppliedAcrossParts: false,
        partCount: 2,
        modelAssemblyCount: 2,
        stepContainerAssemblyCount: 1,
        occurrenceCount: 4,
      },
      occtRoundTrip: {
        passed: true,
        rootCount: 1,
        solidCount: 2,
        expectedPartCount: 2,
        expectedVolumeM3: 9,
        boundsMatch: true,
        boundsAbsoluteToleranceM: 1e-6,
      },
    });
    expect(report.occtRoundTrip.importedVolumeM3).toBeCloseTo(9, 12);
    expect(report.occtRoundTrip.boundsMaximumAbsoluteErrorM)
      .toBeLessThanOrEqual(report.occtRoundTrip.boundsAbsoluteToleranceM);
    expect(report.occtRoundTrip.expectedBoundsM).toEqual(report.occtRoundTrip.boundsM);
    expect(report.occtRoundTrip.boundsM.min.x).toBeCloseTo(0, 5);
    expect(report.occtRoundTrip.boundsM.min.y).toBeCloseTo(0, 5);
    expect(report.occtRoundTrip.boundsM.max.x).toBeCloseTo(5.5, 5);
    expect(report.occtRoundTrip.boundsM.max.y).toBeCloseTo(2, 5);
    expect(report.occtRoundTrip.boundsM.size.z).toBeCloseTo(2, 5);

    const archived = storedZipFiles(first.archive.bytes);
    expect([...archived.keys()]).toEqual(first.files.map((file) => file.path));
    for (const file of first.files) {
      expect(archived.get(file.path)).toEqual(file.bytes);
    }
  }, 60_000);

  it("exports an editable CAD feature body and primitive as separate exact XCAF parts", async () => {
    const sourceModel = mixedCadModel();
    const result = await createModelDefinitionCadHandoffPackage(sourceModel);
    const repeated = await createModelDefinitionCadHandoffPackage(sourceModel);
    expect(textOf(result.files, "model.step")).toBe(textOf(repeated.files, "model.step"));
    expect(result.archive.bytes).toEqual(repeated.archive.bytes);
    const step = textOf(result.files, "model.step");
    expect(step).toContain("Exact editable plate");
    expect(step).toContain("plate_body");
    expect(step).toContain("PLATE-001");
    expect(step.match(/NEXT_ASSEMBLY_USAGE_OCCURRENCE\s*\(/gu)).toHaveLength(4);

    const cadNode = result.manifest.nodes.find((node) => node.semaframeNodeId === "EDITABLE_PLATE");
    expect(cadNode).toMatchObject({
      kind: "part",
      logicalNodeId: "EDITABLE_PLATE",
      partNumber: "PLATE-001",
      materialName: "Aluminium 6061",
      geometry: {
        kind: "cad-part",
        activeBodyIds: ["plate_body"],
      },
      stepBodyDefinitions: [{ bodyId: "plate_body" }],
    });
    expect(result.manifest.editableModelDefinition).toEqual(sourceModel);
    expect(result.report).toMatchObject({
      outcome: "passed",
      export: {
        exactBrep: true,
        booleanUnionAppliedAcrossParts: false,
        partCount: 2,
        modelAssemblyCount: 1,
        cadPartAssemblyCount: 1,
        occurrenceCount: 4,
      },
      occtRoundTrip: {
        passed: true,
        solidCount: 2,
        expectedPartCount: 2,
      },
    });
    expect(result.report.occtRoundTrip.expectedVolumeM3).toBeCloseTo(9, 12);
    expect(result.report.occtRoundTrip.importedVolumeM3).toBeCloseTo(9, 10);
  }, 60_000);

  it("fails closed for non-uniform scale instead of silently distorting geometry", async () => {
    const definition = nestedColoredModel();
    if (definition.formatVersion !== LEGACY_MODEL_DEFINITION_FORMAT_VERSION) {
      throw new Error("The spatial-primitive-only fixture must remain a legacy V1 model definition");
    }
    const arm = definition.nodes.find((node) => node.nodeId === "ARM")!;
    const changed: ModelDefinitionV1 = {
      ...definition,
      nodes: definition.nodes.map((node) => node.nodeId === arm.nodeId
        ? { ...node, placement: { ...node.placement, scale: { x: 2, y: 1, z: 1 } } }
        : node),
    };
    const { digest: _digest, ...content } = changed;
    const mutated = { ...content, digest: deterministicDigest(content) };
    await expect(createModelDefinitionCadHandoffPackage(mutated)).rejects.toMatchObject({
      code: "non_uniform_scale",
    });
  });
});
