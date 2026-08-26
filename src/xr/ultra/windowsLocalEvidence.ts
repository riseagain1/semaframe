import {
  ULTRA_BENCHMARK_WORKLOAD_ID,
  ULTRA_POLICY_VERSION,
  type UltraRuntimeBenchmarkInput,
  type UltraStaticProbe,
  type UltraTransport,
} from "./contracts";
import type {
  UltraLocalBenchmarkRequest,
  UltraLocalEvidencePort,
} from "./localActivation";

export type UltraBrowserProbeEvidence = Readonly<{
  browserEngine: "chromium" | "unknown";
  secureContext: boolean;
  immersiveVrSupported: boolean;
}>;

export type UltraRuntimeSystemSample = Readonly<{
  version: 1;
  transport: UltraTransport;
  processRssBytes: number;
  gpuMemoryUsageRatio: number;
  gpuMemoryHeadroomBytes: number;
  thermalThrottleObserved: boolean;
  runtimeConnected: boolean;
  sampledAt: string;
}>;

export interface UltraSystemEvidenceClient {
  collectStaticProbe(
    browser: UltraBrowserProbeEvidence,
    signal: AbortSignal,
  ): Promise<UltraStaticProbe>;
  sampleRuntime(signal: AbortSignal): Promise<UltraRuntimeSystemSample>;
}

export type UltraPhysicalBenchmarkRunner = (
  request: UltraLocalBenchmarkRequest,
  system: UltraSystemEvidenceClient,
) => Promise<UltraRuntimeBenchmarkInput>;

export type WindowsUltraLocalEvidenceOptions = Readonly<{
  system: UltraSystemEvidenceClient;
  benchmarkRunner?: UltraPhysicalBenchmarkRunner;
  navigator?: Navigator;
  secureContext?: boolean;
}>;

function abortError(signal: AbortSignal): DOMException {
  return signal.reason instanceof DOMException
    ? signal.reason
    : new DOMException("Windows Ultra verification was cancelled.", "AbortError");
}

function ensureActive(signal: AbortSignal): void {
  if (signal.aborted) throw abortError(signal);
}

function browserEngine(navigatorValue: Navigator): "chromium" | "unknown" {
  const userAgentData = (navigatorValue as Navigator & {
    userAgentData?: { brands?: readonly Readonly<{ brand: string }>[] };
  }).userAgentData;
  const brands = userAgentData?.brands?.map(({ brand }) => brand).join(" ") ?? "";
  const identity = `${brands} ${navigatorValue.userAgent}`;
  return /(Chromium|Chrome|Edg|OculusBrowser)/iu.test(identity) ? "chromium" : "unknown";
}

export function isLikelyWindowsX64Browser(navigatorValue: Navigator = navigator): boolean {
  const candidate = navigatorValue as Navigator & {
    userAgentData?: { platform?: string };
  };
  const platform = candidate.userAgentData?.platform ?? navigatorValue.platform ?? "";
  return /Windows/iu.test(`${platform} ${navigatorValue.userAgent}`)
    && !/(ARM64|Windows Phone)/iu.test(navigatorValue.userAgent);
}

function checkedSystemSample(value: UltraRuntimeSystemSample): UltraRuntimeSystemSample {
  if (value.version !== 1
    || (value.transport !== "link_cable" && value.transport !== "air_link")
    || !Number.isSafeInteger(value.processRssBytes) || value.processRssBytes < 0
    || typeof value.gpuMemoryUsageRatio !== "number" || !Number.isFinite(value.gpuMemoryUsageRatio)
    || value.gpuMemoryUsageRatio < 0 || value.gpuMemoryUsageRatio > 1
    || !Number.isSafeInteger(value.gpuMemoryHeadroomBytes) || value.gpuMemoryHeadroomBytes < 0
    || typeof value.thermalThrottleObserved !== "boolean"
    || typeof value.runtimeConnected !== "boolean"
    || !Number.isFinite(Date.parse(value.sampledAt))) {
    throw new TypeError("Windows Ultra runtime evidence is invalid.");
  }
  return Object.freeze({ ...value });
}

function delay(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.reject(abortError(signal));
  return new Promise<void>((resolve, reject) => {
    const timer = globalThis.setTimeout(done, ms);
    function done() {
      signal.removeEventListener("abort", aborted);
      resolve();
    }
    function aborted() {
      globalThis.clearTimeout(timer);
      reject(abortError(signal));
    }
    signal.addEventListener("abort", aborted, { once: true });
  });
}

const ULTRA_SESSION_REQUEST_TIMEOUT_MS = 30_000;
const ULTRA_SESSION_END_TIMEOUT_MS = 2_000;
const ULTRA_BENCHMARK_WALL_CLOCK_GRACE_MS = 30_000;
const ULTRA_RAF_STALL_TIMEOUT_MS = 3_000;
const MAX_TIMER_DELAY_MS = 2_147_000_000;

const REFERENCE_WORKLOAD_TIERS = Object.freeze([
  Object.freeze({ tier: 0, instanceCount: 4_096 }),
  Object.freeze({ tier: 1, instanceCount: 2_048 }),
  Object.freeze({ tier: 2, instanceCount: 1_024 }),
]);
const REFERENCE_MATERIAL_TEXTURE_SIZE = 128;
const REFERENCE_SHADOW_MAP_SIZE = 1_024;

function timeoutError(message: string): DOMException {
  return new DOMException(message, "TimeoutError");
}

function benchmarkWallClockTimeout(durationMs: number): number {
  return Math.min(
    MAX_TIMER_DELAY_MS,
    Math.max(ULTRA_BENCHMARK_WALL_CLOCK_GRACE_MS, durationMs)
      + ULTRA_BENCHMARK_WALL_CLOCK_GRACE_MS,
  );
}

function awaitAbortable<T>(promise: PromiseLike<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(abortError(signal));
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const cleanup = () => signal.removeEventListener("abort", aborted);
    const aborted = () => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(abortError(signal));
    };
    signal.addEventListener("abort", aborted, { once: true });
    void Promise.resolve(promise).then((value) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(value);
    }, (cause) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(cause);
    });
  });
}

function endSessionBestEffort(session: XRSession): Promise<void> {
  return new Promise<void>((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      globalThis.clearTimeout(timer);
      resolve();
    };
    const timer = globalThis.setTimeout(finish, ULTRA_SESSION_END_TIMEOUT_MS);
    void Promise.resolve().then(() => session.end()).then(finish, finish);
  });
}

function requestImmersiveSession(
  xr: XRSystem,
  signal: AbortSignal,
): Promise<XRSession> {
  ensureActive(signal);
  // This call must remain synchronous with the Verify button's transient user
  // activation. Do not insert an awaited capability probe before it.
  const pending = xr.requestSession("immersive-vr", {
    requiredFeatures: ["local-floor"],
  });
  return new Promise<XRSession>((resolve, reject) => {
    let settled = false;
    const cleanup = () => {
      globalThis.clearTimeout(timer);
      signal.removeEventListener("abort", aborted);
    };
    const fail = (cause: unknown) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(cause);
    };
    const aborted = () => fail(abortError(signal));
    const timer = globalThis.setTimeout(() => {
      fail(timeoutError("The immersive runtime did not open the Ultra benchmark session in time."));
    }, ULTRA_SESSION_REQUEST_TIMEOUT_MS);
    signal.addEventListener("abort", aborted, { once: true });
    void pending.then((session) => {
      if (settled) {
        // A permission prompt may resolve after timeout/abort. Never leave that
        // late session resident just because the benchmark caller moved on.
        void endSessionBestEffort(session);
        return;
      }
      settled = true;
      cleanup();
      resolve(session);
    }, fail);
  });
}

function createReferenceWorkload(gl: WebGL2RenderingContext): Readonly<{
  drawShadow(): void;
  drawView(framebuffer: WebGLFramebuffer, viewport: XRViewport): void;
  dispose(): void;
}> {
  // v1 intentionally uses fixed, bounded allocations: a 64 KiB deterministic
  // albedo texture and a 4 MiB 1024² depth map. The three tiers submit 7,168
  // procedural cube instances (258,048 vertices) to both a shadow pass and the
  // textured lighting pass. This is materially representative of Ultra scene
  // costs without deriving allocation sizes from runtime or user input.
  const vertexSource = `#version 300 es
    precision highp float;
    uniform float uTier;
    out vec3 vNormal;
    out vec2 vUv;
    out vec3 vShadowCoord;
    void main() {
      vec2 corners[6] = vec2[6](
        vec2(-1.0, -1.0), vec2(1.0, -1.0), vec2(1.0, 1.0),
        vec2(-1.0, -1.0), vec2(1.0, 1.0), vec2(-1.0, 1.0)
      );
      int face = gl_VertexID / 6;
      vec2 corner = corners[gl_VertexID % 6];
      vec3 localPosition;
      vec3 normal;
      if (face == 0) { localPosition = vec3(1.0, corner); normal = vec3(1.0, 0.0, 0.0); }
      else if (face == 1) { localPosition = vec3(-1.0, corner); normal = vec3(-1.0, 0.0, 0.0); }
      else if (face == 2) { localPosition = vec3(corner.x, 1.0, corner.y); normal = vec3(0.0, 1.0, 0.0); }
      else if (face == 3) { localPosition = vec3(corner.x, -1.0, corner.y); normal = vec3(0.0, -1.0, 0.0); }
      else if (face == 4) { localPosition = vec3(corner, 1.0); normal = vec3(0.0, 0.0, 1.0); }
      else { localPosition = vec3(corner, -1.0); normal = vec3(0.0, 0.0, -1.0); }
      int column = gl_InstanceID % 32;
      int row = (gl_InstanceID / 32) % 32;
      int layer = (gl_InstanceID / 1024) % 4;
      float tierScale = 1.0 - uTier * 0.16;
      vec3 center = vec3(
        (float(column) - 15.5) * 0.058,
        (float(row) - 15.5) * 0.058,
        -0.72 + float(layer) * 0.34 + uTier * 0.025
      );
      vec3 world = center + localPosition * (0.020 * tierScale);
      vNormal = normal;
      vUv = corner * 0.5 + 0.5;
      vShadowCoord = vec3(world.xy * 0.5 + 0.5, clamp((world.z + 1.0) * 0.5, 0.0, 1.0));
      gl_Position = vec4(world.xy, clamp((world.z + 1.1) * 0.42, 0.0, 1.0), 1.0);
    }`;
  const fragmentSource = `#version 300 es
    precision highp float;
    uniform sampler2D uAlbedo;
    uniform sampler2D uShadowMap;
    in vec3 vNormal;
    in vec2 vUv;
    in vec3 vShadowCoord;
    out vec4 color;
    void main() {
      vec3 material = texture(uAlbedo, fract(vUv * 4.0 + gl_FragCoord.xy * 0.001)).rgb;
      vec3 lightDirection = normalize(vec3(0.45, 0.78, 0.36));
      float diffuse = max(dot(normalize(vNormal), lightDirection), 0.0);
      float storedDepth = texture(uShadowMap, clamp(vShadowCoord.xy, 0.0, 1.0)).r;
      float visibility = vShadowCoord.z - 0.004 > storedDepth ? 0.42 : 1.0;
      vec3 halfVector = normalize(lightDirection + vec3(0.0, 0.0, 1.0));
      float specular = pow(max(dot(normalize(vNormal), halfVector), 0.0), 24.0);
      vec3 lit = material * (0.12 + visibility * diffuse * 0.88) + vec3(specular * 0.18);
      color = vec4(lit, 1.0);
    }`;
  const shadowFragmentSource = `#version 300 es
    precision highp float;
    void main() { }
  `;
  const shaders: WebGLShader[] = [];
  const programs: WebGLProgram[] = [];
  const textures: WebGLTexture[] = [];
  const framebuffers: WebGLFramebuffer[] = [];
  const vertexArrays: WebGLVertexArrayObject[] = [];
  const compile = (kind: number, source: string) => {
    const shader = gl.createShader(kind);
    if (!shader) throw new Error("The Ultra reference shader could not be created.");
    shaders.push(shader);
    gl.shaderSource(shader, source);
    gl.compileShader(shader);
    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
      const message = gl.getShaderInfoLog(shader) || "The Ultra reference shader failed.";
      gl.deleteShader(shader);
      throw new Error(message.slice(0, 300));
    }
    return shader;
  };
  const link = (vertex: WebGLShader, fragment: WebGLShader) => {
    const program = gl.createProgram();
    if (!program) throw new Error("The Ultra reference program could not be created.");
    programs.push(program);
    gl.attachShader(program, vertex);
    gl.attachShader(program, fragment);
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
      const message = gl.getProgramInfoLog(program) || "The Ultra reference program failed.";
      throw new Error(message.slice(0, 300));
    }
    return program;
  };
  const dispose = () => {
    gl.colorMask(true, true, true, true);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.bindTexture(gl.TEXTURE_2D, null);
    gl.bindVertexArray(null);
    for (const vertexArray of vertexArrays) gl.deleteVertexArray(vertexArray);
    for (const framebuffer of framebuffers) gl.deleteFramebuffer(framebuffer);
    for (const texture of textures) gl.deleteTexture(texture);
    for (const program of programs) gl.deleteProgram(program);
    for (const shader of shaders) gl.deleteShader(shader);
  };
  try {
    const vertex = compile(gl.VERTEX_SHADER, vertexSource);
    const lightingFragment = compile(gl.FRAGMENT_SHADER, fragmentSource);
    const shadowFragment = compile(gl.FRAGMENT_SHADER, shadowFragmentSource);
    const lightingProgram = link(vertex, lightingFragment);
    const shadowProgram = link(vertex, shadowFragment);
    const vertexArray = gl.createVertexArray();
    if (!vertexArray) throw new Error("The Ultra reference geometry could not be created.");
    vertexArrays.push(vertexArray);

    const albedoTexture = gl.createTexture();
    if (!albedoTexture) throw new Error("The Ultra reference material texture could not be created.");
    textures.push(albedoTexture);
    const albedo = new Uint8Array(REFERENCE_MATERIAL_TEXTURE_SIZE ** 2 * 4);
    for (let offset = 0; offset < albedo.length; offset += 4) {
      const texel = offset / 4;
      const x = texel % REFERENCE_MATERIAL_TEXTURE_SIZE;
      const y = Math.floor(texel / REFERENCE_MATERIAL_TEXTURE_SIZE);
      const checker = ((x >> 3) ^ (y >> 3)) & 1;
      albedo[offset] = 32 + checker * 36;
      albedo[offset + 1] = 92 + ((x * 13 + y * 7) & 31);
      albedo[offset + 2] = 148 + checker * 48;
      albedo[offset + 3] = 255;
    }
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, albedoTexture);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.REPEAT);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.REPEAT);
    gl.texImage2D(
      gl.TEXTURE_2D,
      0,
      gl.RGBA8,
      REFERENCE_MATERIAL_TEXTURE_SIZE,
      REFERENCE_MATERIAL_TEXTURE_SIZE,
      0,
      gl.RGBA,
      gl.UNSIGNED_BYTE,
      albedo,
    );
    gl.generateMipmap(gl.TEXTURE_2D);

    const shadowTexture = gl.createTexture();
    if (!shadowTexture) throw new Error("The Ultra reference shadow texture could not be created.");
    textures.push(shadowTexture);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, shadowTexture);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texImage2D(
      gl.TEXTURE_2D,
      0,
      gl.DEPTH_COMPONENT24,
      REFERENCE_SHADOW_MAP_SIZE,
      REFERENCE_SHADOW_MAP_SIZE,
      0,
      gl.DEPTH_COMPONENT,
      gl.UNSIGNED_INT,
      null,
    );
    const shadowFramebuffer = gl.createFramebuffer();
    if (!shadowFramebuffer) throw new Error("The Ultra reference shadow framebuffer could not be created.");
    framebuffers.push(shadowFramebuffer);
    gl.bindFramebuffer(gl.FRAMEBUFFER, shadowFramebuffer);
    gl.framebufferTexture2D(
      gl.FRAMEBUFFER,
      gl.DEPTH_ATTACHMENT,
      gl.TEXTURE_2D,
      shadowTexture,
      0,
    );
    gl.drawBuffers([gl.NONE]);
    gl.readBuffer(gl.NONE);
    if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE) {
      throw new Error("The Ultra reference shadow framebuffer is incomplete.");
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);

    const lightingTier = gl.getUniformLocation(lightingProgram, "uTier");
    const shadowTier = gl.getUniformLocation(shadowProgram, "uTier");
    const albedoSampler = gl.getUniformLocation(lightingProgram, "uAlbedo");
    const shadowSampler = gl.getUniformLocation(lightingProgram, "uShadowMap");
    gl.useProgram(lightingProgram);
    if (albedoSampler) gl.uniform1i(albedoSampler, 0);
    if (shadowSampler) gl.uniform1i(shadowSampler, 1);

    return Object.freeze({
      drawShadow() {
        gl.bindFramebuffer(gl.FRAMEBUFFER, shadowFramebuffer);
        gl.viewport(0, 0, REFERENCE_SHADOW_MAP_SIZE, REFERENCE_SHADOW_MAP_SIZE);
        gl.colorMask(false, false, false, false);
        gl.clear(gl.DEPTH_BUFFER_BIT);
        gl.useProgram(shadowProgram);
        gl.bindVertexArray(vertexArray);
        for (const tier of REFERENCE_WORKLOAD_TIERS) {
          if (shadowTier) gl.uniform1f(shadowTier, tier.tier);
          gl.drawArraysInstanced(gl.TRIANGLES, 0, 36, tier.instanceCount);
        }
        gl.colorMask(true, true, true, true);
      },
      drawView(framebuffer, viewport) {
        gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer);
        gl.viewport(viewport.x, viewport.y, viewport.width, viewport.height);
        gl.useProgram(lightingProgram);
        gl.bindVertexArray(vertexArray);
        gl.activeTexture(gl.TEXTURE0);
        gl.bindTexture(gl.TEXTURE_2D, albedoTexture);
        gl.activeTexture(gl.TEXTURE1);
        gl.bindTexture(gl.TEXTURE_2D, shadowTexture);
        for (const tier of REFERENCE_WORKLOAD_TIERS) {
          if (lightingTier) gl.uniform1f(lightingTier, tier.tier);
          gl.drawArraysInstanced(gl.TRIANGLES, 0, 36, tier.instanceCount);
        }
      },
      dispose,
    });
  } catch (cause) {
    try {
      dispose();
    } catch {
      // Preserve the setup failure while best-effort cleanup continues below.
    }
    throw cause;
  }
}

async function collectSystemSamples(
  request: UltraLocalBenchmarkRequest,
  system: UltraSystemEvidenceClient,
  startedAtMs: number,
): Promise<readonly UltraRuntimeSystemSample[]> {
  const sampleCount = 11;
  const spacingMs = request.minimumDurationMs / (sampleCount - 1);
  const samples = await Promise.all(Array.from({ length: sampleCount }, async (_, index) => {
    const targetMs = startedAtMs + spacingMs * index;
    const remainingMs = targetMs - Date.now();
    if (remainingMs > 0) await delay(remainingMs, request.signal);
    ensureActive(request.signal);
    return checkedSystemSample(await system.sampleRuntime(request.signal));
  }));
  return Object.freeze(samples);
}

/** Runs the real WebXR frame workload; it has no simulator or synthetic-pass path. */
export async function runWindowsUltraPhysicalBenchmark(
  request: UltraLocalBenchmarkRequest,
  system: UltraSystemEvidenceClient,
): Promise<UltraRuntimeBenchmarkInput> {
  ensureActive(request.signal);
  if (!/^sha256:[0-9a-f]{64}$/u.test(request.probeFingerprint)
    || request.workloadId !== ULTRA_BENCHMARK_WORKLOAD_ID) {
    throw new TypeError("Windows Ultra benchmark identity is invalid.");
  }
  const xr = navigator.xr;
  if (!xr) {
    throw new Error("Immersive WebXR is unavailable for the physical Ultra benchmark.");
  }
  // requestSession must be invoked inside the Verify button's transient user
  // activation. Capability support was already observed by the background
  // static probe; awaiting isSessionSupported here would consume that gesture.
  ensureActive(request.signal);
  const rawSession = await requestImmersiveSession(xr, request.signal);
  let completed = false;
  let listenerAttached = false;
  let workload: ReturnType<typeof createReferenceWorkload> | undefined;
  let systemSamplesPromise: Promise<readonly UltraRuntimeSystemSample[]> | undefined;
  const lifecycleAbort = new AbortController();
  const forwardAbort = () => lifecycleAbort.abort(request.signal.reason);
  if (request.signal.aborted) forwardAbort();
  else request.signal.addEventListener("abort", forwardAbort, { once: true });
  const wallClockTimer = globalThis.setTimeout(() => {
    lifecycleAbort.abort(timeoutError(
      "The Windows Ultra benchmark exceeded its wall-clock safety limit.",
    ));
  }, benchmarkWallClockTimeout(request.minimumDurationMs));
  const onEnded = () => {
    if (!completed) {
      lifecycleAbort.abort(new DOMException(
        "The PCVR runtime disconnected during the Ultra benchmark.",
        "NetworkError",
      ));
    }
  };
  const expectedFrameMs = 1_000 / request.targetFrameRateHz;
  const frameTimeSamplesMs: number[] = [];
  let droppedFrameCount = 0;
  let consecutiveDroppedFrames = 0;
  let maximumConsecutiveDroppedFrames = 0;
  let startedAt: number | undefined;
  let previousAt: number | undefined;
  try {
    rawSession.addEventListener("end", onEnded);
    listenerAttached = true;
    ensureActive(lifecycleAbort.signal);
    const canvas = document.createElement("canvas");
    canvas.width = 1024;
    canvas.height = 1024;
    const gl = canvas.getContext("webgl2", {
      alpha: false,
      antialias: true,
      depth: true,
      powerPreference: "high-performance",
      xrCompatible: true,
    });
    if (!gl) throw new Error("WebGL2 is required for the Ultra reference workload.");
    const compatible = gl as WebGL2RenderingContext & { makeXRCompatible?: () => Promise<void> };
    if (compatible.makeXRCompatible) {
      await awaitAbortable(compatible.makeXRCompatible(), lifecycleAbort.signal);
    }
    ensureActive(lifecycleAbort.signal);
    const Layer = (globalThis as typeof globalThis & {
      XRWebGLLayer?: new (
        session: XRSession,
        context: WebGLRenderingContext | WebGL2RenderingContext,
        options?: Readonly<{ framebufferScaleFactor?: number }>,
      ) => XRWebGLLayer;
    }).XRWebGLLayer;
    if (!Layer) throw new Error("XRWebGLLayer is unavailable for the Ultra reference workload.");
    const layer = new Layer(rawSession, gl, { framebufferScaleFactor: 1 });
    rawSession.updateRenderState({ baseLayer: layer, depthNear: 0.05, depthFar: 200 });
    ensureActive(lifecycleAbort.signal);
    const referenceSpace = await awaitAbortable(
      rawSession.requestReferenceSpace("local-floor"),
      lifecycleAbort.signal,
    );
    const supportedRates = rawSession.supportedFrameRates;
    if (supportedRates && Array.from(supportedRates).includes(request.targetFrameRateHz)) {
      await awaitAbortable(
        rawSession.updateTargetFrameRate(request.targetFrameRateHz),
        lifecycleAbort.signal,
      );
    }
    ensureActive(lifecycleAbort.signal);
    workload = createReferenceWorkload(gl);
    ensureActive(lifecycleAbort.signal);

    const samplingStartedAtMs = Date.now();
    const linkedRequest = Object.freeze({
      ...request,
      signal: lifecycleAbort.signal,
    });
    systemSamplesPromise = collectSystemSamples(linkedRequest, system, samplingStartedAtMs);
    const frameLoopPromise = new Promise<void>((resolve, reject) => {
      let settled = false;
      let stallTimer: ReturnType<typeof globalThis.setTimeout> | undefined;
      const clearStallTimer = () => {
        if (stallTimer !== undefined) globalThis.clearTimeout(stallTimer);
        stallTimer = undefined;
      };
      const finish = (outcome: () => void) => {
        if (settled) return;
        settled = true;
        clearStallTimer();
        lifecycleAbort.signal.removeEventListener("abort", aborted);
        outcome();
      };
      const aborted = () => finish(() => reject(abortError(lifecycleAbort.signal)));
      const armStallTimer = () => {
        clearStallTimer();
        stallTimer = globalThis.setTimeout(() => {
          finish(() => reject(timeoutError(
            "The immersive runtime stopped delivering frames during the Ultra benchmark.",
          )));
        }, ULTRA_RAF_STALL_TIMEOUT_MS);
      };
      lifecycleAbort.signal.addEventListener("abort", aborted, { once: true });
      const frame = (time: number, xrFrame: XRFrame) => {
        clearStallTimer();
        if (settled) return;
        if (lifecycleAbort.signal.aborted) {
          aborted();
          return;
        }
        try {
          startedAt ??= time;
          if (previousAt !== undefined) {
            const frameTime = time - previousAt;
            frameTimeSamplesMs.push(frameTime);
            const missed = Math.max(0, Math.round(frameTime / expectedFrameMs) - 1);
            droppedFrameCount += missed;
            consecutiveDroppedFrames = missed > 0 ? consecutiveDroppedFrames + missed : 0;
            maximumConsecutiveDroppedFrames = Math.max(
              maximumConsecutiveDroppedFrames,
              consecutiveDroppedFrames,
            );
          }
          previousAt = time;
          const pose = xrFrame.getViewerPose(referenceSpace);
          workload!.drawShadow();
          gl.bindFramebuffer(gl.FRAMEBUFFER, layer.framebuffer);
          gl.enable(gl.DEPTH_TEST);
          gl.clearColor(0.015, 0.028, 0.05, 1);
          gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
          for (const view of pose?.views ?? []) {
            const viewport = layer.getViewport(view);
            if (!viewport) continue;
            workload!.drawView(layer.framebuffer, viewport);
          }
          if (time - startedAt >= request.minimumDurationMs) {
            finish(resolve);
            return;
          }
          armStallTimer();
          rawSession.requestAnimationFrame(frame);
        } catch (cause) {
          finish(() => reject(cause));
        }
      };
      try {
        armStallTimer();
        rawSession.requestAnimationFrame(frame);
      } catch (cause) {
        finish(() => reject(cause));
      }
    });
    const [, systemSamples] = await Promise.all([frameLoopPromise, systemSamplesPromise]);
    ensureActive(lifecycleAbort.signal);
    completed = true;
    const completedAt = new Date().toISOString();
    const transports = new Set(systemSamples.map(({ transport }) => transport));
    if (transports.size !== 1) throw new Error("The PCVR transport changed during the Ultra benchmark.");
    const durationMs = Math.max(
      request.minimumDurationMs,
      Math.round((previousAt ?? 0) - (startedAt ?? 0)),
    );
    return Object.freeze({
      version: 1,
      policyVersion: ULTRA_POLICY_VERSION,
      workloadId: ULTRA_BENCHMARK_WORKLOAD_ID,
      transport: systemSamples[0]!.transport,
      targetFrameRateHz: request.targetFrameRateHz,
      durationMs,
      frameTimeSamplesMs: Object.freeze(frameTimeSamplesMs),
      droppedFrameCount,
      maximumConsecutiveDroppedFrames,
      processRssSamplesBytes: Object.freeze(systemSamples.map(({ processRssBytes }) => processRssBytes)),
      gpuMemoryUsageRatioSamples: Object.freeze(systemSamples.map(({ gpuMemoryUsageRatio }) => gpuMemoryUsageRatio)),
      gpuMemoryHeadroomSamplesBytes: Object.freeze(systemSamples.map(({ gpuMemoryHeadroomBytes }) => gpuMemoryHeadroomBytes)),
      thermalThrottleObserved: systemSamples.some(({ thermalThrottleObserved }) => thermalThrottleObserved),
      runtimeDisconnectCount: systemSamples.filter(({ runtimeConnected }) => !runtimeConnected).length,
      completedAt,
    });
  } finally {
    completed = true;
    globalThis.clearTimeout(wallClockTimer);
    request.signal.removeEventListener("abort", forwardAbort);
    lifecycleAbort.abort("benchmark_finished");
    void systemSamplesPromise?.catch(() => undefined);
    if (listenerAttached) rawSession.removeEventListener("end", onEnded);
    try {
      workload?.dispose();
    } catch {
      // Session teardown is the primary cleanup invariant.
    }
    await endSessionBestEffort(rawSession);
  }
}

export function createWindowsUltraLocalEvidencePort(
  options: WindowsUltraLocalEvidenceOptions,
): UltraLocalEvidencePort {
  const navigatorValue = options.navigator ?? navigator;
  const secureContext = options.secureContext ?? globalThis.isSecureContext;
  const benchmarkRunner = options.benchmarkRunner ?? runWindowsUltraPhysicalBenchmark;
  const port: UltraLocalEvidencePort = {
    async collectStaticProbe({ signal }) {
      ensureActive(signal);
      const immersiveVrSupported = Boolean(navigatorValue.xr
        && await navigatorValue.xr.isSessionSupported("immersive-vr"));
      ensureActive(signal);
      return options.system.collectStaticProbe(Object.freeze({
        browserEngine: browserEngine(navigatorValue),
        secureContext: Boolean(secureContext),
        immersiveVrSupported,
      }), signal);
    },
    runPhysicalBenchmark(request) {
      return benchmarkRunner(request, options.system);
    },
  };
  return Object.freeze(port);
}
