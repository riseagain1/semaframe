import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WorkspaceInspector } from "../../app/components/workspace/WorkspaceInspector";
import type { WorkspaceRenderComponent } from "../../workspace/renderer/contracts";

afterEach(cleanup);

function spatial(): WorkspaceRenderComponent {
  return {
    id: "CMP_SPATIAL",
    type: { typeId: "spatial-entity", version: "1.3.0", digest: "spatial-digest" },
    label: "Wooden table",
    props: {
      assetId: "table_wood_simple_01",
      entityKind: "prop",
      collision: { enabled: true, role: "solid", shape: "asset_bounds", margin: 0.02 },
    },
    durableState: {},
    placement: {
      space: "world3d",
      position: { x: 0, y: 0, z: 0 },
      rotation: { x: 0, y: 0, z: 0 },
      scale: { x: 2, y: 1, z: 1 },
    },
    tags: [],
    visibility: "visible",
    locks: { placement: false, resize: false, visualEffects: false, props: false, deletion: false, actions: false },
  };
}

describe("spatial collision Inspector", () => {
  it("shows asset-derived dimensions and emits one closed collision update", async () => {
    const user = userEvent.setup();
    const onUpdate = vi.fn();
    render(<WorkspaceInspector component={spatial()} onUpdate={onUpdate} />);

    expect(screen.getByRole("heading", { name: "Collision volume" })).toBeVisible();
    expect(screen.getByText("3.24 m")).toBeVisible();
    expect(screen.getByText("0.80 m")).toBeVisible();
    expect(screen.getByText("0.89 m")).toBeVisible();
    await user.selectOptions(screen.getByRole("combobox", { name: "Role" }), "trigger");
    const margin = screen.getByRole("spinbutton", { name: "Margin (m)" });
    await user.clear(margin);
    await user.type(margin, "0.1");
    await user.click(screen.getByRole("button", { name: "Apply collision" }));

    expect(onUpdate).toHaveBeenCalledWith({
      componentId: "CMP_SPATIAL",
      props: { collision: { enabled: true, role: "trigger", shape: "asset_bounds", margin: 0.1 } },
    });
  });

  it("validates margin and respects the property lock", async () => {
    const user = userEvent.setup();
    const onUpdate = vi.fn();
    const view = render(<WorkspaceInspector component={spatial()} onUpdate={onUpdate} />);
    const margin = screen.getByRole("spinbutton", { name: "Margin (m)" });
    await user.clear(margin);
    await user.type(margin, "11");
    await user.click(screen.getByRole("button", { name: "Apply collision" }));
    expect(screen.getByRole("alert")).toHaveTextContent(/between 0 and 10/i);
    expect(onUpdate).not.toHaveBeenCalled();

    view.rerender(<WorkspaceInspector
      component={{ ...spatial(), locks: { ...spatial().locks, props: true } }}
      onUpdate={onUpdate}
    />);
    expect(screen.getByRole("combobox", { name: "Role" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Apply collision" })).toBeDisabled();
  });
});
