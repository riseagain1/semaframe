import { useState } from "react";
import type { RealityAssetDescriptor } from "../../../workspace/assets";
import type {
  PhotoReconstructionJobView,
  PhotoReconstructionProfile,
} from "../../../reconstruction/contracts";
import { PHOTO_RECONSTRUCTION_LIMITS } from "../../../reconstruction/contracts";

export type RealityAssetAvailability = "checking" | "available" | "missing" | "error";

export type WorkspaceRealityAssetItem = Readonly<{
  descriptor: RealityAssetDescriptor;
  availability: RealityAssetAvailability;
  componentIds: readonly string[];
}>;

export type WorkspacePhotoReconstructionCapability =
  | "checking"
  | Readonly<{
      available: boolean;
      backend: Readonly<{ id: string; version: string }>;
      reason?: string;
    }>;

export type WorkspaceRealityAssetsProps = Readonly<{
  items: readonly WorkspaceRealityAssetItem[];
  disabled?: boolean;
  importBusy?: boolean;
  importStatus?: string;
  reconstructionCapability?: WorkspacePhotoReconstructionCapability;
  reconstructionProfile?: PhotoReconstructionProfile;
  reconstructionJob?: PhotoReconstructionJobView;
  reconstructionBusy?: boolean;
  reconstructionStatus?: string;
  onImport?: () => void;
  onReconstruct?: () => void;
  onReconstructionProfile?: (profile: PhotoReconstructionProfile) => void;
  onCancelReconstruction?: () => void;
  onRelink?: (assetId: string) => void;
  onDelete?: (assetId: string) => boolean | void | Promise<boolean | void>;
  onSelectComponent?: (componentId: string) => void;
}>;

function formatBytes(bytes: number): string {
  if (bytes < 1_024) return `${bytes} B`;
  if (bytes < 1_048_576) return `${(bytes / 1_024).toFixed(1)} KiB`;
  return `${(bytes / 1_048_576).toFixed(bytes >= 10_485_760 ? 0 : 1)} MiB`;
}

function formatStorageBudget(bytes: number): string {
  const gibibytes = bytes / (1024 * 1024 * 1024);
  return gibibytes >= 1 ? `${gibibytes.toFixed(gibibytes % 1 === 0 ? 0 : 1)} GiB` : formatBytes(bytes);
}

function shortDigest(digest: string): string {
  return `${digest.slice(0, 15)}…${digest.slice(-8)}`;
}

function availabilityCopy(availability: RealityAssetAvailability): string {
  if (availability === "available") return "Local bytes ready";
  if (availability === "missing") return "Local bytes missing";
  if (availability === "error") return "Local storage unavailable";
  return "Checking local bytes";
}

/**
 * Human-facing view of the project's safe Reality metadata and the separate
 * local binary vault. File names and bytes never cross this component boundary.
 */
export function WorkspaceRealityAssets({
  items,
  disabled = false,
  importBusy = false,
  importStatus,
  reconstructionCapability = "checking",
  reconstructionProfile = "balanced",
  reconstructionJob,
  reconstructionBusy = false,
  reconstructionStatus,
  onImport,
  onReconstruct,
  onReconstructionProfile,
  onCancelReconstruction,
  onRelink,
  onDelete,
  onSelectComponent,
}: WorkspaceRealityAssetsProps) {
  const [confirmDelete, setConfirmDelete] = useState<string>();

  return (
    <aside className="workspace-side-panel workspace-reality" aria-label="Reality assets">
      <header>
        <span>Reality</span>
        <strong>{items.length} {items.length === 1 ? "asset" : "assets"}</strong>
      </header>
      <section className="workspace-reality__import workspace-reality__reconstruct" aria-label="Reconstruct Reality from photos">
        <div className="workspace-reality__section-heading">
          <h3>Reconstruct from photos</h3>
          <span>Local</span>
        </div>
        <p>
          Choose overlapping JPEG, PNG, WebP, HEIC, or HEIF views. Twenty or more well-lit
          angles are recommended; temporary source photos are deleted after the job.
        </p>
        <label className="workspace-reality__profile">
          <span>Detail</span>
          <select
            value={reconstructionProfile}
            disabled={disabled || importBusy || reconstructionBusy || !onReconstructionProfile}
            onChange={(event) => onReconstructionProfile?.(event.target.value as PhotoReconstructionProfile)}
          >
            <option value="preview">Preview · fast</option>
            <option value="balanced">Balanced</option>
            <option value="quality">Quality · slow</option>
          </select>
        </label>
        {reconstructionCapability === "checking" ? (
          <p className="workspace-reality__capability" role="status">Checking the local reconstruction backend…</p>
        ) : !reconstructionCapability.available ? (
          <p className="workspace-reality__capability is-unavailable" role="status">
            {reconstructionCapability.reason ?? "Photo reconstruction is unavailable on this machine."}
          </p>
        ) : (
          <p className="workspace-reality__capability" role="status">
            {reconstructionCapability.backend.id === "apple-object-capture-gaussian"
              ? `Apple Object Capture is ready on this Mac. ${reconstructionProfile[0]!.toUpperCase()}${reconstructionProfile.slice(1)} limits: ${PHOTO_RECONSTRUCTION_LIMITS.objectCaptureMaximumPixelsByProfile[reconstructionProfile] / 1_000_000}M decoded pixels; ${formatStorageBudget(PHOTO_RECONSTRUCTION_LIMITS.objectCaptureOutputBytesByProfile[reconstructionProfile])} temp plus ${formatStorageBudget(PHOTO_RECONSTRUCTION_LIMITS.objectCaptureMinimumFreeReserveBytes)} disk reserve; ${formatStorageBudget(PHOTO_RECONSTRUCTION_LIMITS.objectCaptureMaximumProcessRssBytesByProfile[reconstructionProfile])} process-tree RSS plus ${formatStorageBudget(PHOTO_RECONSTRUCTION_LIMITS.objectCaptureMinimumFreeMemoryReserveBytes)} memory reserve.`
              : `${reconstructionCapability.backend.id} is ready.`}
          </p>
        )}
        <button
          type="button"
          disabled={disabled || importBusy || reconstructionBusy || !onReconstruct ||
            reconstructionCapability === "checking" || !reconstructionCapability.available}
          onClick={onReconstruct}
        >
          {reconstructionBusy ? "Reconstructing…" : "Choose photo set…"}
        </button>
        {(reconstructionJob || reconstructionBusy) && (
          <div className="workspace-reality__progress" aria-label="Photo reconstruction progress">
            <div>
              <strong>{reconstructionJob?.status.replaceAll("_", " ") ?? "preparing photos"}</strong>
              <span>{Math.round((reconstructionJob?.progress ?? 0) * 100)}%</span>
            </div>
            <progress
              aria-label="Photo reconstruction progress"
              max={1}
              value={reconstructionJob?.progress ?? 0}
            />
            {reconstructionJob && (
              <small>
                {reconstructionJob.uploadedPhotoCount}/{reconstructionJob.inputPhotoCount} photos verified
                {reconstructionJob.registeredPhotoCount === undefined
                  ? ""
                  : ` · ${reconstructionJob.registeredPhotoCount} cameras solved`}
              </small>
            )}
            {reconstructionBusy && onCancelReconstruction && (
              <button type="button" className="is-secondary" disabled={disabled} onClick={onCancelReconstruction}>
                Cancel and delete temporary photos
              </button>
            )}
          </div>
        )}
        {reconstructionStatus && (
          <p
            aria-label="Photo reconstruction status"
            className="workspace-reality__status"
            role="status"
          >
            {reconstructionStatus}
          </p>
        )}
        <p className="workspace-reality__boundary">
          Output is visual-only and uncalibrated. Add scale and semantic proxies before collision,
          measurement, physics, CAD, or survey use.
        </p>
      </section>
      <section className="workspace-reality__import" aria-label="Import Reality asset">
        <h3>Gaussian capture</h3>
        <p>
          Import PLY, SPZ v4, or SOG v2. The project stores verified metadata only;
          source bytes stay in this browser's private asset vault.
        </p>
        <button type="button" disabled={disabled || importBusy || !onImport} onClick={onImport}>
          {importBusy ? "Inspecting asset…" : "Import Reality asset"}
        </button>
        {importStatus && <p className="workspace-reality__status" role="status">{importStatus}</p>}
      </section>

      {items.length === 0 ? (
        <p className="workspace-empty-copy">
          No Reality assets yet. An import creates an editable, visual-only Gaussian layer.
        </p>
      ) : (
        <ul className="workspace-reality__list">
          {items.map(({ descriptor, availability, componentIds }) => {
            const deleting = confirmDelete === descriptor.assetId;
            return (
              <li key={descriptor.assetId} className="workspace-reality-card">
                <div className="workspace-reality-card__heading">
                  <strong>{descriptor.format.toUpperCase()}</strong>
                  <span className={`is-${availability}`}>{availabilityCopy(availability)}</span>
                </div>
                <code title={descriptor.digest}>{shortDigest(descriptor.digest)}</code>
                <dl>
                  <div><dt>Splats</dt><dd>{descriptor.splatCount.toLocaleString()}</dd></div>
                  <div><dt>Bytes</dt><dd>{formatBytes(descriptor.byteLength)}</dd></div>
                  <div><dt>Coordinates</dt><dd>{descriptor.coordinateSystem.system}</dd></div>
                  <div><dt>Authority</dt><dd>Visual only</dd></div>
                </dl>

                {componentIds.length > 0 && (
                  <div className="workspace-reality-card__instances">
                    <span>{componentIds.length} {componentIds.length === 1 ? "instance" : "instances"}</span>
                    {componentIds.map((componentId, index) => (
                      <button
                        key={componentId}
                        type="button"
                        disabled={disabled || !onSelectComponent}
                        onClick={() => onSelectComponent?.(componentId)}
                      >
                        Select {index + 1}
                      </button>
                    ))}
                  </div>
                )}

                {availability === "missing" || availability === "error" ? (
                  <div className="workspace-reality-card__relink">
                    <p>
                      The scene keeps a placeholder until you choose the exact same content again.
                    </p>
                    <button
                      type="button"
                      disabled={disabled || importBusy || !onRelink}
                      onClick={() => onRelink?.(descriptor.assetId)}
                    >
                      Relink same asset…
                    </button>
                  </div>
                ) : null}

                {componentIds.length === 0 && (deleting ? (
                  <div className="workspace-reality-card__delete" role="alertdialog" aria-label="Remove Reality asset">
                    <p>Remove this metadata from the project? Content-addressed local bytes stay cached because another project may use the same digest.</p>
                    <div>
                      <button type="button" onClick={() => setConfirmDelete(undefined)}>Cancel</button>
                      <button
                        type="button"
                        className="is-danger"
                        disabled={disabled || !onDelete}
                        onClick={async () => {
                          const deleted = await onDelete?.(descriptor.assetId);
                          if (deleted !== false) setConfirmDelete(undefined);
                        }}
                      >
                        Confirm remove
                      </button>
                    </div>
                  </div>
                ) : (
                  <button
                    type="button"
                    className="workspace-reality-card__remove is-danger"
                    disabled={disabled || !onDelete}
                    onClick={() => setConfirmDelete(descriptor.assetId)}
                  >
                    Remove unreferenced asset…
                  </button>
                ))}
              </li>
            );
          })}
        </ul>
      )}
    </aside>
  );
}
