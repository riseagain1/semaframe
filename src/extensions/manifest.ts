import { z } from "zod";
import {
  canonicalizeExtensionJson,
  sha256ExtensionBytes,
  type ExtensionJsonValue,
} from "./canonicalJson";
import {
  EXTENSION_API_VERSION,
  EXTENSION_PERMISSION_IDS,
  type ExtensionPermissionIdV1,
  type ExtensionProviderKindV1,
} from "./contracts";

export const EXTENSION_MANIFEST_SCHEMA_VERSION = "1.0" as const;

const IDENTIFIER_PATTERN = /^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/u;
const SEMVER_PATTERN = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/u;
const SEMVER_PARTS_PATTERN = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/u;
const SHA256_PATTERN = /^sha256:[0-9a-f]{64}$/u;
const SAFE_PACKAGE_PATH_PATTERN = /^(?!\/)(?!.*\\)[\x21-\x7e]{1,512}$/u;
const MEDIA_TYPE_PATTERN = /^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+(?:;[\x20-\x7e]+)?$/iu;
const BASE64_PATTERN = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u;

const identifierSchema = z.string().min(1).max(128).regex(IDENTIFIER_PATTERN);
const semverSchema = z.string().min(5).max(128).regex(SEMVER_PATTERN);
const sha256Schema = z.string().regex(SHA256_PATTERN);
export function isSafeExtensionPackagePathV1(value: unknown): value is string {
  if (typeof value !== "string" || !SAFE_PACKAGE_PATH_PATTERN.test(value)) return false;
  const segments = value.split("/");
  if (segments.some((segment) => segment.length < 1
    || segment.length > 128
    || segment === "."
    || segment === ".."
    || /[<>:"|?*]/u.test(segment)
    || /[. ]$/u.test(segment)
    || /^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.|$)/iu.test(segment))) return false;
  return segments.join("/") === value;
}
const safePackagePathSchema = z.string().refine(isSafeExtensionPackagePathV1, "Must be a canonical safe package-relative path.");
const packageRootFileSchema = z.strictObject({
  path: safePackagePathSchema,
  byteLength: z.number().int().min(0).max(2_147_483_647),
  sha256: sha256Schema,
});
const jsonValueSchema: z.ZodType<ExtensionJsonValue> = z.lazy(() => z.union([
  z.string(),
  z.number().finite(),
  z.boolean(),
  z.null(),
  z.array(jsonValueSchema).max(10_000),
  z.record(z.string(), jsonValueSchema),
]));
const jsonObjectSchema = z.record(z.string(), jsonValueSchema);

const formatSchema = z.strictObject({
  id: identifierSchema,
  mediaType: z.string().min(3).max(256).regex(MEDIA_TYPE_PATTERN),
  extensions: z.array(z.string().min(1).max(16).regex(/^[a-z0-9]+$/u)).min(1).max(16),
});

const connectorDescriptorSchema = z.strictObject({
  kind: z.literal("connector"),
  id: identifierSchema,
  displayName: z.string().min(1).max(128),
  configurationSchema: jsonObjectSchema,
  outputSchema: jsonObjectSchema,
  supportsCursor: z.boolean().default(false),
});

const importerDescriptorSchema = z.strictObject({
  kind: z.literal("importer"),
  id: identifierSchema,
  displayName: z.string().min(1).max(128),
  formats: z.array(formatSchema).min(1).max(32),
  outputSchemaId: z.string().min(1).max(256),
});

const exporterDescriptorSchema = z.strictObject({
  kind: z.literal("exporter"),
  id: identifierSchema,
  displayName: z.string().min(1).max(128),
  formats: z.array(formatSchema).min(1).max(32),
  inputSchemaIds: z.array(z.string().min(1).max(256)).min(1).max(32),
});

const bridgeDescriptorSchema = z.strictObject({
  kind: z.literal("bridge"),
  id: identifierSchema,
  displayName: z.string().min(1).max(128),
  target: z.enum(["blender", "cad", "unity", "unreal", "custom"]),
  directions: z.array(z.enum(["pull", "push"])).min(1).max(2),
  documentSchemaIds: z.array(z.string().min(1).max(256)).min(1).max(32),
});

export const extensionProviderDescriptorV1Schema = z.discriminatedUnion("kind", [
  connectorDescriptorSchema,
  importerDescriptorSchema,
  exporterDescriptorSchema,
  bridgeDescriptorSchema,
]);

const scopedPermissionIds = ["network:brokered", "secret:use"] as const;
const unscopedPermissionIds = EXTENSION_PERMISSION_IDS.filter(
  (permission) => !scopedPermissionIds.includes(permission as typeof scopedPermissionIds[number]),
) as Exclude<ExtensionPermissionIdV1, typeof scopedPermissionIds[number]>[];

const permissionRequestSchema = z.discriminatedUnion("permission", [
  z.strictObject({ permission: z.enum(unscopedPermissionIds) }),
  z.strictObject({
    permission: z.literal("network:brokered"),
    origins: z.array(z.url().max(2_048)).min(1).max(64),
  }),
  z.strictObject({
    permission: z.literal("secret:use"),
    secretIds: z.array(identifierSchema).min(1).max(64),
  }),
]);

export const extensionManifestV1Schema = z.strictObject({
  schemaVersion: z.literal(EXTENSION_MANIFEST_SCHEMA_VERSION),
  apiVersion: z.literal(EXTENSION_API_VERSION),
  id: identifierSchema,
  version: semverSchema,
  displayName: z.string().min(1).max(128),
  description: z.string().min(1).max(1_000).optional(),
  publisher: z.strictObject({
    id: identifierSchema,
    displayName: z.string().min(1).max(128),
  }),
  compatibility: z.strictObject({
    minimumHostVersion: semverSchema,
    maximumHostVersion: semverSchema.optional(),
  }),
  entrypoint: z.discriminatedUnion("kind", [
    z.strictObject({ kind: z.literal("none") }),
    z.strictObject({
      kind: z.literal("native_stdio"),
      path: safePackagePathSchema,
      byteLength: z.number().int().min(1).max(2_147_483_647),
      sha256: sha256Schema,
      args: z.array(z.string().max(512)).max(32).default([]),
      protocolVersion: z.literal(1),
    }),
  ]),
  providers: z.array(extensionProviderDescriptorV1Schema).min(1).max(32),
  requestedPermissions: z.array(permissionRequestSchema).max(32),
  package: z.strictObject({
    byteLength: z.number().int().min(0).max(2_147_483_647),
    sha256: sha256Schema,
    rootFiles: z.array(packageRootFileSchema).max(4_096),
  }),
  signature: z.strictObject({
    algorithm: z.literal("ed25519"),
    keyId: identifierSchema,
    signatureBase64: z.string().min(4).max(4_096).regex(BASE64_PATTERN),
  }).optional(),
}).superRefine((manifest, context) => {
  if (manifest.compatibility.maximumHostVersion
    && compareExtensionSemverV1(
      manifest.compatibility.maximumHostVersion,
      manifest.compatibility.minimumHostVersion,
    ) < 0) {
    context.addIssue({
      code: "custom",
      path: ["compatibility", "maximumHostVersion"],
      message: "Maximum host version cannot be lower than minimum host version.",
    });
  }
  const providerIds = new Set<string>();
  for (const [index, provider] of manifest.providers.entries()) {
    if (providerIds.has(provider.id)) {
      context.addIssue({
        code: "custom",
        path: ["providers", index, "id"],
        message: `Duplicate provider id ${provider.id}.`,
      });
    }
    providerIds.add(provider.id);
    if (provider.kind === "bridge" && new Set(provider.directions).size !== provider.directions.length) {
      context.addIssue({
        code: "custom",
        path: ["providers", index, "directions"],
        message: "Bridge directions must be unique.",
      });
    }
  }
  const permissions = new Set<ExtensionPermissionIdV1>();
  for (const [index, request] of manifest.requestedPermissions.entries()) {
    if (permissions.has(request.permission)) {
      context.addIssue({
        code: "custom",
        path: ["requestedPermissions", index, "permission"],
        message: `Duplicate permission ${request.permission}.`,
      });
    }
    permissions.add(request.permission);
    if (request.permission === "network:brokered") {
      const normalized = new Set<string>();
      for (const [originIndex, origin] of request.origins.entries()) {
        let url: URL;
        try {
          url = new URL(origin);
        } catch {
          continue;
        }
        if ((url.protocol !== "https:" && url.hostname !== "localhost" && url.hostname !== "127.0.0.1")
          || url.origin !== origin
          || normalized.has(url.origin)) {
          context.addIssue({
            code: "custom",
            path: ["requestedPermissions", index, "origins", originIndex],
            message: "Network scope must be a unique normalized HTTPS origin (HTTP is local-only).",
          });
        }
        normalized.add(url.origin);
      }
    }
    if (request.permission === "secret:use" && new Set(request.secretIds).size !== request.secretIds.length) {
      context.addIssue({
        code: "custom",
        path: ["requestedPermissions", index, "secretIds"],
        message: "Secret scopes must be unique.",
      });
    }
  }
  if (manifest.entrypoint.kind === "native_stdio" && !permissions.has("native:stdio")) {
    context.addIssue({
      code: "custom",
      path: ["requestedPermissions"],
      message: "A native_stdio entrypoint must request native:stdio.",
    });
  }
  let previousRootPath: string | undefined;
  let rootByteLength = 0;
  const rootPaths = new Set<string>();
  const foldedRootPaths = new Set<string>();
  const foldedTreeCasing = new Map<string, string>();
  for (const [index, file] of manifest.package.rootFiles.entries()) {
    rootByteLength += file.byteLength;
    if (rootPaths.has(file.path)) {
      context.addIssue({
        code: "custom",
        path: ["package", "rootFiles", index, "path"],
        message: `Duplicate package root path ${file.path}.`,
      });
    }
    rootPaths.add(file.path);
    const foldedFilePath = file.path.toLowerCase();
    if (foldedRootPaths.has(foldedFilePath)) {
      context.addIssue({
        code: "custom",
        path: ["package", "rootFiles", index, "path"],
        message: "Package root file paths must not collide by letter case.",
      });
    }
    foldedRootPaths.add(foldedFilePath);
    if (previousRootPath !== undefined && previousRootPath >= file.path) {
      context.addIssue({
        code: "custom",
        path: ["package", "rootFiles", index, "path"],
        message: "Package root files must be strictly sorted by path.",
      });
    }
    const pathSegments = file.path.split("/");
    const hasFileParent = pathSegments.slice(0, -1).some((_segment, parentIndex) =>
      foldedRootPaths.has(pathSegments.slice(0, parentIndex + 1).join("/").toLowerCase()));
    if (hasFileParent) {
      context.addIssue({
        code: "custom",
        path: ["package", "rootFiles", index, "path"],
        message: "A package root file cannot also be the parent of another file.",
      });
    }
    for (let length = 1; length <= pathSegments.length; length += 1) {
      const treePath = pathSegments.slice(0, length).join("/");
      const foldedTreePath = treePath.toLowerCase();
      const existingCasing = foldedTreeCasing.get(foldedTreePath);
      if (existingCasing !== undefined && existingCasing !== treePath) {
        context.addIssue({
          code: "custom",
          path: ["package", "rootFiles", index, "path"],
          message: "Package root path segments must use one consistent letter casing.",
        });
      }
      foldedTreeCasing.set(foldedTreePath, treePath);
    }
    previousRootPath = file.path;
  }
  if (rootByteLength > 2_147_483_647) {
    context.addIssue({
      code: "custom",
      path: ["package", "rootFiles"],
      message: "Package root file bytes cannot exceed 2147483647 in aggregate.",
    });
  }
  if (foldedTreeCasing.size > 8_192) {
    context.addIssue({
      code: "custom",
      path: ["package", "rootFiles"],
      message: "Package root tree cannot exceed 8192 files and directories.",
    });
  }
  if (manifest.entrypoint.kind === "native_stdio") {
    const nativeEntrypoint = manifest.entrypoint;
    const entrypointFile = manifest.package.rootFiles.find((file) => file.path === nativeEntrypoint.path);
    if (!entrypointFile) {
      context.addIssue({
        code: "custom",
        path: ["package", "rootFiles"],
        message: "Package root files must include the native stdio entrypoint.",
      });
    } else if (entrypointFile.byteLength !== nativeEntrypoint.byteLength
      || entrypointFile.sha256 !== nativeEntrypoint.sha256) {
      context.addIssue({
        code: "custom",
        path: ["entrypoint"],
        message: "Native entrypoint byte identity must match its package root file entry.",
      });
    }
  } else if (manifest.package.rootFiles.length > 0) {
    context.addIssue({
      code: "custom",
      path: ["package", "rootFiles"],
      message: "An in-process extension cannot declare a native package root tree.",
    });
  }
  const requiredPermissions = new Set<ExtensionPermissionIdV1>();
  for (const provider of manifest.providers) {
    if (provider.kind === "connector") requiredPermissions.add("connector:execute");
    if (provider.kind === "importer") requiredPermissions.add("importer:execute");
    if (provider.kind === "exporter") requiredPermissions.add("exporter:execute");
    if (provider.kind === "bridge" && provider.directions.includes("pull")) requiredPermissions.add("bridge:pull");
    if (provider.kind === "bridge" && provider.directions.includes("push")) requiredPermissions.add("bridge:push");
  }
  for (const permission of requiredPermissions) {
    if (!permissions.has(permission)) {
      context.addIssue({
        code: "custom",
        path: ["requestedPermissions"],
        message: `Provider declarations require ${permission}.`,
      });
    }
  }
});

export type ExtensionProviderDescriptorV1 = z.infer<typeof extensionProviderDescriptorV1Schema>;
export type ExtensionPermissionRequestV1 = z.infer<typeof permissionRequestSchema>;
export type ExtensionManifestV1 = z.infer<typeof extensionManifestV1Schema>;

export class ExtensionManifestError extends Error {
  constructor(
    readonly code:
      | "invalid_manifest"
      | "invalid_host_version"
      | "incompatible_host_version"
      | "package_size_mismatch"
      | "package_digest_mismatch"
      | "unverified_package_evidence"
      | "signature_required"
      | "signature_verifier_required"
      | "invalid_signature",
    message: string,
  ) {
    super(message);
    this.name = "ExtensionManifestError";
  }
}

type ParsedSemver = Readonly<{
  major: bigint;
  minor: bigint;
  patch: bigint;
  prerelease: readonly string[];
}>;

function parsedSemver(value: string): ParsedSemver | undefined {
  const match = SEMVER_PARTS_PATTERN.exec(value);
  if (!match) return undefined;
  return {
    major: BigInt(match[1]!),
    minor: BigInt(match[2]!),
    patch: BigInt(match[3]!),
    prerelease: Object.freeze(match[4]?.split(".") ?? []),
  };
}

/** SemVer precedence comparison. Build metadata intentionally has no effect. */
export function compareExtensionSemverV1(left: string, right: string): -1 | 0 | 1 {
  const a = parsedSemver(left);
  const b = parsedSemver(right);
  if (!a || !b) throw new TypeError("Extension versions must be valid semantic versions.");
  for (const field of ["major", "minor", "patch"] as const) {
    if (a[field] < b[field]) return -1;
    if (a[field] > b[field]) return 1;
  }
  if (a.prerelease.length === 0 && b.prerelease.length === 0) return 0;
  if (a.prerelease.length === 0) return 1;
  if (b.prerelease.length === 0) return -1;
  const length = Math.max(a.prerelease.length, b.prerelease.length);
  for (let index = 0; index < length; index += 1) {
    const leftIdentifier = a.prerelease[index];
    const rightIdentifier = b.prerelease[index];
    if (leftIdentifier === undefined) return -1;
    if (rightIdentifier === undefined) return 1;
    if (leftIdentifier === rightIdentifier) continue;
    const leftNumeric = /^\d+$/u.test(leftIdentifier);
    const rightNumeric = /^\d+$/u.test(rightIdentifier);
    if (leftNumeric && rightNumeric) {
      const leftNumber = BigInt(leftIdentifier);
      const rightNumber = BigInt(rightIdentifier);
      if (leftNumber === rightNumber) continue;
      return leftNumber < rightNumber ? -1 : 1;
    }
    if (leftNumeric !== rightNumeric) return leftNumeric ? -1 : 1;
    return leftIdentifier < rightIdentifier ? -1 : 1;
  }
  return 0;
}

export function assertExtensionHostCompatibilityV1(
  manifest: ExtensionManifestV1,
  hostVersion: string,
): void {
  const parsed = parseExtensionManifestV1(manifest);
  if (!parsedSemver(hostVersion)) {
    throw new ExtensionManifestError("invalid_host_version", "Extension host version must be semantic.");
  }
  if (compareExtensionSemverV1(hostVersion, parsed.compatibility.minimumHostVersion) < 0
    || (parsed.compatibility.maximumHostVersion
      && compareExtensionSemverV1(hostVersion, parsed.compatibility.maximumHostVersion) > 0)) {
    const range = parsed.compatibility.maximumHostVersion
      ? `${parsed.compatibility.minimumHostVersion} through ${parsed.compatibility.maximumHostVersion}`
      : `${parsed.compatibility.minimumHostVersion} or newer`;
    throw new ExtensionManifestError(
      "incompatible_host_version",
      `Extension ${parsed.id}@${parsed.version} requires host ${range}; current host is ${hostVersion}.`,
    );
  }
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const nested of Object.values(value)) deepFreeze(nested);
  }
  return value;
}

export function parseExtensionManifestV1(value: unknown): ExtensionManifestV1 {
  const result = extensionManifestV1Schema.safeParse(value);
  if (!result.success) {
    const issue = result.error.issues[0];
    throw new ExtensionManifestError(
      "invalid_manifest",
      `Invalid extension manifest at ${issue?.path.join(".") || "$"}: ${issue?.message ?? "invalid value"}`,
    );
  }
  return deepFreeze(structuredClone(result.data));
}

export function extensionManifestProvider(
  manifest: ExtensionManifestV1,
  providerId: string,
  kind?: ExtensionProviderKindV1,
): ExtensionProviderDescriptorV1 | undefined {
  return manifest.providers.find((provider) => provider.id === providerId && (kind === undefined || provider.kind === kind));
}

export function canonicalExtensionManifestV1(manifest: ExtensionManifestV1): string {
  const parsed = parseExtensionManifestV1(manifest);
  const { signature: _signature, ...unsignedManifest } = parsed;
  return canonicalizeExtensionJson(unsignedManifest);
}

export function extensionManifestSigningBytesV1(manifest: ExtensionManifestV1): Uint8Array {
  const domain = new TextEncoder().encode("SemaFrame Extension Manifest v1\0");
  const canonical = new TextEncoder().encode(canonicalExtensionManifestV1(manifest));
  const output = new Uint8Array(domain.byteLength + canonical.byteLength);
  output.set(domain, 0);
  output.set(canonical, domain.byteLength);
  return output;
}

export async function extensionManifestSha256V1(manifest: ExtensionManifestV1): Promise<`sha256:${string}`> {
  return sha256ExtensionBytes(extensionManifestSigningBytesV1(manifest));
}

export type ExtensionSignatureVerifierV1 = Readonly<{
  verify(input: Readonly<{
    algorithm: "ed25519";
    keyId: string;
    signatureBase64: string;
    message: Uint8Array;
  }>): Promise<boolean>;
}>;

export type ExtensionPackageVerificationV1 = Readonly<{
  manifestSha256: `sha256:${string}`;
  packageSha256: `sha256:${string}`;
  signature: "unsigned" | "unverified" | "verified";
}>;

const verifiedPackageEvidence = new WeakSet<object>();

function verifiedPackageResult(result: ExtensionPackageVerificationV1): ExtensionPackageVerificationV1 {
  const frozen = Object.freeze(result);
  verifiedPackageEvidence.add(frozen);
  return frozen;
}

function equalDigest(expected: string, actual: string): boolean {
  if (expected.length !== actual.length) return false;
  let difference = 0;
  for (let index = 0; index < expected.length; index += 1) {
    difference |= expected.charCodeAt(index) ^ actual.charCodeAt(index);
  }
  return difference === 0;
}

export async function verifyExtensionPackageV1(input: Readonly<{
  manifest: ExtensionManifestV1;
  packageBytes: Uint8Array;
  signatureVerifier?: ExtensionSignatureVerifierV1;
  requireSignature?: boolean;
}>): Promise<ExtensionPackageVerificationV1> {
  const manifest = parseExtensionManifestV1(input.manifest);
  if (!ArrayBuffer.isView(input.packageBytes) || input.packageBytes.BYTES_PER_ELEMENT !== 1) {
    throw new TypeError("Extension package bytes must be a Uint8Array.");
  }
  if (input.packageBytes.byteLength !== manifest.package.byteLength) {
    throw new ExtensionManifestError("package_size_mismatch", "Extension package byte length does not match its manifest.");
  }
  const packageSha256 = await sha256ExtensionBytes(input.packageBytes);
  if (!equalDigest(manifest.package.sha256, packageSha256)) {
    throw new ExtensionManifestError("package_digest_mismatch", "Extension package SHA-256 does not match its manifest.");
  }
  const manifestSha256 = await extensionManifestSha256V1(manifest);
  if (!manifest.signature) {
    if (input.requireSignature) {
      throw new ExtensionManifestError("signature_required", "This host requires a signed extension package.");
    }
    return verifiedPackageResult({ manifestSha256, packageSha256, signature: "unsigned" });
  }
  if (!input.signatureVerifier) {
    if (input.requireSignature) {
      throw new ExtensionManifestError("signature_verifier_required", "No verifier is available for the package signature.");
    }
    return verifiedPackageResult({ manifestSha256, packageSha256, signature: "unverified" });
  }
  const verified = await input.signatureVerifier.verify({
    ...manifest.signature,
    message: extensionManifestSigningBytesV1(manifest),
  });
  if (!verified) {
    throw new ExtensionManifestError("invalid_signature", "Extension package signature is invalid.");
  }
  return verifiedPackageResult({ manifestSha256, packageSha256, signature: "verified" });
}

/**
 * Verifies that package evidence was produced by this SDK instance from the
 * exact manifest/package bytes, rather than reconstructed from attacker-owned
 * strings. Native hosts consume this ephemeral proof before spawning code.
 */
export async function assertVerifiedExtensionPackageV1(
  manifest: ExtensionManifestV1,
  evidence: ExtensionPackageVerificationV1,
): Promise<void> {
  if (!evidence || typeof evidence !== "object" || !verifiedPackageEvidence.has(evidence)) {
    throw new ExtensionManifestError(
      "unverified_package_evidence",
      "Extension package evidence was not produced by verifyExtensionPackageV1 in this host process.",
    );
  }
  const parsed = parseExtensionManifestV1(manifest);
  const manifestSha256 = await extensionManifestSha256V1(parsed);
  if (!equalDigest(evidence.manifestSha256, manifestSha256)
    || !equalDigest(evidence.packageSha256, parsed.package.sha256)) {
    throw new ExtensionManifestError(
      "unverified_package_evidence",
      "Extension package evidence does not match the manifest being launched.",
    );
  }
}
