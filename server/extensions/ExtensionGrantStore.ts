import { createHash, randomBytes } from "node:crypto";
import {
  assertExtensionPermissionGrantV1,
  extensionManifestSha256V1,
  ExtensionPermissionError,
  parseExtensionManifestV1,
  parseExtensionPermissionGrantV1,
  type ExtensionManifestV1,
  type ExtensionPermissionCheckV1,
  type ExtensionPermissionGrantV1,
  type ExtensionPermissionIdV1,
} from "../../src/extensions";

const DEFAULT_TTL_MS = 30 * 60 * 1_000;
const MAX_TTL_MS = 24 * 60 * 60 * 1_000;
const DEFAULT_CAPACITY = 256;

type StoredGrant = Readonly<{
  tokenHash: string;
  grant: ExtensionPermissionGrantV1;
}>;

export type ExtensionGrantIssueRequest = Readonly<{
  manifest: ExtensionManifestV1;
  workspaceId: string;
  providerIds: readonly string[];
  permissions: readonly ExtensionPermissionIdV1[];
  networkOrigins?: readonly string[];
  secretIds?: readonly string[];
  ttlMs?: number;
}>;

export type IssuedExtensionGrant = Readonly<{
  /** Bearer capability. It is returned once and never stored in plaintext. */
  token: string;
  grant: ExtensionPermissionGrantV1;
}>;

export type ExtensionGrantStoreOptions = Readonly<{
  capacity?: number;
  now?: () => number;
  randomBytes?: (size: number) => Uint8Array;
}>;

function digestToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

function unique<T>(values: readonly T[]): T[] {
  return [...new Set(values)];
}

function manifestPermissionScopes(manifest: ExtensionManifestV1): Readonly<{
  permissions: ReadonlySet<ExtensionPermissionIdV1>;
  origins: ReadonlySet<string>;
  secretIds: ReadonlySet<string>;
}> {
  const permissions = new Set<ExtensionPermissionIdV1>();
  const origins = new Set<string>();
  const secretIds = new Set<string>();
  for (const request of manifest.requestedPermissions) {
    permissions.add(request.permission);
    if (request.permission === "network:brokered") request.origins.forEach((origin) => origins.add(origin));
    if (request.permission === "secret:use") request.secretIds.forEach((secretId) => secretIds.add(secretId));
  }
  return { permissions, origins, secretIds };
}

export class ExtensionGrantStore {
  readonly #records = new Map<string, StoredGrant>();
  readonly #capacity: number;
  readonly #now: () => number;
  readonly #randomBytes: (size: number) => Uint8Array;

  constructor(options: ExtensionGrantStoreOptions = {}) {
    this.#capacity = options.capacity ?? DEFAULT_CAPACITY;
    if (!Number.isSafeInteger(this.#capacity) || this.#capacity < 1 || this.#capacity > 10_000) {
      throw new RangeError("Extension grant capacity must be between 1 and 10000.");
    }
    this.#now = options.now ?? Date.now;
    this.#randomBytes = options.randomBytes ?? randomBytes;
  }

  get size(): number {
    this.#sweepExpired();
    return this.#records.size;
  }

  async issue(request: ExtensionGrantIssueRequest): Promise<IssuedExtensionGrant> {
    const manifest = parseExtensionManifestV1(request.manifest);
    const now = this.#now();
    const ttlMs = request.ttlMs ?? DEFAULT_TTL_MS;
    if (!Number.isSafeInteger(ttlMs) || ttlMs < 1_000 || ttlMs > MAX_TTL_MS) {
      throw new RangeError("Extension grant ttlMs must be between 1000 and 86400000.");
    }
    if (!request.workspaceId || request.workspaceId.length > 256) {
      throw new ExtensionPermissionError("invalid_grant", "Extension workspace id is invalid.");
    }
    const providerIds = unique(request.providerIds);
    const declaredProviderIds = new Set(manifest.providers.map((provider) => provider.id));
    if (providerIds.length === 0 || providerIds.some((providerId) => !declaredProviderIds.has(providerId))) {
      throw new ExtensionPermissionError("scope_denied", "Grant contains an undeclared extension provider.");
    }
    const permissions = unique(request.permissions);
    const requested = manifestPermissionScopes(manifest);
    if (permissions.length === 0 || permissions.some((permission) => !requested.permissions.has(permission))) {
      throw new ExtensionPermissionError("permission_denied", "Grant contains a permission the extension did not request.");
    }
    const networkOrigins = unique(request.networkOrigins ?? []);
    if (networkOrigins.some((origin) => !requested.origins.has(origin))) {
      throw new ExtensionPermissionError("scope_denied", "Grant contains an unrequested network origin.");
    }
    const secretIds = unique(request.secretIds ?? []);
    if (secretIds.some((secretId) => !requested.secretIds.has(secretId))) {
      throw new ExtensionPermissionError("scope_denied", "Grant contains an unrequested secret identifier.");
    }
    this.#sweepExpired();
    if (this.#records.size >= this.#capacity) {
      throw new ExtensionPermissionError("invalid_grant", "Extension grant capacity is exhausted.");
    }

    const token = Buffer.from(this.#randomBytes(32)).toString("base64url");
    const grantId = Buffer.from(this.#randomBytes(18)).toString("base64url");
    const grant: ExtensionPermissionGrantV1 = parseExtensionPermissionGrantV1({
      schemaVersion: "1.0",
      grantId,
      extensionId: manifest.id,
      extensionVersion: manifest.version,
      manifestSha256: await extensionManifestSha256V1(manifest),
      workspaceId: request.workspaceId,
      providerIds,
      permissions,
      networkOrigins,
      secretIds,
      issuedAtMs: now,
      expiresAtMs: now + ttlMs,
    });
    this.#records.set(grantId, Object.freeze({ tokenHash: digestToken(token), grant }));
    return Object.freeze({ token, grant });
  }

  authorize(token: string, check: ExtensionPermissionCheckV1): ExtensionPermissionGrantV1 {
    if (typeof token !== "string" || token.length < 32 || token.length > 128) {
      throw new ExtensionPermissionError("grant_not_found", "Extension grant token was not found.");
    }
    const tokenHash = digestToken(token);
    let record: StoredGrant | undefined;
    for (const candidate of this.#records.values()) {
      const expected = Buffer.from(candidate.tokenHash, "hex");
      const actual = Buffer.from(tokenHash, "hex");
      if (expected.length === actual.length) {
        let difference = 0;
        for (let index = 0; index < expected.length; index += 1) difference |= expected[index]! ^ actual[index]!;
        if (difference === 0) record = candidate;
      }
    }
    if (!record) {
      throw new ExtensionPermissionError("grant_not_found", "Extension grant token was not found.");
    }
    try {
      return assertExtensionPermissionGrantV1(record.grant, check, this.#now());
    } catch (error) {
      if (error instanceof ExtensionPermissionError && error.code === "grant_expired") {
        this.#records.delete(record.grant.grantId);
      }
      throw error;
    }
  }

  revoke(grantId: string): boolean {
    return this.#records.delete(grantId);
  }

  revokeExtension(extensionId: string): number {
    let removed = 0;
    for (const [grantId, record] of this.#records) {
      if (record.grant.extensionId === extensionId) {
        this.#records.delete(grantId);
        removed += 1;
      }
    }
    return removed;
  }

  #sweepExpired(): void {
    const now = this.#now();
    for (const [grantId, record] of this.#records) {
      if (now >= record.grant.expiresAtMs) this.#records.delete(grantId);
    }
  }
}
