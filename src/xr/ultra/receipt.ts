import {
  ULTRA_POLICY_VERSION,
  ULTRA_RECEIPT_REVALIDATION_MS,
  ULTRA_RECEIPT_TTL_MS,
  type UltraEligibilityReceipt,
  type UltraReceiptValidation,
  type UltraRuntimeBenchmarkEvaluation,
  type UltraStaticProbeEvaluation,
} from "./contracts";
import { fingerprintUltraValue } from "./fingerprint";

type UnsignedReceipt = Omit<UltraEligibilityReceipt, "fingerprint">;

// A public SHA-256 fingerprint detects mutation but is not an authenticity
// proof: attacker-authored JSON can reproduce it. Receipts are therefore
// realm-local capabilities. Parsed, cloned, or persisted JSON fails closed.
const locallyIssuedReceipts = new WeakSet<object>();

function unsignedReceipt(receipt: UltraEligibilityReceipt): UnsignedReceipt {
  return Object.freeze({
    version: receipt.version,
    policyVersion: receipt.policyVersion,
    scope: receipt.scope,
    status: receipt.status,
    probeFingerprint: receipt.probeFingerprint,
    benchmarkFingerprint: receipt.benchmarkFingerprint,
    issuedAt: receipt.issuedAt,
    revalidateAt: receipt.revalidateAt,
    expiresAt: receipt.expiresAt,
  });
}

function canonicalTimestamp(value: string): number | undefined {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value ? parsed : undefined;
}

export async function issueUltraEligibilityReceipt(
  probe: UltraStaticProbeEvaluation,
  benchmark: UltraRuntimeBenchmarkEvaluation,
  now = Date.now(),
): Promise<UltraEligibilityReceipt> {
  if (!probe.eligible) throw new Error("Ultra receipt cannot be issued for an ineligible static probe");
  if (!benchmark.passed) throw new Error("Ultra receipt cannot be issued for a failed runtime benchmark");
  if (probe.policyVersion !== ULTRA_POLICY_VERSION || benchmark.policyVersion !== ULTRA_POLICY_VERSION) {
    throw new Error("Ultra receipt cannot be issued for a different policy version");
  }
  if (!Number.isSafeInteger(now) || now < 0) throw new TypeError("Ultra receipt time is invalid");

  const receipt: UnsignedReceipt = Object.freeze({
    version: 1,
    policyVersion: ULTRA_POLICY_VERSION,
    scope: "windows_pcvr_ultra",
    status: "eligible",
    probeFingerprint: probe.fingerprint,
    benchmarkFingerprint: benchmark.fingerprint,
    issuedAt: new Date(now).toISOString(),
    revalidateAt: new Date(now + ULTRA_RECEIPT_REVALIDATION_MS).toISOString(),
    expiresAt: new Date(now + ULTRA_RECEIPT_TTL_MS).toISOString(),
  });
  const issued = Object.freeze({
    ...receipt,
    fingerprint: await fingerprintUltraValue(receipt),
  });
  locallyIssuedReceipts.add(issued);
  return issued;
}

export async function validateUltraEligibilityReceipt(
  receipt: UltraEligibilityReceipt | undefined,
  probe: UltraStaticProbeEvaluation,
  benchmark: UltraRuntimeBenchmarkEvaluation,
  now = Date.now(),
): Promise<UltraReceiptValidation> {
  if (!receipt) return Object.freeze({ valid: false, status: "missing" });
  if (!locallyIssuedReceipts.has(receipt)) {
    return Object.freeze({ valid: false, status: "invalid" });
  }
  if (receipt.version !== 1 || receipt.scope !== "windows_pcvr_ultra" || receipt.status !== "eligible") {
    return Object.freeze({ valid: false, status: "invalid" });
  }
  if (receipt.policyVersion !== ULTRA_POLICY_VERSION
    || probe.policyVersion !== ULTRA_POLICY_VERSION
    || benchmark.policyVersion !== ULTRA_POLICY_VERSION) {
    return Object.freeze({ valid: false, status: "policy_mismatch" });
  }
  if (!probe.eligible) return Object.freeze({ valid: false, status: "probe_ineligible" });
  if (!benchmark.passed) return Object.freeze({ valid: false, status: "benchmark_failed" });

  const issuedAt = canonicalTimestamp(receipt.issuedAt);
  const revalidateAt = canonicalTimestamp(receipt.revalidateAt);
  const expiresAt = canonicalTimestamp(receipt.expiresAt);
  if (issuedAt === undefined || revalidateAt === undefined || expiresAt === undefined
    || !Number.isSafeInteger(now) || now < 0
    || issuedAt > revalidateAt || revalidateAt > expiresAt
    || revalidateAt - issuedAt !== ULTRA_RECEIPT_REVALIDATION_MS
    || expiresAt - issuedAt !== ULTRA_RECEIPT_TTL_MS) {
    return Object.freeze({ valid: false, status: "invalid" });
  }
  const expectedFingerprint = await fingerprintUltraValue(unsignedReceipt(receipt));
  if (expectedFingerprint !== receipt.fingerprint) {
    return Object.freeze({ valid: false, status: "invalid" });
  }
  if (receipt.probeFingerprint !== probe.fingerprint) {
    return Object.freeze({ valid: false, status: "probe_changed" });
  }
  if (receipt.benchmarkFingerprint !== benchmark.fingerprint) {
    return Object.freeze({ valid: false, status: "benchmark_changed" });
  }
  if (now >= expiresAt) return Object.freeze({ valid: false, status: "expired" });
  if (now >= revalidateAt) return Object.freeze({ valid: false, status: "revalidation_required" });
  return Object.freeze({ valid: true, status: "valid" });
}
