import { describe, expect, it } from "vitest";
import {
  createVerifiedCatalogCacheRecord,
  decideTemplateCatalogCache,
  parseCatalogTemplateArtifact,
  parseDigestPinnedTemplateArtifact,
  parseStaticTemplateCatalog,
  sha256Digest,
  staticCatalogSignedBytes,
  verifyStaticTemplateCatalog,
  type StaticTemplateCatalog,
} from "../../ecosystem/catalog";
import { FIRST_PARTY_PROJECT_TEMPLATES } from "../../ecosystem/templates";

function base64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/gu, "-").replace(/\//gu, "_").replace(/=+$/gu, "");
}

async function signedCatalog(
  privateKey: CryptoKey,
  overrides: Record<string, unknown> = {},
): Promise<StaticTemplateCatalog> {
  const unsigned = parseStaticTemplateCatalog({
    schemaVersion: "1",
    catalogId: "first-party",
    sequence: 7,
    generatedAt: "2026-08-27T00:00:00.000Z",
    expiresAt: "2026-09-03T00:00:00.000Z",
    entries: [{
      id: "first-party.decision-board",
      kind: "project",
      version: "1.0.0",
      title: "Decision board",
      summary: "A small decision workspace.",
      license: "Apache-2.0",
      publisher: "semaframe",
      artifactPath: "templates/decision-board.json",
      artifactDigest: `sha256:${"a".repeat(64)}`,
    }],
    signature: { algorithm: "Ed25519", keyId: "release-2026", value: "A".repeat(86) },
    ...overrides,
  });
  const signature = new Uint8Array(await crypto.subtle.sign("Ed25519", privateKey, staticCatalogSignedBytes(unsigned)));
  return parseStaticTemplateCatalog({
    ...unsigned,
    signature: { ...unsigned.signature, value: base64Url(signature) },
  });
}

describe("signed static template catalog", () => {
  it("verifies a pinned publisher key and rejects tampering and rollback", async () => {
    const keys = await crypto.subtle.generateKey("Ed25519", true, ["sign", "verify"]);
    const catalog = await signedCatalog(keys.privateKey);
    const trustStore = { getEd25519Key: async (keyId: string) => keyId === "release-2026" ? keys.publicKey : undefined };
    const verified = await verifyStaticTemplateCatalog(catalog, trustStore, {
      nowMs: Date.parse("2026-08-28T00:00:00.000Z"),
      minimumSequence: 7,
    });
    expect(verified.catalog.entries[0]?.artifactPath).toBe("templates/decision-board.json");
    expect(verified.catalogDigest).toMatch(/^sha256:[a-f0-9]{64}$/u);

    await expect(verifyStaticTemplateCatalog({
      ...catalog,
      entries: [{ ...catalog.entries[0], title: "Tampered" }],
    }, trustStore, { nowMs: Date.parse("2026-08-28T00:00:00.000Z") }))
      .rejects.toThrow(/does not verify/u);
    await expect(verifyStaticTemplateCatalog(catalog, trustStore, {
      nowMs: Date.parse("2026-08-28T00:00:00.000Z"),
      minimumSequence: 8,
    })).rejects.toThrow(/roll back/u);
  });

  it("rejects unsafe artifact locations and verifies descriptor bytes before parsing", async () => {
    expect(() => parseStaticTemplateCatalog({
      schemaVersion: "1",
      catalogId: "catalog",
      sequence: 1,
      generatedAt: "2026-08-27T00:00:00.000Z",
      expiresAt: "2026-08-28T00:00:00.000Z",
      entries: [{
        id: "bad.entry",
        kind: "project",
        version: "1.0.0",
        title: "Bad",
        summary: "Unsafe path",
        license: "MIT",
        publisher: "example",
        artifactPath: "https://example.test/template.json",
        artifactDigest: `sha256:${"0".repeat(64)}`,
      }],
      signature: { algorithm: "Ed25519", keyId: "key", value: "A".repeat(86) },
    })).toThrow(/safe catalog-relative path/u);

    const bytes = new TextEncoder().encode('{"schemaVersion":"1"}');
    const pinned = await sha256Digest(bytes);
    await expect(parseDigestPinnedTemplateArtifact(bytes, pinned)).resolves.toEqual({ schemaVersion: "1" });
    await expect(parseDigestPinnedTemplateArtifact(bytes, `sha256:${"f".repeat(64)}`)).rejects.toThrow(/pinned digest/u);

    const descriptor = FIRST_PARTY_PROJECT_TEMPLATES[0]!;
    const descriptorBytes = new TextEncoder().encode(JSON.stringify(descriptor));
    const entry = {
      id: descriptor.id,
      kind: descriptor.kind,
      version: descriptor.version,
      title: descriptor.title,
      summary: descriptor.summary,
      license: descriptor.license,
      publisher: "semaframe",
      artifactPath: "templates/decision-board.json",
      artifactDigest: await sha256Digest(descriptorBytes),
    } as const;
    await expect(parseCatalogTemplateArtifact(entry, descriptorBytes)).resolves.toMatchObject({ id: descriptor.id });
    await expect(parseCatalogTemplateArtifact({ ...entry, id: "other.template" }, descriptorBytes))
      .rejects.toThrow(/identity does not match/u);
  });

  it("uses stale cache only offline and only inside signed validity", async () => {
    const keys = await crypto.subtle.generateKey("Ed25519", true, ["sign", "verify"]);
    const catalog = await signedCatalog(keys.privateKey);
    const verified = await verifyStaticTemplateCatalog(catalog, {
      getEd25519Key: async () => keys.publicKey,
    }, { nowMs: Date.parse("2026-08-27T00:30:00.000Z") });
    const record = createVerifiedCatalogCacheRecord(
      verified,
      Date.parse("2026-08-27T01:00:00.000Z"),
    );
    expect(decideTemplateCatalogCache(record, {
      nowMs: Date.parse("2026-08-27T01:30:00.000Z"),
    }).action).toBe("use_cached");
    expect(decideTemplateCatalogCache(record, {
      nowMs: Date.parse("2026-08-28T00:00:00.000Z"),
      online: true,
    }).action).toBe("revalidate");
    expect(decideTemplateCatalogCache(record, {
      nowMs: Date.parse("2026-08-28T00:00:00.000Z"),
      online: false,
    }).action).toBe("use_stale_verified");
    expect(decideTemplateCatalogCache(record, {
      nowMs: Date.parse("2026-09-03T00:00:00.000Z"),
      online: false,
    }).action).toBe("fetch_required");

    expect(decideTemplateCatalogCache({
      catalog,
      catalogDigest: "not-even-a-digest",
      fetchedAtMs: Date.parse("2026-08-27T01:00:00.000Z"),
      verifiedAtMs: Date.parse("2026-08-27T01:00:00.000Z"),
    } as never)).toEqual({ action: "fetch_required", reason: "unverified" });
    expect(() => createVerifiedCatalogCacheRecord({
      catalog,
      catalogDigest: `sha256:${"b".repeat(64)}`,
    } as never)).toThrow(/verification evidence/u);
  });
});
