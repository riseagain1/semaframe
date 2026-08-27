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
  /** Optional human-facing metadata. Known built-in export IDs receive sensible defaults. */
  group?: WorkspaceModelExportGroup;
  formatName?: string;
  purpose?: string;
  editability?: string;
  preparation?: string;
  /** Optional per-definition capability gate, for example a supported STEP subset. */
  isAvailable?: (definition: ModelDefinition) => boolean;
  unavailableReason?: string | ((definition: ModelDefinition) => string);
}>;

export type WorkspaceModelExportGroup = "scene" | "cad" | "mesh" | "other";

export type WorkspaceModelExportPresentation = Readonly<{
  group: WorkspaceModelExportGroup;
  groupLabel: string;
  groupDescription: string;
  formatName: string;
  purpose: string;
  editability: string;
  preparation: string;
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
  onOpenValidation?: () => void;
}>;

const EXPORT_GROUPS: Readonly<Record<WorkspaceModelExportGroup, Readonly<{
  label: string;
  description: string;
}>>> = Object.freeze({
  scene: {
    label: "Scene & simulation",
    description: "Preserve a structured scene for OpenUSD-aware tools and simulation pipelines.",
  },
  cad: {
    label: "CAD & manufacturing",
    description: "Continue exact mechanical work in CAD-compatible interchange formats.",
  },
  mesh: {
    label: "Mesh & visualization",
    description: "Create tessellated geometry for DCC, rendering, review, or prototyping.",
  },
  other: {
    label: "Other formats",
    description: "Additional export targets supplied by this runtime.",
  },
});

function inferredExportGroup(id: string): WorkspaceModelExportGroup {
  const normalized = id.toLowerCase();
  if (normalized.includes("usd")) return "scene";
  if (normalized.includes("step") || normalized.includes("cad")) return "cad";
  if (normalized.includes("obj") || normalized.includes("stl") || normalized.includes("mesh")) return "mesh";
  return "other";
}

/** Stable human explanation for built-in and extension-provided export actions. */
export function workspaceModelExportPresentation(
  action: WorkspaceModelExportAction,
): WorkspaceModelExportPresentation {
  const group = action.group ?? inferredExportGroup(action.id);
  const normalized = action.id.toLowerCase();
  const defaults = normalized.includes("cad-handoff")
    ? {
        formatName: "Verified CAD handoff",
        purpose: "Continue precision work in CAD with separate solids, provenance, and validation artifacts.",
        editability: "Best CAD continuation; the package keeps each supported solid separate.",
        preparation: "Thorough export with geometry evaluation and round-trip verification.",
      }
    : normalized.includes("step")
      ? {
          formatName: "STEP AP242",
          purpose: "Exchange supported mechanical solids with downstream CAD systems.",
          editability: "CAD solid interchange; source feature history may not transfer.",
          preparation: "Available only for the published STEP-compatible geometry subset.",
        }
      : normalized.includes("usd")
        ? {
            formatName: "OpenUSD scene",
            purpose: "Move structured scene data into OpenUSD-aware tools, simulation, or archival workflows.",
            editability: "Structured scene data remains inspectable; this is not a CAD feature tree.",
            preparation: "Deterministic scene export; no solid-mesh evaluation is required.",
          }
        : normalized.includes("stl")
          ? {
              formatName: "STL mesh",
              purpose: "Send tessellated geometry to slicers, mesh checks, or prototype workflows.",
              editability: "Mesh only; dimensions and parametric relationships are not retained.",
              preparation: "Evaluates supported solid geometry before creating the mesh.",
            }
          : normalized.includes("obj")
            ? {
                formatName: "OBJ mesh",
                purpose: "Use tessellated geometry in DCC, rendering, review, or visualization tools.",
                editability: "Mesh only; dimensions and parametric relationships are not retained.",
                preparation: "Evaluates supported solid geometry before creating the mesh.",
              }
            : {
                formatName: action.label,
                purpose: "Export this immutable model definition to an extension-provided target.",
                editability: "Editability depends on the receiving application and format.",
                preparation: "Preparation time depends on the export implementation.",
              };
  return {
    group,
    groupLabel: EXPORT_GROUPS[group].label,
    groupDescription: EXPORT_GROUPS[group].description,
    formatName: action.formatName ?? defaults.formatName,
    purpose: action.purpose ?? defaults.purpose,
    editability: action.editability ?? defaults.editability,
    preparation: action.preparation ?? defaults.preparation,
  };
}

type ResolvedExportAction = Readonly<{
  action: WorkspaceModelExportAction;
  presentation: WorkspaceModelExportPresentation;
  available: boolean;
  unavailableReason?: string;
  descriptionId: string;
}>;

type WorkspaceModelExportOutcome = Readonly<{
  key: string;
  kind: "success" | "error";
  message: string;
}>;

function resolveExportAction(
  action: WorkspaceModelExportAction,
  definition: ModelDefinition,
  descriptionId: string,
): ResolvedExportAction {
  try {
    const available = action.isAvailable?.(definition) ?? true;
    const unavailableReason = available
      ? undefined
      : typeof action.unavailableReason === "function"
        ? action.unavailableReason(definition)
        : action.unavailableReason;
    return {
      action,
      presentation: workspaceModelExportPresentation(action),
      available,
      unavailableReason: available ? undefined : unavailableReason ?? "This model is not compatible with this export format.",
      descriptionId,
    };
  } catch (error) {
    return {
      action,
      presentation: workspaceModelExportPresentation(action),
      available: false,
      unavailableReason: error instanceof Error
        ? `The compatibility check failed: ${error.message}`
        : "The compatibility check failed for this format.",
      descriptionId,
    };
  }
}

export type WorkspaceModelExportCenterProps = Readonly<{
  definition: ModelDefinition;
  definitionIndex: number;
  actions: readonly WorkspaceModelExportAction[];
  disabled?: boolean;
  pendingExportKey?: string;
  outcome?: WorkspaceModelExportOutcome;
  onExport: (action: WorkspaceModelExportAction, definition: ModelDefinition) => void | Promise<void>;
  onOpenValidation?: () => void;
}>;

/** Purpose-led export UI with compatibility preflight and honest indeterminate progress. */
export function WorkspaceModelExportCenter({
  definition,
  definitionIndex,
  actions,
  disabled = false,
  pendingExportKey,
  outcome,
  onExport,
  onOpenValidation,
}: WorkspaceModelExportCenterProps) {
  const resolvedActions = actions.map((action, actionIndex) => resolveExportAction(
    action,
    definition,
    `workspace-model-unavailable-${definitionIndex}-${actionIndex}`,
  ));
  const exportGroups = (["scene", "cad", "mesh", "other"] as const).flatMap((group) => {
    const groupActions = resolvedActions.filter((resolved) => resolved.presentation.group === group);
    return groupActions.length ? [{
      id: group,
      label: EXPORT_GROUPS[group].label,
      description: EXPORT_GROUPS[group].description,
      actions: groupActions,
    }] : [];
  });
  const readyCount = resolvedActions.filter(({ available }) => available).length;
  const blockedCount = resolvedActions.length - readyCount;

  return <section
    className="workspace-export-center"
    aria-labelledby={`workspace-export-center-${definitionIndex}`}
    aria-busy={Boolean(pendingExportKey) || undefined}
  >
    <div className="workspace-export-center__heading">
      <div>
        <h4 id={`workspace-export-center-${definitionIndex}`}>Export center</h4>
        <p>Choose by downstream use. A ready format is compatible with this published definition, not a production-safety certification.</p>
      </div>
      {resolvedActions.length > 0 && <span className={blockedCount > 0 ? "needs-attention" : "is-ready"}>
        {readyCount} ready{blockedCount > 0 ? ` · ${blockedCount} unavailable` : ""}
      </span>}
    </div>
    <div className="workspace-export-center__checks">
      <p>Run scene-wide Checks for spatial, physics, reality, and data issues before production use.</p>
      {onOpenValidation && <button type="button" disabled={disabled || Boolean(pendingExportKey)} onClick={onOpenValidation}>
        Review Checks
      </button>}
    </div>
    {exportGroups.length > 0 ? exportGroups.map((group) => <section
      key={group.id}
      className="workspace-export-group"
      aria-labelledby={`workspace-export-group-${definitionIndex}-${group.id}`}
    >
      <div className="workspace-export-group__heading">
        <h5 id={`workspace-export-group-${definitionIndex}-${group.id}`}>{group.label}</h5>
        <p>{group.description}</p>
      </div>
      <div className="workspace-export-formats">
        {group.actions.map(({ action, presentation, available, unavailableReason, descriptionId }) => {
          const exportKey = `${definition.modelId}@${definition.version}:${action.id}`;
          const pending = pendingExportKey === exportKey;
          const actionOutcome = outcome?.key === exportKey ? outcome : undefined;
          return <article key={action.id} className={`workspace-export-format${available ? " is-ready" : " is-unavailable"}`}>
            <div className="workspace-export-format__title">
              <strong>{presentation.formatName}</strong>
              <span>{available ? "Ready" : "Unavailable"}</span>
            </div>
            <p>{presentation.purpose}</p>
            <dl>
              <div><dt>Editability</dt><dd>{presentation.editability}</dd></div>
              <div><dt>Preparation</dt><dd>{presentation.preparation}</dd></div>
            </dl>
            {unavailableReason && <p id={descriptionId} className="workspace-export-format__reason">
              <strong>Why unavailable:</strong> {unavailableReason}
            </p>}
            <button
              type="button"
              disabled={disabled || Boolean(pendingExportKey) || !available}
              title={!available ? unavailableReason : undefined}
              aria-describedby={!available && unavailableReason ? descriptionId : undefined}
              aria-busy={pending}
              onClick={() => void onExport(action, definition)}
            >{pending ? "Exporting…" : action.label}</button>
            {actionOutcome && <p
              className={`workspace-export-format__outcome is-${actionOutcome.kind}`}
              role={actionOutcome.kind === "error" ? "alert" : "status"}
              aria-live={actionOutcome.kind === "error" ? "assertive" : "polite"}
            >{actionOutcome.message}</p>}
          </article>;
        })}
      </div>
    </section>) : <p className="workspace-empty-copy">No export formats are configured for this runtime.</p>}
  </section>;
}

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
  onOpenValidation,
}: WorkspaceModelLibraryProps) {
  const [modelId, setModelId] = useState(() => modelSlug(selectedAssembly?.label ?? "model"));
  const [version, setVersion] = useState("1.0.0");
  const [displayName, setDisplayName] = useState(selectedAssembly?.label ?? "Reusable model");
  const [formError, setFormError] = useState<string>();
  const [pendingDeleteKey, setPendingDeleteKey] = useState<string>();
  const [pendingExportKey, setPendingExportKey] = useState<string>();
  const [exportOutcome, setExportOutcome] = useState<WorkspaceModelExportOutcome>();
  const deleteCancelRef = useRef<HTMLButtonElement>(null);
  const pendingExportKeyRef = useRef<string | undefined>(undefined);

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
    // React state does not update until the current event flushes. Keep the
    // operation gate in a ref so two programmatic/same-frame activations cannot
    // start duplicate extension or synchronous OpenUSD exports.
    if (pendingExportKeyRef.current) return;
    pendingExportKeyRef.current = key;
    setPendingExportKey(key);
    setExportOutcome(undefined);
    try {
      const result = await action.onExport(definition);
      setExportOutcome(result === false
        ? { key, kind: "error", message: `${action.label} export did not complete. Review the app notification and Checks before trying again.` }
        : { key, kind: "success", message: `${action.label} export completed.` });
    } catch (error) {
      setExportOutcome({
        key,
        kind: "error",
        message: error instanceof Error ? error.message : "The export could not be completed.",
      });
    } finally {
      if (pendingExportKeyRef.current === key) pendingExportKeyRef.current = undefined;
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
        {sortedDefinitions.length ? <ul>
          {sortedDefinitions.map((definition, index) => {
            const key = `${definition.modelId}@${definition.version}`;
            const confirming = pendingDeleteKey === key;
            const titleId = `workspace-model-delete-${index}`;
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
                <button
                  type="button"
                  className="is-danger"
                  disabled={disabled || Boolean(pendingExportKey) || !onDelete}
                  aria-expanded={confirming}
                  onClick={() => setPendingDeleteKey(confirming ? undefined : key)}
                >Delete</button>
              </div>
              <WorkspaceModelExportCenter
                definition={definition}
                definitionIndex={index}
                actions={exportActions}
                disabled={disabled}
                pendingExportKey={pendingExportKey}
                outcome={exportOutcome}
                onExport={runExport}
                onOpenValidation={onOpenValidation}
              />
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
                  <button type="button" className="is-danger" disabled={Boolean(pendingExportKey)} onClick={() => {
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
