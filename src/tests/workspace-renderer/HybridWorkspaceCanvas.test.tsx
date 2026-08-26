import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { createRef } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  HybridWorkspaceCanvas,
  type HybridWorkspaceCanvasHandle,
} from "../../app/components/workspace/HybridWorkspaceCanvas";
import type { SceneDelta, SceneOperation, SceneState } from "../../renderer/sceneRenderTypes";
import type { RenderPresentationContext } from "../../renderer/materialization";
import type { RealityMeasurementEvent } from "../../renderer/reality";
import { ThreeComponentRenderer, type ThreeRendererPort } from "../../workspace/renderer/ThreeComponentRenderer";
import type { WorkspaceRenderSnapshot } from "../../workspace/renderer/contracts";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("HybridWorkspaceCanvas", () => {
  it("bridges a user-activated XR session without creating another Workspace authority", async () => {
    const port = new FakePort();
    const ref = createRef<HybridWorkspaceCanvasHandle>();
    const onXRPanelAction = vi.fn();
    render(<HybridWorkspaceCanvas
      ref={ref}
      state={snapshot()}
      rendererOptions={{ three: new ThreeComponentRenderer({ renderer: port }) }}
      onXRPanelAction={onXRPanelAction}
    />);
    await waitFor(() => expect(port.renderState).toHaveBeenCalled());

    const session = {} as XRSession;
    await act(async () => {
      await ref.current?.enterXR(session, { referenceSpaceType: "local-floor", foveation: 0.5 });
    });
    expect(port.enterXR).toHaveBeenCalledWith(session, {
      referenceSpaceType: "local-floor",
      foveation: 0.5,
    });
    expect(ref.current?.isXRPresenting()).toBe(true);

    await act(async () => { await ref.current?.exitXR(); });
    expect(port.exitXR).toHaveBeenCalledOnce();

    ref.current?.setXRWorldPanels?.([], 7);
    expect(port.setXRWorldPanels).toHaveBeenCalledWith([], 7);
    const actionHandler = port.setXRPanelActionHandler.mock.calls[0]?.[0];
    actionHandler?.({
      panelId: "panel:run",
      componentId: "run",
      workspaceRevision: 7,
      action: {
        type: "invoke_component_action",
        targetComponentId: "run",
        actionName: "press",
        input: {},
        expectedWorkspaceRevision: 7,
        confirmation: "none",
      },
    });
    expect(onXRPanelAction).toHaveBeenCalledWith(expect.objectContaining({ panelId: "panel:run" }));
  });

  it("bridges Reality measurement controls and events through the App canvas boundary", async () => {
    const port = new FakePort();
    port.startRealityMeasurement.mockReturnValue(true);
    const three = new ThreeComponentRenderer({ renderer: port });
    const installMeasurementHandler = vi.spyOn(three, "setRealityMeasurementHandler");
    const ref = createRef<HybridWorkspaceCanvasHandle>();
    const onRealityMeasurement = vi.fn();
    const onRendererReady = vi.fn();

    render(<HybridWorkspaceCanvas
      ref={ref}
      state={snapshot()}
      rendererOptions={{ three }}
      onRealityMeasurement={onRealityMeasurement}
      onRendererReady={onRendererReady}
    />);

    await waitFor(() => expect(onRendererReady).toHaveBeenCalledOnce());
    expect(installMeasurementHandler).toHaveBeenCalledOnce();
    expect(ref.current?.startRealityMeasurement("reality-pole")).toBe(true);
    expect(port.startRealityMeasurement).toHaveBeenCalledWith("reality-pole");

    const event: RealityMeasurementEvent = {
      kind: "started",
      componentId: "reality-pole",
      assetId: "ra_fixture",
      assetDigest: `sha256:${"b".repeat(64)}`,
      sessionId: 7,
    };
    installMeasurementHandler.mock.calls[0]?.[0]?.(event);
    expect(onRealityMeasurement).toHaveBeenCalledWith(event);

    ref.current?.cancelRealityMeasurement();
    expect(port.cancelRealityMeasurement).toHaveBeenCalledOnce();
  });

  it("replaces a stale injected Reality measurement handler and clears it on disposal", async () => {
    const port = new FakePort();
    const staleHandler = vi.fn();
    const three = new ThreeComponentRenderer({ renderer: port, onRealityMeasurement: staleHandler });
    const installMeasurementHandler = vi.spyOn(three, "setRealityMeasurementHandler");
    const onRendererReady = vi.fn();
    const view = render(<HybridWorkspaceCanvas
      state={snapshot()}
      rendererOptions={{ three }}
      onRendererReady={onRendererReady}
    />);

    await waitFor(() => expect(onRendererReady).toHaveBeenCalledOnce());
    expect(installMeasurementHandler).toHaveBeenCalledOnce();
    const replacement = installMeasurementHandler.mock.calls[0]?.[0];
    expect(replacement).toEqual(expect.any(Function));
    replacement?.({
      kind: "started",
      componentId: "reality-pole",
      assetId: "ra_fixture",
      assetDigest: `sha256:${"c".repeat(64)}`,
      sessionId: 8,
    });
    expect(staleHandler).not.toHaveBeenCalled();

    view.unmount();
    expect(installMeasurementHandler).toHaveBeenLastCalledWith(undefined);
    expect(installMeasurementHandler).toHaveBeenCalledTimes(2);
    expect(staleHandler).not.toHaveBeenCalled();
  });

  it("provides one App boundary for selection, preview, commit, and camera controls", async () => {
    const port = new FakePort();
    const ref = createRef<HybridWorkspaceCanvasHandle>();
    const onSelect = vi.fn();
    const onActivate = vi.fn();
    const onPreviewPlacement = vi.fn();
    const onCommitPlacement = vi.fn();
    const onCancelPreview = vi.fn();
    const onPreviewResize = vi.fn();
    const onCommitResize = vi.fn();
    const onCancelResize = vi.fn();
    render(<div style={{ width: 800, height: 600 }}>
      <HybridWorkspaceCanvas
        ref={ref}
        state={snapshot()}
        rendererOptions={{ three: new ThreeComponentRenderer({ renderer: port }) }}
        onSelect={onSelect}
        onActivate={onActivate}
        onPreviewPlacement={onPreviewPlacement}
        onCommitPlacement={onCommitPlacement}
        onCancelPreview={onCancelPreview}
        getResizePolicy={() => ({
          kind: "box2d",
          mode: "free",
          defaultSize: { width: 240, height: 144 },
          minSize: { width: 80, height: 60 },
          maxSize: { width: 1_200, height: 900 },
          allowedAxes: ["width", "height"],
          units: "px",
        })}
        onPreviewResize={onPreviewResize}
        onCommitResize={onCommitResize}
        onCancelResize={onCancelResize}
      />
    </div>);

    const panel = await screen.findByRole("region", { name: /Status panel, panel component/i });
    fireEvent.focus(panel);
    expect(onSelect).toHaveBeenCalledWith("panel");
    expect(port.setSelectedEntity).toHaveBeenCalledWith(null, false);
    fireEvent.keyDown(panel, { key: "Enter" });
    expect(onActivate).toHaveBeenCalledWith({ componentId: "panel" });
    fireEvent.doubleClick(panel.querySelector(".workspace-projected-component__content")!);
    expect(onActivate).toHaveBeenCalledTimes(2);

    fireEvent(panel, new MouseEvent("pointerdown", { bubbles: true, button: 0, clientX: 10, clientY: 20 }));
    fireEvent(document, new MouseEvent("pointermove", { bubbles: true, clientX: 50, clientY: 60 }));
    expect(onPreviewPlacement).toHaveBeenCalledOnce();
    expect(onCommitPlacement).not.toHaveBeenCalled();
    fireEvent(document, new MouseEvent("pointerup", { bubbles: true, clientX: 50, clientY: 60 }));
    expect(onCommitPlacement).toHaveBeenCalledOnce();
    await waitFor(() => expect(onCancelPreview).toHaveBeenCalledOnce());

    const resizeHandle = await screen.findByRole("button", { name: /Resize Status panel from bottom right/i });
    fireEvent(resizeHandle, new MouseEvent("pointerdown", { bubbles: true, button: 0, clientX: 240, clientY: 144 }));
    fireEvent(document, new MouseEvent("pointermove", { bubbles: true, clientX: 280, clientY: 174 }));
    expect(onPreviewResize).toHaveBeenCalledOnce();
    expect(onCommitResize).not.toHaveBeenCalled();
    fireEvent(document, new MouseEvent("pointerup", { bubbles: true, clientX: 280, clientY: 174 }));
    expect(onCommitResize).toHaveBeenCalledOnce();
    expect(onCommitResize).toHaveBeenCalledWith(expect.objectContaining({
      componentId: "panel",
      resize: { kind: "box2d", size: { width: 280, height: 174 } },
      baseRevision: 4,
    }));
    await waitFor(() => expect(onCancelResize).toHaveBeenCalledOnce());

    ref.current?.frameAll();
    ref.current?.resetView();
    ref.current?.zoomIn();
    expect(port.zoomBy).toHaveBeenLastCalledWith(1.2);
    expect(ref.current?.getContainer()?.dataset.canvasZoom).toBe("1.2");
    ref.current?.zoomOut();
    expect(port.zoomBy).toHaveBeenLastCalledWith(1 / 1.2);
    expect(Number(ref.current?.getContainer()?.dataset.canvasZoom)).toBeCloseTo(1);
    const threeLayer = ref.current?.getContainer()?.querySelector<HTMLElement>("[data-workspace-three-layer]");
    expect(threeLayer).toBeTruthy();
    touchPointer(threeLayer!, "pointerdown", 1, 100, 100);
    touchPointer(threeLayer!, "pointerdown", 2, 200, 100);
    touchPointer(threeLayer!, "pointermove", 2, 300, 100);
    expect(Number(ref.current?.getContainer()?.dataset.canvasZoom)).toBeCloseTo(2);
    touchPointer(threeLayer!, "pointerup", 1, 100, 100);
    touchPointer(threeLayer!, "pointerup", 2, 300, 100);
    expect(port.frameAll).toHaveBeenCalledOnce();
    expect(port.resetView).toHaveBeenCalledOnce();
    expect(ref.current?.getContainer()).toHaveAttribute("role", "application");
  });

  it("cancels pending 2D and desktop 3D gestures before a trusted gate takes over", async () => {
    const port = new FakePort();
    const ref = createRef<HybridWorkspaceCanvasHandle>();
    const onPreviewPlacement = vi.fn();
    const onCommitPlacement = vi.fn();
    const onCancelPreview = vi.fn();
    render(<HybridWorkspaceCanvas
      ref={ref}
      state={snapshot()}
      rendererOptions={{ three: new ThreeComponentRenderer({ renderer: port }) }}
      onPreviewPlacement={onPreviewPlacement}
      onCommitPlacement={onCommitPlacement}
      onCancelPreview={onCancelPreview}
    />);
    const panel = await screen.findByRole("region", { name: /Status panel, panel component/i });
    fireEvent(panel, new MouseEvent("pointerdown", { bubbles: true, button: 0, clientX: 10, clientY: 20 }));
    fireEvent(document, new MouseEvent("pointermove", { bubbles: true, clientX: 50, clientY: 60 }));
    expect(onPreviewPlacement).toHaveBeenCalledOnce();

    const threeLayer = ref.current?.getContainer()?.querySelector<HTMLElement>("[data-workspace-three-layer]");
    expect(threeLayer).toBeTruthy();
    touchPointer(threeLayer!, "pointerdown", 1, 100, 100);
    touchPointer(threeLayer!, "pointerdown", 2, 200, 100);
    touchPointer(threeLayer!, "pointermove", 2, 300, 100);
    const zoomBeforeCancel = Number(ref.current?.getContainer()?.dataset.canvasZoom);
    expect(zoomBeforeCancel).toBeGreaterThan(1);

    ref.current?.cancelActiveInteractions();
    fireEvent(document, new MouseEvent("pointerup", { bubbles: true, clientX: 50, clientY: 60 }));
    touchPointer(threeLayer!, "pointermove", 2, 400, 100);

    expect(onCommitPlacement).not.toHaveBeenCalled();
    expect(onCancelPreview).toHaveBeenCalledOnce();
    expect(port.cancelDesktopInteractions).toHaveBeenCalledOnce();
    expect(Number(ref.current?.getContainer()?.dataset.canvasZoom)).toBe(zoomBeforeCancel);
  });

  it("mounts, replaces state, and unmounts without nested-root lifecycle warnings", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const consoleWarn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const port = new FakePort();
    const view = render(<HybridWorkspaceCanvas
      state={snapshot()}
      rendererOptions={{ three: new ThreeComponentRenderer({ renderer: port }) }}
    />);
    await view.findByRole("region", { name: /Status panel, panel component/i });

    const replacement = snapshot();
    view.rerender(<HybridWorkspaceCanvas
      state={{
        ...replacement,
        revision: replacement.revision + 1,
        components: replacement.components.map((component) => ({
          ...component,
          label: "Replacement panel",
          props: { title: "Replacement" },
        })),
      }}
      rendererOptions={{ three: new ThreeComponentRenderer({ renderer: port }) }}
    />);
    await view.findByRole("region", { name: /Replacement panel, panel component/i });

    await act(async () => {
      view.unmount();
      await Promise.resolve();
    });

    const lifecycleMessages = [...consoleError.mock.calls, ...consoleWarn.mock.calls]
      .flatMap((call) => call.map(String))
      .filter((message) => message.includes("flushSync was called from inside a lifecycle method")
        || message.includes("Attempted to synchronously unmount a root"));
    expect(lifecycleMessages).toEqual([]);
    consoleError.mockRestore();
    consoleWarn.mockRestore();
  });

  it("publishes readiness only after the latest initialization-time revision renders", async () => {
    const gate = deferred<void>();
    const port = new FakePort();
    port.renderState.mockImplementationOnce(async () => { await gate.promise; return undefined; });
    const onRendererReady = vi.fn();
    const onStatus = vi.fn();
    const view = render(<HybridWorkspaceCanvas
      state={snapshot()}
      rendererOptions={{ three: new ThreeComponentRenderer({ renderer: port }) }}
      onRendererReady={onRendererReady}
      onStatus={onStatus}
    />);
    await waitFor(() => expect(port.renderState).toHaveBeenCalledOnce());
    expect(onRendererReady).not.toHaveBeenCalled();
    expect(onStatus).not.toHaveBeenCalledWith({ kind: "ready" });

    const latest = { ...snapshot(), revision: 5, components: snapshot().components.map((component) => ({
      ...component,
      label: "Latest panel",
    })) };
    view.rerender(<HybridWorkspaceCanvas
      state={latest}
      rendererOptions={{ three: new ThreeComponentRenderer({ renderer: port }) }}
      onRendererReady={onRendererReady}
      onStatus={onStatus}
    />);
    gate.resolve();
    await waitFor(() => expect(onRendererReady).toHaveBeenCalledOnce());
    expect(port.applyDelta).toHaveBeenCalledOnce();
    expect(port.applyDelta.mock.calls[0]?.[0]).toMatchObject({ fromRevision: 4, toRevision: 5 });
    expect(onStatus).toHaveBeenCalledWith({ kind: "ready" });
  });

  it("animates only the exact revision-producing commit and does not replay it", async () => {
    const port = new FakePort();
    const initial = snapshot();
    const next: WorkspaceRenderSnapshot = {
      ...initial,
      revision: 5,
      components: initial.components.map((component) => component.placement.space === "viewport"
        ? { ...component, placement: { ...component.placement, offset: { x: 80, y: 32 } } }
        : component),
    };
    const commit = {
      baseRevision: 4,
      resultingRevision: 5,
      operations: [{
        op: "place_component" as const,
        op_id: "move_panel",
        id: "panel",
        placement: next.components[0]!.placement,
        transition: { durationMs: 240, delayMs: 30, easing: "ease_in_out" as const },
      }],
    };
    const view = render(<HybridWorkspaceCanvas
      state={initial}
      rendererOptions={{ three: new ThreeComponentRenderer({ renderer: port }) }}
    />);
    const panel = await view.findByRole("region", { name: /Status panel, panel component/i });

    view.rerender(<HybridWorkspaceCanvas
      state={next}
      commit={commit}
      rendererOptions={{ three: new ThreeComponentRenderer({ renderer: port }) }}
    />);
    await waitFor(() => expect(panel.style.transition).toContain("left 240ms ease-in-out 30ms"));

    view.rerender(<HybridWorkspaceCanvas
      state={next}
      commit={{ ...commit, operations: [...commit.operations] }}
      rendererOptions={{ three: new ThreeComponentRenderer({ renderer: port }) }}
    />);
    expect(panel.style.transition).toContain("left 240ms ease-in-out 30ms");
    await waitFor(() => expect(panel.style.transition).toBe(""));
  });

  it("suppresses committed transitions when reduced motion is requested", async () => {
    const port = new FakePort();
    const initial = snapshot();
    const next: WorkspaceRenderSnapshot = {
      ...initial,
      revision: 5,
      components: initial.components.map((component) => component.placement.space === "viewport"
        ? { ...component, placement: { ...component.placement, offset: { x: 24, y: 16 } } }
        : component),
    };
    const rendererOptions = {
      three: new ThreeComponentRenderer({ renderer: port }),
      reducedMotion: true,
    };
    const view = render(<HybridWorkspaceCanvas state={initial} rendererOptions={rendererOptions} />);
    const panel = await view.findByRole("region", { name: /Status panel, panel component/i });
    view.rerender(<HybridWorkspaceCanvas
      state={next}
      commit={{
        baseRevision: 4,
        resultingRevision: 5,
        operations: [{
          op: "place_component",
          op_id: "move_panel_reduced",
          id: "panel",
          placement: next.components[0]!.placement,
          transition: { durationMs: 240, easing: "ease_out" },
        }],
      }}
      rendererOptions={rendererOptions}
    />);
    await waitFor(() => expect(panel.style.left).not.toBe(""));
    expect(panel.style.transition).toBe("");
  });

  it("retains a hidden component for its bounded exit and marks a shown component as entering", async () => {
    const port = new FakePort();
    const rendererOptions = { three: new ThreeComponentRenderer({ renderer: port }), reducedMotion: false };
    const initial = snapshot();
    const hidden: WorkspaceRenderSnapshot = {
      ...initial,
      revision: 5,
      components: initial.components.map((component) => ({ ...component, visibility: "hidden" as const })),
    };
    const view = render(<HybridWorkspaceCanvas state={initial} rendererOptions={rendererOptions} />);
    await view.findByRole("region", { name: /Status panel, panel component/i });
    view.rerender(<HybridWorkspaceCanvas
      state={hidden}
      commit={visibilityCommit(4, 5, "hide", 30)}
      rendererOptions={rendererOptions}
    />);
    await waitFor(() => expect(view.container.querySelector("[data-workspace-presence='exiting']")).not.toBeNull());
    const exiting = view.container.querySelector<HTMLElement>(".workspace-projected-component[data-workspace-component-id='panel']")!;
    expect(exiting.style.opacity).toBe("0");
    expect(exiting.style.transition).toContain("opacity 30ms");
    expect(exiting).toHaveAttribute("aria-hidden", "true");
    await waitFor(() => expect(view.container.querySelector(".workspace-projected-component[data-workspace-component-id='panel']")).toBeNull());

    const shown = { ...initial, revision: 6 };
    view.rerender(<HybridWorkspaceCanvas
      state={shown}
      commit={visibilityCommit(5, 6, "show", 30)}
      rendererOptions={rendererOptions}
    />);
    await waitFor(() => expect(view.container.querySelector("[data-workspace-presence='entering']")).not.toBeNull());
  });

  it("drops an active exit immediately when reduced motion becomes preferred", async () => {
    const media = new ControlledMotionQuery(false);
    vi.stubGlobal("matchMedia", vi.fn(() => media as unknown as MediaQueryList));
    const port = new FakePort();
    const rendererOptions = { three: new ThreeComponentRenderer({ renderer: port }) };
    const initial = snapshot();
    const hidden: WorkspaceRenderSnapshot = {
      ...initial,
      revision: 5,
      components: initial.components.map((component) => ({ ...component, visibility: "collapsed" as const })),
    };
    const view = render(<HybridWorkspaceCanvas state={initial} rendererOptions={rendererOptions} />);
    await view.findByRole("region", { name: /Status panel, panel component/i });
    view.rerender(<HybridWorkspaceCanvas
      state={hidden}
      commit={visibilityCommit(4, 5, "hide", 500)}
      rendererOptions={rendererOptions}
    />);
    await waitFor(() => expect(view.container.querySelector("[data-workspace-presence='exiting']")).not.toBeNull());
    act(() => media.setMatches(true));
    await waitFor(() => expect(view.container.querySelector(".workspace-projected-component[data-workspace-component-id='panel']")).toBeNull());
  });

  it("forwards resolved 3D operations only for their exact resulting revision", async () => {
    const port = new FakePort();
    const rendererOptions = { three: new ThreeComponentRenderer({ renderer: port }) };
    const initial = spatialSnapshot(1, 0);
    const next = spatialSnapshot(2, 4);
    const commit = {
      baseRevision: 1,
      resultingRevision: 2,
      operations: [{
        op: "place_component" as const,
        op_id: "move_actor",
        id: "actor",
        placement: next.components[1]!.placement,
        transition: { durationMs: 500, easing: "linear" as const },
      }],
    };
    const view = render(<HybridWorkspaceCanvas state={initial} rendererOptions={rendererOptions} />);
    await waitFor(() => expect(port.renderState).toHaveBeenCalledOnce());

    view.rerender(<HybridWorkspaceCanvas state={next} commit={commit} rendererOptions={rendererOptions} />);
    await waitFor(() => expect(port.applyDelta).toHaveBeenCalledTimes(1));
    expect(port.applyDelta.mock.calls[0]?.[2]).toEqual([expect.objectContaining({
      op_id: "workspace:move_actor",
      id: "actor",
      visualTiming: { startAfterMs: 0, durationMs: 500, easing: "linear" },
    })]);
    expect(port.applyDelta.mock.calls[0]?.[3]).toEqual({
      delivery: "live_commit",
      batchKey: "spatial-hybrid-test:1->2",
    });

    view.rerender(<HybridWorkspaceCanvas
      state={next}
      commit={{ ...commit, operations: [...commit.operations] }}
      rendererOptions={rendererOptions}
    />);
    await waitFor(() => expect(port.applyDelta).toHaveBeenCalledTimes(2));
    expect(port.applyDelta.mock.calls[1]?.[2]).toEqual([]);
    expect(port.applyDelta.mock.calls[1]?.[3]).toEqual({ delivery: "context_restore" });

    view.rerender(<HybridWorkspaceCanvas
      state={spatialSnapshot(3, 6)}
      rendererOptions={rendererOptions}
    />);
    await waitFor(() => expect(port.applyDelta).toHaveBeenCalledTimes(3));
    expect(port.applyDelta.mock.calls[2]?.[3]).toEqual({ delivery: "reconnect" });
  });
});

function touchPointer(
  target: HTMLElement,
  type: "pointerdown" | "pointermove" | "pointerup",
  pointerId: number,
  clientX: number,
  clientY: number,
): void {
  const event = new Event(type, { bubbles: true });
  Object.defineProperties(event, {
    pointerId: { value: pointerId },
    pointerType: { value: "touch" },
    clientX: { value: clientX },
    clientY: { value: clientY },
  });
  fireEvent(target, event);
}

class FakePort implements ThreeRendererPort {
  initialize = vi.fn(async (_container: HTMLElement) => undefined);
  renderState = vi.fn(async (_state: Readonly<SceneState>) => undefined);
  applyDelta = vi.fn(async (
    _delta: SceneDelta,
    _state?: Readonly<SceneState>,
    _operations?: readonly SceneOperation[],
    _presentation?: RenderPresentationContext,
  ) => undefined);
  resize = vi.fn();
  dispose = vi.fn();
  frameAll = vi.fn();
  resetView = vi.fn();
  zoomBy = vi.fn();
  setSelectedEntity = vi.fn();
  startRealityMeasurement = vi.fn((_entityId: string) => false);
  cancelRealityMeasurement = vi.fn();
  cancelDesktopInteractions = vi.fn();
  enterXR = vi.fn(async (_session: XRSession) => undefined);
  exitXR = vi.fn(async () => undefined);
  isXRPresenting = vi.fn(() => this.enterXR.mock.calls.length > this.exitXR.mock.calls.length);
  setXRWorldPanels = vi.fn();
  setXRPanelActionHandler = vi.fn();
  setXRPanelWarningHandler = vi.fn();
}

class ControlledMotionQuery {
  matches: boolean;
  private listeners = new Set<(event: MediaQueryListEvent) => void>();

  constructor(matches: boolean) {
    this.matches = matches;
  }

  addEventListener(_type: "change", listener: (event: MediaQueryListEvent) => void): void {
    this.listeners.add(listener);
  }

  removeEventListener(_type: "change", listener: (event: MediaQueryListEvent) => void): void {
    this.listeners.delete(listener);
  }

  setMatches(matches: boolean): void {
    this.matches = matches;
    for (const listener of this.listeners) listener({ matches } as MediaQueryListEvent);
  }
}

function visibilityCommit(
  baseRevision: number,
  resultingRevision: number,
  action: "hide" | "show",
  durationMs: number,
) {
  return {
    baseRevision,
    resultingRevision,
    operations: [{
      op: "invoke_component_action" as const,
      op_id: `${action}_panel`,
      id: "panel",
      action,
      input: {},
      transition: { durationMs, easing: "ease_out" as const },
    }],
  };
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((next) => { resolve = next; });
  return { promise, resolve };
}

function snapshot(): WorkspaceRenderSnapshot {
  return {
    workspaceId: "hybrid-test",
    revision: 4,
    components: [{
      id: "panel",
      type: { typeId: "panel", version: "1.0.0", digest: "panel" },
      label: "Status panel",
      props: { title: "Status" },
      durableState: {},
      placement: { space: "viewport", anchor: "center", offset: { x: 0, y: 0 } },
      tags: [],
      visibility: "visible",
      locks: { placement: false, props: false, deletion: false, actions: false },
    }],
  };
}

function spatialSnapshot(revision: number, x: number): WorkspaceRenderSnapshot {
  return {
    workspaceId: "spatial-hybrid-test",
    revision,
    components: [
      {
        id: "stage",
        type: { typeId: "stage-3d", version: "1.2.0", digest: "stage" },
        label: "Stage",
        props: { environmentPreset: "blank_stage" },
        durableState: {},
        placement: {
          space: "world3d",
          position: { x: 0, y: 0, z: 0 },
          rotation: { x: 0, y: 0, z: 0 },
          scale: { x: 1, y: 1, z: 1 },
        },
        tags: [],
        visibility: "visible",
        locks: { placement: true },
      },
      {
        id: "actor",
        type: { typeId: "spatial-entity", version: "1.2.0", digest: "actor" },
        label: "Actor",
        props: { entityKind: "character", assetId: "humanoid_generic_01" },
        durableState: {
          playback: { clip: "idle", playing: false, loop: true, speed: 1, generation: 0 },
        },
        placement: {
          space: "world3d",
          position: { x, y: 0, z: 0 },
          rotation: { x: 0, y: 0, z: 0 },
          scale: { x: 1, y: 1, z: 1 },
        },
        tags: [],
        visibility: "visible",
        locks: { placement: false },
      },
    ],
  };
}
