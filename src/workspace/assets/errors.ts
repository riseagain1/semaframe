export type RealityAssetErrorCode =
  | "aborted"
  | "operation_timeout"
  | "empty_file"
  | "file_too_large"
  | "unsupported_format"
  | "unsupported_compression"
  | "invalid_format"
  | "invalid_descriptor"
  | "splat_limit_exceeded"
  | "expanded_limit_exceeded"
  | "digest_mismatch"
  | "storage_unavailable"
  | "storage_failure"
  | "not_found";

export class RealityAssetError extends Error {
  readonly code: RealityAssetErrorCode;

  constructor(code: RealityAssetErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "RealityAssetError";
    this.code = code;
  }
}

export function throwIfRealityAssetAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) {
    throw new RealityAssetError("aborted", "Reality asset operation was cancelled");
  }
}

export type SerializedRealityAssetError = Readonly<{
  name: "RealityAssetError";
  code: RealityAssetErrorCode;
  message: string;
}>;

export function serializeRealityAssetError(error: unknown): SerializedRealityAssetError {
  if (error instanceof RealityAssetError) {
    return Object.freeze({ name: "RealityAssetError", code: error.code, message: error.message });
  }
  return Object.freeze({
    name: "RealityAssetError",
    code: "invalid_format",
    message: "Reality asset inspection failed",
  });
}

export function deserializeRealityAssetError(error: SerializedRealityAssetError): RealityAssetError {
  return new RealityAssetError(error.code, error.message);
}
