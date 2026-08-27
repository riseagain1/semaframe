import type { ExtensionJsonValue } from "./canonicalJson";

export const EXTENSION_API_VERSION = "1.0" as const;

export const EXTENSION_PERMISSION_IDS = [
  "workspace:read",
  "workspace:propose",
  "artifact:read",
  "artifact:write",
  "connector:execute",
  "importer:execute",
  "exporter:execute",
  "bridge:pull",
  "bridge:push",
  "network:brokered",
  "secret:use",
  "native:stdio",
] as const;

export type ExtensionPermissionIdV1 = typeof EXTENSION_PERMISSION_IDS[number];
export type ExtensionProviderKindV1 = "connector" | "importer" | "exporter" | "bridge";

export type ExtensionOperationLimitsV1 = Readonly<{
  maxInputBytes: number;
  maxOutputBytes: number;
  maxArtifacts: number;
  maxArtifactBytes: number;
  timeoutMs: number;
}>;

export type ExtensionLogEventV1 = Readonly<{
  level: "debug" | "info" | "warn" | "error";
  code: string;
  message: string;
  details?: ExtensionJsonValue;
}>;

export type ExtensionBrokerRequestV1 = Readonly<{
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  url: string;
  headers?: Readonly<Record<string, string>>;
  bodyBase64?: string;
  timeoutMs?: number;
}>;

export type ExtensionBrokerResponseV1 = Readonly<{
  status: number;
  headers: Readonly<Record<string, string>>;
  bodyBase64: string;
}>;

export type ExtensionArtifactRefV1 = Readonly<{
  artifactId: string;
  mediaType: string;
  byteLength: number;
  sha256: `sha256:${string}`;
}>;

export type ExtensionArtifactCandidateV1 = Readonly<{
  fileName: string;
  mediaType: string;
  bytes: Uint8Array;
  metadata?: ExtensionJsonValue;
}>;

/** Host-owned capabilities. Providers never receive ambient fetch, secrets, or filesystem paths. */
export type ExtensionCapabilityBrokerV1 = Readonly<{
  fetch(request: ExtensionBrokerRequestV1, signal?: AbortSignal): Promise<ExtensionBrokerResponseV1>;
  readArtifact(ref: ExtensionArtifactRefV1, signal?: AbortSignal): Promise<Uint8Array>;
  useSecret(secretId: string, operation: ExtensionJsonValue, signal?: AbortSignal): Promise<ExtensionJsonValue>;
}>;

export type ExtensionOperationContextV1 = Readonly<{
  apiVersion: typeof EXTENSION_API_VERSION;
  operationId: string;
  extensionId: string;
  extensionVersion: string;
  workspaceId: string;
  grantedPermissions: readonly ExtensionPermissionIdV1[];
  limits: ExtensionOperationLimitsV1;
  signal: AbortSignal;
  broker: ExtensionCapabilityBrokerV1;
  log(event: ExtensionLogEventV1): void;
}>;

export type ConnectorReadRequestV1 = Readonly<{
  configuration: ExtensionJsonValue;
  cursor?: string;
  limit?: number;
}>;

export type ConnectorReadResultV1 = Readonly<{
  items: readonly ExtensionJsonValue[];
  nextCursor?: string;
  observedAt: string;
  source: Readonly<{
    sourceId: string;
    sourceUrl?: string;
    license?: string;
  }>;
}>;

export type ConnectorProviderV1 = Readonly<{
  kind: "connector";
  id: string;
  probe(configuration: ExtensionJsonValue, context: ExtensionOperationContextV1): Promise<Readonly<{
    available: boolean;
    reason?: string;
  }>>;
  read(request: ConnectorReadRequestV1, context: ExtensionOperationContextV1): Promise<ConnectorReadResultV1>;
}>;

export type ImportInspectionV1 = Readonly<{
  recognized: boolean;
  formatId?: string;
  summary?: string;
  warnings?: readonly string[];
}>;

export type WorkspaceMutationCandidateV1 = Readonly<{
  schemaId: string;
  document: ExtensionJsonValue;
  warnings?: readonly string[];
}>;

export type ImporterProviderV1 = Readonly<{
  kind: "importer";
  id: string;
  inspect(artifact: ExtensionArtifactRefV1, context: ExtensionOperationContextV1): Promise<ImportInspectionV1>;
  import(artifact: ExtensionArtifactRefV1, context: ExtensionOperationContextV1): Promise<WorkspaceMutationCandidateV1>;
}>;

export type ExportPlanV1 = Readonly<{
  formatId: string;
  artifactNames: readonly string[];
  warnings?: readonly string[];
}>;

export type ExportRequestV1 = Readonly<{
  formatId: string;
  workspaceSnapshot: ExtensionJsonValue;
  options?: ExtensionJsonValue;
}>;

export type ExporterProviderV1 = Readonly<{
  kind: "exporter";
  id: string;
  plan(request: ExportRequestV1, context: ExtensionOperationContextV1): Promise<ExportPlanV1>;
  export(request: ExportRequestV1, context: ExtensionOperationContextV1): Promise<readonly ExtensionArtifactCandidateV1[]>;
}>;

export type BridgeTargetV1 = "blender" | "cad" | "unity" | "unreal" | "custom";

export type BridgeProviderV1 = Readonly<{
  kind: "bridge";
  id: string;
  target: BridgeTargetV1;
  probe(context: ExtensionOperationContextV1): Promise<Readonly<{ available: boolean; version?: string; reason?: string }>>;
  push(candidate: WorkspaceMutationCandidateV1, context: ExtensionOperationContextV1): Promise<Readonly<{
    remoteDocumentId: string;
    revision?: string;
    warnings?: readonly string[];
  }>>;
  pull(remoteDocumentId: string, context: ExtensionOperationContextV1): Promise<WorkspaceMutationCandidateV1>;
}>;

export type ExtensionProviderV1 =
  | ConnectorProviderV1
  | ImporterProviderV1
  | ExporterProviderV1
  | BridgeProviderV1;
