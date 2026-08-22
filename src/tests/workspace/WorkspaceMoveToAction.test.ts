import { describe, expect, it } from "vitest";
import { DEFAULT_COMPONENT_REGISTRY } from "../../workspace/components";
import type { JSONObject, Vec3 } from "../../workspace/components/componentTypes";
import {
  WorkspaceProjectSerializer,
  type WorkspaceProjectFile,
} from "../../workspace/persistence";
import type {
  CreateComponentOperation,
  TransitionSpec,
  WorkspaceAuthorization,
  WorkspaceOperation,
} from "../../workspace/protocol";
import {
  toRenderSnapshot,
  workspaceOperationsToSceneOperations,
} from "../../workspace/renderer";
import { buildSemaFrameSpatialGraph } from "../../workspace/spatial";
import { WorkspaceStore } from "../../workspace/state";
import { workspaceBatch } from "./helpers";

type MovableTypeId = "spatial-entity" | "spatial-primitive" | "model-assembly";

const vec = (x: number, y = 0, z = 0): Vec3 => ({ x, y, z });

const placement = (x: number, y = 0, z = 0, scale = vec(1, 1, 1)) => ({
  space: "world3d" as const,
  position: vec(x, y, z),
  rotation: vec(0, 0, 0),
  scale: structuredClone(scale),
});

const moveInput = (position: Vec3, rotation = vec(0, 0, 0)): JSONObject => ({
  target: { space: "world3d", position, rotation },
});

function createStage(): CreateComponentOperation {
  return {
    op: "create_component",
    op_id: "create_stage",
    id: "STAGE",
    component_type: DEFAULT_COMPONENT_REGISTRY.ref("stage-3d"),
    placement: placement(0),
  };
}

function createMovable(
  id: string,
  typeId: MovableTypeId,
  initial: ReturnType<typeof placement>,
  locks: CreateComponentOperation["locks"] = undefined,
): CreateComponentOperation {
  let props: JSONObject;
  if (typeId === "spatial-entity") {
    props = { assetId: "primitive_box", entityKind: "primitive" };
  } else if (typeId === "spatial-primitive") {
    props = { geometry: { kind: "box", sizeM: { x: 0.6, y: 0.6, z: 0.6 } } };
  } else {
    props = { description: "Movable assembly", collisionPolicy: "external_only" };
  }
  return {
    op: "create_component",
    op_id: `create_${id.toLowerCase()}`,
    id,
    component_type: DEFAULT_COMPONENT_REGISTRY.ref(typeId),
    placement: initial,
    props,
    ...(locks ? { locks } : {}),
  };
}

function createButton(id = "BUTTON"): CreateComponentOperation {
  return {
    op: "create_component",
    op_id: `create_${id.toLowerCase()}`,
    id,
    component_type: DEFAULT_COMPONENT_REGISTRY.ref("button"),
    placement: { space: "viewport", anchor: "bottom", offset: { x: 0, y: 0 } },
  };
}

function invokeMove(
  id: string,
  input: JSONObject,
  transition: TransitionSpec = { durationMs: 900, delayMs: 40, easing: "ease_out" },
): WorkspaceOperation {
  return {
    op: "invoke_component_action",
    op_id: `move_${id.toLowerCase()}`,
    id,
    action: "move_to",
    input,
    transition,
  };
}

function connectMove(
  targetId: string,
  input: JSONObject,
  transition: TransitionSpec = { durationMs: 900, easing: "ease_in_out" },
): WorkspaceOperation {
  return {
    op: "connect_event",
    op_id: "connect_move",
    connection: {
      kind: "event_connection",
      id: "EVENT_MOVE",
      sourceComponentId: "BUTTON",
      event: "pressed",
      targetComponentId: targetId,
      action: "move_to",
      input,
      enabled: true,
      transition,
    },
  };
}

function worldPlacement(store: WorkspaceStore, id: string) {
  const value = store.getState().components.get(id)?.placement;
  if (!value || value.space !== "world3d") throw new Error(`Expected ${id} in world3d`);
  return value;
}

describe("event-routable spatial move_to", () => {
  it.each([
    ["spatial-entity", vec(1.5, 1.25, 0.75)],
    ["spatial-primitive", vec(1, 1, 1)],
    ["model-assembly", vec(2, 2, 2)],
  ] as const)("moves a %s to one absolute endpoint, preserves scale, projects, and replays", (typeId, scale) => {
    const store = new WorkspaceStore({ clock: () => 2_000 });
    store.apply(workspaceBatch(store, "setup", [
      createStage(),
      createMovable("TARGET", typeId, placement(-3, 0, 1, scale)),
    ]));

    const targetPosition = vec(3, 0.5, -2);
    const targetRotation = vec(0, 0.75, 0);
    const result = store.applyDetailed(workspaceBatch(store, "move", [
      invokeMove("TARGET", moveInput(targetPosition, targetRotation)),
    ]));

    expect(worldPlacement(store, "TARGET")).toEqual({
      space: "world3d",
      position: targetPosition,
      rotation: targetRotation,
      scale,
    });
    expect(result.command.resolvedOperations[0]).toMatchObject({
      op: "invoke_component_action",
      action: "move_to",
      transition: { durationMs: 900, delayMs: 40, easing: "ease_out" },
    });
    const effect = result.command.resolvedActionEffects?.[0];
    expect(effect).not.toHaveProperty("placement");
    expect(effect?.events).toEqual([{
      id: result.events[0]?.id,
      event: "moved",
      payload: {
        placement: {
          space: "world3d",
          position: targetPosition,
          rotation: targetRotation,
          scale,
        },
      },
    }]);
    expect(result.events[0]).toMatchObject({
      componentId: "TARGET",
      event: "moved",
      source: "user",
    });

    const node = buildSemaFrameSpatialGraph(store.getState()).nodes.find(({ id }) => id === "TARGET");
    expect(node?.worldTransform).toMatchObject({
      position: targetPosition,
      rotationQuaternion: {
        x: 0,
        y: Math.sin(targetRotation.y / 2),
        z: 0,
        w: Math.cos(targetRotation.y / 2),
      },
      scale,
    });

    expect(store.undoUserCommand()).not.toBeNull();
    expect(worldPlacement(store, "TARGET").position).toEqual(vec(-3, 0, 1));
    expect(store.redoUserCommand()).not.toBeNull();
    expect(worldPlacement(store, "TARGET")).toMatchObject({
      position: targetPosition,
      rotation: targetRotation,
      scale,
    });

    const serializer = new WorkspaceProjectSerializer();
    const reopened = serializer.openStore(serializer.deserialize(serializer.serialize(
      serializer.fromStore(`move-${typeId}`, store),
    )));
    expect(worldPlacement(reopened, "TARGET")).toEqual(worldPlacement(store, "TARGET"));
    expect(reopened.getCommandHistory().at(-1)?.resolvedActionEffects)
      .toEqual(store.getCommandHistory().at(-1)?.resolvedActionEffects);
  });

  it("routes a button press to a model assembly with causation and renderer timing", () => {
    const store = new WorkspaceStore({ clock: () => 3_000 });
    store.apply(workspaceBatch(store, "setup", [
      createStage(),
      createButton(),
      createMovable("ASSEMBLY", "model-assembly", placement(-3)),
      createMovable("CHILD", "spatial-primitive", placement(0)),
      {
        op: "attach_component",
        op_id: "attach_child",
        child_id: "CHILD",
        parent_id: "ASSEMBLY",
        transform_mode: "preserve_local",
      },
      connectMove("ASSEMBLY", moveInput(vec(4, 0, 1), vec(0, 0.5, 0))),
    ]));

    const result = store.applyDetailed(workspaceBatch(store, "press", [{
      op: "invoke_component_action",
      op_id: "press_button",
      id: "BUTTON",
      action: "press",
      input: {},
    }]));

    expect(worldPlacement(store, "ASSEMBLY")).toMatchObject({
      position: vec(4, 0, 1),
      rotation: vec(0, 0.5, 0),
    });
    const routed = result.command.resolvedOperations.find((operation) =>
      operation.op === "invoke_component_action" && operation.id === "ASSEMBLY");
    expect(routed).toMatchObject({
      action: "move_to",
      transition: { durationMs: 900, easing: "ease_in_out" },
    });
    expect(result.events.map((event) => [event.event, event.source])).toEqual([
      ["pressed", "user"],
      ["moved", "binding"],
    ]);
    expect(result.command.resolvedActionEffects?.[1]).toMatchObject({
      causedBy: { eventId: result.events[0]?.id, connectionId: "EVENT_MOVE" },
      events: [{ event: "moved" }],
    });

    const sceneOperations = workspaceOperationsToSceneOperations(
      result.command.resolvedOperations,
      toRenderSnapshot(store.getState()),
    );
    expect(sceneOperations).toContainEqual({
      op: "update_entity",
      op_id: `workspace:${routed?.op_id}`,
      id: "ASSEMBLY",
      patch: {},
      visualTiming: { durationMs: 900, startAfterMs: 0, easing: "ease_in_out" },
    });

    const serializer = new WorkspaceProjectSerializer();
    const project = serializer.deserialize(serializer.serialize(
      serializer.fromStore("routed-move", store),
    ));
    const reopened = serializer.openStore(project);
    expect(reopened.getCommandHistory()).toEqual(store.getCommandHistory());
    expect(reopened.getEventHistory()).toEqual(store.getEventHistory());
    expect(worldPlacement(reopened, "ASSEMBLY")).toEqual(worldPlacement(store, "ASSEMBLY"));
    expect(buildSemaFrameSpatialGraph(reopened.getState()).nodes.find(({ id }) => id === "ASSEMBLY")?.worldTransform)
      .toEqual(buildSemaFrameSpatialGraph(store.getState()).nodes.find(({ id }) => id === "ASSEMBLY")?.worldTransform);
  });

  it("requires component:update in addition to component:invoke", () => {
    const store = new WorkspaceStore();
    store.apply(workspaceBatch(store, "setup", [
      createStage(),
      createMovable("TARGET", "spatial-entity", placement(-2)),
    ]));
    const batch = workspaceBatch(store, "move", [invokeMove("TARGET", moveInput(vec(2)))]);
    const invokeOnly: WorkspaceAuthorization = {
      actor: "agent",
      permissions: ["workspace:write", "component:invoke"],
    };
    const revision = store.getRevision();
    expect(() => store.apply(batch, invokeOnly)).toThrow(expect.objectContaining({
      code: "permission_denied",
      permission: "component:update",
    }));
    expect(store.getRevision()).toBe(revision);
    expect(worldPlacement(store, "TARGET").position).toEqual(vec(-2));
  });

  it("rejects placement-locked move routes at connection time without affecting other actions", () => {
    const store = new WorkspaceStore();
    store.apply(workspaceBatch(store, "setup", [
      createStage(),
      createButton(),
      createMovable("TARGET", "model-assembly", placement(0), { placement: true }),
    ]));
    const revision = store.getRevision();
    expect(() => store.apply(workspaceBatch(store, "connect_locked_move", [
      connectMove("TARGET", moveInput(vec(2))),
    ]))).toThrow(expect.objectContaining({ code: "component_locked" }));
    expect(store.getRevision()).toBe(revision);

    expect(() => store.apply(workspaceBatch(store, "connect_visibility", [{
      op: "connect_event",
      op_id: "connect_visibility",
      connection: {
        kind: "event_connection",
        id: "EVENT_VISIBILITY",
        sourceComponentId: "BUTTON",
        event: "pressed",
        targetComponentId: "TARGET",
        action: "toggle_visibility",
        input: {},
        enabled: true,
      },
    }]))).not.toThrow();
  });

  it("rejects a second enabled direct route for the same source event and move target", () => {
    const store = new WorkspaceStore();
    store.apply(workspaceBatch(store, "setup", [
      createStage(),
      createButton(),
      createMovable("TARGET", "spatial-entity", placement(-2)),
      connectMove("TARGET", moveInput(vec(2))),
    ]));
    const revision = store.getRevision();
    expect(() => store.apply(workspaceBatch(store, "duplicate_route", [{
      op: "connect_event",
      op_id: "connect_move_duplicate",
      connection: {
        kind: "event_connection",
        id: "EVENT_MOVE_DUPLICATE",
        sourceComponentId: "BUTTON",
        event: "pressed",
        targetComponentId: "TARGET",
        action: "move_to",
        input: moveInput(vec(3)),
        enabled: true,
      },
    }]))).toThrow(expect.objectContaining({ code: "duplicate_move_route" }));
    expect(store.getRevision()).toBe(revision);
    expect(store.getState().connections.has("EVENT_MOVE_DUPLICATE")).toBe(false);
  });

  it("rejects two explicit move_to endpoints for one component before final-state validation", () => {
    const store = new WorkspaceStore();
    store.apply(workspaceBatch(store, "setup", [
      createStage(),
      createMovable("TARGET", "spatial-entity", placement(-2)),
      createMovable("BLOCKER", "spatial-entity", placement(0)),
    ]));
    const revision = store.getRevision();
    expect(() => store.apply(workspaceBatch(store, "ambiguous_waypoints", [
      invokeMove("TARGET", moveInput(vec(0))),
      { ...invokeMove("TARGET", moveInput(vec(2))), op_id: "move_target_again" },
    ]))).toThrow(expect.objectContaining({ code: "duplicate_move_target" }));
    expect(store.getRevision()).toBe(revision);
    expect(worldPlacement(store, "TARGET").position).toEqual(vec(-2));
    expect(store.getEventHistory()).toEqual([]);
  });

  it("rejects duplicate same-source routed moves at runtime but allows different move targets", () => {
    const source = new WorkspaceStore();
    source.apply(workspaceBatch(source, "setup", [
      createStage(),
      createButton(),
      createMovable("TARGET_A", "spatial-entity", placement(-3)),
      createMovable("TARGET_B", "spatial-entity", placement(3)),
      connectMove("TARGET_A", moveInput(vec(-2))),
    ]));

    const duplicatedState = source.getState();
    const firstRoute = duplicatedState.connections.get("EVENT_MOVE");
    if (!firstRoute || firstRoute.kind !== "event_connection") throw new Error("Expected move route");
    duplicatedState.connections.set("EVENT_MOVE_DUPLICATE", {
      ...structuredClone(firstRoute),
      id: "EVENT_MOVE_DUPLICATE",
      input: moveInput(vec(-1)),
    });
    const duplicated = new WorkspaceStore({ initialState: duplicatedState as never });
    const duplicateRevision = duplicated.getRevision();
    expect(() => duplicated.apply(workspaceBatch(duplicated, "press_duplicate_routes", [{
      op: "invoke_component_action",
      op_id: "press",
      id: "BUTTON",
      action: "press",
      input: {},
    }]))).toThrow(expect.objectContaining({ code: "duplicate_move_target" }));
    expect(duplicated.getRevision()).toBe(duplicateRevision);
    expect(duplicated.getState().components.get("BUTTON")?.durableState.pressCount).toBe(0);
    expect(worldPlacement(duplicated, "TARGET_A").position).toEqual(vec(-3));

    expect(() => source.apply(workspaceBatch(source, "move_distinct_targets", [
      invokeMove("TARGET_A", moveInput(vec(-2))),
      { ...invokeMove("TARGET_B", moveInput(vec(2))), op_id: "move_target_b" },
    ]))).not.toThrow();
    expect(worldPlacement(source, "TARGET_A").position).toEqual(vec(-2));
    expect(worldPlacement(source, "TARGET_B").position).toEqual(vec(2));
  });

  it("rejects invalid targets, endpoint collisions, and missing Stage basis atomically", () => {
    const invalid = new WorkspaceStore();
    invalid.apply(workspaceBatch(invalid, "setup", [
      createStage(),
      createMovable("TARGET", "spatial-entity", placement(-2)),
    ]));
    const invalidRevision = invalid.getRevision();
    expect(() => invalid.apply(workspaceBatch(invalid, "invalid_scale", [invokeMove("TARGET", {
      target: {
        space: "world3d",
        position: vec(2),
        rotation: vec(0),
        scale: vec(2, 2, 2),
      },
    })]))).toThrow(expect.objectContaining({ code: "invalid_action_input" }));
    expect(() => invalid.apply(workspaceBatch(invalid, "out_of_bounds", [
      invokeMove("TARGET", moveInput(vec(1_001))),
    ]))).toThrow(expect.objectContaining({ code: "invalid_action_input" }));
    expect(invalid.getRevision()).toBe(invalidRevision);

    const collision = new WorkspaceStore();
    collision.apply(workspaceBatch(collision, "setup", [
      createStage(),
      createButton(),
      createMovable("TARGET", "spatial-entity", placement(-2)),
      createMovable("BLOCKER", "spatial-entity", placement(2)),
      connectMove("TARGET", moveInput(vec(2))),
    ]));
    const collisionRevision = collision.getRevision();
    expect(() => collision.apply(workspaceBatch(collision, "press", [{
      op: "invoke_component_action",
      op_id: "press",
      id: "BUTTON",
      action: "press",
      input: {},
    }]))).toThrow(expect.objectContaining({ code: "spatial_collision" }));
    expect(collision.getRevision()).toBe(collisionRevision);
    expect(collision.getState().components.get("BUTTON")?.durableState.pressCount).toBe(0);
    expect(worldPlacement(collision, "TARGET").position).toEqual(vec(-2));

    const noStage = new WorkspaceStore();
    noStage.apply(workspaceBatch(noStage, "setup", [
      createStage(),
      createMovable("TARGET", "spatial-entity", placement(-2)),
    ]));
    // Normal APIs protect the Stage while world3d nodes reference it. Mutate the
    // in-memory fixture to prove move_to still defends a corrupted/recovered
    // runtime state instead of relying only on the create/delete invariants.
    const unsafeRuntime = noStage as unknown as {
      state: { components: Map<string, unknown> };
    };
    unsafeRuntime.state.components.delete("STAGE");
    const noStageRevision = noStage.getRevision();
    expect(() => noStage.apply(workspaceBatch(noStage, "move_without_stage", [
      invokeMove("TARGET", moveInput(vec(2))),
    ]))).toThrow(expect.objectContaining({ code: "stage_basis_required" }));
    expect(noStage.getRevision()).toBe(noStageRevision);
  });

  it("validates a moved assembly's descendant colliders at the final endpoint", () => {
    const store = new WorkspaceStore();
    store.apply(workspaceBatch(store, "setup", [
      createStage(),
      createMovable("ASSEMBLY", "model-assembly", placement(-3)),
      createMovable("CHILD", "spatial-primitive", placement(0)),
      {
        op: "attach_component",
        op_id: "attach_child",
        child_id: "CHILD",
        parent_id: "ASSEMBLY",
        transform_mode: "preserve_local",
      },
      createMovable("BLOCKER", "spatial-entity", placement(3)),
    ]));
    const revision = store.getRevision();
    expect(() => store.apply(workspaceBatch(store, "colliding_assembly_endpoint", [
      invokeMove("ASSEMBLY", moveInput(vec(3))),
    ]))).toThrow(expect.objectContaining({ code: "spatial_collision" }));
    expect(store.getRevision()).toBe(revision);
    expect(worldPlacement(store, "ASSEMBLY").position).toEqual(vec(-3));
  });

  it("keeps an attached child's move target local and projects parent times local into SSG", () => {
    const store = new WorkspaceStore();
    const parentRotation = Math.PI / 2;
    store.apply(workspaceBatch(store, "setup", [
      createStage(),
      createMovable("PARENT", "model-assembly", {
        ...placement(5, 0, 2),
        rotation: vec(0, parentRotation, 0),
      }),
      createMovable("CHILD", "spatial-entity", placement(1)),
      {
        op: "attach_component",
        op_id: "attach_child",
        child_id: "CHILD",
        parent_id: "PARENT",
        transform_mode: "preserve_local",
      },
    ]));

    const localPosition = vec(2, 1, 0);
    const localRotation = vec(0, 0.25, 0);
    store.apply(workspaceBatch(store, "move_child_local", [
      invokeMove("CHILD", moveInput(localPosition, localRotation)),
    ]));

    expect(worldPlacement(store, "CHILD")).toEqual({
      space: "world3d",
      position: localPosition,
      rotation: localRotation,
      scale: vec(1, 1, 1),
    });
    const node = buildSemaFrameSpatialGraph(store.getState()).nodes.find(({ id }) => id === "CHILD");
    expect(node?.worldTransform.position.x).toBeCloseTo(5, 10);
    expect(node?.worldTransform.position.y).toBeCloseTo(1, 10);
    expect(node?.worldTransform.position.z).toBeCloseTo(0, 10);
    expect(node?.worldTransform.rotationQuaternion.y)
      .toBeCloseTo(Math.sin((parentRotation + localRotation.y) / 2), 10);
    expect(node?.worldTransform.rotationQuaternion.w)
      .toBeCloseTo(Math.cos((parentRotation + localRotation.y) / 2), 10);
  });

  it("rolls back a move_to endpoint rejected by enforced stability physics", () => {
    const store = new WorkspaceStore();
    const dynamicEnforced = {
      enabled: true,
      bodyType: "dynamic",
      massKg: 10,
      centerOfMass: vec(0),
      friction: 0.6,
      restitution: 0.1,
      gravityScale: 1,
      stabilityMode: "enforce",
      constraints: [],
    };
    store.apply(workspaceBatch(store, "setup", [
      createStage(),
      createMovable("BASE", "spatial-entity", placement(0)),
      {
        ...createMovable("TARGET", "spatial-entity", placement(0, 1.04)),
        props: {
          assetId: "primitive_box",
          entityKind: "primitive",
          physics: dynamicEnforced,
        },
      },
    ]));
    const revision = store.getRevision();
    expect(() => store.apply(workspaceBatch(store, "unsupported_endpoint", [
      invokeMove("TARGET", moveInput(vec(4, 4, 0))),
    ]))).toThrow(expect.objectContaining({ code: "physics_validation_failed" }));
    expect(store.getRevision()).toBe(revision);
    expect(worldPlacement(store, "TARGET").position).toEqual(vec(0, 1.04, 0));
    expect(store.getEventHistory()).toEqual([]);
  });

  it("validates only the endpoint; transition interpolation is not a swept-path query", () => {
    const store = new WorkspaceStore();
    store.apply(workspaceBatch(store, "setup", [
      createStage(),
      createMovable("TARGET", "spatial-entity", placement(-2)),
      createMovable("BLOCKER", "spatial-entity", placement(0)),
    ]));

    expect(() => store.apply(workspaceBatch(store, "move_across_blocker", [
      invokeMove("TARGET", moveInput(vec(2)), { durationMs: 1_200, easing: "linear" }),
    ]))).not.toThrow();
    expect(worldPlacement(store, "TARGET").position).toEqual(vec(2));
  });

  it("fails closed when persisted move_to input, moved effect, or saved endpoint is tampered", () => {
    const store = new WorkspaceStore({ clock: () => 9_000 });
    store.apply(workspaceBatch(store, "setup", [
      createStage(),
      createMovable("TARGET", "spatial-entity", placement(-3, 0, 1, vec(1.5, 1.25, 0.75))),
    ]));
    store.apply(workspaceBatch(store, "move", [
      invokeMove("TARGET", moveInput(vec(3, 0.5, -2), vec(0, 0.75, 0))),
    ]));
    const serializer = new WorkspaceProjectSerializer();
    const project = serializer.fromStore("tampered-move", store);

    const moveCommand = (candidate: WorkspaceProjectFile) => {
      const command = candidate.commandHistory.find(({ requestId }) => requestId === "move");
      if (!command) throw new Error("Expected move command");
      return command;
    };
    const moveEffect = (candidate: WorkspaceProjectFile) => {
      const effect = moveCommand(candidate).resolvedActionEffects?.[0];
      if (!effect) throw new Error("Expected move effect");
      return effect;
    };
    const expectRejected = (candidate: WorkspaceProjectFile) => {
      expect(() => serializer.openStore(serializer.deserialize(candidate))).toThrow();
    };

    const noEffect = structuredClone(project);
    delete moveCommand(noEffect).resolvedActionEffects;
    expectRejected(noEffect);

    const noMovedEvent = structuredClone(project);
    moveEffect(noMovedEvent).events = [];
    expectRejected(noMovedEvent);

    const duplicateMovedEvent = structuredClone(project);
    const duplicate = structuredClone(moveEffect(duplicateMovedEvent).events[0]!);
    duplicate.id = "EVT_DUPLICATE_MOVE";
    moveEffect(duplicateMovedEvent).events.push(duplicate);
    expectRejected(duplicateMovedEvent);

    const malformedMovedEvent = structuredClone(project);
    const malformedPlacement = moveEffect(malformedMovedEvent).events[0]!.payload.placement as JSONObject;
    (malformedPlacement.position as JSONObject).x = "not-a-number";
    expectRejected(malformedMovedEvent);

    const resizedByEffect = structuredClone(project);
    const resizedPlacement = moveEffect(resizedByEffect).events[0]!.payload.placement as JSONObject;
    resizedPlacement.scale = vec(2, 2, 2) as unknown as JSONObject;
    expectRejected(resizedByEffect);

    const mismatchedInput = structuredClone(project);
    const operation = moveCommand(mismatchedInput).resolvedOperations.find(({ op }) =>
      op === "invoke_component_action");
    if (!operation || operation.op !== "invoke_component_action") throw new Error("Expected move operation");
    operation.input = moveInput(vec(4, 0.5, -2), vec(0, 0.75, 0));
    expectRejected(mismatchedInput);

    const savedStateOnly = structuredClone(project);
    const savedTarget = savedStateOnly.workspace.components.find(([id]) => id === "TARGET")?.[1];
    if (!savedTarget || savedTarget.placement.space !== "world3d") throw new Error("Expected saved target");
    savedTarget.placement.position = vec(4, 0.5, -2);
    expectRejected(savedStateOnly);
  });
});
