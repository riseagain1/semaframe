import { describe, expect, it } from "vitest";
import {
  controllerRayFromPose,
  createXRContextEnvelope,
  parseXRContextEnvelope,
  pickNearestControllerRayTarget,
  planSnapTurn,
  planTeleport,
  playerCapsuleIntersectsAabb,
  validatePlayerCapsulePlacement,
  type XRContextEnvelope,
  type XRPlayerCapsule,
} from "../../xr/client";

const IDENTITY = { x: 0, y: 0, z: 0, w: 1 } as const;
const CAPSULE: XRPlayerCapsule = { feet: { x: 0, y: 0, z: 0 }, radius: 0.3, height: 1.8 };

function context(): XRContextEnvelope {
  return createXRContextEnvelope({
    source: "immersive-xr",
    workspaceId: "workspace-main",
    workspaceRevision: 7,
    capturedAtMs: 100,
    sampleSequence: 42,
    tracking: {
      state: "tracked",
      headPoseState: "tracked",
      sourceTimestampMs: 2_500.5,
      sourceTimestampBasis: "performance-time-origin",
      sourceAgeMs: 4.5,
      sessionVisibility: "visible",
    },
    referenceSpace: "local-floor",
    headPose: { position: { x: 0, y: 1.65, z: 0 }, orientation: IDENTITY },
    trackedInputs: [{
      sourceId: "right-controller",
      handedness: "right",
      trackingState: "tracked",
      targetRayMode: "tracked-pointer",
      targetRayPose: { position: { x: 0.2, y: 1.2, z: 0 }, orientation: IDENTITY },
      gripPose: { position: { x: 0.18, y: 1.16, z: 0.04 }, orientation: IDENTITY },
      ray: { origin: { x: 0.2, y: 1.2, z: 0 }, direction: { x: 0, y: 0, z: -4 }, maxDistance: 20 },
      rayHit: {
        kind: "component",
        targetId: "table",
        point: { x: 0.2, y: 1.2, z: -2 },
        normal: { x: 0, y: 0, z: 2 },
        distance: 2,
      },
      actions: {
        available: true,
        selectPressed: true,
        squeezePressed: false,
        primaryButtonPressed: false,
        secondaryButtonPressed: false,
        thumbstickPressed: false,
        thumbstick: { x: 0.25, y: -0.5 },
      },
    }],
    primaryInputSourceId: "right-controller",
    activeInputSourceId: "right-controller",
    primaryRay: { origin: { x: 0.2, y: 1.2, z: 0 }, direction: { x: 0, y: 0, z: -4 }, maxDistance: 20 },
    rayHit: {
      kind: "component",
      targetId: "table",
      point: { x: 0.2, y: 1.2, z: -2 },
      normal: { x: 0, y: 0, z: 2 },
      distance: 2,
    },
    spatialPin: {
      pinId: "xr-pin-1",
      pinSequence: 1,
      workspacePositionM: { x: 0.2, y: 1.2, z: -2 },
      surfaceNormal: { x: 0, y: 0, z: 2 },
      hitKind: "component",
      targetComponentId: "table",
      sourceId: "right-controller",
      handedness: "right",
      placedAtMs: 90,
      placedAtWorkspaceRevision: 7,
      coordinateSpace: "workspace-world-rub",
      units: "metre",
      authority: "render-interaction-estimate",
    },
    selectedComponentId: "table",
    playerCapsule: CAPSULE,
  });
}

describe("XR context and pure spatial input", () => {
  it("creates a normalized, revision-bound, explicitly ephemeral context", () => {
    const envelope = context();
    expect(envelope).toMatchObject({
      format: "semaframe-xr-context",
      version: "1.2",
      ephemeral: true,
      persistence: "forbidden",
      workspaceRevision: 7,
      sampleSequence: 42,
      primaryInputSourceId: "right-controller",
      activeInputSourceId: "right-controller",
      selectedComponentId: "table",
    });
    expect(envelope.tracking).toEqual({
      state: "tracked",
      headPoseState: "tracked",
      sourceTimestampMs: 2_500.5,
      sourceTimestampBasis: "performance-time-origin",
      sourceAgeMs: 4.5,
      sessionVisibility: "visible",
    });
    expect(envelope.trackedInputs[0]).toMatchObject({
      sourceId: "right-controller",
      trackingState: "tracked",
      targetRayMode: "tracked-pointer",
      actions: {
        available: true,
        selectPressed: true,
        thumbstick: { x: 0.25, y: -0.5 },
      },
      ray: { direction: { x: 0, y: 0, z: -1 } },
      rayHit: { normal: { x: 0, y: 0, z: 1 } },
    });
    expect(envelope.primaryRay?.direction).toEqual({ x: 0, y: 0, z: -1 });
    expect(envelope.rayHit?.normal).toEqual({ x: 0, y: 0, z: 1 });
    expect(envelope.spatialPin).toMatchObject({
      pinId: "xr-pin-1",
      workspacePositionM: { x: 0.2, y: 1.2, z: -2 },
      surfaceNormal: { x: 0, y: 0, z: 1 },
      authority: "render-interaction-estimate",
    });
    expect(Object.isFrozen(envelope)).toBe(true);
    expect(Object.isFrozen(envelope.trackedInputs)).toBe(true);
  });

  it("rejects stale-shaped or persistable-looking context inputs", () => {
    expect(() => createXRContextEnvelope({
      ...context(),
      workspaceRevision: -1,
    })).toThrow(/workspaceRevision/u);
    expect(() => createXRContextEnvelope({
      ...context(),
      primaryRay: undefined,
    })).toThrow(/rayHit requires primaryRay/u);
    expect(() => parseXRContextEnvelope({
      ...context(),
      unexpected: true,
    })).toThrow(/fields are invalid/u);
    expect(() => parseXRContextEnvelope({
      ...context(),
      headPose: { ...context().headPose, unexpected: true },
    })).toThrow(/headPose fields are invalid/u);
    expect(parseXRContextEnvelope(structuredClone(context()))).toEqual(context());
    const legacy11 = structuredClone(context()) as unknown as Record<string, unknown>;
    legacy11.version = "1.1";
    delete legacy11.sampleSequence;
    delete legacy11.tracking;
    delete legacy11.primaryInputSourceId;
    delete legacy11.activeInputSourceId;
    for (const input of legacy11.trackedInputs as Record<string, unknown>[]) {
      delete input.trackingState;
      delete input.targetRayMode;
      delete input.ray;
      delete input.rayHit;
      delete input.actions;
    }
    expect(parseXRContextEnvelope(legacy11)).toMatchObject({
      version: "1.2",
      workspaceRevision: 7,
      sampleSequence: 0,
      tracking: { state: "unknown", sourceTimestampBasis: "unknown" },
    });
    const legacy10 = structuredClone(legacy11);
    legacy10.version = "1.0";
    delete legacy10.spatialPin;
    expect(parseXRContextEnvelope(legacy10)).toMatchObject({ version: "1.2", workspaceRevision: 7 });
    expect(() => parseXRContextEnvelope({ ...legacy11, version: "1.0" })).toThrow(/1\.0 cannot contain spatialPin/u);
    const incompleteV12 = structuredClone(context()) as unknown as Record<string, unknown>;
    delete incompleteV12.tracking;
    expect(() => parseXRContextEnvelope(incompleteV12)).toThrow(/requires sampleSequence and tracking/u);
  });

  it("strictly validates Agent-facing source identities, action state, and per-input rays", () => {
    expect(() => createXRContextEnvelope({
      ...context(),
      primaryInputSourceId: "missing-controller",
    })).toThrow(/must identify a tracked input/u);
    expect(() => createXRContextEnvelope({
      ...context(),
      trackedInputs: [{
        ...context().trackedInputs[0]!,
        actions: { ...context().trackedInputs[0]!.actions, thumbstick: { x: 1.1, y: 0 } },
      }],
    })).toThrow(/axes must be in/u);
    expect(() => createXRContextEnvelope({
      ...context(),
      trackedInputs: [{
        ...context().trackedInputs[0]!,
        actions: {
          ...context().trackedInputs[0]!.actions,
          available: false,
          selectPressed: true,
        },
      }],
    })).toThrow(/cannot report actions when unavailable/u);
    expect(() => createXRContextEnvelope({
      ...context(),
      trackedInputs: [{
        ...context().trackedInputs[0]!,
        ray: undefined,
      }],
    })).toThrow(/rayHit requires ray/u);
    expect(() => createXRContextEnvelope({
      ...context(),
      primaryRay: {
        ...context().primaryRay!,
        maxDistance: 30,
      },
    })).toThrow(/must mirror the primary tracked input ray/u);
    expect(() => createXRContextEnvelope({
      ...context(),
      rayHit: {
        ...context().rayHit!,
        kind: "surface",
        targetId: undefined,
      },
    })).toThrow(/must mirror the primary tracked input hit/u);
    expect(() => createXRContextEnvelope({
      ...context(),
      primaryInputSourceId: undefined,
    })).toThrow(/must be present together/u);
    expect(() => createXRContextEnvelope({
      ...context(),
      tracking: { ...context().tracking, sessionVisibility: "hidden" },
    })).toThrow(/hidden XR visibility requires lost/u);
    expect(() => createXRContextEnvelope({
      ...context(),
      trackedInputs: [{
        ...context().trackedInputs[0]!,
        trackingState: "unknown",
      }],
    })).toThrow(/cannot expose spatial evidence while tracking is unknown/u);
    expect(() => createXRContextEnvelope({
      ...context(),
      trackedInputs: [{
        ...context().trackedInputs[0]!,
        trackingState: "emulated",
      }],
    })).toThrow(/tracked aggregate state requires/u);
  });

  it("builds a controller ray from pose and selects the nearest enabled target", () => {
    const ray = controllerRayFromPose({
      position: { x: 0, y: 1, z: 0 },
      orientation: IDENTITY,
    });
    const hit = pickNearestControllerRayTarget(ray, [
      { id: "far", bounds: { min: { x: -1, y: 0, z: -6 }, max: { x: 1, y: 2, z: -5 } } },
      { id: "disabled", selectable: false, bounds: { min: { x: -1, y: 0, z: -2 }, max: { x: 1, y: 2, z: -1 } } },
      { id: "near", bounds: { min: { x: -1, y: 0, z: -4 }, max: { x: 1, y: 2, z: -3 } } },
    ]);
    expect(hit).toMatchObject({ targetId: "near", distance: 3, point: { x: 0, y: 1, z: -3 } });
  });

  it("uses a vertical capsule rather than a loose AABB for user clearance", () => {
    expect(playerCapsuleIntersectsAabb(CAPSULE, {
      min: { x: 0.25, y: 0.7, z: -0.05 },
      max: { x: 0.35, y: 1.1, z: 0.05 },
    })).toBe(true);
    expect(playerCapsuleIntersectsAabb(CAPSULE, {
      min: { x: 0.31, y: 0.7, z: 0.31 },
      max: { x: 0.4, y: 1.1, z: 0.4 },
    })).toBe(false);
    expect(validatePlayerCapsulePlacement(CAPSULE, [{
      id: "lamp",
      bounds: { min: { x: -0.1, y: 0, z: -0.1 }, max: { x: 0.1, y: 2, z: 0.1 } },
    }])).toEqual({ valid: false, conflicts: ["lamp"] });
  });

  it("plans teleport only onto a bounded floor with a collision-free capsule", () => {
    const ray = {
      origin: { x: 0, y: 1.6, z: 0 },
      direction: { x: 0, y: -0.5, z: -Math.sqrt(0.75) },
      maxDistance: 10,
    } as const;
    const surface = {
      id: "room-floor",
      height: 0,
      boundary: [{ x: -5, y: -5 }, { x: 5, y: -5 }, { x: 5, y: 5 }, { x: -5, y: 5 }],
    } as const;
    const clear = planTeleport({ ray, currentFeet: CAPSULE.feet, capsule: CAPSULE, surfaces: [surface] });
    expect(clear).toMatchObject({ valid: true, surfaceId: "room-floor", targetFeet: { y: 0 } });
    if (!clear.valid) throw new Error("Expected a clear teleport plan");
    const blocked = planTeleport({
      ray,
      currentFeet: CAPSULE.feet,
      capsule: CAPSULE,
      surfaces: [surface],
      obstacles: [{
        id: "sofa",
        bounds: {
          min: { x: clear.targetFeet.x - 0.2, y: 0, z: clear.targetFeet.z - 0.2 },
          max: { x: clear.targetFeet.x + 0.2, y: 1, z: clear.targetFeet.z + 0.2 },
        },
      }],
    });
    expect(blocked).toEqual({ valid: false, reason: "collision", conflicts: ["sofa"] });
  });

  it("snap-turns the rig around the tracked head instead of orbiting the user", () => {
    const result = planSnapTurn({
      direction: "left",
      incrementDegrees: 30,
      currentYawRadians: 0,
      rigPosition: { x: 0, y: 0, z: 0 },
      headWorldPosition: { x: 0.2, y: 1.65, z: 0.1 },
    });
    const cosine = Math.cos(result.deltaRadians);
    const sine = Math.sin(result.deltaRadians);
    const oldOffset = { x: 0.2, y: 1.65, z: 0.1 };
    const rotatedOffset = {
      x: oldOffset.x * cosine + oldOffset.z * sine,
      y: oldOffset.y,
      z: -oldOffset.x * sine + oldOffset.z * cosine,
    };
    expect({
      x: result.nextRigPosition.x + rotatedOffset.x,
      y: result.nextRigPosition.y + rotatedOffset.y,
      z: result.nextRigPosition.z + rotatedOffset.z,
    }).toEqual(expect.objectContaining({ x: expect.closeTo(0.2), y: expect.closeTo(1.65), z: expect.closeTo(0.1) }));
  });
});
