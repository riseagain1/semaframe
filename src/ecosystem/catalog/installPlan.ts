import {
  WORKSPACE_PROTOCOL_VERSION,
  validateWorkspaceCommandBatch,
  type WorkspaceCommandBatch,
} from "../../workspace/protocol";
import { compareExtensionSemverV1 } from "../../extensions";
import type {
  ModelTemplateDescriptor,
  ProjectTemplateDescriptor,
  TemplateInstallProposal,
} from "./contracts";

const REQUEST_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._~-]{0,127}$/u;

function opaque(value: string, name: string): string {
  if (!REQUEST_ID_PATTERN.test(value)) throw new TypeError(`${name} must be a bounded opaque identifier`);
  return value;
}

function registryDigest(value: string): string {
  if (value.length < 1 || value.length > 256 || /[\u0000-\u001f\u007f]/u.test(value)) {
    throw new TypeError("registryDigest must be a bounded printable digest");
  }
  return value;
}

function assertCompatibleAppVersion(
  descriptor: ProjectTemplateDescriptor | ModelTemplateDescriptor,
  appVersion: string,
): void {
  let comparison: -1 | 0 | 1;
  try {
    comparison = compareExtensionSemverV1(appVersion, descriptor.minimumAppVersion);
  } catch {
    throw new TypeError("appVersion must be a semantic version");
  }
  if (comparison < 0) {
    throw new RangeError(
      `Template ${descriptor.id}@${descriptor.version} requires SemaFrame ${descriptor.minimumAppVersion} or newer; current app is ${appVersion}.`,
    );
  }
}

function deepFreeze<T>(value: T): T {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const item of Object.values(value as Record<string, unknown>)) deepFreeze(item);
  return Object.freeze(value);
}

function transaction(input: Readonly<{
  descriptor: ProjectTemplateDescriptor | ModelTemplateDescriptor;
  requestId: string;
  workspaceId: string;
  revision: number;
  registryDigest: string;
}>): WorkspaceCommandBatch {
  if (!Number.isSafeInteger(input.revision) || input.revision < 0) {
    throw new TypeError("revision must be a non-negative safe integer");
  }
  return deepFreeze(validateWorkspaceCommandBatch({
    protocol_version: WORKSPACE_PROTOCOL_VERSION,
    request_id: opaque(input.requestId, "requestId"),
    workspace_id: opaque(input.workspaceId, "workspaceId"),
    input_revision: input.revision,
    base_workspace_revision: input.revision,
    registry_digest: registryDigest(input.registryDigest),
    mode: "commit",
    operations: structuredClone(input.descriptor.operations),
  }));
}

/**
 * Produces reviewable data only. This module has no store, network, persistence,
 * or authorization dependency and therefore cannot execute or authorize a plan.
 */
export function planProjectTemplateInstallation(
  descriptor: ProjectTemplateDescriptor,
  context: Readonly<{
    requestId: string;
    proposedWorkspaceId: string;
    registryDigest: string;
    appVersion: string;
  }>,
): TemplateInstallProposal {
  assertCompatibleAppVersion(descriptor, context.appVersion);
  return Object.freeze({
    kind: "new_project_proposal",
    template: Object.freeze({ id: descriptor.id, version: descriptor.version }),
    suggestedTitle: descriptor.newProject.suggestedTitle,
    authorization: Object.freeze({
      status: "not_granted",
      requiredPermissions: Object.freeze([...descriptor.requiredPermissions]),
    }),
    transaction: transaction({
      descriptor,
      requestId: context.requestId,
      workspaceId: context.proposedWorkspaceId,
      revision: 0,
      registryDigest: context.registryDigest,
    }),
  });
}

export function planModelTemplateInstallation(
  descriptor: ModelTemplateDescriptor,
  context: Readonly<{
    requestId: string;
    workspaceId: string;
    workspaceRevision: number;
    registryDigest: string;
    appVersion: string;
  }>,
): TemplateInstallProposal {
  assertCompatibleAppVersion(descriptor, context.appVersion);
  return Object.freeze({
    kind: "workspace_transaction_proposal",
    template: Object.freeze({ id: descriptor.id, version: descriptor.version }),
    authorization: Object.freeze({
      status: "not_granted",
      requiredPermissions: Object.freeze([...descriptor.requiredPermissions]),
    }),
    transaction: transaction({
      descriptor,
      requestId: context.requestId,
      workspaceId: context.workspaceId,
      revision: context.workspaceRevision,
      registryDigest: context.registryDigest,
    }),
  });
}
