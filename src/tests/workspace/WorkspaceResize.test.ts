import { describe, expect, it } from "vitest";
import {
  DEFAULT_COMPONENT_LOCKS,
  DEFAULT_COMPONENT_REGISTRY,
  type ComponentInstance,
} from "../../workspace/components";
import {
  LEGACY_WORKSPACE_PROTOCOL_VERSION,
  prepareComponentRecipe,
  WORKSPACE_PROTOCOL_VERSION,
  type WorkspaceCommandBatch,
  type WorkspaceOperation,
} from "../../workspace/protocol";
import { WorkspaceStoreEngineAdapter } from "../../workspace/agents/WorkspaceStoreEngineAdapter";
import { WorkspaceProjectSerializer } from "../../workspace/persistence";
import { ProjectionBridge } from "../../workspace/renderer/ProjectionBridge";
import { toRenderSnapshot } from "../../workspace/renderer/contracts";
import {
  createInitialWorkspace,
  WorkspacePermissionError,
  WorkspaceStore,
} from "../../workspace/state";

function batch(
  store: WorkspaceStore,
  requestId: string,
  operations: WorkspaceOperation[],
): WorkspaceCommandBatch {
  return {
    protocol_version: WORKSPACE_PROTOCOL_VERSION,
    request_id: requestId,
    workspace_id: store.getState().workspaceId,
    input_revision: store.getRevision(),
    base_workspace_revision: store.getRevision(),
    registry_digest: store.getRegistryDigest(),
    mode: "commit",
    operations,
  };
}

function viewportTimer(id = "CMP_000001", locks = {}) {
  return {
    op: "create_component" as const,
    op_id: `create_${id}`,
    id,
    component_type: DEFAULT_COMPONENT_REGISTRY.ref("timer"),
    placement: { space: "viewport" as const, anchor: "center" as const, offset: { x: 0, y: 0 } },
    locks,
  };
}

const worldPlacement = {
  space: "world3d" as const,
  position: { x: 0, y: 0, z: 0 },
  rotation: { x: 0, y: 0, z: 0 },
  scale: { x: 1, y: 1, z: 1 },
};

function stage(id = "CMP_000010") {
  return {
    op: "create_component" as const,
    op_id: `create_${id}`,
    id,
    component_type: DEFAULT_COMPONENT_REGISTRY.ref("stage-3d"),
    placement: structuredClone(worldPlacement),
  };
}

describe("Workspace Protocol 1.1 resize_component", () => {
  it("materializes explicit defaults and commits an absolute 2D resize as one undoable revision", () => {
    const store = new WorkspaceStore();
    store.apply(batch(store, "create_timer", [viewportTimer()]));
    expect(store.getState().components.get("CMP_000001")?.placement).toMatchObject({
      size: { width: 210, height: 112 },
    });

    const resize = batch(store, "resize_timer", [{
      op: "resize_component",
      op_id: "resize_timer",
      id: "CMP_000001",
      resize: { kind: "box2d", size: { width: 420, height: 224 } },
    }]);
    const first = store.applyDetailed(resize);
    const retry = store.applyDetailed(resize);
    expect(first.deduplicated).toBe(false);
    expect(retry.deduplicated).toBe(true);
    expect(store.getRevision()).toBe(2);
    expect(store.getState().components.get("CMP_000001")?.placement.size)
      .toEqual({ width: 420, height: 224 });

    store.undo();
    expect(store.getState().components.get("CMP_000001")?.placement.size)
      .toEqual({ width: 210, height: 112 });
    store.redo();
    expect(store.getState().components.get("CMP_000001")?.placement.size)
      .toEqual({ width: 420, height: 224 });
  });

  it("enforces resize kind, bounds and aspect constraints without mutation", () => {
    const store = new WorkspaceStore();
    store.apply(batch(store, "create_video", [{
      op: "create_component",
      op_id: "create_video",
      id: "CMP_000001",
      component_type: DEFAULT_COMPONENT_REGISTRY.ref("video-player"),
      placement: { space: "viewport", anchor: "center", offset: { x: 0, y: 0 } },
    }]));

    for (const [requestId, resize] of [
      ["wrong_kind", { kind: "scale3d", scale: { x: 2, y: 2, z: 2 } }],
      ["too_small", { kind: "box2d", size: { width: 40, height: 40 } }],
      ["bad_ratio", { kind: "box2d", size: { width: 640, height: 360 } }],
    ] as const) {
      expect(() => store.apply(batch(store, requestId, [{
        op: "resize_component", op_id: requestId, id: "CMP_000001", resize,
      }]))).toThrow();
      expect(store.getRevision()).toBe(1);
    }

    store.apply(batch(store, "valid_ratio", [{
      op: "resize_component",
      op_id: "valid_ratio",
      id: "CMP_000001",
      resize: { kind: "box2d", size: { width: 640, height: 408 } },
    }]));
    expect(store.getState().components.get("CMP_000001")?.placement.size)
      .toEqual({ width: 640, height: 408 });
  });

  it("resizes free 3D scale and Stage dimensions through their canonical representations", () => {
    const store = new WorkspaceStore();
    store.apply(batch(store, "create_world", [
      stage(),
      {
        op: "create_component",
        op_id: "create_spatial",
        id: "CMP_000011",
        component_type: DEFAULT_COMPONENT_REGISTRY.ref("spatial-entity"),
        placement: structuredClone(worldPlacement),
      },
    ]));
    expect(store.getState().components.get("CMP_000010")?.props.dimensions)
      .toEqual({ width: 12, height: 4, depth: 10 });

    store.apply(batch(store, "resize_world", [{
      op: "resize_component",
      op_id: "scale",
      id: "CMP_000011",
      resize: { kind: "scale3d", scale: { x: 2, y: 1.5, z: 0.5 } },
    }, {
      op: "resize_component",
      op_id: "stage_dimensions",
      id: "CMP_000010",
      resize: { kind: "stage_dimensions", dimensions: { width: 24, height: 8, depth: 20 } },
    }]));
    expect(store.getState().components.get("CMP_000011")?.placement).toMatchObject({
      scale: { x: 2, y: 1.5, z: 0.5 },
    });
    expect(store.getState().components.get("CMP_000010")?.props.dimensions)
      .toEqual({ width: 24, height: 8, depth: 20 });
  });

  it("prevents placement/update/binding bypasses and honors both placement and resize locks", () => {
    const store = new WorkspaceStore();
    store.apply(batch(store, "create_locked", [
      viewportTimer("CMP_000001", { resize: true }),
      viewportTimer("CMP_000002", { placement: true }),
      stage(),
      {
        op: "upsert_resource",
        op_id: "resource",
        resource: {
          id: "RES_dimensions", label: "Dimensions", connectorType: "inline-json", connectorVersion: "1",
          outputSchema: { type: "object" }, config: {}, policy: { mode: "manual", offline: "keep_last_good" },
          status: "ready",
        },
      },
    ]));

    for (const id of ["CMP_000001", "CMP_000002"]) {
      expect(() => store.apply(batch(store, `resize_${id}`, [{
        op: "resize_component",
        op_id: `resize_${id}`,
        id,
        resize: { kind: "box2d", size: { width: 420, height: 224 } },
      }]))).toThrow(/locked/i);
    }
    expect(() => store.apply(batch(store, "place_size_bypass", [{
      op: "place_component",
      op_id: "place_size_bypass",
      id: "CMP_000001",
      placement: {
        space: "viewport", anchor: "top_left", offset: { x: 10, y: 10 },
        size: { width: 420, height: 224 },
      },
    }]))).toThrow(/locked/i);
    expect(() => store.apply(batch(store, "update_stage_bypass", [{
      op: "update_component",
      op_id: "update_stage_bypass",
      id: "CMP_000010",
      patch: { props: { dimensions: { width: 20, height: 5, depth: 20 } } },
    }]))).toThrow(/resize_component/i);
    expect(() => store.apply(batch(store, "bind_stage_bypass", [{
      op: "bind_resource",
      op_id: "bind_stage_bypass",
      binding: {
        kind: "resource_binding", id: "BIND_dimensions", resourceId: "RES_dimensions",
        componentId: "CMP_000010", targetProp: "dimensions", mode: "snapshot",
        transform: { kind: "identity" }, enabled: true,
      },
    }]))).toThrow(/cannot be changed by a resource binding/i);

    const unlocked = new WorkspaceStore();
    unlocked.apply(batch(unlocked, "create_unlocked", [viewportTimer()]));
    expect(() => unlocked.apply(batch(unlocked, "place_resize_bypass", [{
      op: "place_component",
      op_id: "place_resize_bypass",
      id: "CMP_000001",
      placement: {
        space: "viewport", anchor: "top_left", offset: { x: 10, y: 10 },
        size: { width: 420, height: 224 },
      },
    }]))).toThrow(/must use resize_component/i);
  });

  it("keeps fixed-policy geometry immutable while allowing ordinary moves and prop updates", () => {
    const store = new WorkspaceStore();
    const recipe = prepareComponentRecipe({
      typeId: "recipe.fixed-card",
      version: "1.1.0",
      displayName: "Fixed card",
      allowedPlacements: ["viewport"],
      resizePolicy: { viewport: { kind: "none", mode: "none" } },
      propsSchema: {
        type: "object",
        additionalProperties: false,
        properties: { width: { type: "number" }, height: { type: "number" } },
      },
      durableStateSchema: { type: "object", additionalProperties: false },
      defaultProps: { width: 200, height: 100 },
      defaultDurableState: {},
      writableProps: ["width", "height"],
      actions: {},
      events: {},
      root: { id: "root", primitive: "stack" },
    });
    store.apply(batch(store, "create_fixed", [{
      op: "define_component_recipe", op_id: "define", recipe,
    }, {
      op: "create_component", op_id: "create", id: "CMP_000001",
      component_type: { typeId: recipe.typeId, version: recipe.version, digest: recipe.digest },
      placement: {
        space: "viewport", anchor: "center", offset: { x: 0, y: 0 },
        size: { width: 200, height: 100 },
      },
    }]));

    store.apply(batch(store, "update_fixed_props", [{
      op: "update_component", op_id: "update", id: "CMP_000001",
      patch: { props: { width: 800, height: 400 } },
    }, {
      op: "place_component", op_id: "move", id: "CMP_000001",
      placement: { space: "viewport", anchor: "top_left", offset: { x: 12, y: 18 } },
    }]));
    expect(store.getState().components.get("CMP_000001")).toMatchObject({
      props: { width: 800, height: 400 },
      placement: { size: { width: 200, height: 100 }, offset: { x: 12, y: 18 } },
    });

    expect(() => store.apply(batch(store, "fixed_place_bypass", [{
      op: "place_component", op_id: "place", id: "CMP_000001",
      placement: {
        space: "viewport", anchor: "center", offset: { x: 0, y: 0 },
        size: { width: 400, height: 200 },
      },
    }]))).toThrow(/fixed component geometry/i);
    expect(() => store.apply(batch(store, "fixed_resize", [{
      op: "resize_component", op_id: "resize", id: "CMP_000001",
      resize: { kind: "box2d", size: { width: 400, height: 200 } },
    }]))).toThrow(/not resizable/i);
  });

  it("rejects every noncanonical raw size and world-scale geometry lane", () => {
    const store = new WorkspaceStore();
    store.apply(batch(store, "create_world_geometry", [
      stage(),
      {
        op: "create_component", op_id: "create_image", id: "CMP_000011",
        component_type: DEFAULT_COMPONENT_REGISTRY.ref("image"),
        placement: {
          ...structuredClone(worldPlacement),
          size: { width: 320, height: 220 },
        },
        locks: { resize: true },
      },
      {
        op: "create_component", op_id: "create_spatial", id: "CMP_000012",
        component_type: DEFAULT_COMPONENT_REGISTRY.ref("spatial-entity"),
        placement: structuredClone(worldPlacement),
        locks: { resize: true },
      },
    ]));

    expect(() => store.apply(batch(store, "box_scale_bypass", [{
      op: "place_component", op_id: "place", id: "CMP_000011",
      placement: {
        ...structuredClone(worldPlacement),
        position: { x: 2, y: 0, z: 0 },
        scale: { x: 2, y: 2, z: 2 },
        size: { width: 320, height: 220 },
      },
    }]))).toThrow(/resize is locked/i);
    expect(() => store.apply(batch(store, "scale_size_bypass", [{
      op: "place_component", op_id: "place", id: "CMP_000012",
      placement: {
        ...structuredClone(worldPlacement),
        position: { x: 3, y: 0, z: 0 },
        size: { width: 400, height: 200 },
      },
    }]))).toThrow(/resize is locked/i);

    expect(() => store.apply(batch(store, "invalid_box_create", [{
      op: "create_component", op_id: "create", id: "CMP_000013",
      component_type: DEFAULT_COMPONENT_REGISTRY.ref("image"),
      placement: {
        ...structuredClone(worldPlacement),
        scale: { x: 2, y: 2, z: 2 },
      },
    }]))).toThrow(/must keep world3d placement scale at identity/i);
    expect(() => store.apply(batch(store, "invalid_scale_create", [{
      op: "create_component", op_id: "create", id: "CMP_000014",
      component_type: DEFAULT_COMPONENT_REGISTRY.ref("spatial-entity"),
      placement: {
        ...structuredClone(worldPlacement),
        size: { width: 100, height: 100 },
      },
    }]))).toThrow(/cannot carry an independent placement size/i);

    const fixedRecipe = prepareComponentRecipe({
      typeId: "recipe.fixed-world",
      version: "1.1.0",
      displayName: "Fixed world overlay",
      allowedPlacements: ["world3d"],
      resizePolicy: { world3d: { kind: "none", mode: "none" } },
      propsSchema: { type: "object", additionalProperties: false },
      durableStateSchema: { type: "object", additionalProperties: false },
      defaultProps: {}, defaultDurableState: {}, writableProps: [], actions: {}, events: {},
      root: { id: "root", primitive: "stack" },
    });
    store.apply(batch(store, "create_fixed_world", [{
      op: "define_component_recipe", op_id: "define", recipe: fixedRecipe,
    }, {
      op: "create_component", op_id: "create", id: "CMP_000015",
      component_type: {
        typeId: fixedRecipe.typeId, version: fixedRecipe.version, digest: fixedRecipe.digest,
      },
      placement: {
        ...structuredClone(worldPlacement),
        size: { width: 180, height: 90 },
      },
    }]));
    expect(() => store.apply(batch(store, "fixed_scale_bypass", [{
      op: "place_component", op_id: "place", id: "CMP_000015",
      placement: {
        ...structuredClone(worldPlacement),
        scale: { x: 1.5, y: 1.5, z: 1.5 },
        size: { width: 180, height: 90 },
      },
    }]))).toThrow(/fixed component geometry/i);

    const corrupt = store.getState() as ReturnType<WorkspaceStore["getState"]> & {
      components: Map<string, ComponentInstance>;
    };
    corrupt.components.get("CMP_000012")!.placement.size = { width: 10, height: 10 };
    expect(() => new WorkspaceStore({ initialState: corrupt })).toThrow(/independent placement size/i);
  });

  it("makes cross-placement policy transitions deterministic, undoable, and resize-lock protected", () => {
    const store = new WorkspaceStore();
    const recipe = prepareComponentRecipe({
      typeId: "recipe.hybrid-policy",
      version: "1.1.0",
      displayName: "Hybrid policy",
      allowedPlacements: ["viewport", "canvas2d"],
      resizePolicy: {
        viewport: {
          kind: "box2d", mode: "free",
          defaultSize: { width: 200, height: 100 },
          minSize: { width: 1, height: 1 },
          maxSize: { width: 4_096, height: 4_096 },
          allowedAxes: ["width", "height"], units: "px",
        },
        canvas2d: { kind: "none", mode: "none" },
      },
      propsSchema: { type: "object", additionalProperties: false },
      durableStateSchema: { type: "object", additionalProperties: false },
      defaultProps: {}, defaultDurableState: {}, writableProps: [], actions: {}, events: {},
      root: { id: "root", primitive: "stack" },
    });
    store.apply(batch(store, "create_hybrid", [{
      op: "define_component_recipe", op_id: "define", recipe,
    }, {
      op: "create_component", op_id: "create", id: "CMP_000001",
      component_type: { typeId: recipe.typeId, version: recipe.version, digest: recipe.digest },
      placement: {
        space: "viewport", anchor: "center", offset: { x: 0, y: 0 },
        size: { width: 300, height: 150 },
      },
    }]));
    store.apply(batch(store, "freeze_on_canvas", [{
      op: "place_component", op_id: "place", id: "CMP_000001",
      placement: { space: "canvas2d", position: { x: 20, y: 30 } },
    }]));
    expect(store.getState().components.get("CMP_000001")?.placement)
      .toMatchObject({ space: "canvas2d", size: { width: 300, height: 150 } });
    store.undo();
    expect(store.getState().components.get("CMP_000001")?.placement.space).toBe("viewport");
    store.redo();
    expect(store.getState().components.get("CMP_000001")?.placement.space).toBe("canvas2d");

    expect(() => store.apply(batch(store, "mutate_frozen", [{
      op: "place_component", op_id: "place", id: "CMP_000001",
      placement: {
        space: "canvas2d", position: { x: 40, y: 50 }, size: { width: 400, height: 200 },
      },
    }]))).toThrow(/fixed component geometry/i);

    expect(() => store.apply(batch(store, "place_cannot_resize_transition", [{
      op: "place_component", op_id: "place", id: "CMP_000001",
      placement: {
        space: "viewport", anchor: "center", offset: { x: 0, y: 0 },
        size: { width: 350, height: 175 },
      },
    }]))).toThrow(/target default or frozen geometry/i);

    store.apply(batch(store, "return_to_box", [{
      op: "place_component", op_id: "place", id: "CMP_000001",
      placement: { space: "viewport", anchor: "center", offset: { x: 0, y: 0 } },
    }, {
      op: "resize_component", op_id: "resize", id: "CMP_000001",
      resize: { kind: "box2d", size: { width: 350, height: 175 } },
    }]));
    expect(store.getState().components.get("CMP_000001")?.placement.size)
      .toEqual({ width: 350, height: 175 });
    store.apply(batch(store, "lock_resize", [{
      op: "update_component", op_id: "lock", id: "CMP_000001",
      patch: { locks: { resize: true } },
    }]));
    expect(() => store.apply(batch(store, "locked_policy_transition", [{
      op: "place_component", op_id: "place", id: "CMP_000001",
      placement: {
        space: "canvas2d", position: { x: 0, y: 0 }, size: { width: 350, height: 175 },
      },
    }]))).toThrow(/resize is locked/i);
  });

  it("uses the 1px host floor for recipes without an explicit resize policy", () => {
    const store = new WorkspaceStore();
    const recipe = prepareComponentRecipe({
      typeId: "recipe.legacy-sized",
      version: "1.0.0",
      displayName: "Legacy sized",
      allowedPlacements: ["viewport"],
      propsSchema: { type: "object", additionalProperties: false },
      durableStateSchema: { type: "object", additionalProperties: false },
      defaultProps: {}, defaultDurableState: {}, writableProps: [], actions: {}, events: {},
      root: { id: "root", primitive: "stack" },
    });
    store.apply(batch(store, "small_legacy_recipe", [{
      op: "define_component_recipe", op_id: "define", recipe,
    }, {
      op: "create_component", op_id: "create", id: "CMP_000001",
      component_type: { typeId: recipe.typeId, version: recipe.version, digest: recipe.digest },
      placement: {
        space: "viewport", anchor: "center", offset: { x: 0, y: 0 },
        size: { width: 8, height: 9 },
      },
    }]));
    expect(store.getState().components.get("CMP_000001")?.placement.size)
      .toEqual({ width: 8, height: 9 });
  });

  it("materializes fixed declarative geometry across inspection, projection, and replay", async () => {
    const store = new WorkspaceStore();
    const recipe = prepareComponentRecipe({
      typeId: "recipe.fixed-card",
      version: "1.1.0",
      displayName: "Fixed card",
      allowedPlacements: ["viewport"],
      resizePolicy: { viewport: { kind: "none", mode: "none" } },
      propsSchema: { type: "object", additionalProperties: false },
      durableStateSchema: { type: "object", additionalProperties: false },
      defaultProps: {}, defaultDurableState: {}, writableProps: [], actions: {}, events: {},
      root: { id: "root", primitive: "stack" },
    });
    store.apply(batch(store, "create_fixed_recipe", [{
      op: "define_component_recipe", op_id: "define", recipe,
    }, {
      op: "create_component", op_id: "create_default", id: "CMP_000030",
      component_type: { typeId: recipe.typeId, version: recipe.version, digest: recipe.digest },
      placement: { space: "viewport", anchor: "center", offset: { x: 0, y: 0 } },
    }, {
      op: "create_component", op_id: "create_authored", id: "CMP_000031",
      component_type: { typeId: recipe.typeId, version: recipe.version, digest: recipe.digest },
      placement: {
        space: "viewport", anchor: "top_left", offset: { x: 10, y: 12 },
        size: { width: 333, height: 111 },
      },
    }]));

    expect(store.getState().components.get("CMP_000030")?.placement.size)
      .toEqual({ width: 240, height: 144 });
    expect(store.getState().components.get("CMP_000031")?.placement.size)
      .toEqual({ width: 333, height: 111 });

    const inspection = await new WorkspaceStoreEngineAdapter(store).inspectComponent(
      "CMP_000030",
      {
        sessionId: "fixed_recipe_session",
        clientId: "fixed_recipe_client",
        clientName: "Fixed recipe test",
        scopes: ["workspace:read"],
      },
    );
    expect(inspection.component).toMatchObject({
      placement: { size: { width: 240, height: 144 } },
    });
    expect(inspection.activeResizePolicy).toEqual({ kind: "none", mode: "none" });

    const renderSnapshot = toRenderSnapshot(store.getState());
    const rendered = renderSnapshot.components.find(({ id }) => id === "CMP_000030");
    if (!rendered) throw new Error("Missing fixed recipe render component");
    const projection = new ProjectionBridge();
    projection.setViewport({ width: 800, height: 600 });
    projection.setComponents(renderSnapshot.components);
    expect(projection.project(rendered)).toMatchObject({ width: 240, height: 144 });

    const serializer = new WorkspaceProjectSerializer();
    const project = serializer.fromStore("fixed_recipe_replay", store);
    const reopened = serializer.openStore(serializer.deserialize(serializer.serialize(project)));
    expect(reopened.getState().components.get("CMP_000030")?.placement.size)
      .toEqual({ width: 240, height: 144 });
    expect(reopened.getState().components.get("CMP_000031")?.placement.size)
      .toEqual({ width: 333, height: 111 });

    // Projects written by the early 1.1 engine relied on the renderer's
    // implicit fixed-recipe box. Opening them now persists the same geometry
    // before replay verification.
    const implicit = structuredClone(project) as any;
    delete implicit.workspace.components
      .find(([, component]: any[]) => component.id === "CMP_000030")[1].placement.size;
    const reopenedImplicit = serializer.openStore(serializer.deserialize(implicit));
    expect(reopenedImplicit.getState().components.get("CMP_000030")?.placement.size)
      .toEqual({ width: 240, height: 144 });
  }, 20_000);

  it("treats resize axes as an unordered policy set during placement moves", () => {
    const store = new WorkspaceStore();
    const box = (allowedAxes: Array<"width" | "height">) => ({
      kind: "box2d" as const,
      mode: "free" as const,
      defaultSize: { width: 200, height: 100 },
      minSize: { width: 1, height: 1 },
      maxSize: { width: 4_096, height: 4_096 },
      allowedAxes,
      units: "px" as const,
    });
    const recipe = prepareComponentRecipe({
      typeId: "recipe.axis-order",
      version: "1.1.0",
      displayName: "Axis order",
      allowedPlacements: ["viewport", "canvas2d"],
      resizePolicy: {
        viewport: box(["width", "height"]),
        canvas2d: box(["height", "width"]),
      },
      propsSchema: { type: "object", additionalProperties: false },
      durableStateSchema: { type: "object", additionalProperties: false },
      defaultProps: {}, defaultDurableState: {}, writableProps: [], actions: {}, events: {},
      root: { id: "root", primitive: "stack" },
    });
    store.apply(batch(store, "create_axis_order", [{
      op: "define_component_recipe", op_id: "define", recipe,
    }, {
      op: "create_component", op_id: "create", id: "CMP_000040",
      component_type: { typeId: recipe.typeId, version: recipe.version, digest: recipe.digest },
      placement: {
        space: "viewport", anchor: "center", offset: { x: 0, y: 0 },
        size: { width: 333, height: 177 },
      },
      locks: { resize: true },
    }]));
    store.apply(batch(store, "move_axis_order", [{
      op: "place_component", op_id: "place", id: "CMP_000040",
      placement: {
        space: "canvas2d", position: { x: 12, y: 18 },
        size: { width: 333, height: 177 },
      },
    }]));
    expect(store.getState().components.get("CMP_000040")?.placement).toEqual({
      space: "canvas2d", position: { x: 12, y: 18 }, size: { width: 333, height: 177 },
    });
  });

  it("requires component:update and keeps Protocol 1.0 non-resize batches compatible", () => {
    const store = new WorkspaceStore();
    store.apply(batch(store, "create", [viewportTimer()]));
    const resizeBatch = batch(store, "unauthorized", [{
      op: "resize_component",
      op_id: "unauthorized",
      id: "CMP_000001",
      resize: { kind: "box2d", size: { width: 420, height: 224 } },
    }]);
    expect(() => store.apply(resizeBatch, {
      actor: "agent",
      permissions: ["workspace:write"],
    })).toThrow(WorkspacePermissionError);

    const legacy = {
      ...batch(store, "legacy_view", [{
        op: "present_view", op_id: "view", view: { id: "VIEW_1", label: "Legacy", componentIds: [] },
      }]),
      protocol_version: LEGACY_WORKSPACE_PROTOCOL_VERSION,
    };
    expect(() => store.apply(legacy)).not.toThrow();
    expect(() => store.apply({
      ...batch(store, "legacy_resize", [{
        op: "resize_component", op_id: "legacy_resize", id: "CMP_000001",
        resize: { kind: "box2d", size: { width: 420, height: 224 } },
      }]),
      protocol_version: LEGACY_WORKSPACE_PROTOCOL_VERSION,
    })).toThrow(/requires Workspace Protocol 1.1/i);
  });

  it("supports bounded declarative policies, including uniform and allowed-axis constraints", () => {
    const store = new WorkspaceStore();
    const recipe = prepareComponentRecipe({
      typeId: "recipe.axis-card",
      version: "1.1.0",
      displayName: "Axis card",
      allowedPlacements: ["viewport"],
      resizePolicy: {
        viewport: {
          kind: "box2d",
          mode: "free",
          defaultSize: { width: 200, height: 100 },
          minSize: { width: 100, height: 100 },
          maxSize: { width: 800, height: 400 },
          allowedAxes: ["width"],
          units: "px",
        },
      },
      propsSchema: { type: "object", additionalProperties: false },
      durableStateSchema: { type: "object", additionalProperties: false },
      defaultProps: {},
      defaultDurableState: {},
      writableProps: [],
      actions: {},
      events: {},
      root: { id: "root", primitive: "stack" },
    });
    store.apply(batch(store, "define_recipe", [{
      op: "define_component_recipe", op_id: "define", recipe,
    }, {
      op: "create_component", op_id: "create", id: "CMP_000001",
      component_type: { typeId: recipe.typeId, version: recipe.version, digest: recipe.digest },
      placement: { space: "viewport", anchor: "center", offset: { x: 0, y: 0 } },
    }]));
    expect(store.getState().components.get("CMP_000001")?.placement.size)
      .toEqual({ width: 200, height: 100 });
    expect(() => store.apply(batch(store, "height_forbidden", [{
      op: "resize_component", op_id: "height", id: "CMP_000001",
      resize: { kind: "box2d", size: { width: 300, height: 150 } },
    }]))).toThrow(/axis height/i);
    store.apply(batch(store, "width_only", [{
      op: "resize_component", op_id: "width", id: "CMP_000001",
      resize: { kind: "box2d", size: { width: 300, height: 100 } },
    }]));
    expect(store.getState().components.get("CMP_000001")?.placement.size)
      .toEqual({ width: 300, height: 100 });
  });

  it("migrates a pinned 1.0 component without rewriting its ref and rejects corrupt scale", () => {
    const legacy = createInitialWorkspace();
    legacy.protocolVersion = "1.0";
    legacy.workspaceSchemaVersion = "1.0";
    legacy.registryDigest = "legacy-registry";
    const manifest = DEFAULT_COMPONENT_REGISTRY.require("timer", "1.0.0");
    legacy.components.set("CMP_000001", {
      id: "CMP_000001",
      type: { typeId: manifest.typeId, version: manifest.version, digest: manifest.digest },
      label: "Legacy timer",
      props: structuredClone(manifest.defaultProps),
      durableState: structuredClone(manifest.defaultDurableState),
      placement: { space: "viewport", anchor: "center", offset: { x: 0, y: 0 } },
      bindings: [],
      tags: [],
      visibility: "visible",
      locks: { placement: false, props: false, deletion: false, actions: false } as never,
      provenance: { createdRevision: 0, createdBy: "migration" },
    });
    const migrated = new WorkspaceStore({ initialState: legacy });
    expect(migrated.getState()).toMatchObject({
      protocolVersion: "1.2",
      workspaceSchemaVersion: "1.2",
    });
    expect(migrated.getState().components.get("CMP_000001")).toMatchObject({
      type: { version: "1.0.0" },
      locks: { resize: false },
      placement: { size: { width: 210, height: 112 } },
    });

    const corrupt = createInitialWorkspace();
    const spatial = DEFAULT_COMPONENT_REGISTRY.require("spatial-entity");
    const stageManifest = DEFAULT_COMPONENT_REGISTRY.require("stage-3d");
    corrupt.components.set("CMP_000010", {
      id: "CMP_000010", type: DEFAULT_COMPONENT_REGISTRY.ref("stage-3d"), label: "Stage",
      props: structuredClone(stageManifest.defaultProps), durableState: {}, placement: structuredClone(worldPlacement),
      bindings: [], tags: [], visibility: "visible", locks: structuredClone(DEFAULT_COMPONENT_LOCKS),
      provenance: { createdRevision: 0, createdBy: "migration" },
    });
    corrupt.components.set("CMP_000011", {
      id: "CMP_000011", type: DEFAULT_COMPONENT_REGISTRY.ref("spatial-entity"), label: "Bad",
      props: structuredClone(spatial.defaultProps), durableState: {},
      placement: { ...structuredClone(worldPlacement), scale: { x: 0, y: 1, z: 1 } },
      bindings: [], tags: [], visibility: "visible", locks: structuredClone(DEFAULT_COMPONENT_LOCKS),
      provenance: { createdRevision: 0, createdBy: "migration" },
    } satisfies ComponentInstance);
    expect(() => new WorkspaceStore({ initialState: corrupt })).toThrow(/scale\.x/i);
  });
});
