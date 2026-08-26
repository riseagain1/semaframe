import { describe, expect, it } from "vitest";
import * as THREE from "three";
import type { EntityState, SceneState } from "../../renderer/sceneRenderTypes";
import {
  MaterializationController,
  MaterializationLayer,
  materializationAssetBounds,
  planMaterialization,
} from "../../renderer/materialization";

describe("MaterializationPlanner", () => {
  it("plans one deterministic bounded pass with parents before children", () => {
    const state = scene([
      entity("detail", { x: 2, y: 1, z: 0 }, "frame"),
      entity("frame", { x: 0, y: 0, z: 0 }, undefined, "structure"),
      entity("motor", { x: 1, y: 0.4, z: 0 }),
    ]);
    const input = {
      state,
      addedEntityIds: ["motor", "detail", "frame", "motor"],
      batchKey: "workspace:4->5",
      mode: "full" as const,
      resolveAssetBounds: () => materializationAssetBounds(
        { x: 0, y: 0.5, z: 0 },
        { x: 1, y: 1, z: 1 },
      ),
    };
    const first = planMaterialization(input);
    const second = planMaterialization(input);

    expect(second).toEqual(first);
    expect(first.entries.map(({ entityId }) => entityId)).toEqual(["frame", "motor", "detail"]);
    const frame = first.entries.find(({ entityId }) => entityId === "frame")!;
    const detail = first.entries.find(({ entityId }) => entityId === "detail")!;
    expect(detail.revealAtMs - frame.revealAtMs).toBeGreaterThanOrEqual(120);
    expect(first.totalDurationMs).toBeGreaterThanOrEqual(2_000);
    expect(first.totalDurationMs).toBeLessThanOrEqual(4_000);
    expect(first.entries.every(({ proxy }) => proxy.reliableBounds)).toBe(true);
  });

  it("keeps a 2,000-entity plan within the fixed duration instead of serializing every object", () => {
    const entities = Array.from({ length: 2_000 }, (_, index) => entity(
      `part-${index.toString().padStart(4, "0")}`,
      { x: index % 50, y: Math.floor(index / 50) * 0.1, z: index % 7 },
    ));
    const state = scene(entities);
    const plan = planMaterialization({
      state,
      addedEntityIds: entities.map(({ id }) => id),
      batchKey: "large",
      mode: "subtle",
      resolveAssetBounds: () => materializationAssetBounds(
        { x: 0, y: 0.25, z: 0 },
        { x: 0.5, y: 0.5, z: 0.5 },
      ),
    });
    expect(plan.entries).toHaveLength(2_000);
    expect(plan.totalDurationMs).toBeGreaterThanOrEqual(2_000);
    expect(plan.totalDurationMs).toBeLessThanOrEqual(4_000);
  });

  it("uses a fixed loading glyph rather than inventing CAD dimensions", () => {
    const candidate: EntityState = {
      ...entity("cad", { x: 0, y: 0, z: 0 }),
      assetId: "cad:unresolved",
      renderGeometry: {
        kind: "assembly",
        collisionPolicy: "external_only",
      },
    };
    const plan = planMaterialization({
      state: scene([candidate]),
      addedEntityIds: [candidate.id],
      batchKey: "unknown-bounds",
      mode: "full",
    });
    expect(plan.entries[0]?.proxy).toMatchObject({
      source: "loading_glyph",
      reliableBounds: false,
      localSize: { x: 0.18, y: 0.18, z: 0.18 },
    });
  });
});

describe("MaterializationController", () => {
  it("crossfades at final transforms, gates interaction, and restores final appearance", () => {
    let now = 1_000;
    const parent = new THREE.Group();
    const layer = new MaterializationLayer(parent, 16);
    const controller = new MaterializationController(layer, () => now);
    const state = scene([entity("box", { x: 4, y: 2, z: -3 })]);
    const plan = planMaterialization({
      state,
      addedEntityIds: ["box"],
      batchKey: "fade",
      mode: "full",
      resolveAssetBounds: () => materializationAssetBounds(
        { x: 0, y: 0.5, z: 0 },
        { x: 1, y: 1, z: 1 },
      ),
    });
    controller.begin(plan);
    const material = new THREE.MeshStandardMaterial({ opacity: 1 });
    const root = new THREE.Group();
    root.position.set(4, 2, -3);
    root.add(new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), material));
    parent.add(root);
    controller.attach("box", root, {
      opacity: 0.75,
      emissiveColor: "#FFFFFF",
      emissiveIntensity: 0,
      glowColor: "#58E6FF",
      glowIntensity: 0,
      glowSpread: 0.5,
    }, true);

    expect(root.position.toArray()).toEqual([4, 2, -3]);
    expect(controller.isEntityInteractive("box")).toBe(false);
    expect(material.opacity).toBe(0);
    now += plan.entries[0]!.revealAtMs + plan.entries[0]!.revealDurationMs / 2;
    controller.update(now);
    expect(material.opacity).toBeGreaterThan(0);
    expect(material.opacity).toBeLessThan(0.75);
    expect(controller.isEntityInteractive("box")).toBe(true);
    now = 1_000 + plan.totalDurationMs + 1;
    controller.update(now);
    expect(material.opacity).toBeCloseTo(0.75);
    expect(controller.isActive()).toBe(false);

    controller.dispose();
    material.dispose();
  });

  it("finishes active content immediately when reduced motion or a new revision cancels it", () => {
    let now = 0;
    const parent = new THREE.Group();
    const layer = new MaterializationLayer(parent);
    const controller = new MaterializationController(layer, () => now);
    const state = scene([entity("box", { x: 0, y: 0, z: 0 })]);
    controller.begin(planMaterialization({
      state,
      addedEntityIds: ["box"],
      batchKey: "cancel",
      mode: "full",
      resolveAssetBounds: () => materializationAssetBounds(
        { x: 0, y: 0.5, z: 0 },
        { x: 1, y: 1, z: 1 },
      ),
    }));
    const material = new THREE.MeshStandardMaterial();
    const root = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), material);
    parent.add(root);
    controller.attach("box", root, {
      opacity: 1,
      emissiveColor: "#FFFFFF",
      emissiveIntensity: 0,
      glowColor: "#58E6FF",
      glowIntensity: 0,
      glowSpread: 0.5,
    }, true);
    controller.cancel(true);
    expect(controller.isActive()).toBe(false);
    expect(controller.isEntityInteractive("box")).toBe(true);
    expect(material.opacity).toBe(1);
    controller.dispose();
    material.dispose();
  });

  it("fails safe when an external asset never finishes the active materialization pass", () => {
    let now = 5_000;
    const parent = new THREE.Group();
    const layer = new MaterializationLayer(parent);
    const controller = new MaterializationController(layer, () => now);
    const state = scene([
      entity("ready", { x: 0, y: 0, z: 0 }),
      entity("hung", { x: 2, y: 0, z: 0 }),
    ]);
    const plan = planMaterialization({
      state,
      addedEntityIds: ["ready", "hung"],
      batchKey: "decoder-watchdog",
      mode: "full",
      resolveAssetBounds: () => materializationAssetBounds(
        { x: 0, y: 0.5, z: 0 },
        { x: 1, y: 1, z: 1 },
      ),
    });
    controller.begin(plan);
    const material = new THREE.MeshStandardMaterial({ opacity: 1 });
    const root = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), material);
    parent.add(root);
    controller.attach("ready", root, {
      opacity: 0.8,
      emissiveColor: "#FFFFFF",
      emissiveIntensity: 0,
      glowColor: "#58E6FF",
      glowIntensity: 0,
      glowSpread: 0.5,
    }, true);

    // The second entity never attaches. The bounded renderer-only watchdog
    // still restores the ready root and clears every proxy/collision stand-in.
    now += plan.totalDurationMs + 12_001;
    controller.update(now);
    expect(controller.isActive()).toBe(false);
    expect(controller.isEntityInteractive("ready")).toBe(true);
    expect(root.visible).toBe(true);
    expect(material.opacity).toBeCloseTo(0.8);
    expect(layer.getCollisionRoot("hung")).toBeUndefined();

    controller.dispose();
    material.dispose();
  });
});

function entity(
  id: string,
  position: Readonly<{ x: number; y: number; z: number }>,
  parentId?: string,
  kind: EntityState["kind"] = "prop",
): EntityState {
  return {
    id,
    kind,
    assetId: `asset:${id}`,
    label: id,
    transform: {
      position: { ...position },
      rotation: { x: 0, y: 0, z: 0 },
      scale: { x: 1, y: 1, z: 1 },
    },
    appearance: { opacity: 1 },
    state: { type: "generic", properties: {} },
    ...(parentId ? { parentId } : {}),
    tags: [],
    locked: false,
  };
}

function scene(entities: readonly EntityState[]): SceneState {
  return {
    revision: 1,
    environment: { preset: "blank_stage", anchors: {} },
    lighting: { preset: "neutral", exposure: 1 },
    entities: new Map(entities.map((candidate) => [candidate.id, candidate])),
    activeCamera: {
      position: { x: 7, y: 5, z: 8 },
      target: { x: 0, y: 0, z: 0 },
      fovDeg: 44,
    },
  };
}
