export const REALITY_TWIN_MAX_ASSET_BYTES = 256 * 1024 * 1024;
export const REALITY_TWIN_MAX_SPLAT_COUNT = 4_000_000;

export function isWithinRealityTwinImportLimits({ byteLength, splatCount }) {
  return Number.isSafeInteger(byteLength)
    && byteLength >= 1
    && byteLength <= REALITY_TWIN_MAX_ASSET_BYTES
    && Number.isSafeInteger(splatCount)
    && splatCount >= 1
    && splatCount <= REALITY_TWIN_MAX_SPLAT_COUNT;
}
