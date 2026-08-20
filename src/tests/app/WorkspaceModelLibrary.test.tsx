import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  WorkspaceChrome,
  WorkspaceModelLibrary,
} from "../../app/components/workspace";
import type { ModelDefinition } from "../../workspace/modeling";
import type { WorkspaceRenderComponent } from "../../workspace/renderer";

afterEach(cleanup);

function definition(): ModelDefinition {
  return {
    formatVersion: "1.0",
    generatorVersion: "1.0.0",
    modelId: "com.semaframe.fixture",
    version: "1.2.0",
    displayName: "Fixture",
    digest: "sha256:7eb32a9ff38eddf0aaef03567c6debbf305d13328a6383a73fc8c6536562a720",
    rootNodeId: "ASSEMBLY",
    sourceRevision: 12,
    nodes: [{
      nodeId: "ASSEMBLY",
      sourceComponentId: "ASSEMBLY",
      componentType: { typeId: "model-assembly", version: "1.0.0", digest: "manifest-assembly" },
      label: "Fixture",
      props: { collisionPolicy: "external_only" },
      durableState: {},
      placement: {
        space: "world3d",
        position: { x: 0, y: 0, z: 0 },
        rotation: { x: 0, y: 0, z: 0 },
        scale: { x: 1, y: 1, z: 1 },
      },
      tags: ["model"],
      visibility: "visible",
    }, {
      nodeId: "PART",
      sourceComponentId: "PART",
      parentNodeId: "ASSEMBLY",
      componentType: { typeId: "spatial-primitive", version: "1.0.0", digest: "manifest-primitive" },
      label: "Part",
      props: { geometry: { kind: "box", sizeM: { x: 1, y: 1, z: 1 } } },
      durableState: {},
      placement: {
        space: "world3d",
        position: { x: 0, y: 0.5, z: 0 },
        rotation: { x: 0, y: 0, z: 0 },
        scale: { x: 1, y: 1, z: 1 },
      },
      tags: [],
      visibility: "visible",
    }],
  };
}

describe("Workspace model library", () => {
  it("validates identity fields and publishes the selected assembly as one explicit request", async () => {
    const user = userEvent.setup();
    const onPublish = vi.fn(() => true);
    render(<WorkspaceModelLibrary
      definitions={[]}
      selectedAssembly={{ id: "ASSEMBLY", label: "Adjustable Fixture" }}
      onPublish={onPublish}
    />);

    expect(screen.getByRole("textbox", { name: "Model ID" })).toHaveValue("com.semaframe.adjustable.fixture");
    expect(screen.getByRole("textbox", { name: "Version" })).toHaveValue("1.0.0");
    const modelId = screen.getByRole("textbox", { name: "Model ID" });
    await user.clear(modelId);
    await user.type(modelId, "1 invalid model");
    await user.click(screen.getByRole("button", { name: "Publish immutable model" }));
    expect(screen.getByRole("alert")).toHaveTextContent("Model ID must start with a letter");
    expect(onPublish).not.toHaveBeenCalled();

    await user.clear(modelId);
    await user.type(modelId, "com.example.adjustable-fixture");
    await user.click(screen.getByRole("button", { name: "Publish immutable model" }));
    expect(onPublish).toHaveBeenCalledWith({
      rootId: "ASSEMBLY",
      modelId: "com.example.adjustable-fixture",
      version: "1.0.0",
      displayName: "Adjustable Fixture",
    });
  });

  it("shows immutable identity metadata and supports extensible export, instance, and confirmed delete actions", async () => {
    const user = userEvent.setup();
    const model = definition();
    const onInstantiate = vi.fn(() => true);
    const onUsda = vi.fn(() => true);
    const onStep = vi.fn(() => true);
    const onUnsupported = vi.fn(() => true);
    const onDelete = vi.fn()
      .mockReturnValueOnce(false)
      .mockReturnValueOnce(true);
    render(<WorkspaceModelLibrary
      definitions={[model]}
      onInstantiate={onInstantiate}
      exportActions={[
        { id: "usda", label: "Export USDA", onExport: onUsda },
        { id: "step", label: "Export STEP", onExport: onStep },
        {
          id: "unsupported",
          label: "Export advanced STEP",
          onExport: onUnsupported,
          isAvailable: () => false,
          unavailableReason: "This definition uses geometry outside the STEP subset.",
        },
      ]}
      onDelete={onDelete}
    />);

    expect(screen.getByText("com.semaframe.fixture@1.2.0")).toBeVisible();
    expect(screen.getByTitle(model.digest)).toHaveTextContent(model.digest);
    expect(screen.getByText("2", { selector: "dd" })).toBeVisible();
    expect(screen.getByRole("button", { name: "Export advanced STEP" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Export advanced STEP" })).toHaveAttribute(
      "title",
      "This definition uses geometry outside the STEP subset.",
    );
    const unsupportedExplanation = screen.getByText(/This definition uses geometry outside the STEP subset/);
    expect(unsupportedExplanation).toBeVisible();
    expect(screen.getByRole("button", { name: "Export advanced STEP" }))
      .toHaveAttribute("aria-describedby", unsupportedExplanation.id);
    await user.click(screen.getByRole("button", { name: "Add instance" }));
    await user.click(screen.getByRole("button", { name: "Export USDA" }));
    await user.click(screen.getByRole("button", { name: "Export STEP" }));
    expect(onInstantiate).toHaveBeenCalledWith(model);
    expect(onUsda).toHaveBeenCalledWith(model);
    expect(onStep).toHaveBeenCalledWith(model);
    expect(onUnsupported).not.toHaveBeenCalled();

    await user.click(screen.getByRole("button", { name: "Delete" }));
    expect(screen.getByRole("alertdialog")).toHaveTextContent("Deletion is blocked while a live instance");
    expect(onDelete).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: "Delete definition" }));
    expect(onDelete).toHaveBeenCalledWith(model);
    expect(screen.getByRole("alertdialog")).toBeVisible();
    await user.click(screen.getByRole("button", { name: "Delete definition" }));
    expect(onDelete).toHaveBeenCalledTimes(2);
    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
  });

  it("provides a visible hierarchy path for selecting otherwise empty assembly roots", async () => {
    const user = userEvent.setup();
    const onSelectComponent = vi.fn();
    render(<WorkspaceModelLibrary
      definitions={[]}
      hierarchyItems={[
        { id: "STAGE", label: "3D Stage", typeId: "stage-3d", depth: 0 },
        { id: "ROOT", label: "Empty fixture root", typeId: "model-assembly", depth: 0 },
        { id: "PART", label: "Exact bracket", typeId: "spatial-primitive", parentId: "ROOT", depth: 1 },
      ]}
      selectedComponentId="PART"
      onSelectComponent={onSelectComponent}
    />);

    const tree = screen.getByRole("tree", { name: "Editable model components" });
    expect(within(tree).getByRole("button", { name: "3D Stage" })).toHaveTextContent("Stage");
    expect(within(tree).getByRole("treeitem", { name: /Empty fixture root/i }))
      .toHaveAttribute("aria-level", "1");
    expect(within(tree).getByRole("treeitem", { name: /Exact bracket/i }))
      .toHaveAttribute("aria-selected", "true");
    await user.click(within(tree).getByRole("button", { name: /Empty fixture root/i }));
    expect(onSelectComponent).toHaveBeenCalledWith("ROOT");
  });

  it("opens from WorkspaceChrome and only offers publishing for a selected assembly", async () => {
    const user = userEvent.setup();
    const selected: WorkspaceRenderComponent = {
      id: "ASSEMBLY",
      type: { typeId: "model-assembly", version: "1.0.0", digest: "manifest-assembly" },
      label: "Bench Model",
      props: {},
      durableState: {},
      placement: {
        space: "world3d",
        position: { x: 0, y: 0, z: 0 },
        rotation: { x: 0, y: 0, z: 0 },
        scale: { x: 1, y: 1, z: 1 },
      },
      tags: [],
      visibility: "visible",
      locks: { placement: false, resize: false, visualEffects: false, props: false, deletion: false, actions: false },
    };
    const view = render(<WorkspaceChrome
      catalog={[]}
      selected={selected}
      sources={[]}
      onCreate={vi.fn()}
      onUpdate={vi.fn()}
      onAction={vi.fn()}
      onCreateShowcase={vi.fn()}
      modelDefinitions={[]}
      onPublishModel={vi.fn()}
    />);

    await user.click(screen.getByRole("button", { name: "Models" }));
    expect(screen.getByRole("region", { name: "models panel" })).toBeVisible();
    expect(screen.getByText(/Capture/)).toHaveTextContent("Bench Model");
    expect(screen.getByRole("textbox", { name: "Display name" })).toHaveValue("Bench Model");

    const scrollContent = view.container.querySelector<HTMLElement>(".workspace-tool-panel__content")!;
    const fixedHeader = view.container.querySelector<HTMLElement>(".workspace-tool-panel__header")!;
    const closeButton = screen.getByRole("button", { name: "Close models panel" });
    expect(fixedHeader).toContainElement(closeButton);
    expect(scrollContent).not.toContainElement(closeButton);
    scrollContent.scrollTop = 240;
    scrollContent.scrollLeft = 20;

    await user.click(screen.getByRole("button", { name: "Inspector" }));
    expect(screen.getByRole("region", { name: "inspector panel" })).toBeVisible();
    expect(scrollContent.scrollTop).toBe(0);
    expect(scrollContent.scrollLeft).toBe(0);
    expect(fixedHeader).toHaveTextContent("Inspector");
    expect(screen.getByRole("button", { name: "Close inspector panel" })).toBeVisible();

    scrollContent.scrollTop = 160;
    await user.click(screen.getByRole("button", { name: "Models" }));
    expect(scrollContent.scrollTop).toBe(0);
    expect(fixedHeader).toHaveTextContent("Models");
  });

  it("prevents duplicate heavy exports while an async geometry worker is active", async () => {
    const user = userEvent.setup();
    let finish: (() => void) | undefined;
    const onExport = vi.fn(() => new Promise<void>((resolve) => { finish = resolve; }));
    render(<WorkspaceModelLibrary
      definitions={[definition()]}
      exportActions={[
        { id: "stl", label: "STL", onExport },
        { id: "step", label: "STEP", onExport: vi.fn() },
      ]}
    />);

    await user.click(screen.getByRole("button", { name: "STL" }));
    expect(screen.getByRole("button", { name: "Exporting…" })).toHaveAttribute("aria-busy", "true");
    expect(screen.getByRole("button", { name: "STEP" })).toBeDisabled();
    expect(onExport).toHaveBeenCalledTimes(1);
    finish?.();
    await waitFor(() => expect(screen.getByRole("button", { name: "STL" })).toBeEnabled());
  });
});
