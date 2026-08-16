import { describe, expect, it } from "vitest";
import {
  MAX_RECIPE_DEPTH,
  prepareComponentRecipe,
  validateComponentRecipe,
  validateWorkspaceCommandBatch,
  WorkspaceValidationError,
} from "../../workspace/protocol";
import type { ComponentRecipeNode } from "../../workspace/components";
import { DEFAULT_COMPONENT_REGISTRY } from "../../workspace/components";
import { WorkspaceStore } from "../../workspace/state";
import { workspaceBatch } from "./helpers";

describe("Workspace Protocol 1.1 validation", () => {
  it("accepts the closed batch and rejects unknown fields", () => {
    const store = new WorkspaceStore();
    const valid = workspaceBatch(store, "req_valid", [{
      op: "create_component",
      op_id: "create_text",
      id: "CMP_000001",
      component_type: {
        typeId: "text",
        version: store.getComponentManifest("text")!.version,
        digest: store.getComponentManifest("text")!.digest,
      },
      placement: { space: "viewport", anchor: "top", offset: { x: 0, y: 16 } },
      props: { text: "hello" },
    }]);
    expect(validateWorkspaceCommandBatch(valid)).toEqual(valid);
    expect(() => validateWorkspaceCommandBatch({ ...valid, surprise: true })).toThrow(WorkspaceValidationError);
    expect(() => validateWorkspaceCommandBatch({
      ...valid,
      operations: [{ ...valid.operations[0], surprise: true }],
    })).toThrow(/must NOT have additional properties/);
  });

  it("accepts bounded closed component transitions only in protocol 1.2", () => {
    const store = new WorkspaceStore();
    const operation = {
      op: "place_component" as const,
      op_id: "move_with_transition",
      id: "CMP_000001",
      placement: { space: "viewport" as const, anchor: "center" as const, offset: { x: 40, y: 20 } },
      transition: { durationMs: 360, delayMs: 40, easing: "ease_out" as const },
    };
    const batch = workspaceBatch(store, "transition", [operation]);
    expect(validateWorkspaceCommandBatch(batch).operations[0]).toEqual(operation);

    expect(() => validateWorkspaceCommandBatch({
      ...batch,
      operations: [{ ...operation, transition: { ...operation.transition, spring: 0.4 } }],
    })).toThrow(/additional properties/i);
    expect(() => validateWorkspaceCommandBatch({
      ...batch,
      operations: [{ ...operation, transition: { ...operation.transition, durationMs: 60_001 } }],
    })).toThrow(/must be <= 60000/i);
    expect(() => validateWorkspaceCommandBatch({ ...batch, protocol_version: "1.1" }))
      .toThrow(/require Workspace Protocol 1.2/i);

    const presentView = workspaceBatch(store, "view_transition", [{
      op: "present_view",
      op_id: "view_transition",
      view: {
        id: "VIEW_TRANSITION",
        label: "Unsupported transition",
        componentIds: [],
        transition: { durationMs: 120 },
      },
    } as never]);
    expect(() => validateWorkspaceCommandBatch(presentView)).toThrow(/additional properties/i);
  });

  it("accepts explicit manifest upgrades only in protocol 1.2", () => {
    const store = new WorkspaceStore();
    const operation = {
      op: "upgrade_component_manifest" as const,
      op_id: "upgrade_legacy_panel",
      id: "CMP_000001",
      component_type: DEFAULT_COMPONENT_REGISTRY.ref("panel"),
    };
    const batch = workspaceBatch(store, "upgrade_legacy_panel", [operation]);
    expect(validateWorkspaceCommandBatch(batch).operations[0]).toEqual(operation);
    expect(() => validateWorkspaceCommandBatch({ ...batch, protocol_version: "1.1" }))
      .toThrow(/upgrade_component_manifest requires Workspace Protocol 1.2/i);
  });

  it("rejects duplicate operation IDs and dangerous recursive keys", () => {
    const store = new WorkspaceStore();
    const operation = {
      op: "present_view" as const,
      op_id: "same",
      view: { id: "VIEW_1", label: "View", componentIds: [] },
    };
    expect(() => validateWorkspaceCommandBatch(workspaceBatch(store, "dup", [operation, operation])))
      .toThrow(/Duplicate op_id/);
    const poisoned = JSON.parse('{"safe":{"__proto__":{"polluted":true}}}');
    expect(() => validateWorkspaceCommandBatch({
      ...workspaceBatch(store, "poison", [operation]),
      operations: [{ ...operation, view: { ...operation.view, camera: poisoned } }],
    })).toThrow(/Dangerous key/);
  });

  it("pins recipe digests and enforces deterministic node/depth quotas", () => {
    const recipe = prepareComponentRecipe({
      typeId: "recipe.launch-card",
      version: "1.0.0",
      displayName: "Launch card",
      allowedPlacements: ["viewport"],
      propsSchema: { type: "object", additionalProperties: false, properties: { title: { type: "string" } } },
      durableStateSchema: { type: "object", additionalProperties: false },
      defaultProps: { title: "Launch" },
      defaultDurableState: {},
      writableProps: ["title"],
      actions: {},
      events: {},
      root: { id: "root", primitive: "stack", children: [{ id: "title", primitive: "text" }] },
    });
    expect(() => validateComponentRecipe(recipe)).not.toThrow();
    expect(() => validateComponentRecipe({ ...recipe, displayName: "tampered" })).toThrow(/digest mismatch/i);

    const store = new WorkspaceStore();
    const wireRecipe = { ...recipe, digest: "auto" };
    const wireBatch = workspaceBatch(store, "define_auto_recipe", [{
      op: "define_component_recipe",
      op_id: "define_auto_recipe",
      recipe: wireRecipe,
    }]);
    const resolvedBatch = validateWorkspaceCommandBatch(wireBatch);
    expect(wireRecipe.digest).toBe("auto");
    expect(resolvedBatch.operations[0]).toMatchObject({
      op: "define_component_recipe",
      recipe: { typeId: recipe.typeId, digest: recipe.digest },
    });
    const committed = store.applyDetailed(wireBatch);
    expect(store.getState().recipes.get(`${recipe.typeId}@${recipe.version}`)?.digest).toBe(recipe.digest);
    expect(committed.command.resolvedOperations[0]).toMatchObject({
      op: "define_component_recipe",
      recipe: { digest: recipe.digest },
    });

    const recipeDraft = { ...recipe };
    delete (recipeDraft as { digest?: string }).digest;
    const regexRecipe = prepareComponentRecipe({
      ...recipeDraft,
      propsSchema: {
        type: "object",
        properties: { title: { type: "string", pattern: "^(a+)+$" } },
      },
    });
    expect(() => validateComponentRecipe(regexRecipe)).toThrow(/forbidden regex keyword pattern/u);

    const patternPropertiesRecipe = prepareComponentRecipe({
      ...recipeDraft,
      propsSchema: {
        type: "object",
        patternProperties: { "^(a+)+$": { type: "string" } },
      },
    });
    expect(() => validateComponentRecipe(patternPropertiesRecipe)).toThrow(
      /forbidden regex keyword patternProperties/u,
    );

    const refBypassRecipe = prepareComponentRecipe({
      ...recipeDraft,
      propsSchema: {
        $ref: "#/payload",
        payload: { type: "string", pattern: "^(a+)+$" },
      },
    });
    expect(() => validateComponentRecipe(refBypassRecipe)).toThrow(/forbidden reference keyword \$ref/u);

    const combinatorRecipe = prepareComponentRecipe({
      ...recipeDraft,
      propsSchema: { allOf: [{ type: "object" }, { maxProperties: 8 }] },
    });
    expect(() => validateComponentRecipe(combinatorRecipe)).toThrow(/complexity keyword allOf/u);

    const uniqueItemsRecipe = prepareComponentRecipe({
      ...recipeDraft,
      propsSchema: { type: "array", uniqueItems: true, items: { type: "object" } },
    });
    expect(() => validateComponentRecipe(uniqueItemsRecipe)).toThrow(/complexity keyword uniqueItems/u);

    const { resizePolicy: _resizePolicy, ...recipeWithoutResizePolicy } = recipe;
    const explicitBatch = workspaceBatch(new WorkspaceStore(), "define_explicit_recipe", [{
      op: "define_component_recipe",
      op_id: "define_explicit_recipe",
      recipe: {
        ...recipeWithoutResizePolicy,
        typeId: "recipe.explicit-launch-card",
        digest: "auto",
      },
    }]);
    const autoResolved = validateWorkspaceCommandBatch(explicitBatch);
    const autoRecipe = autoResolved.operations[0]?.op === "define_component_recipe"
      ? autoResolved.operations[0].recipe
      : undefined;
    if (!autoRecipe) throw new Error("Expected resolved recipe");
    const explicitResolved = validateWorkspaceCommandBatch({
      ...explicitBatch,
      request_id: "define_explicit_recipe_pinned",
      operations: [{
        ...explicitBatch.operations[0]!,
        op_id: "define_explicit_recipe_pinned",
        recipe: { ...recipeWithoutResizePolicy, typeId: autoRecipe.typeId, digest: autoRecipe.digest },
      }],
    });
    expect(explicitResolved.operations[0]).toMatchObject({
      op: "define_component_recipe",
      recipe: {
        digest: autoRecipe.digest,
        resizePolicy: { viewport: { kind: "box2d", mode: "free" } },
      },
    });

    const spatialRecipe = {
      ...recipe,
      typeId: "recipe.unsupported-spatial",
      digest: "auto",
      allowedPlacements: ["world3d"] as const,
      resizePolicy: {
        world3d: {
          kind: "scale3d" as const,
          mode: "free" as const,
          defaultScale: { x: 1, y: 1, z: 1 },
          minScale: { x: 0.01, y: 0.01, z: 0.01 },
          maxScale: { x: 100, y: 100, z: 100 },
          allowedAxes: ["x", "y", "z"] as const,
          units: "ratio" as const,
        },
      },
    };
    expect(() => validateWorkspaceCommandBatch(workspaceBatch(store, "reject_spatial_recipe", [{
      op: "define_component_recipe", op_id: "reject_spatial_recipe", recipe: spatialRecipe,
    }] as never))).toThrow(/does not match protocol/i);

    let root: ComponentRecipeNode = { id: `node_${MAX_RECIPE_DEPTH + 1}`, primitive: "stack" };
    for (let depth = MAX_RECIPE_DEPTH; depth >= 0; depth -= 1) {
      root = { id: `node_${depth}`, primitive: "stack", children: [root] };
    }
    const { digest: _digest, ...recipeWithoutDigest } = recipe;
    const deep = prepareComponentRecipe({ ...recipeWithoutDigest, root });
    expect(() => validateComponentRecipe(deep)).toThrow(/exceeds depth/);
  });
});
