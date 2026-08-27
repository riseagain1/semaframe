import {
  sha256ExtensionJson,
  type ExtensionJsonValue,
} from "../../extensions";

export const ARTIFACT_JOB_SCHEMA_VERSION = "1.0" as const;

export type ArtifactProviderOriginV1 =
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
      requiredPermission: "exporter:execute" | "bridge:push" | "bridge:pull";
    }>;

export type ArtifactProviderDescriptorDocumentV1 = Readonly<{
  schemaVersion: typeof ARTIFACT_JOB_SCHEMA_VERSION;
  kind: "exporter" | "bridge";
  providerId: string;
  providerVersion: string;
  displayName: string;
  origin: ArtifactProviderOriginV1;
}>;

export type ArtifactProviderDescriptorV1 = ArtifactProviderDescriptorDocumentV1 & Readonly<{
  descriptorSha256: `sha256:${string}`;
}>;

export async function artifactProviderDescriptorSha256V1(
  descriptor: ArtifactProviderDescriptorDocumentV1,
): Promise<`sha256:${string}`> {
  return sha256ExtensionJson({
    schemaVersion: descriptor.schemaVersion,
    kind: descriptor.kind,
    providerId: descriptor.providerId,
    providerVersion: descriptor.providerVersion,
    displayName: descriptor.displayName,
    origin: descriptor.origin as unknown as ExtensionJsonValue,
  });
}

export type ArtifactJobScopeV1 = Readonly<{
  ownerId: string;
  workspaceId: string;
  providerId: string;
}>;

export type ArtifactJobSubmitRequestV1 = ArtifactJobScopeV1 & Readonly<{
  requestId: string;
  input: ExtensionJsonValue;
  options?: ExtensionJsonValue;
}>;

export type ArtifactJobProgressV1 = Readonly<{
  fraction: number;
  message?: string;
}>;

export type ArtifactJobArtifactV1 = Readonly<{
  artifactId: `sha256:${string}`;
  fileName: string;
  mediaType: string;
  byteLength: number;
  sha256: `sha256:${string}`;
  metadata?: ExtensionJsonValue;
}>;

export type ArtifactJobErrorV1 = Readonly<{
  code:
    | "canceled"
    | "timeout"
    | "provider_failed"
    | "output_limit_exceeded"
    | "invalid_provider_output"
    | "permission_denied";
  message: string;
}>;

export type ArtifactJobStatusV1 = "queued" | "running" | "succeeded" | "failed" | "canceled";

export type ArtifactJobSnapshotV1 = Readonly<{
  schemaVersion: typeof ARTIFACT_JOB_SCHEMA_VERSION;
  jobId: string;
  requestId: string;
  ownerId: string;
  workspaceId: string;
  provider: ArtifactProviderDescriptorV1;
  requestSha256: `sha256:${string}`;
  status: ArtifactJobStatusV1;
  progress: ArtifactJobProgressV1;
  artifacts: readonly ArtifactJobArtifactV1[];
  error?: ArtifactJobErrorV1;
  createdAt: string;
  startedAt?: string;
  completedAt?: string;
  expiresAt: string;
}>;

export type ArtifactCandidateV1 = Readonly<{
  fileName: string;
  mediaType: string;
  bytes: Uint8Array;
  metadata?: ExtensionJsonValue;
}>;

export type ArtifactProviderOperationContextV1 = Readonly<{
  operationId: string;
  workspaceId: string;
  signal: AbortSignal;
  limits: Readonly<{
    maxArtifacts: number;
    maxOutputBytes: number;
    maxRuntimeMs: number;
  }>;
  updateProgress(progress: ArtifactJobProgressV1): void;
}>;

export type ArtifactProviderRegistrationV1 = Readonly<{
  descriptor: ArtifactProviderDescriptorV1;
  run(
    request: Readonly<{ input: ExtensionJsonValue; options?: ExtensionJsonValue }>,
    context: ArtifactProviderOperationContextV1,
  ): Promise<readonly ArtifactCandidateV1[]>;
}>;
