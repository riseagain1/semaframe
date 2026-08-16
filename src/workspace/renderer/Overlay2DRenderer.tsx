import { createRoot, type Root } from "react-dom/client";
import { WorkspaceCanvasOverlay } from "../../app/components/workspace/WorkspaceCanvasOverlay";
import type {
  ComponentActionRequest,
  HybridRendererStatus,
  ProjectedComponent,
  ResizePolicyResolver,
  WorkspaceComponentTransitions,
  WorkspaceRenderComponent,
  WorkspaceRenderSnapshot,
} from "./contracts";

export type Overlay2DRendererOptions = Readonly<{
  now?: () => number;
  onSelect?: (componentId: string) => void;
  onActivate?: (componentId: string) => void;
  onAction?: (request: ComponentActionRequest) => void;
  getResizePolicy?: ResizePolicyResolver;
  onStatus?: (status: HybridRendererStatus) => void;
  reducedMotion?: boolean;
}>;

/** React-backed accessible overlay. It never owns semantic component state. */
export class Overlay2DRenderer {
  private readonly options: Overlay2DRendererOptions;
  private host: HTMLDivElement | null = null;
  private root: Root | null = null;
  private latestSnapshot: WorkspaceRenderSnapshot | null = null;
  private latestProjections: ReadonlyMap<string, ProjectedComponent> = new Map();
  private selectedId: string | null = null;
  private resizeAnnouncement = "";
  private activeTransitions: WorkspaceComponentTransitions = new Map();
  private transitionTimer: number | null = null;
  private reducedMotion = false;
  private reducedMotionQuery: MediaQueryList | null = null;
  private exiting = new Map<string, Readonly<{
    component: WorkspaceRenderComponent;
    projection: ProjectedComponent;
  }>>();
  private presence = new Map<string, "entering" | "exiting">();

  private readonly handleReducedMotionChange = (event: MediaQueryListEvent): void => {
    if (this.reducedMotion === event.matches) return;
    this.reducedMotion = event.matches;
    if (!event.matches) return;
    this.clearTransitionTimer();
    this.activeTransitions = new Map();
    this.exiting.clear();
    this.presence.clear();
    this.renderCurrent();
  };

  constructor(options: Overlay2DRendererOptions = {}) {
    this.options = options;
  }

  initialize(container: HTMLElement): HTMLElement {
    if (this.host) return this.host;
    const host = container.ownerDocument.createElement("div");
    host.className = "workspace-overlay-layer";
    host.setAttribute("data-workspace-overlay-layer", "true");
    Object.assign(host.style, {
      position: "absolute",
      inset: "0",
      overflow: "hidden",
      pointerEvents: "none",
    });
    container.appendChild(host);
    this.host = host;
    this.root = createRoot(host);
    this.reducedMotionQuery = this.options.reducedMotion === undefined
      ? container.ownerDocument.defaultView?.matchMedia?.("(prefers-reduced-motion: reduce)") ?? null
      : null;
    this.reducedMotion = this.options.reducedMotion ?? this.reducedMotionQuery?.matches ?? false;
    this.reducedMotionQuery?.addEventListener?.("change", this.handleReducedMotionChange);
    return host;
  }

  render(
    snapshot: WorkspaceRenderSnapshot,
    projections: ReadonlyMap<string, ProjectedComponent>,
    selectedId = this.selectedId,
    transitions?: WorkspaceComponentTransitions,
  ): void {
    if (!this.root) throw new Error("Overlay2DRenderer must be initialized before render().");
    const previousSnapshot = this.latestSnapshot;
    const previousProjections = this.latestProjections;
    if (transitions) {
      this.setActiveTransitions(transitions, previousSnapshot, previousProjections, snapshot);
    }
    this.latestSnapshot = snapshot;
    this.latestProjections = projections;
    this.selectedId = selectedId;
    this.renderCurrent();
  }

  private renderCurrent(): void {
    const snapshot = this.latestSnapshot;
    if (!this.root || !snapshot) return;
    const componentById = new Map(snapshot.components.map((component) => [component.id, component]));
    const presentationProjections = new Map(this.latestProjections);
    for (const [componentId, exit] of this.exiting) {
      componentById.set(componentId, exit.component);
      presentationProjections.set(componentId, exit.projection);
    }
    this.root.render(
      <WorkspaceCanvasOverlay
        components={[...componentById.values()]}
        semanticComponents={snapshot.components}
        projections={presentationProjections}
        recipes={snapshot.recipes}
        selectedId={this.selectedId}
        now={this.options.now}
        onSelect={this.options.onSelect}
        onActivate={this.options.onActivate}
        onAction={this.options.onAction}
        getResizePolicy={this.options.getResizePolicy}
        resizeAnnouncement={this.resizeAnnouncement}
        transitions={this.activeTransitions}
        presence={this.presence}
        onProjectionError={(componentId, error) => this.options.onStatus?.({
          kind: "projection-warning",
          componentId,
          message: error.message,
        })}
      />,
    );
  }

  setSelection(componentId: string | null): void {
    if (this.selectedId === componentId) return;
    this.selectedId = componentId;
    if (this.latestSnapshot) this.render(this.latestSnapshot, this.latestProjections, componentId);
  }

  announceResize(message: string): void {
    this.resizeAnnouncement = message;
  }

  getElement(): HTMLElement | null {
    return this.host;
  }

  dispose(): void {
    const root = this.root;
    const host = this.host;
    this.clearTransitionTimer();
    this.reducedMotionQuery?.removeEventListener?.("change", this.handleReducedMotionChange);
    this.reducedMotionQuery = null;
    this.root = null;
    this.host = null;
    this.latestSnapshot = null;
    this.latestProjections = new Map();
    this.resizeAnnouncement = "";
    this.activeTransitions = new Map();
    this.exiting.clear();
    this.presence.clear();
    if (!root) {
      host?.remove();
      return;
    }
    // HybridWorkspaceCanvas disposes from a parent React effect cleanup. A
    // synchronous nested-root unmount there races React's active commit and
    // emits a warning (and may skip child cleanup). Defer exactly one
    // microtask, after the parent commit, then cleanly unmount and remove the
    // host. Clearing our references above makes dispose immediately idempotent.
    queueMicrotask(() => {
      root.unmount();
      host?.remove();
    });
  }

  private setActiveTransitions(
    transitions: WorkspaceComponentTransitions,
    previousSnapshot: WorkspaceRenderSnapshot | null,
    previousProjections: ReadonlyMap<string, ProjectedComponent>,
    nextSnapshot: WorkspaceRenderSnapshot,
  ): void {
    this.clearTransitionTimer();
    this.activeTransitions = this.reducedMotion ? new Map() : new Map(transitions);
    this.exiting.clear();
    this.presence.clear();
    if (!this.reducedMotion) {
      const previousById = new Map(previousSnapshot?.components.map((component) => [component.id, component]));
      const nextById = new Map(nextSnapshot.components.map((component) => [component.id, component]));
      for (const componentId of this.activeTransitions.keys()) {
        const previous = previousById.get(componentId);
        const next = nextById.get(componentId);
        if (previous?.visibility === "visible" && next && next.visibility !== "visible") {
          const projection = previousProjections.get(componentId);
          if (projection) {
            this.exiting.set(componentId, { component: previous, projection });
            this.presence.set(componentId, "exiting");
          }
        } else if (next?.visibility === "visible" && previous?.visibility !== "visible") {
          this.presence.set(componentId, "entering");
        }
      }
    }
    if (!this.activeTransitions.size || !this.host) return;
    const longest = Math.max(...[...this.activeTransitions.values()].map(
      (transition) => transition.durationMs + (transition.delayMs ?? 0),
    ));
    const view = this.host.ownerDocument.defaultView;
    if (!view) return;
    this.transitionTimer = view.setTimeout(() => {
      this.transitionTimer = null;
      this.activeTransitions = new Map();
      this.exiting.clear();
      this.presence.clear();
      this.renderCurrent();
    }, longest + 34);
  }

  private clearTransitionTimer(): void {
    if (this.transitionTimer === null) return;
    this.host?.ownerDocument.defaultView?.clearTimeout(this.transitionTimer);
    this.transitionTimer = null;
  }
}
