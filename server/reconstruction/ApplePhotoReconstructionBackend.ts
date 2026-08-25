import { lstat, readdir, statfs } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import {
  PHOTO_RECONSTRUCTION_LIMITS,
} from "../../src/reconstruction/contracts";
import type {
  PhotoReconstructionProfile,
  PhotoReconstructionWarningCode,
} from "../../src/reconstruction/contracts";
import {
  PhotoReconstructionBackendError,
} from "./PhotoReconstructionService";
import type {
  PhotoReconstructionBackend,
  PhotoReconstructionBackendRequest,
  PhotoReconstructionBackendResult,
} from "./PhotoReconstructionService";
import { AppleObjectCaptureBackend } from "./AppleObjectCaptureBackend";
import {
  RECONSTRUCTION_DETAILS,
  ReconstructionBackendError,
} from "./ReconstructionBackend";
import type {
  ReconstructionBackend,
  ReconstructionDetail,
  ReconstructionProgressEvent,
} from "./ReconstructionBackend";
import {
  ObjToGaussianPlyError,
  objToGaussianPly,
} from "./objToGaussianPly";
import type {
  ObjToGaussianPlyOptions,
  ObjToGaussianPlyResult,
} from "./objToGaussianPly";

const DEFAULT_PROFILE_DETAILS: Readonly<Record<PhotoReconstructionProfile, ReconstructionDetail>> =
  Object.freeze({
    preview: "preview",
    balanced: "medium",
    quality: "full",
  });

const DEFAULT_PROFILE_SPLATS: Readonly<Record<PhotoReconstructionProfile, number>> =
  Object.freeze({
    preview: 250_000,
    balanced: 1_000_000,
    quality: 4_000_000,
  });

const MAX_OUTPUT_TREE_ENTRIES = 100_000;
const MAX_OUTPUT_TREE_DEPTH = 24;

type AvailableOutputBytes = (path: string) => Promise<bigint>;

type ConvertObj = (options: ObjToGaussianPlyOptions) => Promise<ObjToGaussianPlyResult>;

export type ApplePhotoReconstructionBackendOptions = Readonly<{
  objectCaptureBackend?: ReconstructionBackend;
  profileDetails?: Partial<Readonly<Record<PhotoReconstructionProfile, ReconstructionDetail>>>;
  profileSplatCounts?: Partial<Readonly<Record<PhotoReconstructionProfile, number>>>;
  convertObj?: ConvertObj;
  availableOutputBytes?: AvailableOutputBytes;
}>;

async function filesystemAvailableBytes(path: string): Promise<bigint> {
  let candidate = resolve(path);
  while (true) {
    try {
      const stats = await statfs(candidate, { bigint: true });
      return stats.bavail * stats.bsize;
    } catch (cause) {
      if (!(cause instanceof Error) || !("code" in cause) || cause.code !== "ENOENT") throw cause;
      const parent = dirname(candidate);
      if (parent === candidate) throw cause;
      candidate = parent;
    }
  }
}

async function boundedOutputTreeBytes(root: string, maximumBytes: number): Promise<number> {
  let rootInfo;
  try {
    rootInfo = await lstat(root);
  } catch (cause) {
    throw new PhotoReconstructionBackendError("output_invalid", false);
  }
  if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) {
    throw new PhotoReconstructionBackendError("output_invalid", false);
  }

  const pending: Array<Readonly<{ path: string; depth: number }>> = [{ path: root, depth: 0 }];
  let entriesVisited = 0;
  let totalBytes = 0;
  while (pending.length > 0) {
    const current = pending.pop()!;
    if (current.depth > MAX_OUTPUT_TREE_DEPTH) {
      throw new PhotoReconstructionBackendError("output_invalid", false);
    }
    let entries;
    try {
      entries = await readdir(current.path, { withFileTypes: true });
    } catch {
      throw new PhotoReconstructionBackendError("output_invalid", false);
    }
    for (const entry of entries) {
      entriesVisited += 1;
      if (entriesVisited > MAX_OUTPUT_TREE_ENTRIES) {
        throw new PhotoReconstructionBackendError("output_invalid", false);
      }
      const path = join(current.path, entry.name);
      let info;
      try {
        info = await lstat(path);
      } catch {
        throw new PhotoReconstructionBackendError("output_invalid", false);
      }
      if (info.isSymbolicLink()) throw new PhotoReconstructionBackendError("output_invalid", false);
      if (info.isDirectory()) {
        pending.push({ path, depth: current.depth + 1 });
        continue;
      }
      if (!info.isFile() || !Number.isSafeInteger(info.size) || info.size < 0) {
        throw new PhotoReconstructionBackendError("output_invalid", false);
      }
      totalBytes += info.size;
      if (!Number.isSafeInteger(totalBytes) || totalBytes > maximumBytes) {
        throw new PhotoReconstructionBackendError("resource_exhausted", true);
      }
    }
  }
  return totalBytes;
}

async function checkedAvailableOutputBytes(
  outputDirectory: string,
  availableOutputBytes: AvailableOutputBytes,
): Promise<bigint> {
  try {
    const available = await availableOutputBytes(outputDirectory);
    if (typeof available !== "bigint" || available < 0n) throw new Error("invalid available bytes");
    return available;
  } catch (cause) {
    throw new PhotoReconstructionBackendError("resource_exhausted", true);
  }
}

function validatedSplatCounts(
  overrides: ApplePhotoReconstructionBackendOptions["profileSplatCounts"],
): Readonly<Record<PhotoReconstructionProfile, number>> {
  const result = { ...DEFAULT_PROFILE_SPLATS, ...overrides };
  for (const [profile, count] of Object.entries(result)) {
    if (!Number.isSafeInteger(count) || count < 1 || count > 4_000_000) {
      throw new TypeError(`Apple reconstruction ${profile} splat count must be between 1 and 4000000`);
    }
  }
  return Object.freeze(result);
}

function mappedBackendError(error: unknown): never {
  if (error instanceof ReconstructionBackendError) {
    if (error.code === "aborted") throw error;
    if (error.code === "unsupported" || error.code === "process_failed") {
      throw new PhotoReconstructionBackendError("backend_unavailable", true);
    }
    if (error.code === "timeout" || error.code === "resource_exhausted") {
      throw new PhotoReconstructionBackendError("resource_exhausted", true);
    }
    if (error.code === "invalid_request") {
      throw new PhotoReconstructionBackendError("input_decode_failed");
    }
    throw new PhotoReconstructionBackendError("output_invalid");
  }
  if (error instanceof ObjToGaussianPlyError) {
    if (error.code === "aborted") throw error;
    if (error.code === "resource_limit") {
      const cause = (error as Error & { cause?: unknown }).cause;
      if (cause instanceof PhotoReconstructionBackendError) throw cause;
      throw new PhotoReconstructionBackendError("resource_exhausted");
    }
    throw new PhotoReconstructionBackendError("output_invalid");
  }
  throw error;
}

function cameraProgress(event: ReconstructionProgressEvent): number | undefined {
  if (event.type === "started") return 0.03;
  if (event.type === "complete") return 0.85;
  if (event.type === "progress" && event.progress !== undefined) {
    return 0.05 + event.progress * 0.78;
  }
  return undefined;
}

/**
 * Local macOS pipeline: Apple Object Capture produces an editable textured
 * mesh, then the bounded converter packs a visual-only Gaussian PLY for the
 * existing Reality Asset ingress. Source units and axes remain explicitly
 * unknown; this adapter never invents metric scale or coordinate authority.
 */
export class ApplePhotoReconstructionBackend implements PhotoReconstructionBackend {
  readonly identity = Object.freeze({ id: "apple-object-capture-gaussian", version: "1" });
  readonly #objectCaptureBackend: ReconstructionBackend;
  readonly #profileDetails: Readonly<Record<PhotoReconstructionProfile, ReconstructionDetail>>;
  readonly #profileSplatCounts: Readonly<Record<PhotoReconstructionProfile, number>>;
  readonly #convertObj: ConvertObj;
  readonly #availableOutputBytes: AvailableOutputBytes;

  constructor(options: ApplePhotoReconstructionBackendOptions = {}) {
    this.#objectCaptureBackend = options.objectCaptureBackend ?? new AppleObjectCaptureBackend();
    this.#profileDetails = Object.freeze({ ...DEFAULT_PROFILE_DETAILS, ...options.profileDetails });
    for (const detail of Object.values(this.#profileDetails)) {
      if (!RECONSTRUCTION_DETAILS.includes(detail)) {
        throw new TypeError("Apple reconstruction detail must be preview, reduced, medium, or full");
      }
    }
    this.#profileSplatCounts = validatedSplatCounts(options.profileSplatCounts);
    this.#convertObj = options.convertObj ?? objToGaussianPly;
    this.#availableOutputBytes = options.availableOutputBytes ?? filesystemAvailableBytes;
  }

  async probe(signal?: AbortSignal): Promise<Readonly<{ available: boolean; reason?: string }>> {
    const result = await this.#objectCaptureBackend.probe(signal);
    return Object.freeze({
      available: result.supported,
      ...(result.reason ? { reason: result.reason } : {}),
    });
  }

  async run(request: PhotoReconstructionBackendRequest): Promise<PhotoReconstructionBackendResult> {
    const rejectedSamples = new Set<number>();
    try {
      const mesh = await this.#objectCaptureBackend.reconstruct({
        inputDirectory: request.inputDirectory,
        outputDirectory: request.outputDirectory,
        detail: this.#profileDetails[request.profile],
        aggregatePixelCount: request.aggregatePixelCount,
        signal: request.signal,
        onProgress: (event) => {
          if ((event.type === "invalid_sample" || event.type === "skipped_sample") && event.sampleId !== undefined) {
            rejectedSamples.add(event.sampleId);
          }
          const progress = cameraProgress(event);
          if (progress !== undefined) {
            request.onProgress({ phase: "camera_solving", progress });
          }
        },
      });

      const registeredPhotoCount = Math.max(0, request.photos.length - rejectedSamples.size);
      const partialWarning: readonly PhotoReconstructionWarningCode[] = registeredPhotoCount < request.photos.length
        ? ["partial_camera_registration"]
        : [];
      request.onProgress({
        phase: "training",
        progress: 0.88,
        registeredPhotoCount,
        warnings: partialWarning,
      });

      const outputPath = join(request.outputDirectory, "reconstruction.ply");
      const maximumTreeBytes = PHOTO_RECONSTRUCTION_LIMITS.objectCaptureOutputBytesByProfile[request.profile];
      const existingTreeBytes = await boundedOutputTreeBytes(request.outputDirectory, maximumTreeBytes);
      const remainingTreeBytes = maximumTreeBytes - existingTreeBytes;
      if (remainingTreeBytes < 1) {
        throw new PhotoReconstructionBackendError("resource_exhausted", true);
      }
      const maximumPlyBytes = Math.min(
        PHOTO_RECONSTRUCTION_LIMITS.maximumOutputBytes,
        remainingTreeBytes,
      );
      let reservedPlyBytes: number | undefined;
      const reserveOutputBytes = async (remainingOutputBytes: number): Promise<void> => {
        if (!Number.isSafeInteger(remainingOutputBytes) || remainingOutputBytes < 0
          || remainingOutputBytes > maximumPlyBytes) {
          throw new PhotoReconstructionBackendError("resource_exhausted", true);
        }
        if (reservedPlyBytes === undefined) {
          reservedPlyBytes = remainingOutputBytes;
          if (existingTreeBytes + reservedPlyBytes > maximumTreeBytes) {
            throw new PhotoReconstructionBackendError("resource_exhausted", true);
          }
        } else if (remainingOutputBytes > reservedPlyBytes) {
          throw new PhotoReconstructionBackendError("resource_exhausted", true);
        }
        const availableBytes = await checkedAvailableOutputBytes(
          request.outputDirectory,
          this.#availableOutputBytes,
        );
        if (availableBytes < BigInt(remainingOutputBytes)
            + BigInt(PHOTO_RECONSTRUCTION_LIMITS.objectCaptureMinimumFreeReserveBytes)) {
          throw new PhotoReconstructionBackendError("resource_exhausted", true);
        }
      };
      await this.#convertObj({
        objPath: mesh.objPath,
        assetRoot: request.outputDirectory,
        outputPath,
        targetSplatCount: this.#profileSplatCounts[request.profile],
        maxSplats: 4_000_000,
        maxBytes: maximumPlyBytes,
        reserveOutputBytes,
        signal: request.signal,
      });
      await boundedOutputTreeBytes(request.outputDirectory, maximumTreeBytes);
      await reserveOutputBytes(0);
      request.onProgress({ phase: "packing", progress: 0.94, registeredPhotoCount });

      return Object.freeze({
        outputPath,
        format: "ply",
        registeredPhotoCount,
        warnings: Object.freeze([
          ...partialWarning,
          "source_scale_unknown",
          "source_coordinates_unknown",
        ] satisfies PhotoReconstructionWarningCode[]),
      });
    } catch (error) {
      mappedBackendError(error);
    }
  }
}

export const applePhotoReconstructionProfileDetails = DEFAULT_PROFILE_DETAILS;
export const applePhotoReconstructionProfileSplatCounts = DEFAULT_PROFILE_SPLATS;
