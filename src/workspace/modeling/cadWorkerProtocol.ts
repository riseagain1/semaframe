import type {
  CadBooleanOperation,
  CadBoxInput,
  CadCylinderInput,
  CadIndexedMesh,
  CadMassProperties,
  CadOperationOptions,
  CadShapeHandle,
  CadSphereInput,
  CadStepExport,
  CadTessellationOptions,
  CadTransform,
  CadValidationResult,
  CadKernelErrorCode,
} from "./cadKernel";

export type CadWorkerMethod =
  | "init"
  | "createBox"
  | "createCylinder"
  | "createSphere"
  | "transform"
  | "boolean"
  | "validate"
  | "measure"
  | "tessellate"
  | "exportStep"
  | "release"
  | "dispose";

export type CadWorkerArguments = Readonly<{
  init: readonly [];
  createBox: readonly [CadBoxInput, CadOperationOptions?];
  createCylinder: readonly [CadCylinderInput, CadOperationOptions?];
  createSphere: readonly [CadSphereInput, CadOperationOptions?];
  transform: readonly [CadShapeHandle, CadTransform, CadOperationOptions?];
  boolean: readonly [
    CadBooleanOperation,
    CadShapeHandle,
    CadShapeHandle,
    CadOperationOptions?,
  ];
  validate: readonly [CadShapeHandle, CadOperationOptions?];
  measure: readonly [CadShapeHandle, number?, CadOperationOptions?];
  tessellate: readonly [CadShapeHandle, CadTessellationOptions?];
  exportStep: readonly [CadShapeHandle, string?, CadOperationOptions?];
  release: readonly [CadShapeHandle];
  dispose: readonly [];
}>;

export type CadWorkerResults = Readonly<{
  init: true;
  createBox: CadShapeHandle;
  createCylinder: CadShapeHandle;
  createSphere: CadShapeHandle;
  transform: CadShapeHandle;
  boolean: CadShapeHandle;
  validate: CadValidationResult;
  measure: CadMassProperties;
  tessellate: CadIndexedMesh;
  exportStep: CadStepExport;
  release: undefined;
  dispose: undefined;
}>;

export type CadWorkerRequest<M extends CadWorkerMethod = CadWorkerMethod> = Readonly<{
  id: number;
  method: M;
  args: CadWorkerArguments[M];
}>;

export type CadWorkerSerializedError = Readonly<{
  name: "CadKernelError";
  code: CadKernelErrorCode;
  operation: string;
  message: string;
}>;

export type CadWorkerSuccess<M extends CadWorkerMethod = CadWorkerMethod> = Readonly<{
  id: number;
  ok: true;
  method: M;
  value: CadWorkerResults[M];
}>;

export type CadWorkerFailure = Readonly<{
  id: number;
  ok: false;
  error: CadWorkerSerializedError;
}>;

export type CadWorkerResponse = CadWorkerSuccess | CadWorkerFailure;
