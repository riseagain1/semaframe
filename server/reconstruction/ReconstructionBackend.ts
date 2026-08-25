export const RECONSTRUCTION_DETAILS = [
  "preview",
  "reduced",
  "medium",
  "full",
] as const;

export type ReconstructionDetail = (typeof RECONSTRUCTION_DETAILS)[number];

export type ReconstructionBackendProbe = Readonly<{
  version: 1;
  backendId: string;
  supported: boolean;
  reason?: string;
}>;

export type ReconstructionProgressEvent = Readonly<{
  version: 1;
  type:
    | "started"
    | "progress"
    | "progress_info"
    | "invalid_sample"
    | "skipped_sample"
    | "warning"
    | "complete";
  progress?: number;
  stage?: string;
  estimatedRemainingSeconds?: number;
  sampleId?: number;
  message?: string;
}>;

export type ReconstructionRequest = Readonly<{
  inputDirectory: string;
  outputDirectory: string;
  detail: ReconstructionDetail;
  /** Verified decoded pixels across every source image. */
  aggregatePixelCount: number;
  signal?: AbortSignal;
  onProgress?: (event: ReconstructionProgressEvent) => void;
}>;

export type ReconstructionResult = Readonly<{
  backendId: string;
  outputDirectory: string;
  objPath: string;
  artifacts: readonly string[];
}>;

export interface ReconstructionBackend {
  readonly id: string;
  probe(signal?: AbortSignal): Promise<ReconstructionBackendProbe>;
  reconstruct(request: ReconstructionRequest): Promise<ReconstructionResult>;
}

export type ReconstructionBackendErrorCode =
  | "invalid_request"
  | "unsupported"
  | "aborted"
  | "timeout"
  | "resource_exhausted"
  | "process_failed"
  | "protocol_error"
  | "output_missing";

export class ReconstructionBackendError extends Error {
  readonly code: ReconstructionBackendErrorCode;
  readonly details?: Readonly<Record<string, unknown>>;

  constructor(
    code: ReconstructionBackendErrorCode,
    message: string,
    options: { cause?: unknown; details?: Readonly<Record<string, unknown>> } = {},
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = "ReconstructionBackendError";
    this.code = code;
    this.details = options.details;
  }
}
