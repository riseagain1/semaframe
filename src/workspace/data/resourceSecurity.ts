import Ajv2020, { type ErrorObject, type ValidateFunction } from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import type { JSONSchema, JSONValue } from "../components/componentTypes";
import {
  findUnsafeJsonSchemaKeyword,
  MAX_UNTRUSTED_JSON_SCHEMA_BYTES,
} from "../components/jsonSchemaSafety";
import { deterministicDigest, stableStringify } from "../components/manifestDigest";
import type { WorkspaceResource } from "./dataTypes";
import { findWorkspaceConnectorCapability } from "./connectorCatalog";
import {
  HOST_FEED_CONNECTOR_TYPE,
  HOST_FEED_CONNECTOR_VERSION,
  normalizeHostFeedUrl,
} from "./hostFeedContracts";

const FORBIDDEN_SECRET_KEYS = new Set([
  "access_token",
  "api_key",
  "api_key_ref",
  "authorization",
  "authorization_header",
  "auth_token",
  "auth_header",
  "bearer",
  "client_secret",
  "credential",
  "credential_ref",
  "credential_reference",
  "credentials",
  "id_token",
  "password",
  "password_ref",
  "proxy_authorization",
  "private_key",
  "private_key_ref",
  "refresh_token",
  "secret",
  "secret_ref",
  "secret_reference",
  "session_token",
  "token",
  "token_ref",
]);
const FORBIDDEN_SECRET_TOKENS = new Set([
  "authorization",
  "bearer",
  "credential",
  "credentials",
  "password",
  "secret",
  "token",
]);
const BENIGN_CREDENTIAL_KEYS = new Set([
  // Token counts are usage metadata, not bearer material. Keep this allowlist
  // exact so accessTokenCount and other credential-qualified names still fail.
  "token_count",
]);
const FORBIDDEN_COLLAPSED_SECRET_KEYS = new Set([
  "accesstoken",
  "apikey",
  "apikeyref",
  "authtoken",
  "authorizationheader",
  "authheader",
  "clientsecret",
  "credentialref",
  "credentialreference",
  "idtoken",
  "passwordref",
  "proxyauthorization",
  "privatekey",
  "privatekeyref",
  "refreshtoken",
  "secretref",
  "secretreference",
  "sessiontoken",
  "tokenref",
]);
const FORBIDDEN_SECRET_KEY_SUFFIXES = [
  "access_token",
  "api_key",
  "auth_token",
  "authorization_header",
  "auth_header",
  "client_secret",
  "credential_ref",
  "id_token",
  "password_ref",
  "proxy_authorization",
  "private_key",
  "refresh_token",
  "secret_ref",
  "session_token",
  "token_ref",
] as const;
const FORBIDDEN_SECRET_TOKEN_SEQUENCES = [
  ["api", "key"],
  ["auth", "header"],
  ["private", "key"],
] as const;

const resourceSchemaAjv = new Ajv2020({
  allErrors: true,
  strict: false,
  strictNumbers: true,
});
addFormats(resourceSchemaAjv);
const resourceTimestampValidator = resourceSchemaAjv.compile({
  type: "string",
  format: "date-time",
});
const resourceSchemaValidators = new Map<string, ValidateFunction>();
const MAX_CACHED_RESOURCE_SCHEMAS = 128;
const MIN_HOST_FEED_INTERVAL_MS = 30_000;
const MAX_HOST_FEED_INTERVAL_MS = 24 * 60 * 60 * 1_000;
const MAX_HOST_FEED_PROVENANCE_TITLE_LENGTH = 2_000;

export class WorkspaceResourceValidationError extends Error {
  constructor(
    message: string,
    readonly code:
      | "embedded_secret"
      | "invalid_resource_connector"
      | "invalid_resource_output_schema"
      | "invalid_resource_snapshot",
    readonly details: readonly string[] = [],
  ) {
    super(message);
    this.name = "WorkspaceResourceValidationError";
  }
}

/** Normalize Unicode, camelCase, dotted, dashed, and spaced credential keys. */
export function normalizeCredentialKey(key: string): string {
  return key
    .normalize("NFKC")
    .replace(/([A-Z]+)([A-Z][a-z])/gu, "$1_$2")
    .replace(/([a-z0-9])([A-Z])/gu, "$1_$2")
    .replace(/[^A-Za-z0-9]+/gu, "_")
    .replace(/^_+|_+$/gu, "")
    .toLowerCase();
}

function isCredentialKey(key: string): boolean {
  const normalized = normalizeCredentialKey(key);
  if (BENIGN_CREDENTIAL_KEYS.has(normalized)) return false;
  if (FORBIDDEN_SECRET_KEYS.has(normalized)) return true;
  const tokens = normalized.split("_").filter(Boolean);
  if (tokens.some((token) => FORBIDDEN_SECRET_TOKENS.has(token))) return true;
  if (FORBIDDEN_SECRET_TOKEN_SEQUENCES.some((sequence) =>
    tokens.some((token, index) => token === sequence[0] && tokens[index + 1] === sequence[1]))) {
    return true;
  }
  const collapsed = normalized.replace(/_/gu, "");
  if ([...FORBIDDEN_COLLAPSED_SECRET_KEYS].some((suffix) => collapsed.endsWith(suffix))) return true;
  return FORBIDDEN_SECRET_KEY_SUFFIXES.some((suffix) => normalized.endsWith(`_${suffix}`));
}

export function findEmbeddedSecretPath(value: JSONValue, path = "$"): string | null {
  if (Array.isArray(value)) {
    for (const [index, item] of value.entries()) {
      const found = findEmbeddedSecretPath(item, `${path}[${index}]`);
      if (found) return found;
    }
    return null;
  }
  if (!value || typeof value !== "object") return null;
  for (const [key, item] of Object.entries(value)) {
    if (isCredentialKey(key)) return `${path}.${key}`;
    const found = findEmbeddedSecretPath(item, `${path}.${key}`);
    if (found) return found;
  }
  return null;
}

export function assertNoEmbeddedSecrets(value: JSONValue): void {
  const path = findEmbeddedSecretPath(value);
  if (path) {
    throw new WorkspaceResourceValidationError(
      `Embedded credential-like field is forbidden at ${path}; use a host-owned secret reference`,
      "embedded_secret",
      [path],
    );
  }
}

function findSecretLikeValuePath(value: JSONValue, path = "$"): string | null {
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (/^(?:bearer|basic)\s+\S{8,}$/iu.test(trimmed)
      || /^(?:sk|rk|ghp|github_pat|xox[baprs])[-_][A-Za-z0-9._~-]{8,}$/u.test(trimmed)
      || /^[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}$/u.test(trimmed)) {
      return path;
    }
    return null;
  }
  if (Array.isArray(value)) {
    for (const [index, item] of value.entries()) {
      const found = findSecretLikeValuePath(item, `${path}[${index}]`);
      if (found) return found;
    }
    return null;
  }
  if (!value || typeof value !== "object") return null;
  for (const [key, item] of Object.entries(value)) {
    const found = findSecretLikeValuePath(item, `${path}.${key}`);
    if (found) return found;
  }
  return null;
}

function assertNoSecretLikeValues(value: JSONValue): void {
  const path = findSecretLikeValuePath(value);
  if (!path) return;
  throw new WorkspaceResourceValidationError(
    `Embedded credential-like value is forbidden at ${path}; use a host-owned secret reference`,
    "embedded_secret",
    [path],
  );
}

function schemaErrors(errors: ErrorObject[] | null | undefined): string[] {
  return (errors ?? []).slice(0, 16).map((error) =>
    `${error.instancePath || "/"} ${error.message ?? error.keyword}`,
  );
}

function validatorForResourceSchema(schema: JSONSchema): ValidateFunction {
  let key: string;
  try {
    key = JSON.stringify(schema);
  } catch (error) {
    throw new WorkspaceResourceValidationError(
      `Resource outputSchema is not serializable: ${error instanceof Error ? error.message : String(error)}`,
      "invalid_resource_output_schema",
    );
  }
  const schemaBytes = new TextEncoder().encode(key).byteLength;
  if (schemaBytes > MAX_UNTRUSTED_JSON_SCHEMA_BYTES) {
    throw new WorkspaceResourceValidationError(
      `Resource outputSchema exceeds ${MAX_UNTRUSTED_JSON_SCHEMA_BYTES} bytes`,
      "invalid_resource_output_schema",
    );
  }
  const cached = resourceSchemaValidators.get(key);
  if (cached) return cached;
  let validator: ValidateFunction;
  try {
    validator = resourceSchemaAjv.compile(structuredClone(schema));
  } catch (error) {
    throw new WorkspaceResourceValidationError(
      `Resource outputSchema is invalid: ${error instanceof Error ? error.message : String(error)}`,
      "invalid_resource_output_schema",
    );
  }
  if (resourceSchemaValidators.size >= MAX_CACHED_RESOURCE_SCHEMAS) {
    const oldest = resourceSchemaValidators.keys().next().value as string | undefined;
    if (oldest !== undefined) resourceSchemaValidators.delete(oldest);
  }
  resourceSchemaValidators.set(key, validator);
  return validator;
}

function assertSnapshotPayloadSafe(resource: Readonly<WorkspaceResource>): void {
  assertNoEmbeddedSecrets(resource.config);
  assertNoSecretLikeValues(resource.config);
  const unsafe = findUnsafeJsonSchemaKeyword(resource.outputSchema);
  if (unsafe && !isTrustedRecommendedOutputSchema(resource, unsafe.keyword)) {
    const profile = unsafe.keyword === "pattern" || unsafe.keyword === "patternProperties"
      ? "regex keyword"
      : unsafe.keyword.startsWith("$") || unsafe.keyword === "definitions"
        ? "reference keyword"
        : "complexity keyword";
    throw new WorkspaceResourceValidationError(
      `Resource outputSchema uses forbidden ${profile} ${unsafe.keyword} at ${unsafe.path}`,
      "invalid_resource_output_schema",
      [unsafe.path],
    );
  }
  const validator = validatorForResourceSchema(resource.outputSchema);
  if (!resource.snapshot) return;
  if (!resourceTimestampValidator(resource.snapshot.retrievedAt)) {
    throw new WorkspaceResourceValidationError(
      `Resource ${resource.id} snapshot retrievedAt is not a valid ISO timestamp`,
      "invalid_resource_snapshot",
    );
  }
  for (const [index, provenance] of resource.snapshot.provenance.entries()) {
    if (!resourceTimestampValidator(provenance.retrievedAt)) {
      throw new WorkspaceResourceValidationError(
        `Resource ${resource.id} provenance[${index}].retrievedAt is not a valid ISO timestamp`,
        "invalid_resource_snapshot",
      );
    }
  }
  assertNoEmbeddedSecrets(resource.snapshot.data);
  assertNoSecretLikeValues(resource.snapshot.data);
  if (validator(resource.snapshot.data)) return;
  const details = schemaErrors(validator.errors);
  throw new WorkspaceResourceValidationError(
    `Resource ${resource.id} snapshot does not match outputSchema: ${details.join("; ")}`,
    "invalid_resource_snapshot",
    details,
  );
}

function isTrustedRecommendedOutputSchema(
  resource: Readonly<WorkspaceResource>,
  keyword: string,
): boolean {
  // References stay closed even if a future recommended schema uses them;
  // trusted host schemas should remain self-contained and directly auditable.
  if (keyword.startsWith("$") || keyword === "definitions") return false;
  const capability = findWorkspaceConnectorCapability(resource.connectorType, resource.connectorVersion);
  if (!capability?.recommendedOutputSchemas?.length) return false;
  try {
    const candidate = stableStringify(resource.outputSchema);
    return capability.recommendedOutputSchemas.some((recommended) =>
      stableStringify(recommended.schema) === candidate);
  } catch {
    return false;
  }
}

/** Validate an untrusted wire resource before any host-owned normalization. */
export function assertWorkspaceResourceInputSafe(resource: Readonly<WorkspaceResource>): void {
  if (resource.connectorType === "inline.snapshot" && resource.connectorVersion !== "1.0.0") {
    throw new WorkspaceResourceValidationError(
      `Unsupported inline snapshot connector version ${resource.connectorVersion}; use inline.snapshot@1.0.0`,
      "invalid_resource_connector",
    );
  }
  if (resource.connectorType === "inline.snapshot") {
    if (!resource.snapshot) {
      throw new WorkspaceResourceValidationError(
        `Inline snapshot resource ${resource.id} requires a snapshot`,
        "invalid_resource_snapshot",
      );
    }
  }
  // Scan and validate before connector-specific shape rejection so callers
  // receive the actionable embedded_secret code for credential-bearing input.
  assertSnapshotPayloadSafe(resource);
  if (resource.connectorType === "inline.snapshot") {
    if (resource.secretRef || Object.keys(resource.config).length > 0) {
      throw new WorkspaceResourceValidationError(
        "The inline snapshot connector does not accept configuration or secret references",
        "invalid_resource_snapshot",
      );
    }
  }
}

/** Enforce the capability allowlist for a newly submitted Agent write. */
export function assertWorkspaceResourceAgentWriteSafe(resource: Readonly<WorkspaceResource>): void {
  assertWorkspaceResourceInputSafe(resource);
  const capability = findWorkspaceConnectorCapability(resource.connectorType, resource.connectorVersion);
  if (!capability || capability.agentWritePolicy !== "allowed") {
    throw new WorkspaceResourceValidationError(
      `Connector ${resource.connectorType}@${resource.connectorVersion} is not available for new Agent writes`,
      "invalid_resource_connector",
    );
  }
  let validateConfig: ValidateFunction;
  try {
    validateConfig = resourceSchemaAjv.compile(structuredClone(capability.configSchema));
  } catch (error) {
    throw new WorkspaceResourceValidationError(
      `Connector ${resource.connectorType}@${resource.connectorVersion} has an invalid host config schema: ${error instanceof Error ? error.message : String(error)}`,
      "invalid_resource_connector",
    );
  }
  if (validateConfig(resource.config)) return;
  const details = schemaErrors(validateConfig.errors);
  throw new WorkspaceResourceValidationError(
    `Connector ${resource.connectorType}@${resource.connectorVersion} config is invalid: ${details.join("; ")}`,
    "invalid_resource_connector",
    details,
  );
}

/**
 * Validate the complete durable resource boundary.
 *
 * Connector execution is deliberately out of scope here. This function makes
 * persisted configuration/snapshots safe to store and guarantees that a
 * snapshot matches the resource's advertised output schema before bindings can
 * project it into component props.
 */
export function assertWorkspaceResourceSafe(resource: Readonly<WorkspaceResource>): void {
  assertWorkspaceResourceInputSafe(resource);
  if (resource.connectorType === HOST_FEED_CONNECTOR_TYPE) {
    assertCanonicalHostFeedResource(resource);
    return;
  }
  if (resource.connectorType !== "inline.snapshot") return;
  const snapshot = resource.snapshot!;
  const expectedProvenance = [{
    title: resource.label,
    publisher: "Scene Thread inline snapshot",
    retrievedAt: snapshot.retrievedAt,
  }];
  const canonicalTime = new Date(snapshot.retrievedAt).toISOString();
  if (canonicalTime !== snapshot.retrievedAt
    || snapshot.contentHash !== deterministicDigest(snapshot.data)
    || snapshot.stale
    || stableStringify(snapshot.provenance) !== stableStringify(expectedProvenance)
    || stableStringify(resource.config) !== "{}"
    || stableStringify(resource.policy) !== stableStringify({ mode: "manual", offline: "keep_last_good" })
    || resource.secretRef !== undefined
    || resource.status !== "ready"
    || resource.lastError !== undefined) {
    throw new WorkspaceResourceValidationError(
      `Inline snapshot resource ${resource.id} is not in the canonical host-owned form`,
      "invalid_resource_snapshot",
    );
  }
}

function canonicalIsoTimestamp(value: string): boolean {
  const parsed = new Date(value);
  return !Number.isNaN(parsed.valueOf()) && parsed.toISOString() === value;
}

function canonicalFeedUrl(value: unknown): string | null {
  if (typeof value !== "string") return null;
  try {
    const normalized = normalizeHostFeedUrl(value);
    return normalized === value ? normalized : null;
  } catch {
    return null;
  }
}

function canonicalFeedPolicy(resource: Readonly<WorkspaceResource>): boolean {
  const { policy } = resource;
  if (policy.offline !== "keep_last_good" && policy.offline !== "show_error") return false;
  if (policy.mode === "manual" || policy.mode === "on_open") {
    return stableStringify(policy) === stableStringify({ mode: policy.mode, offline: policy.offline });
  }
  if (policy.mode !== "interval"
    || !Number.isSafeInteger(policy.intervalMs)
    || policy.intervalMs! < MIN_HOST_FEED_INTERVAL_MS
    || policy.intervalMs! > MAX_HOST_FEED_INTERVAL_MS) {
    return false;
  }
  return stableStringify(policy) === stableStringify({
    mode: "interval",
    intervalMs: policy.intervalMs,
    offline: policy.offline,
  });
}

function safeFeedProvenanceTitle(value: unknown): value is string {
  return typeof value === "string"
    && value.length > 0
    && value.length <= MAX_HOST_FEED_PROVENANCE_TITLE_LENGTH
    && !/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/u.test(value);
}

function invalidCanonicalHostFeed(resource: Readonly<WorkspaceResource>): never {
  throw new WorkspaceResourceValidationError(
    `Host feed resource ${resource.id} is not in the canonical host-owned form`,
    "invalid_resource_snapshot",
  );
}

function assertCanonicalHostFeedResource(resource: Readonly<WorkspaceResource>): void {
  if (resource.connectorVersion !== HOST_FEED_CONNECTOR_VERSION
    || resource.secretRef !== undefined
    || resource.status !== "ready"
    || resource.lastError !== undefined
    || !canonicalFeedPolicy(resource)) {
    invalidCanonicalHostFeed(resource);
  }

  const configKeys = Object.keys(resource.config);
  const requestedUrl = canonicalFeedUrl(resource.config.url);
  const format = resource.config.format;
  if (configKeys.length !== 2
    || !configKeys.includes("url")
    || !configKeys.includes("format")
    || !requestedUrl
    || (format !== "auto" && format !== "json" && format !== "csv" && format !== "rss")) {
    invalidCanonicalHostFeed(resource);
  }

  const snapshot = resource.snapshot;
  if (!snapshot) invalidCanonicalHostFeed(resource);
  const provenance = snapshot.provenance[0];
  if (!canonicalIsoTimestamp(snapshot.retrievedAt)
    || snapshot.contentHash !== deterministicDigest(snapshot.data)
    || snapshot.stale
    || snapshot.provenance.length !== 1
    || !provenance
    || provenance.retrievedAt !== snapshot.retrievedAt
    || !canonicalIsoTimestamp(provenance.retrievedAt)) {
    invalidCanonicalHostFeed(resource);
  }

  const finalUrl = canonicalFeedUrl(provenance.uri);
  if (!finalUrl) invalidCanonicalHostFeed(resource);
  if (provenance.citation !== finalUrl) invalidCanonicalHostFeed(resource);
  const finalUrlObject = new URL(finalUrl);
  const publisher = finalUrlObject.hostname
    .toLowerCase()
    .replace(/^\[|\]$/gu, "")
    .replace(/\.$/u, "");
  const expectedProvenance = {
    ...(provenance.title === undefined
      ? {}
      : safeFeedProvenanceTitle(provenance.title)
        ? { title: provenance.title }
        : invalidCanonicalHostFeed(resource)),
    uri: finalUrl,
    publisher,
    retrievedAt: snapshot.retrievedAt,
    citation: finalUrl,
  };
  if (stableStringify(provenance) !== stableStringify(expectedProvenance)) {
    invalidCanonicalHostFeed(resource);
  }
}

/** True only for a complete, replay-safe host-brokered feed snapshot. */
export function isCanonicalHostFeedResource(resource: Readonly<WorkspaceResource>): boolean {
  if (resource.connectorType !== HOST_FEED_CONNECTOR_TYPE
    || resource.connectorVersion !== HOST_FEED_CONNECTOR_VERSION) {
    return false;
  }
  try {
    assertWorkspaceResourceSafe(resource);
    return true;
  } catch {
    return false;
  }
}

export function isCanonicalInlineSnapshotResource(resource: Readonly<WorkspaceResource>): boolean {
  if (resource.connectorType !== "inline.snapshot" || resource.connectorVersion !== "1.0.0") return false;
  try {
    assertWorkspaceResourceSafe(resource);
    return true;
  } catch {
    return false;
  }
}

/**
 * Canonicalize the built-in, non-executable inline snapshot connector.
 *
 * The caller supplies only JSON data/schema semantics. The host supplies the
 * observation time, computes the content hash, removes claimed credentials and
 * provenance, and fixes status/policy. Unknown connector types are intentionally
 * not normalized or executed by this helper.
 */
export function normalizeInlineSnapshotResource(
  resource: Readonly<WorkspaceResource>,
  observedAtMs: number,
): WorkspaceResource {
  if (resource.connectorType !== "inline.snapshot" || resource.connectorVersion !== "1.0.0") {
    throw new WorkspaceResourceValidationError(
      "Inline snapshot normalization requires connector inline.snapshot@1.0.0",
      "invalid_resource_output_schema",
    );
  }
  if (!Number.isSafeInteger(observedAtMs) || observedAtMs < 0 || !resource.snapshot) {
    throw new WorkspaceResourceValidationError(
      "Inline snapshot normalization requires a snapshot and a non-negative host observation time",
      "invalid_resource_snapshot",
    );
  }
  assertNoEmbeddedSecrets(resource.config);
  assertNoEmbeddedSecrets(resource.snapshot.data);
  if (resource.secretRef || Object.keys(resource.config).length > 0) {
    throw new WorkspaceResourceValidationError(
      "The inline snapshot connector does not accept configuration or secret references",
      "invalid_resource_snapshot",
    );
  }
  const retrievedAt = new Date(observedAtMs).toISOString();
  const normalized: WorkspaceResource = {
    id: resource.id,
    label: resource.label,
    connectorType: "inline.snapshot",
    connectorVersion: "1.0.0",
    outputSchema: structuredClone(resource.outputSchema),
    config: {},
    policy: { mode: "manual", offline: "keep_last_good" },
    snapshot: {
      data: structuredClone(resource.snapshot.data),
      contentHash: deterministicDigest(resource.snapshot.data),
      retrievedAt,
      stale: false,
      provenance: [{
        title: resource.label,
        publisher: "Scene Thread inline snapshot",
        retrievedAt,
      }],
    },
    status: "ready",
  };
  assertWorkspaceResourceSafe(normalized);
  return normalized;
}
