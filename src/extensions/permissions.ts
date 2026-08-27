import { z } from "zod";
import { EXTENSION_PERMISSION_IDS, type ExtensionPermissionIdV1 } from "./contracts";

const IDENTIFIER = z.string().min(1).max(128).regex(/^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/u);
const SEMVER = z.string().min(5).max(128).regex(/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/u);
const SHA256 = z.string().regex(/^sha256:[0-9a-f]{64}$/u);
const GRANT_ID = z.string().min(16).max(128).regex(/^[A-Za-z0-9_-]+$/u);

export const extensionPermissionGrantV1Schema = z.strictObject({
  schemaVersion: z.literal("1.0"),
  grantId: GRANT_ID,
  extensionId: IDENTIFIER,
  extensionVersion: SEMVER,
  manifestSha256: SHA256,
  workspaceId: z.string().min(1).max(256),
  providerIds: z.array(IDENTIFIER).min(1).max(32),
  permissions: z.array(z.enum(EXTENSION_PERMISSION_IDS)).min(1).max(EXTENSION_PERMISSION_IDS.length),
  networkOrigins: z.array(z.url().max(2_048)).max(64),
  secretIds: z.array(IDENTIFIER).max(64),
  issuedAtMs: z.number().int().nonnegative(),
  expiresAtMs: z.number().int().positive(),
}).superRefine((grant, context) => {
  for (const key of ["providerIds", "permissions", "networkOrigins", "secretIds"] as const) {
    if (new Set(grant[key]).size !== grant[key].length) {
      context.addIssue({ code: "custom", path: [key], message: `${key} must contain unique values.` });
    }
  }
  if (grant.expiresAtMs <= grant.issuedAtMs) {
    context.addIssue({ code: "custom", path: ["expiresAtMs"], message: "Grant expiry must be after issue time." });
  }
  if (grant.networkOrigins.length > 0 && !grant.permissions.includes("network:brokered")) {
    context.addIssue({ code: "custom", path: ["networkOrigins"], message: "Network origins require network:brokered." });
  }
  if (grant.secretIds.length > 0 && !grant.permissions.includes("secret:use")) {
    context.addIssue({ code: "custom", path: ["secretIds"], message: "Secret scopes require secret:use." });
  }
});

export type ExtensionPermissionGrantV1 = z.infer<typeof extensionPermissionGrantV1Schema>;

export class ExtensionPermissionError extends Error {
  constructor(
    readonly code:
      | "invalid_grant"
      | "grant_expired"
      | "grant_not_found"
      | "grant_binding_mismatch"
      | "permission_denied"
      | "scope_denied",
    message: string,
  ) {
    super(message);
    this.name = "ExtensionPermissionError";
  }
}

export function parseExtensionPermissionGrantV1(value: unknown): ExtensionPermissionGrantV1 {
  const result = extensionPermissionGrantV1Schema.safeParse(value);
  if (!result.success) {
    const issue = result.error.issues[0];
    throw new ExtensionPermissionError(
      "invalid_grant",
      `Invalid extension permission grant at ${issue?.path.join(".") || "$"}: ${issue?.message ?? "invalid value"}`,
    );
  }
  const grant = structuredClone(result.data);
  Object.freeze(grant.providerIds);
  Object.freeze(grant.permissions);
  Object.freeze(grant.networkOrigins);
  Object.freeze(grant.secretIds);
  return Object.freeze(grant);
}

export type ExtensionPermissionCheckV1 = Readonly<{
  extensionId: string;
  extensionVersion: string;
  manifestSha256: string;
  workspaceId: string;
  providerId: string;
  permission: ExtensionPermissionIdV1;
  networkOrigin?: string;
  secretId?: string;
}>;

export function assertExtensionPermissionGrantV1(
  grantValue: ExtensionPermissionGrantV1,
  check: ExtensionPermissionCheckV1,
  nowMs = Date.now(),
): ExtensionPermissionGrantV1 {
  const grant = parseExtensionPermissionGrantV1(grantValue);
  if (nowMs >= grant.expiresAtMs) {
    throw new ExtensionPermissionError("grant_expired", "Extension permission grant has expired.");
  }
  if (grant.extensionId !== check.extensionId
    || grant.extensionVersion !== check.extensionVersion
    || grant.manifestSha256 !== check.manifestSha256
    || grant.workspaceId !== check.workspaceId) {
    throw new ExtensionPermissionError("grant_binding_mismatch", "Extension permission grant is bound to another package or workspace.");
  }
  if (!grant.providerIds.includes(check.providerId)) {
    throw new ExtensionPermissionError("scope_denied", "Extension provider is outside the grant scope.");
  }
  if (!grant.permissions.includes(check.permission)) {
    throw new ExtensionPermissionError("permission_denied", `Extension permission ${check.permission} was not granted.`);
  }
  if (check.permission === "network:brokered") {
    if (!check.networkOrigin || !grant.networkOrigins.includes(check.networkOrigin)) {
      throw new ExtensionPermissionError("scope_denied", "Network origin is outside the grant scope.");
    }
  }
  if (check.permission === "secret:use") {
    if (!check.secretId || !grant.secretIds.includes(check.secretId)) {
      throw new ExtensionPermissionError("scope_denied", "Secret identifier is outside the grant scope.");
    }
  }
  return grant;
}
