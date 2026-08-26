import { describe, expect, it } from "vitest";
import { xrRenderProfileForGate } from "../../xr/ultra";

describe("XR render profile gate", () => {
  it("defaults to the bounded cross-platform profile", () => {
    expect(xrRenderProfileForGate()).toMatchObject({
      mode: "balanced",
      targetFrameRateHz: 72,
      framebufferScaleFactor: 0.82,
    });
  });

  it("does not unlock from a requested or locked Ultra state", () => {
    expect(xrRenderProfileForGate({ effectiveMode: "balanced", state: "locked" }).mode).toBe("balanced");
    expect(xrRenderProfileForGate({ effectiveMode: "ultra", state: "locked" }).mode).toBe("balanced");
  });

  it("does not unlock from a JSON-forgeable eligible-looking decision", () => {
    expect(xrRenderProfileForGate({ effectiveMode: "ultra", state: "eligible" }).mode)
      .toBe("balanced");
  });
});
