import { ApplePhotoReconstructionBackend } from "./ApplePhotoReconstructionBackend";
import {
  PhotoReconstructionBackendError,
  type PhotoReconstructionBackend,
  type PhotoReconstructionBackendRequest,
} from "./PhotoReconstructionService";

export const RECONSTRUCTION_BACKEND_MODES = ["auto", "apple", "remote", "none"] as const;
export type ReconstructionBackendMode = (typeof RECONSTRUCTION_BACKEND_MODES)[number];
export type SelectedReconstructionBackend = Exclude<ReconstructionBackendMode, "auto">;

export type ReconstructionBackendCapabilityReason =
  | "disabled"
  | "remote_not_configured"
  | "no_platform_backend"
  | "provider_unavailable";

export type ReconstructionBackendCapability = Readonly<{
  version: 1;
  requested: ReconstructionBackendMode;
  selected: SelectedReconstructionBackend;
  backend: Readonly<{ id: string; version: string }>;
  available: boolean;
  reason?: ReconstructionBackendCapabilityReason;
}>;

export type ReconstructionBackendFactoryOptions = Readonly<{
  mode?: ReconstructionBackendMode;
  platform?: NodeJS.Platform;
  appleFactory?: () => PhotoReconstructionBackend;
  remoteBackend?: PhotoReconstructionBackend;
}>;

export type ReconstructionBackendFactoryResult = Readonly<{
  requested: ReconstructionBackendMode;
  selected: SelectedReconstructionBackend;
  backend: PhotoReconstructionBackend;
  capability(signal?: AbortSignal): Promise<ReconstructionBackendCapability>;
}>;

class UnavailablePhotoReconstructionBackend implements PhotoReconstructionBackend {
  readonly identity = Object.freeze({ id: "reconstruction-unavailable", version: "1" });

  constructor(readonly reason: Exclude<ReconstructionBackendCapabilityReason, "provider_unavailable">) {}

  async probe(): Promise<Readonly<{ available: boolean; reason?: string }>> {
    return Object.freeze({ available: false, reason: "Photo reconstruction is unavailable." });
  }

  async run(_request: PhotoReconstructionBackendRequest): Promise<never> {
    throw new PhotoReconstructionBackendError("backend_unavailable", false);
  }
}

function checkedMode(value: ReconstructionBackendMode | undefined): ReconstructionBackendMode {
  const mode = value ?? "auto";
  if (!RECONSTRUCTION_BACKEND_MODES.includes(mode)) {
    throw new TypeError("Reconstruction backend mode must be auto, apple, remote, or none");
  }
  return mode;
}

function appleBackend(options: ReconstructionBackendFactoryOptions): PhotoReconstructionBackend {
  return (options.appleFactory ?? (() => new ApplePhotoReconstructionBackend()))();
}

function selectedBackend(
  requested: ReconstructionBackendMode,
  platform: NodeJS.Platform,
  options: ReconstructionBackendFactoryOptions,
): Readonly<{ selected: SelectedReconstructionBackend; backend: PhotoReconstructionBackend }> {
  if (requested === "none") {
    return Object.freeze({
      selected: "none",
      backend: new UnavailablePhotoReconstructionBackend("disabled"),
    });
  }
  if (requested === "apple") {
    return Object.freeze({ selected: "apple", backend: appleBackend(options) });
  }
  if (requested === "remote") {
    return options.remoteBackend
      ? Object.freeze({ selected: "remote", backend: options.remoteBackend })
      : Object.freeze({
        selected: "none",
        backend: new UnavailablePhotoReconstructionBackend("remote_not_configured"),
      });
  }

  // Existing behavior remains unchanged on macOS: auto selects the local
  // Apple Object Capture adapter and lets its probe describe availability.
  if (platform === "darwin") {
    return Object.freeze({ selected: "apple", backend: appleBackend(options) });
  }
  if (options.remoteBackend) {
    return Object.freeze({ selected: "remote", backend: options.remoteBackend });
  }
  return Object.freeze({
    selected: "none",
    backend: new UnavailablePhotoReconstructionBackend("no_platform_backend"),
  });
}

/**
 * Selects a configured provider without guessing a remote service or leaking
 * credentials into this layer. `auto` is Apple-local on macOS, remote when an
 * adapter is explicitly injected elsewhere, and unavailable otherwise.
 */
export function createReconstructionBackendFactory(
  options: ReconstructionBackendFactoryOptions = {},
): ReconstructionBackendFactoryResult {
  const requested = checkedMode(options.mode);
  const selection = selectedBackend(requested, options.platform ?? process.platform, options);
  const unavailableReason = selection.backend instanceof UnavailablePhotoReconstructionBackend
    ? selection.backend.reason
    : undefined;

  return Object.freeze({
    requested,
    selected: selection.selected,
    backend: selection.backend,
    async capability(signal?: AbortSignal): Promise<ReconstructionBackendCapability> {
      let available = unavailableReason === undefined;
      let reason: ReconstructionBackendCapabilityReason | undefined = unavailableReason;
      if (available && selection.backend.probe) {
        try {
          const result = await selection.backend.probe(signal);
          available = result.available === true;
          if (!available) reason = "provider_unavailable";
        } catch {
          available = false;
          reason = "provider_unavailable";
        }
      }
      return Object.freeze({
        version: 1,
        requested,
        selected: selection.selected,
        backend: Object.freeze({ ...selection.backend.identity }),
        available,
        ...(reason ? { reason } : {}),
      });
    },
  });
}
