import {
  WORKSPACE_PROTOCOL_VERSION,
  validateWorkspaceCommandBatch,
  type WorkspaceOperation,
  type WorkspacePermission,
} from "../../workspace/protocol";
import {
  STATIC_TEMPLATE_CATALOG_VERSION,
  TEMPLATE_CATALOG_SIGNATURE_ALGORITHM,
  TEMPLATE_DESCRIPTOR_VERSION,
  type ModelTemplateDescriptor,
  type ProjectTemplateDescriptor,
  type Sha256Digest,
  type StaticTemplateCatalog,
  type StaticTemplateCatalogEntry,
  type TemplateDescriptor,
  type TemplateKind,
} from "./contracts";

const DIGEST_PATTERN = /^sha256:[a-f0-9]{64}$/u;
const ID_PATTERN = /^[a-z0-9](?:[a-z0-9._-]{0,126}[a-z0-9])?$/u;
const VERSION_PATTERN = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u;
const ISO_INSTANT_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;
const RELATIVE_ARTIFACT_PATTERN = /^(?!\/)(?!.*(?:^|\/)\.\.(?:\/|$))(?!.*[\\?#:])[A-Za-z0-9._~/-]{1,240}$/u;
const MAX_CATALOG_ENTRIES = 1_000;
const MAX_TEMPLATE_OPERATIONS = 100;

const PERMISSIONS = new Set<WorkspacePermission>([
  "workspace:write",
  "component:create",
  "component:update",
  "component:delete",
  "component:invoke",
  "component:recipe_define",
  "connector:write",
  "connector:delete",
  "connector:bind",
  "asset:register",
  "event:connect",
  "view:present",
  "workspace:clear",
  "effect:data_read",
  "effect:external_write",
  "extension:install",
]);

export class EcosystemValidationError extends TypeError {
  constructor(
    readonly code:
      | "invalid_type"
      | "missing_field"
      | "unknown_field"
      | "invalid_value"
      | "limit_exceeded"
      | "inconsistent_value",
    readonly path: string,
    message: string,
  ) {
    super(`${path}: ${message}`);
    this.name = "EcosystemValidationError";
  }
}

function record(value: unknown, path: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new EcosystemValidationError("invalid_type", path, "must be a plain object");
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new EcosystemValidationError("invalid_type", path, "must be a plain object");
  }
  if (Object.getOwnPropertySymbols(value).length > 0) {
    throw new EcosystemValidationError("invalid_type", path, "must not contain symbol properties");
  }
  for (const descriptor of Object.values(Object.getOwnPropertyDescriptors(value))) {
    if (descriptor.get || descriptor.set) {
      throw new EcosystemValidationError("invalid_type", path, "must contain data properties only");
    }
  }
  return value as Record<string, unknown>;
}

function exact(
  value: unknown,
  allowed: readonly string[],
  required: readonly string[],
  path: string,
): Record<string, unknown> {
  const body = record(value, path);
  const allowedSet = new Set(allowed);
  for (const key of Object.getOwnPropertyNames(body)) {
    if (!allowedSet.has(key)) {
      throw new EcosystemValidationError("unknown_field", `${path}.${key}`, "is not allowed");
    }
  }
  for (const key of required) {
    if (!Object.hasOwn(body, key)) {
      throw new EcosystemValidationError("missing_field", `${path}.${key}`, "is required");
    }
  }
  return body;
}

function array(value: unknown, path: string, maximum: number): readonly unknown[] {
  if (!Array.isArray(value)) {
    throw new EcosystemValidationError("invalid_type", path, "must be an array");
  }
  if (value.length > maximum) {
    throw new EcosystemValidationError("limit_exceeded", path, `cannot exceed ${maximum} items`);
  }
  const names = Object.getOwnPropertyNames(value);
  const indices = [...value.keys()].map(String);
  if (Object.getOwnPropertySymbols(value).length
    || names.length !== value.length + 1
    || indices.some((index) => !names.includes(index))
    || names.some((name) => name !== "length" && !indices.includes(name))) {
    throw new EcosystemValidationError("invalid_type", path, "must be a dense array without extra properties");
  }
  return value;
}

function deepFreeze<T>(value: T): T {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const item of Object.values(value as Record<string, unknown>)) deepFreeze(item);
  return Object.freeze(value);
}

function text(value: unknown, path: string, maximum = 240): string {
  if (typeof value !== "string" || value.length < 1 || value.length > maximum || /[\u0000-\u001f\u007f]/u.test(value)) {
    throw new EcosystemValidationError("invalid_value", path, `must be 1-${maximum} printable characters`);
  }
  return value;
}

function identifier(value: unknown, path: string): string {
  const parsed = text(value, path, 128);
  if (!ID_PATTERN.test(parsed)) {
    throw new EcosystemValidationError("invalid_value", path, "must be a lowercase opaque identifier");
  }
  return parsed;
}

function semver(value: unknown, path: string): string {
  const parsed = text(value, path, 64);
  if (!VERSION_PATTERN.test(parsed)) {
    throw new EcosystemValidationError("invalid_value", path, "must be a semantic version");
  }
  return parsed;
}

function digest(value: unknown, path: string): Sha256Digest {
  if (typeof value !== "string" || !DIGEST_PATTERN.test(value)) {
    throw new EcosystemValidationError("invalid_value", path, "must be a canonical lowercase SHA-256 digest");
  }
  return value as Sha256Digest;
}

function instant(value: unknown, path: string): string {
  if (typeof value !== "string" || !ISO_INSTANT_PATTERN.test(value) || !Number.isFinite(Date.parse(value))) {
    throw new EcosystemValidationError("invalid_value", path, "must be a canonical UTC instant");
  }
  return value;
}

function kind(value: unknown, path: string): TemplateKind {
  if (value !== "project" && value !== "model") {
    throw new EcosystemValidationError("invalid_value", path, "must be project or model");
  }
  return value;
}

function parseEntry(value: unknown, path: string): StaticTemplateCatalogEntry {
  const keys = [
    "id", "kind", "version", "title", "summary", "license", "publisher", "artifactPath", "artifactDigest",
  ] as const;
  const body = exact(value, keys, keys, path);
  const artifactPath = text(body.artifactPath, `${path}.artifactPath`, 240);
  if (!RELATIVE_ARTIFACT_PATTERN.test(artifactPath)) {
    throw new EcosystemValidationError(
      "invalid_value",
      `${path}.artifactPath`,
      "must be a safe catalog-relative path without URL, traversal, query, or fragment syntax",
    );
  }
  return Object.freeze({
    id: identifier(body.id, `${path}.id`),
    kind: kind(body.kind, `${path}.kind`),
    version: semver(body.version, `${path}.version`),
    title: text(body.title, `${path}.title`),
    summary: text(body.summary, `${path}.summary`, 1_000),
    license: text(body.license, `${path}.license`, 80),
    publisher: identifier(body.publisher, `${path}.publisher`),
    artifactPath,
    artifactDigest: digest(body.artifactDigest, `${path}.artifactDigest`),
  });
}

export function parseStaticTemplateCatalog(value: unknown): StaticTemplateCatalog {
  const keys = ["schemaVersion", "catalogId", "sequence", "generatedAt", "expiresAt", "entries", "signature"] as const;
  const body = exact(value, keys, keys, "$");
  if (body.schemaVersion !== STATIC_TEMPLATE_CATALOG_VERSION) {
    throw new EcosystemValidationError("invalid_value", "$.schemaVersion", `must equal ${STATIC_TEMPLATE_CATALOG_VERSION}`);
  }
  if (!Number.isSafeInteger(body.sequence) || Number(body.sequence) < 0) {
    throw new EcosystemValidationError("invalid_value", "$.sequence", "must be a non-negative safe integer");
  }
  const entries = Object.freeze(array(body.entries, "$.entries", MAX_CATALOG_ENTRIES)
    .map((entry, index) => parseEntry(entry, `$.entries[${index}]`)));
  const entryKeys = new Set<string>();
  for (const entry of entries) {
    const entryKey = `${entry.id}@${entry.version}`;
    if (entryKeys.has(entryKey)) {
      throw new EcosystemValidationError("inconsistent_value", "$.entries", `duplicates ${entryKey}`);
    }
    entryKeys.add(entryKey);
  }
  const signature = exact(body.signature, ["algorithm", "keyId", "value"], ["algorithm", "keyId", "value"], "$.signature");
  if (signature.algorithm !== TEMPLATE_CATALOG_SIGNATURE_ALGORITHM) {
    throw new EcosystemValidationError("invalid_value", "$.signature.algorithm", "must be Ed25519");
  }
  const signatureValue = text(signature.value, "$.signature.value", 128);
  if (!/^[A-Za-z0-9_-]{86}$/u.test(signatureValue)) {
    throw new EcosystemValidationError("invalid_value", "$.signature.value", "must be an unpadded base64url Ed25519 signature");
  }
  const generatedAt = instant(body.generatedAt, "$.generatedAt");
  const expiresAt = instant(body.expiresAt, "$.expiresAt");
  if (Date.parse(expiresAt) <= Date.parse(generatedAt)) {
    throw new EcosystemValidationError("inconsistent_value", "$.expiresAt", "must be later than generatedAt");
  }
  return Object.freeze({
    schemaVersion: STATIC_TEMPLATE_CATALOG_VERSION,
    catalogId: identifier(body.catalogId, "$.catalogId"),
    sequence: Number(body.sequence),
    generatedAt,
    expiresAt,
    entries,
    signature: Object.freeze({
      algorithm: TEMPLATE_CATALOG_SIGNATURE_ALGORITHM,
      keyId: identifier(signature.keyId, "$.signature.keyId"),
      value: signatureValue,
    }),
  });
}

function parsePermissions(value: unknown, path: string): readonly WorkspacePermission[] {
  const values = array(value, path, PERMISSIONS.size);
  const parsed = values.map((permission, index) => {
    if (typeof permission !== "string" || !PERMISSIONS.has(permission as WorkspacePermission)) {
      throw new EcosystemValidationError("invalid_value", `${path}[${index}]`, "is not an allowed explicit permission");
    }
    return permission as WorkspacePermission;
  });
  if (new Set(parsed).size !== parsed.length) {
    throw new EcosystemValidationError("inconsistent_value", path, "must not contain duplicate permissions");
  }
  return Object.freeze(parsed);
}

function parseOperations(value: unknown, path: string): readonly WorkspaceOperation[] {
  const operations = array(value, path, MAX_TEMPLATE_OPERATIONS);
  try {
    return deepFreeze(validateWorkspaceCommandBatch({
      protocol_version: WORKSPACE_PROTOCOL_VERSION,
      request_id: "template_descriptor_validation",
      workspace_id: "template_descriptor_validation",
      input_revision: 0,
      base_workspace_revision: 0,
      registry_digest: "template-registry-validation",
      mode: "commit",
      operations,
    }).operations);
  } catch (error) {
    throw new EcosystemValidationError(
      "invalid_value",
      path,
      `must contain valid Workspace Protocol operations: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

function operationPermission(operation: WorkspaceOperation): WorkspacePermission {
  switch (operation.op) {
    case "define_component_recipe": return "component:recipe_define";
    case "create_component":
    case "instantiate_model": return "component:create";
    case "update_component":
    case "upgrade_component_manifest":
    case "place_component":
    case "resize_component":
    case "set_component_visual_effects":
    case "attach_component":
    case "detach_component":
    case "publish_model": return "component:update";
    case "delete_component":
    case "delete_model_definition": return "component:delete";
    case "invoke_component_action": return "component:invoke";
    case "upsert_resource": return "connector:write";
    case "delete_resource": return "connector:delete";
    case "register_reality_asset":
    case "delete_reality_asset": return "asset:register";
    case "bind_resource":
    case "unbind_resource": return "connector:bind";
    case "connect_event":
    case "disconnect_event": return "event:connect";
    case "present_view": return "view:present";
    case "clear_workspace": return "workspace:clear";
  }
}

export function parseTemplateDescriptor(value: unknown): TemplateDescriptor {
  const baseKeys = [
    "schemaVersion", "kind", "id", "version", "title", "summary", "license", "minimumAppVersion",
    "requiredPermissions", "operations",
  ] as const;
  const preliminary = record(value, "$");
  const templateKind = kind(preliminary.kind, "$.kind");
  const keys = templateKind === "project" ? [...baseKeys, "newProject"] : baseKeys;
  const body = exact(value, keys, keys, "$");
  if (body.schemaVersion !== TEMPLATE_DESCRIPTOR_VERSION) {
    throw new EcosystemValidationError("invalid_value", "$.schemaVersion", `must equal ${TEMPLATE_DESCRIPTOR_VERSION}`);
  }
  const requiredPermissions = parsePermissions(body.requiredPermissions, "$.requiredPermissions");
  const operations = parseOperations(body.operations, "$.operations");
  const declared = new Set<WorkspacePermission>(requiredPermissions);
  for (const operation of operations) {
    const required = operationPermission(operation);
    if (!declared.has(required)) {
      throw new EcosystemValidationError(
        "inconsistent_value",
        "$.requiredPermissions",
        `must declare ${required} for ${operation.op}`,
      );
    }
  }
  const base = {
    schemaVersion: TEMPLATE_DESCRIPTOR_VERSION,
    kind: templateKind,
    id: identifier(body.id, "$.id"),
    version: semver(body.version, "$.version"),
    title: text(body.title, "$.title"),
    summary: text(body.summary, "$.summary", 1_000),
    license: text(body.license, "$.license", 80),
    minimumAppVersion: semver(body.minimumAppVersion, "$.minimumAppVersion"),
    requiredPermissions,
    operations,
  };
  if (templateKind === "model") return Object.freeze(base) as ModelTemplateDescriptor;
  const newProject = exact(body.newProject, ["suggestedTitle"], ["suggestedTitle"], "$.newProject");
  return Object.freeze({
    ...base,
    kind: "project",
    newProject: Object.freeze({ suggestedTitle: text(newProject.suggestedTitle, "$.newProject.suggestedTitle") }),
  }) as ProjectTemplateDescriptor;
}
