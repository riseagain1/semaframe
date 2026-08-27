import {
  boundedExtensionJsonByteLength,
  canonicalizeExtensionJson,
  extensionJsonClone,
  sha256ExtensionJson,
  type ConnectorReadRequestV1,
  type ConnectorReadResultV1,
  type ExtensionJsonValue,
} from "../../extensions";
import type { JSONValue } from "../components/componentTypes";
import { deterministicDigest } from "../components/manifestDigest";
import {
  WORKSPACE_CONNECTOR_CAPABILITIES,
  type WorkspaceConnectorCapability,
} from "./connectorCatalog";
import { assertNoEmbeddedSecrets } from "./resourceSecurity";
import type { ResourceSnapshot, WorkspaceResource } from "./dataTypes";

const IDENTIFIER = /^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/u;
const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/u;
const SHA256 = /^sha256:[0-9a-f]{64}$/u;
const MAX_CONFIGURATION_BYTES = 512 * 1024;
const MAX_CONNECTOR_ITEMS = 10_000;
const DEFAULT_MAX_CONNECTOR_RESULT_BYTES = 4 * 1024 * 1024;
const MAX_CONNECTOR_RESULT_BYTES = 64 * 1024 * 1024;
const RAW_SECRET_VALUE = /^(?:bearer|basic)\s+\S{8,}$|^(?:sk|rk|ghp|github_pat|xox[baprs])[-_][A-Za-z0-9._~-]{8,}$|^[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}$/iu;
const CREDENTIAL_QUERY_KEY = /(?:^|[_-])(?:api[_-]?key|authorization|bearer|credential|password|secret|token)(?:$|[_-])/iu;
const LOCAL_PATH_VALUE = /^(?:file:\/\/|\/(?:Users|home|private|tmp|var|etc|opt)(?:\/|$)|[A-Za-z]:[\\/])/u;

export type ConnectorProviderOriginV1 =
  | Readonly<{
      kind: "builtin";
      hostProviderId: string;
      hostProviderVersion: string;
    }>
  | Readonly<{
      kind: "extension";
      extensionId: string;
      extensionVersion: string;
      manifestSha256: `sha256:${string}`;
    }>;

export type ConnectorRegistrationDescriptorV1 = Readonly<{
  schemaVersion: "1.0";
  providerId: string;
  connectorType: string;
  connectorVersion: string;
  capability: WorkspaceConnectorCapability;
  origin: ConnectorProviderOriginV1;
}>;

export type ConnectorRegistrationV1 = ConnectorRegistrationDescriptorV1 & Readonly<{
  descriptorSha256: `sha256:${string}`;
}>;

export type ConnectorRegistryResolutionV1 =
  | Readonly<{
      state: "available";
      mode: "snapshot_only" | "host_executable";
      registration: ConnectorRegistrationV1;
    }>
  | Readonly<{
      state: "missing_provider";
      mode: "read_only";
      connectorType: string;
      connectorVersion: string;
      existingSnapshotReadable: boolean;
      reason: string;
    }>;

export type ConnectorHostCallbacksV1 = Readonly<{
  /** The grant token is consumed only by this host authorization callback. */
  authorizeExtension?(request: Readonly<{
    grantToken: string;
    extensionId: string;
    extensionVersion: string;
    manifestSha256: `sha256:${string}`;
    workspaceId: string;
    providerId: string;
    permission: "connector:execute";
  }>): void | Promise<void>;
  /** Implementations are host-owned brokers; extension code is never called directly by the registry. */
  invokeConnector(request: Readonly<{
    registration: ConnectorRegistrationV1;
    read: ConnectorReadRequestV1;
    signal: AbortSignal;
  }>): Promise<ConnectorReadResultV1>;
}>;

export type ConnectorExecutionRequestV1 = Readonly<{
  workspaceId: string;
  connectorType: string;
  connectorVersion: string;
  configuration: ExtensionJsonValue;
  cursor?: string;
  limit?: number;
  grantToken?: string;
  signal?: AbortSignal;
}>;

export type NormalizedConnectorReadV1 = Readonly<{
  snapshot: Readonly<ResourceSnapshot>;
  nextCursor?: string;
  source: Readonly<{
    sourceId: string;
    sourceUrl?: string;
    license?: string;
  }>;
}>;

export class ConnectorRegistryError extends Error {
  constructor(
    readonly code:
      | "invalid_registration"
      | "digest_mismatch"
      | "registration_collision"
      | "missing_provider"
      | "read_only_connector"
      | "workspace_mismatch"
      | "permission_required"
      | "unsafe_configuration"
      | "invalid_provider_result",
    message: string,
  ) {
    super(message);
    this.name = "ConnectorRegistryError";
  }
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object" && !ArrayBuffer.isView(value) && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const nested of Object.values(value)) deepFreeze(nested);
  }
  return value;
}

function cloneJson<T extends ExtensionJsonValue>(value: T): T {
  return deepFreeze(extensionJsonClone(value));
}

function assertIdentifier(value: string, label: string): void {
  if (typeof value !== "string" || value.length > 128 || !IDENTIFIER.test(value)) {
    throw new ConnectorRegistryError("invalid_registration", `${label} is invalid.`);
  }
}

function assertSemver(value: string, label: string): void {
  if (typeof value !== "string" || value.length > 128 || !SEMVER.test(value)) {
    throw new ConnectorRegistryError("invalid_registration", `${label} must be a semantic version.`);
  }
}

function assertSha256(value: string, label: string): asserts value is `sha256:${string}` {
  if (!SHA256.test(value)) {
    throw new ConnectorRegistryError("invalid_registration", `${label} must be a lowercase SHA-256 digest.`);
  }
}

function registrationKey(connectorType: string, connectorVersion: string): string {
  return `${connectorType}\u0000${connectorVersion}`;
}

function descriptorDocument(
  registration: ConnectorRegistrationDescriptorV1 | ConnectorRegistrationV1,
): ExtensionJsonValue {
  return {
    schemaVersion: registration.schemaVersion,
    providerId: registration.providerId,
    connectorType: registration.connectorType,
    connectorVersion: registration.connectorVersion,
    capability: registration.capability as unknown as ExtensionJsonValue,
    origin: registration.origin as unknown as ExtensionJsonValue,
  };
}

export async function connectorRegistrationDescriptorSha256V1(
  registration: ConnectorRegistrationDescriptorV1,
): Promise<`sha256:${string}`> {
  return sha256ExtensionJson(descriptorDocument(registration));
}

function assertRawSecretsAbsent(value: ExtensionJsonValue, path = "$", depth = 0): void {
  if (depth > 64) {
    throw new ConnectorRegistryError("unsafe_configuration", "Connector configuration is too deeply nested.");
  }
  if (typeof value === "string") {
    if (RAW_SECRET_VALUE.test(value.trim())) {
      throw new ConnectorRegistryError(
        "unsafe_configuration",
        `Connector configuration contains credential material at ${path}; use a host-owned secret reference.`,
      );
    }
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((entry, index) => assertRawSecretsAbsent(entry, `${path}[${index}]`, depth + 1));
    return;
  }
  if (!value || typeof value !== "object") return;
  for (const [key, entry] of Object.entries(value)) {
    assertRawSecretsAbsent(entry, `${path}.${key}`, depth + 1);
  }
}

function canonicalTimestamp(value: string): string {
  if (typeof value !== "string" || value.length > 100) {
    throw new ConnectorRegistryError("invalid_provider_result", "Connector observedAt is invalid.");
  }
  const date = new Date(value);
  if (Number.isNaN(date.valueOf()) || date.toISOString() !== value) {
    throw new ConnectorRegistryError("invalid_provider_result", "Connector observedAt must be a canonical ISO timestamp.");
  }
  return value;
}

function boundedText(value: unknown, label: string, maxLength: number): string {
  if (typeof value !== "string" || value.length < 1 || value.length > maxLength || /[\u0000-\u001f\u007f]/u.test(value)) {
    throw new ConnectorRegistryError("invalid_provider_result", `${label} is invalid.`);
  }
  if (LOCAL_PATH_VALUE.test(value.trim()) || RAW_SECRET_VALUE.test(value.trim())) {
    throw new ConnectorRegistryError("invalid_provider_result", `${label} contains private host or credential material.`);
  }
  return value;
}

function publicSourceUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new ConnectorRegistryError("invalid_provider_result", "Connector sourceUrl is invalid.");
  }
  if ((url.protocol !== "https:" && url.protocol !== "http:") || url.username || url.password || url.hash) {
    throw new ConnectorRegistryError("invalid_provider_result", "Connector sourceUrl is not a safe public HTTP URL.");
  }
  for (const [key, queryValue] of url.searchParams) {
    if (CREDENTIAL_QUERY_KEY.test(key.normalize("NFKC")) || RAW_SECRET_VALUE.test(queryValue.trim())) {
      throw new ConnectorRegistryError("invalid_provider_result", "Connector sourceUrl contains credential material.");
    }
  }
  return url.toString();
}

function normalizeConnectorReadResult(
  result: ConnectorReadResultV1,
  maximumResultBytes: number,
): NormalizedConnectorReadV1 {
  if (!result || typeof result !== "object" || !Array.isArray(result.items) || result.items.length > MAX_CONNECTOR_ITEMS) {
    throw new ConnectorRegistryError("invalid_provider_result", "Connector returned an invalid item collection.");
  }
  try {
    boundedExtensionJsonByteLength(result.items, { maxBytes: maximumResultBytes });
  } catch {
    throw new ConnectorRegistryError(
      "invalid_provider_result",
      `Connector item data exceeds its ${maximumResultBytes}-byte canonical JSON limit.`,
    );
  }
  const retrievedAt = canonicalTimestamp(result.observedAt);
  const data = cloneJson(result.items as readonly ExtensionJsonValue[]) as unknown as JSONValue;
  assertNoEmbeddedSecrets(data);
  assertRawSecretsAbsent(data as unknown as ExtensionJsonValue);
  const sourceId = boundedText(result.source?.sourceId, "Connector sourceId", 256);
  const sourceUrl = result.source.sourceUrl === undefined ? undefined : publicSourceUrl(result.source.sourceUrl);
  const license = result.source.license === undefined
    ? undefined
    : boundedText(result.source.license, "Connector source license", 512);
  const nextCursor = result.nextCursor === undefined
    ? undefined
    : boundedText(result.nextCursor, "Connector cursor", 4_096);
  const source = deepFreeze({
    sourceId,
    ...(sourceUrl ? { sourceUrl } : {}),
    ...(license ? { license } : {}),
  });
  const snapshot = deepFreeze({
    data,
    contentHash: deterministicDigest(data),
    retrievedAt,
    stale: false,
    provenance: [{
      publisher: sourceId,
      ...(sourceUrl ? { uri: sourceUrl } : {}),
      retrievedAt,
      ...(license ? { citation: `License: ${license}` } : {}),
    }],
  });
  return deepFreeze({ snapshot, ...(nextCursor ? { nextCursor } : {}), source });
}

function validateRegistrationShape(registration: ConnectorRegistrationV1): void {
  if (registration.schemaVersion !== "1.0") {
    throw new ConnectorRegistryError("invalid_registration", "Connector registration schemaVersion is unsupported.");
  }
  assertIdentifier(registration.providerId, "Connector providerId");
  assertIdentifier(registration.connectorType, "Connector type");
  assertSemver(registration.connectorVersion, "Connector version");
  assertSha256(registration.descriptorSha256, "Connector descriptor digest");
  if (registration.capability.connectorType !== registration.connectorType
    || registration.capability.connectorVersion !== registration.connectorVersion) {
    throw new ConnectorRegistryError("invalid_registration", "Connector capability identity does not match its registration.");
  }
  if (registration.origin.kind === "builtin") {
    assertIdentifier(registration.origin.hostProviderId, "Built-in host provider id");
    assertSemver(registration.origin.hostProviderVersion, "Built-in host provider version");
  } else {
    assertIdentifier(registration.origin.extensionId, "Extension id");
    assertSemver(registration.origin.extensionVersion, "Extension version");
    assertSha256(registration.origin.manifestSha256, "Extension manifest digest");
  }
  try {
    canonicalizeExtensionJson(descriptorDocument(registration));
  } catch (error) {
    throw new ConnectorRegistryError(
      "invalid_registration",
      `Connector registration is not canonical JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

async function firstPartyRegistrations(): Promise<readonly ConnectorRegistrationV1[]> {
  const capabilities = WORKSPACE_CONNECTOR_CAPABILITIES.filter((capability) =>
    capability.connectorType === "inline.snapshot" || capability.connectorType === "http.feed",
  );
  return Promise.all(capabilities.map(async (capability) => {
    const descriptor: ConnectorRegistrationDescriptorV1 = {
      schemaVersion: "1.0",
      providerId: `semaframe.${capability.connectorType}`,
      connectorType: capability.connectorType,
      connectorVersion: capability.connectorVersion,
      capability,
      origin: {
        kind: "builtin",
        hostProviderId: "semaframe.host",
        hostProviderVersion: "1.0.0",
      },
    };
    return {
      ...descriptor,
      descriptorSha256: await connectorRegistrationDescriptorSha256V1(descriptor),
    };
  }));
}

/**
 * Immutable connector authority captured when a workspace opens.
 *
 * There is intentionally no register/unregister method. Installing an
 * extension changes the provider set for the next workspace session; it never
 * hot-swaps executable code beneath an already-open project.
 */
export class ConnectorRegistryV1 {
  readonly workspaceId: string;
  readonly registrySha256: `sha256:${string}`;
  readonly #registrations: readonly ConnectorRegistrationV1[];
  readonly #byKey: ReadonlyMap<string, ConnectorRegistrationV1>;
  readonly #maximumResultBytes: number;

  private constructor(
    workspaceId: string,
    registrations: readonly ConnectorRegistrationV1[],
    registrySha256: `sha256:${string}`,
    maximumResultBytes: number,
  ) {
    this.workspaceId = workspaceId;
    this.registrySha256 = registrySha256;
    this.#maximumResultBytes = maximumResultBytes;
    this.#registrations = registrations;
    this.#byKey = new Map(registrations.map((registration) => [
      registrationKey(registration.connectorType, registration.connectorVersion),
      registration,
    ]));
    Object.freeze(this);
  }

  static async create(input: Readonly<{
    workspaceId: string;
    extensions?: readonly ConnectorRegistrationV1[];
    includeFirstParty?: boolean;
    maxResultBytes?: number;
  }>): Promise<ConnectorRegistryV1> {
    if (typeof input.workspaceId !== "string" || input.workspaceId.length < 1 || input.workspaceId.length > 256
      || /[\u0000-\u001f\u007f]/u.test(input.workspaceId)) {
      throw new ConnectorRegistryError("invalid_registration", "Workspace id is invalid.");
    }
    const maximumResultBytes = input.maxResultBytes ?? DEFAULT_MAX_CONNECTOR_RESULT_BYTES;
    if (!Number.isSafeInteger(maximumResultBytes)
      || maximumResultBytes < 1
      || maximumResultBytes > MAX_CONNECTOR_RESULT_BYTES) {
      throw new ConnectorRegistryError(
        "invalid_registration",
        `Connector maxResultBytes must be between 1 and ${MAX_CONNECTOR_RESULT_BYTES}.`,
      );
    }
    const candidates = [
      ...(input.includeFirstParty === false ? [] : await firstPartyRegistrations()),
      ...(input.extensions ?? []),
    ];
    const registrations: ConnectorRegistrationV1[] = [];
    const keys = new Set<string>();
    const providerIds = new Set<string>();
    for (const candidate of candidates) {
      validateRegistrationShape(candidate);
      const descriptorSha256 = await connectorRegistrationDescriptorSha256V1(candidate);
      if (descriptorSha256 !== candidate.descriptorSha256) {
        throw new ConnectorRegistryError(
          "digest_mismatch",
          `Connector ${candidate.connectorType}@${candidate.connectorVersion} descriptor digest does not match its contents.`,
        );
      }
      const key = registrationKey(candidate.connectorType, candidate.connectorVersion);
      if (keys.has(key) || providerIds.has(candidate.providerId)) {
        throw new ConnectorRegistryError(
          "registration_collision",
          `Connector registration collides with ${candidate.providerId}.`,
        );
      }
      keys.add(key);
      providerIds.add(candidate.providerId);
      registrations.push(deepFreeze(structuredClone(candidate)));
    }
    registrations.sort((left, right) =>
      left.connectorType.localeCompare(right.connectorType) || left.connectorVersion.localeCompare(right.connectorVersion),
    );
    const frozen = Object.freeze(registrations);
    const registrySha256 = await sha256ExtensionJson({
      schemaVersion: "1.0",
      workspaceId: input.workspaceId,
      registrations: frozen.map((registration) => ({
        descriptorSha256: registration.descriptorSha256,
        descriptor: descriptorDocument(registration),
      })),
    });
    return new ConnectorRegistryV1(input.workspaceId, frozen, registrySha256, maximumResultBytes);
  }

  list(): readonly ConnectorRegistrationV1[] {
    return this.#registrations;
  }

  resolve(connectorType: string, connectorVersion: string): ConnectorRegistrationV1 | undefined {
    return this.#byKey.get(registrationKey(connectorType, connectorVersion));
  }

  resolveResource(resource: Pick<WorkspaceResource, "connectorType" | "connectorVersion" | "snapshot">): ConnectorRegistryResolutionV1 {
    const registration = this.resolve(resource.connectorType, resource.connectorVersion);
    if (!registration) {
      return deepFreeze({
        state: "missing_provider",
        mode: "read_only",
        connectorType: resource.connectorType,
        connectorVersion: resource.connectorVersion,
        existingSnapshotReadable: resource.snapshot !== undefined,
        reason: `Provider ${resource.connectorType}@${resource.connectorVersion} is not installed in this workspace session.`,
      });
    }
    return deepFreeze({
      state: "available",
      mode: registration.capability.execution === "host" ? "host_executable" : "snapshot_only",
      registration,
    });
  }

  async execute(
    request: ConnectorExecutionRequestV1,
    host: ConnectorHostCallbacksV1,
  ): Promise<NormalizedConnectorReadV1> {
    if (request.workspaceId !== this.workspaceId) {
      throw new ConnectorRegistryError("workspace_mismatch", "Connector request belongs to another workspace.");
    }
    const registration = this.resolve(request.connectorType, request.connectorVersion);
    if (!registration) {
      throw new ConnectorRegistryError("missing_provider", "Connector provider is unavailable; the resource remains read-only.");
    }
    if (registration.capability.execution !== "host") {
      throw new ConnectorRegistryError("read_only_connector", "This connector stores snapshots and has no executable provider.");
    }
    let configuration: ExtensionJsonValue;
    try {
      configuration = extensionJsonClone(request.configuration);
      if (new TextEncoder().encode(canonicalizeExtensionJson(configuration)).byteLength > MAX_CONFIGURATION_BYTES) {
        throw new ConnectorRegistryError("unsafe_configuration", "Connector configuration exceeds its byte limit.");
      }
      assertNoEmbeddedSecrets(configuration as unknown as JSONValue);
      assertRawSecretsAbsent(configuration);
    } catch (error) {
      if (error instanceof ConnectorRegistryError) throw error;
      throw new ConnectorRegistryError(
        "unsafe_configuration",
        error instanceof Error ? error.message : "Connector configuration is unsafe.",
      );
    }
    if (request.limit !== undefined && (!Number.isSafeInteger(request.limit) || request.limit < 1 || request.limit > 10_000)) {
      throw new ConnectorRegistryError("unsafe_configuration", "Connector limit must be between 1 and 10000.");
    }
    if (request.cursor !== undefined && (request.cursor.length < 1 || request.cursor.length > 4_096)) {
      throw new ConnectorRegistryError("unsafe_configuration", "Connector cursor is invalid.");
    }
    if (registration.origin.kind === "extension") {
      if (!request.grantToken || typeof host.authorizeExtension !== "function") {
        throw new ConnectorRegistryError("permission_required", "Extension connector execution requires a host capability grant.");
      }
      await host.authorizeExtension({
        grantToken: request.grantToken,
        extensionId: registration.origin.extensionId,
        extensionVersion: registration.origin.extensionVersion,
        manifestSha256: registration.origin.manifestSha256,
        workspaceId: this.workspaceId,
        providerId: registration.providerId,
        permission: "connector:execute",
      });
    }
    const signal = request.signal ?? new AbortController().signal;
    const result = await host.invokeConnector({
      registration,
      read: Object.freeze({
        configuration: cloneJson(configuration),
        ...(request.cursor ? { cursor: request.cursor } : {}),
        ...(request.limit ? { limit: request.limit } : {}),
      }),
      signal,
    });
    return normalizeConnectorReadResult(result, this.#maximumResultBytes);
  }
}
