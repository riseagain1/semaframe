import { describe, expect, it, vi } from "vitest";
import type { ExtensionJsonValue } from "../../extensions";
import type { WorkspaceConnectorCapability } from "../../workspace/data/connectorCatalog";
import {
  ConnectorRegistryError,
  ConnectorRegistryV1,
  connectorRegistrationDescriptorSha256V1,
  type ConnectorRegistrationDescriptorV1,
  type ConnectorRegistrationV1,
} from "../../workspace/data/ConnectorRegistry";

const MANIFEST_DIGEST = `sha256:${"a".repeat(64)}` as const;

async function extensionRegistration(
  overrides: Partial<ConnectorRegistrationDescriptorV1> = {},
): Promise<ConnectorRegistrationV1> {
  const capability: WorkspaceConnectorCapability = {
    connectorType: "weather.live",
    connectorVersion: "2.1.0",
    displayName: "Weather live",
    execution: "host",
    snapshotAuthority: "host_normalized",
    agentWritePolicy: "host_approval_required",
    networkAccess: true,
    configSchema: { type: "object", additionalProperties: false },
    notes: ["Host broker only."],
  };
  const descriptor: ConnectorRegistrationDescriptorV1 = {
    schemaVersion: "1.0",
    providerId: "weather.connector",
    connectorType: capability.connectorType,
    connectorVersion: capability.connectorVersion,
    capability,
    origin: {
      kind: "extension",
      extensionId: "example.weather",
      extensionVersion: "1.2.0",
      manifestSha256: MANIFEST_DIGEST,
    },
    ...overrides,
  };
  return {
    ...descriptor,
    descriptorSha256: await connectorRegistrationDescriptorSha256V1(descriptor),
  };
}

describe("ConnectorRegistryV1", () => {
  it("pins first-party inline and HTTP descriptors into an immutable per-workspace registry", async () => {
    const left = await ConnectorRegistryV1.create({ workspaceId: "workspace-1" });
    const right = await ConnectorRegistryV1.create({ workspaceId: "workspace-1" });
    expect(left.registrySha256).toBe(right.registrySha256);
    expect(left.list().map((entry) => `${entry.connectorType}@${entry.connectorVersion}`)).toEqual([
      "http.feed@1.0.0",
      "inline.snapshot@1.0.0",
    ]);
    expect(Object.isFrozen(left)).toBe(true);
    expect(Object.isFrozen(left.list())).toBe(true);
    expect(Object.isFrozen(left.list()[0]?.capability)).toBe(true);
  });

  it("rejects descriptor tampering, invalid versions, and provider or connector collisions", async () => {
    const valid = await extensionRegistration();
    await expect(ConnectorRegistryV1.create({
      workspaceId: "workspace-1",
      extensions: [{ ...valid, descriptorSha256: `sha256:${"b".repeat(64)}` }],
    })).rejects.toMatchObject({ code: "digest_mismatch" });

    const invalidVersion = {
      ...valid,
      connectorVersion: "latest",
      capability: { ...valid.capability, connectorVersion: "latest" },
    } as ConnectorRegistrationV1;
    await expect(ConnectorRegistryV1.create({
      workspaceId: "workspace-1",
      extensions: [invalidVersion],
    })).rejects.toMatchObject({ code: "invalid_registration" });

    const collision = await extensionRegistration({ providerId: "weather.other" });
    await expect(ConnectorRegistryV1.create({
      workspaceId: "workspace-1",
      extensions: [valid, collision],
    })).rejects.toMatchObject({ code: "registration_collision" });
  });

  it("preserves resources with missing extensions as read-only degraded snapshots", async () => {
    const registry = await ConnectorRegistryV1.create({ workspaceId: "workspace-1" });
    const resolution = registry.resolveResource({
      connectorType: "weather.live",
      connectorVersion: "2.1.0",
      snapshot: {
        data: [{ temperature: 21 }],
        contentHash: "fnv1a32:test",
        retrievedAt: "2026-08-27T00:00:00.000Z",
        stale: true,
        provenance: [],
      },
    });
    expect(resolution).toMatchObject({
      state: "missing_provider",
      mode: "read_only",
      existingSnapshotReadable: true,
    });
    expect(Object.isFrozen(resolution)).toBe(true);
  });

  it("executes extension connectors only after host grant authorization and normalizes immutable output", async () => {
    const registration = await extensionRegistration();
    const registry = await ConnectorRegistryV1.create({
      workspaceId: "workspace-1",
      extensions: [registration],
    });
    const events: string[] = [];
    const authorizeExtension = vi.fn(async (request) => {
      events.push("authorize");
      expect(request).toMatchObject({
        grantToken: "grant-token-capability",
        workspaceId: "workspace-1",
        extensionId: "example.weather",
        providerId: "weather.connector",
        permission: "connector:execute",
      });
    });
    const providerItems: ExtensionJsonValue[] = [{ temperature: 21 }];
    const invokeConnector = vi.fn(async ({ read }) => {
      events.push("invoke");
      expect(read.configuration).toEqual({ city: "Shanghai" });
      expect(Object.isFrozen(read.configuration)).toBe(true);
      return {
        items: providerItems,
        nextCursor: "page-2",
        observedAt: "2026-08-27T00:00:00.000Z",
        source: {
          sourceId: "weather.example",
          sourceUrl: "https://weather.example/current",
          license: "CC-BY-4.0",
        },
      };
    });
    const result = await registry.execute({
      workspaceId: "workspace-1",
      connectorType: "weather.live",
      connectorVersion: "2.1.0",
      configuration: { city: "Shanghai" },
      grantToken: "grant-token-capability",
    }, { authorizeExtension, invokeConnector });
    providerItems[0] = { temperature: 99 };

    expect(events).toEqual(["authorize", "invoke"]);
    expect(result.snapshot.data).toEqual([{ temperature: 21 }]);
    expect(result.snapshot.contentHash).toMatch(/^fnv1a32:/u);
    expect(result.snapshot.provenance[0]).toMatchObject({
      publisher: "weather.example",
      uri: "https://weather.example/current",
      citation: "License: CC-BY-4.0",
    });
    expect(result.nextCursor).toBe("page-2");
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.snapshot)).toBe(true);
    expect(Object.isFrozen(result.snapshot.data)).toBe(true);
  });

  it("fails closed without a grant and rejects raw credential material before host invocation", async () => {
    const registry = await ConnectorRegistryV1.create({
      workspaceId: "workspace-1",
      extensions: [await extensionRegistration()],
    });
    const invokeConnector = vi.fn();
    await expect(registry.execute({
      workspaceId: "workspace-1",
      connectorType: "weather.live",
      connectorVersion: "2.1.0",
      configuration: {},
    }, { invokeConnector })).rejects.toMatchObject({ code: "permission_required" });
    await expect(registry.execute({
      workspaceId: "workspace-1",
      connectorType: "weather.live",
      connectorVersion: "2.1.0",
      configuration: { apiKey: "sk-example-credential-material" },
      grantToken: "grant-token-capability",
    }, {
      authorizeExtension: vi.fn(),
      invokeConnector,
    })).rejects.toBeInstanceOf(ConnectorRegistryError);
    expect(invokeConnector).not.toHaveBeenCalled();
  });

  it("rejects provider item data above the host-owned canonical byte budget", async () => {
    const registry = await ConnectorRegistryV1.create({
      workspaceId: "workspace-1",
      extensions: [await extensionRegistration()],
      maxResultBytes: 64,
    });
    await expect(registry.execute({
      workspaceId: "workspace-1",
      connectorType: "weather.live",
      connectorVersion: "2.1.0",
      configuration: {},
      grantToken: "grant-token-capability",
    }, {
      authorizeExtension: vi.fn(),
      invokeConnector: vi.fn(async () => ({
        items: [{ payload: "x".repeat(128) }],
        observedAt: "2026-08-27T00:00:00.000Z",
        source: { sourceId: "weather.example" },
      })),
    })).rejects.toMatchObject({ code: "invalid_provider_result" });
  });
});
