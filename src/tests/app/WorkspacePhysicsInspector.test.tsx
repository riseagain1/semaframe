import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WorkspaceInspector } from "../../app/components/workspace/WorkspaceInspector";
import type { PhysicsBodyReport } from "../../workspace/physics";
import type { WorkspaceRenderComponent } from "../../workspace/renderer/contracts";

afterEach(cleanup);

const component: WorkspaceRenderComponent = {
  id: "CMP_PHYSICS",
  type: { typeId: "spatial-entity", version: "1.5.0", digest: "physics-digest" },
  label: "Physics crate",
  props: {
    assetId: "primitive_box",
    entityKind: "primitive",
    collision: { enabled: true, role: "solid", shape: "asset_bounds", margin: 0.02 },
    physics: {
      enabled: true,
      bodyType: "static", massKg: 1, centerOfMass: { x: 0, y: 0, z: 0 },
      friction: 0.6, restitution: 0.1, gravityScale: 1, stabilityMode: "report", constraints: [],
    },
  },
  durableState: {},
  placement: {
    space: "world3d",
    position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0 }, scale: { x: 1, y: 1, z: 1 },
  },
  tags: [],
  visibility: "visible",
  locks: { placement: false, resize: false, visualEffects: false, props: false, deletion: false, actions: false },
};

const report: PhysicsBodyReport = {
  componentId: "CMP_PHYSICS",
  enabled: true,
  bodyType: "static",
  massKg: 1,
  centerOfMassWorld: { x: 0, y: 0.5, z: 0 },
  friction: 0.6,
  restitution: 0.1,
  gravityScale: 1,
  stabilityMode: "report",
  stable: true,
  grounded: true,
  stabilityReason: "anchored",
  supportPolygon: [{ x: -0.5, z: -0.5 }, { x: 0.5, z: -0.5 }, { x: 0.5, z: 0.5 }],
  stabilityMarginM: 0.5,
  supports: [{
    componentId: "CMP_PHYSICS",
    kind: "ground",
    contactHeight: 0,
    contactAreaM2: 1,
    grounded: true,
  }],
  constraints: [],
};

describe("Workspace physics Inspector", () => {
  it("shows live feasibility and emits one complete validated physics object", async () => {
    const user = userEvent.setup();
    const onUpdate = vi.fn();
    render(<WorkspaceInspector component={component} physicsReport={report} onUpdate={onUpdate} />);

    expect(screen.getByRole("heading", { name: "Physics validation" })).toBeVisible();
    expect(screen.getByText("Stable")).toBeVisible();
    expect(screen.getByRole("checkbox", { name: "Physics enabled" })).toBeChecked();
    expect(screen.getByText("0.500 m")).toBeVisible();
    await user.selectOptions(screen.getByRole("combobox", { name: "Body type" }), "dynamic");
    const mass = screen.getByRole("spinbutton", { name: "Mass (kg)" });
    await user.clear(mass);
    await user.type(mass, "12.5");
    await user.selectOptions(screen.getByRole("combobox", { name: "Stability" }), "enforce");
    await user.click(screen.getByRole("button", { name: "Apply physics" }));

    expect(onUpdate).toHaveBeenCalledWith({
      componentId: "CMP_PHYSICS",
      props: { physics: {
        enabled: true,
        bodyType: "dynamic", massKg: 12.5, centerOfMass: { x: 0, y: 0, z: 0 },
        friction: 0.6, restitution: 0.1, gravityScale: 1, stabilityMode: "enforce", constraints: [],
      } },
    });
  });

  it("disables participation while retaining the configured attributes", async () => {
    const user = userEvent.setup();
    const onUpdate = vi.fn();
    render(<WorkspaceInspector component={component} physicsReport={{ ...report, enabled: false, stabilityReason: "disabled", supportPolygon: [], stabilityMarginM: null, supports: [] }} onUpdate={onUpdate} />);
    expect(screen.getByText("Disabled")).toBeVisible();
    await user.click(screen.getByRole("checkbox", { name: "Physics enabled" }));
    expect(screen.getByRole("spinbutton", { name: "Mass (kg)" })).toBeDisabled();
    expect(screen.getByText(/Collision remains independently controlled/i)).toBeVisible();
    await user.click(screen.getByRole("button", { name: "Apply physics" }));
    expect(onUpdate).toHaveBeenCalledWith({
      componentId: "CMP_PHYSICS",
      props: { physics: expect.objectContaining({ enabled: false, massKg: 1, friction: 0.6 }) },
    });
  });

  it("edits an explicit collision box without weakening closed validation", async () => {
    const user = userEvent.setup();
    const onUpdate = vi.fn();
    render(<WorkspaceInspector component={component} onUpdate={onUpdate} />);
    await user.selectOptions(screen.getByRole("combobox", { name: "Shape" }), "box");
    const sizeInputs = screen.getByRole("group", { name: "Box size (m)" }).querySelectorAll("input");
    await user.clear(sizeInputs[0]!);
    await user.type(sizeInputs[0]!, "2");
    await user.click(screen.getByRole("button", { name: "Apply collision" }));
    expect(onUpdate).toHaveBeenCalledWith(expect.objectContaining({
      props: { collision: expect.objectContaining({ shape: "box", size: { x: 2, y: 1, z: 1 } }) },
    }));
  });
});
