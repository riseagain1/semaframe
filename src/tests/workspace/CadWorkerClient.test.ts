// @vitest-environment node

import { describe, expect, it } from "vitest";
import { CadKernelError } from "../../workspace/modeling/cadKernel";
import {
  type CadWorkerFactory,
  createCadWorkerKernel,
} from "../../workspace/modeling/cadWorkerClient";
import type {
  CadWorkerRequest,
  CadWorkerResponse,
} from "../../workspace/modeling/cadWorkerProtocol";

class FakeWorker {
  onmessage: ((event: MessageEvent<CadWorkerResponse>) => void) | null = null;
  onerror: ((event: ErrorEvent) => void) | null = null;
  onmessageerror: ((event: MessageEvent) => void) | null = null;
  terminated = false;
  ignoreAfterInitialization = false;

  postMessage(request: CadWorkerRequest): void {
    if (this.terminated) throw new Error("worker terminated");
    if (request.method !== "init" && this.ignoreAfterInitialization) return;
    queueMicrotask(() => {
      this.onmessage?.({
        data: {
          id: request.id,
          ok: true,
          method: request.method,
          value: request.method === "init" ? true : undefined,
        },
      } as MessageEvent<CadWorkerResponse>);
    });
  }

  terminate(): void {
    this.terminated = true;
  }
}

function factory(worker: FakeWorker): CadWorkerFactory {
  return () => worker as unknown as Worker;
}

async function errorFrom(promise: Promise<unknown>): Promise<CadKernelError> {
  const error = await promise.catch((caught: unknown) => caught);
  expect(error).toBeInstanceOf(CadKernelError);
  return error as CadKernelError;
}

describe("CAD worker hard-stop boundary", () => {
  it("terminates the whole worker on abort and invalidates its handle space", async () => {
    const worker = new FakeWorker();
    const kernel = await createCadWorkerKernel({ workerFactory: factory(worker) });
    worker.ignoreAfterInitialization = true;
    const controller = new AbortController();
    const operation = kernel.createBox(
      { sizeM: { x: 1, y: 1, z: 1 } },
      { signal: controller.signal, budgetMs: 1_000 },
    );
    controller.abort();

    expect((await errorFrom(operation)).code).toBe("aborted");
    expect(worker.terminated).toBe(true);
    expect((await errorFrom(kernel.validate({ id: "cad:1" }))).code).toBe("kernel_disposed");
  });

  it("terminates an unresponsive worker when the operation budget expires", async () => {
    const worker = new FakeWorker();
    const kernel = await createCadWorkerKernel({ workerFactory: factory(worker) });
    worker.ignoreAfterInitialization = true;

    const error = await errorFrom(kernel.createSphere(
      { radiusM: 1 },
      { budgetMs: 10 },
    ));
    expect(error.code).toBe("operation_timeout");
    expect(worker.terminated).toBe(true);
  });
});
