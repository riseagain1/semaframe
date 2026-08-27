export type PortableProjectErrorCode =
  | "aborted"
  | "archive_corrupt"
  | "asset_corrupt"
  | "cached_asset_corrupt"
  | "closure_mismatch"
  | "duplicate_entry"
  | "invalid_manifest"
  | "invalid_path"
  | "legacy_project_invalid"
  | "missing_asset"
  | "project_corrupt"
  | "rollback_failed"
  | "size_limit_exceeded"
  | "unsupported_archive"
  | "unsupported_version";

export class PortableProjectError extends Error {
  constructor(
    readonly code: PortableProjectErrorCode,
    message: string,
    options: ErrorOptions = {},
  ) {
    super(message, options);
    this.name = "PortableProjectError";
  }
}

export function throwIfPortableProjectAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw new PortableProjectError("aborted", "Portable project operation was cancelled");
  }
}

export function portableProjectError(
  error: unknown,
  code: PortableProjectErrorCode,
  message: string,
): PortableProjectError {
  if (error instanceof PortableProjectError) return error;
  if (
    (typeof DOMException !== "undefined" && error instanceof DOMException && error.name === "AbortError")
    || (error !== null
      && typeof error === "object"
      && "code" in error
      && (error as { code?: unknown }).code === "aborted")
  ) {
    return new PortableProjectError("aborted", "Portable project operation was cancelled", { cause: error });
  }
  return new PortableProjectError(code, message, { cause: error });
}
