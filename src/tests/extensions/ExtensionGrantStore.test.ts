import { describe, expect, it } from "vitest";
import { ExtensionGrantStore } from "../../../server/extensions";
import {
  EXAMPLE_EXTENSION_MANIFEST_V1,
  extensionManifestSha256V1,
  parseExtensionManifestV1,
} from "../../extensions";

function scopedManifest() {
  return parseExtensionManifestV1({
    ...EXAMPLE_EXTENSION_MANIFEST_V1,
    requestedPermissions: [
      ...EXAMPLE_EXTENSION_MANIFEST_V1.requestedPermissions,
      { permission: "network:brokered", origins: ["https://api.example.com"] },
      { permission: "secret:use", secretIds: ["example.api_key"] },
    ],
  });
}

describe("ExtensionGrantStore", () => {
  it("issues a one-time-visible bearer capability bound to package, workspace, provider, and scopes", async () => {
    let now = 10_000;
    let byte = 1;
    const store = new ExtensionGrantStore({
      now: () => now,
      randomBytes: (size) => new Uint8Array(size).fill(byte++),
    });
    const manifest = scopedManifest();
    const issued = await store.issue({
      manifest,
      workspaceId: "workspace-1",
      providerIds: ["noop.connector"],
      permissions: ["connector:execute", "network:brokered", "secret:use"],
      networkOrigins: ["https://api.example.com"],
      secretIds: ["example.api_key"],
      ttlMs: 2_000,
    });
    expect(JSON.stringify(issued.grant)).not.toContain(issued.token);
    const base = {
      extensionId: manifest.id,
      extensionVersion: manifest.version,
      manifestSha256: await extensionManifestSha256V1(manifest),
      workspaceId: "workspace-1",
      providerId: "noop.connector",
    } as const;
    expect(store.authorize(issued.token, { ...base, permission: "connector:execute" }))
      .toEqual(issued.grant);
    expect(store.authorize(issued.token, {
      ...base,
      permission: "network:brokered",
      networkOrigin: "https://api.example.com",
    })).toEqual(issued.grant);
    expect(() => store.authorize(issued.token, {
      ...base,
      permission: "network:brokered",
      networkOrigin: "https://evil.example",
    })).toThrow(expect.objectContaining({ code: "scope_denied" }));
    expect(() => store.authorize(issued.token, {
      ...base,
      workspaceId: "workspace-2",
      permission: "connector:execute",
    })).toThrow(expect.objectContaining({ code: "grant_binding_mismatch" }));

    now = 12_000;
    expect(() => store.authorize(issued.token, { ...base, permission: "connector:execute" }))
      .toThrow(expect.objectContaining({ code: "grant_expired" }));
    expect(store.size).toBe(0);
  });

  it("never elevates beyond manifest-declared permissions or providers", async () => {
    const store = new ExtensionGrantStore();
    await expect(store.issue({
      manifest: EXAMPLE_EXTENSION_MANIFEST_V1,
      workspaceId: "workspace-1",
      providerIds: ["undeclared.provider"],
      permissions: ["connector:execute"],
    })).rejects.toMatchObject({ code: "scope_denied" });
    await expect(store.issue({
      manifest: EXAMPLE_EXTENSION_MANIFEST_V1,
      workspaceId: "workspace-1",
      providerIds: ["noop.connector"],
      permissions: ["bridge:push"],
    })).rejects.toMatchObject({ code: "permission_denied" });
  });
});
