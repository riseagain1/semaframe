// @vitest-environment node

import { afterEach, describe, expect, it, vi } from "vitest";
import type { ModelDefinition } from "../../workspace/modeling/modelDefinitions";
import type { CadHandoffPackage } from "../../workspace/modeling/cadHandoff";
import {
  createModelDefinitionCadHandoffPackageInWorker,
} from "../../workspace/modeling/cadHandoffWorkerClient";
import type {
  CadHandoffWorkerRequest,
  CadHandoffWorkerResponse,
} from "../../workspace/modeling/cadHandoffWorkerProtocol";

const definition = Object.freeze({
  modelId: "com.semaframe.fake",
  version: "1.0.0",
  digest: "fnv1a32:00000000",
  displayName: "Fake",
  rootNodeId: "ROOT",
  nodes: [],
  sourceRevision: 0,
  formatVersion: "1.0",
  generatorVersion: "1.0.0",
}) as ModelDefinition;

const packageResult = Object.freeze({
  format: "semaframe-cad-package",
  version: "2.0",
}) as CadHandoffPackage;

class FakeWorker {
  onmessage: ((event: MessageEvent<CadHandoffWorkerResponse>) => void) | null = null;
  onerror: ((event: ErrorEvent) => void) | null = null;
  onmessageerror: (() => void) | null = null;
  terminated = false;
  posted?: CadHandoffWorkerRequest;

  constructor(private readonly respond = true) {}

  postMessage(request: CadHandoffWorkerRequest): void {
    this.posted = request;
    if (!this.respond) return;
    queueMicrotask(() => this.onmessage?.({
      data: { id: request.id, ok: true, package: packageResult },
    } as MessageEvent<CadHandoffWorkerResponse>));
  }

  terminate(): void {
    this.terminated = true;
  }
}

afterEach(() => vi.useRealTimers());

describe("CAD handoff browser worker boundary", () => {
  it("returns the package, sends only cloneable options, and disposes the worker", async () => {
    const worker = new FakeWorker();
    const result = await createModelDefinitionCadHandoffPackageInWorker(definition, {
      workerFactory: () => worker as unknown as Worker,
      budgetMs: 1_000,
      volumeRelativeTolerance: 1e-7,
    });
    expect(result).toBe(packageResult);
    expect(worker.posted).toMatchObject({
      id: 1,
      options: { volumeRelativeTolerance: 1e-7 },
    });
    expect(worker.posted).not.toHaveProperty("signal");
    expect(worker.terminated).toBe(true);
  });

  it("hard-stops an unresponsive worker on timeout", async () => {
    vi.useFakeTimers();
    const worker = new FakeWorker(false);
    const pending = createModelDefinitionCadHandoffPackageInWorker(definition, {
      workerFactory: () => worker as unknown as Worker,
      budgetMs: 10,
    });
    const rejection = expect(pending).rejects.toMatchObject({ code: "operation_timeout" });
    await vi.advanceTimersByTimeAsync(10);
    await rejection;
    expect(worker.terminated).toBe(true);
  });

  it("hard-stops on AbortSignal and validates budgets before worker allocation", async () => {
    const worker = new FakeWorker(false);
    const controller = new AbortController();
    const pending = createModelDefinitionCadHandoffPackageInWorker(definition, {
      workerFactory: () => worker as unknown as Worker,
      signal: controller.signal,
    });
    controller.abort();
    await expect(pending).rejects.toMatchObject({ code: "aborted" });
    expect(worker.terminated).toBe(true);

    let allocated = false;
    await expect(createModelDefinitionCadHandoffPackageInWorker(definition, {
      budgetMs: 0,
      workerFactory: () => {
        allocated = true;
        return worker as unknown as Worker;
      },
    })).rejects.toMatchObject({ code: "invalid_options" });
    expect(allocated).toBe(false);
  });
});
