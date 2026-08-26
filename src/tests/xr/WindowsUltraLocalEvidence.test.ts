import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ULTRA_BENCHMARK_WORKLOAD_ID,
  runWindowsUltraPhysicalBenchmark,
  type UltraLocalBenchmarkRequest,
  type UltraRuntimeSystemSample,
  type UltraSystemEvidenceClient,
} from "../../xr/ultra";

type FrameMode = "microtask" | "timer" | "stall";

function request(minimumDurationMs: number, signal = new AbortController().signal) {
  return {
    signal,
    probeFingerprint: `sha256:${"f".repeat(64)}`,
    workloadId: ULTRA_BENCHMARK_WORKLOAD_ID,
    // Production supplies the 60,000 ms contract literal. Focused lifecycle
    // tests deliberately compress the same scheduling logic.
    minimumDurationMs,
    targetFrameRateHz: 90,
  } as unknown as UltraLocalBenchmarkRequest;
}

function runtimeSample(): UltraRuntimeSystemSample {
  return {
    version: 1,
    transport: "link_cable",
    processRssBytes: 512 * 1024 * 1024,
    gpuMemoryUsageRatio: 0.25,
    gpuMemoryHeadroomBytes: 8 * 1024 * 1024 * 1024,
    thermalThrottleObserved: false,
    runtimeConnected: true,
    sampledAt: new Date().toISOString(),
  };
}

function createGl() {
  const gl = {
    VERTEX_SHADER: 1,
    FRAGMENT_SHADER: 2,
    COMPILE_STATUS: 3,
    LINK_STATUS: 4,
    TRIANGLES: 5,
    FRAMEBUFFER: 6,
    DEPTH_TEST: 7,
    COLOR_BUFFER_BIT: 8,
    DEPTH_BUFFER_BIT: 16,
    TEXTURE_2D: 17,
    TEXTURE0: 18,
    TEXTURE1: 19,
    TEXTURE_MIN_FILTER: 20,
    TEXTURE_MAG_FILTER: 21,
    TEXTURE_WRAP_S: 22,
    TEXTURE_WRAP_T: 23,
    LINEAR_MIPMAP_LINEAR: 24,
    LINEAR: 25,
    NEAREST: 26,
    REPEAT: 27,
    CLAMP_TO_EDGE: 28,
    RGBA8: 29,
    RGBA: 30,
    UNSIGNED_BYTE: 31,
    DEPTH_COMPONENT24: 32,
    DEPTH_COMPONENT: 33,
    UNSIGNED_INT: 34,
    DEPTH_ATTACHMENT: 35,
    NONE: 36,
    FRAMEBUFFER_COMPLETE: 37,
    createShader: vi.fn(() => ({})),
    shaderSource: vi.fn(),
    compileShader: vi.fn(),
    getShaderParameter: vi.fn(() => true),
    getShaderInfoLog: vi.fn(() => ""),
    deleteShader: vi.fn(),
    createProgram: vi.fn(() => ({})),
    attachShader: vi.fn(),
    linkProgram: vi.fn(),
    getProgramParameter: vi.fn(() => true),
    getProgramInfoLog: vi.fn(() => ""),
    deleteProgram: vi.fn(),
    createVertexArray: vi.fn(() => ({})),
    bindVertexArray: vi.fn(),
    deleteVertexArray: vi.fn(),
    createTexture: vi.fn(() => ({})),
    deleteTexture: vi.fn(),
    activeTexture: vi.fn(),
    bindTexture: vi.fn(),
    texParameteri: vi.fn(),
    texImage2D: vi.fn(),
    generateMipmap: vi.fn(),
    createFramebuffer: vi.fn(() => ({})),
    deleteFramebuffer: vi.fn(),
    framebufferTexture2D: vi.fn(),
    drawBuffers: vi.fn(),
    readBuffer: vi.fn(),
    checkFramebufferStatus: vi.fn(() => 37),
    getUniformLocation: vi.fn(() => ({})),
    uniform1i: vi.fn(),
    uniform1f: vi.fn(),
    colorMask: vi.fn(),
    useProgram: vi.fn(),
    drawArraysInstanced: vi.fn(),
    bindFramebuffer: vi.fn(),
    enable: vi.fn(),
    clearColor: vi.fn(),
    clear: vi.fn(),
    viewport: vi.fn(),
    makeXRCompatible: vi.fn(async () => undefined),
  };
  return gl;
}

function createSession(
  frameMode: FrameMode = "microtask",
  wallIntervalMs = 1,
  timestampStepMs = 1,
) {
  const endListeners = new Set<() => void>();
  let frameTime = 0;
  let frameHandle = 0;
  const session = {
    supportedFrameRates: new Float32Array([72, 90]),
    updateTargetFrameRate: vi.fn(async () => undefined),
    updateRenderState: vi.fn(),
    requestReferenceSpace: vi.fn(async () => ({})),
    requestAnimationFrame: vi.fn((callback: XRFrameRequestCallback) => {
      frameHandle += 1;
      if (frameMode === "stall") return frameHandle;
      const deliver = () => {
        frameTime += timestampStepMs;
        callback(frameTime, {
          getViewerPose: () => ({ views: [{}] }),
        } as unknown as XRFrame);
      };
      if (frameMode === "timer") globalThis.setTimeout(deliver, wallIntervalMs);
      else queueMicrotask(deliver);
      return frameHandle;
    }),
    addEventListener: vi.fn((type: string, listener: () => void) => {
      if (type === "end") endListeners.add(listener);
    }),
    removeEventListener: vi.fn((type: string, listener: () => void) => {
      if (type === "end") endListeners.delete(listener);
    }),
    end: vi.fn(async () => {
      for (const listener of [...endListeners]) listener();
    }),
  };
  return { session, endListeners };
}

function installRuntime(
  gl: ReturnType<typeof createGl>,
  session: ReturnType<typeof createSession>["session"],
) {
  const isSessionSupported = vi.fn(async () => true);
  const requestSession = vi.fn(async () => session);
  vi.stubGlobal("navigator", { xr: { isSessionSupported, requestSession } });
  class FakeLayer {
    readonly framebuffer = {};
    getViewport() {
      return { x: 0, y: 0, width: 1024, height: 1024 };
    }
  }
  vi.stubGlobal("XRWebGLLayer", FakeLayer);
  vi.spyOn(HTMLCanvasElement.prototype, "getContext")
    .mockImplementation((() => gl as unknown as WebGL2RenderingContext) as never);
  return { isSessionSupported, requestSession, FakeLayer };
}

function systemWith(
  sampleRuntime: UltraSystemEvidenceClient["sampleRuntime"] = vi.fn(async () => runtimeSample()),
): UltraSystemEvidenceClient {
  return { collectStaticProbe: vi.fn(), sampleRuntime };
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("Windows Ultra physical WebXR benchmark", () => {
  it("runs the deterministic tiered material, shadow, and lighting workload", async () => {
    const gl = createGl();
    const { session, endListeners } = createSession();
    const { isSessionSupported, requestSession, FakeLayer } = installRuntime(gl, session);
    const sampleRuntime = vi.fn<UltraSystemEvidenceClient["sampleRuntime"]>(async () => runtimeSample());

    const result = await runWindowsUltraPhysicalBenchmark(request(10), systemWith(sampleRuntime));

    expect(result).toMatchObject({
      version: 1,
      workloadId: ULTRA_BENCHMARK_WORKLOAD_ID,
      transport: "link_cable",
      targetFrameRateHz: 90,
      durationMs: 10,
      thermalThrottleObserved: false,
      runtimeDisconnectCount: 0,
    });
    expect(result.frameTimeSamplesMs).toHaveLength(10);
    expect(result.processRssSamplesBytes).toHaveLength(11);
    expect(sampleRuntime).toHaveBeenCalledTimes(11);
    expect(isSessionSupported).not.toHaveBeenCalled();
    expect(requestSession).toHaveBeenCalledWith("immersive-vr", {
      requiredFeatures: ["local-floor"],
    });
    expect(session.updateTargetFrameRate).toHaveBeenCalledWith(90);
    expect(session.updateRenderState).toHaveBeenCalledWith(expect.objectContaining({
      baseLayer: expect.any(FakeLayer),
    }));
    for (const instances of [4_096, 2_048, 1_024]) {
      expect(gl.drawArraysInstanced).toHaveBeenCalledWith(gl.TRIANGLES, 0, 36, instances);
    }
    expect(gl.texImage2D).toHaveBeenCalledTimes(2);
    expect(gl.framebufferTexture2D).toHaveBeenCalledOnce();
    expect(gl.shaderSource.mock.calls.some(([, source]) => (
      typeof source === "string" && source.includes("texture(uAlbedo") && source.includes("uShadowMap")
    ))).toBe(true);
    expect(gl.deleteProgram).toHaveBeenCalledTimes(2);
    expect(gl.deleteTexture).toHaveBeenCalledTimes(2);
    expect(gl.deleteFramebuffer).toHaveBeenCalledOnce();
    expect(session.end).toHaveBeenCalledOnce();
    expect(endListeners.size).toBe(0);
  });

  it("always ends the acquired session when an asynchronous preflight step fails", async () => {
    const gl = createGl();
    gl.makeXRCompatible.mockRejectedValueOnce(new Error("compatibility failed"));
    const { session, endListeners } = createSession();
    installRuntime(gl, session);

    await expect(runWindowsUltraPhysicalBenchmark(request(10), systemWith()))
      .rejects.toThrow("compatibility failed");

    expect(session.end).toHaveBeenCalledOnce();
    expect(session.removeEventListener).toHaveBeenCalledOnce();
    expect(endListeners.size).toBe(0);
    expect(gl.createTexture).not.toHaveBeenCalled();
  });

  it("rejects a stalled immersive RAF loop and tears down instead of remaining in Benchmarking", async () => {
    vi.useFakeTimers({ now: new Date("2026-08-25T08:00:00.000Z") });
    const gl = createGl();
    const { session, endListeners } = createSession("stall");
    installRuntime(gl, session);
    const benchmark = runWindowsUltraPhysicalBenchmark(request(10), systemWith());
    const rejected = expect(benchmark).rejects.toMatchObject({
      name: "TimeoutError",
      message: expect.stringContaining("stopped delivering frames"),
    });

    await vi.advanceTimersByTimeAsync(3_001);
    await rejected;

    expect(session.requestAnimationFrame).toHaveBeenCalledOnce();
    expect(session.end).toHaveBeenCalledOnce();
    expect(endListeners.size).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("starts all 11 telemetry commands at absolute points across the draw window", async () => {
    vi.useFakeTimers({ now: new Date("2026-08-25T08:00:00.000Z") });
    const startedAt = Date.now();
    const gl = createGl();
    const { session } = createSession("timer", 10, 10);
    installRuntime(gl, session);
    const sampleStartTimes: number[] = [];
    const sampleRuntime = vi.fn<UltraSystemEvidenceClient["sampleRuntime"]>(async () => {
      sampleStartTimes.push(Date.now() - startedAt);
      await new Promise<void>((resolve) => globalThis.setTimeout(resolve, 40));
      return runtimeSample();
    });
    const benchmark = runWindowsUltraPhysicalBenchmark(request(100), systemWith(sampleRuntime));

    await vi.advanceTimersByTimeAsync(500);
    const result = await benchmark;

    expect(result.durationMs).toBe(100);
    expect(sampleStartTimes).toEqual([0, 10, 20, 30, 40, 50, 60, 70, 80, 90, 100]);
    expect(sampleRuntime).toHaveBeenCalledTimes(11);
    expect(session.end).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("bounds a requestSession that never settles and closes a late session", async () => {
    vi.useFakeTimers({ now: new Date("2026-08-25T08:00:00.000Z") });
    let resolveSession!: (session: XRSession) => void;
    const pending = new Promise<XRSession>((resolve) => { resolveSession = resolve; });
    const requestSession = vi.fn(() => pending);
    vi.stubGlobal("navigator", { xr: { requestSession } });
    const benchmark = runWindowsUltraPhysicalBenchmark(request(10), systemWith());
    const rejected = expect(benchmark).rejects.toMatchObject({
      name: "TimeoutError",
      message: expect.stringContaining("did not open"),
    });

    await vi.advanceTimersByTimeAsync(30_001);
    await rejected;

    const { session } = createSession("stall");
    resolveSession(session as unknown as XRSession);
    await Promise.resolve();
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(0);
    expect(session.end).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });
});
