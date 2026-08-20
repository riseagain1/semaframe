import Ajv2020, { type ErrorObject, type ValidateFunction } from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import {
  defaultRecipeResizePolicies,
  type ComponentRecipe,
  type ComponentRecipeNode,
  type ComponentResizePolicies,
} from "../components/componentTypes";
import {
  findUnsafeJsonSchemaKeyword,
  MAX_UNTRUSTED_JSON_SCHEMA_BYTES,
} from "../components/jsonSchemaSafety";
import { deterministicDigest } from "../components/manifestDigest";
import {
  assertWorkspaceResourceInputSafe,
  WorkspaceResourceValidationError,
} from "../data/resourceSecurity";
import workspaceProtocolSchema from "./workspaceProtocol.schema.json";
import {
  MAX_WORKSPACE_BATCH_BYTES,
  MAX_WORKSPACE_JSON_DEPTH,
  type WorkspaceCommandBatch,
} from "./workspaceTypes";

export const MAX_RECIPE_NODES = 256;
export const MAX_RECIPE_DEPTH = 16;
export const MAX_RECIPE_SCHEMA_BYTES = MAX_UNTRUSTED_JSON_SCHEMA_BYTES;

export class WorkspaceValidationError extends Error {
  constructor(message: string, readonly code: string, readonly details: string[] = []) {
    super(message);
    this.name = "WorkspaceValidationError";
  }
}

const ajv = new Ajv2020({ allErrors: true, strict: true, strictNumbers: true });
addFormats(ajv);
const batchValidator: ValidateFunction<WorkspaceCommandBatch> =
  ajv.compile<WorkspaceCommandBatch>(workspaceProtocolSchema);

function schemaErrors(errors: ErrorObject[] | null | undefined): string[] {
  return (errors ?? []).slice(0, 16).map((error) =>
    `${error.instancePath || "/"} ${error.message ?? error.keyword}`,
  );
}

function byteLength(value: unknown): number {
  return new TextEncoder().encode(JSON.stringify(value)).byteLength;
}

function inspectJSON(
  value: unknown,
  path: string,
  depth: number,
  seen: Set<object>,
): void {
  if (depth > MAX_WORKSPACE_JSON_DEPTH) {
    throw new WorkspaceValidationError(`JSON exceeds depth ${MAX_WORKSPACE_JSON_DEPTH} at ${path}`, "json_too_deep");
  }
  if (!value || typeof value !== "object") return;
  if (seen.has(value)) throw new WorkspaceValidationError(`Cyclic input at ${path}`, "cyclic_input");
  seen.add(value);
  if (Array.isArray(value)) {
    value.forEach((item, index) => inspectJSON(item, `${path}[${index}]`, depth + 1, seen));
  } else {
    for (const [key, item] of Object.entries(value)) {
      if (key === "__proto__" || key === "prototype" || key === "constructor") {
        throw new WorkspaceValidationError(`Dangerous key ${key} at ${path}`, "dangerous_key");
      }
      inspectJSON(item, `${path}.${key}`, depth + 1, seen);
    }
  }
  seen.delete(value);
}

type ComponentRecipeDraft = Omit<ComponentRecipe, "digest" | "resizePolicy"> & {
  resizePolicy?: ComponentResizePolicies;
};

function recipeContent(recipe: Omit<ComponentRecipe, "digest">): Omit<ComponentRecipe, "digest"> {
  return structuredClone(recipe);
}

export function componentRecipeDigest(recipe: Omit<ComponentRecipe, "digest">): string {
  const canonical = recipeContent({
    ...structuredClone(recipe),
    resizePolicy: structuredClone(
      recipe.resizePolicy ?? defaultRecipeResizePolicies(recipe.allowedPlacements),
    ),
  });
  return deterministicDigest(canonical);
}

export function prepareComponentRecipe(recipe: ComponentRecipeDraft): ComponentRecipe {
  const canonical: Omit<ComponentRecipe, "digest"> = {
    ...structuredClone(recipe),
    resizePolicy: structuredClone(
      recipe.resizePolicy ?? defaultRecipeResizePolicies(recipe.allowedPlacements),
    ),
  };
  return { ...canonical, digest: componentRecipeDigest(canonical) };
}

/**
 * Resolve the wire-only `auto` sentinel into the canonical pinned digest.
 * Stored recipes and component type references never retain the sentinel.
 */
export function resolveComponentRecipeDigest(recipe: ComponentRecipe): ComponentRecipe {
  const { digest: _digest, ...content } = recipe;
  const canonical = prepareComponentRecipe(content);
  if (recipe.digest !== "auto" && recipe.digest !== canonical.digest) {
    throw new WorkspaceValidationError(
      `Recipe digest mismatch for ${recipe.typeId}: expected ${canonical.digest}`,
      "recipe_digest_mismatch",
    );
  }
  return canonical;
}

export function validateComponentRecipe(recipe: ComponentRecipe): void {
  if (!recipe.typeId.startsWith("recipe.")) {
    throw new WorkspaceValidationError("Declarative component typeId must start with recipe.", "invalid_recipe_type_id");
  }
  const { digest: _digest, ...content } = recipe;
  const expected = componentRecipeDigest(content);
  if (recipe.digest !== expected) {
    throw new WorkspaceValidationError(
      `Recipe digest mismatch for ${recipe.typeId}: expected ${expected}`,
      "recipe_digest_mismatch",
    );
  }
  for (const [placement, policy] of Object.entries(recipe.resizePolicy ?? {})) {
    if (policy.kind !== "none" && policy.kind !== "box2d") {
      throw new WorkspaceValidationError(
        `Declarative recipe ${recipe.typeId} cannot use ${policy.kind} resize policy for ${placement}`,
        "invalid_recipe_resize_policy",
      );
    }
  }
  const schemaBytes = byteLength(recipe.propsSchema) + byteLength(recipe.durableStateSchema)
    + byteLength(Object.values(recipe.actions).map((action) => action.inputSchema))
    + byteLength(recipe.events);
  if (schemaBytes > MAX_RECIPE_SCHEMA_BYTES) {
    throw new WorkspaceValidationError(
      `Recipe schemas exceed ${MAX_RECIPE_SCHEMA_BYTES} bytes`,
      "recipe_schema_too_large",
    );
  }
  const recipeSchemas = [
    ["propsSchema", recipe.propsSchema],
    ["durableStateSchema", recipe.durableStateSchema],
    ...Object.entries(recipe.actions).map(([name, action]) => [`actions.${name}.inputSchema`, action.inputSchema] as const),
    ...Object.entries(recipe.events).map(([name, schema]) => [`events.${name}`, schema] as const),
  ] as const;
  for (const [name, schema] of recipeSchemas) {
    const unsafe = findUnsafeJsonSchemaKeyword(schema);
    if (unsafe) {
      const profile = unsafe.keyword === "pattern" || unsafe.keyword === "patternProperties"
        ? "regex keyword"
        : unsafe.keyword.startsWith("$") || unsafe.keyword === "definitions"
          ? "reference keyword"
          : "complexity keyword";
      throw new WorkspaceValidationError(
        `Recipe ${name} uses forbidden ${profile} ${unsafe.keyword} at ${unsafe.path}`,
        "recipe_schema_regex_forbidden",
        [`${name}${unsafe.path.slice("$schema".length)}`],
      );
    }
  }
  const ids = new Set<string>();
  let count = 0;
  const walk = (node: ComponentRecipeNode, depth: number): void => {
    count += 1;
    if (count > MAX_RECIPE_NODES) {
      throw new WorkspaceValidationError(`Recipe exceeds ${MAX_RECIPE_NODES} nodes`, "recipe_too_many_nodes");
    }
    if (depth > MAX_RECIPE_DEPTH) {
      throw new WorkspaceValidationError(`Recipe exceeds depth ${MAX_RECIPE_DEPTH}`, "recipe_too_deep");
    }
    if (ids.has(node.id)) {
      throw new WorkspaceValidationError(`Duplicate recipe node ID ${node.id}`, "duplicate_recipe_node_id");
    }
    ids.add(node.id);
    for (const child of node.children ?? []) walk(child, depth + 1);
  };
  walk(recipe.root, 1);

  // Compilation is deterministic and also validates defaults against schemas.
  const localAjv = new Ajv2020({ allErrors: true, strict: false, strictNumbers: true });
  let props: ValidateFunction;
  let state: ValidateFunction;
  try {
    props = localAjv.compile(structuredClone(recipe.propsSchema));
    state = localAjv.compile(structuredClone(recipe.durableStateSchema));
    for (const action of Object.values(recipe.actions)) localAjv.compile(structuredClone(action.inputSchema));
    for (const eventSchema of Object.values(recipe.events)) localAjv.compile(structuredClone(eventSchema));
  } catch (error) {
    throw new WorkspaceValidationError(
      `Recipe contains an invalid JSON Schema: ${error instanceof Error ? error.message : String(error)}`,
      "invalid_recipe_schema",
    );
  }
  if (!props(recipe.defaultProps)) {
    throw new WorkspaceValidationError(`Recipe defaultProps are invalid: ${localAjv.errorsText(props.errors)}`, "invalid_recipe_defaults");
  }
  if (!state(recipe.defaultDurableState)) {
    throw new WorkspaceValidationError(`Recipe defaultDurableState is invalid: ${localAjv.errorsText(state.errors)}`, "invalid_recipe_defaults");
  }
}

export function validateWorkspaceCommandBatch(value: unknown): WorkspaceCommandBatch {
  let bytes: number;
  try {
    bytes = byteLength(value);
  } catch (error) {
    throw new WorkspaceValidationError(
      `Workspace batch is not serializable: ${error instanceof Error ? error.message : String(error)}`,
      "invalid_json",
    );
  }
  if (bytes > MAX_WORKSPACE_BATCH_BYTES) {
    throw new WorkspaceValidationError(
      `Workspace batch exceeds ${MAX_WORKSPACE_BATCH_BYTES} bytes`,
      "batch_too_large",
    );
  }
  inspectJSON(value, "$", 0, new Set());
  if (!batchValidator(value)) {
    const details = schemaErrors(batchValidator.errors);
    throw new WorkspaceValidationError(
      `Workspace batch does not match protocol 1.2/compatible 1.1/1.0: ${details.join("; ")}`,
      "invalid_batch",
      details,
    );
  }
  const batch = structuredClone(value);
  if (
    batch.protocol_version === "1.0"
    && batch.operations.some((operation) => operation.op === "resize_component")
  ) {
    throw new WorkspaceValidationError(
      "resize_component requires Workspace Protocol 1.1",
      "protocol_version_mismatch",
    );
  }
  if (
    batch.protocol_version !== "1.2"
    && batch.operations.some((operation) => operation.op === "set_component_visual_effects")
  ) {
    throw new WorkspaceValidationError(
      "set_component_visual_effects requires Workspace Protocol 1.2",
      "protocol_version_mismatch",
    );
  }
  if (
    batch.protocol_version !== "1.2"
    && batch.operations.some((operation) => operation.op === "upgrade_component_manifest")
  ) {
    throw new WorkspaceValidationError(
      "upgrade_component_manifest requires Workspace Protocol 1.2",
      "protocol_version_mismatch",
    );
  }
  if (
    batch.protocol_version !== "1.2"
    && batch.operations.some((operation) => (
      ("transition" in operation && operation.transition !== undefined)
      || (operation.op === "connect_event" && (
        operation.connection.transition !== undefined
        || operation.connection.inputMode === "event_payload"
      ))
    ))
  ) {
    throw new WorkspaceValidationError(
      "Component and event-connection transitions require Workspace Protocol 1.2",
      "protocol_version_mismatch",
    );
  }
  if (
    batch.protocol_version !== "1.2"
    && batch.operations.some((operation) => (
      operation.op === "publish_model"
      || operation.op === "instantiate_model"
      || operation.op === "delete_model_definition"
      || ((operation.op === "attach_component" || operation.op === "detach_component")
        && operation.transform_mode !== undefined)
    ))
  ) {
    throw new WorkspaceValidationError(
      "Reusable models and explicit reparent transform modes require Workspace Protocol 1.2",
      "protocol_version_mismatch",
    );
  }
  const operationIds = new Set<string>();
  for (const operation of batch.operations) {
    if (operationIds.has(operation.op_id)) {
      throw new WorkspaceValidationError(`Duplicate op_id ${operation.op_id}`, "duplicate_operation_id");
    }
    operationIds.add(operation.op_id);
    if (operation.op === "define_component_recipe") {
      operation.recipe = resolveComponentRecipeDigest(operation.recipe);
      validateComponentRecipe(operation.recipe);
    }
    if (operation.op === "upsert_resource") {
      try {
        assertWorkspaceResourceInputSafe(operation.resource);
      } catch (error) {
        if (error instanceof WorkspaceResourceValidationError) {
          throw new WorkspaceValidationError(error.message, error.code, [...error.details]);
        }
        throw error;
      }
    }
  }
  return batch;
}

export function workspaceProtocolJSONSchema(): object {
  return structuredClone(workspaceProtocolSchema);
}
