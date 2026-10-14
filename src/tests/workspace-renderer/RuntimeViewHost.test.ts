import { afterEach, describe, expect, it, vi } from "vitest";
import { collectRuntimeViewHost } from "../../workspace/renderer/runtimeViewHost";

afterEach(() => { document.body.replaceChildren(); vi.restoreAllMocks(); });

describe("app-owned runtime view occluders", () => {
  it("reports only clipped geometry with fixed IDs, not host text or component/iframe contents", () => {
    const { root, canvas } = setup();
    const toolbar = region(root, "workspace-tools", [105, 580, 200, 80]);
    toolbar.textContent = "private connection URL and client name";
    const input = document.createElement("input");
    input.value = "private token";
    toolbar.append(input);
    region(root, "unknown-user-supplied-id", [100, 20, 200, 80]);
    const component = document.createElement("div");
    component.dataset.workspaceComponentId = "user-panel";
    root.append(component);
    region(component, "camera-controls", [100, 20, 200, 80]);
    const iframe = document.createElement("iframe");
    root.append(iframe);
    Object.defineProperty(iframe, "contentDocument", { get: () => { throw new Error("Never inspect iframe contents"); } });

    expect(collectRuntimeViewHost(canvas)).toEqual({ occluders: [{
      id: "workspace-tools", kind: "toolbar", bounds: { left: 5, top: 560, width: 200, height: 79 },
    }] });
    expect(JSON.stringify(collectRuntimeViewHost(canvas))).not.toMatch(/private|user-panel|unknown/);
  });

  it("ignores hidden/outside regions and measures display:contents wrapper children independently", () => {
    const { root, canvas } = setup();
    region(root, "workspace-panel", [650, 40, 100, 500]);
    const hidden = region(root, "camera-controls", [105, 580, 200, 40]);
    hidden.style.display = "none";
    const wrapper = region(root, "viewport-status", [0, 0, 0, 0]);
    wrapper.dataset.workspaceRuntimeChildren = "true";
    wrapper.style.display = "contents";
    const left = document.createElement("span");
    const right = document.createElement("span");
    wrapper.append(left, right);
    rect(left, [110, 30, 80, 30]);
    rect(right, [510, 30, 80, 30]);
    expect(collectRuntimeViewHost(canvas).occluders).toEqual([
      { id: "viewport-status:0", kind: "status", bounds: { left: 10, top: 10, width: 80, height: 30 } },
      { id: "viewport-status:1", kind: "status", bounds: { left: 410, top: 10, width: 80, height: 30 } },
    ]);
  });

  it("marks only explicitly scoped host dialogs and app gates unavailable", () => {
    const { root, canvas } = setup();
    const scope = document.createElement("div");
    root.append(scope);
    const dialog = document.createElement("div");
    dialog.setAttribute("role", "dialog");
    scope.append(dialog);
    rect(dialog, [130, 50, 300, 400]);
    expect(collectRuntimeViewHost(canvas).unavailableReason).toBeUndefined();
    scope.dataset.workspaceRuntimeModalScope = "true";
    expect(collectRuntimeViewHost(canvas).unavailableReason).toBe("host_modal_or_gate");
    dialog.hidden = true;
    expect(collectRuntimeViewHost(canvas).unavailableReason).toBeUndefined();
    root.dataset.workspaceRuntimeBlocked = "true";
    expect(collectRuntimeViewHost(canvas).unavailableReason).toBe("host_modal_or_gate");
  });

  it("does not reserve nonpresented app chrome outside an immersive desktop viewport", () => {
    const { root, canvas } = setup();
    const shell = document.createElement("main");
    shell.dataset.workspaceRuntimeImmersive = "true";
    root.append(shell);
    shell.append(canvas);
    region(root, "agent-controls", [200, 30, 200, 44]);
    region(shell, "camera-controls", [540, 580, 44, 44]);
    expect(collectRuntimeViewHost(canvas).occluders.map((entry) => entry.id)).toEqual(["camera-controls"]);
  });

  it("detects known XR modal portals outside the app root without inspecting their contents", () => {
    const { canvas } = setup();
    const portal = document.createElement("div");
    portal.dataset.workspaceRuntimeModal = "unregistered-modal";
    document.body.append(portal);
    rect(portal, [0, 0, 1200, 900]);
    expect(collectRuntimeViewHost(canvas).unavailableReason).toBeUndefined();
    for (const id of ["xr-setup", "xr-headset"]) {
      portal.dataset.workspaceRuntimeModal = id;
      portal.textContent = "private pairing URL";
      expect(collectRuntimeViewHost(canvas)).toEqual({ occluders: [], unavailableReason: "host_modal_or_gate" });
    }
    portal.remove();
    expect(collectRuntimeViewHost(canvas).unavailableReason).toBeUndefined();
  });
});

function setup() {
  const root = document.createElement("div");
  root.dataset.workspaceRuntimeRoot = "true";
  const canvas = document.createElement("div");
  root.append(canvas);
  document.body.append(root);
  rect(canvas, [100, 20, 501, 639]);
  return { root, canvas };
}

function region(parent: HTMLElement, id: string, bounds: [number, number, number, number]) {
  const element = document.createElement("div");
  element.dataset.workspaceRuntimeRegion = id;
  parent.append(element);
  rect(element, bounds);
  return element;
}

function rect(element: HTMLElement, [left, top, width, height]: [number, number, number, number]) {
  vi.spyOn(element, "getBoundingClientRect").mockReturnValue({
    x: left, y: top, left, top, width, height, right: left + width, bottom: top + height, toJSON: () => ({}),
  });
}
