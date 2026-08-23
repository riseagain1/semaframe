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
    case "evaluatePart":
      return kernel.evaluatePart(...request.args as Parameters<CadKernel["evaluatePart"]>);
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
      let transfer: Transferable[] | undefined;
      if (request.method === "tessellate" && value !== null && typeof value === "object") {
        transfer = [
          (value as { positions: Float32Array }).positions.buffer,
          (value as { normals: Float32Array }).normals.buffer,
          (value as { indices: Uint32Array }).indices.buffer,
        ];
      } else if (request.method === "evaluatePart" && value !== null && typeof value === "object") {
        transfer = (value as { meshes: readonly { mesh: {
          positions: Float32Array;
          normals: Float32Array;
          indices: Uint32Array;
        } }[] }).meshes.flatMap(({ mesh }) => [
          mesh.positions.buffer,
          mesh.normals.buffer,
          mesh.indices.buffer,
        ]);
      }
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
