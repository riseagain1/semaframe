import type {
  ComponentActionRequest,
  ProjectedComponent,
  WorkspaceComponentTransitions,
  WorkspaceRenderComponent,
} from "../../../workspace/renderer/contracts";
import { recipeForComponent } from "../../../workspace/renderer/contracts";
import type { ComponentRecipe } from "../../../workspace/components/componentTypes";
import type { Box2DResizePolicy, ComponentResizePolicy } from "../../../workspace/components/componentTypes";
import { DEFAULT_COMPONENT_VISUAL_EFFECTS } from "../../../workspace/components/componentTypes";
import type { TransitionSpec } from "../../../workspace/protocol/workspaceTypes";
import { ComponentProjectionBoundary, WorkspaceComponentView } from "./WorkspaceComponentViews";

export type WorkspaceCanvasOverlayProps = Readonly<{
  components: readonly WorkspaceRenderComponent[];
  semanticComponents?: readonly WorkspaceRenderComponent[];
  projections: ReadonlyMap<string, ProjectedComponent>;
  recipes?: readonly ComponentRecipe[];
  selectedId: string | null;
  now?: () => number;
  onSelect?: (componentId: string) => void;
  onActivate?: (componentId: string) => void;
  onAction?: (request: ComponentActionRequest) => void;
  onProjectionError?: (componentId: string, error: Error) => void;
  getResizePolicy?: (component: WorkspaceRenderComponent) => ComponentResizePolicy | undefined;
  resizeAnnouncement?: string;
  transitions?: WorkspaceComponentTransitions;
  presence?: ReadonlyMap<string, "entering" | "exiting">;
}>;

/** Accessible DOM/SVG projection layer rendered above the Three.js canvas. */
export function WorkspaceCanvasOverlay({
  components,
  semanticComponents = components,
  projections,
  recipes = [],
  selectedId,
  now,
  onSelect,
  onActivate,
  onAction,
  onProjectionError,
  getResizePolicy,
  resizeAnnouncement,
  transitions = new Map(),
  presence = new Map(),
}: WorkspaceCanvasOverlayProps) {
  const ordered = [...components].sort((left, right) => {
    const leftZ = projections.get(left.id)?.zIndex ?? 0;
    const rightZ = projections.get(right.id)?.zIndex ?? 0;
    return leftZ - rightZ || left.id.localeCompare(right.id);
  });

  return (
    <div className="workspace-canvas-overlay" data-testid="workspace-canvas-overlay">
      {ordered.map((component) => {
        const projection = projections.get(component.id);
        if (!projection || projection.spatialOnly || component.visibility !== "visible") return null;
        const selected = selectedId === component.id;
        const presencePhase = presence.get(component.id);
        const resizePolicy = getResizePolicy?.(component);
        const canResize = selected
          && resizePolicy?.kind === "box2d"
          && supportsDirectResizeHandles(component, projection)
          && !component.locks.placement
          && !component.locks.resize;
        const rotation = component.placement.space === "canvas2d" ? component.placement.rotationDeg ?? 0 : 0;
        const effects = component.visualEffects ?? DEFAULT_COMPONENT_VISUAL_EFFECTS;
        const interactive = presencePhase !== "exiting" && projection.visible && effects.opacity > 0.001;
        const glowRadius = 8 + effects.glow.spread * 36;
        const glowAlpha = Math.min(0.9, effects.glow.intensity * 0.2);
        const emissiveAlpha = Math.min(0.8, effects.emissive.intensity * 0.08);
        const transitionSpec = component.placement.space === "canvas2d"
          || component.placement.space === "viewport"
          ? transitions.get(component.id)
          : undefined;
        const effectShadows = [
          "0 14px 42px rgba(0, 0, 0, 0.32)",
          ...(emissiveAlpha > 0
            ? [`inset 0 0 ${Math.round(8 + effects.emissive.intensity * 3)}px ${hexAlpha(effects.emissive.color, emissiveAlpha)}`]
            : []),
          ...(glowAlpha > 0
            ? [`0 0 ${Math.round(glowRadius)}px ${Math.round(glowRadius * 0.24)}px ${hexAlpha(effects.glow.color, glowAlpha)}`]
            : []),
        ].join(", ");
        return (
          <div
            key={`${component.id}:${component.instanceRevision ?? "legacy"}`}
            className={`workspace-projected-component${selected ? " is-selected" : ""}`}
            data-workspace-component-id={component.id}
            data-workspace-component-label={component.label}
            data-workspace-component-type={component.type.typeId}
            data-workspace-placement={component.placement.space}
            data-workspace-draggable={component.locks.placement ? "false" : "true"}
            data-workspace-resizable={canResize ? "true" : "false"}
            data-workspace-presence={presencePhase}
            data-preview={undefined}
            role="region"
            aria-label={`${component.label}, ${component.type.typeId} component`}
            aria-current={selected ? "true" : undefined}
            aria-hidden={interactive ? undefined : true}
            tabIndex={interactive ? 0 : -1}
            onFocus={() => onSelect?.(component.id)}
            onPointerDown={() => onSelect?.(component.id)}
            onDoubleClick={(event) => {
              const target = event.target instanceof Element ? event.target : null;
              if (!target?.closest("button, input, textarea, select, option, a, [role='button'], [contenteditable='true']")) {
                onActivate?.(component.id);
              }
            }}
            onKeyDown={(event) => {
              if (event.currentTarget !== event.target || (event.key !== "Enter" && event.key !== " ")) return;
              event.preventDefault();
              onActivate?.(component.id);
            }}
            style={{
              position: "absolute",
              left: `${projection.left}px`,
              top: `${projection.top}px`,
              width: `${projection.width}px`,
              height: `${projection.height}px`,
              zIndex: projection.zIndex,
              visibility: projection.visible ? "visible" : "hidden",
              pointerEvents: interactive ? "auto" : "none",
              opacity: presencePhase === "exiting" ? 0 : effects.opacity,
              boxShadow: effectShadows,
              transform: [
                rotation ? `rotate(${rotation}deg)` : "",
                presencePhase === "exiting" ? "scale(0.98)" : "",
              ].filter(Boolean).join(" ") || undefined,
              transformOrigin: "center",
              transition: transitionSpec ? componentTransitionCSS(transitionSpec) : undefined,
            }}
          >
            <div className="workspace-projected-component__content">
              <ComponentProjectionBoundary
                component={component}
                onError={(error) => onProjectionError?.(component.id, error)}
              >
                <WorkspaceComponentView
                  component={component}
                  recipe={recipeForComponent(component, recipes)}
                  now={now}
                  onAction={onAction}
                />
              </ComponentProjectionBoundary>
            </div>
            {canResize && <ResizeHandles component={component} policy={resizePolicy} />}
          </div>
        );
      })}

      <div className="workspace-component-tree" role="tree" aria-label="Workspace components">
        {semanticComponents.map((component) => {
          const selected = selectedId === component.id;
          return (
            <div
              role="treeitem"
              aria-selected={selected}
              aria-label={`${component.label}, ${component.type.typeId}, ${component.visibility}`}
              key={component.id}
            >
              <button
                type="button"
                data-workspace-component-id={component.id}
                data-workspace-draggable="false"
                onClick={() => onSelect?.(component.id)}
              >
                {component.label}
              </button>
            </div>
          );
        })}
      </div>
      <p className="workspace-resize-announcer" aria-live="polite" aria-atomic="true">
        {resizeAnnouncement}
      </p>
    </div>
  );
}

function componentTransitionCSS(transition: TransitionSpec): string {
  const easing = {
    linear: "linear",
    ease_in: "ease-in",
    ease_out: "ease-out",
    ease_in_out: "ease-in-out",
  }[transition.easing];
  const delay = transition.delayMs ?? 0;
  return ["left", "top", "width", "height", "opacity", "box-shadow", "transform"]
    .map((property) => `${property} ${transition.durationMs}ms ${easing} ${delay}ms`)
    .join(", ");
}

function hexAlpha(color: string, alpha: number): string {
  const value = /^#([0-9a-f]{6})$/iu.exec(color)?.[1];
  if (!value) return `rgba(255, 255, 255, ${alpha})`;
  return `rgba(${Number.parseInt(value.slice(0, 2), 16)}, ${Number.parseInt(value.slice(2, 4), 16)}, ${Number.parseInt(value.slice(4, 6), 16)}, ${alpha})`;
}

/**
 * Edge handles promise that the opposite projected edge stays fixed. That is
 * exact for authored 2D and viewport coordinates only. Camera-projected boxes
 * (surface, billboard, world3d) and responsive viewport projections use the
 * Inspector's exact numeric resize instead of a misleading direct affordance.
 */
function supportsDirectResizeHandles(
  component: WorkspaceRenderComponent,
  projection: ProjectedComponent,
): boolean {
  if (component.placement.space === "canvas2d") return true;
  if (component.placement.space !== "viewport") return false;
  const authored = component.placement.size;
  if (!authored) return true;
  return Math.abs(authored.width - projection.width) < 0.5
    && Math.abs(authored.height - projection.height) < 0.5;
}

type ResizeDirection = "n" | "ne" | "e" | "se" | "s" | "sw" | "w" | "nw";

const RESIZE_DIRECTION_LABELS: Readonly<Record<ResizeDirection, string>> = {
  n: "top",
  ne: "top right",
  e: "right",
  se: "bottom right",
  s: "bottom",
  sw: "bottom left",
  w: "left",
  nw: "top left",
};

function ResizeHandles({
  component,
  policy,
}: Readonly<{
  component: WorkspaceRenderComponent;
  policy: Box2DResizePolicy;
}>) {
  return (
    <div className="workspace-resize-handles" aria-label={`Resize ${component.label}`}>
      {resizeDirections(policy).map((direction) => (
        <button
          key={direction}
          type="button"
          className={`workspace-resize-handle is-${direction}`}
          data-workspace-resize-handle={direction}
          data-no-canvas-drag="true"
          aria-label={`Resize ${component.label} from ${RESIZE_DIRECTION_LABELS[direction]}`}
          title={`Drag to resize. Arrow keys resize by 8 ${policy.units}; Shift+Arrow by 24.`}
        />
      ))}
    </div>
  );
}

function resizeDirections(policy: Box2DResizePolicy): ResizeDirection[] {
  const width = policy.allowedAxes.includes("width");
  const height = policy.allowedAxes.includes("height");
  if (!width && !height) return [];
  if (policy.mode === "aspect_locked") return ["ne", "se", "sw", "nw"];
  if (width && height) return ["n", "ne", "e", "se", "s", "sw", "w", "nw"];
  return width ? ["e", "w"] : ["n", "s"];
}
