import { describe, expect, it, vi } from "vitest";
import {
  canonicalExtensionManifestV1,
  canonicalizeExtensionJson,
  assertExtensionHostCompatibilityV1,
  boundedExtensionJsonByteLength,
  EXAMPLE_EXTENSION_MANIFEST_V1,
  extensionManifestSha256V1,
  parseExtensionManifestV1,
  sha256ExtensionBytes,
  verifyExtensionPackageV1,
} from "../../extensions";

describe("ExtensionManifestV1", () => {
  it("strictly parses the SDK example and rejects unknown fields or package path traversal", () => {
    expect(parseExtensionManifestV1(EXAMPLE_EXTENSION_MANIFEST_V1)).toEqual(EXAMPLE_EXTENSION_MANIFEST_V1);

    expect(() => parseExtensionManifestV1({ ...EXAMPLE_EXTENSION_MANIFEST_V1, surprise: true }))
      .toThrow(expect.objectContaining({ code: "invalid_manifest" }));

    expect(() => parseExtensionManifestV1({
      ...EXAMPLE_EXTENSION_MANIFEST_V1,
      entrypoint: { kind: "native_stdio", path: "../escape.mjs", args: [], protocolVersion: 1 },
      requestedPermissions: [
        ...EXAMPLE_EXTENSION_MANIFEST_V1.requestedPermissions,
        { permission: "native:stdio" },
      ],
    })).toThrow(expect.objectContaining({ code: "invalid_manifest" }));

    expect(() => parseExtensionManifestV1({
      ...EXAMPLE_EXTENSION_MANIFEST_V1,
      compatibility: { minimumHostVersion: "9.0.0", maximumHostVersion: "1.0.0" },
    })).toThrow(/Maximum host version/u);
  });

  it("enforces semantic host compatibility including prerelease precedence", () => {
    const manifest = parseExtensionManifestV1({
      ...EXAMPLE_EXTENSION_MANIFEST_V1,
      compatibility: { minimumHostVersion: "0.4.0-rc.1", maximumHostVersion: "0.4.0" },
    });
    expect(() => assertExtensionHostCompatibilityV1(manifest, "0.4.0-rc.2")).not.toThrow();
    expect(() => assertExtensionHostCompatibilityV1(manifest, "0.4.0-rc.0"))
      .toThrow(expect.objectContaining({ code: "incompatible_host_version" }));
    expect(() => assertExtensionHostCompatibilityV1(manifest, "0.4.1"))
      .toThrow(expect.objectContaining({ code: "incompatible_host_version" }));
  });

  it("requires a canonical, exact, non-colliding native package-root manifest", () => {
    const digest = `sha256:${"a".repeat(64)}`;
    const native = {
      ...EXAMPLE_EXTENSION_MANIFEST_V1,
      entrypoint: {
        kind: "native_stdio",
        path: "main.mjs",
        byteLength: 1,
        sha256: digest,
        args: [],
        protocolVersion: 1,
      },
      requestedPermissions: [
        ...EXAMPLE_EXTENSION_MANIFEST_V1.requestedPermissions,
        { permission: "native:stdio" },
      ],
      package: {
        ...EXAMPLE_EXTENSION_MANIFEST_V1.package,
        rootFiles: [
          { path: "main.mjs", byteLength: 1, sha256: digest },
          { path: "support.mjs", byteLength: 1, sha256: digest },
        ],
      },
    };
    expect(() => parseExtensionManifestV1(native)).not.toThrow();
    expect(() => parseExtensionManifestV1({
      ...native,
      package: { ...native.package, rootFiles: [...native.package.rootFiles].reverse() },
    })).toThrow(/strictly sorted/u);
    expect(() => parseExtensionManifestV1({
      ...native,
      package: {
        ...native.package,
        rootFiles: [
          { path: "Main.mjs", byteLength: 1, sha256: digest },
          { path: "main.mjs", byteLength: 1, sha256: digest },
          { path: "support.mjs", byteLength: 1, sha256: digest },
        ],
      },
    })).toThrow(/letter case/u);
    expect(() => parseExtensionManifestV1({
      ...native,
      entrypoint: { ...native.entrypoint, path: "lib//main.mjs" },
      package: {
        ...native.package,
        rootFiles: [{ path: "lib//main.mjs", byteLength: 1, sha256: digest }],
      },
    })).toThrow(/canonical safe/u);
  });

  it("uses deterministic canonical JSON and excludes only the signature from manifest identity", async () => {
    const canonicalValue = { z: [3, { b: 2, a: 1 }, "é\n😀"], a: -0 };
    expect(canonicalizeExtensionJson(canonicalValue))
      .toBe('{"a":0,"z":[3,{"a":1,"b":2},"é\\n😀"]}');
    expect(boundedExtensionJsonByteLength(canonicalValue, { maxBytes: 1_024 }))
      .toBe(new TextEncoder().encode(canonicalizeExtensionJson(canonicalValue)).byteLength);
    expect(() => boundedExtensionJsonByteLength("x".repeat(1_024), { maxBytes: 64 }))
      .toThrow(expect.objectContaining({ code: "json_too_large" }));

    expect(canonicalizeExtensionJson({ z: [3, { b: 2, a: 1 }], a: -0 }))
      .toBe('{"a":0,"z":[3,{"a":1,"b":2}]}');

    const unsignedDigest = await extensionManifestSha256V1(EXAMPLE_EXTENSION_MANIFEST_V1);
    const signed = parseExtensionManifestV1({
      ...EXAMPLE_EXTENSION_MANIFEST_V1,
      signature: { algorithm: "ed25519", keyId: "example.key", signatureBase64: "YWJjZA==" },
    });
    expect(await extensionManifestSha256V1(signed)).toBe(unsignedDigest);
    expect(canonicalExtensionManifestV1(signed)).not.toContain("signatureBase64");

    const changed = parseExtensionManifestV1({
      ...EXAMPLE_EXTENSION_MANIFEST_V1,
      displayName: "Changed identity",
    });
    expect(await extensionManifestSha256V1(changed)).not.toBe(unsignedDigest);
  });

  it("verifies package bytes and exposes a replaceable signature verifier seam", async () => {
    const packageBytes = new TextEncoder().encode("extension package");
    const packageSha256 = await sha256ExtensionBytes(packageBytes);
    const manifest = parseExtensionManifestV1({
      ...EXAMPLE_EXTENSION_MANIFEST_V1,
      package: { byteLength: packageBytes.byteLength, sha256: packageSha256, rootFiles: [] },
      signature: { algorithm: "ed25519", keyId: "example.key", signatureBase64: "YWJjZA==" },
    });
    const verify = vi.fn(async ({ message }: { message: Uint8Array }) => (
      new TextDecoder().decode(message).startsWith("SemaFrame Extension Manifest v1\0")
    ));

    await expect(verifyExtensionPackageV1({
      manifest,
      packageBytes,
      signatureVerifier: { verify },
      requireSignature: true,
    })).resolves.toMatchObject({ packageSha256, signature: "verified" });
    expect(verify).toHaveBeenCalledOnce();

    await expect(verifyExtensionPackageV1({
      manifest,
      packageBytes: Uint8Array.from(packageBytes, (byte, index) => index === 0 ? byte ^ 1 : byte),
    })).rejects.toMatchObject({ code: "package_digest_mismatch" });
    await expect(verifyExtensionPackageV1({ manifest, packageBytes, requireSignature: true }))
      .rejects.toMatchObject({ code: "signature_verifier_required" });
  });
});
