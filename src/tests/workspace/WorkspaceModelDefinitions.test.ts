import { describe, expect, it } from "vitest";
import { DEFAULT_COMPONENT_REGISTRY } from "../../workspace/components";
import { modelDefinitionRef } from "../../workspace/modeling";
import { WorkspaceProjectSerializer } from "../../workspace/persistence";
import { WorkspaceStore } from "../../workspace/state";
import { workspaceBatch } from "./helpers";

const world = (x: number, y: number, z: number) => ({
  space: "world3d" as const,
  position: { x, y, z },
  rotation: { x: 0, y: 0, z: 0 },
  scale: { x: 1, y: 1, z: 1 },
});

function authoredModel(): WorkspaceStore {
  const store = new WorkspaceStore();
  store.apply(workspaceBatch(store, "model_source", [{
    op: "create_component",
    op_id: "stage",
    id: "STAGE",
    component_type: DEFAULT_COMPONENT_REGISTRY.ref("stage-3d"),
    placement: world(0, 0, 0),
  }, {
    op: "create_component",
    op_id: "assembly",
    id: "ASSEMBLY",
    component_type: DEFAULT_COMPONENT_REGISTRY.ref("model-assembly"),
    props: { description: "Reusable two-part fixture", collisionPolicy: "external_only" },
    placement: world(2, 0, -1),
  }, {
    op: "create_component",
    op_id: "base",
    id: "BASE",
    component_type: DEFAULT_COMPONENT_REGISTRY.ref("spatial-primitive"),
    props: { geometry: { kind: "box", sizeM: { x: 2, y: 0.2, z: 1 } } },
    placement: world(0, 0.1, 0),
    parent_id: "ASSEMBLY",
  }, {
    op: "create_component",
    op_id: "post",
    id: "POST",
    component_type: DEFAULT_COMPONENT_REGISTRY.ref("spatial-primitive"),
    props: { geometry: { kind: "cylinder", radiusM: 0.1, heightM: 1.5, axis: "y" } },
    placement: world(0, 0.85, 0),
    parent_id: "ASSEMBLY",
  }]));
  return store;
}

describe("Workspace reusable model definitions", () => {
  it("publishes a digest-pinned immutable definition and materializes editable instances", () => {
    const store = authoredModel();
    store.apply(workspaceBatch(store, "publish_fixture", [{
      op: "publish_model",
      op_id: "publish",
      model_id: "com.semaframe.fixture",
      version: "1.0.0",
      display_name: "Fixture",
      root_id: "ASSEMBLY",
    }]));
    const definition = store.getState().modelDefinitions.get("com.semaframe.fixture@1.0.0")!;
    expect(definition.nodes.map((node) => node.nodeId)).toEqual(["ASSEMBLY", "BASE", "POST"]);
    expect(definition.nodes[0]?.placement).toEqual(world(0, 0, 0));

    const ref = modelDefinitionRef(definition);
    store.apply(workspaceBatch(store, "instantiate_fixture", [{
      op: "instantiate_model",
      op_id: "instantiate",
      model: ref,
      id_map: { ASSEMBLY: "ASSEMBLY_COPY", BASE: "BASE_COPY", POST: "POST_COPY" },
      root_placement: world(-3, 0, 4),
    }]));
    expect(store.getState().components.get("ASSEMBLY_COPY")).toMatchObject({
      props: { modelRef: ref },
      placement: world(-3, 0, 4),
    });
    expect(store.getState().components.get("BASE_COPY")).toMatchObject({
      parentId: "ASSEMBLY_COPY",
      props: { geometry: { kind: "box", sizeM: { x: 2, y: 0.2, z: 1 } } },
    });

    // An instance is an ordinary editable tree, not a hidden proxy.
    store.apply(workspaceBatch(store, "edit_instance", [{
      op: "update_component",
      op_id: "edit",
      id: "BASE_COPY",
      patch: { props: { geometry: { kind: "box", sizeM: { x: 3, y: 0.2, z: 1 } } } },
    }]));
    expect(store.getState().components.get("BASE_COPY")?.props.geometry).toEqual({
      kind: "box", sizeM: { x: 3, y: 0.2, z: 1 },
    });
    expect(definition.nodes[1]?.props.geometry).toEqual({
      kind: "box", sizeM: { x: 2, y: 0.2, z: 1 },
    });
  });

  it("persists and replays models, protects referenced definitions, and preserves undo/redo", () => {
    const store = authoredModel();
    store.apply(workspaceBatch(store, "publish_fixture", [{
      op: "publish_model",
      op_id: "publish",
      model_id: "com.semaframe.fixture",
      version: "1.0.0",
      display_name: "Fixture",
      root_id: "ASSEMBLY",
    }]));
    const definition = store.getState().modelDefinitions.get("com.semaframe.fixture@1.0.0")!;
    const ref = modelDefinitionRef(definition);
    store.apply(workspaceBatch(store, "instantiate_fixture", [{
      op: "instantiate_model",
      op_id: "instantiate",
      model: ref,
      id_map: { ASSEMBLY: "COPY", BASE: "COPY_BASE", POST: "COPY_POST" },
      root_placement: world(5, 0, 0),
    }]));
    expect(() => store.apply(workspaceBatch(store, "delete_referenced", [{
      op: "delete_model_definition",
      op_id: "delete",
      model: ref,
      confirm: true,
    }]))).toThrowError(expect.objectContaining({ code: "model_definition_referenced" }));

    const serializer = new WorkspaceProjectSerializer();
    const project = serializer.fromStore("model-project", store);
    const reopened = serializer.openStore(serializer.deserialize(serializer.serialize(project)));
    expect(reopened.getState().modelDefinitions.get("com.semaframe.fixture@1.0.0")).toEqual(definition);
    expect(reopened.getState().components.has("COPY_POST")).toBe(true);
    expect(reopened.undo()).not.toBeNull();
    expect(reopened.getState().components.has("COPY")).toBe(false);
    expect(reopened.getState().modelDefinitions.has("com.semaframe.fixture@1.0.0")).toBe(true);
    expect(reopened.redo()).not.toBeNull();
    expect(reopened.getState().components.has("COPY_POST")).toBe(true);
  });

  it("rejects incomplete maps, digest mismatches, invalid geometry, and duplicate versions atomically", () => {
    const store = authoredModel();
    store.apply(workspaceBatch(store, "publish_fixture", [{
      op: "publish_model",
      op_id: "publish",
      model_id: "com.semaframe.fixture",
      version: "1.0.0",
      display_name: "Fixture",
      root_id: "ASSEMBLY",
    }]));
    const definition = store.getState().modelDefinitions.get("com.semaframe.fixture@1.0.0")!;
    const revision = store.getRevision();
    expect(() => store.apply(workspaceBatch(store, "bad_map", [{
      op: "instantiate_model",
      op_id: "bad",
      model: modelDefinitionRef(definition),
      id_map: { ASSEMBLY: "ONLY_ROOT" },
      root_placement: world(0, 0, 0),
    }]))).toThrowError(expect.objectContaining({ code: "invalid_model_id_map" }));
    expect(() => store.apply(workspaceBatch(store, "bad_digest", [{
      op: "instantiate_model",
      op_id: "bad",
      model: { ...modelDefinitionRef(definition), digest: "forged" },
      id_map: { ASSEMBLY: "A2", BASE: "B2", POST: "P2" },
      root_placement: world(0, 0, 0),
    }]))).toThrowError(expect.objectContaining({ code: "model_digest_mismatch" }));
    expect(() => store.apply(workspaceBatch(store, "duplicate_model", [{
      op: "publish_model",
      op_id: "duplicate",
      model_id: "com.semaframe.fixture",
      version: "1.0.0",
      display_name: "Fixture again",
      root_id: "ASSEMBLY",
    }]))).toThrowError(expect.objectContaining({ code: "duplicate_model_definition" }));
    expect(store.getRevision()).toBe(revision);

    expect(() => store.apply(workspaceBatch(store, "bad_geometry", [{
      op: "update_component",
      op_id: "bad_geometry",
      id: "BASE",
      patch: { props: { geometry: { kind: "capsule", radiusM: 499, cylinderHeightM: 10, axis: "y" } } },
    }]))).toThrowError();
    expect(store.getRevision()).toBe(revision);
  });
});
