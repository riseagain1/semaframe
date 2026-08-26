import { Crosshair, HelpCircle, Maximize2, Minimize2, RotateCcw, X, ZoomIn, ZoomOut } from "lucide-react";
import { forwardRef, useEffect, useRef, useState, type ReactNode } from "react";
import type { WorkspaceHistoryStatus } from "../uiTypes";
import { StatusPill } from "./StatusPill";

export type ViewportProps = {
  status: WorkspaceHistoryStatus;
  entityCount: number;
  revision: number;
  agentControlStatus?: string;
  interactionDisabled?: boolean;
  onFrameAll: () => void;
  onResetView: () => void;
  onZoomIn?: () => void;
  onZoomOut?: () => void;
  xrControl?: ReactNode;
  children?: ReactNode;
};

type FullscreenMode = "off" | "native" | "fallback";

type FullscreenElement = HTMLElement & {
  webkitRequestFullscreen?: () => Promise<void> | void;
};

type FullscreenDocument = Document & {
  webkitFullscreenElement?: Element | null;
  webkitExitFullscreen?: () => Promise<void> | void;
};

function activeFullscreenElement(): Element | null {
  const fullscreenDocument = document as FullscreenDocument;
  return document.fullscreenElement ?? fullscreenDocument.webkitFullscreenElement ?? null;
}

function fullscreenBelongsTo(element: HTMLElement): boolean {
  const active = activeFullscreenElement();
  return active === element || Boolean(active && element.contains(active));
}

function requestElementFullscreen(element: FullscreenElement): Promise<void> | void {
  if (element.requestFullscreen) return element.requestFullscreen();
  return element.webkitRequestFullscreen?.();
}

function exitDocumentFullscreen(): Promise<void> | void {
  const fullscreenDocument = document as FullscreenDocument;
  if (document.exitFullscreen) return document.exitFullscreen();
  return fullscreenDocument.webkitExitFullscreen?.();
}

export const Viewport = forwardRef<HTMLDivElement, ViewportProps>(function Viewport(
  { status, entityCount, revision, agentControlStatus, interactionDisabled = false, onFrameAll, onResetView, onZoomIn, onZoomOut, xrControl, children },
  ref,
) {
  const [showHelp, setShowHelp] = useState(false);
  const [fullscreenMode, setFullscreenModeState] = useState<FullscreenMode>("off");
  const shellRef = useRef<HTMLElement>(null);
  const helpButtonRef = useRef<HTMLButtonElement>(null);
  const helpCloseRef = useRef<HTMLButtonElement>(null);
  const fullscreenButtonRef = useRef<HTMLButtonElement>(null);
  const fullscreenModeRef = useRef<FullscreenMode>("off");
  const fullscreenRequestRef = useRef(0);
  const nativeRequestPendingRef = useRef(false);
  const restoreFocusRef = useRef<HTMLElement | null>(null);
  const isImmersive = fullscreenMode !== "off";

  const setFullscreenMode = (next: FullscreenMode) => {
    fullscreenModeRef.current = next;
    setFullscreenModeState(next);
  };

  const restorePriorFocus = () => {
    const target = restoreFocusRef.current;
    restoreFocusRef.current = null;
    requestAnimationFrame(() => {
      if (target?.isConnected) target.focus({ preventScroll: true });
    });
  };

  const finishFullscreenExit = () => {
    if (fullscreenModeRef.current === "off") return;
    ++fullscreenRequestRef.current;
    nativeRequestPendingRef.current = false;
    setFullscreenMode("off");
    restorePriorFocus();
  };

  const enterFullscreen = async () => {
    const shell = shellRef.current;
    if (!shell || fullscreenModeRef.current !== "off") return;

    const focused = document.activeElement;
    restoreFocusRef.current = focused instanceof HTMLElement ? focused : fullscreenButtonRef.current;
    setShowHelp(false);
    const requestId = ++fullscreenRequestRef.current;
    const fullscreenElement = shell as FullscreenElement;
    const canRequestNative = Boolean(fullscreenElement.requestFullscreen || fullscreenElement.webkitRequestFullscreen);

    if (canRequestNative) {
      nativeRequestPendingRef.current = true;
      try {
        await requestElementFullscreen(fullscreenElement);
        // WebKit can resolve before exposing webkitFullscreenElement. Give its
        // fullscreenchange event one frame before using the CSS fallback.
        await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
        if (requestId !== fullscreenRequestRef.current) return;
        if (fullscreenBelongsTo(shell)) {
          nativeRequestPendingRef.current = false;
          setFullscreenMode("native");
          return;
        }
      } catch {
        // Permission, embedding, and browser-policy failures all retain a
        // complete immersive path through the fixed-position fallback.
      }
    }

    if (requestId !== fullscreenRequestRef.current) return;
    nativeRequestPendingRef.current = false;
    setFullscreenMode("fallback");
  };

  const exitFullscreen = async () => {
    const shell = shellRef.current;
    ++fullscreenRequestRef.current;
    if (fullscreenModeRef.current === "native" && shell && fullscreenBelongsTo(shell)) {
      try {
        await exitDocumentFullscreen();
      } catch {
        // The native fullscreenchange listener remains authoritative. A later
        // browser Escape still completes the exit and restores focus.
      }
      if (!fullscreenBelongsTo(shell)) finishFullscreenExit();
      return;
    }
    finishFullscreenExit();
  };

  useEffect(() => {
    if (showHelp) requestAnimationFrame(() => helpCloseRef.current?.focus());
  }, [showHelp]);
  useEffect(() => {
    if (!interactionDisabled) return;
    setShowHelp(false);
    if (fullscreenModeRef.current !== "off") void exitFullscreen();
  }, [interactionDisabled]);
  useEffect(() => {
    const syncNativeFullscreen = () => {
      const shell = shellRef.current;
      if (shell && fullscreenBelongsTo(shell)
        && (fullscreenModeRef.current === "native" || nativeRequestPendingRef.current)) {
        nativeRequestPendingRef.current = false;
        setFullscreenMode("native");
        return;
      }
      if (fullscreenModeRef.current === "native") finishFullscreenExit();
    };
    document.addEventListener("fullscreenchange", syncNativeFullscreen);
    document.addEventListener("webkitfullscreenchange", syncNativeFullscreen);
    return () => {
      document.removeEventListener("fullscreenchange", syncNativeFullscreen);
      document.removeEventListener("webkitfullscreenchange", syncNativeFullscreen);
      ++fullscreenRequestRef.current;
      nativeRequestPendingRef.current = false;
      if (fullscreenModeRef.current === "native" && shellRef.current && fullscreenBelongsTo(shellRef.current)) {
        void exitDocumentFullscreen();
      }
    };
  }, []);
  useEffect(() => {
    if (!isImmersive) return;
    const handleEscape = (event: globalThis.KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopPropagation();
      void exitFullscreen();
    };
    const containFocus = (event: FocusEvent) => {
      if (fullscreenModeRef.current === "off") return;
      const shell = shellRef.current;
      if (!shell || !(event.target instanceof Node) || shell.contains(event.target)) return;
      requestAnimationFrame(() => {
        if (fullscreenModeRef.current !== "off") fullscreenButtonRef.current?.focus({ preventScroll: true });
      });
    };
    document.addEventListener("keydown", handleEscape, true);
    document.addEventListener("focusin", containFocus, true);
    requestAnimationFrame(() => fullscreenButtonRef.current?.focus({ preventScroll: true }));
    return () => {
      document.removeEventListener("keydown", handleEscape, true);
      document.removeEventListener("focusin", containFocus, true);
    };
  }, [isImmersive]);
  const closeHelp = () => {
    setShowHelp(false);
    requestAnimationFrame(() => helpButtonRef.current?.focus());
  };
  return (
    <main
      ref={shellRef}
      className={`viewport-shell${interactionDisabled ? " is-interaction-disabled" : ""}${isImmersive ? " is-immersive" : ""}${fullscreenMode === "fallback" ? " is-fullscreen-fallback" : ""}`}
      data-fullscreen-mode={fullscreenMode}
      aria-hidden={interactionDisabled || undefined}
      inert={interactionDisabled || undefined}
    >
      <div
        ref={ref}
        className="viewport-canvas"
        tabIndex={children ? -1 : 0}
        role={children ? "region" : "application"}
        aria-label={children
          ? "Interactive hybrid workspace containing 2D components and a 3D scene."
          : "Interactive 3D scene. Drag to orbit, Shift drag to pan, wheel to zoom, and press F to frame all."}
        aria-describedby="viewport-instructions"
      >{children}</div>
      <p id="viewport-instructions" className="sr-only">Select a 3D object with one click. Activate its configured interaction with a double-click, or select it and press Enter or Space. A text alternative describing the environment, components, and relations is available in the Workspace component tree.</p>
      <div className="viewport-topline">
        <StatusPill status={status} />
        {agentControlStatus && <span className="agent-control-chip" role="status"><span aria-hidden="true" />Agent · {agentControlStatus}</span>}
        <div className="scene-stat" aria-label={`${entityCount} components, workspace revision ${revision}`}>
          <span>{entityCount} {entityCount === 1 ? "component" : "components"}</span><i /> <span>rev {revision}</span>
        </div>
      </div>
      <div className="viewport-tools" aria-label="Camera controls">
        <button type="button" onClick={onFrameAll} title="Frame all (F)" aria-label="Frame all"><Crosshair size={17} /></button>
        {onZoomIn && <button type="button" onClick={onZoomIn} title="Zoom in (+)" aria-label="Zoom in"><ZoomIn size={17} /></button>}
        {onZoomOut && <button type="button" onClick={onZoomOut} title="Zoom out (-)" aria-label="Zoom out"><ZoomOut size={17} /></button>}
        <button type="button" onClick={onResetView} title="Reset view" aria-label="Reset view"><RotateCcw size={16} /></button>
        <button ref={helpButtonRef} type="button" onClick={() => setShowHelp((value) => !value)} title="Camera controls" aria-label="Camera controls" aria-expanded={showHelp} aria-controls="viewport-help"><HelpCircle size={17} /></button>
        {xrControl}
        <button
          ref={fullscreenButtonRef}
          type="button"
          className="viewport-fullscreen-toggle"
          onClick={() => { if (isImmersive) void exitFullscreen(); else void enterFullscreen(); }}
          title={isImmersive ? "Exit full screen (Esc)" : "Enter full screen"}
          aria-label={isImmersive ? "Exit full screen" : "Enter full screen"}
          aria-pressed={isImmersive}
        >
          {isImmersive ? <Minimize2 size={17} aria-hidden="true" /> : <Maximize2 size={17} aria-hidden="true" />}
        </button>
      </div>
      {showHelp && (
        <div id="viewport-help" className="viewport-help" role="dialog" aria-label="Camera controls" onKeyDown={(event) => { if (event.key === "Escape") { event.stopPropagation(); closeHelp(); } }}>
          <button ref={helpCloseRef} type="button" className="icon-close" onClick={closeHelp} aria-label="Close camera help"><X size={15} /></button>
          <p className="eyebrow">Explore the stage</p>
          <dl>
            <div><dt>Orbit</dt><dd>Drag</dd></div>
            <div><dt>Pan</dt><dd>Shift + drag</dd></div>
            <div><dt>Zoom</dt><dd>Scroll or pinch</dd></div>
            <div><dt>Zoom steps</dt><dd>+ / −</dd></div>
            <div><dt>Frame all</dt><dd>F</dd></div>
            <div><dt>Activate object</dt><dd>Double-click or Enter</dd></div>
          </dl>
        </div>
      )}
      {entityCount === 0 && (
        <div className="viewport-empty" aria-hidden="true">
          <span className="horizon-line" />
          <p>YOUR WORKSPACE STARTS HERE</p>
        </div>
      )}
      <p className="sr-only" role="status" aria-live="polite" aria-atomic="true">
        {isImmersive ? "Full screen scene active. Press Escape to exit." : ""}
      </p>
    </main>
  );
});
