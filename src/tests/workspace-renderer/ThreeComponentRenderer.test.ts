import { describe, expect, it, vi } from "vitest";
import { Box3, Group, LineSegments, Vector3 } from "three";
import type { SceneDelta, SceneOperation, SceneState } from "../../renderer/sceneRenderTypes";
import {
  createEnvironment,
  MAX_STAGE_GRID_DIVISIONS,
} from "../../renderer/environmentPresets";
import {
  isEntityVisuallyPresent,
  reparentPreservingWorldTransform,
  shouldScheduleTransformTween,
} from "../../renderer/ThreeRenderer";
import { DEFAULT_COMPONENT_REGISTRY } from "../../workspace/components";
import {
  EMPTY_WORKSPACE_ENVIRONMENT_PRESET,
  ThreeComponentRenderer,
  workspaceOperationsToSceneOperations,
  workspaceToSceneState,
  type ThreeRendererPort,
} from "../../workspace/renderer/ThreeComponentRenderer";
import { toRenderSnapshot, type WorkspaceRenderSnapshot } from "../../workspace/renderer/contracts";
import { WorkspaceStore } from "../../workspace/state";
import { workspaceBatch } from "../workspace/helpers";

describe("ThreeComponentRenderer", () => {
  it("renders a stage-free workspace with no implicit ground, grid, or spatial entities", () => {
    const emptyScene = workspaceToSceneState({
      workspaceId: "empty",
      revision: 0,
      components: [],
    });
    expect(emptyScene.environment.preset).toBe(EMPTY_WORKSPACE_ENVIRONMENT_PRESET);
    expect(emptyScene.entities.size).toBe(0);
    const environment = createEnvironment(emptyScene.environment);
    expect(environment.root.children).toEqual([]);

    const full = snapshot();
    const malformed = {
      ...full,
      components: full.components.filter((component) => component.type.typeId !== "stage-3d"),
    };
    expect(workspaceToSceneState(malformed).entities.size).toBe(0);
  });

  it("delegates spatial entities while leaving UI components in the overlay", () => {
    const scene = workspaceToSceneState(snapshot());
    expect([...scene.entities.keys()]).toEqual(["desk"]);
    expect(scene.entities.get("desk")).toMatchObject({
      id: "desk",
      assetId: "primitive_box",
      kind: "prop",
      transform: { position: { x: 1, y: 0, z: 2 } },
    });
    expect(scene.environment.preset).toBe("simple_room");
  });

  it("projects exact parametric primitives and transform-only model assemblies", () => {
    const source = snapshot();
    const scene = workspaceToSceneState({
      ...source,
      components: [
        source.components[0]!,
        {
          id: "assembly",
          type: { typeId: "model-assembly", version: "1.0.0", digest: "assembly" },
          label: "Assembly",
          props: { description: "fixture", collisionPolicy: "external_only" },
          durableState: {},
          placement: { space: "world3d", position: { x: 2, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0 }, scale: { x: 1, y: 1, z: 1 } },
          tags: [],
          visibility: "visible",
          locks: { placement: false },
        },
        {
          id: "primitive",
          type: { typeId: "spatial-primitive", version: "1.0.0", digest: "primitive" },
          label: "Exact box",
          props: {
            geometry: { kind: "box", sizeM: { x: 1.2, y: 0.4, z: 2.5 } },
            material: { baseColor: "#123456", metallic: 0.2, roughness: 0.3, opacity: 0.8, emissiveColor: "#010203", emissiveIntensity: 0.4 },
            castShadow: true,
            receiveShadow: false,
          },
          durableState: {},
          placement: { space: "world3d", position: { x: 0, y: 0.2, z: 0 }, rotation: { x: 0, y: 0, z: 0 }, scale: { x: 1, y: 1, z: 1 } },
          parentId: "assembly",
          tags: [],
          visibility: "visible",
          locks: { placement: false },
        },
      ],
    });
    expect(scene.entities.get("assembly")?.renderGeometry).toEqual({ kind: "assembly" });
    expect(scene.entities.get("primitive")).toMatchObject({
      parentId: "assembly",
      renderGeometry: {
        kind: "parametric",
        definition: { kind: "box", sizeM: { x: 1.2, y: 0.4, z: 2.5 } },
        material: { baseColor: "#123456", metallic: 0.2, roughness: 0.3 },
      },
    });
  });

  it("projects a calibrated Reality layer as visual-only digest-pinned geometry", () => {
    const source = snapshot();
    const digest = `sha256:${"a".repeat(64)}` as const;
    const scene = workspaceToSceneState({
      ...source,
      realityAssets: [{
        version: 1,
        assetId: "ra_pole",
        digest,
        format: "spz-v4",
        formatVersion: 4,
        mediaType: "application/x-spz",
        byteLength: 2048,
        splatCount: 800,
        sphericalHarmonicsDegree: 1,
        model: "gaussian-3d",
        antialiased: false,
        coordinateSystem: { system: "LDF", provenance: "embedded" },
        sourceBounds: { min: { x: 1, y: 2, z: 3 }, max: { x: 5, y: 8, z: 9 } },
        engineeringAuthority: "visual_only",
      }],
      components: [
        source.components[0]!,
        {
          id: "reality-pole",
          type: { typeId: "gaussian-splat", version: "1.0.0", digest: "manifest" },
          label: "Captured utility pole",
          props: {
            assetRef: { assetId: "ra_pole", digest },
            calibration: {
              version: 1,
              status: "reference-distance",
              sourceCoordinateSystem: "LDF",
              targetCoordinateSystem: "RUB",
              metersPerSourceUnit: 0.01,
              sourceDistance: 200,
              referenceDistanceM: 2,
            },
            quality: "high",
            semanticProxyIds: [],
          },
          durableState: {},
          placement: {
            space: "world3d",
            position: { x: 4, y: 0, z: 2 },
            rotation: { x: 0, y: 0.5, z: 0 },
            scale: { x: 2, y: 2, z: 2 },
          },
          tags: [],
          visibility: "visible",
          locks: { placement: false },
        },
      ],
    });
    expect(scene.entities.get("reality-pole")).toMatchObject({
      assetId: "reality:ra_pole",
      transform: {
        position: { x: 4, y: 0, z: 2 },
        scale: { x: 0.02, y: 0.02, z: 0.02 },
      },
      renderGeometry: {
        kind: "reality",
        asset: { assetId: "ra_pole", digest, format: "spz-v4", byteLength: 2048, splatCount: 800 },
        bounds: { min: { x: 1, y: 2, z: 3 }, max: { x: 5, y: 8, z: 9 } },
        sourceAxisSigns: { x: -1, y: -1, z: -1 },
        metersPerSourceUnit: 0.01,
        quality: "high",
        engineeringAuthority: "visual_only",
      },
    });
  });

  it("projects durable spatial playback instead of relying on opaque props", () => {
    const source = snapshot();
    const scene = workspaceToSceneState({
      ...source,
      components: source.components.map((component) => component.id === "desk"
        ? {
            ...component,
            props: { ...component.props, entityKind: "character", state: { animation: "idle" } },
            durableState: {
              playback: { clip: "run", playing: true, loop: false, speed: 1.75, generation: 3 },
            },
          }
        : component),
    });
    expect(scene.entities.get("desk")?.state).toEqual({
      type: "character",
      animation: "run",
      animationPlaying: true,
      animationLoop: false,
      animationSpeed: 1.75,
      animationGeneration: 3,
    });
  });

  it("defaults playback-aware 1.2 entities to a stopped idle state", () => {
    const source = snapshot();
    const scene = workspaceToSceneState({
      ...source,
      components: source.components.map((component) => component.id === "desk"
        ? {
            ...component,
            type: { ...component.type, version: "1.2.0" },
            props: { ...component.props, entityKind: "character" },
            durableState: {},
          }
        : component),
    });
    expect(scene.entities.get("desk")?.state).toMatchObject({
      type: "character",
      animation: "idle",
      animationPlaying: false,
      animationLoop: true,
      animationSpeed: 1,
      animationGeneration: 0,
    });
  });

  it("projects hidden spatial entities as non-visible and collapses them entirely", () => {
    const source = snapshot();
    const withVisibility = (visibility: "hidden" | "collapsed") => workspaceToSceneState({
      ...source,
      components: source.components.map((component) => component.id === "desk"
        ? { ...component, visibility }
        : component),
    });
    const hiddenEntity = withVisibility("hidden").entities.get("desk");
    expect(hiddenEntity?.appearance.opacity).toBe(0);
    expect(isEntityVisuallyPresent(hiddenEntity)).toBe(false);
    expect(withVisibility("collapsed").entities.has("desk")).toBe(false);

    const hiddenStage = workspaceToSceneState({
      ...source,
      components: source.components.map((component) => component.id === "stage"
        ? { ...component, visibility: "hidden" as const }
        : component),
    });
    expect(hiddenStage.environment.preset).toBe(EMPTY_WORKSPACE_ENVIRONMENT_PRESET);
    expect(hiddenStage.entities.size).toBe(0);
  });

  it("keeps flat Stage preset and resized dimensions authoritative over conflicting nested environment data", () => {
    const store = new WorkspaceStore();
    store.apply(workspaceBatch(store, "create_stage", [{
      op: "create_component",
      op_id: "stage",
      id: "CMP_000001",
      component_type: DEFAULT_COMPONENT_REGISTRY.ref("stage-3d"),
      placement: {
        space: "world3d",
        position: { x: 0, y: 0, z: 0 },
        rotation: { x: 0, y: 0, z: 0 },
        scale: { x: 1, y: 1, z: 1 },
      },
      props: {
        environmentPreset: "grassland",
        environment: {
          preset: "dark_room",
          dimensions: { width: 2, height: 2, depth: 2 },
          anchors: {
            briefing: {
              position: { x: 1, y: 2, z: 3 },
              rotation: { x: 0, y: 0, z: 0 },
              scale: { x: 1, y: 1, z: 1 },
            },
            "field.north": {
              position: { x: 0, y: 0, z: -999 },
              rotation: { x: 0, y: 0, z: 0 },
              scale: { x: 1, y: 1, z: 1 },
            },
          },
          properties: { weather: "clear", ignoredObject: { unsafe: true } },
        },
      },
    }]));
    store.apply(workspaceBatch(store, "resize_stage", [{
      op: "resize_component",
      op_id: "resize",
      id: "CMP_000001",
      resize: {
        kind: "stage_dimensions",
        dimensions: { width: 24, height: 8, depth: 20 },
      },
    }]));

    const scene = workspaceToSceneState(toRenderSnapshot(store.getState()));
    expect(scene.environment).toMatchObject({
      preset: "grassland",
      dimensions: { width: 24, height: 8, depth: 20 },
      properties: { weather: "clear" },
      anchors: {
        briefing: { position: { x: 1, y: 2, z: 3 } },
        "field.north": { position: { x: 0, y: 0, z: -20 / 3 } },
      },
    });
    expect(scene.environment.properties).not.toHaveProperty("ignoredObject");

    const rendered = createEnvironment(scene.environment);
    expect(rendered.root.userData.stageDimensions).toEqual({ width: 24, height: 8, depth: 20 });
    expect(objectSize(rendered.root.getObjectByName("environment:bounds"))).toEqual({
      x: 24,
      y: 8,
      z: 20,
    });
  });

  it("projects writable Stage background and grid visibility from Store to the environment renderer", () => {
    const store = new WorkspaceStore();
    store.apply(workspaceBatch(store, "create_stage", [{
      op: "create_component",
      op_id: "stage",
      id: "CMP_000001",
      component_type: DEFAULT_COMPONENT_REGISTRY.ref("stage-3d"),
      placement: {
        space: "world3d",
        position: { x: 0, y: 0, z: 0 },
        rotation: { x: 0, y: 0, z: 0 },
        scale: { x: 1, y: 1, z: 1 },
      },
      props: { environmentPreset: "blank_stage" },
    }]));
    store.apply(workspaceBatch(store, "style_stage", [{
      op: "update_component",
      op_id: "style",
      id: "CMP_000001",
      patch: { props: { background: "#123456CC", gridVisible: false } },
    }]));

    const snapshot = toRenderSnapshot(store.getState());
    expect(snapshot.components[0]?.props).toMatchObject({
      background: "#123456CC",
      gridVisible: false,
    });
    const scene = workspaceToSceneState(snapshot);
    expect(scene.environment.properties).toMatchObject({
      background: "#123456CC",
      gridVisible: false,
    });

    const rendered = createEnvironment(scene.environment);
    expect(rendered.background.getHexString()).toBe("123456");
    expect(rendered.root.getObjectByName("environment:grid")?.visible).toBe(false);
    expect(rendered.root.getObjectByName("environment:ground")?.visible).not.toBe(false);
  });

  it.each([
    "__workspace_empty__",
    "blank_stage",
    "grassland",
    "city_street",
    "simple_room",
    "dark_room",
    "bedroom",
  ])("uses a Stage background override for the %s preset", (preset) => {
    const rendered = createEnvironment({
      preset,
      anchors: {},
      properties: { background: "#0A1B2C" },
    });
    expect(rendered.background.getHexString()).toBe("0a1b2c");
  });

  it("keeps enormous older-manifest Stage extents while bounding renderer allocations", () => {
    const store = new WorkspaceStore();
    const dimensions = { width: 1_000_000_000_000, height: 1_000_000_000, depth: 900_000_000_000 };
    store.apply(workspaceBatch(store, "create_enormous_legacy_stage", [{
      op: "create_component",
      op_id: "stage",
      id: "CMP_000099",
      component_type: DEFAULT_COMPONENT_REGISTRY.ref("stage-3d", "1.0.0"),
      placement: {
        space: "world3d",
        position: { x: 0, y: 0, z: 0 },
        rotation: { x: 0, y: 0, z: 0 },
        scale: { x: 1, y: 1, z: 1 },
      },
      props: { environmentPreset: "blank_stage", dimensions },
    }]));

    const scene = workspaceToSceneState(toRenderSnapshot(store.getState()));
    expect(scene.environment.dimensions).toEqual(dimensions);
    const rendered = createEnvironment(scene.environment);
    expect(rendered.root.userData.stageDimensions).toEqual(dimensions);
    const grid = rendered.root.getObjectByName("environment:grid") as LineSegments | undefined;
    expect(grid?.userData.divisions).toBe(MAX_STAGE_GRID_DIVISIONS);
    expect(grid?.geometry.getAttribute("position").count)
      .toBeLessThanOrEqual((MAX_STAGE_GRID_DIVISIONS + 1) * 4);
    expect(rendered.root.getObjectByName("environment:ground")).toBeDefined();
    expect(rendered.root.getObjectByName("environment:bounds")).toBeDefined();
  });

  it("does not grant privileged Stage or spatial semantics to suffix-colliding recipe type IDs", () => {
    const full = snapshot();
    const stage = full.components[0]!;
    const desk = full.components[1]!;
    const collidingStage = {
      ...stage,
      type: { ...stage.type, typeId: "recipe.stage-3d" },
    };
    const collidingSpatial = {
      ...desk,
      type: { ...desk.type, typeId: "recipe.spatial-entity" },
    };

    const withoutRealStage = workspaceToSceneState({
      ...full,
      components: [collidingStage, collidingSpatial],
    });
    expect(withoutRealStage.environment.preset).toBe(EMPTY_WORKSPACE_ENVIRONMENT_PRESET);
    expect(withoutRealStage.entities.size).toBe(0);

    const withRealStage = workspaceToSceneState({
      ...full,
      components: [stage, collidingSpatial],
    });
    expect(withRealStage.environment.preset).toBe("simple_room");
    expect(withRealStage.entities.size).toBe(0);
  });

  it.each([
    ["blank_stage", "environment:grid", undefined],
    ["grassland", "environment:grass:mound:0", 0.1],
    ["street", "environment:street:building:-1:0", 0.46],
    ["city_street", "environment:street:building:-1:0", 0.46],
    ["simple_room", "environment:room:north-wall", 1],
    ["dark_room", "environment:room:north-wall", 1],
    ["bedroom", "environment:room:rug", undefined],
  ])("renders %s from the exact width, height, and depth", (preset, featureName, heightRatio) => {
    const dimensions = { width: 18, height: 7, depth: 11 };
    const built = createEnvironment({ preset, dimensions, anchors: {} });
    expect(built.root.userData).toMatchObject({
      environmentPreset: preset,
      stageDimensions: dimensions,
      stageBounds: {
        min: { x: -9, y: 0, z: -5.5 },
        max: { x: 9, y: 7, z: 5.5 },
      },
    });
    const bounds = built.root.getObjectByName("environment:bounds");
    expect(bounds).toBeInstanceOf(LineSegments);
    expect(objectSize(bounds)).toEqual({ x: 18, y: 7, z: 11 });
    expect(bounds?.visible).toBe(true);

    const ground = objectSize(built.root.getObjectByName("environment:ground"));
    expect(ground.x).toBeCloseTo(18);
    expect(ground.z).toBeCloseTo(11);
    const feature = built.root.getObjectByName(featureName);
    expect(feature).toBeDefined();
    if (heightRatio !== undefined) {
      expect(objectSize(feature).y).toBeCloseTo(7 * heightRatio);
    }
  });

  it("retains visual fallbacks when an environment has no dimensions", () => {
    const blank = createEnvironment({ preset: "blank_stage", anchors: {} });
    expect(objectSize(blank.root.getObjectByName("environment:ground"))).toMatchObject({ x: 12, z: 12 });
    const grass = createEnvironment({ preset: "grassland", anchors: {} });
    expect(objectSize(grass.root.getObjectByName("environment:ground"))).toMatchObject({ x: 42, z: 42 });
    const street = createEnvironment({ preset: "street", anchors: {} });
    expect(objectSize(street.root.getObjectByName("environment:ground"))).toMatchObject({ x: 30, z: 30 });
    const room = createEnvironment({ preset: "simple_room", anchors: {} });
    expect(objectSize(room.root.getObjectByName("environment:ground"))).toMatchObject({ x: 8, z: 7 });
  });

  it("uses deltas after the initial render", async () => {
    const port = new FakeThreePort();
    const renderer = new ThreeComponentRenderer({ renderer: port });
    await renderer.initialize(document.createElement("div"));
    await renderer.render(snapshot());
    const moved = snapshot();
    const desk = moved.components.find((component) => component.id === "desk")!;
    const next: WorkspaceRenderSnapshot = {
      ...moved,
      revision: 2,
      components: moved.components.map((component) => component.id === "desk"
        ? {
            ...desk,
            placement: {
              space: "world3d" as const,
              position: { x: 3, y: 0, z: 2 },
              rotation: { x: 0, y: 0, z: 0 },
              scale: { x: 1, y: 1, z: 1 },
            },
          }
        : component),
    };
    await renderer.render(next, [{
      op: "place_component",
      op_id: "move_desk",
      id: "desk",
      placement: next.components.find((component) => component.id === "desk")!.placement,
      transition: { durationMs: 640, delayMs: 75, easing: "ease_out" },
    }]);
    expect(port.renderState).toHaveBeenCalledOnce();
    expect(port.applyDelta).toHaveBeenCalledOnce();
    expect(port.applyDelta.mock.calls[0]?.[0]).toMatchObject({ updated: ["desk"], fromRevision: 1, toRevision: 2 });
    expect(port.applyDelta.mock.calls[0]?.[2]).toEqual([{
      op: "update_entity",
      op_id: "workspace:move_desk",
      id: "desk",
      patch: {},
      visualTiming: { startAfterMs: 75, durationMs: 640, easing: "ease_out" },
    }]);
    renderer.frameAll();
    renderer.resetView();
    renderer.zoomBy(1.2);
    expect(port.frameAll).toHaveBeenCalledOnce();
    expect(port.resetView).toHaveBeenCalledOnce();
    expect(port.zoomBy).toHaveBeenCalledWith(1.2);
  });

  it("serializes async revisions against the last fully rendered scene", async () => {
    const gate = deferred<void>();
    const port = new FakeThreePort();
    port.renderState.mockImplementationOnce(async () => { await gate.promise; return undefined; });
    const renderer = new ThreeComponentRenderer({ renderer: port });
    await renderer.initialize(document.createElement("div"));
    const first = renderer.render(snapshot());
    const next = movedSnapshot(2, 6);
    const second = renderer.render(next);

    await Promise.resolve();
    expect(port.renderState).toHaveBeenCalledOnce();
    expect(port.applyDelta).not.toHaveBeenCalled();
    gate.resolve();
    await Promise.all([first, second]);
    expect(port.applyDelta).toHaveBeenCalledOnce();
    expect(port.applyDelta.mock.calls[0]?.[0]).toMatchObject({ fromRevision: 1, toRevision: 2 });
  });

  it("does not continue a queued render after disposal", async () => {
    const gate = deferred<void>();
    const port = new FakeThreePort();
    port.renderState.mockImplementationOnce(async () => { await gate.promise; return undefined; });
    const renderer = new ThreeComponentRenderer({ renderer: port });
    await renderer.initialize(document.createElement("div"));
    const first = renderer.render(snapshot());
    const second = renderer.render(movedSnapshot(2, 8));
    renderer.dispose();
    gate.resolve();
    await Promise.all([first, second]);
    expect(port.applyDelta).not.toHaveBeenCalled();
    expect(port.dispose).toHaveBeenCalledOnce();
  });

  it("preserves world transform while changing a rendered parent", () => {
    const from = new Group();
    from.position.set(5, 2, -3);
    const to = new Group();
    to.position.set(-4, 1, 7);
    const child = new Group();
    child.position.set(1, 0.5, 2);
    from.add(child);
    from.updateWorldMatrix(true, true);
    to.updateWorldMatrix(true, true);
    const before = child.getWorldPosition(new Vector3());
    reparentPreservingWorldTransform(child, to);
    expect(child.getWorldPosition(new Vector3()).distanceTo(before)).toBeLessThan(1e-9);
  });

  it("preserves an explicit delay when transition duration is zero", () => {
    expect(shouldScheduleTransformTween(true, {
      durationMs: 0,
      startAfterMs: 80,
      easing: "linear",
    })).toBe(true);
    expect(shouldScheduleTransformTween(true, {
      durationMs: 0,
      startAfterMs: 0,
      easing: "linear",
    })).toBe(false);
  });

  it("maps an explicit Stage transition into environment timing", () => {
    expect(workspaceOperationsToSceneOperations([{
      op: "update_component",
      op_id: "fade_stage",
      id: "stage",
      patch: { props: { environmentPreset: "dark_room" } },
      transition: { durationMs: 420, delayMs: 60, easing: "ease_in_out" },
    }], snapshot())).toEqual([{
      op: "set_environment",
      op_id: "workspace:fade_stage",
      environmentPreset: "simple_room",
      visualTiming: { durationMs: 420, startAfterMs: 60, easing: "ease_in_out" },
    }]);
  });
});

class FakeThreePort implements ThreeRendererPort {
  initialize = vi.fn(async (_container: HTMLElement) => undefined);
  renderState = vi.fn(async (_state: Readonly<SceneState>) => undefined);
  applyDelta = vi.fn(async (_delta: SceneDelta, _state?: Readonly<SceneState>, _operations?: readonly SceneOperation[]) => undefined);
  resize = vi.fn();
  dispose = vi.fn();
  frameAll = vi.fn();
  resetView = vi.fn();
  zoomBy = vi.fn();
}

function objectSize(object: import("three").Object3D | undefined): { x: number; y: number; z: number } {
  if (!object) throw new Error("Expected environment object");
  const size = new Box3().setFromObject(object).getSize(new Vector3());
  return {
    x: normalized(size.x),
    y: normalized(size.y),
    z: normalized(size.z),
  };
}

function normalized(value: number): number {
  return Number(value.toFixed(8));
}

function movedSnapshot(revision: number, x: number): WorkspaceRenderSnapshot {
  const source = snapshot();
  return {
    ...source,
    revision,
    components: source.components.map((component) => component.id === "desk"
      ? {
          ...component,
          placement: {
            space: "world3d" as const,
            position: { x, y: 0, z: 2 },
            rotation: { x: 0, y: 0, z: 0 },
            scale: { x: 1, y: 1, z: 1 },
          },
        }
      : component),
  };
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((next) => { resolve = next; });
  return { promise, resolve };
}

function snapshot(): WorkspaceRenderSnapshot {
  return {
    workspaceId: "test",
    revision: 1,
    components: [
      {
        id: "stage",
        type: { typeId: "stage-3d", version: "1.0.0", digest: "stage" },
        label: "Stage",
        props: { environmentPreset: "simple_room" },
        durableState: {},
        placement: { space: "world3d", position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0 }, scale: { x: 1, y: 1, z: 1 } },
        tags: [],
        visibility: "visible",
        locks: { placement: true },
      },
      {
        id: "desk",
        type: { typeId: "spatial-entity", version: "1.0.0", digest: "entity" },
        label: "Desk",
        props: { assetId: "primitive_box", entityKind: "prop" },
        durableState: {},
        placement: { space: "world3d", position: { x: 1, y: 0, z: 2 }, rotation: { x: 0, y: 0, z: 0 }, scale: { x: 1, y: 1, z: 1 } },
        tags: [],
        visibility: "visible",
        locks: { placement: false },
      },
      {
        id: "timer",
        type: { typeId: "timer", version: "1.0.0", digest: "timer" },
        label: "Timer",
        props: { durationMs: 10_000 },
        durableState: { phase: "idle", durationMs: 10_000, remainingMs: 10_000, runGeneration: 0 },
        placement: { space: "billboard", targetId: "desk", offset: { x: 0, y: 2, z: 0 } },
        tags: [],
        visibility: "visible",
        locks: { placement: false },
      },
    ],
  };
}
