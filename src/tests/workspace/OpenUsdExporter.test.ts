import { describe, expect, it } from "vitest";
import {
  OpenUsdExportError,
  assertOpenUsdExportDocument,
  exportParametricModelToUsda,
  toOpenUsdIdentifier,
  type OpenUsdExportDocument,
} from "../../workspace/modeling/openUsdExporter";

const material = Object.freeze({
  id: "material:steel",
  name: "Blue steel",
  baseColorLinear: { r: 0.02, g: 0.08, b: 0.2 },
  metallic: 0.9,
  roughness: 0.25,
  opacity: 0.95,
  emissiveColorLinear: { r: 0, g: 0.01, b: 0.03 },
});

function modelDocument(): OpenUsdExportDocument {
  return {
    id: "model:machine-v1",
    name: "Machine v1",
    materials: [material],
    nodes: [
      {
        id: "assembly",
        name: "Machine assembly",
        transform: {
          translationM: { x: 1.25, y: 0, z: -2 },
          rotationQuaternion: { x: 0, y: Math.SQRT1_2, z: 0, w: Math.SQRT1_2 },
          scale: { x: 1, y: 1, z: 1 },
        },
      },
      {
        id: "base",
        name: "Base plate",
        parentId: "assembly",
        primitive: { kind: "box", sizeM: { x: 1.2, y: 0.08, z: 0.8 } },
        materialId: material.id,
      },
      {
        id: "ball",
        name: "Ball",
        parentId: "assembly",
        primitive: { kind: "sphere", radiusM: 0.125 },
      },
      {
        id: "column",
        name: "Column",
        parentId: "assembly",
        primitive: { kind: "cylinder", radiusM: 0.1, heightM: 0.8, axis: "y" },
      },
      {
        id: "guard",
        name: "Guard",
        parentId: "assembly",
        primitive: { kind: "capsule", radiusM: 0.05, cylinderHeightM: 0.4, axis: "x" },
      },
      {
        id: "tip",
        name: "Tip",
        parentId: "assembly",
        primitive: { kind: "cone", radiusM: 0.1, heightM: 0.2, axis: "z" },
        visible: false,
      },
      {
        id: "work-surface",
        name: "Work surface",
        parentId: "assembly",
        primitive: { kind: "plane", sizeM: { x: 2, y: 1.5 }, normalAxis: "y" },
      },
    ],
  };
}

describe("OpenUSD ASCII exporter", () => {
  it("emits a self-contained meters/Y-up hierarchy with analytic primitives and Preview Surface", () => {
    const result = exportParametricModelToUsda(modelDocument());

    expect(result).toMatchObject({ format: "usda", version: "1.0" });
    expect(result.usda).toContain("#usda 1.0\n(");
    expect(result.usda).toContain('defaultPrim = "World"');
    expect(result.usda).toContain("metersPerUnit = 1");
    expect(result.usda).toContain('upAxis = "Y"');
    expect(result.usda).toContain('string "semaframe:id" = "model:machine-v1"');
    expect(result.usda).toContain('string "semaframe:label" = "Machine assembly"');
    expect(result.usda).toContain('def Xform "Machine_assembly"');
    expect(result.usda).toContain("double3 xformOp:translate = (1.25, 0, -2)");
    expect(result.usda).toContain("quatd xformOp:orient = (0.7071067811865475, 0, 0.7071067811865475, 0)");
    expect(result.usda).toContain('def Cube "Geometry"');
    expect(result.usda).toContain("double3 xformOp:scale = (1.2, 0.08, 0.8)");
    expect(result.usda).toContain('def Sphere "Geometry"');
    expect(result.usda).toContain("double radius = 0.125");
    expect(result.usda).toContain('def Cylinder "Geometry"');
    expect(result.usda).toContain('uniform token axis = "Y"');
    expect(result.usda).toContain('def Capsule "Geometry"');
    expect(result.usda).toContain('uniform token axis = "X"');
    expect(result.usda).toContain('def Cone "Geometry"');
    expect(result.usda).toContain('uniform token axis = "Z"');
    expect(result.usda).toContain('def Plane "Geometry"');
    expect(result.usda).toContain("double length = 1.5");
    expect(result.usda).toContain("double width = 2");
    expect(result.usda).toContain('token visibility = "invisible"');
    expect(result.usda).toContain('def Material "Blue_steel"');
    expect(result.usda).toContain('uniform token info:id = "UsdPreviewSurface"');
    expect(result.usda).toContain("color3f inputs:diffuseColor = (0.02, 0.08, 0.2)");
    expect(result.usda).toContain("float inputs:metallic = 0.9");
    expect(result.usda).toContain("rel material:binding = </World/Materials/Blue_steel>");
    expect(result.usda.endsWith("\n")).toBe(true);
    expect(result.nodePrimPaths).toEqual({
      assembly: "/World/Machine_assembly",
      ball: "/World/Machine_assembly/Ball",
      base: "/World/Machine_assembly/Base_plate",
      column: "/World/Machine_assembly/Column",
      guard: "/World/Machine_assembly/Guard",
      tip: "/World/Machine_assembly/Tip",
      "work-surface": "/World/Machine_assembly/Work_surface",
    });
    expect(result.materialPrimPaths).toEqual({
      "material:steel": "/World/Materials/Blue_steel",
    });
  });

  it("is byte-stable across input permutations and canonicalizes equivalent quaternions", () => {
    const first = modelDocument();
    const reversed: OpenUsdExportDocument = {
      ...first,
      nodes: [...first.nodes]
        .reverse()
        .map((node) => node.id === "assembly"
          ? {
              ...node,
              transform: {
                ...node.transform,
                rotationQuaternion: {
                  x: -(node.transform?.rotationQuaternion?.x ?? 0),
                  y: -(node.transform?.rotationQuaternion?.y ?? 0),
                  z: -(node.transform?.rotationQuaternion?.z ?? 0),
                  w: -(node.transform?.rotationQuaternion?.w ?? 1),
                },
              },
            }
          : node),
      materials: [...(first.materials ?? [])].reverse(),
    };

    const left = exportParametricModelToUsda(first);
    const right = exportParametricModelToUsda(reversed);
    expect(right.usda).toBe(left.usda);
    expect(right.nodePrimPaths).toEqual(left.nodePrimPaths);
    expect(right.materialPrimPaths).toEqual(left.materialPrimPaths);
  });

  it("resolves sanitized sibling and reserved-name collisions deterministically", () => {
    const document: OpenUsdExportDocument = {
      id: "model",
      name: "Collision test",
      materials: [{
        id: "mat",
        name: "Paint",
        baseColorLinear: { r: 1, g: 0, b: 0 },
      }],
      nodes: [
        { id: "one", name: "Part-A", primitive: { kind: "box", sizeM: { x: 1, y: 1, z: 1 } } },
        { id: "two", name: "Part A", primitive: { kind: "box", sizeM: { x: 1, y: 1, z: 1 } } },
        { id: "materials-node", name: "Materials" },
        {
          id: "geometry-child",
          name: "Geometry",
          parentId: "one",
          primitive: { kind: "sphere", radiusM: 0.5 },
        },
      ],
    };
    const forward = exportParametricModelToUsda(document);
    const reverse = exportParametricModelToUsda({ ...document, nodes: [...document.nodes].reverse() });

    expect(reverse.usda).toBe(forward.usda);
    expect(new Set(Object.values(forward.nodePrimPaths)).size).toBe(document.nodes.length);
    expect(forward.nodePrimPaths.one).toMatch(/^\/World\/Part_A_[a-f0-9]{8}$/u);
    expect(forward.nodePrimPaths.two).toMatch(/^\/World\/Part_A_[a-f0-9]{8}$/u);
    expect(forward.nodePrimPaths["materials-node"]).toMatch(/^\/World\/Materials_[a-f0-9]{8}$/u);
    expect(forward.nodePrimPaths["geometry-child"]).toMatch(/\/Geometry_[a-f0-9]{8}$/u);
  });

  it("sanitizes arbitrary labels into legal USD identifiers", () => {
    expect(toOpenUsdIdentifier("  12 mm bracket / left  ")).toBe("_12_mm_bracket_left");
    expect(toOpenUsdIdentifier("机械臂", "Node")).toBe("Node");
    expect(toOpenUsdIdentifier("机械臂", "123 fallback name")).toBe("_123_fallback_name");
    expect(toOpenUsdIdentifier("Already_valid")).toBe("Already_valid");
  });

  it.each([
    {
      name: "duplicate IDs",
      mutate: (): unknown => ({
        ...modelDocument(),
        nodes: [{ id: "same", name: "A" }, { id: "same", name: "B" }],
      }),
      code: "duplicate_id",
    },
    {
      name: "missing parents",
      mutate: (): unknown => ({
        ...modelDocument(),
        nodes: [{ id: "child", name: "Child", parentId: "absent" }],
      }),
      code: "missing_parent",
    },
    {
      name: "hierarchy cycles",
      mutate: (): unknown => ({
        ...modelDocument(),
        nodes: [
          { id: "a", name: "A", parentId: "b" },
          { id: "b", name: "B", parentId: "a" },
        ],
      }),
      code: "hierarchy_cycle",
    },
    {
      name: "missing materials",
      mutate: (): unknown => ({
        ...modelDocument(),
        nodes: [{
          id: "box",
          name: "Box",
          primitive: { kind: "box", sizeM: { x: 1, y: 1, z: 1 } },
          materialId: "absent",
        }],
      }),
      code: "missing_material",
    },
    {
      name: "degenerate dimensions",
      mutate: (): unknown => ({
        ...modelDocument(),
        nodes: [{ id: "box", name: "Box", primitive: { kind: "box", sizeM: { x: 1, y: 0, z: 1 } } }],
      }),
      code: "invalid_number",
    },
    {
      name: "zero quaternions",
      mutate: (): unknown => ({
        ...modelDocument(),
        nodes: [{
          id: "node",
          name: "Node",
          transform: { rotationQuaternion: { x: 0, y: 0, z: 0, w: 0 } },
        }],
      }),
      code: "invalid_number",
    },
    {
      name: "unknown DTO properties",
      mutate: (): unknown => ({
        ...modelDocument(),
        nodes: [{ id: "node", name: "Node", unexportedGeometry: true }],
      }),
      code: "invalid_document",
    },
  ])("rejects $name atomically", ({ mutate, code }) => {
    expect(() => assertOpenUsdExportDocument(mutate())).toThrowError(
      expect.objectContaining<Partial<OpenUsdExportError>>({ code: code as OpenUsdExportError["code"] }),
    );
  });
});
