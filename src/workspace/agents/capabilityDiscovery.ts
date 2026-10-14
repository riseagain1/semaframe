import { WorkspaceEngineError, type JSONValue } from "./contracts";

export type CapabilityDetail = "catalog" | "full";

function record(value: JSONValue | undefined): Record<string, JSONValue> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, JSONValue>
    : {};
}

function pick(value: Record<string, JSONValue>, fields: readonly string[]): Record<string, JSONValue> {
  return Object.fromEntries(fields.filter((field) => value[field] !== undefined).map((field) => [field, value[field]]));
}

/** Catalog entries retain exact creation bindings, but never imply that schemas were returned. */
export function workspaceCapabilityCatalog(manifest: JSONValue): JSONValue {
  const full = record(manifest);
  const types = Array.isArray(full.component_types) ? full.component_types : [];
  const library = record(full.asset_library);
  return {
    ...pick(full, ["protocol_version", "registry_digest", "allowed_operations", "permission_scopes", "numeric_limits", "component_type_count", "omitted_component_type_count"]),
    detail: "catalog",
    schemas_included: false,
    discovery_tool: "inspect_workspace_capabilities",
    component_types: types.map((entry) => typeof entry === "string" ? entry : pick(record(entry), [
      "typeId", "version", "digest", "displayName", "allowedPlacements",
    ])),
    asset_library: {
      ...pick(library, ["version", "style_family", "asset_count", "omitted_asset_count"]),
      detail: "not_requested",
    },
  };
}

export function capabilityDetail(value: unknown): CapabilityDetail {
  if (value === undefined || value === "catalog") return "catalog";
  if (value === "full") return "full";
  throw new WorkspaceEngineError("invalid_request", "capability_detail must be catalog or full", { retryable: true });
}

export function discoveryNames(value: unknown, field: string, maximum: number): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length < 1 || value.length > maximum ||
      value.some((entry) => typeof entry !== "string" || entry.length < 1 || entry.length > 128)) {
    throw new WorkspaceEngineError("invalid_request", `${field} must contain 1 to ${maximum} names of at most 128 characters`, { retryable: true });
  }
  return [...new Set(value as string[])];
}

/** Selection is exact and fail-closed: unknown or bounded-out types are never silently omitted. */
export function selectComponentManifests(manifest: JSONValue, names: readonly string[]): JSONValue[] {
  const full = record(manifest);
  const types = Array.isArray(full.component_types) ? full.component_types : [];
  return names.map((name) => {
    const selected = types.find((entry) => record(entry).typeId === name);
    if (selected === undefined) {
      throw new WorkspaceEngineError("capability_not_found", `Component type ${name} is not available in the current public registry. Inspect the catalog for exact type IDs.`, {
        retryable: true, requiredAction: "inspect_workspace",
      });
    }
    return structuredClone(selected);
  });
}

export function selectDiscoveryEntries(source: Readonly<Record<string, JSONValue>>, names: readonly string[], field: string): Record<string, JSONValue> {
  const selected: Record<string, JSONValue> = {};
  for (const name of names) {
    if (!Object.hasOwn(source, name)) {
      throw new WorkspaceEngineError("invalid_request", `Unknown ${field} '${name}'. Available: ${Object.keys(source).join(", ")}`, { retryable: true });
    }
    selected[name] = structuredClone(source[name]);
  }
  return selected;
}

export function optionalCapabilitySection(manifest: JSONValue, field: string): JSONValue {
  return structuredClone(record(manifest)[field] ?? null);
}
