import { useState } from "react";
import type { RealityAssetDescriptor } from "../../../workspace/assets";

export type RealityAssetAvailability = "checking" | "available" | "missing" | "error";

export type WorkspaceRealityAssetItem = Readonly<{
  descriptor: RealityAssetDescriptor;
  availability: RealityAssetAvailability;
  componentIds: readonly string[];
}>;

export type WorkspaceRealityAssetsProps = Readonly<{
  items: readonly WorkspaceRealityAssetItem[];
  disabled?: boolean;
  importBusy?: boolean;
  importStatus?: string;
  onImport?: () => void;
  onRelink?: (assetId: string) => void;
  onDelete?: (assetId: string) => boolean | void | Promise<boolean | void>;
  onSelectComponent?: (componentId: string) => void;
}>;

function formatBytes(bytes: number): string {
  if (bytes < 1_024) return `${bytes} B`;
  if (bytes < 1_048_576) return `${(bytes / 1_024).toFixed(1)} KiB`;
  return `${(bytes / 1_048_576).toFixed(bytes >= 10_485_760 ? 0 : 1)} MiB`;
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
  onImport,
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
