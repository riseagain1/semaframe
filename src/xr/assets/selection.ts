import type {
  XrAssetLodTier,
  XrAssetPerformanceBudget,
  XrAssetTierRejection,
  XrAssetTierRejectionReason,
  XrAssetTierSelection,
} from "./contracts";
import { parseXrAssetLodManifest, parseXrAssetPerformanceBudget } from "./validation";

function rejectionReasons(
  tier: XrAssetLodTier,
  budget: XrAssetPerformanceBudget,
): readonly XrAssetTierRejectionReason[] {
  const reasons: XrAssetTierRejectionReason[] = [];
  if (!budget.supportedFormats.includes(tier.format)) reasons.push("format_unsupported");
  if (tier.byteLength > budget.maximumAssetBytes) reasons.push("asset_bytes_exceeded");
  if (tier.estimatedGpuBytes > budget.maximumEstimatedGpuBytes) reasons.push("gpu_bytes_exceeded");
  if (tier.representation === "mesh") {
    if (tier.triangleCount > budget.maximumTriangles) reasons.push("triangle_budget_exceeded");
    if (tier.texturePixelCount > budget.maximumTexturePixels) reasons.push("texture_budget_exceeded");
  } else {
    if (tier.splatCount > budget.maximumSplats) reasons.push("splat_budget_exceeded");
    if (tier.sphericalHarmonicsDegree > budget.maximumSphericalHarmonicsDegree) {
      reasons.push("spherical_harmonics_budget_exceeded");
    }
  }
  return Object.freeze(reasons);
}

/** Selects the best tier without ever silently exceeding an observed budget. */
export function selectXrAssetLodTier(
  manifestValue: unknown,
  budgetValue: unknown,
): XrAssetTierSelection {
  const manifest = parseXrAssetLodManifest(manifestValue);
  const budget = parseXrAssetPerformanceBudget(budgetValue);
  const ordered = [...manifest.tiers].sort((left, right) => right.quality - left.quality);
  const rejected: XrAssetTierRejection[] = [];
  for (const tier of ordered) {
    const reasons = rejectionReasons(tier, budget);
    if (reasons.length === 0) {
      return Object.freeze({
        status: "selected",
        mode: tier.tierId === manifest.defaultTierId ? "full" : "degraded",
        tier,
        rejected: Object.freeze(rejected),
      });
    }
    rejected.push(Object.freeze({ tierId: tier.tierId, reasons }));
  }
  return Object.freeze({
    status: "placeholder",
    reason: rejected.every((entry) => entry.reasons.includes("format_unsupported"))
      ? "no_supported_format"
      : "performance_budget_exceeded",
    rejected: Object.freeze(rejected),
  });
}
