import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { access, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  NativeStdioExtensionHost,
  NativeStdioExtensionHostError,
} from "../../../server/extensions";
import {
  parseExtensionManifestV1,
  verifyExtensionPackageV1,
  type ExtensionPackageVerificationV1,
} from "../../extensions";

const repositoryRoot = resolve(".");
const fixturePath = resolve(repositoryRoot, "scripts/extension-fixture-host.mjs");
const supportPath = resolve(repositoryRoot, "scripts/extension-fixture-support.mjs");
const fixtureBytes = readFileSync(fixturePath);
const supportBytes = readFileSync(supportPath);
const fixtureSha256 = `sha256:${createHash("sha256").update(fixtureBytes).digest("hex")}` as const;
const supportSha256 = `sha256:${createHash("sha256").update(supportBytes).digest("hex")}` as const;
let packageRoot = "";

async function createFixturePackageRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "semaframe-extension-source-"));
  await writeFile(join(root, "extension-fixture-host.mjs"), fixtureBytes);
  await writeFile(join(root, "extension-fixture-support.mjs"), supportBytes);
  return root;
}

beforeAll(async () => {
  packageRoot = await createFixturePackageRoot();
});

afterAll(async () => {
  await rm(packageRoot, { recursive: true, force: true });
});

function nativeManifest() {
  return parseExtensionManifestV1({
    schemaVersion: "1.0",
    apiVersion: "1.0",
    id: "semaframe.fixture",
    version: "1.0.0",
    displayName: "Native fixture",
    publisher: { id: "semaframe", displayName: "SemaFrame" },
    compatibility: { minimumHostVersion: "0.4.0" },
    entrypoint: {
      kind: "native_stdio",
      path: "extension-fixture-host.mjs",
      byteLength: fixtureBytes.byteLength,
      sha256: fixtureSha256,
      args: [],
      protocolVersion: 1,
    },
    providers: [{
      kind: "connector",
      id: "fixture.connector",
      displayName: "Fixture connector",
      configurationSchema: { type: "object" },
      outputSchema: { type: "object" },
      supportsCursor: false,
    }],
    requestedPermissions: [
      { permission: "native:stdio" },
      { permission: "connector:execute" },
    ],
    package: {
      byteLength: 0,
      sha256: "sha256:e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
      rootFiles: [
        { path: "extension-fixture-host.mjs", byteLength: fixtureBytes.byteLength, sha256: fixtureSha256 },
        { path: "extension-fixture-support.mjs", byteLength: supportBytes.byteLength, sha256: supportSha256 },
      ],
    },
  });
}

function pullBridgeManifest() {
  return parseExtensionManifestV1({
    ...nativeManifest(),
    id: "semaframe.bridge-fixture",
    providers: [{
      kind: "bridge",
      id: "fixture.bridge",
      displayName: "Fixture bridge",
      target: "custom",
      directions: ["pull"],
      documentSchemaIds: ["semaframe.test"],
    }],
    requestedPermissions: [
      { permission: "native:stdio" },
      { permission: "bridge:pull" },
    ],
  });
}

async function launch(overrides: Partial<Parameters<typeof NativeStdioExtensionHost.launch>[0]> = {}) {
  const manifest = overrides.manifest ?? nativeManifest();
  const packageVerification = overrides.packageVerification ?? await verifyExtensionPackageV1({
    manifest,
    packageBytes: new Uint8Array(),
  });
  return NativeStdioExtensionHost.launch({
    manifest,
    packageVerification,
    packageRoot,
    hostVersion: "0.4.0",
    command: process.execPath,
    requestTimeoutMs: 2_000,
    authorize: () => undefined,
    ...overrides,
  });
}

describe("NativeStdioExtensionHost", () => {
  it("handshakes against the verified manifest and invokes a provider over bounded stdio", async () => {
    const authorize = vi.fn();
    const host = await launch({
      authorize,
      environment: { SEMAFRAME_EXTENSION_FIXTURE: "enabled" },
    });
    await expect(host.invoke(
      "fixture.connector",
      "read",
      { fixtureAction: "echo", payload: { value: 42 } },
      { permission: "connector:execute" },
    )).resolves.toEqual({ value: 42 });
    expect(authorize).toHaveBeenCalledWith(expect.objectContaining({
      extensionId: "semaframe.fixture",
      providerId: "fixture.connector",
      permission: "connector:execute",
    }));
    const environment = await host.invoke(
      "fixture.connector",
      "read",
      { fixtureAction: "environment" },
      { permission: "connector:execute" },
    );
    expect(environment).toMatchObject({
      hasHome: false,
      hasPath: false,
      protocol: "1",
      custom: "enabled",
      support: "verified-support",
      cwd: expect.stringContaining("semaframe-extension-"),
    });
    expect((environment as { cwd: string }).cwd).not.toBe(packageRoot);
    await expect(host.invoke(
      "fixture.connector",
      "read",
      { fixtureAction: "echo", payload: {} },
      { permission: "native:stdio" },
    )).rejects.toMatchObject({ code: "permission_denied" });
    await host.close();
    expect(host.closed).toBe(true);
  });

  it("supports schema-bounded extension-to-host calls on the same capability channel", async () => {
    const handleHostCall = vi.fn(async (method, params) => ({ method, params }));
    const host = await launch({ handleHostCall });
    await expect(host.invoke(
      "fixture.connector",
      "read",
      { fixtureAction: "host_call", payload: { ping: "pong" } },
      { permission: "connector:execute" },
    )).resolves.toEqual({ hostResult: { method: "fixture.reflect", params: { ping: "pong" } } });
    expect(handleHostCall).toHaveBeenCalledOnce();
    await host.close();
  });

  it("hard-stops the owned process on timeout or AbortSignal cancellation", async () => {
    const timeoutHost = await launch({ requestTimeoutMs: 100 });
    await expect(timeoutHost.invoke(
      "fixture.connector",
      "read",
      { fixtureAction: "hang" },
      { permission: "connector:execute" },
    )).rejects.toMatchObject({ code: "request_timeout" });
    expect(timeoutHost.closed).toBe(true);

    const abortHost = await launch();
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 25);
    await expect(abortHost.invoke(
      "fixture.connector",
      "read",
      { fixtureAction: "hang" },
      { permission: "connector:execute", signal: controller.signal },
    )).rejects.toMatchObject({ code: "request_aborted" });
    expect(abortHost.closed).toBe(true);
  });

  it("fails closed on oversized or malformed output and rejects cwd escape", async () => {
    const oversizedHost = await launch({ maxFrameBytes: 4_096 });
    await expect(oversizedHost.invoke(
      "fixture.connector",
      "read",
      { fixtureAction: "oversize" },
      { permission: "connector:execute" },
    )).rejects.toMatchObject({ code: "protocol_error" });
    expect(oversizedHost.closed).toBe(true);

    const malformedHost = await launch();
    await expect(malformedHost.invoke(
      "fixture.connector",
      "read",
      { fixtureAction: "malformed" },
      { permission: "connector:execute" },
    )).rejects.toMatchObject({ code: "protocol_error" });

    await expect(launch({ cwd: "/tmp" })).rejects.toBeInstanceOf(NativeStdioExtensionHostError);
    await expect(launch({ authorize: () => { throw new Error("denied"); } }))
      .rejects.toMatchObject({ code: "permission_denied" });
  });

  it("requires SDK-produced package evidence and a manifest-pinned package tree", async () => {
    await expect(launch({
      packageVerification: {
        manifestSha256: `sha256:${"0".repeat(64)}`,
        packageSha256: `sha256:${"0".repeat(64)}`,
        signature: "verified",
      } as ExtensionPackageVerificationV1,
    })).rejects.toMatchObject({ code: "package_verification_failed" });

    const manifest = parseExtensionManifestV1({
      ...nativeManifest(),
      entrypoint: { ...nativeManifest().entrypoint, sha256: `sha256:${"0".repeat(64)}` },
      package: {
        ...nativeManifest().package,
        rootFiles: nativeManifest().package.rootFiles.map((file) =>
          file.path === "extension-fixture-host.mjs" ? { ...file, sha256: `sha256:${"0".repeat(64)}` } : file),
      },
    });
    await expect(launch({ manifest })).rejects.toMatchObject({ code: "package_root_verification_failed" });
  });

  it("rejects changed support files, unlisted extras, and symbolic links", async () => {
    const changedSupportRoot = await createFixturePackageRoot();
    await writeFile(join(changedSupportRoot, "extension-fixture-support.mjs"), "export const fixtureSupportValue = 'tampered';\n");
    await expect(launch({ packageRoot: changedSupportRoot }))
      .rejects.toMatchObject({ code: "package_root_verification_failed" });
    await rm(changedSupportRoot, { recursive: true, force: true });

    const extraRoot = await createFixturePackageRoot();
    await writeFile(join(extraRoot, "unlisted.mjs"), "export {};\n");
    await expect(launch({ packageRoot: extraRoot }))
      .rejects.toMatchObject({ code: "package_root_verification_failed" });
    await rm(extraRoot, { recursive: true, force: true });

    const symlinkRoot = await createFixturePackageRoot();
    await symlink("extension-fixture-support.mjs", join(symlinkRoot, "alias.mjs"));
    await expect(launch({ packageRoot: symlinkRoot }))
      .rejects.toMatchObject({ code: "package_root_verification_failed" });
    await rm(symlinkRoot, { recursive: true, force: true });
  });

  it("executes a private verified snapshot when the caller mutates the source after verification", async () => {
    const mutableRoot = await createFixturePackageRoot();
    const authorize = vi.fn(async (request: { permission: string }) => {
      if (request.permission === "native:stdio") {
        await writeFile(
          join(mutableRoot, "extension-fixture-support.mjs"),
          "export const fixtureSupportValue = 'swapped-after-verification';\n",
        );
        await writeFile(join(mutableRoot, "added-after-verification.mjs"), "export const late = true;\n");
      }
    });
    const host = await launch({ packageRoot: mutableRoot, authorize });
    const environment = await host.invoke(
      "fixture.connector",
      "read",
      { fixtureAction: "environment" },
      { permission: "connector:execute" },
    ) as { support: string; cwd: string };
    expect(environment.support).toBe("verified-support");
    expect(environment.cwd).not.toBe(mutableRoot);
    const snapshotRoot = environment.cwd;
    await host.close();
    await expect(access(snapshotRoot)).rejects.toThrow();
    await rm(mutableRoot, { recursive: true, force: true });
  });

  it("enforces host compatibility and exact provider method permissions", async () => {
    await expect(launch({ hostVersion: "0.3.9" })).rejects.toMatchObject({ code: "incompatible_host" });

    const connector = await launch();
    await expect(connector.invoke(
      "fixture.connector",
      "arbitrary",
      {},
      { permission: "connector:execute" },
    )).rejects.toMatchObject({ code: "invalid_configuration" });
    await connector.close();

    const authorize = vi.fn();
    const bridge = await launch({ manifest: pullBridgeManifest(), authorize });
    await expect(bridge.invoke(
      "fixture.bridge",
      "probe",
      {},
      { permission: "bridge:pull" },
    )).resolves.toEqual({ available: true });
    expect(authorize).toHaveBeenCalledWith(expect.objectContaining({ permission: "bridge:pull" }));
    await expect(bridge.invoke(
      "fixture.bridge",
      "push",
      {},
      { permission: "bridge:pull" },
    )).rejects.toMatchObject({ code: "permission_denied" });
    await bridge.close();
  });
});
