import { useEffect, useId, useRef, useState, type FormEvent, type ReactNode } from "react";
import {
  BUILTIN_PARAMETRIC_PRIMITIVE_DEFAULTS,
  DEFAULT_COMPONENT_VISUAL_EFFECTS,
} from "../../../workspace/components";
import { DEFAULT_ASSET_REGISTRY } from "../../../assets/AssetRegistry";
import type {
  ComponentResize,
  ComponentResizePolicy,
  ComponentVisualEffects,
  JSONObject,
  JSONValue,
  World3DPlacement,
} from "../../../workspace/components";
import type { ComponentActionRequest, WorkspaceRenderComponent } from "../../../workspace/renderer/contracts";
import type { RealityMeasurementEvent } from "../../../renderer/reality";
import { resolveVideoSource, type VideoSourceKind } from "./VideoPlayerView";
import { resolveWebPanelSource } from "./WebPanelView";
import { parseSpatialCollisionConfig } from "../../../workspace/spatial";
import {
  DEFAULT_SPATIAL_PHYSICS,
  parseSpatialPhysicsConfig,
  type PhysicsBodyReport,
} from "../../../workspace/physics";
import {
  deriveParametricBounds,
  parseParametricPrimitive,
  parseCadAssemblyMates,
  createCadWorkerKernel,
  type ParametricAxis,
  type ParametricPrimitive,
} from "../../../workspace/modeling";
import {
  CAD_PART_DEFINITION_FORMAT_VERSION,
  DEFAULT_CAD_SKETCH_PLANE,
  applyCadDocumentEdits,
  cadLengthExpression,
  cadPartDefinitionDigest,
  parseCadEvaluationEvidence,
  parseCadPartDefinition,
  type CadEvaluationEvidenceV1,
  type CadPartDefinitionV1,
} from "../../../workspace/modeling/cad";
import {
  REALITY_COORDINATE_SYSTEMS,
  parseRealityAssetCalibration,
  type RealityAssetCalibration,
  type RealityCoordinateSystem,
} from "../../../workspace/assets";

export type WorkspaceComponentUpdateRequest = Readonly<{
  componentId: string;
  label?: string;
  props: JSONObject;
}>;

export type WorkspaceCadPartEvaluator = (
  definition: CadPartDefinitionV1,
) => Promise<CadEvaluationEvidenceV1>;

export type WorkspaceComponentResizeRequest = Readonly<{
  componentId: string;
  resize: ComponentResize;
}>;

export type WorkspaceComponentVisualEffectsRequest = Readonly<{
  componentId: string;
  visualEffects: ComponentVisualEffects;
}>;

export type WorkspaceComponentTransformRequest = Readonly<{
  componentId: string;
  worldPlacement: World3DPlacement;
}>;

export type WorkspaceComponentHierarchyRequest = Readonly<{
  componentId: string;
  parentId?: string;
}>;

export type WorkspaceAssemblyOption = Readonly<{
  id: string;
  label: string;
}>;

export type WorkspaceComponentManifestUpgrade = Readonly<{
  fromVersion: string;
  toVersion: string;
}>;

export type WorkspaceInspectorMode = "basic" | "advanced";

export type WorkspaceInspectorSectionId =
  | "overview"
  | "manifest"
  | "size"
  | "transform"
  | "geometry"
  | "cad"
  | "cad-features"
  | "assembly"
  | "assembly-mates"
  | "reality"
  | "collision"
  | "collision-details"
  | "physics"
  | "physics-details"
  | "model"
  | "hierarchy"
  | "lifecycle"
  | "effects"
  | "source"
  | "actions"
  | "raw";

export type WorkspaceInspectorFocusRequest = Readonly<{
  sectionId: WorkspaceInspectorSectionId;
  /** Change this token to focus the same section again. */
  requestId?: string | number;
}>;

export type WorkspaceInspectorProps = Readonly<{
  component?: WorkspaceRenderComponent;
  onAction?: (request: ComponentActionRequest) => void;
  onUpdate?: (request: WorkspaceComponentUpdateRequest) => boolean | void;
  resizePolicy?: ComponentResizePolicy;
  onResize?: (request: WorkspaceComponentResizeRequest) => void;
  onVisualEffects?: (request: WorkspaceComponentVisualEffectsRequest) => void;
  manifestUpgrade?: WorkspaceComponentManifestUpgrade;
  onUpgradeManifest?: (componentId: string) => void;
  physicsReport?: PhysicsBodyReport;
  onCreateAssembly?: (componentId: string) => void;
  worldPlacement?: World3DPlacement;
  assemblyOptions?: readonly WorkspaceAssemblyOption[];
  realityProxyOptions?: readonly WorkspaceAssemblyOption[];
  realityMeasurement?: RealityMeasurementEvent;
  onStartRealityMeasurement?: (componentId: string) => boolean;
  onCancelRealityMeasurement?: () => void;
  onTransform?: (request: WorkspaceComponentTransformRequest) => void;
  onReparent?: (request: WorkspaceComponentHierarchyRequest) => boolean | void;
  onSelectComponent?: (componentId: string) => void;
  descendantCount?: number;
  onDeleteComponent?: (componentId: string) => boolean | void;
  /** Test/host seam; normal callers use the bounded CAD Worker. */
  evaluateCadPart?: WorkspaceCadPartEvaluator;
  /** UI-only preference. It is never serialized into a Workspace project. */
  defaultMode?: WorkspaceInspectorMode;
  /** Optional host seam for Validation/Checks deep links. */
  focusRequest?: WorkspaceInspectorFocusRequest;
}>;

const ADVANCED_INSPECTOR_SECTIONS: ReadonlySet<WorkspaceInspectorSectionId> = new Set([
  "manifest",
  "cad-features",
  "assembly-mates",
  "collision-details",
  "physics-details",
  "raw",
]);

function InspectorSectionAnchor({
  sectionId,
  children,
}: Readonly<{
  sectionId: WorkspaceInspectorSectionId;
  children: ReactNode;
}>) {
  return <div
    className="workspace-inspector__section-anchor"
    data-workspace-inspector-section={sectionId}
    tabIndex={-1}
  >{children}</div>;
}

export function WorkspaceInspector({
  component,
  onAction,
  onUpdate,
  resizePolicy,
  onResize,
  onVisualEffects,
  manifestUpgrade,
  onUpgradeManifest,
  physicsReport,
  onCreateAssembly,
  worldPlacement,
  assemblyOptions = [],
  realityProxyOptions = [],
  realityMeasurement,
  onStartRealityMeasurement,
  onCancelRealityMeasurement,
  onTransform,
  onReparent,
  onSelectComponent,
  descendantCount = 0,
  onDeleteComponent,
  evaluateCadPart,
  defaultMode = "basic",
  focusRequest,
}: WorkspaceInspectorProps) {
  const inspectorRef = useRef<HTMLElement>(null);
  const [inspectorMode, setInspectorMode] = useState<WorkspaceInspectorMode>(defaultMode);
  const componentId = component?.id;
  const focusSectionId = focusRequest?.sectionId;
  const focusRequestId = focusRequest?.requestId;

  useEffect(() => {
    if (focusSectionId && ADVANCED_INSPECTOR_SECTIONS.has(focusSectionId)) {
      setInspectorMode("advanced");
    }
  }, [focusRequestId, focusSectionId]);

  useEffect(() => {
    if (!componentId || !focusSectionId) return;
    const frame = requestAnimationFrame(() => {
      const target = inspectorRef.current?.querySelector<HTMLElement>(
        `[data-workspace-inspector-section="${focusSectionId}"]`,
      );
      target?.scrollIntoView?.({ block: "nearest" });
      target?.focus({ preventScroll: true });
    });
    return () => cancelAnimationFrame(frame);
  }, [componentId, focusRequestId, focusSectionId, inspectorMode]);

  if (!component) {
    return (
      <aside ref={inspectorRef} className="workspace-side-panel workspace-inspector" aria-label="Inspector">
        <header><span>Inspector</span></header>
        <p className="workspace-empty-copy">Select a component to inspect it.</p>
      </aside>
    );
  }
  const timerActions = component.type.typeId === "timer"
    ? ["start", "pause", "resume", "reset"]
    : [];
  return (
    <aside ref={inspectorRef} className="workspace-side-panel workspace-inspector" aria-label={`Inspector for ${component.label}`}>
      <header>
        <span>Inspector</span>
        <strong>{component.label}</strong>
      </header>
      <div className="workspace-inspector__mode" role="group" aria-label="Inspector detail level">
        <button
          type="button"
          aria-pressed={inspectorMode === "basic"}
          onClick={() => setInspectorMode("basic")}
        >Basic</button>
        <button
          type="button"
          aria-pressed={inspectorMode === "advanced"}
          onClick={() => setInspectorMode("advanced")}
        >Advanced</button>
      </div>
      <dl
        className="workspace-inspector__overview"
        data-workspace-inspector-section="overview"
        tabIndex={-1}
      >
        <div><dt>Type</dt><dd>{component.type.typeId}</dd></div>
        <div><dt>Placement</dt><dd>{component.placement.space}</dd></div>
        <div><dt>Version</dt><dd>{component.type.version}</dd></div>
        <div><dt>Visibility</dt><dd>{component.visibility}</dd></div>
        {inspectorMode === "advanced" && <div><dt>Manifest digest</dt><dd>{component.type.digest}</dd></div>}
      </dl>
      {inspectorMode === "advanced" && manifestUpgrade && (
        <InspectorSectionAnchor sectionId="manifest"><section className="workspace-inspector__upgrade" aria-label="Component interaction upgrade">
          <h3>Interaction upgrade available</h3>
          <p>
            This component is pinned to {manifestUpgrade.fromVersion}. Upgrade explicitly to
            {" "}{manifestUpgrade.toVersion} to use the current actions and events.
          </p>
          <button
            type="button"
            disabled={!onUpgradeManifest || component.locks.props || component.locks.actions}
            onClick={() => onUpgradeManifest?.(component.id)}
          >
            Upgrade component interactions
          </button>
          {(component.locks.props || component.locks.actions) && (
            <p className="workspace-inspector__hint">Unlock properties and actions before upgrading.</p>
          )}
        </section></InspectorSectionAnchor>
      )}
      {resizePolicy && resizePolicy.kind !== "none" && (
        <InspectorSectionAnchor sectionId="size"><ResizeInspectorEditor component={component} policy={resizePolicy} onResize={onResize} /></InspectorSectionAnchor>
      )}
      {component.placement.space === "world3d" && component.type.typeId !== "stage-3d" && (
        <InspectorSectionAnchor sectionId="transform"><WorldTransformInspectorEditor
          component={component}
          worldPlacement={worldPlacement ?? component.placement}
          onTransform={onTransform}
        /></InspectorSectionAnchor>
      )}
      {component.type.typeId === "spatial-primitive" && (
        <InspectorSectionAnchor sectionId="geometry"><ParametricPrimitiveInspectorEditor component={component} onUpdate={onUpdate} /></InspectorSectionAnchor>
      )}
      {component.type.typeId === "cad-part" && (
        <InspectorSectionAnchor sectionId="cad"><CadPartInspectorEditor
          component={component}
          onUpdate={onUpdate}
          evaluateCadPart={evaluateCadPart}
          advanced={inspectorMode === "advanced"}
        /></InspectorSectionAnchor>
      )}
      {component.type.typeId === "model-assembly" && (
        <InspectorSectionAnchor sectionId="assembly"><ModelAssemblyInspectorEditor component={component} onUpdate={onUpdate} advanced={inspectorMode === "advanced"} /></InspectorSectionAnchor>
      )}
      {component.type.typeId === "gaussian-splat" && (
        <InspectorSectionAnchor sectionId="reality"><RealitySplatInspectorEditor
          component={component}
          proxyOptions={realityProxyOptions}
          measurement={realityMeasurement}
          onStartMeasurement={onStartRealityMeasurement}
          onCancelMeasurement={onCancelRealityMeasurement}
          onUpdate={onUpdate}
          advanced={inspectorMode === "advanced"}
        /></InspectorSectionAnchor>
      )}
      {(component.type.typeId === "spatial-entity"
        || component.type.typeId === "spatial-primitive"
        || component.type.typeId === "cad-part")
        && Boolean(component.props.collision) && (
        <InspectorSectionAnchor sectionId="collision"><CollisionInspectorEditor component={component} onUpdate={onUpdate} advanced={inspectorMode === "advanced"} /></InspectorSectionAnchor>
      )}
      {(component.type.typeId === "spatial-entity"
        || component.type.typeId === "spatial-primitive"
        || component.type.typeId === "cad-part")
        && Boolean(component.props.physics) && (
        <InspectorSectionAnchor sectionId="physics"><PhysicsInspectorEditor component={component} onUpdate={onUpdate} report={physicsReport} advanced={inspectorMode === "advanced"} /></InspectorSectionAnchor>
      )}
      {(component.type.typeId === "spatial-primitive"
        || component.type.typeId === "spatial-entity"
        || component.type.typeId === "cad-part") && (
        <InspectorSectionAnchor sectionId="model"><section className="workspace-inspector__model-actions" aria-label="Model assembly actions">
          <h3>Model</h3>
          <p className="workspace-inspector__hint">
            Wrap this object in a transform-only assembly without changing its world position.
          </p>
          <button
            type="button"
            disabled={!onCreateAssembly || component.locks.placement}
            onClick={() => onCreateAssembly?.(component.id)}
          >
            Create model assembly
          </button>
        </section></InspectorSectionAnchor>
      )}
      {component.placement.space === "world3d" && component.type.typeId !== "stage-3d" && (
        <InspectorSectionAnchor sectionId="hierarchy"><ComponentHierarchyInspectorEditor
          component={component}
          assemblyOptions={assemblyOptions}
          onReparent={onReparent}
          onSelectComponent={onSelectComponent}
        /></InspectorSectionAnchor>
      )}
      {(component.type.typeId === "spatial-primitive"
        || component.type.typeId === "spatial-entity"
        || component.type.typeId === "cad-part"
        || component.type.typeId === "model-assembly"
        || component.type.typeId === "gaussian-splat") && (
        <InspectorSectionAnchor sectionId="lifecycle"><ComponentLifecycleEditor
          component={component}
          descendantCount={descendantCount}
          onDelete={onDeleteComponent}
        /></InspectorSectionAnchor>
      )}
      <InspectorSectionAnchor sectionId="effects"><VisualEffectsInspectorEditor component={component} onApply={onVisualEffects} /></InspectorSectionAnchor>
      {component.type.typeId === "video-player" && (
        <InspectorSectionAnchor sectionId="source"><VideoPlayerInspectorEditor component={component} onUpdate={onUpdate} /></InspectorSectionAnchor>
      )}
      {component.type.typeId === "web-panel" && (
        <InspectorSectionAnchor sectionId="source"><WebPanelInspectorEditor component={component} onUpdate={onUpdate} /></InspectorSectionAnchor>
      )}
      {timerActions.length > 0 && (
        <InspectorSectionAnchor sectionId="actions"><section>
          <h3>Actions</h3>
          <div className="workspace-inspector__actions">
            {timerActions.map((action) => (
              <button
                key={action}
                type="button"
                disabled={component.locks.actions}
                onClick={() => onAction?.({ componentId: component.id, action })}
              >
                {action}
              </button>
            ))}
          </div>
        </section></InspectorSectionAnchor>
      )}
      {inspectorMode === "advanced" && <InspectorSectionAnchor sectionId="raw"><div className="workspace-inspector__raw">
        <details>
          <summary>Raw properties</summary>
          <pre>{JSON.stringify(component.props, null, 2)}</pre>
        </details>
        <details>
          <summary>Raw durable state</summary>
          <pre>{JSON.stringify(component.durableState, null, 2)}</pre>
        </details>
      </div></InspectorSectionAnchor>}
    </aside>
  );
}

const RADIANS_TO_DEGREES = 180 / Math.PI;
const DEGREES_TO_RADIANS = Math.PI / 180;

function editableNumber(value: number): string {
  return Number(value.toFixed(6)).toString();
}

function WorldTransformInspectorEditor({
  component,
  worldPlacement,
  onTransform,
}: Readonly<{
  component: WorkspaceRenderComponent;
  worldPlacement: World3DPlacement;
  onTransform?: (request: WorkspaceComponentTransformRequest) => void;
}>) {
  const formId = useId();
  const signature = JSON.stringify(worldPlacement);
  const [position, setPosition] = useState(() => [
    editableNumber(worldPlacement.position.x),
    editableNumber(worldPlacement.position.y),
    editableNumber(worldPlacement.position.z),
  ]);
  const [rotationDeg, setRotationDeg] = useState(() => [
    editableNumber(worldPlacement.rotation.x * RADIANS_TO_DEGREES),
    editableNumber(worldPlacement.rotation.y * RADIANS_TO_DEGREES),
    editableNumber(worldPlacement.rotation.z * RADIANS_TO_DEGREES),
  ]);
  const [error, setError] = useState<string>();

  useEffect(() => {
    setPosition([
      editableNumber(worldPlacement.position.x),
      editableNumber(worldPlacement.position.y),
      editableNumber(worldPlacement.position.z),
    ]);
    setRotationDeg([
      editableNumber(worldPlacement.rotation.x * RADIANS_TO_DEGREES),
      editableNumber(worldPlacement.rotation.y * RADIANS_TO_DEGREES),
      editableNumber(worldPlacement.rotation.z * RADIANS_TO_DEGREES),
    ]);
    setError(undefined);
  }, [component.id, signature]);

  const locked = component.locks.placement || !onTransform;
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const parsedPosition = position.map(Number);
    const parsedRotation = rotationDeg.map(Number);
    if ([...parsedPosition, ...parsedRotation].some((value) => !Number.isFinite(value))) {
      setError("Position and rotation must contain finite numbers.");
      return;
    }
    setError(undefined);
    onTransform?.({
      componentId: component.id,
      worldPlacement: {
        space: "world3d",
        position: { x: parsedPosition[0]!, y: parsedPosition[1]!, z: parsedPosition[2]! },
        rotation: {
          x: parsedRotation[0]! * DEGREES_TO_RADIANS,
          y: parsedRotation[1]! * DEGREES_TO_RADIANS,
          z: parsedRotation[2]! * DEGREES_TO_RADIANS,
        },
        scale: structuredClone(worldPlacement.scale),
      },
    });
  };

  return <section className="workspace-inspector__modeling workspace-inspector__transform" aria-labelledby={`${formId}-heading`}>
    <h3 id={`${formId}-heading`}>World transform</h3>
    <p className="workspace-inspector__hint">Exact world-space coordinates. Rotation is shown in degrees; hierarchy changes preserve this pose.</p>
    <form onSubmit={submit} noValidate>
      <fieldset>
        <legend>Position (m)</legend>
        {(["X", "Y", "Z"] as const).map((axis, index) => <label key={axis} htmlFor={`${formId}-position-${axis.toLowerCase()}`}>
          <span>{axis}</span>
          <input
            id={`${formId}-position-${axis.toLowerCase()}`}
            aria-label={`World position ${axis} (m)`}
            type="number"
            inputMode="decimal"
            step="0.001"
            value={position[index]}
            disabled={locked}
            onChange={(event) => setPosition((current) => current.map((value, item) => item === index ? event.target.value : value))}
          />
        </label>)}
      </fieldset>
      <fieldset>
        <legend>Rotation (deg)</legend>
        {(["X", "Y", "Z"] as const).map((axis, index) => <label key={axis} htmlFor={`${formId}-rotation-${axis.toLowerCase()}`}>
          <span>{axis}</span>
          <input
            id={`${formId}-rotation-${axis.toLowerCase()}`}
            aria-label={`World rotation ${axis} (deg)`}
            type="number"
            inputMode="decimal"
            step="0.1"
            value={rotationDeg[index]}
            disabled={locked}
            onChange={(event) => setRotationDeg((current) => current.map((value, item) => item === index ? event.target.value : value))}
          />
        </label>)}
      </fieldset>
      {error && <p className="workspace-inspector__error" role="alert">{error}</p>}
      <button type="submit" disabled={locked}>Apply world transform</button>
    </form>
    {component.locks.placement && <p className="workspace-inspector__hint">Placement is locked for this component.</p>}
  </section>;
}

function ComponentHierarchyInspectorEditor({
  component,
  assemblyOptions,
  onReparent,
  onSelectComponent,
}: Readonly<{
  component: WorkspaceRenderComponent;
  assemblyOptions: readonly WorkspaceAssemblyOption[];
  onReparent?: (request: WorkspaceComponentHierarchyRequest) => boolean | void;
  onSelectComponent?: (componentId: string) => void;
}>) {
  const formId = useId();
  const [parentId, setParentId] = useState(component.parentId ?? "");
  const currentParent = assemblyOptions.find((option) => option.id === component.parentId);
  useEffect(() => setParentId(component.parentId ?? ""), [component.id, component.parentId]);
  const locked = component.locks.placement || !onReparent;
  const apply = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if ((component.parentId ?? "") === parentId) return;
    onReparent?.({ componentId: component.id, ...(parentId ? { parentId } : {}) });
  };
  return <section className="workspace-inspector__modeling workspace-inspector__hierarchy" aria-labelledby={`${formId}-heading`}>
    <h3 id={`${formId}-heading`}>Assembly hierarchy</h3>
    <p className="workspace-inspector__hint">Attach to an assembly or detach to the world root without moving this component.</p>
    <form onSubmit={apply}>
      <label htmlFor={`${formId}-parent`}><span>Parent</span>
        <select id={`${formId}-parent`} value={parentId} disabled={locked} onChange={(event) => setParentId(event.target.value)}>
          <option value="">World root (detached)</option>
          {assemblyOptions.map((option) => <option key={option.id} value={option.id}>{option.label}</option>)}
        </select>
      </label>
      <button type="submit" disabled={locked || (component.parentId ?? "") === parentId}>Apply parent · preserve world</button>
    </form>
    {component.parentId && <button
      type="button"
      className="workspace-inspector__secondary-action"
      disabled={!onSelectComponent}
      onClick={() => onSelectComponent?.(component.parentId!)}
    >Select parent assembly{currentParent ? ` · ${currentParent.label}` : ""}</button>}
  </section>;
}

function ComponentLifecycleEditor({
  component,
  descendantCount,
  onDelete,
}: Readonly<{
  component: WorkspaceRenderComponent;
  descendantCount: number;
  onDelete?: (componentId: string) => boolean | void;
}>) {
  const [confirming, setConfirming] = useState(false);
  const cancelRef = useRef<HTMLButtonElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const modelRef = recordValue(component.props.modelRef);
  useEffect(() => {
    if (!confirming) return;
    const frame = requestAnimationFrame(() => cancelRef.current?.focus());
    return () => cancelAnimationFrame(frame);
  }, [confirming]);
  const close = () => {
    setConfirming(false);
    requestAnimationFrame(() => triggerRef.current?.focus());
  };
  const label = modelRef ? "Delete model instance" : "Delete component";
  return <section className="workspace-inspector__modeling workspace-inspector__lifecycle" aria-label="Component lifecycle">
    <h3>Remove</h3>
    <p className="workspace-inspector__hint">
      {descendantCount > 0
        ? `This removes ${component.label} and ${descendantCount} descendant${descendantCount === 1 ? "" : "s"}.`
        : `This removes ${component.label} from the workspace.`}
      {modelRef ? " Removing an instance also releases its published definition reference." : ""}
    </p>
    <button
      ref={triggerRef}
      type="button"
      className="is-danger"
      disabled={component.locks.deletion || !onDelete}
      aria-expanded={confirming}
      onClick={() => setConfirming((value) => !value)}
    >{label}…</button>
    {confirming && <div
      className="workspace-model-delete"
      role="alertdialog"
      aria-label={`Confirm ${label.toLowerCase()}`}
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          event.preventDefault();
          close();
        }
      }}
    >
      <strong>{label}?</strong>
      <p>
        {descendantCount > 0
          ? `This will also remove ${descendantCount} descendant${descendantCount === 1 ? "" : "s"} and their bindings. `
          : "Bindings to this component are removed with it. "}
        This cannot be undone from the Models panel.
      </p>
      <div>
        <button ref={cancelRef} type="button" onClick={close}>Cancel</button>
        <button type="button" className="is-danger" onClick={() => {
          const result = onDelete?.(component.id);
          if (result !== false) close();
        }}>Confirm delete</button>
      </div>
    </div>}
  </section>;
}

type PrimitiveKind = ParametricPrimitive["kind"];

type PrimitiveEditorFields = Readonly<{
  first: string;
  second: string;
  third: string;
  axis: ParametricAxis;
}>;

function safePrimitive(value: unknown): ParametricPrimitive {
  try {
    return parseParametricPrimitive(value);
  } catch {
    return structuredClone(BUILTIN_PARAMETRIC_PRIMITIVE_DEFAULTS.box);
  }
}

function fieldsForPrimitive(primitive: ParametricPrimitive): PrimitiveEditorFields {
  switch (primitive.kind) {
    case "box": return {
      first: String(primitive.sizeM.x), second: String(primitive.sizeM.y), third: String(primitive.sizeM.z), axis: "y",
    };
    case "sphere": return { first: String(primitive.radiusM), second: "", third: "", axis: "y" };
    case "cylinder":
    case "cone": return {
      first: String(primitive.radiusM), second: String(primitive.heightM), third: "", axis: primitive.axis,
    };
    case "capsule": return {
      first: String(primitive.radiusM), second: String(primitive.cylinderHeightM), third: "", axis: primitive.axis,
    };
    case "plane": return {
      first: String(primitive.sizeM.x), second: String(primitive.sizeM.y), third: "", axis: primitive.normalAxis,
    };
  }
}

function primitiveFromFields(kind: PrimitiveKind, fields: PrimitiveEditorFields): ParametricPrimitive {
  const first = Number(fields.first);
  const second = Number(fields.second);
  const third = Number(fields.third);
  switch (kind) {
    case "box": return parseParametricPrimitive({ kind, sizeM: { x: first, y: second, z: third } });
    case "sphere": return parseParametricPrimitive({ kind, radiusM: first });
    case "cylinder": return parseParametricPrimitive({ kind, radiusM: first, heightM: second, axis: fields.axis });
    case "cone": return parseParametricPrimitive({ kind, radiusM: first, heightM: second, axis: fields.axis });
    case "capsule": return parseParametricPrimitive({ kind, radiusM: first, cylinderHeightM: second, axis: fields.axis });
    case "plane": return parseParametricPrimitive({ kind, sizeM: { x: first, y: second }, normalAxis: fields.axis });
  }
}

function primitiveDimensionLabels(kind: PrimitiveKind): readonly string[] {
  switch (kind) {
    case "box": return ["Width X (m)", "Height Y (m)", "Depth Z (m)"];
    case "sphere": return ["Radius (m)"];
    case "cylinder":
    case "cone": return ["Radius (m)", "Height (m)"];
    case "capsule": return ["Radius (m)", "Cylinder length (m)"];
    case "plane": return ["Size U (m)", "Size V (m)"];
  }
}

function ParametricPrimitiveInspectorEditor({
  component,
  onUpdate,
}: Readonly<{
  component: WorkspaceRenderComponent;
  onUpdate?: (request: WorkspaceComponentUpdateRequest) => boolean | void;
}>) {
  const formId = useId();
  const primitive = safePrimitive(component.props.geometry);
  const material = recordValue(component.props.material) ?? {};
  const signature = JSON.stringify({ primitive, material });
  const [kind, setKind] = useState<PrimitiveKind>(primitive.kind);
  const [fields, setFields] = useState<PrimitiveEditorFields>(fieldsForPrimitive(primitive));
  const [baseColor, setBaseColor] = useState(stringValue(material.baseColor) || "#68D5FF");
  const [metallic, setMetallic] = useState(String(finiteNumber(material.metallic) ?? 0));
  const [roughness, setRoughness] = useState(String(finiteNumber(material.roughness) ?? 0.55));
  const [opacity, setOpacity] = useState(String(finiteNumber(material.opacity) ?? 1));
  const [emissiveColor, setEmissiveColor] = useState(stringValue(material.emissiveColor) || "#000000");
  const [emissiveIntensity, setEmissiveIntensity] = useState(String(finiteNumber(material.emissiveIntensity) ?? 0));
  const [error, setError] = useState<string>();
  useEffect(() => {
    setKind(primitive.kind);
    setFields(fieldsForPrimitive(primitive));
    setBaseColor(stringValue(material.baseColor) || "#68D5FF");
    setMetallic(String(finiteNumber(material.metallic) ?? 0));
    setRoughness(String(finiteNumber(material.roughness) ?? 0.55));
    setOpacity(String(finiteNumber(material.opacity) ?? 1));
    setEmissiveColor(stringValue(material.emissiveColor) || "#000000");
    setEmissiveIntensity(String(finiteNumber(material.emissiveIntensity) ?? 0));
    setError(undefined);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [component.id, signature]);
  const locked = component.locks.props || !onUpdate;
  const labels = primitiveDimensionLabels(kind);
  const values = [fields.first, fields.second, fields.third];
  const setDimension = (index: number, value: string) => {
    setFields((current) => ({
      ...current,
      ...(index === 0 ? { first: value } : index === 1 ? { second: value } : { third: value }),
    }));
    setError(undefined);
  };
  const changeKind = (next: PrimitiveKind) => {
    const nextPrimitive = BUILTIN_PARAMETRIC_PRIMITIVE_DEFAULTS[next];
    setKind(next);
    setFields(fieldsForPrimitive(nextPrimitive));
    setError(undefined);
  };
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    let nextGeometry: ParametricPrimitive;
    try {
      nextGeometry = primitiveFromFields(kind, fields);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Geometry dimensions are invalid.");
      return;
    }
    const nextMetallic = Number(metallic);
    const nextRoughness = Number(roughness);
    const nextOpacity = Number(opacity);
    const nextEmissiveIntensity = Number(emissiveIntensity);
    if (!inRange(nextMetallic, 0, 1) || !inRange(nextRoughness, 0, 1)
      || !inRange(nextOpacity, 0, 1) || !inRange(nextEmissiveIntensity, 0, 8)) {
      setError("Metallic, roughness, and opacity must be 0–1; emission must be 0–8.");
      return;
    }
    setError(undefined);
    onUpdate?.({
      componentId: component.id,
      props: {
        geometry: structuredClone(nextGeometry) as unknown as JSONObject,
        material: {
          baseColor: baseColor.toUpperCase(),
          metallic: nextMetallic,
          roughness: nextRoughness,
          opacity: nextOpacity,
          emissiveColor: emissiveColor.toUpperCase(),
          emissiveIntensity: nextEmissiveIntensity,
        },
      },
    });
  };
  return <section className="workspace-inspector__modeling" aria-labelledby={`${formId}-heading`}>
    <h3 id={`${formId}-heading`}>Parametric geometry</h3>
    <p className="workspace-inspector__hint">Canonical dimensions in metres drive rendering, bounds, collision, SSG, and export.</p>
    <form onSubmit={submit} noValidate>
      <label htmlFor={`${formId}-kind`}><span>Primitive</span><select id={`${formId}-kind`} value={kind} disabled={locked} onChange={(event) => changeKind(event.target.value as PrimitiveKind)}>{Object.keys(BUILTIN_PARAMETRIC_PRIMITIVE_DEFAULTS).map((value) => <option key={value} value={value}>{value[0]?.toUpperCase()}{value.slice(1)}</option>)}</select></label>
      <fieldset><legend>Exact dimensions</legend>{labels.map((label, index) => <label key={label} htmlFor={`${formId}-dimension-${index}`}><span>{label}</span><input id={`${formId}-dimension-${index}`} aria-label={label} type="number" inputMode="decimal" min="0.000001" max="1000" step="0.001" value={values[index]} disabled={locked} onChange={(event) => setDimension(index, event.target.value)} /></label>)}</fieldset>
      {kind !== "box" && kind !== "sphere" && <label htmlFor={`${formId}-axis`}><span>{kind === "plane" ? "Normal axis" : "Length axis"}</span><select id={`${formId}-axis`} value={fields.axis} disabled={locked} onChange={(event) => setFields((current) => ({ ...current, axis: event.target.value as ParametricAxis }))}><option value="x">X</option><option value="y">Y</option><option value="z">Z</option></select></label>}
      {kind === "capsule" && <p className="workspace-inspector__hint">Total length is cylinder length plus two radii.</p>}
      <fieldset><legend>PBR material</legend>
        <label htmlFor={`${formId}-base-color`}><span>Base color</span><input id={`${formId}-base-color`} aria-label="Base color" type="color" value={baseColor} disabled={locked} onChange={(event) => setBaseColor(event.target.value)} /></label>
        <label htmlFor={`${formId}-metallic`}><span>Metallic</span><input id={`${formId}-metallic`} aria-label="Metallic" type="number" min="0" max="1" step="0.05" value={metallic} disabled={locked} onChange={(event) => setMetallic(event.target.value)} /></label>
        <label htmlFor={`${formId}-roughness`}><span>Roughness</span><input id={`${formId}-roughness`} aria-label="Roughness" type="number" min="0" max="1" step="0.05" value={roughness} disabled={locked} onChange={(event) => setRoughness(event.target.value)} /></label>
        <label htmlFor={`${formId}-material-opacity`}><span>Opacity</span><input id={`${formId}-material-opacity`} aria-label="Material opacity" type="number" min="0" max="1" step="0.05" value={opacity} disabled={locked} onChange={(event) => setOpacity(event.target.value)} /></label>
        <label htmlFor={`${formId}-emissive-color`}><span>Emission color</span><input id={`${formId}-emissive-color`} aria-label="Material emission color" type="color" value={emissiveColor} disabled={locked} onChange={(event) => setEmissiveColor(event.target.value)} /></label>
        <label htmlFor={`${formId}-emissive-intensity`}><span>Emission</span><input id={`${formId}-emissive-intensity`} aria-label="Material emission" type="number" min="0" max="8" step="0.1" value={emissiveIntensity} disabled={locked} onChange={(event) => setEmissiveIntensity(event.target.value)} /></label>
      </fieldset>
      {error && <p className="workspace-inspector__error" role="alert">{error}</p>}
      <button type="submit" disabled={locked}>Apply geometry and material</button>
    </form>
  </section>;
}

function cadParameterLength(
  definition: CadPartDefinitionV1,
  parameterId: string,
  fallback: number,
): number {
  const parameter = definition.parameters.find((candidate) => candidate.id === parameterId);
  return parameter?.expression.kind === "constant"
    && parameter.expression.dimension === "length"
    && Number.isFinite(parameter.expression.value)
    ? parameter.expression.value
    : fallback;
}

function editableCadLengthParameter(
  definition: CadPartDefinitionV1,
  parameterId: string,
) {
  const parameter = definition.parameters.find((candidate) => candidate.id === parameterId);
  return parameter?.dimension === "length"
    && parameter.expression.kind === "constant"
    && parameter.expression.dimension === "length"
    ? parameter
    : undefined;
}

/**
 * A fully constrained, editable starter part for the human CAD surface. The
 * dimensions remain named parameters, while an optional through-hole remains
 * a distinct feature in history instead of being baked into a mesh.
 */
export function createRectangularCadPlateDefinition(input: Readonly<{
  partId: string;
  displayName: string;
  widthM: number;
  depthM: number;
  thicknessM: number;
  holeDiameterM?: number;
}>): CadPartDefinitionV1 {
  const { widthM, depthM, thicknessM } = input;
  const holeDiameterM = input.holeDiameterM ?? 0;
  if (![widthM, depthM, thicknessM, holeDiameterM].every(Number.isFinite)
    || widthM < 1e-6 || widthM > 1_000
    || depthM < 1e-6 || depthM > 1_000
    || thicknessM < 1e-6 || thicknessM > 1_000
    || holeDiameterM < 0 || holeDiameterM >= Math.min(widthM, depthM)) {
    throw new Error("Plate dimensions must be 0.000001–1000 m, and the optional hole must be smaller than both planar dimensions.");
  }
  const halfWidth = widthM / 2;
  const halfDepth = depthM / 2;
  const parameterRef = (parameterId: string) => ({
    kind: "parameter" as const,
    parameterId,
  });
  const history: CadPartDefinitionV1["history"][number][] = [{
    id: "base_sketch",
    name: "Base sketch",
    kind: "sketch",
    sketch: {
      plane: DEFAULT_CAD_SKETCH_PLANE,
      entities: [
        { id: "bottom", kind: "line", start: { x: -halfWidth, y: -halfDepth }, end: { x: halfWidth, y: -halfDepth } },
        { id: "right", kind: "line", start: { x: halfWidth, y: -halfDepth }, end: { x: halfWidth, y: halfDepth } },
        { id: "top", kind: "line", start: { x: halfWidth, y: halfDepth }, end: { x: -halfWidth, y: halfDepth } },
        { id: "left", kind: "line", start: { x: -halfWidth, y: halfDepth }, end: { x: -halfWidth, y: -halfDepth } },
      ],
      loops: [{ id: "outer", entityIds: ["bottom", "right", "top", "left"], role: "outer" }],
      constraints: [
        { id: "anchor", kind: "fixed", point: { entityId: "bottom", point: "start" }, position: { x: -halfWidth, y: -halfDepth } },
        { id: "join_br", kind: "coincident", first: { entityId: "bottom", point: "end" }, second: { entityId: "right", point: "start" } },
        { id: "join_rt", kind: "coincident", first: { entityId: "right", point: "end" }, second: { entityId: "top", point: "start" } },
        { id: "join_tl", kind: "coincident", first: { entityId: "top", point: "end" }, second: { entityId: "left", point: "start" } },
        { id: "join_lb", kind: "coincident", first: { entityId: "left", point: "end" }, second: { entityId: "bottom", point: "start" } },
        { id: "bottom_horizontal", kind: "horizontal", entityId: "bottom" },
        { id: "top_horizontal", kind: "horizontal", entityId: "top" },
        { id: "right_vertical", kind: "vertical", entityId: "right" },
        { id: "left_vertical", kind: "vertical", entityId: "left" },
        { id: "plate_width", kind: "length", entityId: "bottom", value: parameterRef("width") },
        { id: "plate_depth", kind: "length", entityId: "right", value: parameterRef("depth") },
      ],
    },
  }, {
    id: "base_extrude",
    name: "Base extrude",
    kind: "extrude",
    profile: { sketchFeatureId: "base_sketch", loopIds: ["outer"] },
    distance: parameterRef("thickness"),
    operation: "new",
    resultBodyId: "body",
  }];
  if (holeDiameterM > 0) {
    history.push({
      id: "center_hole",
      name: "Center through-hole",
      kind: "hole",
      targetBodyId: "body",
      resultBodyId: "body",
      centerM: { x: 0, y: 0, z: 0 },
      axis: { x: 0, y: 0, z: 1 },
      diameter: parameterRef("hole_diameter"),
      throughAll: true,
    });
  }
  return parseCadPartDefinition({
    formatVersion: CAD_PART_DEFINITION_FORMAT_VERSION,
    partId: input.partId,
    displayName: input.displayName,
    units: "metre",
    parameters: [
      { id: "width", name: "Width", dimension: "length", expression: cadLengthExpression(widthM) },
      { id: "depth", name: "Depth", dimension: "length", expression: cadLengthExpression(depthM) },
      { id: "thickness", name: "Thickness", dimension: "length", expression: cadLengthExpression(thicknessM) },
      ...(holeDiameterM > 0 ? [{
        id: "hole_diameter",
        name: "Hole diameter",
        dimension: "length" as const,
        expression: cadLengthExpression(holeDiameterM),
      }] : []),
    ],
    history,
    activeBodyIds: ["body"],
  });
}

function isRectangularCadPlateDefinition(
  definition: CadPartDefinitionV1,
  evidence: CadEvaluationEvidenceV1 | undefined,
): boolean {
  if (definition.history.length === 0 && definition.parameters.length === 0) return true;
  try {
    const existingHole = definition.history.find((feature) => feature.kind === "hole");
    const reconstructed = createRectangularCadPlateDefinition({
      partId: definition.partId,
      displayName: definition.displayName,
      widthM: cadParameterLength(definition, "width", evidence?.overallBounds.size.x ?? 0.6),
      depthM: cadParameterLength(definition, "depth", evidence?.overallBounds.size.y ?? 0.4),
      thicknessM: cadParameterLength(definition, "thickness", evidence?.overallBounds.size.z ?? 0.08),
      holeDiameterM: existingHole ? cadParameterLength(definition, "hole_diameter", 0.08) : 0,
    });
    return cadPartDefinitionDigest(reconstructed) === cadPartDefinitionDigest(definition);
  } catch {
    return false;
  }
}

function updateBasicCadDefinition(
  definition: CadPartDefinitionV1,
  input: Readonly<{
    displayName: string;
    widthM: number;
    depthM: number;
    thicknessM: number;
    holeDiameterM: number;
  }>,
): CadPartDefinitionV1 {
  const displayName = input.displayName.trim();
  if (!displayName) throw new Error("Part name is required.");
  let next = applyCadDocumentEdits(definition, [{ kind: "rename_part", displayName }]);
  const candidates = [
    ["width", input.widthM],
    ["depth", input.depthM],
    ["thickness", input.thicknessM],
  ] as const;
  for (const [parameterId, value] of candidates) {
    const parameter = editableCadLengthParameter(next, parameterId);
    if (!parameter) continue;
    if (!Number.isFinite(value) || value < 1e-6 || value > 1_000) {
      throw new Error("Editable CAD dimensions must be between 0.000001 and 1000 metres.");
    }
    next = applyCadDocumentEdits(next, [{
      kind: "set_parameter",
      parameter: { ...parameter, expression: cadLengthExpression(value) },
    }]);
  }
  const holeParameter = editableCadLengthParameter(next, "hole_diameter");
  if (holeParameter) {
    if (!Number.isFinite(input.holeDiameterM)
      || input.holeDiameterM < 1e-6
      || input.holeDiameterM >= Math.min(input.widthM, input.depthM)) {
      throw new Error("A custom part's existing hole must stay positive and smaller than its editable width and depth.");
    }
    next = applyCadDocumentEdits(next, [{
      kind: "set_parameter",
      parameter: { ...holeParameter, expression: cadLengthExpression(input.holeDiameterM) },
    }]);
  }
  return next;
}

async function evaluateCadPartInWorker(
  definition: CadPartDefinitionV1,
): Promise<CadEvaluationEvidenceV1> {
  const kernel = await createCadWorkerKernel();
  try {
    const result = await kernel.evaluatePart(definition, {
      linearDeflectionM: 0.0005,
      angularDeflectionRad: 0.15,
      budgetMs: 30_000,
    });
    return parseCadEvaluationEvidence(result.evidence, definition);
  } finally {
    await kernel.dispose();
  }
}

function CadPartInspectorEditor({
  component,
  onUpdate,
  evaluateCadPart,
  advanced,
}: Readonly<{
  component: WorkspaceRenderComponent;
  onUpdate?: (request: WorkspaceComponentUpdateRequest) => boolean | void;
  evaluateCadPart?: WorkspaceCadPartEvaluator;
  advanced: boolean;
}>) {
  const formId = useId();
  const definition = parseCadPartDefinition(component.props.definition);
  const evidence = component.props.evaluation === null
    ? undefined
    : parseCadEvaluationEvidence(component.props.evaluation, definition);
  const signature = JSON.stringify({
    definition,
    partNumber: component.props.partNumber,
    materialName: component.props.materialName,
    evidence,
  });
  const existingHole = definition.history.find((feature) => feature.kind === "hole");
  const rectangularStarter = isRectangularCadPlateDefinition(definition, evidence);
  const basicDimensionsEditable = rectangularStarter || ["width", "depth", "thickness"]
    .every((parameterId) => editableCadLengthParameter(definition, parameterId));
  const basicHoleEditable = rectangularStarter || Boolean(editableCadLengthParameter(definition, "hole_diameter"));
  const [displayName, setDisplayName] = useState(definition.displayName);
  const [width, setWidth] = useState(String(cadParameterLength(definition, "width", evidence?.overallBounds.size.x ?? 0.6)));
  const [depth, setDepth] = useState(String(cadParameterLength(definition, "depth", evidence?.overallBounds.size.y ?? 0.4)));
  const [thickness, setThickness] = useState(String(cadParameterLength(definition, "thickness", evidence?.overallBounds.size.z ?? 0.08)));
  const [holeDiameter, setHoleDiameter] = useState(String(existingHole ? cadParameterLength(definition, "hole_diameter", 0.08) : 0));
  const [partNumber, setPartNumber] = useState(stringValue(component.props.partNumber));
  const [materialName, setMaterialName] = useState(stringValue(component.props.materialName));
  const [rawDefinition, setRawDefinition] = useState(JSON.stringify(definition, null, 2));
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string>();
  const runRef = useRef(0);

  useEffect(() => {
    runRef.current += 1;
    setDisplayName(definition.displayName);
    setWidth(String(cadParameterLength(definition, "width", evidence?.overallBounds.size.x ?? 0.6)));
    setDepth(String(cadParameterLength(definition, "depth", evidence?.overallBounds.size.y ?? 0.4)));
    setThickness(String(cadParameterLength(definition, "thickness", evidence?.overallBounds.size.z ?? 0.08)));
    setHoleDiameter(String(existingHole ? cadParameterLength(definition, "hole_diameter", 0.08) : 0));
    setPartNumber(stringValue(component.props.partNumber));
    setMaterialName(stringValue(component.props.materialName));
    setRawDefinition(JSON.stringify(definition, null, 2));
    setPending(false);
    setError(undefined);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [component.id, signature]);

  const locked = component.locks.props || !onUpdate;
  const evaluateAndCommit = async (nextDefinition: CadPartDefinitionV1): Promise<void> => {
    if (locked || pending) return;
    const run = runRef.current + 1;
    runRef.current = run;
    setPending(true);
    setError(undefined);
    try {
      const evaluator = evaluateCadPart ?? evaluateCadPartInWorker;
      const nextEvidence = parseCadEvaluationEvidence(await evaluator(nextDefinition), nextDefinition);
      if (run !== runRef.current) return;
      const applied = onUpdate?.({
        componentId: component.id,
        props: {
          definition: structuredClone(nextDefinition) as unknown as JSONObject,
          definitionDigest: cadPartDefinitionDigest(nextDefinition),
          evaluation: structuredClone(nextEvidence) as unknown as JSONObject,
          partNumber: partNumber.trim(),
          materialName: materialName.trim(),
        },
      });
      if (applied === false) throw new Error("The evaluated CAD part could not be committed to this Workspace.");
      setRawDefinition(JSON.stringify(nextDefinition, null, 2));
    } catch (caught) {
      if (run === runRef.current) {
        setError(caught instanceof Error ? caught.message : "The CAD feature history could not be evaluated.");
      }
    } finally {
      if (run === runRef.current) setPending(false);
    }
  };

  const applyStarter = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    try {
      const input = {
        displayName: displayName.trim() || definition.displayName,
        widthM: Number(width),
        depthM: Number(depth),
        thicknessM: Number(thickness),
        holeDiameterM: Number(holeDiameter),
      };
      const next = advanced || rectangularStarter
        ? createRectangularCadPlateDefinition({ partId: definition.partId, ...input })
        : updateBasicCadDefinition(definition, input);
      void evaluateAndCommit(next);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "The starter part dimensions are invalid.");
    }
  };

  const applyRawDefinition = () => {
    try {
      void evaluateAndCommit(parseCadPartDefinition(JSON.parse(rawDefinition) as unknown));
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "The CAD document JSON is invalid.");
    }
  };

  return <section className="workspace-inspector__modeling workspace-inspector__cad" aria-labelledby={`${formId}-heading`}>
    <h3 id={`${formId}-heading`}>Editable CAD part</h3>
    <p className="workspace-inspector__hint">
      Named SI parameters and ordered features are evaluated as exact OCCT B-rep. A failed feature never replaces the last valid part.
    </p>
    {!advanced && !rectangularStarter && <p className="workspace-inspector__hint">
      Basic mode preserves this custom feature history. It can rename the part and edit existing constant width, depth, thickness, and hole parameters; use Advanced for topology changes.
    </p>}
    {evidence ? <dl className="workspace-inspector__cad-evidence" aria-label="CAD evaluation evidence">
      <div><dt>Status</dt><dd>Valid B-rep</dd></div>
      <div><dt>Bodies</dt><dd>{evidence.bodies.length}</dd></div>
      <div><dt>Volume</dt><dd>{evidence.bodies.reduce((sum, body) => sum + body.volumeM3, 0).toPrecision(6)} m³</dd></div>
      <div><dt>Bounds</dt><dd>{evidence.overallBounds.size.x.toPrecision(4)} × {evidence.overallBounds.size.y.toPrecision(4)} × {evidence.overallBounds.size.z.toPrecision(4)} m</dd></div>
    </dl> : <p className="workspace-inspector__cad-empty">No solid yet. Build the starter plate or evaluate an advanced feature document.</p>}
    <form onSubmit={applyStarter} noValidate>
      <label htmlFor={`${formId}-cad-name`}><span>Part name</span><input id={`${formId}-cad-name`} type="text" maxLength={256} value={displayName} disabled={locked || pending} onChange={(event) => setDisplayName(event.target.value)} /></label>
      <fieldset><legend>Starter plate · exact metres</legend>
        <label htmlFor={`${formId}-cad-width`}><span>Width</span><input id={`${formId}-cad-width`} aria-label="CAD plate width (m)" type="number" min="0.000001" max="1000" step="0.001" value={width} disabled={locked || pending || (!advanced && !basicDimensionsEditable)} onChange={(event) => setWidth(event.target.value)} /></label>
        <label htmlFor={`${formId}-cad-depth`}><span>Depth</span><input id={`${formId}-cad-depth`} aria-label="CAD plate depth (m)" type="number" min="0.000001" max="1000" step="0.001" value={depth} disabled={locked || pending || (!advanced && !basicDimensionsEditable)} onChange={(event) => setDepth(event.target.value)} /></label>
        <label htmlFor={`${formId}-cad-thickness`}><span>Thickness</span><input id={`${formId}-cad-thickness`} aria-label="CAD plate thickness (m)" type="number" min="0.000001" max="1000" step="0.001" value={thickness} disabled={locked || pending || (!advanced && !basicDimensionsEditable)} onChange={(event) => setThickness(event.target.value)} /></label>
        <label htmlFor={`${formId}-cad-hole`}><span>Center hole · 0 off</span><input id={`${formId}-cad-hole`} aria-label="CAD plate hole diameter (m)" type="number" min="0" max="1000" step="0.001" value={holeDiameter} disabled={locked || pending || (!advanced && !basicHoleEditable)} onChange={(event) => setHoleDiameter(event.target.value)} /></label>
      </fieldset>
      <label htmlFor={`${formId}-cad-part-number`}><span>Part number</span><input id={`${formId}-cad-part-number`} type="text" maxLength={128} value={partNumber} disabled={locked || pending} onChange={(event) => setPartNumber(event.target.value)} /></label>
      <label htmlFor={`${formId}-cad-material-name`}><span>Material name</span><input id={`${formId}-cad-material-name`} type="text" maxLength={256} value={materialName} disabled={locked || pending} onChange={(event) => setMaterialName(event.target.value)} /></label>
      <button type="submit" disabled={locked || pending}>{pending
        ? "Evaluating exact B-rep…"
        : !advanced && !rectangularStarter ? "Apply safe CAD parameters" : "Build and apply starter part"}</button>
    </form>
    {advanced && <InspectorSectionAnchor sectionId="cad-features"><div className="workspace-inspector__advanced-fields">
      <ol className="workspace-inspector__feature-tree" aria-label="CAD feature history">
        {definition.history.map((feature, index) => <li key={feature.id} className={feature.suppressed ? "is-suppressed" : undefined}>
          <span>{index + 1}</span><strong>{feature.name}</strong><small>{feature.kind.replaceAll("_", " ")}{feature.suppressed ? " · suppressed" : ""}</small>
        </li>)}
      </ol>
      <details className="workspace-inspector__cad-advanced">
        <summary>Advanced feature document</summary>
        <p className="workspace-inspector__hint">Edit the versioned definition directly for revolve, boolean, hole, all-edge fillet, or all-edge chamfer. Unsupported features fail explicitly.</p>
        <textarea aria-label="CAD feature document JSON" rows={16} value={rawDefinition} disabled={locked || pending} spellCheck={false} onChange={(event) => setRawDefinition(event.target.value)} />
        <button type="button" disabled={locked || pending} onClick={applyRawDefinition}>Evaluate JSON and apply</button>
      </details>
    </div></InspectorSectionAnchor>}
    {error && <p className="workspace-inspector__error" role="alert">{error}</p>}
  </section>;
}

function ModelAssemblyInspectorEditor({
  component,
  onUpdate,
  advanced,
}: Readonly<{
  component: WorkspaceRenderComponent;
  onUpdate?: (request: WorkspaceComponentUpdateRequest) => boolean | void;
  advanced: boolean;
}>) {
  const formId = useId();
  const [displayName, setDisplayName] = useState(component.label);
  const [description, setDescription] = useState(stringValue(component.props.description));
  const [collisionPolicy, setCollisionPolicy] = useState<"external_only" | "all" | "none">(
    component.props.collisionPolicy === "all" || component.props.collisionPolicy === "none"
      ? component.props.collisionPolicy : "external_only",
  );
  const supportsCadAssembly = Number(component.type.version.split(".")[0]) >= 2;
  const [partNumber, setPartNumber] = useState(stringValue(component.props.partNumber));
  const [materialName, setMaterialName] = useState(stringValue(component.props.materialName));
  const [mates, setMates] = useState(JSON.stringify(Array.isArray(component.props.mates) ? component.props.mates : [], null, 2));
  const [error, setError] = useState<string>();
  useEffect(() => {
    setDisplayName(component.label);
    setDescription(stringValue(component.props.description));
    setCollisionPolicy(component.props.collisionPolicy === "all" || component.props.collisionPolicy === "none"
      ? component.props.collisionPolicy : "external_only");
    setPartNumber(stringValue(component.props.partNumber));
    setMaterialName(stringValue(component.props.materialName));
    setMates(JSON.stringify(Array.isArray(component.props.mates) ? component.props.mates : [], null, 2));
    setError(undefined);
  }, [
    component.id,
    component.label,
    component.props.collisionPolicy,
    component.props.description,
    component.props.materialName,
    component.props.mates,
    component.props.partNumber,
  ]);
  const locked = component.locks.props || !onUpdate;
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const label = displayName.trim();
    if (!label) return;
    let parsedMates;
    try {
      parsedMates = supportsCadAssembly ? parseCadAssemblyMates(JSON.parse(mates) as unknown) : undefined;
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Assembly mates must be valid JSON.");
      return;
    }
    setError(undefined);
    const applied = onUpdate?.({
      componentId: component.id,
      label,
      props: {
        description: description.trim(),
        collisionPolicy,
        ...(supportsCadAssembly ? {
          partNumber: partNumber.trim(),
          materialName: materialName.trim(),
          mates: structuredClone(parsedMates) as unknown as JSONValue,
        } : {}),
      },
    });
    if (applied === false) setError("Assembly metadata or mate endpoints could not be applied.");
  };
  const modelRef = recordValue(component.props.modelRef);
  return <section className="workspace-inspector__modeling" aria-labelledby={`${formId}-heading`}>
    <h3 id={`${formId}-heading`}>Model assembly</h3>
    <p className="workspace-inspector__hint">A transform-only root for editable parts. External-only collision permits intentional overlap between its descendants.</p>
    <form onSubmit={submit}>
      <label htmlFor={`${formId}-name`}><span>Display name</span><input id={`${formId}-name`} type="text" maxLength={500} value={displayName} disabled={locked} onChange={(event) => setDisplayName(event.target.value)} /></label>
      <label htmlFor={`${formId}-description`}><span>Description</span><textarea id={`${formId}-description`} maxLength={2_000} value={description} disabled={locked} onChange={(event) => setDescription(event.target.value)} /></label>
      <label htmlFor={`${formId}-collision-policy`}><span>Collision policy</span><select id={`${formId}-collision-policy`} value={collisionPolicy} disabled={locked} onChange={(event) => setCollisionPolicy(event.target.value as typeof collisionPolicy)}><option value="external_only">External only</option><option value="all">All descendants</option><option value="none">No assembly collision</option></select></label>
      {supportsCadAssembly && <>
        <label htmlFor={`${formId}-assembly-part-number`}><span>Assembly number</span><input id={`${formId}-assembly-part-number`} type="text" maxLength={128} value={partNumber} disabled={locked} onChange={(event) => setPartNumber(event.target.value)} /></label>
        <label htmlFor={`${formId}-assembly-material`}><span>Material / specification</span><input id={`${formId}-assembly-material`} type="text" maxLength={256} value={materialName} disabled={locked} onChange={(event) => setMaterialName(event.target.value)} /></label>
        {advanced && <div
          className="workspace-inspector__advanced-fields"
          data-workspace-inspector-section="assembly-mates"
          tabIndex={-1}
        >
          <label htmlFor={`${formId}-assembly-mates`}><span>Semantic mates</span><textarea id={`${formId}-assembly-mates`} aria-label="Assembly mates JSON" rows={8} value={mates} disabled={locked} spellCheck={false} onChange={(event) => setMates(event.target.value)} /></label>
          <p className="workspace-inspector__hint">Fixed, revolute, slider, and planar mates reference child component IDs plus optional CAD datum/topology roles.</p>
        </div>}
      </>}
      {error && <p className="workspace-inspector__error" role="alert">{error}</p>}
      <button type="submit" disabled={locked || !displayName.trim()}>Apply model settings</button>
    </form>
    {modelRef && <dl className="workspace-inspector__model-ref" aria-label="Published model reference"><div><dt>Model</dt><dd>{stringValue(modelRef.modelId)}</dd></div><div><dt>Version</dt><dd>{stringValue(modelRef.version)}</dd></div>{advanced && <div><dt>Digest</dt><dd>{stringValue(modelRef.digest)}</dd></div>}</dl>}
  </section>;
}

type RealityCalibrationMode = RealityAssetCalibration["status"];
type RealityQuality = "auto" | "low" | "medium" | "high";
type RealityDeclaredUnit = "metre" | "centimetre" | "millimetre" | "inch" | "foot";

const REALITY_UNIT_SCALE: Readonly<Record<RealityDeclaredUnit, number>> = Object.freeze({
  metre: 1,
  centimetre: 0.01,
  millimetre: 0.001,
  inch: 0.0254,
  foot: 0.3048,
});

function safeRealityCalibration(value: unknown): RealityAssetCalibration {
  try {
    return parseRealityAssetCalibration(value);
  } catch {
    return {
      version: 1,
      status: "uncalibrated",
      sourceCoordinateSystem: "UNKNOWN",
      targetCoordinateSystem: "RUB",
      metersPerSourceUnit: null,
    };
  }
}

function RealitySplatInspectorEditor({
  component,
  proxyOptions,
  measurement,
  onStartMeasurement,
  onCancelMeasurement,
  onUpdate,
  advanced,
}: Readonly<{
  component: WorkspaceRenderComponent;
  proxyOptions: readonly WorkspaceAssemblyOption[];
  measurement?: RealityMeasurementEvent;
  onStartMeasurement?: (componentId: string) => boolean;
  onCancelMeasurement?: () => void;
  onUpdate?: (request: WorkspaceComponentUpdateRequest) => boolean | void;
  advanced: boolean;
}>) {
  const formId = useId();
  const calibration = safeRealityCalibration(component.props.calibration);
  const currentQuality: RealityQuality = ["low", "medium", "high"].includes(String(component.props.quality))
    ? component.props.quality as RealityQuality
    : "auto";
  const currentProxyIds = Array.isArray(component.props.semanticProxyIds)
    ? component.props.semanticProxyIds.filter((value): value is string => typeof value === "string")
    : [];
  const assetRef = recordValue(component.props.assetRef);
  const measurementForAsset = measurement?.componentId === component.id
    && measurement.assetId === stringValue(assetRef?.assetId)
    && measurement.assetDigest === stringValue(assetRef?.digest)
    ? measurement
    : undefined;
  const measurementIsLive = Boolean(measurementForAsset && measurementForAsset.kind !== "cancelled");
  const signature = JSON.stringify({ assetRef, calibration, currentQuality, currentProxyIds });
  const [mode, setMode] = useState<RealityCalibrationMode>(calibration.status);
  const [coordinateSystem, setCoordinateSystem] = useState<RealityCoordinateSystem>(calibration.sourceCoordinateSystem);
  const [declaredUnit, setDeclaredUnit] = useState<RealityDeclaredUnit>(
    calibration.status === "metadata-declared" ? calibration.declaredUnit : "metre",
  );
  const [sourceDistance, setSourceDistance] = useState(
    calibration.status === "reference-distance" ? String(calibration.sourceDistance) : "1",
  );
  const [referenceDistanceM, setReferenceDistanceM] = useState(
    calibration.status === "reference-distance" ? String(calibration.referenceDistanceM) : "1",
  );
  const [quality, setQuality] = useState<RealityQuality>(currentQuality);
  const [proxyIds, setProxyIds] = useState<readonly string[]>(currentProxyIds);
  const [error, setError] = useState<string>();
  const [measurementDraftSessionId, setMeasurementDraftSessionId] = useState<number>();
  const [confirmedReferenceSessionId, setConfirmedReferenceSessionId] = useState<number>();
  const activeMeasurementSessionRef = useRef<number | undefined>(undefined);
  const completedMeasurementSessionRef = useRef<number | undefined>(undefined);
  const focusedMeasurementSessionRef = useRef<number | undefined>(undefined);
  const referenceDistanceInputRef = useRef<HTMLInputElement>(null);
  const persistedMode = calibration.status;
  const persistedSourceDistance = calibration.status === "reference-distance"
    ? String(calibration.sourceDistance)
    : "1";
  const persistedReferenceDistanceM = calibration.status === "reference-distance"
    ? String(calibration.referenceDistanceM)
    : "1";
  const persistedDeclaredUnit: RealityDeclaredUnit = calibration.status === "metadata-declared"
    ? calibration.declaredUnit
    : "metre";

  useEffect(() => {
    if (!measurementIsLive) {
      setMode(calibration.status);
      setCoordinateSystem(calibration.sourceCoordinateSystem);
      setDeclaredUnit(persistedDeclaredUnit);
      setSourceDistance(persistedSourceDistance);
      setReferenceDistanceM(persistedReferenceDistanceM);
      setMeasurementDraftSessionId(undefined);
      setConfirmedReferenceSessionId(undefined);
    }
    setQuality(currentQuality);
    setProxyIds(currentProxyIds);
    setError(undefined);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [component.id, signature, measurementIsLive]);

  useEffect(() => {
    const activeMeasurement = measurementForAsset?.kind === "cancelled"
      ? undefined
      : measurementForAsset;
    if (!activeMeasurement) {
      if (activeMeasurementSessionRef.current !== undefined) {
        setMode(persistedMode);
        setCoordinateSystem(calibration.sourceCoordinateSystem);
        setDeclaredUnit(persistedDeclaredUnit);
        setSourceDistance(persistedSourceDistance);
        setReferenceDistanceM(persistedReferenceDistanceM);
        setMeasurementDraftSessionId(undefined);
        setConfirmedReferenceSessionId(undefined);
        setError(undefined);
      }
      activeMeasurementSessionRef.current = undefined;
      completedMeasurementSessionRef.current = undefined;
      focusedMeasurementSessionRef.current = undefined;
      return;
    }

    if (activeMeasurementSessionRef.current !== activeMeasurement.sessionId) {
      activeMeasurementSessionRef.current = activeMeasurement.sessionId;
      completedMeasurementSessionRef.current = undefined;
      focusedMeasurementSessionRef.current = undefined;
      setMode(persistedMode);
      setCoordinateSystem(calibration.sourceCoordinateSystem);
      setDeclaredUnit(persistedDeclaredUnit);
      setSourceDistance(persistedSourceDistance);
      setReferenceDistanceM(persistedReferenceDistanceM);
      setMeasurementDraftSessionId(undefined);
      setConfirmedReferenceSessionId(undefined);
      setError(undefined);
    }

    if (activeMeasurement.kind === "complete"
      && completedMeasurementSessionRef.current !== activeMeasurement.sessionId) {
      completedMeasurementSessionRef.current = activeMeasurement.sessionId;
      setMode("reference-distance");
      setSourceDistance(formatMeasuredDistance(activeMeasurement.sourceDistance));
      // A new A/B span cannot silently inherit either the placeholder 1 m value
      // or a real distance that belonged to a previous span. The user must make
      // one explicit input change for this exact renderer session.
      setReferenceDistanceM("");
      setMeasurementDraftSessionId(activeMeasurement.sessionId);
      setConfirmedReferenceSessionId(undefined);
      setError(undefined);
    }
  }, [
    calibration.sourceCoordinateSystem,
    calibration.status,
    measurementForAsset,
    persistedDeclaredUnit,
    persistedMode,
    persistedReferenceDistanceM,
    persistedSourceDistance,
  ]);

  useEffect(() => {
    if (measurementForAsset?.kind !== "complete"
      || measurementDraftSessionId !== measurementForAsset.sessionId
      || mode !== "reference-distance"
      || focusedMeasurementSessionRef.current === measurementForAsset.sessionId) return;
    const input = referenceDistanceInputRef.current;
    if (!input) return;
    focusedMeasurementSessionRef.current = measurementForAsset.sessionId;
    input.focus({ preventScroll: true });
  }, [measurementDraftSessionId, measurementForAsset, mode]);

  const locked = component.locks.props || !onUpdate;
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (locked || !onUpdate) {
      setError("Reality settings are locked and could not be applied.");
      return;
    }
    if (measurementForAsset?.kind === "complete"
      && (mode !== "reference-distance"
        || measurementDraftSessionId !== measurementForAsset.sessionId
        || confirmedReferenceSessionId !== measurementForAsset.sessionId
        || !inRange(Number(referenceDistanceM), 1e-12, 1e6))) {
      setError("Enter the known real distance for this measured A/B span, or clear its markers before applying other Reality settings.");
      return;
    }
    if (mode !== "uncalibrated" && coordinateSystem === "UNKNOWN") {
      setError("Choose the capture's source coordinate system before claiming metric calibration.");
      return;
    }

    let nextCalibration: RealityAssetCalibration;
    try {
      if (mode === "uncalibrated") {
        nextCalibration = parseRealityAssetCalibration({
          version: 1,
          status: "uncalibrated",
          sourceCoordinateSystem: coordinateSystem,
          targetCoordinateSystem: "RUB",
          metersPerSourceUnit: null,
        });
      } else if (mode === "metadata-declared") {
        nextCalibration = parseRealityAssetCalibration({
          version: 1,
          status: "metadata-declared",
          sourceCoordinateSystem: coordinateSystem,
          targetCoordinateSystem: "RUB",
          metersPerSourceUnit: REALITY_UNIT_SCALE[declaredUnit],
          declaredUnit,
        });
      } else {
        const nextSourceDistance = Number(sourceDistance);
        const nextReferenceDistanceM = Number(referenceDistanceM);
        if (!inRange(nextSourceDistance, 1e-12, 1e9)
          || !inRange(nextReferenceDistanceM, 1e-12, 1e6)
          || !inRange(nextReferenceDistanceM / nextSourceDistance, 1e-12, 1e6)) {
          throw new Error("Reference distances or their resulting metric scale exceed the Reality component limits.");
        }
        nextCalibration = parseRealityAssetCalibration({
          version: 1,
          status: "reference-distance",
          sourceCoordinateSystem: coordinateSystem,
          targetCoordinateSystem: "RUB",
          metersPerSourceUnit: nextReferenceDistanceM / nextSourceDistance,
          sourceDistance: nextSourceDistance,
          referenceDistanceM: nextReferenceDistanceM,
        });
      }
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Reality calibration is invalid.");
      return;
    }

    setError(undefined);
    const applied = onUpdate({
      componentId: component.id,
      props: {
        assetRef: assetRef ? structuredClone(assetRef) : null,
        calibration: structuredClone(nextCalibration),
        quality,
        semanticProxyIds: [...proxyIds],
      } as unknown as JSONObject,
    });
    if (applied === false) {
      setError("Reality settings could not be applied. The A/B measurement is still available; fix the Workspace error and try again.");
      return;
    }
    onCancelMeasurement?.();
  };

  const activeMeasurement = measurementForAsset;
  const measurementActive = activeMeasurement !== undefined && activeMeasurement.kind !== "cancelled";
  const completedMeasurementNeedsReference = activeMeasurement?.kind === "complete"
    && (mode !== "reference-distance"
      || measurementDraftSessionId !== activeMeasurement.sessionId
      || confirmedReferenceSessionId !== activeMeasurement.sessionId
      || !inRange(Number(referenceDistanceM), 1e-12, 1e6));
  const startMeasurement = () => {
    setError(undefined);
    if (!onStartMeasurement?.(component.id)) {
      setError("The loaded Gaussian surface is not ready. Relink its local bytes or wait for rendering to finish.");
    }
  };

  return <section className="workspace-inspector__modeling workspace-inspector__reality" aria-labelledby={`${formId}-heading`}>
    <h3 id={`${formId}-heading`}>Reality layer</h3>
    <p className="workspace-inspector__hint">
      Gaussian splats are visual evidence, never collision, physics, CAD, or feasibility authority.
      Link editable spatial proxies when engineering meaning is required.
    </p>
    {assetRef ? <dl className="workspace-inspector__model-ref" aria-label="Reality asset reference">
      <div><dt>Asset</dt><dd>{stringValue(assetRef.assetId)}</dd></div>
      {advanced && <div><dt>Digest</dt><dd>{stringValue(assetRef.digest)}</dd></div>}
    </dl> : <p className="workspace-inspector__privacy">No asset is linked. The renderer will keep a placeholder.</p>}
    <form onSubmit={submit} noValidate>
      <fieldset className="workspace-inspector__reality-measurement">
        <legend>Two-point surface calibration</legend>
        <p className="workspace-inspector__hint">
          Pick A and B directly on the capture. This uses the Gaussian LOD surface as a visual estimate,
          not survey or CAD geometry.
        </p>
        <div className="workspace-inspector__measurement-actions">
          <button type="button" disabled={locked || !assetRef || !onStartMeasurement} onClick={startMeasurement}>
            {measurementActive ? "Restart two-point pick" : "Pick two points"}
          </button>
          {measurementActive && <button type="button" onClick={onCancelMeasurement}>
            {activeMeasurement.kind === "complete" ? "Clear markers" : "Cancel"}
          </button>}
        </div>
        <p className="workspace-inspector__measurement-status" role="status" aria-live="polite">
          {realityMeasurementStatus(activeMeasurement)}
        </p>
      </fieldset>
      <label htmlFor={`${formId}-quality`}><span>Render quality</span><select id={`${formId}-quality`} aria-label="Render quality" value={quality} disabled={locked} onChange={(event) => setQuality(event.target.value as RealityQuality)}><option value="auto">Auto</option><option value="low">Low</option><option value="medium">Medium</option><option value="high">High</option></select></label>
      <label htmlFor={`${formId}-calibration`}><span>Calibration</span><select id={`${formId}-calibration`} aria-label="Calibration" value={mode} disabled={locked} onChange={(event) => { setMode(event.target.value as RealityCalibrationMode); setError(undefined); }}><option value="uncalibrated">Uncalibrated</option><option value="metadata-declared">Declared unit</option><option value="reference-distance">Reference distance</option></select></label>
      <label htmlFor={`${formId}-coordinates`}><span>Source coordinates</span><select id={`${formId}-coordinates`} aria-label="Source coordinates" value={coordinateSystem} disabled={locked} onChange={(event) => { setCoordinateSystem(event.target.value as RealityCoordinateSystem); setError(undefined); }}>{REALITY_COORDINATE_SYSTEMS.map((system) => <option key={system} value={system}>{system}{system === "RUB" ? " · right/up/back" : system === "UNKNOWN" ? " · unknown" : ""}</option>)}</select></label>
      {mode === "metadata-declared" && <label htmlFor={`${formId}-unit`}><span>Source unit</span><select id={`${formId}-unit`} aria-label="Source unit" value={declaredUnit} disabled={locked} onChange={(event) => setDeclaredUnit(event.target.value as RealityDeclaredUnit)}><option value="metre">Metre</option><option value="centimetre">Centimetre</option><option value="millimetre">Millimetre</option><option value="inch">Inch</option><option value="foot">Foot</option></select></label>}
      {mode === "reference-distance" && <fieldset>
        <legend>Known reference</legend>
        <label htmlFor={`${formId}-source-distance`}><span>Source distance</span><input id={`${formId}-source-distance`} aria-label="Source distance" type="number" min="0.000000000001" max="1000000000" step="any" value={sourceDistance} disabled={locked || measurementForAsset?.kind === "complete"} onChange={(event) => { setSourceDistance(event.target.value); setError(undefined); }} /></label>
        <label htmlFor={`${formId}-reference-distance`}><span>Real distance (m)</span><input ref={referenceDistanceInputRef} id={`${formId}-reference-distance`} aria-label="Real distance (m)" type="number" min="0.000000000001" max="1000000" step="any" value={referenceDistanceM} disabled={locked} onChange={(event) => { setReferenceDistanceM(event.target.value); if (measurementForAsset?.kind === "complete" && measurementDraftSessionId === measurementForAsset.sessionId) setConfirmedReferenceSessionId(measurementForAsset.sessionId); setError(undefined); }} /></label>
      </fieldset>}
      <fieldset>
        <legend>Engineering proxies</legend>
        {proxyOptions.length === 0 ? <p className="workspace-inspector__hint">Create an editable primitive, entity, or assembly to provide collision and engineering semantics.</p> : proxyOptions.map((option) => { const checked = proxyIds.includes(option.id); return <label key={option.id}><input type="checkbox" checked={checked} disabled={locked || (!checked && proxyIds.length >= 128)} onChange={(event) => setProxyIds((current) => event.target.checked ? [...current, option.id] : current.filter((id) => id !== option.id))} />{option.label}</label>; })}
      </fieldset>
      {error && <p className="workspace-inspector__error" role="alert">{error}</p>}
      <button type="submit" disabled={locked || completedMeasurementNeedsReference}>Apply Reality settings</button>
    </form>
  </section>;
}

export function realityMeasurementStatus(measurement: RealityMeasurementEvent | undefined): string {
  if (!measurement || measurement.kind === "cancelled") return "Ready to pick a known span from the visible capture.";
  if (measurement.kind === "started") return "Pick point A on the visible Gaussian surface. You can also aim at viewport center and press Enter. Press Escape to cancel.";
  if (measurement.kind === "point") {
    return measurement.pointIndex === 1
      ? "Point A captured. Pick point B on a different part of the surface."
      : "Point B captured. Calculating the source-space distance…";
  }
  if (measurement.kind === "miss") return measurement.message;
  return `Measured ${formatMeasuredDistance(measurement.sourceDistance)} source units (${formatMeasuredDistance(measurement.displayedDistance)} current display units). Enter the known real distance, then apply.`;
}

function formatMeasuredDistance(value: number): string {
  if (!Number.isFinite(value)) return "";
  if (value === 0) return "0";
  const magnitude = Math.abs(value);
  if (magnitude >= 1e6 || magnitude < 1e-5) return value.toExponential(6);
  return Number(value.toPrecision(8)).toString();
}

function CollisionInspectorEditor({
  component,
  onUpdate,
  advanced,
}: Readonly<{
  component: WorkspaceRenderComponent;
  onUpdate?: (request: WorkspaceComponentUpdateRequest) => boolean | void;
  advanced: boolean;
}>) {
  const formId = useId();
  const raw = component.props.collision;
  const initial = raw && typeof raw === "object" && !Array.isArray(raw)
    ? raw as Record<string, unknown>
    : {};
  const signature = JSON.stringify(initial);
  const [enabled, setEnabled] = useState(initial.enabled !== false);
  const [role, setRole] = useState<"solid" | "trigger" | "none">(
    initial.role === "trigger" || initial.role === "none" ? initial.role : "solid",
  );
  const [margin, setMargin] = useState(String(typeof initial.margin === "number" ? initial.margin : 0.02));
  const [shape, setShape] = useState<"asset_bounds" | "box" | "compound">(
    initial.shape === "box" || initial.shape === "compound" ? initial.shape : "asset_bounds",
  );
  const initialCenter = initial.center && typeof initial.center === "object" && !Array.isArray(initial.center)
    ? initial.center as Record<string, unknown> : {};
  const initialSize = initial.size && typeof initial.size === "object" && !Array.isArray(initial.size)
    ? initial.size as Record<string, unknown> : {};
  const [center, setCenter] = useState(["x", "y", "z"].map((axis) => String(typeof initialCenter[axis] === "number" ? initialCenter[axis] : 0)));
  const [size, setSize] = useState(["x", "y", "z"].map((axis) => String(typeof initialSize[axis] === "number" ? initialSize[axis] : 1)));
  const [parts, setParts] = useState(JSON.stringify(Array.isArray(initial.parts) ? initial.parts : [{
    id: "body", center: { x: 0, y: 0.5, z: 0 }, size: { x: 1, y: 1, z: 1 }, rotation: { x: 0, y: 0, z: 0 },
  }], null, 2));
  const [error, setError] = useState<string>();
  useEffect(() => {
    setEnabled(initial.enabled !== false);
    setRole(initial.role === "trigger" || initial.role === "none" ? initial.role : "solid");
    setMargin(String(typeof initial.margin === "number" ? initial.margin : 0.02));
    setShape(initial.shape === "box" || initial.shape === "compound" ? initial.shape : "asset_bounds");
    const nextCenter = initial.center && typeof initial.center === "object" && !Array.isArray(initial.center) ? initial.center as Record<string, unknown> : {};
    const nextSize = initial.size && typeof initial.size === "object" && !Array.isArray(initial.size) ? initial.size as Record<string, unknown> : {};
    setCenter(["x", "y", "z"].map((axis) => String(typeof nextCenter[axis] === "number" ? nextCenter[axis] : 0)));
    setSize(["x", "y", "z"].map((axis) => String(typeof nextSize[axis] === "number" ? nextSize[axis] : 1)));
    setParts(JSON.stringify(Array.isArray(initial.parts) ? initial.parts : [{
      id: "body", center: { x: 0, y: 0.5, z: 0 }, size: { x: 1, y: 1, z: 1 }, rotation: { x: 0, y: 0, z: 0 },
    }], null, 2));
    setError(undefined);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [component.id, signature]);

  const assetId = typeof component.props.assetId === "string" ? component.props.assetId : "";
  const asset = DEFAULT_ASSET_REGISTRY.get(assetId);
  const parametricBounds = component.type.typeId === "spatial-primitive"
    ? (() => {
      try { return deriveParametricBounds(parseParametricPrimitive(component.props.geometry)); }
      catch { return undefined; }
    })()
    : undefined;
  const cadBounds = component.type.typeId === "cad-part" && component.props.evaluation !== null
    ? (() => {
      try {
        const parsed = parseCadEvaluationEvidence(
          component.props.evaluation,
          parseCadPartDefinition(component.props.definition),
        );
        return parsed.overallBounds;
      } catch {
        return undefined;
      }
    })()
    : undefined;
  const scale = component.placement.space === "world3d"
    ? component.placement.scale
    : { x: 1, y: 1, z: 1 };
  const parsedMargin = Number(margin);
  const canonicalBounds = cadBounds
    ? { width: cadBounds.size.x, height: cadBounds.size.y, depth: cadBounds.size.z }
    : parametricBounds
    ? { width: parametricBounds.size.x, height: parametricBounds.size.y, depth: parametricBounds.size.z }
    : asset?.bounds;
  const effectiveSize = shape === "asset_bounds" && canonicalBounds && Number.isFinite(parsedMargin)
    ? {
      x: canonicalBounds.width * Math.abs(scale.x) + parsedMargin * 2,
      y: canonicalBounds.height * Math.abs(scale.y) + parsedMargin * 2,
      z: canonicalBounds.depth * Math.abs(scale.z) + parsedMargin * 2,
    }
    : undefined;
  const locked = component.locks.props || !onUpdate;
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (advanced && !inRange(parsedMargin, 0, 10)) {
      setError("Collision margin must be between 0 and 10 meters.");
      return;
    }
    let rawParts: unknown;
    if (advanced && shape === "compound") {
      try { rawParts = JSON.parse(parts) as unknown; } catch {
        setError("Compound parts must be valid JSON.");
        return;
      }
    }
    const candidate = !advanced
      ? { ...structuredClone(initial), enabled }
      : shape === "asset_bounds"
        ? { enabled, role, shape, margin: parsedMargin }
        : shape === "box"
          ? {
            enabled, role, shape, margin: parsedMargin,
            center: { x: Number(center[0]), y: Number(center[1]), z: Number(center[2]) },
            size: { x: Number(size[0]), y: Number(size[1]), z: Number(size[2]) },
          }
          : { enabled, role, shape, margin: parsedMargin, parts: rawParts };
    const parsed = parseSpatialCollisionConfig(candidate);
    if (!parsed) {
      setError("Collision shape is invalid. Sizes must be positive and compound parts are limited to 16.");
      return;
    }
    setError(undefined);
    onUpdate?.({
      componentId: component.id,
      props: {
        collision: structuredClone(parsed) as unknown as JSONObject,
      },
    });
  };
  return (
    <section className="workspace-inspector__collision" aria-labelledby={`${formId}-heading`}>
      <h3 id={`${formId}-heading`}>Collision volume</h3>
      {advanced && <p className="workspace-inspector__hint">
        Use asset bounds, one explicit oriented box, or up to 16 compound box parts.
      </p>}
      <dl className="workspace-inspector__collision-size" aria-label="Collision configuration summary">
        <div><dt>Status</dt><dd>{enabled ? "Enabled" : "Disabled"}</dd></div>
        <div><dt>Role</dt><dd>{role === "solid" ? "Solid" : role === "trigger" ? "Trigger" : "Ignored"}</dd></div>
        <div><dt>Volume</dt><dd>{shape === "asset_bounds"
          ? component.type.typeId === "cad-part" ? "CAD bounds" : component.type.typeId === "spatial-primitive" ? "Geometry bounds" : "Asset bounds"
          : shape === "box" ? "Explicit box" : `Compound · ${Array.isArray(initial.parts) ? initial.parts.length : 0}`}</dd></div>
      </dl>
      {effectiveSize && (
        <dl className="workspace-inspector__collision-size" aria-label="Effective collision dimensions">
          <div><dt>Width</dt><dd>{effectiveSize.x.toFixed(2)} m</dd></div>
          <div><dt>Height</dt><dd>{effectiveSize.y.toFixed(2)} m</dd></div>
          <div><dt>Depth</dt><dd>{effectiveSize.z.toFixed(2)} m</dd></div>
        </dl>
      )}
      <form onSubmit={submit} noValidate>
        <label className="workspace-inspector__check" htmlFor={`${formId}-enabled`}>
          <input id={`${formId}-enabled`} type="checkbox" checked={enabled} disabled={locked} onChange={(event) => setEnabled(event.target.checked)} />
          <span>Collision enabled</span>
        </label>
        {advanced && <div
          className="workspace-inspector__advanced-fields"
          data-workspace-inspector-section="collision-details"
          tabIndex={-1}
        >
          <label htmlFor={`${formId}-role`}><span>Role</span>
            <select id={`${formId}-role`} value={role} disabled={locked} onChange={(event) => setRole(event.target.value as typeof role)}>
              <option value="solid">Solid · blocks overlap</option>
              <option value="trigger">Trigger · detects only</option>
              <option value="none">None · ignored</option>
            </select>
          </label>
          <label htmlFor={`${formId}-shape`}><span>Shape</span>
            <select id={`${formId}-shape`} value={shape} disabled={locked} onChange={(event) => setShape(event.target.value as typeof shape)}>
              <option value="asset_bounds">{component.type.typeId === "cad-part"
                ? "Exact CAD bounds"
                : component.type.typeId === "spatial-primitive"
                  ? "Geometry bounds"
                  : "Asset bounds"}</option>
              <option value="box">Explicit box</option>
              <option value="compound">Compound boxes</option>
            </select>
          </label>
          {shape === "box" && <>
            <fieldset><legend>Local center (m)</legend>{(["X", "Y", "Z"] as const).map((axis, index) => <label key={axis}><span>{axis}</span><input type="number" step="0.01" value={center[index]} disabled={locked} onChange={(event) => setCenter((current) => current.map((value, item) => item === index ? event.target.value : value))} /></label>)}</fieldset>
            <fieldset><legend>Box size (m)</legend>{(["X", "Y", "Z"] as const).map((axis, index) => <label key={axis}><span>{axis}</span><input type="number" min="0.001" max="1000" step="0.01" value={size[index]} disabled={locked} onChange={(event) => setSize((current) => current.map((value, item) => item === index ? event.target.value : value))} /></label>)}</fieldset>
          </>}
          {shape === "compound" && <label htmlFor={`${formId}-parts`}><span>Parts JSON</span>
            <textarea id={`${formId}-parts`} rows={8} value={parts} disabled={locked} onChange={(event) => setParts(event.target.value)} />
          </label>}
          <label htmlFor={`${formId}-margin`}><span>Margin (m)</span>
            <input id={`${formId}-margin`} type="number" min="0" max="10" step="0.01" value={margin} disabled={locked} onChange={(event) => setMargin(event.target.value)} />
          </label>
          <p className="workspace-inspector__hint">Solid overlaps reject the entire Workspace update. Touching faces are allowed.</p>
        </div>}
        {error && <p className="workspace-inspector__error" role="alert">{error}</p>}
        <button type="submit" disabled={locked}>Apply collision</button>
      </form>
      {component.locks.props && <p className="workspace-inspector__hint">Properties are locked for this component.</p>}
    </section>
  );
}

function PhysicsInspectorEditor({
  component,
  onUpdate,
  report,
  advanced,
}: Readonly<{
  component: WorkspaceRenderComponent;
  onUpdate?: (request: WorkspaceComponentUpdateRequest) => boolean | void;
  report?: PhysicsBodyReport;
  advanced: boolean;
}>) {
  const formId = useId();
  const parsed = parseSpatialPhysicsConfig(component.props.physics) ?? DEFAULT_SPATIAL_PHYSICS;
  const signature = JSON.stringify(parsed);
  const supportsMasterSwitch = component.type.typeId === "spatial-primitive"
    || component.type.typeId === "cad-part"
    || Number(component.type.version.split(".")[0]) > 1
    || (Number(component.type.version.split(".")[0]) === 1 && Number(component.type.version.split(".")[1]) >= 5);
  const [enabled, setEnabled] = useState(parsed.enabled);
  const [bodyType, setBodyType] = useState(parsed.bodyType);
  const [massKg, setMassKg] = useState(String(parsed.massKg));
  const [centerOfMass, setCenterOfMass] = useState([parsed.centerOfMass.x, parsed.centerOfMass.y, parsed.centerOfMass.z].map(String));
  const [friction, setFriction] = useState(String(parsed.friction));
  const [restitution, setRestitution] = useState(String(parsed.restitution));
  const [gravityScale, setGravityScale] = useState(String(parsed.gravityScale));
  const [stabilityMode, setStabilityMode] = useState(parsed.stabilityMode);
  const [constraints, setConstraints] = useState(JSON.stringify(parsed.constraints, null, 2));
  const [error, setError] = useState<string>();
  useEffect(() => {
    setEnabled(parsed.enabled);
    setBodyType(parsed.bodyType);
    setMassKg(String(parsed.massKg));
    setCenterOfMass([parsed.centerOfMass.x, parsed.centerOfMass.y, parsed.centerOfMass.z].map(String));
    setFriction(String(parsed.friction));
    setRestitution(String(parsed.restitution));
    setGravityScale(String(parsed.gravityScale));
    setStabilityMode(parsed.stabilityMode);
    setConstraints(JSON.stringify(parsed.constraints, null, 2));
    setError(undefined);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [component.id, signature]);
  const locked = component.locks.props || !onUpdate;
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!advanced) {
      const next = parseSpatialPhysicsConfig({ ...structuredClone(parsed), enabled });
      if (!next) {
        setError("The existing physics configuration is invalid and cannot be toggled safely.");
        return;
      }
      setError(undefined);
      const persisted = supportsMasterSwitch
        ? structuredClone(next)
        : (() => {
          const { enabled: _enabled, ...legacy } = structuredClone(next);
          return legacy;
        })();
      onUpdate?.({ componentId: component.id, props: { physics: persisted as unknown as JSONObject } });
      return;
    }
    let parsedConstraints: unknown;
    try { parsedConstraints = JSON.parse(constraints) as unknown; } catch {
      setError("Constraints must be valid JSON.");
      return;
    }
    const next = parseSpatialPhysicsConfig({
      enabled,
      bodyType,
      massKg: Number(massKg),
      centerOfMass: { x: Number(centerOfMass[0]), y: Number(centerOfMass[1]), z: Number(centerOfMass[2]) },
      friction: Number(friction),
      restitution: Number(restitution),
      gravityScale: Number(gravityScale),
      stabilityMode,
      constraints: parsedConstraints,
    });
    if (!next) {
      setError("Physics values or constraints are outside the supported bounds.");
      return;
    }
    setError(undefined);
    const persisted = supportsMasterSwitch
      ? structuredClone(next)
      : (() => {
        const { enabled: _enabled, ...legacy } = structuredClone(next);
        return legacy;
      })();
    onUpdate?.({ componentId: component.id, props: { physics: persisted as unknown as JSONObject } });
  };
  return <section className="workspace-inspector__collision" aria-labelledby={`${formId}-heading`}>
    <h3 id={`${formId}-heading`}>Physics validation</h3>
    {report ? <dl className="workspace-inspector__collision-size" aria-label="Physics feasibility">
      <div><dt>Status</dt><dd>{!report.enabled ? "Disabled" : report.stable ? "Stable" : report.stabilityReason}</dd></div>
      <div><dt>Load path</dt><dd>{report.grounded ? "Grounded" : "Not grounded"}</dd></div>
      <div><dt>Margin</dt><dd>{report.stabilityMarginM === null ? "—" : `${report.stabilityMarginM.toFixed(3)} m`}</dd></div>
      <div><dt>Supports</dt><dd>{report.supports.length}</dd></div>
    </dl> : <dl className="workspace-inspector__collision-size" aria-label="Physics configuration summary">
      <div><dt>Status</dt><dd>{enabled ? "Enabled" : "Disabled"}</dd></div>
      <div><dt>Body</dt><dd>{bodyType[0]?.toUpperCase()}{bodyType.slice(1)}</dd></div>
      <div><dt>Mass</dt><dd>{Number(massKg).toLocaleString()} kg</dd></div>
      <div><dt>Constraints</dt><dd>{parsed.constraints.length}</dd></div>
    </dl>}
    <form onSubmit={submit} noValidate>
      <label className="workspace-inspector__check" htmlFor={`${formId}-enabled`}>
        <input id={`${formId}-enabled`} type="checkbox" checked={enabled} disabled={locked || !supportsMasterSwitch} onChange={(event) => setEnabled(event.target.checked)} />
        <span>Physics enabled</span>
      </label>
      {!supportsMasterSwitch && <p className="workspace-inspector__hint">Upgrade this component to 1.5 to use the physics master switch.</p>}
      {advanced && <div
        className="workspace-inspector__advanced-fields"
        data-workspace-inspector-section="physics-details"
        tabIndex={-1}
      >
        <label htmlFor={`${formId}-body`}><span>Body type</span><select id={`${formId}-body`} value={bodyType} disabled={locked || !enabled} onChange={(event) => setBodyType(event.target.value as typeof bodyType)}><option value="static">Static</option><option value="dynamic">Dynamic</option><option value="kinematic">Kinematic</option></select></label>
        <label htmlFor={`${formId}-mass`}><span>Mass (kg)</span><input id={`${formId}-mass`} type="number" min="0.001" max="1000000" step="0.1" value={massKg} disabled={locked || !enabled} onChange={(event) => setMassKg(event.target.value)} /></label>
        <fieldset disabled={locked || !enabled}><legend>COM offset (m)</legend>{(["X", "Y", "Z"] as const).map((axis, index) => <label key={axis}><span>{axis}</span><input type="number" step="0.01" value={centerOfMass[index]} onChange={(event) => setCenterOfMass((current) => current.map((value, item) => item === index ? event.target.value : value))} /></label>)}</fieldset>
        <label htmlFor={`${formId}-friction`}><span>Friction</span><input id={`${formId}-friction`} type="number" min="0" max="2" step="0.05" value={friction} disabled={locked || !enabled} onChange={(event) => setFriction(event.target.value)} /></label>
        <label htmlFor={`${formId}-restitution`}><span>Restitution</span><input id={`${formId}-restitution`} type="number" min="0" max="1" step="0.05" value={restitution} disabled={locked || !enabled} onChange={(event) => setRestitution(event.target.value)} /></label>
        <label htmlFor={`${formId}-gravity`}><span>Gravity scale</span><input id={`${formId}-gravity`} type="number" min="0" max="10" step="0.1" value={gravityScale} disabled={locked || !enabled} onChange={(event) => setGravityScale(event.target.value)} /></label>
        <label htmlFor={`${formId}-stability`}><span>Stability</span><select id={`${formId}-stability`} value={stabilityMode} disabled={locked || !enabled} onChange={(event) => setStabilityMode(event.target.value as typeof stabilityMode)}><option value="report">Report only</option><option value="enforce">Enforce atomically</option></select></label>
        <label htmlFor={`${formId}-constraints`}><span>Constraints JSON</span><textarea id={`${formId}-constraints`} rows={8} value={constraints} disabled={locked || !enabled} onChange={(event) => setConstraints(event.target.value)} /></label>
        <p className="workspace-inspector__hint">Fixed, hinge, slider, and ball constraints use local anchors. Hinge/slider axes must be normalized.</p>
      </div>}
      {!enabled && <p className="workspace-inspector__hint">Physics validation and settling are off. Collision remains independently controlled above.</p>}
      {error && <p className="workspace-inspector__error" role="alert">{error}</p>}
      <button type="submit" disabled={locked}>Apply physics</button>
    </form>
  </section>;
}

function VisualEffectsInspectorEditor({
  component,
  onApply,
}: Readonly<{
  component: WorkspaceRenderComponent;
  onApply?: (request: WorkspaceComponentVisualEffectsRequest) => void;
}>) {
  const formId = useId();
  const effects = component.visualEffects ?? DEFAULT_COMPONENT_VISUAL_EFFECTS;
  const signature = JSON.stringify(effects);
  const [opacity, setOpacity] = useState(String(effects.opacity));
  const [emissiveColor, setEmissiveColor] = useState<string>(effects.emissive.color);
  const [emissiveIntensity, setEmissiveIntensity] = useState(String(effects.emissive.intensity));
  const [glowColor, setGlowColor] = useState<string>(effects.glow.color);
  const [glowIntensity, setGlowIntensity] = useState(String(effects.glow.intensity));
  const [glowSpread, setGlowSpread] = useState(String(effects.glow.spread));
  const [error, setError] = useState<string>();

  useEffect(() => {
    setOpacity(String(effects.opacity));
    setEmissiveColor(effects.emissive.color);
    setEmissiveIntensity(String(effects.emissive.intensity));
    setGlowColor(effects.glow.color);
    setGlowIntensity(String(effects.glow.intensity));
    setGlowSpread(String(effects.glow.spread));
    setError(undefined);
    // The signature is the stable primitive representation of this object.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [component.id, signature]);

  const locked = component.locks.visualEffects === true || !onApply;
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const parsed = {
      opacity: Number(opacity),
      emissiveIntensity: Number(emissiveIntensity),
      glowIntensity: Number(glowIntensity),
      glowSpread: Number(glowSpread),
    };
    if (!inRange(parsed.opacity, 0, 1)
      || !inRange(parsed.emissiveIntensity, 0, 8)
      || !inRange(parsed.glowIntensity, 0, 4)
      || !inRange(parsed.glowSpread, 0, 1)) {
      setError("Use opacity 0–1, emissive 0–8, glow 0–4, and spread 0–1.");
      return;
    }
    setError(undefined);
    onApply?.({
      componentId: component.id,
      visualEffects: {
        opacity: parsed.opacity,
        emissive: { color: emissiveColor.toUpperCase() as `#${string}`, intensity: parsed.emissiveIntensity },
        glow: { color: glowColor.toUpperCase() as `#${string}`, intensity: parsed.glowIntensity, spread: parsed.glowSpread },
      },
    });
  };
  const reset = () => {
    setOpacity("1");
    setEmissiveColor("#FFFFFF");
    setEmissiveIntensity("0");
    setGlowColor("#68D5FF");
    setGlowIntensity("0");
    setGlowSpread("0.5");
    setError(undefined);
  };

  return (
    <section className="workspace-inspector__effects" aria-labelledby={`${formId}-heading`}>
      <h3 id={`${formId}-heading`}>Visual effects</h3>
      <p className="workspace-inspector__hint">Whole-object opacity, emission, and semantic glow.</p>
      <form onSubmit={submit} noValidate>
        <label htmlFor={`${formId}-opacity`}>Object opacity <output>{opacity}</output></label>
        <input id={`${formId}-opacity`} type="range" min="0" max="1" step="0.01" value={opacity} disabled={locked} onChange={(event) => setOpacity(event.target.value)} />
        <div className="workspace-inspector__effects-grid">
          <label htmlFor={`${formId}-emissive-color`}><span>Emission color</span><input id={`${formId}-emissive-color`} type="color" value={emissiveColor} disabled={locked} onChange={(event) => setEmissiveColor(event.target.value)} /></label>
          <label htmlFor={`${formId}-emissive-intensity`}><span>Emission</span><input id={`${formId}-emissive-intensity`} type="number" min="0" max="8" step="0.1" value={emissiveIntensity} disabled={locked} onChange={(event) => setEmissiveIntensity(event.target.value)} /></label>
          <label htmlFor={`${formId}-glow-color`}><span>Glow color</span><input id={`${formId}-glow-color`} type="color" value={glowColor} disabled={locked} onChange={(event) => setGlowColor(event.target.value)} /></label>
          <label htmlFor={`${formId}-glow-intensity`}><span>Glow</span><input id={`${formId}-glow-intensity`} type="number" min="0" max="4" step="0.1" value={glowIntensity} disabled={locked} onChange={(event) => setGlowIntensity(event.target.value)} /></label>
          <label htmlFor={`${formId}-glow-spread`}><span>Spread</span><input id={`${formId}-glow-spread`} type="number" min="0" max="1" step="0.05" value={glowSpread} disabled={locked} onChange={(event) => setGlowSpread(event.target.value)} /></label>
        </div>
        {error && <p className="workspace-inspector__error" role="alert">{error}</p>}
        <div className="workspace-inspector__effects-actions">
          <button type="submit" disabled={locked}>Apply effects</button>
          <button type="button" disabled={locked} onClick={reset}>Reset fields</button>
        </div>
      </form>
      {component.locks.visualEffects && <p className="workspace-inspector__hint">Visual effects are locked for this component.</p>}
    </section>
  );
}

function inRange(value: number, min: number, max: number): boolean {
  return Number.isFinite(value) && value >= min && value <= max;
}

type ResizeField = "width" | "height" | "depth" | "x" | "y" | "z";
type ResizeFieldValues = Record<ResizeField, string>;

const EMPTY_RESIZE_FIELDS: ResizeFieldValues = {
  width: "",
  height: "",
  depth: "",
  x: "",
  y: "",
  z: "",
};

function ResizeInspectorEditor({
  component,
  policy,
  onResize,
}: Readonly<{
  component: WorkspaceRenderComponent;
  policy: Exclude<ComponentResizePolicy, { kind: "none" }>;
  onResize?: (request: WorkspaceComponentResizeRequest) => void;
}>) {
  const formId = useId();
  const initialValues = resizeFieldValues(component, policy);
  const initialSignature = Object.values(initialValues).join("|");
  const [values, setValues] = useState<ResizeFieldValues>(initialValues);
  const [error, setError] = useState<string>();

  useEffect(() => {
    setValues(initialValues);
    setError(undefined);
    // Geometry fields are primitive values represented by this stable token.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [component.id, policy.kind, initialSignature]);

  const locked = component.locks.placement || component.locks.resize || !onResize;
  const fields = resizeFieldsForPolicy(policy);
  const setField = (field: ResizeField, value: string) => {
    setValues((current) => synchronizeResizeFields({ ...current, [field]: value }, field, policy));
    setError(undefined);
  };
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const result = resizeFromFields(values, policy);
    if (!result.ok) {
      setError(result.message);
      return;
    }
    setError(undefined);
    onResize?.({ componentId: component.id, resize: result.resize });
  };

  return (
    <section className="workspace-inspector__resize" aria-labelledby={`${formId}-heading`}>
      <h3 id={`${formId}-heading`}>Size</h3>
      <p id={`${formId}-hint`} className="workspace-inspector__hint">
        Exact {resizeUnitLabel(policy)}. {resizeModeLabel(policy)}
      </p>
      <form onSubmit={submit} noValidate aria-describedby={`${formId}-hint`}>
        <div className="workspace-inspector__dimension-grid">
          {fields.map((field) => {
            const range = resizeFieldRange(policy, field);
            return (
              <label key={field} htmlFor={`${formId}-${field}`}>
                <span>{resizeFieldLabel(field)}</span>
                <input
                  id={`${formId}-${field}`}
                  type="number"
                  inputMode="decimal"
                  min={range.min}
                  max={range.max}
                  step={policy.kind === "box2d" ? 1 : .01}
                  value={values[field]}
                  disabled={locked || !isResizeFieldAllowed(policy, field)}
                  onChange={(event) => setField(field, event.target.value)}
                />
              </label>
            );
          })}
        </div>
        {error && <p className="workspace-inspector__error" role="alert">{error}</p>}
        <button type="submit" disabled={locked}>Apply size</button>
      </form>
      {locked && (
        <p className="workspace-inspector__hint">
          {component.locks.placement || component.locks.resize
            ? "Resizing is locked for this component."
            : "Resize controls are unavailable."}
        </p>
      )}
    </section>
  );
}

function VideoPlayerInspectorEditor({
  component,
  onUpdate,
}: Readonly<{
  component: WorkspaceRenderComponent;
  onUpdate?: (request: WorkspaceComponentUpdateRequest) => boolean | void;
}>) {
  const formId = useId();
  const sourceFromComponent = stringValue(component.props.sourceUrl);
  const titleFromComponent = stringValue(component.props.title) || component.label;
  const captionFromComponent = stringValue(component.props.caption);
  const kindFromComponent = videoSourceKind(component.props.sourceKind);
  const [sourceUrl, setSourceUrl] = useState(sourceFromComponent);
  const [sourceKind, setSourceKind] = useState<VideoSourceKind>(kindFromComponent);
  const [title, setTitle] = useState(titleFromComponent);
  const [caption, setCaption] = useState(captionFromComponent);
  const [controls, setControls] = useState(component.props.controls !== false);
  const [autoplay, setAutoplay] = useState(component.props.autoplay === true);
  const [muted, setMuted] = useState(component.props.muted !== false);
  const [loop, setLoop] = useState(component.props.loop === true);
  const [allowFullscreen, setAllowFullscreen] = useState(component.props.allowFullscreen !== false);
  const [error, setError] = useState<string>();

  useEffect(() => {
    setSourceUrl(sourceFromComponent);
    setSourceKind(kindFromComponent);
    setTitle(titleFromComponent);
    setCaption(captionFromComponent);
    setControls(component.props.controls !== false);
    setAutoplay(component.props.autoplay === true);
    setMuted(component.props.muted !== false);
    setLoop(component.props.loop === true);
    setAllowFullscreen(component.props.allowFullscreen !== false);
    setError(undefined);
  }, [
    captionFromComponent,
    component.id,
    component.props.allowFullscreen,
    component.props.autoplay,
    component.props.controls,
    component.props.loop,
    component.props.muted,
    kindFromComponent,
    sourceFromComponent,
    titleFromComponent,
  ]);

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const trimmedSource = sourceUrl.trim();
    const trimmedTitle = title.trim();
    if (!trimmedTitle) {
      setError("Give this player a title before saving.");
      return;
    }
    const resolved = resolveVideoSource(trimmedSource, sourceKind);
    if (!resolved.ok) {
      setError(resolved.reason);
      return;
    }
    setError(undefined);
    onUpdate?.({
      componentId: component.id,
      label: trimmedTitle,
      props: {
        sourceUrl: trimmedSource,
        sourceKind,
        title: trimmedTitle,
        caption: caption.trim(),
        controls,
        autoplay,
        muted,
        loop,
        allowFullscreen,
      },
    });
  };

  const locked = component.locks.props === true || !onUpdate;
  return (
    <section className="workspace-inspector__editor" aria-labelledby={`${formId}-heading`}>
      <h3 id={`${formId}-heading`}>Player setup</h3>
      <p className="workspace-inspector__hint">
        Paste a YouTube, Vimeo, or direct HTTPS video URL. The player loads only when requested.
      </p>
      <form onSubmit={submit} noValidate>
        <label htmlFor={`${formId}-source`}>Video source URL</label>
        <input
          id={`${formId}-source`}
          type="text"
          inputMode="url"
          autoComplete="off"
          spellCheck={false}
          value={sourceUrl}
          disabled={locked}
          onChange={(event) => {
            setSourceUrl(event.target.value);
            setSourceKind("auto");
          }}
        />
        <label htmlFor={`${formId}-kind`}>Source type</label>
        <select
          id={`${formId}-kind`}
          value={sourceKind}
          disabled={locked}
          onChange={(event) => setSourceKind(videoSourceKind(event.target.value))}
        >
          <option value="auto">Detect automatically</option>
          <option value="youtube">YouTube</option>
          <option value="vimeo">Vimeo</option>
          <option value="direct">Direct media</option>
        </select>
        <label htmlFor={`${formId}-title`}>Player title</label>
        <input
          id={`${formId}-title`}
          type="text"
          maxLength={2_000}
          value={title}
          disabled={locked}
          onChange={(event) => setTitle(event.target.value)}
        />
        <label htmlFor={`${formId}-caption`}>Caption <span>(optional)</span></label>
        <textarea
          id={`${formId}-caption`}
          maxLength={10_000}
          value={caption}
          disabled={locked}
          onChange={(event) => setCaption(event.target.value)}
        />
        <fieldset disabled={locked}>
          <legend>Playback options</legend>
          <label><input type="checkbox" checked={controls} onChange={(event) => setControls(event.target.checked)} />Show controls</label>
          <label><input type="checkbox" checked={muted} onChange={(event) => setMuted(event.target.checked)} />Start muted</label>
          <label><input type="checkbox" checked={autoplay} onChange={(event) => setAutoplay(event.target.checked)} />Autoplay after Load video</label>
          <label><input type="checkbox" checked={loop} onChange={(event) => setLoop(event.target.checked)} />Loop</label>
          <label><input type="checkbox" checked={allowFullscreen} onChange={(event) => setAllowFullscreen(event.target.checked)} />Allow fullscreen</label>
        </fieldset>
        <p className="workspace-inspector__privacy">
          This URL is saved in the project. Do not paste private tokens, cookies, or signed credentials.
        </p>
        {error && <p className="workspace-inspector__error" role="alert">{error}</p>}
        <button type="submit" disabled={locked}>Save player</button>
      </form>
    </section>
  );
}

function WebPanelInspectorEditor({
  component,
  onUpdate,
}: Readonly<{
  component: WorkspaceRenderComponent;
  onUpdate?: (request: WorkspaceComponentUpdateRequest) => boolean | void;
}>) {
  const formId = useId();
  const sourceFromComponent = stringValue(component.props.sourceUrl);
  const titleFromComponent = stringValue(component.props.title) || component.label;
  const [sourceUrl, setSourceUrl] = useState(sourceFromComponent);
  const [title, setTitle] = useState(titleFromComponent);
  const [error, setError] = useState<string>();

  useEffect(() => {
    setSourceUrl(sourceFromComponent);
    setTitle(titleFromComponent);
    setError(undefined);
  }, [component.id, sourceFromComponent, titleFromComponent]);

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const trimmedTitle = title.trim();
    if (!trimmedTitle) {
      setError("Give this website panel a title before saving.");
      return;
    }
    const resolved = resolveWebPanelSource(sourceUrl);
    if (!resolved.ok) {
      setError(resolved.reason);
      return;
    }
    setError(undefined);
    onUpdate?.({
      componentId: component.id,
      label: trimmedTitle,
      props: {
        sourceUrl: resolved.normalizedUrl,
        title: trimmedTitle,
      },
    });
  };

  const locked = component.locks.props === true || !onUpdate;
  return (
    <section className="workspace-inspector__editor" aria-labelledby={`${formId}-heading`}>
      <h3 id={`${formId}-heading`}>Website setup</h3>
      <p className="workspace-inspector__hint">
        Paste a public HTTPS page. Every URL change returns the panel to its unloaded facade.
      </p>
      <form onSubmit={submit} noValidate>
        <label htmlFor={`${formId}-source`}>Website URL</label>
        <input
          id={`${formId}-source`}
          type="text"
          inputMode="url"
          autoComplete="off"
          spellCheck={false}
          value={sourceUrl}
          disabled={locked}
          onChange={(event) => {
            setSourceUrl(event.target.value);
            setError(undefined);
          }}
        />
        <label htmlFor={`${formId}-title`}>Panel title</label>
        <input
          id={`${formId}-title`}
          type="text"
          maxLength={2_000}
          value={title}
          disabled={locked}
          onChange={(event) => {
            setTitle(event.target.value);
            setError(undefined);
          }}
        />
        <p className="workspace-inspector__privacy">
          Do not paste private or signed links. Local hosts, custom ports, and
          recognized credential, token, session, signature, and login-capability
          patterns are rejected. The page loads only after you press Load website
          on the canvas.
        </p>
        {error && <p className="workspace-inspector__error" role="alert">{error}</p>}
        <button type="submit" disabled={locked}>Save website</button>
      </form>
    </section>
  );
}

function resizeFieldValues(
  component: WorkspaceRenderComponent,
  policy: Exclude<ComponentResizePolicy, { kind: "none" }>,
): ResizeFieldValues {
  const next = { ...EMPTY_RESIZE_FIELDS };
  if (policy.kind === "box2d") {
    const size = "size" in component.placement && component.placement.size
      ? component.placement.size
      : policy.defaultSize;
    next.width = formatResizeNumber(size.width);
    next.height = formatResizeNumber(size.height);
    return next;
  }
  if (policy.kind === "scale3d") {
    const scale = component.placement.space === "world3d"
      ? component.placement.scale
      : policy.defaultScale;
    next.x = formatResizeNumber(scale.x);
    next.y = formatResizeNumber(scale.y);
    next.z = formatResizeNumber(scale.z);
    return next;
  }
  const raw = recordValue(component.props.dimensions);
  const dimensions = raw
    && finiteNumber(raw.width) !== undefined
    && finiteNumber(raw.height) !== undefined
    && finiteNumber(raw.depth) !== undefined
    ? {
        width: finiteNumber(raw.width)!,
        height: finiteNumber(raw.height)!,
        depth: finiteNumber(raw.depth)!,
      }
    : policy.defaultDimensions;
  next.width = formatResizeNumber(dimensions.width);
  next.height = formatResizeNumber(dimensions.height);
  next.depth = formatResizeNumber(dimensions.depth);
  return next;
}

function resizeFieldsForPolicy(
  policy: Exclude<ComponentResizePolicy, { kind: "none" }>,
): ResizeField[] {
  if (policy.kind === "box2d") return ["width", "height"];
  if (policy.kind === "scale3d") return ["x", "y", "z"];
  return ["width", "height", "depth"];
}

function resizeFieldRange(
  policy: Exclude<ComponentResizePolicy, { kind: "none" }>,
  field: ResizeField,
): { min: number; max: number } {
  if (policy.kind === "box2d" && (field === "width" || field === "height")) {
    return { min: policy.minSize[field], max: policy.maxSize[field] };
  }
  if (policy.kind === "scale3d" && (field === "x" || field === "y" || field === "z")) {
    return { min: policy.minScale[field], max: policy.maxScale[field] };
  }
  if (policy.kind === "stage_dimensions" && (field === "width" || field === "height" || field === "depth")) {
    return { min: policy.minDimensions[field], max: policy.maxDimensions[field] };
  }
  return { min: 0, max: 0 };
}

function isResizeFieldAllowed(
  policy: Exclude<ComponentResizePolicy, { kind: "none" }>,
  field: ResizeField,
): boolean {
  if (policy.kind === "box2d") {
    return (field === "width" || field === "height") && policy.allowedAxes.includes(field);
  }
  if (policy.kind === "scale3d") {
    return (field === "x" || field === "y" || field === "z") && policy.allowedAxes.includes(field);
  }
  return (field === "width" || field === "height" || field === "depth")
    && policy.allowedAxes.includes(field);
}

function synchronizeResizeFields(
  values: ResizeFieldValues,
  changed: ResizeField,
  policy: Exclude<ComponentResizePolicy, { kind: "none" }>,
): ResizeFieldValues {
  const raw = finiteNumber(values[changed]);
  if (raw === undefined) return values;
  if (policy.kind === "box2d" && policy.mode === "aspect_locked") {
    const ratio = policy.aspectRatio ?? policy.defaultSize.width / policy.defaultSize.height;
    if (changed === "width") values.height = formatResizeNumber(raw / ratio);
    if (changed === "height") values.width = formatResizeNumber(raw * ratio);
  } else if (policy.kind === "scale3d" && policy.mode === "uniform"
    && (changed === "x" || changed === "y" || changed === "z")) {
    values.x = values.y = values.z = formatResizeNumber(raw);
  } else if (policy.kind === "stage_dimensions" && policy.mode === "uniform"
    && (changed === "width" || changed === "height" || changed === "depth")) {
    values.width = values.height = values.depth = formatResizeNumber(raw);
  }
  return values;
}

function resizeFromFields(
  values: ResizeFieldValues,
  policy: Exclude<ComponentResizePolicy, { kind: "none" }>,
): { ok: true; resize: ComponentResize } | { ok: false; message: string } {
  const read = (field: ResizeField) => {
    const value = finiteNumber(values[field]);
    const range = resizeFieldRange(policy, field);
    if (value === undefined || value < range.min || value > range.max) return undefined;
    return value;
  };
  const invalid = (field: ResizeField) => {
    const range = resizeFieldRange(policy, field);
    return `${resizeFieldLabel(field)} must be between ${range.min} and ${range.max} ${policy.units}.`;
  };

  if (policy.kind === "box2d") {
    const width = read("width");
    const height = read("height");
    if (width === undefined) return { ok: false, message: invalid("width") };
    if (height === undefined) return { ok: false, message: invalid("height") };
    const ratio = policy.aspectRatio ?? policy.defaultSize.width / policy.defaultSize.height;
    if (policy.mode === "aspect_locked" && !resizeNumbersNearlyEqual(width / height, ratio)) {
      return { ok: false, message: `Width and height must preserve the ${formatResizeNumber(ratio)}:1 aspect ratio.` };
    }
    return { ok: true, resize: { kind: "box2d", size: { width, height } } };
  }
  if (policy.kind === "scale3d") {
    const x = read("x");
    const y = read("y");
    const z = read("z");
    if (x === undefined) return { ok: false, message: invalid("x") };
    if (y === undefined) return { ok: false, message: invalid("y") };
    if (z === undefined) return { ok: false, message: invalid("z") };
    if (policy.mode === "uniform"
      && (!resizeNumbersNearlyEqual(x, y) || !resizeNumbersNearlyEqual(y, z))) {
      return { ok: false, message: "X, Y, and Z must match for uniform scaling." };
    }
    return { ok: true, resize: { kind: "scale3d", scale: { x, y, z } } };
  }
  const width = read("width");
  const height = read("height");
  const depth = read("depth");
  if (width === undefined) return { ok: false, message: invalid("width") };
  if (height === undefined) return { ok: false, message: invalid("height") };
  if (depth === undefined) return { ok: false, message: invalid("depth") };
  if (policy.mode === "uniform"
    && (!resizeNumbersNearlyEqual(width, height) || !resizeNumbersNearlyEqual(height, depth))) {
    return { ok: false, message: "Width, height, and depth must match for uniform stage dimensions." };
  }
  return { ok: true, resize: { kind: "stage_dimensions", dimensions: { width, height, depth } } };
}

function resizeFieldLabel(field: ResizeField): string {
  return field.length === 1 ? field.toUpperCase() : `${field[0]?.toUpperCase()}${field.slice(1)}`;
}

function resizeUnitLabel(policy: Exclude<ComponentResizePolicy, { kind: "none" }>): string {
  if (policy.units === "px") return "dimensions in pixels";
  if (policy.units === "m") return "dimensions in metres";
  return "scale ratios";
}

function resizeModeLabel(policy: Exclude<ComponentResizePolicy, { kind: "none" }>): string {
  if (policy.mode === "aspect_locked") return "The aspect ratio stays locked.";
  if (policy.mode === "uniform") return "All axes change together.";
  return "Allowed axes can be adjusted independently.";
}

function formatResizeNumber(value: number): string {
  // `String(number)` is the shortest decimal that round-trips to the same
  // IEEE-754 value. Rounding here can turn a valid irrational aspect ratio into
  // geometry the Store rejects, or mutate exact geometry on an unchanged Apply.
  return String(value);
}

const RESIZE_COMPARISON_EPSILON = 1e-6;

function resizeNumbersNearlyEqual(left: number, right: number): boolean {
  return Math.abs(left - right)
    <= RESIZE_COMPARISON_EPSILON * Math.max(1, Math.abs(left), Math.abs(right));
}

function finiteNumber(value: unknown): number | undefined {
  const parsed = typeof value === "number" ? value : typeof value === "string" && value.trim() ? Number(value) : NaN;
  return Number.isFinite(parsed) ? parsed : undefined;
}

function recordValue(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function videoSourceKind(value: unknown): VideoSourceKind {
  return value === "direct" || value === "youtube" || value === "vimeo" ? value : "auto";
}
