import {
  bindablePropsForManifest,
  type ComponentManifest,
  type ComponentPlacement,
  type JSONObject,
} from "../workspace/components";
import {
  HOST_FEED_CONNECTOR_TYPE,
  HOST_FEED_CONNECTOR_VERSION,
  isCanonicalHostFeedResource,
  isCanonicalInlineSnapshotResource,
  parseLocalInlineSource,
  type WorkspaceResource,
} from "../workspace/data";
import type { WorkspaceOperation } from "../workspace/protocol";
import type { WorkspaceState } from "../workspace/state";
import type { WorkspaceSourceAtomicCreateRequest } from "./components/workspace/WorkspaceSourcePanel";

export type WorkspaceSourceAtomicCreatePlan = Readonly<{
  baseRevision: number;
  componentId: string;
  resourceId: string;
  operations: readonly WorkspaceOperation[];
}>;

export type WorkspaceSourceAtomicCreatePlanInput = Readonly<{
  request: WorkspaceSourceAtomicCreateRequest;
  state: Readonly<WorkspaceState>;
  manifest: ComponentManifest;
  placement: ComponentPlacement;
  componentId: string;
  resourceId: string;
  observedAt: string;
  id: (purpose: "create" | "resource" | "binding", index?: number) => string;
}>;

const CREATE_TARGET_TYPES = new Set(["data-panel", "chart", "table"]);

function assertAtomicRequestDoesNotCarryExistingTarget(request: WorkspaceSourceAtomicCreateRequest): void {
  if (request.kind === "local") {
    if (request.source.targetComponentId || request.source.targetProp) {
      throw new Error("A create destination cannot also target an existing component");
    }
    return;
  }
  if (request.source.targetComponentId || request.source.mapping) {
    throw new Error("A create destination cannot also carry an existing feed mapping");
  }
}

function assertExistingResource(
  request: WorkspaceSourceAtomicCreateRequest,
  existing: WorkspaceResource | undefined,
): void {
  if (!request.source.resourceId) return;
  if (!existing) throw new Error(`Unknown resource ${request.source.resourceId}`);
  if (request.kind === "local" && !isCanonicalInlineSnapshotResource(existing)) {
    throw new Error("Only a canonical local snapshot can be updated here");
  }
  if (request.kind === "https" && !isCanonicalHostFeedResource(existing)) {
    throw new Error("Only a trusted host feed can be updated here");
  }
}

function assertMapping(input: WorkspaceSourceAtomicCreatePlanInput): void {
  const { destination } = input.request;
  if (!CREATE_TARGET_TYPES.has(destination.componentType)) {
    throw new Error(`Unsupported source destination ${destination.componentType}`);
  }
  if (input.manifest.typeId !== destination.componentType
    || destination.mapping.targetType !== destination.componentType) {
    throw new Error("The source mapping does not match the component contract");
  }
  if (!input.manifest.allowedPlacements.includes(input.placement.space)) {
    throw new Error(`${input.manifest.displayName} cannot use ${input.placement.space} placement`);
  }
  if (!destination.mapping.bindings.length) throw new Error("The source mapping has no bindings");
  const bindable = new Set(bindablePropsForManifest(input.manifest));
  const targets = new Set<string>();
  for (const binding of destination.mapping.bindings) {
    if (!bindable.has(binding.targetProp)) {
      throw new Error(`${input.manifest.displayName}.${binding.targetProp} is not bindable`);
    }
    if (targets.has(binding.targetProp)) {
      throw new Error(`The source mapping targets ${binding.targetProp} more than once`);
    }
    if (!binding.sourcePath.trim()) throw new Error("The source mapping contains an empty path");
    if (binding.transform.kind !== "identity") throw new Error("Only identity source mappings are supported");
    targets.add(binding.targetProp);
  }
}

function sourceResource(input: WorkspaceSourceAtomicCreatePlanInput): WorkspaceResource {
  const { request } = input;
  const label = request.source.label.trim();
  if (!label) throw new Error("Give the source a label");
  if (request.kind === "local") {
    const parsed = parseLocalInlineSource(request.source.format, request.source.text);
    return {
      id: input.resourceId,
      label,
      connectorType: "inline.snapshot",
      connectorVersion: "1.0.0",
      outputSchema: structuredClone(parsed.outputSchema),
      config: {},
      policy: { mode: "manual", offline: "keep_last_good" },
      snapshot: {
        data: structuredClone(parsed.data),
        contentHash: "host-computed",
        retrievedAt: input.observedAt,
        stale: false,
        provenance: [],
      },
      status: "ready",
    };
  }
  return {
    id: input.resourceId,
    label,
    connectorType: HOST_FEED_CONNECTOR_TYPE,
    connectorVersion: HOST_FEED_CONNECTOR_VERSION,
    outputSchema: structuredClone(request.source.feed.outputSchema),
    config: {
      url: request.source.feed.requestedUrl,
      format: request.source.requestedFormat,
    },
    policy: structuredClone(request.source.policy),
    snapshot: structuredClone(request.source.feed.snapshot),
    status: "ready",
  };
}

/**
 * Plan one canonical Store command. The returned operations must be submitted
 * together; splitting them would violate the function's atomicity contract.
 */
export function planWorkspaceSourceAtomicCreate(
  input: WorkspaceSourceAtomicCreatePlanInput,
): WorkspaceSourceAtomicCreatePlan {
  assertAtomicRequestDoesNotCarryExistingTarget(input.request);
  assertMapping(input);
  if (input.state.components.has(input.componentId)) throw new Error(`Component ${input.componentId} already exists`);
  const existing = input.request.source.resourceId
    ? input.state.resources.get(input.request.source.resourceId)
    : undefined;
  assertExistingResource(input.request, existing);
  if (!input.request.source.resourceId && input.state.resources.has(input.resourceId)) {
    throw new Error(`Resource ${input.resourceId} already exists`);
  }
  if (input.request.source.resourceId && input.request.source.resourceId !== input.resourceId) {
    throw new Error("The planned resource identity does not match the edited source");
  }
  const componentLabel = input.request.destination.componentLabel.trim();
  if (!componentLabel) throw new Error("Give the new component a label");
  const initialProps: JSONObject = {
    ...(input.manifest.writableProps.includes("title") ? { title: componentLabel } : {}),
    ...(input.request.destination.mapping.initialProps
      ? structuredClone(input.request.destination.mapping.initialProps)
      : {}),
  };
  const resource = sourceResource(input);
  const operations: WorkspaceOperation[] = [{
    op: "create_component",
    op_id: input.id("create"),
    id: input.componentId,
    component_type: {
      typeId: input.manifest.typeId,
      version: input.manifest.version,
      digest: input.manifest.digest,
    },
    label: componentLabel,
    ...(Object.keys(initialProps).length ? { props: initialProps } : {}),
    placement: structuredClone(input.placement),
  }, {
    op: "upsert_resource",
    op_id: input.id("resource"),
    resource,
  }, ...input.request.destination.mapping.bindings.map((binding, index): WorkspaceOperation => ({
    op: "bind_resource",
    op_id: input.id("binding", index),
    binding: {
      kind: "resource_binding",
      id: `BIND_source_${input.componentId}_${index + 1}`,
      resourceId: input.resourceId,
      componentId: input.componentId,
      targetProp: binding.targetProp,
      sourcePath: binding.sourcePath,
      mode: "snapshot",
      transform: structuredClone(binding.transform),
      enabled: true,
    },
  }))];
  return {
    baseRevision: input.state.revision,
    componentId: input.componentId,
    resourceId: input.resourceId,
    operations,
  };
}
