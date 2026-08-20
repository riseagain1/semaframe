import { afterEach, describe, expect, it, vi } from "vitest";
import {
  CsgEvaluationError,
  evaluateCsgInWorker,
  parseCsgDefinition,
  type CsgEvaluationResult,
  type CsgWorkerRequest,
  type CsgWorkerResponse,
} from "../../workspace/modeling/csg";

const definition = parseCsgDefinition({
  version: 1,
  root: { kind: "primitive", primitive: { kind: "box", sizeM: { x: 1, y: 1, z: 1 } } },
});

function result(): CsgEvaluationResult {
  return {
    definition,
    definitionDigest: "digest",
    resultDigest: "result",
    options: { circularSegments: 32, maxVertices: 100, maxTriangles: 100 },
    mesh: {
      format: "indexed-triangle-mesh",
      units: "metres",
      coordinateSystem: "right-handed-y-up",
      positions: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]),
      indices: new Uint32Array([0, 1, 2]),
      vertexCount: 3,
      triangleCount: 1,
    },
    bounds: {
      min: { x: 0, y: 0, z: 0 }, max: { x: 1, y: 1, z: 0 },
      center: { x: 0.5, y: 0.5, z: 0 }, size: { x: 1, y: 1, z: 0 },
    },
    volumeM3: 1,
    diagnostics: {
      engine: {
        name: "Manifold", packageName: "manifold-3d", version: "3.5.1",
        license: "Apache-2.0", runtime: "WebAssembly", loading: "lazy",
      },
      status: "NoError",
      manifold: true,
      watertight: true,
      empty: false,
      genus: 0,
      toleranceM: 0,
      surfaceAreaM2: 6,
    },
  };
}

class FakeWorker {
  onmessage: ((event: MessageEvent<CsgWorkerResponse>) => void) | null = null;
  onerror: ((event: ErrorEvent) => void) | null = null;
  onmessageerror: (() => void) | null = null;
  terminated = false;
  posted?: CsgWorkerRequest;

  constructor(private readonly respond = true) {}

  postMessage(request: CsgWorkerRequest): void {
    this.posted = request;
    if (!this.respond || request.type !== "csg/evaluate") return;
    queueMicrotask(() => this.onmessage?.({
      data: { type: "csg/result", requestId: request.requestId, result: result() },
    } as MessageEvent<CsgWorkerResponse>));
  }

  terminate(): void {
    this.terminated = true;
  }
}

afterEach(() => vi.useRealTimers());

describe("CSG browser worker client", () => {
  it("returns transferable geometry and terminates its disposable worker", async () => {
    const worker = new FakeWorker();
    const evaluated = await evaluateCsgInWorker(definition, {
      circularSegments: 24,
      workerFactory: () => worker as unknown as Worker,
    });
    expect(evaluated.mesh.positions).toBeInstanceOf(Float32Array);
    expect(worker.posted).toMatchObject({ type: "csg/evaluate", options: { circularSegments: 24 } });
    expect(worker.terminated).toBe(true);
  });

  it("hard-stops the worker on timeout", async () => {
    vi.useFakeTimers();
    const worker = new FakeWorker(false);
    const pending = evaluateCsgInWorker(definition, {
      timeoutMs: 10,
      workerFactory: () => worker as unknown as Worker,
    });
    const rejection = expect(pending).rejects.toEqual(expect.objectContaining({ code: "operation_timeout" }));
    await vi.advanceTimersByTimeAsync(10);
    await rejection;
    expect(worker.terminated).toBe(true);
  });

  it("hard-stops on AbortSignal and validates budgets before allocating a worker", async () => {
    const worker = new FakeWorker(false);
    const controller = new AbortController();
    const pending = evaluateCsgInWorker(definition, {
      signal: controller.signal,
      workerFactory: () => worker as unknown as Worker,
    });
    controller.abort();
    await expect(pending).rejects.toEqual(expect.objectContaining({ code: "aborted" }));
    expect(worker.terminated).toBe(true);

    let allocated = false;
    const invalid = evaluateCsgInWorker(definition, {
      timeoutMs: 0,
      workerFactory: () => { allocated = true; return worker as unknown as Worker; },
    });
    await expect(invalid).rejects.toBeInstanceOf(CsgEvaluationError);
    expect(allocated).toBe(false);
  });
});
