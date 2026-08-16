import type {
  HostFeedFetchResponse,
  HostFeedFormat,
  ResourceRefreshPolicy,
  WorkspaceHostFeedPreviewRequest,
  WorkspaceHostFeedSaveRequest,
} from "../workspace/data";

export type HostFeedAutomationDescriptor = Readonly<{
  resourceId: string;
  url: string;
  format: HostFeedFormat;
  policy: ResourceRefreshPolicy;
}>;

function policyKey(policy: ResourceRefreshPolicy): string {
  return JSON.stringify([
    policy.mode,
    policy.intervalMs ?? null,
    policy.maxStaleMs ?? null,
    policy.offline,
  ]);
}

function previewIntentKey(request: WorkspaceHostFeedPreviewRequest): string {
  return JSON.stringify([request.url, request.format, policyKey(request.policy)]);
}

function descriptorKey(descriptor: HostFeedAutomationDescriptor): string {
  return JSON.stringify([
    descriptor.url,
    descriptor.format,
    policyKey(descriptor.policy),
  ]);
}

function saveIntentKey(request: WorkspaceHostFeedSaveRequest): string {
  return JSON.stringify([
    request.feed.requestedUrl,
    request.requestedFormat,
    policyKey(request.policy),
  ]);
}

/**
 * Memory-only human consent for automatic feed reads.
 *
 * Project data can describe a refresh policy, but it can never populate this
 * ledger. A successful UI preview records the exact response object and intent;
 * an exact subsequent Save/Update consumes that preview and grants one resource
 * configuration. `reset` is the Store-generation boundary.
 */
export class HostFeedAutomationConsentLedger {
  private previewIntents = new WeakMap<HostFeedFetchResponse, string>();
  private readonly authorizedResources = new Map<string, string>();

  reset(): void {
    this.previewIntents = new WeakMap<HostFeedFetchResponse, string>();
    this.authorizedResources.clear();
  }

  recordPreview(
    request: WorkspaceHostFeedPreviewRequest,
    response: HostFeedFetchResponse,
  ): void {
    if (request.url !== response.requestedUrl) return;
    this.previewIntents.set(response, previewIntentKey(request));
  }

  matchesPreview(request: WorkspaceHostFeedSaveRequest): boolean {
    return this.previewIntents.get(request.feed) === saveIntentKey(request);
  }

  authorizePreviewedSave(
    resourceId: string,
    request: WorkspaceHostFeedSaveRequest,
  ): boolean {
    if (!this.matchesPreview(request)) return false;
    this.previewIntents.delete(request.feed);
    this.authorizedResources.set(resourceId, descriptorKey({
      resourceId,
      url: request.feed.requestedUrl,
      format: request.requestedFormat,
      policy: request.policy,
    }));
    return true;
  }

  isAuthorized(descriptor: HostFeedAutomationDescriptor): boolean {
    return this.authorizedResources.get(descriptor.resourceId) === descriptorKey(descriptor);
  }

  revoke(resourceId: string): boolean {
    return this.authorizedResources.delete(resourceId);
  }

  /**
   * Revoke consent synchronously when a Store update deletes or changes a feed.
   * This never grants consent, so imported/recovered/Agent-authored state stays
   * inert even when it is structurally canonical.
   */
  reconcile(descriptors: Iterable<HostFeedAutomationDescriptor>): boolean {
    const current = new Map<string, string>();
    for (const descriptor of descriptors) {
      current.set(descriptor.resourceId, descriptorKey(descriptor));
    }
    let changed = false;
    for (const [resourceId, authorizedKey] of this.authorizedResources) {
      if (current.get(resourceId) === authorizedKey) continue;
      this.authorizedResources.delete(resourceId);
      changed = true;
    }
    return changed;
  }
}

export function hostFeedAutomationPaused(
  descriptor: HostFeedAutomationDescriptor,
  ledger: HostFeedAutomationConsentLedger,
): boolean {
  return descriptor.policy.mode !== "manual" && !ledger.isAuthorized(descriptor);
}

export function hostFeedRefreshAllowed(
  reason: "manual" | "interval" | "on_open",
  descriptor: HostFeedAutomationDescriptor,
  ledger: HostFeedAutomationConsentLedger,
): boolean {
  return reason === "manual" || ledger.isAuthorized(descriptor);
}
