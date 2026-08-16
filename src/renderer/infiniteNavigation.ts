import * as THREE from "three";

/** Practical limits chosen to feel unbounded while remaining finite and recoverable. */
export const INFINITE_NAVIGATION_LIMITS = Object.freeze({
  minCameraDistance: 1e-5,
  minCanvasZoom: 1e-4,
  maxCanvasZoom: 1e4,
  minFarPlane: 10,
  maxFarPlane: 1e15,
  minNearPlane: 1e-7,
  originRebaseThreshold: 10_000,
  originGrid: 1_000,
});

export type AdaptiveClipPlanes = Readonly<{ near: number; far: number }>;

/**
 * Regular perspective depth precision collapses when one fixed near/far pair
 * covers microscopic and planetary views. The renderer uses logarithmic depth
 * and continuously fits these planes around the live camera and scene bounds.
 */
export function adaptiveClipPlanes(
  cameraDistance: number,
  cameraToBoundsCenter: number,
  boundsRadius: number,
): AdaptiveClipPlanes {
  const distance = positive(cameraDistance, 1);
  const centerDistance = nonNegative(cameraToBoundsCenter);
  const radius = nonNegative(boundsRadius);
  const near = Math.max(
    INFINITE_NAVIGATION_LIMITS.minNearPlane,
    distance * 1e-5,
  );
  const far = Math.min(
    INFINITE_NAVIGATION_LIMITS.maxFarPlane,
    Math.max(
      INFINITE_NAVIGATION_LIMITS.minFarPlane,
      near * 1e5,
      distance * 1e3,
      centerDistance + radius * 2.5,
    ),
  );
  return { near, far: Math.max(far, near * 10) };
}

/** Scene-relative maximum gives each project six orders of dolly headroom. */
export function cameraDistanceLimits(boundsRadius: number): Readonly<{ min: number; max: number }> {
  const radius = Math.max(1, nonNegative(boundsRadius));
  return {
    min: INFINITE_NAVIGATION_LIMITS.minCameraDistance,
    max: Math.min(INFINITE_NAVIGATION_LIMITS.maxFarPlane * 0.1, Math.max(1e6, radius * 1e6)),
  };
}

/** Round a semantic target to a stable render origin once it becomes distant. */
export function floatingOriginFor(
  semanticTarget: THREE.Vector3,
  currentOrigin: THREE.Vector3,
): THREE.Vector3 | null {
  if (semanticTarget.distanceTo(currentOrigin) < INFINITE_NAVIGATION_LIMITS.originRebaseThreshold) return null;
  const grid = INFINITE_NAVIGATION_LIMITS.originGrid;
  return new THREE.Vector3(
    Math.round(semanticTarget.x / grid) * grid,
    Math.round(semanticTarget.y / grid) * grid,
    Math.round(semanticTarget.z / grid) * grid,
  );
}

function positive(value: number, fallback: number): number {
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

function nonNegative(value: number): number {
  return Number.isFinite(value) && value > 0 ? value : 0;
}
