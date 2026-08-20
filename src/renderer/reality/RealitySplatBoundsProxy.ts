import * as THREE from "three";
import type { RealityBounds } from "./types";

const OUTLINE_COLOR = 0xe49a61;

/**
 * Cheap, deterministic selection geometry for a Gaussian splat asset.
 *
 * The transparent box is raycastable without making Spark iterate millions of
 * splats. The outline is presentation-only and never participates in picking.
 */
export class RealitySplatBoundsProxy extends THREE.Group {
  readonly hitTarget: THREE.Mesh<THREE.BoxGeometry, THREE.MeshBasicMaterial>;
  private readonly outline: THREE.LineSegments<THREE.EdgesGeometry, THREE.LineBasicMaterial>;

  constructor(bounds: RealityBounds, entityId?: string) {
    super();
    const box = validatedBounds(bounds);
    const size = box.getSize(new THREE.Vector3());
    const center = box.getCenter(new THREE.Vector3());

    const geometry = new THREE.BoxGeometry(1, 1, 1);
    const hitMaterial = new THREE.MeshBasicMaterial({
      color: 0xffffff,
      colorWrite: false,
      depthWrite: false,
      transparent: true,
      opacity: 0,
      side: THREE.DoubleSide,
    });
    this.hitTarget = new THREE.Mesh(geometry, hitMaterial);
    this.hitTarget.name = "reality-splat-bounds-hit-target";
    this.hitTarget.position.copy(center);
    this.hitTarget.scale.copy(size);
    this.hitTarget.userData.realitySelectionProxy = true;
    if (entityId) this.hitTarget.userData.entityId = entityId;
    this.add(this.hitTarget);

    const outlineGeometry = new THREE.EdgesGeometry(geometry);
    const outlineMaterial = new THREE.LineBasicMaterial({
      color: OUTLINE_COLOR,
      depthTest: false,
      transparent: true,
      opacity: 0.95,
    });
    this.outline = new THREE.LineSegments(outlineGeometry, outlineMaterial);
    this.outline.name = "reality-splat-bounds-outline";
    this.outline.position.copy(center);
    this.outline.scale.copy(size);
    this.outline.renderOrder = 10_000;
    this.outline.visible = false;
    this.outline.raycast = () => undefined;
    this.add(this.outline);
  }

  setSelected(selected: boolean): void {
    this.outline.visible = selected;
  }

  dispose(): void {
    this.removeFromParent();
    this.hitTarget.geometry.dispose();
    this.hitTarget.material.dispose();
    this.outline.geometry.dispose();
    this.outline.material.dispose();
    this.clear();
  }
}

function validatedBounds(bounds: RealityBounds): THREE.Box3 {
  const values = [
    bounds.min.x,
    bounds.min.y,
    bounds.min.z,
    bounds.max.x,
    bounds.max.y,
    bounds.max.z,
  ];
  if (!values.every(Number.isFinite)) {
    throw new Error("Reality asset bounds must contain only finite numbers.");
  }
  if (bounds.min.x > bounds.max.x || bounds.min.y > bounds.max.y || bounds.min.z > bounds.max.z) {
    throw new Error("Reality asset bounds must have min coordinates less than or equal to max coordinates.");
  }
  const minimumExtent = 1e-6;
  const min = new THREE.Vector3(bounds.min.x, bounds.min.y, bounds.min.z);
  const max = new THREE.Vector3(bounds.max.x, bounds.max.y, bounds.max.z);
  for (const axis of ["x", "y", "z"] as const) {
    if (max[axis] - min[axis] >= minimumExtent) continue;
    const center = (min[axis] + max[axis]) * 0.5;
    min[axis] = center - minimumExtent * 0.5;
    max[axis] = center + minimumExtent * 0.5;
  }
  return new THREE.Box3(min, max);
}
