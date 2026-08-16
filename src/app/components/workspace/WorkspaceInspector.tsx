import { useEffect, useId, useState, type FormEvent } from "react";
import { DEFAULT_COMPONENT_VISUAL_EFFECTS } from "../../../workspace/components";
import { DEFAULT_ASSET_REGISTRY } from "../../../assets/AssetRegistry";
import type {
  ComponentResize,
  ComponentResizePolicy,
  ComponentVisualEffects,
  JSONObject,
} from "../../../workspace/components";
import type { ComponentActionRequest, WorkspaceRenderComponent } from "../../../workspace/renderer/contracts";
import { resolveVideoSource, type VideoSourceKind } from "./VideoPlayerView";
import { resolveWebPanelSource } from "./WebPanelView";
import { parseSpatialCollisionConfig } from "../../../workspace/spatial";
import {
  DEFAULT_SPATIAL_PHYSICS,
  parseSpatialPhysicsConfig,
  type PhysicsBodyReport,
} from "../../../workspace/physics";

export type WorkspaceComponentUpdateRequest = Readonly<{
  componentId: string;
  label?: string;
  props: JSONObject;
}>;

export type WorkspaceComponentResizeRequest = Readonly<{
  componentId: string;
  resize: ComponentResize;
}>;

export type WorkspaceComponentVisualEffectsRequest = Readonly<{
  componentId: string;
  visualEffects: ComponentVisualEffects;
}>;

export type WorkspaceComponentManifestUpgrade = Readonly<{
  fromVersion: string;
  toVersion: string;
}>;

export type WorkspaceInspectorProps = Readonly<{
  component?: WorkspaceRenderComponent;
  onAction?: (request: ComponentActionRequest) => void;
  onUpdate?: (request: WorkspaceComponentUpdateRequest) => void;
  resizePolicy?: ComponentResizePolicy;
  onResize?: (request: WorkspaceComponentResizeRequest) => void;
  onVisualEffects?: (request: WorkspaceComponentVisualEffectsRequest) => void;
  manifestUpgrade?: WorkspaceComponentManifestUpgrade;
  onUpgradeManifest?: (componentId: string) => void;
  physicsReport?: PhysicsBodyReport;
}>;

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
}: WorkspaceInspectorProps) {
  if (!component) {
    return (
      <aside className="workspace-side-panel workspace-inspector" aria-label="Inspector">
        <header><span>Inspector</span></header>
        <p className="workspace-empty-copy">Select a component to inspect it.</p>
      </aside>
    );
  }
  const timerActions = component.type.typeId === "timer"
    ? ["start", "pause", "resume", "reset"]
    : [];
  return (
    <aside className="workspace-side-panel workspace-inspector" aria-label={`Inspector for ${component.label}`}>
      <header>
        <span>Inspector</span>
        <strong>{component.label}</strong>
      </header>
      <dl>
        <div><dt>Type</dt><dd>{component.type.typeId}</dd></div>
        <div><dt>Placement</dt><dd>{component.placement.space}</dd></div>
        <div><dt>Version</dt><dd>{component.type.version}</dd></div>
        <div><dt>Visibility</dt><dd>{component.visibility}</dd></div>
      </dl>
      {manifestUpgrade && (
        <section className="workspace-inspector__upgrade" aria-label="Component interaction upgrade">
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
        </section>
      )}
      {resizePolicy && resizePolicy.kind !== "none" && (
        <ResizeInspectorEditor component={component} policy={resizePolicy} onResize={onResize} />
      )}
      {component.type.typeId === "spatial-entity" && Boolean(component.props.collision) && (
        <CollisionInspectorEditor component={component} onUpdate={onUpdate} />
      )}
      {component.type.typeId === "spatial-entity" && Boolean(component.props.physics) && (
        <PhysicsInspectorEditor component={component} onUpdate={onUpdate} report={physicsReport} />
      )}
      <VisualEffectsInspectorEditor component={component} onApply={onVisualEffects} />
      {component.type.typeId === "video-player" && (
        <VideoPlayerInspectorEditor component={component} onUpdate={onUpdate} />
      )}
      {component.type.typeId === "web-panel" && (
        <WebPanelInspectorEditor component={component} onUpdate={onUpdate} />
      )}
      {timerActions.length > 0 && (
        <section>
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
        </section>
      )}
      <details>
        <summary>Properties</summary>
        <pre>{JSON.stringify(component.props, null, 2)}</pre>
      </details>
      <details>
        <summary>Durable state</summary>
        <pre>{JSON.stringify(component.durableState, null, 2)}</pre>
      </details>
    </aside>
  );
}

function CollisionInspectorEditor({
  component,
  onUpdate,
}: Readonly<{
  component: WorkspaceRenderComponent;
  onUpdate?: (request: WorkspaceComponentUpdateRequest) => void;
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
  const scale = component.placement.space === "world3d"
    ? component.placement.scale
    : { x: 1, y: 1, z: 1 };
  const parsedMargin = Number(margin);
  const effectiveSize = shape === "asset_bounds" && asset && Number.isFinite(parsedMargin)
    ? {
      x: asset.bounds.width * Math.abs(scale.x) + parsedMargin * 2,
      y: asset.bounds.height * Math.abs(scale.y) + parsedMargin * 2,
      z: asset.bounds.depth * Math.abs(scale.z) + parsedMargin * 2,
    }
    : undefined;
  const locked = component.locks.props || !onUpdate;
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!inRange(parsedMargin, 0, 10)) {
      setError("Collision margin must be between 0 and 10 meters.");
      return;
    }
    let rawParts: unknown;
    if (shape === "compound") {
      try { rawParts = JSON.parse(parts) as unknown; } catch {
        setError("Compound parts must be valid JSON.");
        return;
      }
    }
    const candidate = shape === "asset_bounds"
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
      <p className="workspace-inspector__hint">
        Use asset bounds, one explicit oriented box, or up to 16 compound box parts.
      </p>
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
          <span>Enabled</span>
        </label>
        <label htmlFor={`${formId}-role`}><span>Role</span>
          <select id={`${formId}-role`} value={role} disabled={locked} onChange={(event) => setRole(event.target.value as typeof role)}>
            <option value="solid">Solid · blocks overlap</option>
            <option value="trigger">Trigger · detects only</option>
            <option value="none">None · ignored</option>
          </select>
        </label>
        <label htmlFor={`${formId}-shape`}><span>Shape</span>
          <select id={`${formId}-shape`} value={shape} disabled={locked} onChange={(event) => setShape(event.target.value as typeof shape)}>
            <option value="asset_bounds">Asset bounds</option>
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
}: Readonly<{
  component: WorkspaceRenderComponent;
  onUpdate?: (request: WorkspaceComponentUpdateRequest) => void;
  report?: PhysicsBodyReport;
}>) {
  const formId = useId();
  const parsed = parseSpatialPhysicsConfig(component.props.physics) ?? DEFAULT_SPATIAL_PHYSICS;
  const signature = JSON.stringify(parsed);
  const supportsMasterSwitch = Number(component.type.version.split(".")[0]) > 1
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
    </dl> : <p className="workspace-inspector__hint">Support and COM feasibility updates from the authoritative Workspace state.</p>}
    <form onSubmit={submit} noValidate>
      <label className="workspace-inspector__check" htmlFor={`${formId}-enabled`}>
        <input id={`${formId}-enabled`} type="checkbox" checked={enabled} disabled={locked || !supportsMasterSwitch} onChange={(event) => setEnabled(event.target.checked)} />
        <span>Physics enabled</span>
      </label>
      {!supportsMasterSwitch && <p className="workspace-inspector__hint">Upgrade this component to 1.5 to use the physics master switch.</p>}
      <label htmlFor={`${formId}-body`}><span>Body type</span><select id={`${formId}-body`} value={bodyType} disabled={locked || !enabled} onChange={(event) => setBodyType(event.target.value as typeof bodyType)}><option value="static">Static</option><option value="dynamic">Dynamic</option><option value="kinematic">Kinematic</option></select></label>
      <label htmlFor={`${formId}-mass`}><span>Mass (kg)</span><input id={`${formId}-mass`} type="number" min="0.001" max="1000000" step="0.1" value={massKg} disabled={locked || !enabled} onChange={(event) => setMassKg(event.target.value)} /></label>
      <fieldset disabled={locked || !enabled}><legend>COM offset (m)</legend>{(["X", "Y", "Z"] as const).map((axis, index) => <label key={axis}><span>{axis}</span><input type="number" step="0.01" value={centerOfMass[index]} onChange={(event) => setCenterOfMass((current) => current.map((value, item) => item === index ? event.target.value : value))} /></label>)}</fieldset>
      <label htmlFor={`${formId}-friction`}><span>Friction</span><input id={`${formId}-friction`} type="number" min="0" max="2" step="0.05" value={friction} disabled={locked || !enabled} onChange={(event) => setFriction(event.target.value)} /></label>
      <label htmlFor={`${formId}-restitution`}><span>Restitution</span><input id={`${formId}-restitution`} type="number" min="0" max="1" step="0.05" value={restitution} disabled={locked || !enabled} onChange={(event) => setRestitution(event.target.value)} /></label>
      <label htmlFor={`${formId}-gravity`}><span>Gravity scale</span><input id={`${formId}-gravity`} type="number" min="0" max="10" step="0.1" value={gravityScale} disabled={locked || !enabled} onChange={(event) => setGravityScale(event.target.value)} /></label>
      <label htmlFor={`${formId}-stability`}><span>Stability</span><select id={`${formId}-stability`} value={stabilityMode} disabled={locked || !enabled} onChange={(event) => setStabilityMode(event.target.value as typeof stabilityMode)}><option value="report">Report only</option><option value="enforce">Enforce atomically</option></select></label>
      <label htmlFor={`${formId}-constraints`}><span>Constraints JSON</span><textarea id={`${formId}-constraints`} rows={8} value={constraints} disabled={locked || !enabled} onChange={(event) => setConstraints(event.target.value)} /></label>
      <p className="workspace-inspector__hint">Fixed, hinge, slider, and ball constraints use local anchors. Hinge/slider axes must be normalized.</p>
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
  onUpdate?: (request: WorkspaceComponentUpdateRequest) => void;
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
  onUpdate?: (request: WorkspaceComponentUpdateRequest) => void;
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
