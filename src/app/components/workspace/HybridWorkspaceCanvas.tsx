import {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useMemo,
  useRef,
} from "react";
import {
  HybridCanvasRenderer,
  type HybridCanvasRendererOptions,
} from "../../../workspace/renderer/HybridCanvasRenderer";
import {
  toRenderSnapshot,
  type AnimationCompletionRequest,
  type ComponentActivationRequest,
  type ComponentActionRequest,
  type HybridRendererStatus,
  type PlacementCommitRequest,
  type PlacementPreview,
  type ResizeCommitRequest,
  type ResizePolicyResolver,
  type ResizePreview,
  type WorkspaceRenderCommit,
  type WorkspaceRenderSnapshot,
  type WorkspaceStateLike,
} from "../../../workspace/renderer/contracts";
import "./workspace.css";

export type HybridWorkspaceCanvasHandle = Readonly<{
  getContainer: () => HTMLDivElement | null;
  getRenderer: () => HybridCanvasRenderer | null;
  resize: () => void;
  frameAll: () => void;
  resetView: () => void;
  zoomIn: () => void;
  zoomOut: () => void;
}>;

export type HybridWorkspaceCanvasProps = Readonly<{
  state: WorkspaceRenderSnapshot | WorkspaceStateLike;
  commit?: WorkspaceRenderCommit;
  selectedId?: string | null;
  className?: string;
  ariaLabel?: string;
  rendererOptions?: Omit<
    HybridCanvasRendererOptions,
    "onSelect" | "onActivate" | "onAnimationComplete" | "onAction" | "onPreviewPlacement" | "onCancelPreview" | "onCommitPlacement"
      | "getResizePolicy" | "onPreviewResize" | "onCancelResize" | "onCommitResize" | "onStatus"
  >;
  onSelect?: (componentId: string | null) => void;
  onActivate?: (request: ComponentActivationRequest) => void | Promise<void>;
  onAnimationComplete?: (request: AnimationCompletionRequest) => void | Promise<void>;
  onAction?: (request: ComponentActionRequest) => void | Promise<void>;
  onPreviewPlacement?: (preview: PlacementPreview) => void;
  onCancelPreview?: (preview: PlacementPreview) => void;
  onCommitPlacement?: (request: PlacementCommitRequest) => void | Promise<void>;
  getResizePolicy?: ResizePolicyResolver;
  onPreviewResize?: (preview: ResizePreview) => void;
  onCancelResize?: (preview: ResizePreview) => void;
  onCommitResize?: (request: ResizeCommitRequest) => void | Promise<void>;
  onStatus?: (status: HybridRendererStatus) => void;
  onRendererReady?: (renderer: HybridCanvasRenderer) => void;
}>;

/**
 * App integration boundary for the universal 2D/3D canvas. The component owns
 * its render layers but every semantic write is returned to the caller.
 */
export const HybridWorkspaceCanvas = forwardRef<HybridWorkspaceCanvasHandle, HybridWorkspaceCanvasProps>(
  function HybridWorkspaceCanvas({
    state,
    commit,
    selectedId,
    className,
    ariaLabel = "Universal 2D and 3D workspace canvas",
    rendererOptions,
    onSelect,
    onActivate,
    onAnimationComplete,
    onAction,
    onPreviewPlacement,
    onCancelPreview,
    onCommitPlacement,
    getResizePolicy,
    onPreviewResize,
    onCancelResize,
    onCommitResize,
    onStatus,
    onRendererReady,
  }, forwardedRef) {
    const containerRef = useRef<HTMLDivElement>(null);
    const rendererRef = useRef<HybridCanvasRenderer | null>(null);
    const readyRef = useRef(false);
    const callbacks = useRef({
      onSelect,
      onActivate,
      onAnimationComplete,
      onAction,
      onPreviewPlacement,
      onCancelPreview,
      onCommitPlacement,
      getResizePolicy,
      onPreviewResize,
      onCancelResize,
      onCommitResize,
      onStatus,
      onRendererReady,
    });
    callbacks.current = {
      onSelect,
      onActivate,
      onAnimationComplete,
      onAction,
      onPreviewPlacement,
      onCancelPreview,
      onCommitPlacement,
      getResizePolicy,
      onPreviewResize,
      onCancelResize,
      onCommitResize,
      onStatus,
      onRendererReady,
    };
    const snapshot = useMemo(() => toRenderSnapshot(state), [state]);
    const initialSnapshotRef = useRef(snapshot);
    const initialCommitRef = useRef(commit);

    useImperativeHandle(forwardedRef, () => ({
      getContainer: () => containerRef.current,
      getRenderer: () => rendererRef.current,
      resize: () => rendererRef.current?.resize(),
      frameAll: () => rendererRef.current?.frameAll(),
      resetView: () => rendererRef.current?.resetView(),
      zoomIn: () => rendererRef.current?.zoomBy(1.2),
      zoomOut: () => rendererRef.current?.zoomBy(1 / 1.2),
    }), []);

    useLayoutEffect(() => {
      const container = containerRef.current;
      if (!container) return;
      let cancelled = false;
      const renderer = new HybridCanvasRenderer({
        ...rendererOptions,
        onSelect: (id) => callbacks.current.onSelect?.(id),
        onActivate: (request) => callbacks.current.onActivate?.(request),
        onAnimationComplete: (request) => callbacks.current.onAnimationComplete?.(request),
        onAction: (request) => callbacks.current.onAction?.(request),
        onPreviewPlacement: (preview) => callbacks.current.onPreviewPlacement?.(preview),
        onCancelPreview: (preview) => callbacks.current.onCancelPreview?.(preview),
        onCommitPlacement: (request) => callbacks.current.onCommitPlacement?.(request),
        getResizePolicy: (component) => callbacks.current.getResizePolicy?.(component),
        onPreviewResize: (preview) => callbacks.current.onPreviewResize?.(preview),
        onCancelResize: (preview) => callbacks.current.onCancelResize?.(preview),
        onCommitResize: (request) => callbacks.current.onCommitResize?.(request),
        onStatus: (status) => callbacks.current.onStatus?.(status),
      });
      rendererRef.current = renderer;
      void renderer.initialize(container).then(async () => {
        if (cancelled) return;
        // State can change while WebGL or an asset initializes. Drain the
        // latest snapshot before publishing readiness so no initial revision
        // is skipped and no later render overlaps the first one.
        for (;;) {
          const pendingSnapshot = initialSnapshotRef.current;
          const pendingCommit = initialCommitRef.current;
          await renderer.render(pendingSnapshot, pendingCommit);
          if (cancelled) return;
          if (pendingSnapshot === initialSnapshotRef.current
            && pendingCommit === initialCommitRef.current) break;
        }
        readyRef.current = true;
        if (cancelled) return;
        if (selectedId !== undefined) renderer.setSelection(selectedId);
        callbacks.current.onRendererReady?.(renderer);
      }).catch((error) => {
        if (!cancelled) callbacks.current.onStatus?.({
          kind: "overlay-error",
          message: error instanceof Error ? error.message : "Workspace canvas could not initialize.",
        });
      });
      return () => {
        cancelled = true;
        readyRef.current = false;
        renderer.dispose();
        if (rendererRef.current === renderer) rendererRef.current = null;
      };
      // A renderer is a canvas lifetime dependency; changing options requires a
      // remount so active Three.js resources are not silently swapped.
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    useEffect(() => {
      if (readyRef.current) {
        void rendererRef.current?.render(snapshot, commit).catch((error) => callbacks.current.onStatus?.({
          kind: "overlay-error",
          message: error instanceof Error ? error.message : "Workspace canvas could not render.",
        }));
      } else {
        initialSnapshotRef.current = snapshot;
        initialCommitRef.current = commit;
      }
    }, [snapshot, commit]);

    useEffect(() => {
      if (selectedId !== undefined && readyRef.current) rendererRef.current?.setSelection(selectedId);
    }, [selectedId]);

    return (
      <div
        ref={containerRef}
        className={`hybrid-workspace-canvas${className ? ` ${className}` : ""}`}
        role="application"
        aria-label={ariaLabel}
      />
    );
  },
);
