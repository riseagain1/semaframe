import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { createRef } from "react";
import { describe, expect, it, vi } from "vitest";
import {
  XRWorkspaceButton,
  type XRWorkspaceButtonHandle,
  type XRWorkspaceRuntime,
} from "../../app/components/XRWorkspaceButton";
import type { HybridWorkspaceCanvasHandle } from "../../app/components/workspace/HybridWorkspaceCanvas";
import { WebXRSessionAdapter } from "../../xr/webxr";
import {
  ULTRA_BENCHMARK_WORKLOAD_ID,
  ULTRA_GIB,
  ULTRA_POLICY_VERSION,
  type UltraLocalEvidencePort,
  type UltraRuntimeBenchmarkInput,
  type UltraStaticProbe,
} from "../../xr/ultra";

function rawSession() {
  const target = new EventTarget() as EventTarget & { end: ReturnType<typeof vi.fn> };
  target.end = vi.fn(async () => target.dispatchEvent(new Event("end")));
  return target as unknown as XRSession;
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

function canvas(overrides: Partial<HybridWorkspaceCanvasHandle> = {}): HybridWorkspaceCanvasHandle {
  return {
    getContainer: () => null,
    getRenderer: () => null,
    resize: vi.fn(),
    frameAll: vi.fn(),
    resetView: vi.fn(),
    zoomIn: vi.fn(),
    zoomOut: vi.fn(),
    startRealityMeasurement: vi.fn(() => false),
    cancelRealityMeasurement: vi.fn(),
    cancelActiveInteractions: vi.fn(),
    enterXR: vi.fn(async () => undefined),
    exitXR: vi.fn(async () => undefined),
    isXRPresenting: vi.fn(() => false),
    ...overrides,
  };
}

describe("XRWorkspaceButton", () => {
  it("reports a browser without immersive WebXR without requesting a session", async () => {
    const runtime: XRWorkspaceRuntime = {
      probe: vi.fn(async () => ({
        runtimeId: "test",
        available: false,
        sessionModes: [] as const,
        referenceSpaces: [] as const,
        features: [] as const,
        inputCapabilities: [] as const,
      })),
      requestSession: vi.fn(),
    };
    render(<XRWorkspaceButton getCanvas={() => canvas()} runtime={runtime} />);
    const button = await screen.findByRole("button", { name: "Immersive WebXR is unavailable in this browser" });
    expect(button).toBeDisabled();
    expect(runtime.requestSession).not.toHaveBeenCalled();
  });

  it("attaches one user-activated session to the existing renderer and exits it", async () => {
    const browserSession = rawSession();
    const adapter = new WebXRSessionAdapter(browserSession, "immersive-vr", "bounded-floor");
    const runtime: XRWorkspaceRuntime = {
      probe: vi.fn(async () => ({
        runtimeId: "test",
        available: true,
        sessionModes: ["immersive-vr"] as const,
        referenceSpaces: ["bounded-floor"] as const,
        features: ["local-floor", "bounded-floor", "hand-tracking", "layers"] as const,
        inputCapabilities: ["controller"] as const,
      })),
      requestSession: vi.fn(async () => adapter),
    };
    const existingCanvas = canvas({
      // Exercise the real ownership order: ThreeRenderer.exitXR ends the raw
      // session, which synchronously notifies WebXRSessionAdapter.
      exitXR: vi.fn(async () => adapter.end()),
    });
    const phases: string[] = [];
    render(<XRWorkspaceButton
      getCanvas={() => existingCanvas}
      runtime={runtime}
      onPhaseChange={(phase) => phases.push(phase)}
    />);

    const enter = await screen.findByRole("button", { name: "Enter immersive XR" });
    fireEvent.click(enter);
    await screen.findByRole("button", { name: "Exit immersive XR" });
    expect(existingCanvas.enterXR).toHaveBeenCalledWith(browserSession, {
      referenceSpaceType: "bounded-floor",
      framebufferScaleFactor: 0.82,
      foveation: 0.65,
      targetFrameRateHz: 72,
      teleport: true,
    });
    expect(runtime.requestSession).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole("button", { name: "Exit immersive XR" }));
    await waitFor(() => expect(existingCanvas.exitXR).toHaveBeenCalledTimes(1));
    expect(await screen.findByRole("button", { name: "Enter immersive XR" })).toHaveAttribute("aria-pressed", "false");
    expect(phases).toContain("active");
    expect(phases).toContain("ending");
  });

  it("returns an explicit unconfirmed outcome when the local renderer cannot exit XR", async () => {
    const browserSession = rawSession();
    const adapter = new WebXRSessionAdapter(browserSession, "immersive-vr", "local-floor");
    const runtime: XRWorkspaceRuntime = {
      probe: vi.fn(async () => ({
        runtimeId: "test",
        available: true,
        sessionModes: ["immersive-vr"] as const,
        referenceSpaces: ["local-floor"] as const,
        features: ["local-floor"] as const,
        inputCapabilities: ["controller"] as const,
      })),
      requestSession: vi.fn(async () => adapter),
    };
    const existingCanvas = canvas({
      isXRPresenting: vi.fn(() => true),
      exitXR: vi.fn(async () => { throw new Error("renderer teardown failed"); }),
    });
    const control = createRef<XRWorkspaceButtonHandle>();
    const view = render(<XRWorkspaceButton ref={control} getCanvas={() => existingCanvas} runtime={runtime} />);
    fireEvent.click(await within(view.container).findByRole("button", { name: "Enter immersive XR" }));
    await within(view.container).findByRole("button", { name: "Exit immersive XR" });

    const outcome = await control.current!.exitFromUserGesture();

    expect(outcome).toEqual({
      locallyReleased: false,
      teardownConfirmed: false,
      error: "renderer teardown failed",
    });
    expect(browserSession.end).toHaveBeenCalledOnce();
    expect(await within(view.container).findByRole("button", { name: "renderer teardown failed" })).toBeEnabled();
  });

  it("ends a granted session if renderer attachment fails", async () => {
    const browserSession = rawSession();
    const adapter = new WebXRSessionAdapter(browserSession, "immersive-vr", "local-floor");
    const runtime: XRWorkspaceRuntime = {
      probe: vi.fn(async () => ({
        runtimeId: "test",
        available: true,
        sessionModes: ["immersive-vr"] as const,
        referenceSpaces: ["local-floor"] as const,
        features: ["local-floor"] as const,
        inputCapabilities: ["controller"] as const,
      })),
      requestSession: vi.fn(async () => adapter),
    };
    const existingCanvas = canvas({ enterXR: vi.fn(async () => { throw new Error("WebGL context lost"); }) });
    const view = render(<XRWorkspaceButton getCanvas={() => existingCanvas} runtime={runtime} />);
    fireEvent.click(await within(view.container).findByRole("button", { name: "Enter immersive XR" }));
    expect(await within(view.container).findByRole("button", { name: "WebGL context lost" })).toBeEnabled();
    expect(browserSession.end).toHaveBeenCalledTimes(1);
  });

  it("ends a permission result that arrives after the same-device control unmounts", async () => {
    const browserSession = rawSession();
    const adapter = new WebXRSessionAdapter(browserSession, "immersive-vr", "local-floor");
    const granted = deferred<WebXRSessionAdapter>();
    const runtime: XRWorkspaceRuntime = {
      probe: vi.fn(async () => ({
        runtimeId: "test",
        available: true,
        sessionModes: ["immersive-vr"] as const,
        referenceSpaces: ["local-floor"] as const,
        features: ["local-floor"] as const,
        inputCapabilities: ["controller"] as const,
      })),
      requestSession: vi.fn(() => granted.promise),
    };
    const existingCanvas = canvas();
    const view = render(<XRWorkspaceButton getCanvas={() => existingCanvas} runtime={runtime} />);
    fireEvent.click(await within(view.container).findByRole("button", { name: "Enter immersive XR" }));
    await waitFor(() => expect(runtime.requestSession).toHaveBeenCalledOnce());

    view.unmount();
    granted.resolve(adapter);
    await waitFor(() => expect(browserSession.end).toHaveBeenCalledOnce());

    expect(existingCanvas.enterXR).not.toHaveBeenCalled();
    expect(existingCanvas.exitXR).not.toHaveBeenCalled();
  });

  it("invalidates a pending permission result when project replacement explicitly exits XR", async () => {
    const browserSession = rawSession();
    const adapter = new WebXRSessionAdapter(browserSession, "immersive-vr", "local-floor");
    const granted = deferred<WebXRSessionAdapter>();
    const runtime: XRWorkspaceRuntime = {
      probe: vi.fn(async () => ({
        runtimeId: "test",
        available: true,
        sessionModes: ["immersive-vr"] as const,
        referenceSpaces: ["local-floor"] as const,
        features: ["local-floor"] as const,
        inputCapabilities: ["controller"] as const,
      })),
      requestSession: vi.fn(() => granted.promise),
    };
    const existingCanvas = canvas();
    const control = createRef<XRWorkspaceButtonHandle>();
    const view = render(<XRWorkspaceButton ref={control} getCanvas={() => existingCanvas} runtime={runtime} />);
    fireEvent.click(await within(view.container).findByRole("button", { name: "Enter immersive XR" }));
    await waitFor(() => expect(runtime.requestSession).toHaveBeenCalledOnce());

    await act(async () => { await control.current?.exitFromUserGesture(); });
    granted.resolve(adapter);
    await waitFor(() => expect(browserSession.end).toHaveBeenCalledOnce());

    expect(existingCanvas.enterXR).not.toHaveBeenCalled();
    expect(existingCanvas.exitXR).not.toHaveBeenCalled();
    expect(await within(view.container).findByRole("button", { name: "Enter immersive XR" })).toBeEnabled();
  });

  it("offers verified Ultra only after a fresh local probe, confirmation, and benchmark", async () => {
    const observedAt = new Date().toISOString();
    const evidence: UltraLocalEvidencePort = {
      collectStaticProbe: vi.fn(async (): Promise<UltraStaticProbe> => ({
        version: 1,
        policyVersion: ULTRA_POLICY_VERSION,
        platform: "windows",
        architecture: "x64",
        operatingSystemVersion: "11.0.26100",
        logicalProcessorCount: 16,
        systemMemoryBytes: 32 * ULTRA_GIB,
        graphics: {
          adapterFingerprint: "workspace-ultra-adapter",
          driverVersion: "580.1",
          hardwareAccelerated: true,
          supportedByRuntime: true,
        },
        runtime: { kind: "meta_horizon_link", version: "80.0", openXrActive: true },
        webXr: { browserEngine: "chromium", secureContext: true, immersiveVrSupported: true },
        collectedAt: observedAt,
      })),
      runPhysicalBenchmark: vi.fn(async (): Promise<UltraRuntimeBenchmarkInput> => ({
        version: 1,
        policyVersion: ULTRA_POLICY_VERSION,
        workloadId: ULTRA_BENCHMARK_WORKLOAD_ID,
        transport: "link_cable",
        targetFrameRateHz: 90,
        durationMs: 60_000,
        frameTimeSamplesMs: Array.from({ length: 5_400 }, () => 10),
        droppedFrameCount: 0,
        maximumConsecutiveDroppedFrames: 0,
        processRssSamplesBytes: Array.from({ length: 10 }, () => 2 * ULTRA_GIB),
        gpuMemoryUsageRatioSamples: Array.from({ length: 10 }, () => 0.6),
        gpuMemoryHeadroomSamplesBytes: Array.from({ length: 10 }, () => 3 * ULTRA_GIB),
        thermalThrottleObserved: false,
        runtimeDisconnectCount: 0,
        completedAt: observedAt,
      })),
    };
    const browserSession = rawSession();
    const runtime: XRWorkspaceRuntime = {
      probe: vi.fn(async () => ({
        runtimeId: "test",
        available: true,
        sessionModes: ["immersive-vr"] as const,
        referenceSpaces: ["local-floor"] as const,
        features: ["local-floor"] as const,
        inputCapabilities: ["controller"] as const,
      })),
      requestSession: vi.fn(async () => new WebXRSessionAdapter(browserSession, "immersive-vr", "local-floor")),
    };
    const existingCanvas = canvas();
    const view = render(<XRWorkspaceButton
      getCanvas={() => existingCanvas}
      runtime={runtime}
      ultraEvidence={evidence}
      confirmUltraActivation={() => true}
    />);

    const check = await within(view.container).findByRole("button", {
      name: "Check Windows PCVR Ultra compatibility",
    });
    expect(evidence.collectStaticProbe).not.toHaveBeenCalled();
    fireEvent.click(check);
    const verify = await within(view.container).findByRole("button", {
      name: "Start Windows PCVR Ultra benchmark",
    });
    fireEvent.click(verify);
    await within(view.container).findByRole("button", { name: "Windows PCVR Ultra enabled" });
    expect(evidence.runPhysicalBenchmark).toHaveBeenCalledWith(expect.objectContaining({
      probeFingerprint: expect.stringMatching(/^sha256:/),
      workloadId: ULTRA_BENCHMARK_WORKLOAD_ID,
      targetFrameRateHz: 90,
    }));

    fireEvent.click(await within(view.container).findByRole("button", { name: "Enter immersive XR" }));
    await within(view.container).findByRole("button", { name: "Exit immersive XR" });
    expect(existingCanvas.enterXR).toHaveBeenCalledWith(browserSession, {
      referenceSpaceType: "local-floor",
      framebufferScaleFactor: 1,
      foveation: 0.2,
      targetFrameRateHz: 90,
      teleport: true,
    });
  });
});
