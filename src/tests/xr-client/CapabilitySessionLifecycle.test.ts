import { describe, expect, it, vi } from "vitest";
import {
  evaluateXRCapabilities,
  type XRRuntimeCapabilities,
  type XRRuntimePort,
  type XRSessionPort,
  type XRSessionRequest,
  XRSessionLifecycle,
  XR_CONTROLLER_VR_REQUIREMENT,
} from "../../xr/client";

const CAPABILITIES: XRRuntimeCapabilities = {
  runtimeId: "fake-webxr",
  available: true,
  sessionModes: ["immersive-vr"],
  referenceSpaces: ["local-floor", "bounded-floor"],
  features: ["local-floor", "bounded-floor", "layers"],
  inputCapabilities: ["controller"],
};

class FakeSession implements XRSessionPort {
  readonly id = "session-1";
  readonly mode = "immersive-vr" as const;
  readonly referenceSpace = "local-floor" as const;
  readonly end = vi.fn(async () => undefined);
  private readonly listeners = new Set<(reason: string) => void>();

  onEnded(listener: (reason: string) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  emitEnded(reason: string): void {
    for (const listener of this.listeners) listener(reason);
  }
}

class FakeRuntime implements XRRuntimePort {
  readonly session = new FakeSession();
  readonly requests: XRSessionRequest[] = [];
  capabilities: XRRuntimeCapabilities = CAPABILITIES;

  async probe(): Promise<XRRuntimeCapabilities> {
    return this.capabilities;
  }

  async requestSession(request: XRSessionRequest): Promise<XRSessionPort> {
    this.requests.push(request);
    return this.session;
  }
}

describe("XR capability and session lifecycle", () => {
  it("reports exact missing capabilities without consulting browser globals", () => {
    const decision = evaluateXRCapabilities({
      ...CAPABILITIES,
      sessionModes: [],
      features: [],
      inputCapabilities: [],
    }, XR_CONTROLLER_VR_REQUIREMENT);

    expect(decision.supported).toBe(false);
    expect(decision.missing).toEqual([
      "mode:immersive-vr",
      "feature:local-floor",
      "input:controller",
    ]);
  });

  it("probes, starts, and ends one injected session deterministically", async () => {
    const runtime = new FakeRuntime();
    const lifecycle = new XRSessionLifecycle(runtime, XR_CONTROLLER_VR_REQUIREMENT);
    const phases: string[] = [];
    lifecycle.subscribe(({ phase }) => phases.push(phase));

    expect((await lifecycle.probe()).phase).toBe("ready");
    expect(await lifecycle.start({
      mode: "immersive-vr",
      requiredFeatures: ["local-floor"],
      optionalFeatures: ["layers"],
    })).toMatchObject({ phase: "active", sessionId: "session-1" });
    expect(runtime.requests).toEqual([{
      mode: "immersive-vr",
      requiredFeatures: ["local-floor"],
      optionalFeatures: ["layers"],
    }]);

    expect((await lifecycle.end()).phase).toBe("ended");
    expect(runtime.session.end).toHaveBeenCalledOnce();
    expect(phases).toEqual(["idle", "probing", "ready", "requesting", "active", "ending", "ended"]);
  });

  it("handles an unexpected runtime end once and removes the old listener", async () => {
    const runtime = new FakeRuntime();
    const lifecycle = new XRSessionLifecycle(runtime, XR_CONTROLLER_VR_REQUIREMENT);
    await lifecycle.probe();
    await lifecycle.start({ mode: "immersive-vr", requiredFeatures: ["local-floor"] });

    runtime.session.emitEnded("visibility_lost");
    expect(lifecycle.snapshot).toMatchObject({ phase: "ended", endReason: "visibility_lost" });
    runtime.session.emitEnded("stale_event");
    expect(lifecycle.snapshot.endReason).toBe("visibility_lost");
  });

  it("fails closed when the runtime cannot meet the controller-floor profile", async () => {
    const runtime = new FakeRuntime();
    runtime.capabilities = { ...CAPABILITIES, inputCapabilities: [] };
    const lifecycle = new XRSessionLifecycle(runtime, XR_CONTROLLER_VR_REQUIREMENT);

    expect(await lifecycle.probe()).toMatchObject({
      phase: "unsupported",
      capability: { supported: false, missing: ["input:controller"] },
    });
    await expect(lifecycle.start({
      mode: "immersive-vr",
      requiredFeatures: ["local-floor"],
    })).rejects.toMatchObject({ code: "unsupported" });
    expect(runtime.requests).toEqual([]);
  });

  it("does not let a caller omit a baseline feature after a successful probe", async () => {
    const runtime = new FakeRuntime();
    const lifecycle = new XRSessionLifecycle(runtime, XR_CONTROLLER_VR_REQUIREMENT);
    await lifecycle.probe();

    await expect(lifecycle.start({ mode: "immersive-vr", requiredFeatures: [] }))
      .rejects.toMatchObject({ code: "required_feature_omitted" });
    expect(runtime.requests).toEqual([]);
  });
});
