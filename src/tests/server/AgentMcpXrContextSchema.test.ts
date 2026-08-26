import { describe, expect, it } from "vitest";
import { liveXrContextMcpResultSchema } from "../../../server/agent/AgentMcpServer";

const pose = {
  position: { x: 1.25, y: 1.7, z: -2.5 },
  orientation: { x: 0, y: 0, z: 0, w: 1 },
} as const;

function liveResult() {
  return {
    ok: true,
    data: {
      command: "get_live_xr_context",
      phase: "active",
      message: "Fresh XR context.",
      source: "remote_headset",
      maximum_age_ms: 1_000,
      age_ms: 39.75,
      context: {
        format: "semaframe-xr-context",
        version: "1.2",
        ephemeral: true,
        persistence: "forbidden",
        source: "immersive-xr",
        workspaceId: "workspace-xr-schema",
        workspaceRevision: 12,
        sampleSequence: 73,
        capturedAtMs: 1_777_777_777_777,
        tracking: {
          state: "tracked",
          headPoseState: "tracked",
          sourceTimestampMs: 8_214.25,
          sourceTimestampBasis: "performance-time-origin",
          sourceAgeMs: 11.75,
          sessionVisibility: "visible",
        },
        referenceSpace: "local-floor",
        headPose: pose,
        trackedInputs: [{
          sourceId: "xr-source-right",
          handedness: "right",
          trackingState: "tracked",
          targetRayMode: "tracked-pointer",
          targetRayPose: pose,
          gripPose: pose,
          ray: {
            origin: pose.position,
            direction: { x: 0, y: 0, z: -1 },
            maxDistance: 40,
          },
          rayHit: {
            kind: "component",
            targetId: "component-control",
            point: { x: 1.25, y: 1.7, z: -4 },
            normal: { x: 0, y: 0, z: 1 },
            distance: 1.5,
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
        primaryInputSourceId: "xr-source-right",
        activeInputSourceId: "xr-source-right",
        primaryRay: {
          origin: pose.position,
          direction: { x: 0, y: 0, z: -1 },
          maxDistance: 40,
        },
        rayHit: {
          kind: "component",
          targetId: "component-control",
          point: { x: 1.25, y: 1.7, z: -4 },
          normal: { x: 0, y: 0, z: 1 },
          distance: 1.5,
        },
        selectedComponentId: "component-control",
        spatialPin: {
          pinId: "pin-12-1",
          pinSequence: 1,
          workspacePositionM: { x: 1.25, y: 1.7, z: -4 },
          surfaceNormal: { x: 0, y: 0, z: 1 },
          hitKind: "component",
          targetComponentId: "component-control",
          sourceId: "xr-source-right",
          handedness: "right",
          placedAtMs: 1_777_777_777_700,
          placedAtWorkspaceRevision: 12,
          coordinateSpace: "workspace-world-rub",
          units: "metre",
          authority: "render-interaction-estimate",
        },
        playerCapsule: {
          feet: { x: 1.25, y: 0, z: -2.5 },
          radius: 0.3,
          height: 1.7,
        },
      },
    },
  } as const;
}

type MutableLiveResult = {
  data: {
    context: {
      version: string;
      trackedInputs: Array<Record<string, unknown>>;
    };
  };
};

describe("Agent MCP live XR user-state output", () => {
  it("accepts the complete discoverable v1.2 snapshot including fractional renderer timing", () => {
    const parsed = liveXrContextMcpResultSchema.parse(liveResult());

    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.data.context.trackedInputs[0]).toMatchObject({
      sourceId: "xr-source-right",
      gripPose: pose,
      actions: { available: true, selectPressed: true },
    });
    expect(parsed.data.context.tracking).toMatchObject({
      sourceTimestampBasis: "performance-time-origin",
      sourceTimestampMs: 8_214.25,
      sourceAgeMs: 11.75,
    });
    expect(parsed.data.age_ms).toBe(39.75);
  });

  it("fails closed when user-state fields are missing or undeclared fields are added", () => {
    const missingActions = structuredClone(liveResult()) as unknown as MutableLiveResult;
    delete missingActions.data.context.trackedInputs[0].actions;
    expect(liveXrContextMcpResultSchema.safeParse(missingActions).success).toBe(false);

    const hiddenRawInput = structuredClone(liveResult()) as unknown as MutableLiveResult;
    hiddenRawInput.data.context.trackedInputs[0].rawGamepad = { buttons: [1] };
    expect(liveXrContextMcpResultSchema.safeParse(hiddenRawInput).success).toBe(false);

    const legacyVersion = structuredClone(liveResult()) as unknown as MutableLiveResult;
    legacyVersion.data.context.version = "1.1";
    expect(liveXrContextMcpResultSchema.safeParse(legacyVersion).success).toBe(false);

    const desktopSimulator = structuredClone(liveResult()) as unknown as MutableLiveResult & {
      data: { context: { source: string } };
    };
    desktopSimulator.data.context.source = "desktop-simulator";
    expect(liveXrContextMcpResultSchema.safeParse(desktopSimulator).success).toBe(false);
  });
});
