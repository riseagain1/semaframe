import * as THREE from "three";
import { describe, expect, it } from "vitest";
import type { EntityState } from "../../renderer/sceneRenderTypes";
import type { SpatialCollisionConfig } from "../../workspace/spatial/spatialTypes";
import {
  isXRTeleportBlockingEntity,
  planThreeRendererTeleport,
} from "../../renderer/xr/XRTeleportPlanner";

const RENDER_ORIGIN = new THREE.Vector3(1_000, 0, -500);
const TARGET_SEMANTIC = new THREE.Vector3(1_002, 0, -503);
const SOLID_COLLISION = Object.freeze({
  enabled: true,
  role: "solid",
  shape: "asset_bounds",
  margin: 0.02,
} as const);

function mesh(
  name: string,
  size: readonly [number, number, number],
  position: THREE.Vector3,
): THREE.Mesh {
  const result = new THREE.Mesh(new THREE.BoxGeometry(...size));
  result.name = name;
  result.position.copy(position);
  return result;
}

function scene(): Readonly<{
  environment: THREE.Group;
  surface: THREE.Mesh;
  rayOrigin: THREE.Vector3;
  rayDirection: THREE.Vector3;
}> {
  const environment = new THREE.Group();
  environment.position.copy(RENDER_ORIGIN).multiplyScalar(-1);
  const surface = mesh(
    "environment:ground",
    [8, 0.08, 8],
    new THREE.Vector3(TARGET_SEMANTIC.x, -0.04, TARGET_SEMANTIC.z),
  );
  environment.add(surface);
  environment.updateMatrixWorld(true);
  const rayOrigin = new THREE.Vector3(0, 1.6, 0);
  const targetRendered = TARGET_SEMANTIC.clone().sub(RENDER_ORIGIN);
  const rayDirection = targetRendered.sub(rayOrigin).normalize();
  return { environment, surface, rayOrigin, rayDirection };
}

function plan(
  input: Readonly<{
    entities?: readonly Readonly<{
      id: string;
      root: THREE.Object3D;
      collision: SpatialCollisionConfig;
    }>[];
    decorateEnvironment?(environment: THREE.Group): void;
  }> = {},
) {
  const fixture = scene();
  input.decorateEnvironment?.(fixture.environment);
  fixture.environment.updateMatrixWorld(true);
  return planThreeRendererTeleport({
    rayOrigin: fixture.rayOrigin,
    rayDirection: fixture.rayDirection,
    maxDistance: 40,
    headWorldPosition: new THREE.Vector3(0, 1.6, 0),
    rigWorldPosition: new THREE.Vector3(0, 0, 0),
    renderOrigin: RENDER_ORIGIN,
    walkableSurface: fixture.surface,
    environmentRoot: fixture.environment,
    entities: input.entities ?? [],
  });
}

function entity(overrides: Partial<EntityState> = {}): EntityState {
  return {
    id: "entity-1",
    kind: "prop",
    assetId: "primitive_box",
    label: "Entity",
    transform: {
      position: { x: 0, y: 0, z: 0 },
      rotation: { x: 0, y: 0, z: 0 },
      scale: { x: 1, y: 1, z: 1 },
    },
    appearance: {},
    state: { type: "prop" },
    collision: SOLID_COLLISION,
    tags: [],
    locked: false,
    ...overrides,
  };
}

describe("ThreeRenderer collision-safe teleport planner", () => {
  it("preserves semantic coordinates across a floating render origin", () => {
    const result = plan();
    expect(result).toMatchObject({
      valid: true,
      surfaceId: "environment:ground",
      targetFeet: {
        x: expect.closeTo(1_002, 6),
        y: expect.closeTo(0, 6),
        z: expect.closeTo(-503, 6),
      },
      rigDelta: {
        x: expect.closeTo(2, 6),
        y: expect.closeTo(0, 6),
        z: expect.closeTo(-3, 6),
      },
    });
  });

  it("excludes the walkable floor but blocks a nearby entity capsule overlap", () => {
    const clear = plan();
    expect(clear.valid).toBe(true);

    const blocker = mesh("entity:sofa", [0.1, 1, 0.2], new THREE.Vector3(2.36, 0.5, -3));
    const blocked = plan({ entities: [{ id: "sofa", root: blocker, collision: SOLID_COLLISION }] });
    expect(blocked).toEqual({
      valid: false,
      reason: "collision",
      conflicts: ["entity:sofa"],
    });
  });

  it("uses an explicit collider even when it is larger than or separate from visual geometry", () => {
    const root = new THREE.Group();
    root.position.set(2.36, 0, -3);
    const blocked = plan({ entities: [{
      id: "semantic-proxy",
      root,
      collision: {
        enabled: true,
        role: "solid",
        shape: "box",
        margin: 0.02,
        center: { x: 0, y: 0.5, z: 0 },
        size: { x: 0.1, y: 1, z: 0.2 },
      },
    }] });
    expect(blocked).toEqual({
      valid: false,
      reason: "collision",
      conflicts: ["entity:semantic-proxy"],
    });
  });

  it("conservatively transforms rotated compound parts through non-uniform root scale", () => {
    const root = new THREE.Group();
    root.position.set(3, 0, -3);
    root.scale.set(3, 1, 0.25);
    const blocked = plan({ entities: [{
      id: "scaled-compound",
      root,
      collision: {
        enabled: true,
        role: "solid",
        shape: "compound",
        margin: 0.02,
        parts: [{
          id: "rotated-arm",
          center: { x: 0, y: 0.5, z: 0 },
          size: { x: 0.1, y: 1, z: 2 },
          rotation: { x: 0, y: Math.PI / 2, z: 0 },
        }],
      },
    }] });
    expect(blocked).toEqual({
      valid: false,
      reason: "collision",
      conflicts: ["entity:scaled-compound"],
    });
  });

  it("treats raised environment details as blockers while excluding named walkable meshes", () => {
    const blocked = plan({
      decorateEnvironment(environment) {
        environment.add(mesh(
          "environment:grass:mound:0",
          [0.1, 1, 0.2],
          new THREE.Vector3(TARGET_SEMANTIC.x + 0.36, 0.5, TARGET_SEMANTIC.z),
        ));
        environment.add(mesh(
          "environment:street:road",
          [8, 0.08, 8],
          new THREE.Vector3(TARGET_SEMANTIC.x, 0.02, TARGET_SEMANTIC.z),
        ));
        environment.add(mesh(
          "environment:street:stripe:0",
          [0.08, 0.025, 1],
          new THREE.Vector3(TARGET_SEMANTIC.x, 0.065, TARGET_SEMANTIC.z),
        ));
      },
    });
    expect(blocked).toMatchObject({
      valid: false,
      reason: "collision",
      conflicts: [expect.stringContaining("environment:grass:mound:0")],
    });
  });

  it("fails closed instead of omitting malformed or empty entity bounds", () => {
    expect(plan({ entities: [{
      id: "loading-asset",
      root: new THREE.Group(),
      collision: SOLID_COLLISION,
    }] })).toEqual({
      valid: false,
      reason: "collision",
      conflicts: ["xr-teleport-scene-invalid"],
    });
  });

  it("classifies transform-only and visual evidence roots as non-blocking", () => {
    expect(isXRTeleportBlockingEntity(entity())).toBe(true);
    expect(isXRTeleportBlockingEntity(entity({ collision: undefined }))).toBe(false);
    expect(isXRTeleportBlockingEntity(entity({
      collision: { ...SOLID_COLLISION, role: "trigger" },
    }))).toBe(false);
    expect(isXRTeleportBlockingEntity(entity({ kind: "effect" }))).toBe(false);
    expect(isXRTeleportBlockingEntity(entity({
      renderGeometry: { kind: "assembly", collisionPolicy: "external_only" },
    }))).toBe(false);
    expect(isXRTeleportBlockingEntity(entity({
      renderGeometry: {
        kind: "reality",
        bounds: { min: { x: -1, y: -1, z: -1 }, max: { x: 1, y: 1, z: 1 } },
        sourceAxisSigns: { x: 1, y: 1, z: 1 },
        metersPerSourceUnit: 1,
        quality: "auto",
        engineeringAuthority: "visual_only",
      },
    }))).toBe(false);
  });

  it("honors collision-disabled assembly ancestry and fails closed on broken parents", () => {
    const child = entity({ id: "assembly-child", parentId: "assembly-root" });
    const disabledAssembly = entity({
      id: "assembly-root",
      renderGeometry: { kind: "assembly", collisionPolicy: "none" },
    });
    const externalAssembly = entity({
      id: "assembly-root",
      renderGeometry: { kind: "assembly", collisionPolicy: "external_only" },
    });

    expect(isXRTeleportBlockingEntity(child, new Map([
      [disabledAssembly.id, disabledAssembly],
      [child.id, child],
    ]))).toBe(false);
    expect(isXRTeleportBlockingEntity(child, new Map([
      [externalAssembly.id, externalAssembly],
      [child.id, child],
    ]))).toBe(true);
    expect(isXRTeleportBlockingEntity(child, new Map([[child.id, child]]))).toBe(true);
  });
});
