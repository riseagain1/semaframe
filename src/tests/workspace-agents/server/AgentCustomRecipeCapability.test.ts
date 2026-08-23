import { describe, expect, it } from "vitest";
import type { Box2DResizePolicy, ComponentResizePolicies } from "../../../workspace/components/componentTypes";
import { prepareComponentRecipe } from "../../../workspace/protocol";
import type { WorkspaceCommandBatch } from "../../../workspace/protocol/workspaceTypes";
import { WorkspaceStoreEngineAdapter } from "../../../workspace/agents/WorkspaceStoreEngineAdapter";
import {
  DEFAULT_WORKSPACE_AGENT_SCOPES,
  type WorkspaceAgentPrincipal,
  type WorkspacePreparedEnvelope,
} from "../../../workspace/agents/contracts";
import { WorkspaceStore } from "../../../workspace/state";

describe("Agent custom recipe capability", () => {
  it("defaults to bounded recipe authority and defines then creates a new pinned type in two transactions", async () => {
    expect(DEFAULT_WORKSPACE_AGENT_SCOPES).toContain("component:recipe_define");
    const store = new WorkspaceStore();
    let requestSequence = 0;
    const adapter = new WorkspaceStoreEngineAdapter(store, {
      requestId: () => `custom_recipe_request_${++requestSequence}`,
    });
    const actor: WorkspaceAgentPrincipal = {
      sessionId: "session_recipe",
      clientId: "client_recipe",
      clientName: "Custom component agent",
      scopes: [
        "workspace:read",
        "workspace:write",
        "component:create",
        "component:recipe_define",
      ],
    };
    const canonicalRecipe = prepareComponentRecipe({
      typeId: "recipe.focus-meter",
      version: "1.0.0",
      displayName: "Focus meter",
      allowedPlacements: ["canvas2d", "surface", "billboard", "viewport"],
      resizePolicy: uiResizePolicy(),
      propsSchema: {
        type: "object",
        additionalProperties: false,
        required: ["title"],
        properties: { title: { type: "string", maxLength: 120 } },
      },
      durableStateSchema: {
        type: "object",
        additionalProperties: false,
        required: ["value"],
        properties: { value: { type: "number", minimum: 0, maximum: 100 } },
      },
      defaultProps: { title: "Focus" },
      defaultDurableState: { value: 50 },
      writableProps: ["title"],
      actions: {},
      events: {},
      root: {
        id: "root",
        primitive: "stack",
        props: { gap: 8 },
        children: [
          { id: "heading", primitive: "text", props: { text: "{{props.title}}", level: 2 } },
          { id: "value", primitive: "text", props: { text: "Focus: {{state.value}}%" } },
        ],
      },
    });

    const definition = await adapter.prepare("Define a reusable focus meter", 1, actor);
    const definitionReceipt = await adapter.submit(definition, batch(definition.envelope, [{
      op: "define_component_recipe",
      op_id: "define_focus_meter",
      recipe: { ...canonicalRecipe, digest: "auto" },
    }]), actor);
    expect(definitionReceipt).toMatchObject({
      resultingWorkspaceRevision: 1,
      resolvedBatch: {
        operations: [{
          op: "define_component_recipe",
          recipe: { typeId: canonicalRecipe.typeId, digest: canonicalRecipe.digest },
        }],
      },
    });
    expect(store.getState().recipes.get("recipe.focus-meter@1.0.0")?.digest).toBe(canonicalRecipe.digest);

    const creation = await adapter.prepare("Create one focus meter instance", 1, actor);
    const capability = creation.capability_manifest as Record<string, unknown>;
    expect(capability).toMatchObject({
      component_type_count: 21,
      component_types: expect.arrayContaining([expect.objectContaining({
        typeId: canonicalRecipe.typeId,
        version: canonicalRecipe.version,
        digest: canonicalRecipe.digest,
        trustTier: "declarative",
      })]),
    });
    const id = creation.reserved_component_ids[0]!;
    await adapter.submit(creation, batch(creation.envelope, [{
      op: "create_component",
      op_id: "create_focus_meter",
      id,
      component_type: {
        typeId: canonicalRecipe.typeId,
        version: canonicalRecipe.version,
        digest: canonicalRecipe.digest,
      },
      label: "My focus meter",
      placement: {
        space: "viewport",
        anchor: "top_right",
        offset: { x: -24, y: 64 },
        size: { width: 280, height: 160 },
      },
    }]), actor);

    expect(store.getState().components.get(id)).toMatchObject({
      label: "My focus meter",
      type: { typeId: canonicalRecipe.typeId, digest: canonicalRecipe.digest },
      props: { title: "Focus" },
      durableState: { value: 50 },
      provenance: { createdBy: "agent" },
    });
  });

  it("rejects regex-bearing recipe schemas before synchronous AJV evaluation", async () => {
    const store = new WorkspaceStore();
    const adapter = new WorkspaceStoreEngineAdapter(store, {
      requestId: () => "regex_recipe_request",
    });
    const actor: WorkspaceAgentPrincipal = {
      sessionId: "session_regex_recipe",
      clientId: "client_regex_recipe",
      clientName: "Regex recipe agent",
      scopes: ["workspace:read", "workspace:write", "component:recipe_define"],
    };
    const recipe = prepareComponentRecipe({
      typeId: "recipe.regex-card",
      version: "1.0.0",
      displayName: "Regex card",
      allowedPlacements: ["viewport"],
      propsSchema: {
        type: "object",
        properties: { value: { type: "string", pattern: "^(a+)+$" } },
      },
      durableStateSchema: { type: "object", additionalProperties: false },
      defaultProps: { value: "safe" },
      defaultDurableState: {},
      writableProps: ["value"],
      actions: {},
      events: {},
      root: { id: "root", primitive: "text", props: { text: "{{props.value}}" } },
    });
    const prepared = await adapter.prepare("Define a regex recipe", 1, actor);

    await expect(adapter.submit(prepared, batch(prepared.envelope, [{
      op: "define_component_recipe",
      op_id: "define_regex_recipe",
      recipe: { ...recipe, digest: "auto" },
    }]), actor)).rejects.toThrow(/forbidden regex keyword pattern/u);
    expect(store.getRevision()).toBe(0);
    expect(store.getState().recipes.size).toBe(0);
  });
});

function uiResizePolicy(): ComponentResizePolicies {
  const box = (): Box2DResizePolicy => ({
    kind: "box2d",
    mode: "free",
    defaultSize: { width: 320, height: 180 },
    minSize: { width: 160, height: 100 },
    maxSize: { width: 1_920, height: 1_080 },
    allowedAxes: ["width", "height"],
    units: "px",
  });
  return { canvas2d: box(), surface: box(), billboard: box(), viewport: box() };
}

function batch(
  envelope: WorkspacePreparedEnvelope,
  operations: WorkspaceCommandBatch["operations"],
): WorkspaceCommandBatch {
  return { ...envelope, protocol_version: "1.1", mode: "commit", operations: [...operations] };
}
