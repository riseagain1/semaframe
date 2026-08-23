import { useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import type { ModelDefinition } from "../../../workspace/modeling";

const MODEL_ID_PATTERN = /^[A-Za-z][A-Za-z0-9._:-]{0,127}$/u;
const SEMVER_PATTERN = /^[0-9]+\.[0-9]+\.[0-9]+(?:-[A-Za-z0-9.-]+)?$/u;

export type WorkspaceModelPublishRequest = Readonly<{
  rootId: string;
  modelId: string;
  version: string;
  displayName: string;
}>;

export type WorkspaceModelSelection = Readonly<{
  id: string;
  label: string;
}>;

export type WorkspaceModelHierarchyItem = Readonly<{
  id: string;
  label: string;
  typeId: string;
  parentId?: string;
  depth: number;
}>;

export type WorkspaceModelExportAction = Readonly<{
  id: string;
  label: string;
  onExport: (definition: ModelDefinition) => boolean | void | Promise<boolean | void>;
  /** Optional per-definition capability gate, for example a supported STEP subset. */
  isAvailable?: (definition: ModelDefinition) => boolean;
  unavailableReason?: string | ((definition: ModelDefinition) => string);
}>;

export type WorkspaceModelLibraryProps = Readonly<{
  definitions: readonly ModelDefinition[];
  selectedAssembly?: WorkspaceModelSelection;
  disabled?: boolean;
  onPublish?: (request: WorkspaceModelPublishRequest) => boolean | void;
  onInstantiate?: (definition: ModelDefinition) => boolean | void;
  exportActions?: readonly WorkspaceModelExportAction[];
  onDelete?: (definition: ModelDefinition) => boolean | void;
  onCreateExample?: () => void;
  hierarchyItems?: readonly WorkspaceModelHierarchyItem[];
  selectedComponentId?: string;
  onSelectComponent?: (componentId: string) => void;
}>;

function modelSlug(label: string): string {
  const slug = label
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, ".")
    .replace(/^\.+|\.+$/gu, "")
    .slice(0, 96);
  return `com.semaframe.${slug || "model"}`;
}

/** Human publishing and reuse surface for immutable Workspace model definitions. */
export function WorkspaceModelLibrary({
  definitions,
  selectedAssembly,
  disabled = false,
  onPublish,
  onInstantiate,
  exportActions = [],
  onDelete,
  onCreateExample,
  hierarchyItems = [],
  selectedComponentId,
  onSelectComponent,
}: WorkspaceModelLibraryProps) {
  const [modelId, setModelId] = useState(() => modelSlug(selectedAssembly?.label ?? "model"));
  const [version, setVersion] = useState("1.0.0");
  const [displayName, setDisplayName] = useState(selectedAssembly?.label ?? "Reusable model");
  const [formError, setFormError] = useState<string>();
  const [pendingDeleteKey, setPendingDeleteKey] = useState<string>();
  const [pendingExportKey, setPendingExportKey] = useState<string>();
  const [actionError, setActionError] = useState<string>();
  const deleteCancelRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!selectedAssembly) return;
    setModelId(modelSlug(selectedAssembly.label));
    setDisplayName(selectedAssembly.label);
    setFormError(undefined);
  }, [selectedAssembly?.id, selectedAssembly?.label]);

  useEffect(() => {
    if (!pendingDeleteKey) return;
    const previouslyFocused = document.activeElement instanceof HTMLElement ? document.activeElement : undefined;
    const frame = requestAnimationFrame(() => deleteCancelRef.current?.focus());
    return () => {
      cancelAnimationFrame(frame);
      previouslyFocused?.focus({ preventScroll: true });
    };
  }, [pendingDeleteKey]);

  const sortedDefinitions = useMemo(() => [...definitions].sort((left, right) =>
    left.displayName.localeCompare(right.displayName)
      || left.version.localeCompare(right.version)
      || left.modelId.localeCompare(right.modelId)), [definitions]);

  const runExport = async (
    action: WorkspaceModelExportAction,
    definition: ModelDefinition,
  ): Promise<void> => {
    const key = `${definition.modelId}@${definition.version}:${action.id}`;
    if (pendingExportKey) return;
    setPendingExportKey(key);
    setActionError(undefined);
    try {
      await action.onExport(definition);
    } catch (error) {
      setActionError(error instanceof Error ? error.message : "The export could not be completed.");
    } finally {
      setPendingExportKey(undefined);
    }
  };

  const publish = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!selectedAssembly) {
      setFormError("Select a model assembly before publishing.");
      return;
    }
    const normalizedId = modelId.trim();
    const normalizedVersion = version.trim();
    const normalizedName = displayName.trim();
    if (!MODEL_ID_PATTERN.test(normalizedId)) {
      setFormError("Model ID must start with a letter and use only letters, numbers, dots, colons, underscores, or hyphens.");
      return;
    }
    if (!SEMVER_PATTERN.test(normalizedVersion)) {
      setFormError("Version must use semantic version syntax, such as 1.0.0 or 1.1.0-beta.1.");
      return;
    }
    if (!normalizedName || normalizedName.length > 256) {
      setFormError("Display name must contain 1 to 256 characters.");
      return;
    }
    if (definitions.some((definition) => definition.modelId === normalizedId && definition.version === normalizedVersion)) {
      setFormError(`${normalizedId}@${normalizedVersion} already exists. Publish a new version instead.`);
      return;
    }
    setFormError(undefined);
    onPublish?.({
      rootId: selectedAssembly.id,
      modelId: normalizedId,
      version: normalizedVersion,
      displayName: normalizedName,
    });
  };

  return (
    <aside className="workspace-side-panel workspace-models" aria-label="Reusable models">
      <header><strong>Models</strong><span>{definitions.length}</span></header>
      {onCreateExample && <section className="workspace-model-example" aria-labelledby="workspace-model-example-heading">
        <h3 id="workspace-model-example-heading">Start with a complete model</h3>
        <p>Create a dimensioned assembly, publish it as a reusable definition, then export OpenUSD, mesh solids, STEP, or a complete CAD handoff package.</p>
        <button type="button" disabled={disabled} onClick={onCreateExample}>Create parametric workbench</button>
      </section>}
      {hierarchyItems.length > 0 && <section className="workspace-model-hierarchy" aria-labelledby="workspace-model-hierarchy-heading">
        <div className="workspace-model-catalog__heading">
          <h3 id="workspace-model-hierarchy-heading">3D hierarchy</h3>
          <small>Select stages, assets, assemblies, and parts</small>
        </div>
        <ul role="tree" aria-label="Editable model components">
          {hierarchyItems.map((item) => <li
            key={item.id}
            role="treeitem"
            aria-level={item.depth + 1}
            aria-selected={selectedComponentId === item.id}
          >
            <button
              type="button"
              className={item.typeId === "model-assembly" ? "is-assembly" : undefined}
              style={{ paddingInlineStart: `${12 + item.depth * 16}px` }}
              aria-label={item.label}
              disabled={!onSelectComponent}
              onClick={() => onSelectComponent?.(item.id)}
            >
              <strong>{item.label}</strong>
              <small>{item.typeId === "stage-3d"
                ? "Stage"
                : item.typeId === "model-assembly"
                  ? "Assembly"
                  : item.typeId === "cad-part"
                    ? "Editable CAD part"
                  : item.typeId === "spatial-primitive"
                    ? "Parametric part"
                    : "Asset"}</small>
            </button>
          </li>)}
        </ul>
      </section>}
      <section className="workspace-model-publish" aria-labelledby="workspace-model-publish-heading">
        <h3 id="workspace-model-publish-heading">Publish selected assembly</h3>
        {selectedAssembly ? <>
          <p>Capture <strong>{selectedAssembly.label}</strong> as a digest-pinned, immutable version.</p>
          <form onSubmit={publish} noValidate>
            <label>Model ID
              <input
                name="modelId"
                value={modelId}
                onChange={(event) => setModelId(event.target.value)}
                autoComplete="off"
                spellCheck={false}
                disabled={disabled}
              />
            </label>
            <label>Version
              <input
                name="version"
                value={version}
                onChange={(event) => setVersion(event.target.value)}
                autoComplete="off"
                spellCheck={false}
                disabled={disabled}
              />
            </label>
            <label>Display name
              <input
                name="displayName"
                value={displayName}
                onChange={(event) => setDisplayName(event.target.value)}
                autoComplete="off"
                disabled={disabled}
              />
            </label>
            {formError && <p className="workspace-models__error" role="alert">{formError}</p>}
            <button type="submit" disabled={disabled || !onPublish}>Publish immutable model</button>
          </form>
        </> : <p className="workspace-empty-copy">Select a model assembly in the 3D world to publish it.</p>}
      </section>

      <section className="workspace-model-catalog" aria-labelledby="workspace-model-catalog-heading">
        <div className="workspace-model-catalog__heading">
          <h3 id="workspace-model-catalog-heading">Published definitions</h3>
          <small>Editable instances, immutable source</small>
        </div>
        {actionError && <p className="workspace-models__error" role="alert">{actionError}</p>}
        {sortedDefinitions.length ? <ul>
          {sortedDefinitions.map((definition, index) => {
            const key = `${definition.modelId}@${definition.version}`;
            const confirming = pendingDeleteKey === key;
            const titleId = `workspace-model-delete-${index}`;
            const resolvedActions = exportActions.map((action, actionIndex) => {
              const available = action.isAvailable?.(definition) ?? true;
              const unavailableReason = typeof action.unavailableReason === "function"
                ? action.unavailableReason(definition)
                : action.unavailableReason;
              return {
                action,
                available,
                unavailableReason,
                descriptionId: `workspace-model-unavailable-${index}-${actionIndex}`,
              };
            });
            return <li key={key} className="workspace-model-card">
              <div className="workspace-model-card__summary">
                <strong>{definition.displayName}</strong>
                <code>{key}</code>
                <dl>
                  <div><dt>Nodes</dt><dd>{definition.nodes.length}</dd></div>
                  <div><dt>Source revision</dt><dd>{definition.sourceRevision}</dd></div>
                </dl>
                <span>Digest</span>
                <code className="workspace-model-card__digest" title={definition.digest}>{definition.digest}</code>
              </div>
              <div className="workspace-model-card__actions" aria-label={`${definition.displayName} actions`}>
                <button type="button" disabled={disabled || !onInstantiate} onClick={() => onInstantiate?.(definition)}>Add instance</button>
                {resolvedActions.map(({ action, available, unavailableReason, descriptionId }) => {
                  const exportKey = `${definition.modelId}@${definition.version}:${action.id}`;
                  const pending = pendingExportKey === exportKey;
                  return <button
                    key={action.id}
                    type="button"
                    disabled={disabled || Boolean(pendingExportKey) || !available}
                    title={!available ? unavailableReason : undefined}
                    aria-describedby={!available && unavailableReason ? descriptionId : undefined}
                    aria-busy={pending}
                    onClick={() => void runExport(action, definition)}
                  >{pending ? "Exporting…" : action.label}</button>;
                })}
                <button
                  type="button"
                  className="is-danger"
                  disabled={disabled || !onDelete}
                  aria-expanded={confirming}
                  onClick={() => setPendingDeleteKey(confirming ? undefined : key)}
                >Delete</button>
              </div>
              {resolvedActions.some(({ available, unavailableReason }) => !available && unavailableReason) && <ul className="workspace-model-unavailable" aria-label="Unavailable export explanations">
                {resolvedActions.flatMap(({ action, available, unavailableReason, descriptionId }) =>
                  !available && unavailableReason
                    ? [<li key={action.id} id={descriptionId}><strong>{action.label}:</strong> {unavailableReason}</li>]
                    : [])}
              </ul>}
              {confirming && <div
                className="workspace-model-delete"
                role="alertdialog"
                aria-labelledby={titleId}
                onKeyDown={(event) => {
                  if (event.key === "Escape") {
                    event.preventDefault();
                    setPendingDeleteKey(undefined);
                  }
                }}
              >
                <strong id={titleId}>Delete {key}?</strong>
                <p>Only the immutable definition is removed. Deletion is blocked while a live instance still references this digest.</p>
                <div>
                  <button ref={deleteCancelRef} type="button" onClick={() => setPendingDeleteKey(undefined)}>Cancel</button>
                  <button type="button" className="is-danger" onClick={() => {
                    const result = onDelete?.(definition);
                    if (result !== false) setPendingDeleteKey(undefined);
                  }}>Delete definition</button>
                </div>
              </div>}
            </li>;
          })}
        </ul> : <p className="workspace-empty-copy">No models published yet. Wrap 3D parts in an assembly, then publish a version here.</p>}
      </section>
    </aside>
  );
}
