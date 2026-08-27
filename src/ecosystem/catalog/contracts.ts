import type {
  WorkspaceCommandBatch,
  WorkspaceOperation,
  WorkspacePermission,
} from "../../workspace/protocol";

export const STATIC_TEMPLATE_CATALOG_VERSION = "1" as const;
export const TEMPLATE_DESCRIPTOR_VERSION = "1" as const;
export const TEMPLATE_CATALOG_SIGNATURE_ALGORITHM = "Ed25519" as const;

export type Sha256Digest = `sha256:${string}`;
export type TemplateKind = "project" | "model";

export type StaticTemplateCatalogEntry = Readonly<{
  id: string;
  kind: TemplateKind;
  version: string;
  title: string;
  summary: string;
  license: string;
  publisher: string;
  artifactPath: string;
  artifactDigest: Sha256Digest;
}>;

export type StaticTemplateCatalog = Readonly<{
  schemaVersion: typeof STATIC_TEMPLATE_CATALOG_VERSION;
  catalogId: string;
  sequence: number;
  generatedAt: string;
  expiresAt: string;
  entries: readonly StaticTemplateCatalogEntry[];
  signature: Readonly<{
    algorithm: typeof TEMPLATE_CATALOG_SIGNATURE_ALGORITHM;
    keyId: string;
    value: string;
  }>;
}>;

type TemplateDescriptorBase = Readonly<{
  schemaVersion: typeof TEMPLATE_DESCRIPTOR_VERSION;
  id: string;
  version: string;
  title: string;
  summary: string;
  license: string;
  minimumAppVersion: string;
  requiredPermissions: readonly WorkspacePermission[];
  operations: readonly WorkspaceOperation[];
}>;

export type ProjectTemplateDescriptor = TemplateDescriptorBase & Readonly<{
  kind: "project";
  newProject: Readonly<{
    suggestedTitle: string;
  }>;
}>;

export type ModelTemplateDescriptor = TemplateDescriptorBase & Readonly<{
  kind: "model";
}>;

export type TemplateDescriptor = ProjectTemplateDescriptor | ModelTemplateDescriptor;

export type TemplateInstallAuthorization = Readonly<{
  status: "not_granted";
  requiredPermissions: readonly WorkspacePermission[];
}>;

export type NewProjectTemplateProposal = Readonly<{
  kind: "new_project_proposal";
  template: Readonly<{ id: string; version: string }>;
  suggestedTitle: string;
  authorization: TemplateInstallAuthorization;
  transaction: WorkspaceCommandBatch;
}>;

export type ModelTemplateTransactionProposal = Readonly<{
  kind: "workspace_transaction_proposal";
  template: Readonly<{ id: string; version: string }>;
  authorization: TemplateInstallAuthorization;
  transaction: WorkspaceCommandBatch;
}>;

export type TemplateInstallProposal =
  | NewProjectTemplateProposal
  | ModelTemplateTransactionProposal;

export type VerifiedCatalogCacheRecord = Readonly<{
  catalog: StaticTemplateCatalog;
  catalogDigest: Sha256Digest;
  fetchedAtMs: number;
  verifiedAtMs: number;
}>;

export type CatalogCacheDecision = Readonly<{
  action: "use_cached" | "use_stale_verified" | "revalidate" | "fetch_required";
  catalog?: StaticTemplateCatalog;
  reason: "fresh" | "offline_within_signed_validity" | "stale" | "expired" | "missing" | "unverified";
}>;
