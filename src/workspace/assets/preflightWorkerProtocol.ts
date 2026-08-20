import type { SerializedRealityAssetError } from "./errors";
import type { RealityAssetCandidate } from "./types";

export type RealityAssetWorkerInspectRequest = Readonly<{
  type: "reality-asset/inspect";
  requestId: string;
  blob: Blob;
}>;

export type RealityAssetWorkerCancelRequest = Readonly<{
  type: "reality-asset/cancel";
  requestId: string;
}>;

export type RealityAssetWorkerRequest = RealityAssetWorkerInspectRequest | RealityAssetWorkerCancelRequest;

export type RealityAssetWorkerSuccess = Readonly<{
  type: "reality-asset/result";
  requestId: string;
  candidate: RealityAssetCandidate;
}>;

export type RealityAssetWorkerFailure = Readonly<{
  type: "reality-asset/error";
  requestId: string;
  error: SerializedRealityAssetError;
}>;

export type RealityAssetWorkerCancelled = Readonly<{
  type: "reality-asset/cancelled";
  requestId: string;
}>;

export type RealityAssetWorkerResponse =
  | RealityAssetWorkerSuccess
  | RealityAssetWorkerFailure
  | RealityAssetWorkerCancelled;
