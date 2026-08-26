import * as THREE from "three";
import { describe, expect, it, vi } from "vitest";
import {
  XRWorldPanelLayer,
  type ThreeRendererXRWorldPanel,
} from "../../renderer/xr";
import { createDefaultXRPanelPresenterRegistry, type XRPanelModel } from "../../xr/panels";

function fakeCanvas() {
  const calls = {
    fillText: vi.fn(),
    lineTo: vi.fn(),
  };
  const context = {
    clearRect: vi.fn(),
    fillRect: vi.fn(),
    strokeRect: vi.fn(),
    beginPath: vi.fn(),
    moveTo: vi.fn(),
    lineTo: calls.lineTo,
    quadraticCurveTo: vi.fn(),
    closePath: vi.fn(),
    fill: vi.fn(),
    stroke: vi.fn(),
    fillText: calls.fillText,
    measureText: vi.fn((text: string) => ({ width: text.length * 10 })),
    save: vi.fn(),
    restore: vi.fn(),
    translate: vi.fn(),
    rotate: vi.fn(),
    fillStyle: "",
    strokeStyle: "",
    lineWidth: 1,
    font: "",
    textAlign: "left",
    textBaseline: "alphabetic",
  } as unknown as CanvasRenderingContext2D;
  const canvas = document.createElement("canvas");
  Object.defineProperty(canvas, "getContext", {
    configurable: true,
    value: vi.fn(() => context),
  });
  return { canvas, calls };
}

function panel(
  model: XRPanelModel,
  revision = model.kind === "button" ? model.action.expectedWorkspaceRevision : 7,
  transform: Partial<ThreeRendererXRWorldPanel["transform"]> = {},
  sourcePlacementSpace = "world3d",
): ThreeRendererXRWorldPanel {
  return {
    format: "semaframe-xr-world-panel",
    version: "1.0",
    rendererNeutral: true,
    workspaceRevision: revision,
    sourcePlacementSpace,
    transform: {
      position: transform.position ?? { x: 0, y: 0, z: 0 },
      rotation: transform.rotation ?? { x: 0, y: 0, z: 0 },
      scale: transform.scale ?? { x: 1, y: 1, z: 1 },
    },
    panel: createDefaultXRPanelPresenterRegistry().present(model),
  };
}

function button(revision: number, label = "Run", state: "enabled" | "disabled" | "busy" = "enabled") {
  return panel({
    kind: "button",
    panelId: "panel:button",
    componentId: "button",
    title: "Machine",
    label,
    state,
    action: {
      type: "invoke_component_action",
      targetComponentId: "button",
      actionName: "press",
      input: {},
      expectedWorkspaceRevision: revision,
      confirmation: "none",
    },
  }, revision);
}

describe("XRWorldPanelLayer", () => {
  it("renders bounded text, number, button, and chart panels into world/viewer roots", () => {
    const canvases: ReturnType<typeof fakeCanvas>[] = [];
    const layer = new XRWorldPanelLayer({
      createCanvas: () => {
        const created = fakeCanvas();
        canvases.push(created);
        return created.canvas;
      },
    });
    layer.setPanels([
      panel({
        kind: "text",
        panelId: "panel:text",
        componentId: "text",
        title: "Notice",
        text: "The north gate is open",
        dimensions: { widthM: 5, heightM: 5 },
      }),
      panel({
        kind: "number",
        panelId: "panel:number",
        componentId: "number",
        value: 42,
        formattedValue: "42.0",
        unit: "kW",
      }, 7, {}, "viewer-layout"),
      button(7),
      panel({
        kind: "chart",
        panelId: "panel:chart",
        componentId: "chart",
        xLabel: "Time",
        yLabel: "Load",
        series: [{ id: "load", label: "Load", points: [{ x: 0, y: 2 }, { x: 1, y: 6 }] }],
      }),
    ], 7);

    expect(layer.getPanelCount()).toBe(4);
    expect(layer.worldRoot.children).toHaveLength(3);
    expect(layer.viewerRoot.children).toHaveLength(1);
    const textGeometry = layer.getPanelObject("panel:text")?.geometry as THREE.PlaneGeometry;
    expect(textGeometry.parameters.width).toBe(2.4);
    expect(textGeometry.parameters.height).toBe(1.6);
    expect(canvases.flatMap(({ calls }) => calls.fillText.mock.calls.map(([value]) => value))).toEqual(
      expect.arrayContaining(["Notice", "The north gate is open", "42.0 kW", "Run"]),
    );
    expect(canvases.some(({ calls }) => calls.lineTo.mock.calls.length > 2)).toBe(true);
  });

  it("retains GPU resources for stable visual content, redraws changes, and disposes every resource", () => {
    const created = fakeCanvas();
    const layer = new XRWorldPanelLayer({ createCanvas: () => created.canvas });
    layer.setPanels([button(7)], 7);
    const mesh = layer.getPanelObject("panel:button") as THREE.Mesh<THREE.PlaneGeometry, THREE.MeshBasicMaterial>;
    const geometry = mesh.geometry;
    const material = mesh.material;
    const texture = material.map as THREE.CanvasTexture;
    const textureVersion = texture.version;
    const drawCount = created.calls.fillText.mock.calls.length;

    layer.setPanels([panel({
      kind: "button",
      panelId: "panel:button",
      componentId: "button",
      title: "Machine",
      label: "Run",
      action: {
        type: "invoke_component_action",
        targetComponentId: "button",
        actionName: "press",
        input: {},
        expectedWorkspaceRevision: 8,
        confirmation: "none",
      },
    }, 8, { position: { x: 1, y: 2, z: 3 } })], 8);

    expect(layer.getPanelObject("panel:button")).toBe(mesh);
    expect(mesh.geometry).toBe(geometry);
    expect(mesh.material).toBe(material);
    expect(material.map).toBe(texture);
    expect(texture.version).toBe(textureVersion);
    expect(created.calls.fillText).toHaveBeenCalledTimes(drawCount);
    expect(mesh.position.toArray()).toEqual([1, 2, 3]);

    layer.setPanels([button(8, "Stop")], 8);
    expect(material.map).toBe(texture);
    expect(texture.version).toBeGreaterThan(textureVersion);
    expect(created.calls.fillText.mock.calls.length).toBeGreaterThan(drawCount);

    const disposeGeometry = vi.spyOn(geometry, "dispose");
    const disposeMaterial = vi.spyOn(material, "dispose");
    const disposeTexture = vi.spyOn(texture, "dispose");
    layer.setPanels([], 9);
    expect(disposeGeometry).toHaveBeenCalledOnce();
    expect(disposeMaterial).toHaveBeenCalledOnce();
    expect(disposeTexture).toHaveBeenCalledOnce();
    expect(created.canvas.width).toBe(1);
    expect(created.canvas.height).toBe(1);
  });

  it("consumes the nearest panel hit and never activates a button behind it", () => {
    const action = vi.fn();
    const layer = new XRWorldPanelLayer({ createCanvas: () => fakeCanvas().canvas, onAction: action });
    layer.setPanels([
      panel({
        kind: "text",
        panelId: "panel:label",
        componentId: "label",
        text: "Foreground",
      }, 7, { position: { x: 0, y: 0, z: 0.2 } }),
      button(7),
    ], 7);
    layer.setVisible(true);
    const ray = new THREE.Raycaster(new THREE.Vector3(0, 0, 1), new THREE.Vector3(0, 0, -1), 0, 10);

    expect(layer.activateFirstHit(ray)).toBe(true);
    expect(action).not.toHaveBeenCalled();
  });

  it("rejects stale actions, activates only current enabled buttons, and reports the stale revision", () => {
    const action = vi.fn();
    const warning = vi.fn();
    const layer = new XRWorldPanelLayer({
      createCanvas: () => fakeCanvas().canvas,
      onAction: action,
      onWarning: warning,
    });
    const ray = new THREE.Raycaster(new THREE.Vector3(0, 0, 1), new THREE.Vector3(0, 0, -1), 0, 10);
    layer.setVisible(true);
    layer.setPanels([button(7)], 8);

    expect(layer.activateFirstHit(ray)).toBe(true);
    expect(action).not.toHaveBeenCalled();
    expect(warning).toHaveBeenLastCalledWith(expect.objectContaining({
      code: "stale_revision",
      panelId: "panel:button",
      componentId: "button",
    }));

    layer.setPanels([button(8)], 8);
    expect(layer.activateFirstHit(ray)).toBe(true);
    expect(action).toHaveBeenCalledOnce();
    expect(action).toHaveBeenCalledWith(expect.objectContaining({
      panelId: "panel:button",
      workspaceRevision: 8,
      action: expect.objectContaining({ expectedWorkspaceRevision: 8 }),
    }));

    layer.setPanels([button(8, "Run", "disabled")], 8);
    expect(layer.activateFirstHit(ray)).toBe(true);
    expect(action).toHaveBeenCalledOnce();
  });

  it("bounds panel count and releases both roots on disposal", () => {
    const warning = vi.fn();
    const layer = new XRWorldPanelLayer({
      maxPanels: 2,
      createCanvas: () => fakeCanvas().canvas,
      onWarning: warning,
    });
    layer.setPanels([0, 1, 2].map((index) => panel({
      kind: "text",
      panelId: `panel:${index}`,
      componentId: `text:${index}`,
      text: `${index}`,
    })), 7);
    const scene = new THREE.Scene();
    scene.add(layer.worldRoot, layer.viewerRoot);

    expect(layer.getPanelCount()).toBe(2);
    expect(warning).toHaveBeenCalledWith(expect.objectContaining({ code: "panel_limit" }));
    layer.dispose();
    expect(layer.getPanelCount()).toBe(0);
    expect(layer.worldRoot.parent).toBeNull();
    expect(layer.viewerRoot.parent).toBeNull();
  });

  it("rejects malformed dimensions and kind-specific content before drawing", () => {
    const warning = vi.fn();
    const layer = new XRWorldPanelLayer({
      createCanvas: () => fakeCanvas().canvas,
      onWarning: warning,
    });
    const malformedDimensions = structuredClone(button(7)) as unknown as Record<string, unknown>;
    (malformedDimensions.panel as { dimensions: { widthM: number } }).dimensions.widthM = Number.NaN;
    const malformedContent = structuredClone(button(7)) as unknown as Record<string, unknown>;
    (malformedContent.panel as { content: unknown }).content = { state: "enabled" };
    expect(() => layer.setPanels([
      malformedDimensions as unknown as ThreeRendererXRWorldPanel,
      malformedContent as unknown as ThreeRendererXRWorldPanel,
    ], 7)).not.toThrow();
    expect(layer.getPanelCount()).toBe(0);
    expect(warning).toHaveBeenCalledTimes(2);
    expect(warning).toHaveBeenCalledWith(expect.objectContaining({ code: "invalid_panel" }));
  });
});
