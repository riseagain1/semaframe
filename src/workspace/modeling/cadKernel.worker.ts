import initOpenCascade from "replicad-opencascadejs";
import wasmAssetUrl from "replicad-opencascadejs/wasm?url&no-inline";
import * as replicad from "replicad";
import {
  CadKernelError,
  createCadKernelFromRuntime,
  type CadKernel,
} from "./cadKernel";
import type {
  CadWorkerFailure,
  CadWorkerRequest,
  CadWorkerResponse,
  CadWorkerSerializedError,
  CadWorkerSuccess,
} from "./cadWorkerProtocol";

type WorkerScope = Readonly<{
  postMessage: (message: CadWorkerResponse, transfer?: Transferable[]) => void;
}> & {
  onmessage: ((event: MessageEvent<CadWorkerRequest>) => void) | null;
};

const workerScope = globalThis as unknown as WorkerScope;
let kernelPromise: Promise<CadKernel> | undefined;

function getKernel(): Promise<CadKernel> {
  // An explicit URL is required in dev because Vite's optimized dependency URL
  // is not adjacent to the WASM file. The build hook keeps the upstream unused
  // fallback from being inlined in production.
  kernelPromise ??= initOpenCascade({ locateFile: () => wasmAssetUrl }).then((oc) => (
    createCadKernelFromRuntime({ oc, replicad })
  ));
  return kernelPromise;
}

function serializedError(error: unknown, operation: string): CadWorkerSerializedError {
  if (error instanceof CadKernelError) {
    return Object.freeze({
      name: "CadKernelError",
      code: error.code,
      operation: error.operation,
      message: error.message,
    });
  }
  return Object.freeze({
    name: "CadKernelError",
    code: operation === "init" ? "kernel_initialization_failed" : "shape_invalid",
    operation,
    message: error instanceof Error ? error.message : String(error),
  });
}

async function dispatch(request: CadWorkerRequest): Promise<unknown> {
  if (request.method === "init") {
    await getKernel();
    return true;
  }
  if (request.method === "dispose") {
    const kernel = await kernelPromise;
    await kernel?.dispose();
    kernelPromise = undefined;
    return undefined;
  }

  const kernel = await getKernel();
  switch (request.method) {
    case "createBox":
      return kernel.createBox(...request.args as Parameters<CadKernel["createBox"]>);
    case "createCylinder":
      return kernel.createCylinder(...request.args as Parameters<CadKernel["createCylinder"]>);
    case "createSphere":
      return kernel.createSphere(...request.args as Parameters<CadKernel["createSphere"]>);
    case "transform":
      return kernel.transform(...request.args as Parameters<CadKernel["transform"]>);
    case "boolean":
      return kernel.boolean(...request.args as Parameters<CadKernel["boolean"]>);
    case "validate":
      return kernel.validate(...request.args as Parameters<CadKernel["validate"]>);
    case "measure":
      return kernel.measure(...request.args as Parameters<CadKernel["measure"]>);
    case "tessellate":
      return kernel.tessellate(...request.args as Parameters<CadKernel["tessellate"]>);
    case "exportStep":
      return kernel.exportStep(...request.args as Parameters<CadKernel["exportStep"]>);
    case "release":
      return kernel.release(...request.args as Parameters<CadKernel["release"]>);
    default: {
      const exhaustive: never = request.method;
      throw new Error(`Unsupported CAD worker method: ${String(exhaustive)}`);
    }
  }
}

workerScope.onmessage = (event): void => {
  const request = event.data;
  void dispatch(request).then(
    (value) => {
      const response: CadWorkerSuccess = {
        id: request.id,
        ok: true,
        method: request.method,
        value: value as never,
      };
      const transfer = request.method === "tessellate" && value !== null && typeof value === "object"
        ? [
          (value as { positions: Float32Array }).positions.buffer,
          (value as { normals: Float32Array }).normals.buffer,
          (value as { indices: Uint32Array }).indices.buffer,
        ]
        : undefined;
      workerScope.postMessage(response, transfer);
    },
    (error: unknown) => {
      const response: CadWorkerFailure = {
        id: request.id,
        ok: false,
        error: serializedError(error, request.method),
      };
      workerScope.postMessage(response);
    },
  );
};
