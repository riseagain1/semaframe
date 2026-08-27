import {
  TEMPLATE_CATALOG_SIGNATURE_ALGORITHM,
  type Sha256Digest,
  type StaticTemplateCatalog,
  type StaticTemplateCatalogEntry,
  type TemplateDescriptor,
} from "./contracts";
import {
  EcosystemValidationError,
  parseStaticTemplateCatalog,
  parseTemplateDescriptor,
} from "./validation";

const MAX_CATALOG_VALIDITY_MS = 31 * 24 * 60 * 60 * 1_000;
const MAX_GENERATED_AT_SKEW_MS = 5 * 60 * 1_000;
const MAX_TEMPLATE_ARTIFACT_BYTES = 1_048_576;

export type TemplateCatalogTrustStore = Readonly<{
  getEd25519Key(keyId: string): Promise<CryptoKey | undefined>;
}>;

declare const verifiedStaticCatalogBrand: unique symbol;
export type VerifiedStaticTemplateCatalog = Readonly<{
  catalog: StaticTemplateCatalog;
  catalogDigest: Sha256Digest;
  [verifiedStaticCatalogBrand]: true;
}>;

const verifiedStaticCatalogs = new WeakSet<object>();

function canonicalJson(value: unknown): string {
  if (value === null || typeof value === "boolean" || typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError("Canonical JSON does not support non-finite numbers");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
      .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`);
    return `{${entries.join(",")}}`;
  }
  throw new TypeError("Canonical JSON supports JSON values only");
}

function base64UrlBytes(value: string): Uint8Array<ArrayBuffer> {
  const base64 = value.replace(/-/gu, "+").replace(/_/gu, "/");
  const binary = atob(`${base64}${"=".repeat((4 - base64.length % 4) % 4)}`);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

export function staticCatalogSignedBytes(catalog: StaticTemplateCatalog): Uint8Array<ArrayBuffer> {
  const { signature, ...payload } = catalog;
  return new TextEncoder().encode(canonicalJson({
    ...payload,
    signature: { algorithm: signature.algorithm, keyId: signature.keyId },
  }));
}

export async function sha256Digest(value: Uint8Array): Promise<Sha256Digest> {
  const owned = new Uint8Array(value.byteLength);
  owned.set(value);
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", owned));
  return `sha256:${[...digest].map((byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}

export async function verifyStaticTemplateCatalog(
  value: unknown,
  trustStore: TemplateCatalogTrustStore,
  options: Readonly<{ nowMs?: number; minimumSequence?: number }> = {},
): Promise<VerifiedStaticTemplateCatalog> {
  const catalog = parseStaticTemplateCatalog(value);
  const nowMs = options.nowMs ?? Date.now();
  const generatedAtMs = Date.parse(catalog.generatedAt);
  const expiresAtMs = Date.parse(catalog.expiresAt);
  if (generatedAtMs > nowMs + MAX_GENERATED_AT_SKEW_MS) {
    throw new EcosystemValidationError("invalid_value", "$.generatedAt", "is unreasonably far in the future");
  }
  if (expiresAtMs - generatedAtMs > MAX_CATALOG_VALIDITY_MS) {
    throw new EcosystemValidationError("invalid_value", "$.expiresAt", "catalog validity cannot exceed 31 days");
  }
  if (expiresAtMs <= nowMs) {
    throw new EcosystemValidationError("invalid_value", "$.expiresAt", "catalog signature validity has expired");
  }
  if (options.minimumSequence !== undefined && catalog.sequence < options.minimumSequence) {
    throw new EcosystemValidationError("invalid_value", "$.sequence", "would roll back the trusted catalog sequence");
  }
  const key = await trustStore.getEd25519Key(catalog.signature.keyId);
  if (!key || key.algorithm.name !== TEMPLATE_CATALOG_SIGNATURE_ALGORITHM || !key.usages.includes("verify")) {
    throw new EcosystemValidationError("invalid_value", "$.signature.keyId", "is not a trusted Ed25519 verification key");
  }
  const valid = await crypto.subtle.verify(
    TEMPLATE_CATALOG_SIGNATURE_ALGORITHM,
    key,
    base64UrlBytes(catalog.signature.value),
    staticCatalogSignedBytes(catalog),
  );
  if (!valid) {
    throw new EcosystemValidationError("invalid_value", "$.signature.value", "does not verify against the pinned key");
  }
  const encodedCatalog = new TextEncoder().encode(canonicalJson(catalog));
  const verified = Object.freeze({
    catalog,
    catalogDigest: await sha256Digest(encodedCatalog),
  }) as VerifiedStaticTemplateCatalog;
  verifiedStaticCatalogs.add(verified);
  return verified;
}

export function assertVerifiedStaticTemplateCatalog(
  value: VerifiedStaticTemplateCatalog,
): asserts value is VerifiedStaticTemplateCatalog {
  if (!value || typeof value !== "object" || !verifiedStaticCatalogs.has(value)) {
    throw new TypeError("Catalog verification evidence must come from verifyStaticTemplateCatalog in this runtime.");
  }
}

export async function parseDigestPinnedTemplateArtifact(
  bytes: Uint8Array,
  expectedDigest: Sha256Digest,
): Promise<unknown> {
  if (bytes.byteLength > MAX_TEMPLATE_ARTIFACT_BYTES) {
    throw new EcosystemValidationError("limit_exceeded", "$artifact", "cannot exceed 1048576 bytes");
  }
  const actualDigest = await sha256Digest(bytes);
  if (actualDigest !== expectedDigest) {
    throw new EcosystemValidationError("inconsistent_value", "$artifact", "bytes do not match the catalog-pinned digest");
  }
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new EcosystemValidationError("invalid_value", "$artifact", "must be valid UTF-8");
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new EcosystemValidationError("invalid_value", "$artifact", "must be valid JSON");
  }
}

export async function parseCatalogTemplateArtifact(
  entry: StaticTemplateCatalogEntry,
  bytes: Uint8Array,
): Promise<TemplateDescriptor> {
  const descriptor = parseTemplateDescriptor(await parseDigestPinnedTemplateArtifact(bytes, entry.artifactDigest));
  if (descriptor.id !== entry.id || descriptor.kind !== entry.kind || descriptor.version !== entry.version) {
    throw new EcosystemValidationError(
      "inconsistent_value",
      "$artifact",
      "descriptor identity does not match its signed catalog entry",
    );
  }
  return descriptor;
}
