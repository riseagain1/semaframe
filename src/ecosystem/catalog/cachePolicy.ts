import type {
  CatalogCacheDecision,
  VerifiedCatalogCacheRecord,
} from "./contracts";
import {
  assertVerifiedStaticTemplateCatalog,
  type VerifiedStaticTemplateCatalog,
} from "./crypto";

export const DEFAULT_TEMPLATE_CATALOG_MAX_AGE_MS = 60 * 60 * 1_000;
const verifiedCacheRecords = new WeakSet<object>();

export function createVerifiedCatalogCacheRecord(
  verifiedCatalog: VerifiedStaticTemplateCatalog,
  nowMs = Date.now(),
): VerifiedCatalogCacheRecord {
  if (!Number.isFinite(nowMs) || nowMs < 0) throw new TypeError("nowMs must be a non-negative finite number");
  assertVerifiedStaticTemplateCatalog(verifiedCatalog);
  const record = Object.freeze({
    catalog: verifiedCatalog.catalog,
    catalogDigest: verifiedCatalog.catalogDigest,
    fetchedAtMs: nowMs,
    verifiedAtMs: nowMs,
  });
  verifiedCacheRecords.add(record);
  return record;
}

export function decideTemplateCatalogCache(
  record: VerifiedCatalogCacheRecord | undefined,
  options: Readonly<{ nowMs?: number; online?: boolean; maxAgeMs?: number }> = {},
): CatalogCacheDecision {
  if (!record) return Object.freeze({ action: "fetch_required", reason: "missing" });
  if (!verifiedCacheRecords.has(record)) {
    return Object.freeze({ action: "fetch_required", reason: "unverified" });
  }
  const nowMs = options.nowMs ?? Date.now();
  const maxAgeMs = options.maxAgeMs ?? DEFAULT_TEMPLATE_CATALOG_MAX_AGE_MS;
  if (!Number.isFinite(nowMs) || nowMs < 0 || !Number.isFinite(maxAgeMs) || maxAgeMs < 0) {
    throw new TypeError("cache times must be non-negative finite numbers");
  }
  if (Date.parse(record.catalog.expiresAt) <= nowMs) {
    return Object.freeze({ action: "fetch_required", reason: "expired" });
  }
  if (nowMs - record.verifiedAtMs <= maxAgeMs) {
    return Object.freeze({ action: "use_cached", reason: "fresh", catalog: record.catalog });
  }
  if (options.online === false) {
    return Object.freeze({
      action: "use_stale_verified",
      reason: "offline_within_signed_validity",
      catalog: record.catalog,
    });
  }
  return Object.freeze({ action: "revalidate", reason: "stale", catalog: record.catalog });
}
