import { describe, expect, it } from "vitest";
import { DEFAULT_COMPONENT_REGISTRY } from "../../workspace/components";
import {
  buildSemaFrameSpatialGraph,
  findBlockingSpatialCollisions,
  querySpatialPlacement,
} from "../../workspace/spatial";
import { WorkspaceStore } from "../../workspace/state";
import { WorkspaceProjectSerializer } from "../../workspace/persistence";
import { parametricGeometryDigest, type ParametricPrimitive } from "../../workspace/modeling";
import type { JSONObject } from "../../workspace/components/componentTypes";
import { workspaceBatch } from "./helpers";

const transform = (
  x: number,
  y = 0,
  z = 0,
  rotationY = 0,
) => ({
  space: "world3d" as const,
  position: { x, y, z },
  rotation: { x: 0, y: rotationY, z: 0 },
  scale: { x: 1, y: 1, z: 1 },
});

function createStage() {
  return {
    op: "create_component" as const,
    op_id: "create_stage",
    id: "STAGE",
    component_type: DEFAULT_COMPONENT_REGISTRY.ref("stage-3d"),
    placement: transform(0),
  };
}

function createSpatial(
  id: string,
  x: number,
  z = 0,
  options: { parentId?: string; rotationY?: number; role?: "solid" | "trigger" | "none" } = {},
) {
  return {
    op: "create_component" as const,
    op_id: `create_${id}`,
    id,
    component_type: DEFAULT_COMPONENT_REGISTRY.ref("spatial-entity"),
    ...(options.parentId ? { parent_id: options.parentId } : {}),
    placement: transform(x, 0, z, options.rotationY ?? 0),
    props: {
      assetId: "primitive_box",
      entityKind: "primitive" as const,
      ...(options.role ? {
        collision: { enabled: true, role: options.role, shape: "asset_bounds" as const, margin: 0 },
      } : {}),
    },
  };
}

function createAssembly(
  id: string,
  collisionPolicy: "external_only" | "all" | "none",
  options: { parentId?: string; placement?: ReturnType<typeof transform>; modelRef?: Record<string, string> } = {},
) {
  return {
    op: "create_component" as const,
    op_id: `create_${id}`,
    id,
    component_type: DEFAULT_COMPONENT_REGISTRY.ref("model-assembly"),
    ...(options.parentId ? { parent_id: options.parentId } : {}),
    placement: options.placement ?? transform(0),
    props: {
      collisionPolicy,
      ...(options.modelRef ? { modelRef: options.modelRef } : {}),
    },
  };
}

function createPrimitive(
  id: string,
  geometry: ParametricPrimitive,
  options: {
    parentId?: string;
    placement?: ReturnType<typeof transform>;
  } = {},
) {
  return {
    op: "create_component" as const,
    op_id: `create_${id}`,
    id,
    component_type: DEFAULT_COMPONENT_REGISTRY.ref("spatial-primitive"),
    ...(options.parentId ? { parent_id: options.parentId } : {}),
    placement: options.placement ?? transform(0),
    props: { geometry: structuredClone(geometry) as unknown as JSONObject },
  };
}

describe("SemaFrame Spatial Graph spatial index", () => {
  it("projects deterministic world transforms, prim paths, bounds, and support relations", () => {
    const store = new WorkspaceStore();
    store.apply(workspaceBatch(store, "space", [
      createStage(),
      createSpatial("PARENT", 2, 3, { rotationY: Math.PI / 2 }),
      createSpatial("CHILD", 1, 0, { parentId: "PARENT" }),
    ]));

    const snapshot = buildSemaFrameSpatialGraph(store.getState());
    expect(snapshot).toMatchObject({
      format: "semaframe-spatial-graph",
      version: "3.2",
      workspaceRevision: 1,
      coordinateSystem: { units: "meters", upAxis: "+Y", forwardAxis: "+Z" },
      stage: {
        componentId: "STAGE",
        visibility: "visible",
        dimensions: { width: 12, height: 4, depth: 10 },
        groundHeight: 0,
      },
      mode: "full",
      removedNodeIds: [],
      collisionConflictsTruncated: false,
      omittedNodeCount: 0,
    });
    expect(snapshot.nodes.map((node) => node.id)).toEqual(["CHILD", "PARENT"]);
    const child = snapshot.nodes.find((node) => node.id === "CHILD")!;
    expect(child.primPath).toBe("/World/PARENT/CHILD");
    expect(child.worldTransform.position.x).toBeCloseTo(2, 6);
    expect(child.worldTransform.position.z).toBeCloseTo(2, 6);
    expect(child.worldBounds.size).toMatchObject({ x: 1, y: 1, z: 1 });
  });

  it("uses oriented boxes, allows face touching, and ignores trigger volumes", () => {
    const store = new WorkspaceStore();
    store.apply(workspaceBatch(store, "space", [
      createStage(),
      createSpatial("A", 0),
      createSpatial("TOUCHING", 1.04),
      createSpatial("ROTATED", 2.5, 2.5, { rotationY: Math.PI / 4 }),
      createSpatial("TRIGGER", 0.2, 0, { role: "trigger" }),
    ]));
    const conflicts = findBlockingSpatialCollisions(store.getState());
    expect(conflicts).toEqual([]);

    const check = querySpatialPlacement(store.getState(), {
      assetId: "primitive_box",
      entityKind: "primitive",
      placement: transform(0.25),
    });
    expect(check.valid).toBe(false);
    expect(check.conflicts.some((conflict) => conflict.conflictsWith === "A")).toBe(true);
    expect(check.suggestedPlacements).toHaveLength(4);
  });

  it("checks updates without colliding an entity with itself and returns an empty delta", () => {
    const store = new WorkspaceStore();
    store.apply(workspaceBatch(store, "space", [createStage(), createSpatial("A", 0)]));
    expect(querySpatialPlacement(store.getState(), {
      componentId: "A",
      placement: transform(4),
    })).toMatchObject({ valid: true, candidateId: "A", conflicts: [] });
    expect(buildSemaFrameSpatialGraph(store.getState(), {
      mode: "delta",
      sinceRevision: 1,
      changedNodeIds: new Set(),
    })).toMatchObject({ mode: "delta", sinceRevision: 1, nodes: [] });
  });

  it("rejects overlaps atomically and preserves collision intent through undo, redo, and reopen", () => {
    const rejected = new WorkspaceStore();
    expect(() => rejected.apply(workspaceBatch(rejected, "overlap", [
      createStage(), createSpatial("A", 0), createSpatial("B", 0.5),
    ]))).toThrowError(expect.objectContaining({
      code: "spatial_collision",
      conflicts: [expect.objectContaining({ componentId: "A", conflictsWith: "B" })],
    }));
    expect(rejected.getRevision()).toBe(0);
    expect(rejected.getState().components.size).toBe(0);

    const store = new WorkspaceStore();
    store.apply(workspaceBatch(store, "clear_space", [
      createStage(), createSpatial("A", 0), createSpatial("B", 3),
    ]));
    expect(() => store.apply(workspaceBatch(store, "bad_move", [{
      op: "place_component", op_id: "move_b", id: "B", placement: transform(0.2),
    }]))).toThrow(/spatial collision/i);
    expect(store.getRevision()).toBe(1);
    expect(store.getState().components.get("B")?.placement).toEqual(transform(3));

    store.apply(workspaceBatch(store, "good_move", [{
      op: "place_component", op_id: "move_b", id: "B", placement: transform(4),
    }]));
    store.undo();
    expect(store.getState().components.get("B")?.placement).toEqual(transform(3));
    store.redo();
    expect(store.getState().components.get("B")?.placement).toEqual(transform(4));
    const serializer = new WorkspaceProjectSerializer();
    const reopened = serializer.openStore(serializer.deserialize(serializer.serialize(
      serializer.fromStore("collision", store),
    )));
    expect(reopened.getState().components.get("A")?.props.collision).toMatchObject({
      enabled: true, role: "solid", shape: "asset_bounds", margin: 0.02,
    });
    expect(findBlockingSpatialCollisions(reopened.getState())).toEqual([]);
  });

  it("permits parent-child face attachment but detects actual hierarchical penetration", () => {
    const touching = new WorkspaceStore();
    touching.apply(workspaceBatch(touching, "attached_touch", [
      createStage(),
      createSpatial("PARENT", 0),
      createSpatial("CHILD", 1, 0, { parentId: "PARENT" }),
    ]));
    expect(findBlockingSpatialCollisions(touching.getState())).toEqual([]);

    const penetrating = new WorkspaceStore();
    expect(() => penetrating.apply(workspaceBatch(penetrating, "attached_overlap", [
      createStage(),
      createSpatial("PARENT", 0),
      createSpatial("CHILD", 0.5, 0, { parentId: "PARENT" }),
    ]))).toThrowError(expect.objectContaining({ code: "spatial_collision" }));
  });

  it("caps nodes before relationship analysis", () => {
    const store = new WorkspaceStore();
    store.apply(workspaceBatch(store, "bounded_analysis", [
      createStage(),
      createSpatial("A", -4),
      createSpatial("B", 0),
      createSpatial("C", 4),
    ]));
    const snapshot = buildSemaFrameSpatialGraph(store.getState(), { maxNodes: 1 });
    expect(snapshot.nodes.map((node) => node.id)).toEqual(["A"]);
    expect(snapshot.nodes[0]?.relations).toEqual([]);
    expect(snapshot.collisionConflicts).toEqual([]);
    expect(snapshot.omittedNodeCount).toBe(2);
  });

  it("rejects a persisted workspace above the spatial analysis capacity before collision work", () => {
    const base = new WorkspaceStore();
    base.apply(workspaceBatch(base, "capacity_base", [createStage(), createSpatial("BODY_0000", 0)]));
    const state = base.getState();
    const sample = state.components.get("BODY_0000")!;
    const components = new Map(state.components);
    for (let index = 1; index <= 2_000; index += 1) {
      const id = `BODY_${String(index).padStart(4, "0")}`;
      components.set(id, { ...structuredClone(sample), id, label: id });
    }
    expect(() => new WorkspaceStore({ initialState: { ...state, components } }))
      .toThrowError(expect.objectContaining({ code: "spatial_capacity_exceeded" }));
  });

  it("projects exact parametric evidence through rotated and scaled assembly transforms", () => {
    const store = new WorkspaceStore();
    const geometry = { kind: "box", sizeM: { x: 2, y: 4, z: 6 } } as const;
    const assemblyPlacement = transform(2, 0, 1, Math.PI / 2);
    const primitivePlacement = transform(1, 5, 0);
    store.apply(workspaceBatch(store, "parametric_space", [
      createStage(),
      createAssembly("MODEL", "external_only", {
        placement: assemblyPlacement,
        modelRef: { modelId: "fixture-a", version: "1.0.0", digest: "fnv1a32:12345678" },
      }),
      createPrimitive("PART", geometry, { parentId: "MODEL", placement: primitivePlacement }),
    ]));

    // Evaluate defensive imported/migrated TRS beyond the authoring policy,
    // which keeps primitives at identity scale and assemblies uniformly scaled.
    const components = new Map(store.getState().components);
    const assembly = components.get("MODEL")!;
    const primitive = components.get("PART")!;
    if (assembly.placement.space !== "world3d" || primitive.placement.space !== "world3d") {
      throw new TypeError("Modeling test components must use world3d placement");
    }
    components.set("MODEL", {
      ...assembly,
      placement: { ...assembly.placement, scale: { x: 2, y: 1, z: 0.5 } },
    });
    components.set("PART", {
      ...primitive,
      placement: { ...primitive.placement, scale: { x: 1, y: 2, z: 1 } },
    });
    const snapshot = buildSemaFrameSpatialGraph({ ...store.getState(), components });
    const model = snapshot.nodes.find((node) => node.id === "MODEL")!;
    const part = snapshot.nodes.find((node) => node.id === "PART")!;
    expect(part).toMatchObject({
      nodeKind: "primitive",
      entityKind: "primitive",
      primPath: "/World/MODEL/PART",
      geometry: {
        kind: "box",
        digest: parametricGeometryDigest(geometry),
        parameters: geometry,
        dimensionsM: { x: 2, y: 4, z: 6 },
        volumeM3: 48,
        collider: { shape: "box", sizeM: { x: 2, y: 4, z: 6 } },
        material: {
          baseColor: "#68D5FF",
          metallic: 0,
          roughness: 0.55,
          opacity: 1,
        },
      },
      collision: { source: "parametric_bounds" },
      assemblyAncestry: [{
        id: "MODEL",
        collisionPolicy: "external_only",
        modelRef: { modelId: "fixture-a", version: "1.0.0", digest: "fnv1a32:12345678" },
      }],
    });
    expect(part.assetId).toBeUndefined();
    expect(part.worldTransform.position.x).toBeCloseTo(2, 8);
    expect(part.worldTransform.position.y).toBeCloseTo(5, 8);
    expect(part.worldTransform.position.z).toBeCloseTo(-1, 8);
    expect(part.worldBounds.size.x).toBeCloseTo(3, 8);
    expect(part.worldBounds.size.y).toBeCloseTo(8, 8);
    expect(part.worldBounds.size.z).toBeCloseTo(4, 8);
    expect(model).toMatchObject({
      nodeKind: "assembly",
      entityKind: "assembly",
      assembly: {
        collisionPolicy: "external_only",
        modelRef: { modelId: "fixture-a", version: "1.0.0", digest: "fnv1a32:12345678" },
      },
      worldBounds: part.worldBounds,
    });
    expect(model.collision).toBeUndefined();
    expect(buildSemaFrameSpatialGraph({ ...store.getState(), components }, {
      mode: "delta",
      changedNodeIds: new Set(["MODEL"]),
    }).nodes.map((node) => node.id)).toEqual(["MODEL", "PART"]);
    expect(buildSemaFrameSpatialGraph({ ...store.getState(), components }, {
      mode: "delta",
      changedNodeIds: new Set(["PART"]),
    }).nodes.map((node) => node.id)).toEqual(["MODEL", "PART"]);
  });

  it("applies external_only, all, and none assembly collision policies deterministically", () => {
    const box = { kind: "box", sizeM: { x: 1, y: 1, z: 1 } } as const;
    const externalOnly = new WorkspaceStore();
    externalOnly.apply(workspaceBatch(externalOnly, "external_only_internal", [
      createStage(),
      createAssembly("MODEL", "external_only"),
      createPrimitive("LEFT", box, { parentId: "MODEL" }),
      createPrimitive("RIGHT", box, { parentId: "MODEL" }),
    ]));
    expect(findBlockingSpatialCollisions(externalOnly.getState())).toEqual([]);
    expect(() => externalOnly.apply(workspaceBatch(externalOnly, "external_collision", [
      createPrimitive("OUTSIDE", box),
    ]))).toThrowError(expect.objectContaining({ code: "spatial_collision" }));

    const all = new WorkspaceStore();
    expect(() => all.apply(workspaceBatch(all, "all_internal", [
      createStage(),
      createAssembly("MODEL", "all"),
      createPrimitive("LEFT", box, { parentId: "MODEL" }),
      createPrimitive("RIGHT", box, { parentId: "MODEL" }),
    ]))).toThrowError(expect.objectContaining({ code: "spatial_collision" }));

    const none = new WorkspaceStore();
    none.apply(workspaceBatch(none, "none_policy", [
      createStage(),
      createAssembly("MODEL", "none"),
      createPrimitive("INTERNAL", box, { parentId: "MODEL" }),
      createPrimitive("OUTSIDE", box),
    ]));
    const noneSnapshot = buildSemaFrameSpatialGraph(none.getState());
    expect(noneSnapshot.collisionConflicts).toEqual([]);
    expect(noneSnapshot.nodes.find((node) => node.id === "INTERNAL")?.collision).toBeDefined();
  });

  it("preflights closed parametric geometry without an asset identity", () => {
    const store = new WorkspaceStore();
    store.apply(workspaceBatch(store, "candidate_target", [
      createStage(),
      createPrimitive("TARGET", { kind: "box", sizeM: { x: 1, y: 1, z: 1 } }),
    ]));
    const geometry = { kind: "sphere", radiusM: 0.75 } as const;
    const check = querySpatialPlacement(store.getState(), {
      geometry,
      placement: transform(0.5),
    });
    expect(check).toMatchObject({
      valid: false,
      candidateId: "__SPATIAL_CANDIDATE__",
      conflicts: [expect.objectContaining({ conflictsWith: "TARGET" })],
    });
    expect(store.getState().components.has("__SPATIAL_CANDIDATE__")).toBe(false);
    expect(() => querySpatialPlacement(store.getState(), {
      geometry,
      assetId: "primitive_box",
      entityKind: "primitive",
      placement: transform(3),
    })).toThrow(/cannot also declare assetId or entityKind/u);
  });
});
