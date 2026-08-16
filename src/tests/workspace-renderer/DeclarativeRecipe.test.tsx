import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { WorkspaceCanvasOverlay } from "../../app/components/workspace/WorkspaceCanvasOverlay";
import type { ComponentRecipe, ComponentRecipeNode } from "../../workspace/components/componentTypes";
import { componentActionOperation } from "../../workspace/interaction/interactionOperations";
import { prepareComponentRecipe } from "../../workspace/protocol/validateWorkspaceBatch";
import type { WorkspaceCommandBatch } from "../../workspace/protocol/workspaceTypes";
import type { ProjectedComponent } from "../../workspace/renderer/contracts";
import { toRenderSnapshot } from "../../workspace/renderer/contracts";
import { WorkspaceStore } from "../../workspace/state/WorkspaceStore";

describe("declarative component recipes", () => {
  it("defines, creates, renders, binds, and invokes only declared actions", async () => {
    const user = userEvent.setup();
    const recipe = statusCardRecipe();
    const store = new WorkspaceStore();
    const initial = store.getState();
    store.apply(batch(initial, "REQ_DEFINE_CARD", [
      { op: "define_component_recipe", op_id: "OP_DEFINE_CARD", recipe },
      {
        op: "create_component",
        op_id: "OP_CREATE_CARD",
        id: "CMP_000001",
        component_type: { typeId: recipe.typeId, version: recipe.version, digest: recipe.digest },
        label: "Launch status",
        props: { title: "Launch Control" },
        durable_state: {
          status: "Go for launch",
          phase: "paused",
          durationMs: 60_000,
          remainingMs: 45_000,
          runGeneration: 1,
        },
        placement: { space: "viewport", anchor: "center", offset: { x: 0, y: 0 } },
      },
    ]));
    const snapshot = toRenderSnapshot(store.getState());
    expect(snapshot.recipes).toHaveLength(1);
    const projection: ProjectedComponent = {
      componentId: "CMP_000001",
      space: "viewport",
      left: 20,
      top: 20,
      width: 360,
      height: 320,
      zIndex: 1,
      visible: true,
      spatialOnly: false,
    };
    const actionSpy = vi.fn((request) => {
      const current = store.getState();
      store.apply(batch(current, `REQ_ACTION_${current.revision}`, [
        componentActionOperation(request, "OP_ACKNOWLEDGE"),
      ]));
    });
    render(<WorkspaceCanvasOverlay
      components={snapshot.components}
      recipes={snapshot.recipes}
      projections={new Map([["CMP_000001", projection]])}
      selectedId={null}
      onAction={actionSpy}
    />);

    expect(screen.getByRole("heading", { name: "Launch Control" })).toBeInTheDocument();
    expect(screen.getByText("Status: Go for launch")).toBeInTheDocument();
    expect(screen.getByLabelText("00:45 remaining")).toBeInTheDocument();
    expect(screen.getByRole("img", { name: "Remote tracking image" })).toHaveTextContent("Image unavailable");
    expect(document.querySelector("img[src^='https:']")).toBeNull();

    const undeclared = screen.getByRole("button", { name: "Unsafe action" });
    expect(undeclared).toBeDisabled();
    await user.click(undeclared);
    expect(actionSpy).not.toHaveBeenCalled();

    await user.click(screen.getByRole("button", { name: "Acknowledge" }));
    expect(actionSpy).toHaveBeenCalledOnce();
    expect(actionSpy).toHaveBeenCalledWith({
      componentId: "CMP_000001",
      action: "acknowledge",
      input: { source: "canvas" },
    });
    expect(store.getEventHistory()).toEqual([
      expect.objectContaining({
        componentId: "CMP_000001",
        event: "acknowledge",
        payload: { source: "canvas" },
        source: "user",
      }),
    ]);
  });

  it("fails closed to a data-preserving placeholder when render limits are exceeded", () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    let root: ComponentRecipeNode = { id: "leaf", primitive: "text", props: { text: "Too deep" } };
    for (let index = 0; index < 17; index += 1) {
      root = { id: `depth-${index}`, primitive: "stack", children: [root] };
    }
    const recipe: ComponentRecipe = {
      ...statusCardRecipe(),
      typeId: "recipe.over-budget",
      digest: "over-budget-digest",
      root,
    };
    const component = {
      id: "CMP_DEEP",
      type: { typeId: recipe.typeId, version: recipe.version, digest: recipe.digest },
      label: "Preserved deep component",
      props: {},
      durableState: {},
      placement: { space: "viewport" as const, anchor: "center" as const, offset: { x: 0, y: 0 } },
      tags: [],
      visibility: "visible" as const,
      locks: { placement: false, props: false, deletion: false, actions: false },
    };
    const rendered = render(<WorkspaceCanvasOverlay
      components={[component]}
      recipes={[recipe]}
      projections={new Map([[component.id, {
        componentId: component.id,
        space: "viewport" as const,
        left: 0,
        top: 0,
        width: 300,
        height: 200,
        zIndex: 1,
        visible: true,
        spatialOnly: false,
      }]])}
      selectedId={null}
    />);
    const placeholder = within(rendered.container).getByRole("status");
    expect(placeholder).toHaveTextContent("Preserved deep component");
    expect(placeholder).toHaveTextContent("data is still safe");
    error.mockRestore();
  });

  it("lets agents and rendered inputs use the explicit validated set_value reducer", async () => {
    const user = userEvent.setup();
    const recipe = editableStatusRecipe();
    const store = new WorkspaceStore();
    store.apply(batch(store.getState(), "REQ_EDITABLE", [{
      op: "define_component_recipe", op_id: "OP_DEFINE_EDITABLE", recipe,
    }, {
      op: "create_component", op_id: "OP_CREATE_EDITABLE", id: "CMP_EDITABLE",
      component_type: { typeId: recipe.typeId, version: recipe.version, digest: recipe.digest },
      placement: { space: "viewport", anchor: "center", offset: { x: 0, y: 0 } },
    }]));
    store.apply(batch(store.getState(), "REQ_AGENT_FILL", [{
      op: "invoke_component_action", op_id: "OP_AGENT_FILL", id: "CMP_EDITABLE",
      action: "set_value", input: { key: "status", value: "Filled by agent" },
    }]));
    expect(store.getState().components.get("CMP_EDITABLE")?.durableState.status).toBe("Filled by agent");
    expect(store.getEventHistory().at(-1)).toMatchObject({
      event: "set_value",
      payload: { key: "status", value: "Filled by agent" },
    });

    const component = toRenderSnapshot(store.getState()).components.find(({ id }) => id === "CMP_EDITABLE")!;
    const onAction = vi.fn();
    render(<WorkspaceCanvasOverlay
      components={[component]}
      recipes={[recipe]}
      projections={new Map([[component.id, {
        componentId: component.id, space: "viewport", left: 0, top: 0,
        width: 320, height: 180, zIndex: 1, visible: true, spatialOnly: false,
      }]])}
      selectedId={component.id}
      onAction={onAction}
    />);
    const input = screen.getByRole("textbox", { name: "Status" });
    expect(input).toHaveValue("Filled by agent");
    await user.clear(input);
    await user.type(input, "Filled by user{Enter}");
    expect(onAction).toHaveBeenCalledWith({
      componentId: "CMP_EDITABLE",
      action: "set_value",
      input: { key: "status", value: "Filled by user" },
    });

    const beforeInvalid = store.getRevision();
    expect(() => store.apply(batch(store.getState(), "REQ_BAD_FILL", [{
      op: "invoke_component_action", op_id: "OP_BAD_FILL", id: "CMP_EDITABLE",
      action: "set_value", input: { key: "status", value: 42 },
    }]))).toThrow(/Invalid recipe\.editable-status\.set_value input/i);
    expect(store.getRevision()).toBe(beforeInvalid);
  });
});

function editableStatusRecipe(): ComponentRecipe {
  const setValueSchema = {
    type: "object",
    additionalProperties: false,
    required: ["key", "value"],
    properties: {
      key: { const: "status" },
      value: { type: "string", maxLength: 1_000 },
    },
  } as const;
  return prepareComponentRecipe({
    typeId: "recipe.editable-status",
    version: "1.0.0",
    displayName: "Editable status",
    allowedPlacements: ["canvas2d", "surface", "billboard", "viewport"],
    propsSchema: { type: "object", additionalProperties: false },
    durableStateSchema: {
      type: "object",
      additionalProperties: false,
      required: ["status"],
      properties: { status: { type: "string", maxLength: 1_000 } },
    },
    defaultProps: {},
    defaultDurableState: { status: "Waiting" },
    writableProps: [],
    actions: {
      set_value: { effectClass: "semantic", inputSchema: setValueSchema },
    },
    events: { set_value: setValueSchema },
    root: {
      id: "status-input",
      primitive: "input",
      props: {
        label: "Status",
        action: "set_value",
        actionInput: { key: "status" },
        valueKey: "value",
        value: { $bind: "state.status" },
      },
    },
  });
}

function statusCardRecipe(): ComponentRecipe {
  const emptyObject = { type: "object", additionalProperties: false } as const;
  return prepareComponentRecipe({
    typeId: "recipe.launch-status-card",
    version: "1.0.0",
    displayName: "Launch status card",
    allowedPlacements: ["canvas2d", "surface", "billboard", "viewport"],
    propsSchema: {
      type: "object",
      additionalProperties: false,
      required: ["title"],
      properties: { title: { type: "string" } },
    },
    durableStateSchema: {
      type: "object",
      additionalProperties: false,
      required: ["status", "phase", "durationMs", "remainingMs", "runGeneration"],
      properties: {
        status: { type: "string" },
        phase: { enum: ["idle", "running", "paused", "completed"] },
        durationMs: { type: "integer", minimum: 0 },
        remainingMs: { type: "integer", minimum: 0 },
        runGeneration: { type: "integer", minimum: 0 },
      },
    },
    defaultProps: { title: "Status" },
    defaultDurableState: {
      status: "Waiting",
      phase: "idle",
      durationMs: 60_000,
      remainingMs: 60_000,
      runGeneration: 0,
    },
    writableProps: ["title"],
    actions: {
      acknowledge: {
        effectClass: "semantic",
        inputSchema: {
          type: "object",
          additionalProperties: false,
          required: ["source"],
          properties: { source: { const: "canvas" } },
        },
      },
      start: { effectClass: "semantic", inputSchema: emptyObject },
      resume: { effectClass: "semantic", inputSchema: emptyObject },
      pause: { effectClass: "semantic", inputSchema: emptyObject },
      reset: { effectClass: "semantic", inputSchema: emptyObject },
    },
    events: {
      acknowledge: {
        type: "object",
        additionalProperties: false,
        required: ["source"],
        properties: { source: { const: "canvas" } },
      },
    },
    root: {
      id: "root",
      primitive: "stack",
      props: { gap: 10 },
      children: [
        { id: "title", primitive: "text", props: { text: { $bind: "props.title" }, level: 2 } },
        { id: "status", primitive: "text", props: { text: "Status: {{state.status}}" } },
        { id: "timer", primitive: "timer", props: { label: "Window", format: "clock" } },
        { id: "remote-image", primitive: "image", props: { assetRef: "https://tracker.invalid/pixel.png", alt: "Remote tracking image" } },
        { id: "ack", primitive: "button", props: { label: "Acknowledge", action: "acknowledge", actionInput: { source: "canvas" } } },
        { id: "unsafe", primitive: "button", props: { label: "Unsafe action", action: "not_declared" } },
      ],
    },
  });
}

function batch(
  state: ReturnType<WorkspaceStore["getState"]>,
  requestId: string,
  operations: WorkspaceCommandBatch["operations"],
): WorkspaceCommandBatch {
  return {
    protocol_version: "1.0",
    request_id: requestId,
    workspace_id: state.workspaceId,
    input_revision: state.revision,
    base_workspace_revision: state.revision,
    registry_digest: state.registryDigest,
    mode: "commit",
    operations,
  };
}
