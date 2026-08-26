import { XR_ASSET_RUNTIME_LIMITS, type XrAssetPerformanceBudget } from "../assets";
import type { UltraGateDecision } from "./contracts";
import { isLocallyResolvedEligibleUltraGate } from "./gate";

export type XrRenderProfile = Readonly<{
  mode: "balanced" | "ultra";
  label: string;
  targetFrameRateHz: 72 | 90;
  framebufferScaleFactor: number;
  foveation: number;
  shadows: boolean;
  expensiveLighting: boolean;
  assetBudget: XrAssetPerformanceBudget;
}>;

const BALANCED_PROFILE: XrRenderProfile = Object.freeze({
  mode: "balanced",
  label: "Balanced XR",
  targetFrameRateHz: 72,
  framebufferScaleFactor: 0.82,
  foveation: 0.65,
  shadows: false,
  expensiveLighting: false,
  assetBudget: Object.freeze({
    version: 1,
    supportedFormats: Object.freeze([
      "mesh-glb", "gaussian-spz-v4", "gaussian-ply", "gaussian-sog-v2",
    ] as const),
    maximumAssetBytes: XR_ASSET_RUNTIME_LIMITS.balancedMaximumAssetBytes,
    maximumEstimatedGpuBytes: 768 * 1024 * 1024,
    maximumTriangles: 1_500_000,
    maximumTexturePixels: 32_000_000,
    maximumSplats: 1_500_000,
    maximumSphericalHarmonicsDegree: 2,
  }),
});

const ULTRA_PROFILE: XrRenderProfile = Object.freeze({
  mode: "ultra",
  label: "Windows PCVR Ultra",
  targetFrameRateHz: 90,
  framebufferScaleFactor: 1,
  foveation: 0.2,
  shadows: true,
  expensiveLighting: true,
  assetBudget: Object.freeze({
    version: 1,
    supportedFormats: Object.freeze([
      "mesh-glb", "gaussian-spz-v4", "gaussian-ply", "gaussian-sog-v2",
    ] as const),
    maximumAssetBytes: XR_ASSET_RUNTIME_LIMITS.relayMaximumAssetBytes,
    maximumEstimatedGpuBytes: 3 * 1024 * 1024 * 1024,
    maximumTriangles: 8_000_000,
    maximumTexturePixels: 192_000_000,
    maximumSplats: 6_000_000,
    maximumSphericalHarmonicsDegree: 3,
  }),
});

/** Ultra settings are impossible to obtain without a current eligible gate. */
export function xrRenderProfileForGate(
  gate?: Pick<UltraGateDecision, "effectiveMode" | "state">,
): XrRenderProfile {
  return gate?.state === "eligible"
    && gate.effectiveMode === "ultra"
    && isLocallyResolvedEligibleUltraGate(gate)
    ? ULTRA_PROFILE
    : BALANCED_PROFILE;
}
