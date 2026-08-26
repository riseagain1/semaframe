import { describe, expect, it } from "vitest";
import {
  createDefaultXRPanelPresenterRegistry,
  XRPanelPresenterRegistry,
  textPanelPresenter,
  type XRPanelTypedAction,
} from "../../xr/panels";

const ACTION: XRPanelTypedAction = {
  type: "invoke_component_action",
  targetComponentId: "floor-lamp",
  actionName: "turn_on",
  input: { brightness: 0.8 },
  expectedWorkspaceRevision: 12,
  confirmation: "none",
};

describe("XRPanelPresenterRegistry", () => {
  it("provides renderer-neutral presentations for text, number, button, and chart", () => {
    const registry = createDefaultXRPanelPresenterRegistry();
    expect(registry.list().map(({ kind }) => kind)).toEqual(["button", "chart", "number", "text"]);

    expect(registry.present({
      kind: "text", panelId: "note", componentId: "note", text: "Route is clear",
    })).toMatchObject({ format: "semaframe-xr-panel", rendererNeutral: true, kind: "text" });
    expect(registry.present({
      kind: "number", panelId: "power", componentId: "power", value: 18.4, unit: "W",
    })).toMatchObject({ kind: "number", content: { value: 18.4, unit: "W", trend: "flat" } });
    expect(registry.present({
      kind: "button", panelId: "switch", componentId: "switch", label: "Lamp", action: ACTION,
    })).toMatchObject({ kind: "button", content: { state: "enabled", action: ACTION } });
    expect(registry.present({
      kind: "chart",
      panelId: "history",
      componentId: "history",
      series: [{ id: "watts", label: "Power", points: [{ x: 0, y: 0 }, { x: 1, y: 18.4 }] }],
    })).toMatchObject({ kind: "chart", content: { series: [{ id: "watts" }] } });
  });

  it("defensively clones typed action input and pins the Workspace revision", () => {
    const mutableInput = { brightness: 0.8 };
    const registry = createDefaultXRPanelPresenterRegistry();
    const panel = registry.present({
      kind: "button",
      panelId: "switch",
      componentId: "switch",
      label: "Lamp",
      action: { ...ACTION, input: mutableInput },
    });
    if (panel.kind !== "button") throw new Error("Expected button presentation");
    mutableInput.brightness = 0.1;

    expect(panel.content.action).toEqual(ACTION);
    expect(Object.isFrozen(panel.content.action.input)).toBe(true);
    expect(panel.content.action.expectedWorkspaceRevision).toBe(12);
  });

  it("rejects presenter ambiguity and invalid chart payloads", () => {
    const registry = new XRPanelPresenterRegistry();
    registry.register(textPanelPresenter);
    expect(() => registry.register(textPanelPresenter)).toThrow(/already registered/u);
    expect(() => createDefaultXRPanelPresenterRegistry().present({
      kind: "chart", panelId: "empty", componentId: "empty", series: [],
    })).toThrow(/requires 1-16 series/u);
    expect(() => createDefaultXRPanelPresenterRegistry().present({
      kind: "button",
      panelId: "bad-action",
      componentId: "bad-action",
      label: "Unsafe",
      action: { ...ACTION, confirmation: "unexpected" as "none" },
    })).toThrow(/confirmation is invalid/u);
  });
});
