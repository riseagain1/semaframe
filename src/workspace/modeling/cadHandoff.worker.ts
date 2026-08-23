import {
  CadHandoffError,
  createModelDefinitionCadHandoffPackage,
  type CadHandoffPackage,
} from "./cadHandoff";
import type {
  CadHandoffWorkerFailure,
  CadHandoffWorkerRequest,
  CadHandoffWorkerResponse,
  CadHandoffWorkerSuccess,
} from "./cadHandoffWorkerProtocol";

type WorkerScope = Readonly<{
  postMessage: (message: CadHandoffWorkerResponse, transfer?: Transferable[]) => void;
}> & {
  onmessage: ((event: MessageEvent<CadHandoffWorkerRequest>) => void) | null;
};

const scope = globalThis as unknown as WorkerScope;

function transferableBuffers(value: CadHandoffPackage): ArrayBuffer[] {
  const buffers = [value.archive.bytes.buffer, ...value.files.map((file) => file.bytes.buffer)];
  return [...new Set(buffers)].filter((buffer): buffer is ArrayBuffer => buffer instanceof ArrayBuffer);
}

function failure(id: number, error: unknown): CadHandoffWorkerFailure {
  if (error instanceof CadHandoffError) {
    return Object.freeze({
      id,
      ok: false,
      error: Object.freeze({
        name: "CadHandoffError",
        code: error.code,
        message: error.message,
      }),
    });
  }
  return Object.freeze({
    id,
    ok: false,
    error: Object.freeze({
      name: "CadHandoffError",
      code: "export_failed",
      message: error instanceof Error ? error.message : String(error),
    }),
  });
}

scope.onmessage = (event): void => {
  const request = event.data;
  void createModelDefinitionCadHandoffPackage(request.definition, request.options).then(
    (result) => {
      const response: CadHandoffWorkerSuccess = Object.freeze({
        id: request.id,
        ok: true,
        package: result,
      });
      scope.postMessage(response, transferableBuffers(result));
    },
    (error: unknown) => scope.postMessage(failure(request.id, error)),
  );
};
