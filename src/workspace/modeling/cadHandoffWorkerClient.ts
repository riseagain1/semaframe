import {
  CAD_KERNEL_LIMITS,
} from "./cadKernel";
import {
  CadHandoffError,
  type CadHandoffPackage,
} from "./cadHandoff";
import type { ModelDefinition } from "./modelDefinitions";
import type {
  CadHandoffWorkerRequest,
  CadHandoffWorkerResponse,
} from "./cadHandoffWorkerProtocol";

export type CadHandoffWorkerFactory = () => Worker;

export type CreateCadHandoffInWorkerOptions = Readonly<{
  workerFactory?: CadHandoffWorkerFactory;
  signal?: AbortSignal;
  budgetMs?: number;
  volumeRelativeTolerance?: number;
}>;

function defaultWorkerFactory(): Worker {
  return new Worker(new URL("./cadHandoff.worker.ts", import.meta.url), {
    type: "module",
    name: "semaframe-cad-handoff",
  });
}

function operationBudget(value: number | undefined): number {
  const budget = value ?? CAD_KERNEL_LIMITS.maximumOperationBudgetMs;
  if (!Number.isFinite(budget)) {
    throw new CadHandoffError("invalid_options", "CAD handoff budget must be finite");
  }
  if (
    budget < CAD_KERNEL_LIMITS.minimumOperationBudgetMs
    || budget > CAD_KERNEL_LIMITS.maximumOperationBudgetMs
  ) {
    throw new CadHandoffError(
      "invalid_options",
      `CAD handoff budget must be between ${CAD_KERNEL_LIMITS.minimumOperationBudgetMs} and ${CAD_KERNEL_LIMITS.maximumOperationBudgetMs} ms`,
    );
  }
  return budget;
}

/** Run the complete OCCT export and re-import proof off the browser main thread. */
export function createModelDefinitionCadHandoffPackageInWorker(
  definition: ModelDefinition,
  options: CreateCadHandoffInWorkerOptions = {},
): Promise<CadHandoffPackage> {
  if (options.signal?.aborted) {
    return Promise.reject(new CadHandoffError("aborted", "CAD handoff was aborted"));
  }
  let budget: number;
  try {
    budget = operationBudget(options.budgetMs);
  } catch (error) {
    return Promise.reject(error);
  }
  const factory = options.workerFactory ?? defaultWorkerFactory;
  let worker: Worker;
  try {
    worker = factory();
  } catch (error) {
    return Promise.reject(new CadHandoffError(
      "worker_failed",
      "CAD handoff worker could not be created",
      { cause: error },
    ));
  }
  const request: CadHandoffWorkerRequest = Object.freeze({
    id: 1,
    definition: structuredClone(definition),
    options: Object.freeze({
      ...(options.volumeRelativeTolerance === undefined
        ? {}
        : { volumeRelativeTolerance: options.volumeRelativeTolerance }),
    }),
  });
  return new Promise<CadHandoffPackage>((resolve, reject) => {
    let settled = false;
    const finish = (body: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", abort);
      worker.terminate();
      body();
    };
    const abort = (): void => finish(() => reject(new CadHandoffError(
      "aborted",
      "CAD handoff was aborted",
    )));
    const timer = setTimeout(() => finish(() => reject(new CadHandoffError(
      "operation_timeout",
      `CAD handoff exceeded its ${budget} ms budget`,
    ))), budget);
    worker.onmessage = (event: MessageEvent<CadHandoffWorkerResponse>) => {
      const response = event.data;
      if (response.id !== request.id) return;
      if (response.ok) {
        finish(() => resolve(response.package));
      } else {
        finish(() => reject(new CadHandoffError(
          response.error.code,
          response.error.message,
        )));
      }
    };
    worker.onerror = (event: ErrorEvent) => finish(() => reject(new CadHandoffError(
      "worker_failed",
      event.message || "CAD handoff worker crashed",
    )));
    worker.onmessageerror = () => finish(() => reject(new CadHandoffError(
      "worker_failed",
      "CAD handoff worker returned an unreadable response",
    )));
    options.signal?.addEventListener("abort", abort, { once: true });
    try {
      worker.postMessage(request);
    } catch (error) {
      finish(() => reject(new CadHandoffError(
        "worker_failed",
        "CAD handoff request could not be sent to the worker",
        { cause: error },
      )));
    }
  });
}
