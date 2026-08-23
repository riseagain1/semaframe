import {
  CAD_KERNEL_INFO,
  CAD_KERNEL_LIMITS,
  CadKernelError,
  type CadBooleanOperation,
  type CadBoxInput,
  type CadCylinderInput,
  type CadIndexedMesh,
  type CadKernel,
  type CadMassProperties,
  type CadOperationOptions,
  type CadPartKernelEvaluationOptions,
  type CadShapeHandle,
  type CadSphereInput,
  type CadStepExport,
  type CadTessellationOptions,
  type CadTransform,
  type CadValidationResult,
} from "./cadKernel";
import type {
  CadPartDefinitionV1,
  CadPartEvaluationResultV1,
} from "./cad";
import type {
  CadWorkerArguments,
  CadWorkerMethod,
  CadWorkerRequest,
  CadWorkerResponse,
  CadWorkerResults,
} from "./cadWorkerProtocol";

export type CadWorkerFactory = () => Worker;

export type CreateCadWorkerKernelOptions = Readonly<{
  workerFactory?: CadWorkerFactory;
  initializationBudgetMs?: number;
}>;

type PendingRequest = {
  method: CadWorkerMethod;
  operation: string;
  resolve: (value: unknown) => void;
  reject: (reason: unknown) => void;
  timer: ReturnType<typeof setTimeout>;
  signal?: AbortSignal;
  abortListener?: () => void;
};

function defaultWorkerFactory(): Worker {
  return new Worker(new URL("./cadKernel.worker.ts", import.meta.url), {
    type: "module",
    name: "semaframe-cad-kernel",
  });
}

function budgetMs(value: number | undefined, operation: string): number {
  const result = value ?? CAD_KERNEL_LIMITS.defaultOperationBudgetMs;
  if (!Number.isFinite(result)) {
    throw new CadKernelError("invalid_input", operation, "budgetMs must be finite");
  }
  if (
    result < CAD_KERNEL_LIMITS.minimumOperationBudgetMs
    || result > CAD_KERNEL_LIMITS.maximumOperationBudgetMs
  ) {
    throw new CadKernelError(
      "limit_exceeded",
      operation,
      `budgetMs must be between ${CAD_KERNEL_LIMITS.minimumOperationBudgetMs} and ${CAD_KERNEL_LIMITS.maximumOperationBudgetMs}`,
    );
  }
  return result;
}

function wireOptions(options: CadOperationOptions | undefined): CadOperationOptions | undefined {
  return options === undefined ? undefined : { budgetMs: options.budgetMs };
}

function wireTessellationOptions(
  options: CadTessellationOptions | undefined,
): CadTessellationOptions | undefined {
  if (options === undefined) return undefined;
  return {
    budgetMs: options.budgetMs,
    linearDeflectionM: options.linearDeflectionM,
    angularDeflectionRad: options.angularDeflectionRad,
  };
}

function wirePartEvaluationOptions(
  options: CadPartKernelEvaluationOptions | undefined,
): CadPartKernelEvaluationOptions | undefined {
  if (options === undefined) return undefined;
  return {
    budgetMs: options.budgetMs,
    linearDeflectionM: options.linearDeflectionM,
    angularDeflectionRad: options.angularDeflectionRad,
    includeMeshes: options.includeMeshes,
  };
}

class WorkerCadKernel implements CadKernel {
  readonly info = CAD_KERNEL_INFO;
  private readonly pending = new Map<number, PendingRequest>();
  private nextRequestId = 1;
  private disposed = false;

  constructor(private readonly worker: Worker) {
    this.worker.onmessage = (event: MessageEvent<CadWorkerResponse>) => {
      this.receive(event.data);
    };
    this.worker.onerror = (event: ErrorEvent) => {
      const error = new CadKernelError(
        "kernel_initialization_failed",
        "worker",
        event.message || "CAD worker crashed",
      );
      this.terminateAll(error);
    };
    this.worker.onmessageerror = () => {
      this.terminateAll(new CadKernelError(
        "kernel_initialization_failed",
        "worker",
        "CAD worker returned an unreadable message",
      ));
    };
  }

  initialize(initializationBudgetMs?: number): Promise<void> {
    return this.send("init", [], undefined, initializationBudgetMs).then(() => undefined);
  }

  createBox(input: CadBoxInput, options?: CadOperationOptions): Promise<CadShapeHandle> {
    return this.send("createBox", [input, wireOptions(options)], options);
  }

  createCylinder(input: CadCylinderInput, options?: CadOperationOptions): Promise<CadShapeHandle> {
    return this.send("createCylinder", [input, wireOptions(options)], options);
  }

  createSphere(input: CadSphereInput, options?: CadOperationOptions): Promise<CadShapeHandle> {
    return this.send("createSphere", [input, wireOptions(options)], options);
  }

  transform(
    shape: CadShapeHandle,
    transform: CadTransform,
    options?: CadOperationOptions,
  ): Promise<CadShapeHandle> {
    return this.send("transform", [shape, transform, wireOptions(options)], options);
  }

  boolean(
    operation: CadBooleanOperation,
    left: CadShapeHandle,
    right: CadShapeHandle,
    options?: CadOperationOptions,
  ): Promise<CadShapeHandle> {
    return this.send("boolean", [operation, left, right, wireOptions(options)], options);
  }

  validate(
    shape: CadShapeHandle,
    options?: CadOperationOptions,
  ): Promise<CadValidationResult> {
    return this.send("validate", [shape, wireOptions(options)], options);
  }

  measure(
    shape: CadShapeHandle,
    densityKgM3?: number,
    options?: CadOperationOptions,
  ): Promise<CadMassProperties> {
    return this.send("measure", [shape, densityKgM3, wireOptions(options)], options);
  }

  tessellate(
    shape: CadShapeHandle,
    options?: CadTessellationOptions,
  ): Promise<CadIndexedMesh> {
    return this.send("tessellate", [shape, wireTessellationOptions(options)], options);
  }

  evaluatePart(
    definition: CadPartDefinitionV1,
    options?: CadPartKernelEvaluationOptions,
  ): Promise<CadPartEvaluationResultV1> {
    return this.send("evaluatePart", [definition, wirePartEvaluationOptions(options)], options);
  }

  exportStep(
    shape: CadShapeHandle,
    name?: string,
    options?: CadOperationOptions,
  ): Promise<CadStepExport> {
    return this.send("exportStep", [shape, name, wireOptions(options)], options);
  }

  release(shape: CadShapeHandle): Promise<void> {
    return this.send("release", [shape]).then(() => undefined);
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    try {
      await this.send("dispose", []);
    } finally {
      this.disposed = true;
      this.worker.terminate();
      this.rejectRemaining(new CadKernelError(
        "kernel_disposed",
        "dispose",
        "CAD worker was disposed",
      ));
    }
  }

  private send<M extends CadWorkerMethod>(
    method: M,
    args: CadWorkerArguments[M],
    operationOptions?: CadOperationOptions,
    budgetOverrideMs?: number,
  ): Promise<CadWorkerResults[M]> {
    const operation = method;
    if (this.disposed) {
      return Promise.reject(new CadKernelError(
        "kernel_disposed",
        operation,
        "CAD worker has been disposed",
      ));
    }
    if (operationOptions?.signal?.aborted) {
      return Promise.reject(new CadKernelError("aborted", operation, "operation was aborted"));
    }

    let allowedMs: number;
    try {
      allowedMs = budgetMs(budgetOverrideMs ?? operationOptions?.budgetMs, operation);
    } catch (error) {
      return Promise.reject(error);
    }

    const id = this.nextRequestId;
    this.nextRequestId += 1;
    const request: CadWorkerRequest<M> = { id, method, args };

    return new Promise<CadWorkerResults[M]>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.terminateRequest(
          id,
          new CadKernelError(
            "operation_timeout",
            operation,
            `worker operation exceeded its ${allowedMs} ms budget`,
          ),
        );
      }, allowedMs);
      const pending: PendingRequest = {
        method,
        operation,
        resolve: resolve as (value: unknown) => void,
        reject,
        timer,
        signal: operationOptions?.signal,
      };
      if (operationOptions?.signal) {
        pending.abortListener = () => {
          this.terminateRequest(
            id,
            new CadKernelError("aborted", operation, "operation was aborted"),
          );
        };
        operationOptions.signal.addEventListener("abort", pending.abortListener, { once: true });
      }
      this.pending.set(id, pending);
      try {
        this.worker.postMessage(request);
      } catch (error) {
        this.finishPending(id);
        reject(new CadKernelError(
          "kernel_initialization_failed",
          operation,
          "could not send request to CAD worker",
          { cause: error },
        ));
      }
    });
  }

  private receive(response: CadWorkerResponse): void {
    const pending = this.pending.get(response.id);
    if (pending === undefined) return;
    this.finishPending(response.id);
    if (!response.ok) {
      pending.reject(new CadKernelError(
        response.error.code,
        response.error.operation,
        response.error.message,
      ));
      return;
    }
    if (response.method !== pending.method) {
      const error = new CadKernelError(
        "kernel_initialization_failed",
        pending.operation,
        "CAD worker response did not match its request",
      );
      pending.reject(error);
      this.terminateAll(error);
      return;
    }
    pending.resolve(response.value);
  }

  private finishPending(id: number): void {
    const pending = this.pending.get(id);
    if (pending === undefined) return;
    clearTimeout(pending.timer);
    if (pending.signal && pending.abortListener) {
      pending.signal.removeEventListener("abort", pending.abortListener);
    }
    this.pending.delete(id);
  }

  /**
   * OCCT's single-threaded synchronous call cannot be interrupted internally.
   * Terminating the Worker is the hard cancellation boundary, so every shape
   * handle from that worker becomes invalid after one timed-out/aborted call.
   */
  private terminateRequest(id: number, primaryError: CadKernelError): void {
    const primary = this.pending.get(id);
    this.finishPending(id);
    primary?.reject(primaryError);
    this.disposed = true;
    this.worker.terminate();
    this.rejectRemaining(new CadKernelError(
      "kernel_disposed",
      primaryError.operation,
      "CAD worker was terminated to stop an operation; create a new worker kernel",
    ));
  }

  private terminateAll(error: CadKernelError): void {
    if (!this.disposed) this.worker.terminate();
    this.disposed = true;
    this.rejectRemaining(error);
  }

  private rejectRemaining(error: CadKernelError): void {
    for (const [id, pending] of this.pending) {
      this.finishPending(id);
      pending.reject(error);
    }
  }
}

/**
 * Creates a dedicated browser Worker, compiles the locally bundled OCCT WASM
 * inside it, and returns the same closed API as `loadCadKernel`. A timeout or
 * abort terminates the worker, which is the only reliable way to preempt a
 * synchronous B-rep operation in the browser.
 */
export async function createCadWorkerKernel(
  options: CreateCadWorkerKernelOptions = {},
): Promise<CadKernel> {
  const worker = (options.workerFactory ?? defaultWorkerFactory)();
  const kernel = new WorkerCadKernel(worker);
  try {
    await kernel.initialize(options.initializationBudgetMs ?? 60_000);
    return kernel;
  } catch (error) {
    await kernel.dispose().catch(() => undefined);
    throw error;
  }
}
