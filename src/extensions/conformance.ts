import {
  canonicalizeExtensionJson,
  extensionJsonByteLength,
  type ExtensionJsonValue,
} from "./canonicalJson";
import type {
  ConnectorProviderV1,
  ExporterProviderV1,
  ExportRequestV1,
  ExtensionCapabilityBrokerV1,
  ExtensionOperationContextV1,
  ExtensionPermissionIdV1,
} from "./contracts";

export type ExtensionConformanceCaseV1 = Readonly<{
  name: string;
  passed: boolean;
  message?: string;
}>;

export type ExtensionConformanceReportV1 = Readonly<{
  apiVersion: "1.0";
  providerId: string;
  providerKind: "connector" | "exporter";
  passed: boolean;
  cases: readonly ExtensionConformanceCaseV1[];
}>;

export type ExtensionConformanceContextOptionsV1 = Readonly<{
  extensionId?: string;
  extensionVersion?: string;
  workspaceId?: string;
  grantedPermissions?: readonly ExtensionPermissionIdV1[];
  signal?: AbortSignal;
}>;

const denyBroker: ExtensionCapabilityBrokerV1 = Object.freeze({
  async fetch() { throw new Error("Conformance broker does not grant network access."); },
  async readArtifact() { throw new Error("Conformance broker does not grant artifact access."); },
  async useSecret() { throw new Error("Conformance broker does not grant secret access."); },
});

export function createExtensionConformanceContextV1(
  options: ExtensionConformanceContextOptionsV1 = {},
): ExtensionOperationContextV1 {
  return Object.freeze({
    apiVersion: "1.0",
    operationId: "conformance-operation",
    extensionId: options.extensionId ?? "example.extension",
    extensionVersion: options.extensionVersion ?? "1.0.0",
    workspaceId: options.workspaceId ?? "conformance-workspace",
    grantedPermissions: Object.freeze([...(options.grantedPermissions ?? [])]),
    limits: Object.freeze({
      maxInputBytes: 1024 * 1024,
      maxOutputBytes: 1024 * 1024,
      maxArtifacts: 16,
      maxArtifactBytes: 16 * 1024 * 1024,
      timeoutMs: 5_000,
    }),
    signal: options.signal ?? new AbortController().signal,
    broker: denyBroker,
    log() {},
  });
}

function exactKeys(value: unknown, allowed: readonly string[], label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${label} must be an object.`);
  }
  const record = value as Record<string, unknown>;
  const extra = Object.keys(record).find((key) => !allowed.includes(key));
  if (extra) throw new TypeError(`${label} contains unknown field ${extra}.`);
  return record;
}

function assertProviderIdentity(provider: { kind: string; id: string }, expectedKind: string): void {
  if (provider.kind !== expectedKind) throw new TypeError(`Provider kind must be ${expectedKind}.`);
  if (!/^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/u.test(provider.id) || provider.id.length > 128) {
    throw new TypeError("Provider id is invalid.");
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message.slice(0, 500) : "Unknown conformance failure.";
}

async function captureCase(name: string, test: () => void | Promise<void>): Promise<ExtensionConformanceCaseV1> {
  try {
    await test();
    return Object.freeze({ name, passed: true });
  } catch (error) {
    return Object.freeze({ name, passed: false, message: errorMessage(error) });
  }
}

function finishReport(
  providerId: string,
  providerKind: "connector" | "exporter",
  cases: readonly ExtensionConformanceCaseV1[],
): ExtensionConformanceReportV1 {
  return Object.freeze({
    apiVersion: "1.0",
    providerId,
    providerKind,
    passed: cases.every((entry) => entry.passed),
    cases: Object.freeze([...cases]),
  });
}

export async function runConnectorProviderConformanceV1(input: Readonly<{
  provider: ConnectorProviderV1;
  configuration?: ExtensionJsonValue;
  context?: ExtensionOperationContextV1;
}>): Promise<ExtensionConformanceReportV1> {
  const configuration = input.configuration ?? {};
  const context = input.context ?? createExtensionConformanceContextV1({
    grantedPermissions: ["connector:execute"],
  });
  let probeResult: Awaited<ReturnType<ConnectorProviderV1["probe"]>> | undefined;
  let readResult: Awaited<ReturnType<ConnectorProviderV1["read"]>> | undefined;
  const configurationBefore = canonicalizeExtensionJson(configuration);
  const cases = [
    await captureCase("provider identity", () => assertProviderIdentity(input.provider, "connector")),
    await captureCase("probe contract", async () => {
      probeResult = await input.provider.probe(configuration, context);
      const body = exactKeys(probeResult, ["available", "reason"], "Connector probe result");
      if (typeof body.available !== "boolean") throw new TypeError("Connector probe available must be boolean.");
      if (body.reason !== undefined && (typeof body.reason !== "string" || body.reason.length > 500)) {
        throw new TypeError("Connector probe reason is invalid.");
      }
      if (extensionJsonByteLength(probeResult as unknown as ExtensionJsonValue) > context.limits.maxOutputBytes) {
        throw new RangeError("Connector probe exceeds maxOutputBytes.");
      }
    }),
    await captureCase("read contract", async () => {
      readResult = await input.provider.read({ configuration, limit: 10 }, context);
      const body = exactKeys(readResult, ["items", "nextCursor", "observedAt", "source"], "Connector read result");
      if (!Array.isArray(body.items) || body.items.length > 10) throw new TypeError("Connector items are invalid.");
      body.items.forEach((item) => canonicalizeExtensionJson(item));
      if (typeof body.observedAt !== "string" || !Number.isFinite(Date.parse(body.observedAt))) {
        throw new TypeError("Connector observedAt must be an ISO-compatible timestamp.");
      }
      if (body.nextCursor !== undefined && (typeof body.nextCursor !== "string" || body.nextCursor.length > 2_048)) {
        throw new TypeError("Connector nextCursor is invalid.");
      }
      const source = exactKeys(body.source, ["sourceId", "sourceUrl", "license"], "Connector source");
      if (typeof source.sourceId !== "string" || source.sourceId.length < 1 || source.sourceId.length > 256) {
        throw new TypeError("Connector sourceId is invalid.");
      }
      if (extensionJsonByteLength(readResult as unknown as ExtensionJsonValue) > context.limits.maxOutputBytes) {
        throw new RangeError("Connector result exceeds maxOutputBytes.");
      }
    }),
    await captureCase("input immutability", () => {
      if (canonicalizeExtensionJson(configuration) !== configurationBefore) {
        throw new TypeError("Connector mutated its configuration input.");
      }
    }),
  ];
  void probeResult;
  void readResult;
  return finishReport(input.provider.id, "connector", cases);
}

function assertSafeArtifactName(fileName: string): void {
  if (!fileName || fileName.length > 256 || fileName.includes("/") || fileName.includes("\\")
    || fileName === "." || fileName === ".." || /[\u0000-\u001f\u007f]/u.test(fileName)) {
    throw new TypeError("Exporter artifact filename is unsafe.");
  }
}

export async function runExporterProviderConformanceV1(input: Readonly<{
  provider: ExporterProviderV1;
  request?: ExportRequestV1;
  context?: ExtensionOperationContextV1;
}>): Promise<ExtensionConformanceReportV1> {
  const request: ExportRequestV1 = input.request ?? Object.freeze({
    formatId: "json",
    workspaceSnapshot: Object.freeze({ components: Object.freeze([]) }),
  });
  const context = input.context ?? createExtensionConformanceContextV1({
    grantedPermissions: ["workspace:read", "exporter:execute", "artifact:write"],
  });
  const requestBefore = canonicalizeExtensionJson(request as unknown as ExtensionJsonValue);
  const cases = [
    await captureCase("provider identity", () => assertProviderIdentity(input.provider, "exporter")),
    await captureCase("plan contract", async () => {
      const plan = await input.provider.plan(request, context);
      const body = exactKeys(plan, ["formatId", "artifactNames", "warnings"], "Export plan");
      if (body.formatId !== request.formatId) throw new TypeError("Export plan formatId does not match the request.");
      if (!Array.isArray(body.artifactNames) || body.artifactNames.length < 1
        || body.artifactNames.length > context.limits.maxArtifacts) {
        throw new TypeError("Export plan artifact names are invalid.");
      }
      body.artifactNames.forEach((name) => {
        if (typeof name !== "string") throw new TypeError("Export plan artifact name must be a string.");
        assertSafeArtifactName(name);
      });
      canonicalizeExtensionJson(plan as unknown as ExtensionJsonValue);
    }),
    await captureCase("export contract", async () => {
      const artifacts = await input.provider.export(request, context);
      if (!Array.isArray(artifacts) || artifacts.length < 1 || artifacts.length > context.limits.maxArtifacts) {
        throw new TypeError("Exporter returned an invalid artifact count.");
      }
      const names = new Set<string>();
      let totalBytes = 0;
      for (const artifact of artifacts) {
        const body = exactKeys(artifact, ["fileName", "mediaType", "bytes", "metadata"], "Export artifact");
        if (typeof body.fileName !== "string") throw new TypeError("Export artifact filename is invalid.");
        assertSafeArtifactName(body.fileName);
        if (names.has(body.fileName)) throw new TypeError("Export artifact filenames must be unique.");
        names.add(body.fileName);
        if (typeof body.mediaType !== "string" || !body.mediaType.includes("/")) {
          throw new TypeError("Export artifact mediaType is invalid.");
        }
        if (!ArrayBuffer.isView(body.bytes) || (body.bytes as Uint8Array).BYTES_PER_ELEMENT !== 1) {
          throw new TypeError("Export artifact bytes must be Uint8Array.");
        }
        if (body.bytes.byteLength > context.limits.maxArtifactBytes) throw new RangeError("Export artifact is too large.");
        totalBytes += body.bytes.byteLength;
        if (body.metadata !== undefined) canonicalizeExtensionJson(body.metadata);
      }
      if (totalBytes > context.limits.maxOutputBytes) throw new RangeError("Exporter output exceeds maxOutputBytes.");
    }),
    await captureCase("input immutability", () => {
      if (canonicalizeExtensionJson(request as unknown as ExtensionJsonValue) !== requestBefore) {
        throw new TypeError("Exporter mutated its request input.");
      }
    }),
  ];
  return finishReport(input.provider.id, "exporter", cases);
}
