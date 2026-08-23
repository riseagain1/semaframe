import type { ModelDefinition } from "./modelDefinitions";
import type {
  CadHandoffErrorCode,
  CadHandoffPackage,
} from "./cadHandoff";

export type CadHandoffWorkerRequest = Readonly<{
  id: number;
  definition: ModelDefinition;
  options: Readonly<{
    volumeRelativeTolerance?: number;
  }>;
}>;

export type CadHandoffWorkerSuccess = Readonly<{
  id: number;
  ok: true;
  package: CadHandoffPackage;
}>;

export type CadHandoffWorkerFailure = Readonly<{
  id: number;
  ok: false;
  error: Readonly<{
    name: "CadHandoffError";
    code: CadHandoffErrorCode;
    message: string;
  }>;
}>;

export type CadHandoffWorkerResponse = CadHandoffWorkerSuccess | CadHandoffWorkerFailure;
