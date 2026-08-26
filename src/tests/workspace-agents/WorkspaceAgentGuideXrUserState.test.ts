import { describe, expect, it } from "vitest";
import { WORKSPACE_AGENT_GUIDE_TEXT } from "../../workspace/agents/guide";

describe("Workspace Agent Guide XR user state", () => {
  it("teaches a one-call, identity-safe and freshness-aware reading path", () => {
    const guide = WORKSPACE_AGENT_GUIDE_TEXT.replace(/\s+/gu, " ");
    expect(guide).toContain(
      "call get_live_xr_context once for the newest fresh",
    );
    expect(guide).toContain(
      "headPose is the HMD/camera",
    );
    expect(guide).toContain(
      "playerCapsule is the room-scale body/clearance volume",
    );
    expect(guide).toContain(
      "Resolve primaryInputSourceId and activeInputSourceId by exact sourceId",
    );
    expect(guide).toContain(
      "targetRayPose, optional gripPose",
    );
    expect(guide).toContain(
      "data.age_ms is already the conservative end-to-end age",
    );
    expect(guide).toContain(
      "Never add sourceAgeMs a second time",
    );
    expect(guide).toContain(
      "sourceTimestampBasis explains the sourceTimestampMs clock",
    );
    expect(guide).toContain(
      "actions.available false means button state was not observable",
    );
    expect(guide).toContain(
      "read it only from data.context.spatialPin",
    );
  });
});
