import type { EntityState } from "../../renderer/sceneRenderTypes";
import {
  classifyAsset,
  createProceduralEntity,
  findSocket,
  updateEntityAnimation,
  type ProceduralEntity,
} from "../../renderer/proceduralAssets";
import { AnimationClip, AnimationMixer, Box3, Group, LoopOnce, Vector3 } from "three";
import { describe, expect, it, vi } from "vitest";

function entity(patch: Partial<EntityState>): EntityState {
  return {
    id: "PROP_0001",
    kind: "prop",
    assetId: "generic_prop",
    label: "prop",
    transform: {
      position: { x: 0, y: 0, z: 0 },
      rotation: { x: 0, y: 0, z: 0 },
      scale: { x: 1, y: 1, z: 1 },
    },
    appearance: {},
    state: { type: "prop" },
    tags: [],
    locked: false,
    ...patch,
  };
}

describe("procedural asset vocabulary", () => {
  it("classifies common story-blocking assets deterministically", () => {
    expect(classifyAsset(entity({ assetId: "desk_wood_01", label: "wooden desk" }))).toBe("table");
    expect(classifyAsset(entity({ assetId: "book_plain_01", label: "red book" }))).toBe("book");
    expect(classifyAsset(entity({ kind: "structure", assetId: "door_simple_01", label: "door" }))).toBe(
      "door",
    );
    expect(classifyAsset(entity({ kind: "primitive", assetId: "primitive_sphere", label: "orb" }))).toBe(
      "sphere",
    );
  });

  it("provides standard humanoid attachment sockets and fallback", () => {
    const character = createProceduralEntity(
      entity({
        id: "CHAR_0001",
        kind: "character",
        assetId: "humanoid_generic_01",
        label: "the person",
        state: { type: "character", pose: "standing" },
      }),
    );
    expect(findSocket(character, "right_hand").name).toBe("socket:right_hand");
    expect(findSocket(character, "unknown_socket").name).toBe("socket:torso");
  });

  it("keeps the small box at manifest scale when attached to a hand", () => {
    const character = createProceduralEntity(
      entity({
        id: "CHAR_0001",
        kind: "character",
        assetId: "humanoid_generic_01",
        label: "the person",
        state: { type: "character", pose: "standing" },
      }),
    );
    const smallBox = createProceduralEntity(
      entity({
        id: "PROP_0002",
        assetId: "box_small_02",
        label: "small red box",
        appearance: { color: "#A84B42" },
      }),
    );
    const hand = findSocket(character, "right_hand");
    hand.add(smallBox);
    smallBox.position.set(0, 0, 0);
    character.updateWorldMatrix(true, true);

    const size = new Box3().setFromObject(smallBox).getSize(new Vector3());
    expect(size.x).toBeCloseTo(0.32, 5);
    expect(size.y).toBeCloseTo(0.24, 5);
    expect(size.z).toBeCloseTo(0.28, 5);
    expect(size.x).toBeLessThan(0.5); // visibly hand-held, not torso-sized

    const handWorld = hand.getWorldPosition(new Vector3());
    const boxCenter = new Box3().setFromObject(smallBox).getCenter(new Vector3());
    expect(boxCenter.distanceTo(handWorld)).toBeLessThan(0.14);
  });

  it("honors durable play, stop, loop, speed, generation, and reduced-motion state", () => {
    const moving = entity({
      id: "CHAR_0002",
      kind: "character",
      assetId: "humanoid_generic_01",
      state: {
        type: "character",
        pose: "standing",
        animation: "run",
        animationPlaying: true,
        animationLoop: false,
        animationSpeed: 2,
        animationGeneration: 4,
      },
    });
    const animated = createProceduralEntity(moving);
    updateEntityAnimation(moving, animated, 1.123, 1 / 60);
    const animatedRig = animated.userData.rig as { leftArm: Group };
    expect(Math.abs(animatedRig.leftArm.rotation.x)).toBeGreaterThan(0.05);

    const stoppedEntity: EntityState = {
      ...moving,
      state: {
        type: "character",
        pose: "standing",
        animation: "run",
        animationPlaying: false,
        animationLoop: false,
        animationSpeed: 2,
        animationGeneration: 5,
      },
    };
    const stopped = createProceduralEntity(stoppedEntity);
    updateEntityAnimation(stoppedEntity, stopped, 1.123, 1 / 60);
    const stoppedRig = stopped.userData.rig as { leftArm: Group };
    expect(stoppedRig.leftArm.rotation.x).toBe(0);

    const reduced = createProceduralEntity(moving);
    updateEntityAnimation(moving, reduced, 1.123, 1 / 60, true);
    const reducedRig = reduced.userData.rig as { leftArm: Group };
    expect(reducedRig.leftArm.rotation.x).toBe(0);

    const gltfRoot = new Group() as ProceduralEntity;
    const mixer = new AnimationMixer(gltfRoot);
    const clip = new AnimationClip("Run", 1, []);
    gltfRoot.userData.animationMixer = mixer;
    gltfRoot.userData.animationClips = [clip];
    updateEntityAnimation(moving, gltfRoot, 0, 1 / 60);
    const action = mixer.existingAction(clip);
    expect(action?.loop).toBe(LoopOnce);
    expect(action?.timeScale).toBe(2);
    expect(action?.clampWhenFinished).toBe(true);
    expect(gltfRoot.userData.activeAnimation).toContain(":4:");
  });

  it("completes a non-looping generation exactly once and resets a stopped live rig", () => {
    const playing = entity({
      id: "CHAR_ONESHOT",
      kind: "character",
      assetId: "humanoid_generic_01",
      state: {
        type: "character",
        pose: "standing",
        animation: "run",
        animationPlaying: true,
        animationLoop: false,
        animationSpeed: 1,
        animationGeneration: 7,
      },
    });
    const root = createProceduralEntity(playing);
    const onComplete = vi.fn();
    updateEntityAnimation(playing, root, 0, 0.8, false, onComplete);
    updateEntityAnimation(playing, root, 0.8, 0.8, false, onComplete);
    expect(onComplete).toHaveBeenCalledOnce();
    expect(onComplete).toHaveBeenCalledWith({ entityId: "CHAR_ONESHOT", clip: "run", generation: 7 });

    const stopped: EntityState = {
      ...playing,
      state: {
        type: "character",
        pose: "standing",
        animation: "run",
        animationPlaying: false,
        animationLoop: false,
        animationSpeed: 1,
        animationGeneration: 8,
      },
    };
    updateEntityAnimation(stopped, root, 1.6, 0, false, onComplete);
    const rig = root.userData.rig!;
    expect(rig.leftArm.rotation.x).toBe(0);
    expect(rig.rightLeg.rotation.x).toBe(0);
    expect(onComplete).toHaveBeenCalledOnce();
  });

  it("animates animal and effect fallbacks from elapsed time and honors stop", () => {
    const animal = entity({
      id: "ANIMAL_0001",
      kind: "animal",
      assetId: "dog_generic_01",
      state: {
        type: "character",
        animation: "walk",
        animationPlaying: true,
        animationLoop: true,
        animationSpeed: 1,
        animationGeneration: 1,
      },
    });
    const animalRoot = createProceduralEntity(animal);
    updateEntityAnimation(animal, animalRoot, 0, 0.2);
    expect(animalRoot.userData.animalRig?.legs.some((leg) => Math.abs(leg.rotation.x) > 0.01)).toBe(true);

    const stoppedEffect = entity({
      id: "EFFECT_0001",
      kind: "effect",
      assetId: "effect_rain_01",
      state: {
        type: "effect",
        enabled: true,
        animation: "idle",
        animationPlaying: false,
        animationLoop: true,
        animationSpeed: 1,
        animationGeneration: 1,
      },
    });
    const effectRoot = createProceduralEntity(stoppedEffect);
    const particle = effectRoot.userData.effectParticles![0]!;
    const initial = particle.position.clone();
    updateEntityAnimation(stoppedEffect, effectRoot, 0, 1);
    expect(particle.position).toEqual(initial);

    const playingEffect: EntityState = {
      ...stoppedEffect,
      state: {
        type: "effect",
        enabled: true,
        animation: "idle",
        animationPlaying: true,
        animationLoop: true,
        animationSpeed: 1,
        animationGeneration: 2,
      },
    };
    updateEntityAnimation(playingEffect, effectRoot, 0, 0.2);
    expect(particle.position.equals(initial)).toBe(false);
  });

  it("finishes non-looping playback immediately when reduced motion is enabled", () => {
    const oneShot = entity({
      id: "CHAR_REDUCED",
      kind: "character",
      assetId: "humanoid_generic_01",
      state: {
        type: "character",
        animation: "enter",
        animationPlaying: true,
        animationLoop: false,
        animationSpeed: 1,
        animationGeneration: 2,
      },
    });
    const onComplete = vi.fn();
    updateEntityAnimation(oneShot, createProceduralEntity(oneShot), 0, 0, true, onComplete);
    expect(onComplete).toHaveBeenCalledWith({ entityId: "CHAR_REDUCED", clip: "enter", generation: 2 });
  });
});
