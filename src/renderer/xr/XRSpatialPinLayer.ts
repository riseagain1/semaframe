import * as THREE from "three";
import type { XRSpatialPin } from "../../xr/client/contracts";

const LABEL_WIDTH = 1024;
const LABEL_HEIGHT = 224;
const STATUS_WIDTH = 1024;
const STATUS_HEIGHT = 180;
const NO_RAYCAST: THREE.Object3D["raycast"] = () => undefined;

/** Renderer-only marker and short-lived headset hint for one active XR pin. */
export class XRSpatialPinLayer {
  readonly root = new THREE.Group();
  readonly hudRoot = new THREE.Group();

  private readonly labelCanvas: HTMLCanvasElement;
  private readonly labelTexture: THREE.CanvasTexture;
  private readonly labelMaterial: THREE.SpriteMaterial;
  private readonly statusCanvas: HTMLCanvasElement;
  private readonly statusTexture: THREE.CanvasTexture;
  private readonly statusMaterial: THREE.MeshBasicMaterial;
  private readonly ownedGeometries: THREE.BufferGeometry[] = [];
  private readonly ownedMaterials: THREE.Material[] = [];
  private readonly ownedTextures: THREE.Texture[] = [];
  private pin?: XRSpatialPin;
  private statusExpiresAtMs = 0;
  private disposed = false;

  constructor(documentValue: Document = document) {
    this.root.name = "semaframe-xr-spatial-pin";
    this.root.visible = false;
    this.root.userData.ephemeral = true;
    this.root.raycast = NO_RAYCAST;
    this.hudRoot.name = "semaframe-xr-spatial-pin-status";
    this.hudRoot.visible = false;
    this.hudRoot.userData.ephemeral = true;
    this.hudRoot.raycast = NO_RAYCAST;

    const sphereGeometry = new THREE.SphereGeometry(0.018, 18, 12);
    const sphereMaterial = new THREE.MeshBasicMaterial({
      color: 0xffc96b,
      depthTest: false,
      depthWrite: false,
      toneMapped: false,
    });
    this.ownedGeometries.push(sphereGeometry);
    this.ownedMaterials.push(sphereMaterial);
    const sphere = new THREE.Mesh(sphereGeometry, sphereMaterial);
    sphere.name = "semaframe-xr-spatial-pin-point";
    sphere.renderOrder = 10_020;
    sphere.raycast = NO_RAYCAST;
    this.root.add(sphere);

    const ringGeometry = new THREE.TorusGeometry(0.045, 0.004, 8, 32);
    const ringMaterial = new THREE.MeshBasicMaterial({
      color: 0x68d5ff,
      depthTest: false,
      depthWrite: false,
      side: THREE.DoubleSide,
      toneMapped: false,
    });
    this.ownedGeometries.push(ringGeometry);
    this.ownedMaterials.push(ringMaterial);
    const ring = new THREE.Mesh(ringGeometry, ringMaterial);
    ring.name = "semaframe-xr-spatial-pin-ring";
    ring.renderOrder = 10_019;
    ring.raycast = NO_RAYCAST;
    this.root.add(ring);

    const stemGeometry = new THREE.BufferGeometry().setFromPoints([
      new THREE.Vector3(0, 0.02, 0),
      new THREE.Vector3(0, 0.16, 0),
    ]);
    const stemMaterial = new THREE.LineBasicMaterial({
      color: 0xffc96b,
      depthTest: false,
      depthWrite: false,
      transparent: true,
      opacity: 0.95,
      toneMapped: false,
    });
    this.ownedGeometries.push(stemGeometry);
    this.ownedMaterials.push(stemMaterial);
    const stem = new THREE.Line(stemGeometry, stemMaterial);
    stem.name = "semaframe-xr-spatial-pin-stem";
    stem.renderOrder = 10_018;
    stem.raycast = NO_RAYCAST;
    this.root.add(stem);

    this.labelCanvas = documentValue.createElement("canvas");
    this.labelCanvas.width = LABEL_WIDTH;
    this.labelCanvas.height = LABEL_HEIGHT;
    this.labelTexture = new THREE.CanvasTexture(this.labelCanvas);
    this.labelTexture.colorSpace = THREE.SRGBColorSpace;
    this.labelTexture.minFilter = THREE.LinearFilter;
    this.labelMaterial = new THREE.SpriteMaterial({
      map: this.labelTexture,
      transparent: true,
      depthTest: false,
      depthWrite: false,
      toneMapped: false,
    });
    this.ownedTextures.push(this.labelTexture);
    this.ownedMaterials.push(this.labelMaterial);
    const label = new THREE.Sprite(this.labelMaterial);
    label.name = "semaframe-xr-spatial-pin-label";
    label.position.set(0, 0.23, 0);
    label.scale.set(0.94, 0.205, 1);
    label.renderOrder = 10_021;
    label.raycast = NO_RAYCAST;
    this.root.add(label);

    this.statusCanvas = documentValue.createElement("canvas");
    this.statusCanvas.width = STATUS_WIDTH;
    this.statusCanvas.height = STATUS_HEIGHT;
    this.statusTexture = new THREE.CanvasTexture(this.statusCanvas);
    this.statusTexture.colorSpace = THREE.SRGBColorSpace;
    this.statusTexture.minFilter = THREE.LinearFilter;
    this.statusMaterial = new THREE.MeshBasicMaterial({
      map: this.statusTexture,
      transparent: true,
      depthTest: false,
      depthWrite: false,
      side: THREE.DoubleSide,
      toneMapped: false,
    });
    const statusGeometry = new THREE.PlaneGeometry(0.9, 0.16);
    this.ownedTextures.push(this.statusTexture);
    this.ownedMaterials.push(this.statusMaterial);
    this.ownedGeometries.push(statusGeometry);
    const status = new THREE.Mesh(statusGeometry, this.statusMaterial);
    status.name = "semaframe-xr-spatial-pin-hint";
    status.renderOrder = 10_030;
    status.raycast = NO_RAYCAST;
    this.hudRoot.add(status);
  }

  setPin(pin: XRSpatialPin): void {
    if (this.disposed) return;
    this.pin = pin;
    this.root.userData.pinId = pin.pinId;
    this.root.userData.workspacePositionM = { ...pin.workspacePositionM };
    this.root.position.set(
      pin.workspacePositionM.x,
      pin.workspacePositionM.y,
      pin.workspacePositionM.z,
    );
    this.root.visible = true;
    this.drawLabel(pin);
    this.showStatus("Coordinate pinned · Agent can read this point", "#72dea1", 2_600);
  }

  clear(showFeedback = true): void {
    if (this.disposed) return;
    this.pin = undefined;
    this.root.visible = false;
    delete this.root.userData.pinId;
    delete this.root.userData.workspacePositionM;
    if (showFeedback) this.showStatus("Coordinate pin cleared", "#ffc96b", 1_800);
  }

  showEntryHint(): void {
    if (this.disposed) return;
    this.showStatus("Aim at a surface · A/X pins · B/Y clears", "#68d5ff", 6_000);
  }

  showMiss(): void {
    if (this.disposed) return;
    this.showStatus("No surface under the pointer · move the ray and try again", "#ff8d83", 2_400);
  }

  getPin(): XRSpatialPin | undefined {
    return this.pin;
  }

  update(camera: THREE.Camera, nowMs = Date.now()): void {
    if (this.disposed) return;
    if (this.root.visible) {
      const cameraPosition = camera.getWorldPosition(new THREE.Vector3());
      const markerPosition = this.root.getWorldPosition(new THREE.Vector3());
      const scale = THREE.MathUtils.clamp(cameraPosition.distanceTo(markerPosition) * 0.055, 0.75, 3.5);
      this.root.scale.setScalar(scale);
    }
    if (this.hudRoot.visible && nowMs >= this.statusExpiresAtMs) this.hudRoot.visible = false;
    if (!this.hudRoot.visible) return;
    const position = camera.getWorldPosition(new THREE.Vector3());
    const orientation = camera.getWorldQuaternion(new THREE.Quaternion());
    const forward = new THREE.Vector3(0, 0, -1).applyQuaternion(orientation);
    const down = new THREE.Vector3(0, -1, 0).applyQuaternion(orientation);
    // Keep the short Pin notice below the Voice Relay card, whose centre is
    // 0.24 m down, so simultaneous status surfaces remain independently legible.
    this.hudRoot.position.copy(position).addScaledVector(forward, 1.05).addScaledVector(down, 0.47);
    this.hudRoot.quaternion.copy(orientation);
    this.hudRoot.updateMatrixWorld(true);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.root.removeFromParent();
    this.hudRoot.removeFromParent();
    for (const geometry of this.ownedGeometries.splice(0)) geometry.dispose();
    for (const material of this.ownedMaterials.splice(0)) material.dispose();
    for (const texture of this.ownedTextures.splice(0)) texture.dispose();
    this.root.clear();
    this.hudRoot.clear();
    this.root.visible = false;
    this.hudRoot.visible = false;
    delete this.root.userData.pinId;
    delete this.root.userData.workspacePositionM;
    this.labelCanvas.width = 1;
    this.labelCanvas.height = 1;
    this.statusCanvas.width = 1;
    this.statusCanvas.height = 1;
    this.pin = undefined;
    this.statusExpiresAtMs = 0;
  }

  private drawLabel(pin: XRSpatialPin): void {
    const context = this.labelCanvas.getContext("2d");
    if (!context) {
      this.labelMaterial.color.set(0xffc96b);
      return;
    }
    this.labelMaterial.color.set(0xffffff);
    context.clearRect(0, 0, LABEL_WIDTH, LABEL_HEIGHT);
    context.fillStyle = "rgba(5, 10, 17, .94)";
    context.fillRect(4, 4, LABEL_WIDTH - 8, LABEL_HEIGHT - 8);
    context.strokeStyle = "#ffc96b";
    context.lineWidth = 8;
    context.strokeRect(4, 4, LABEL_WIDTH - 8, LABEL_HEIGHT - 8);
    context.fillStyle = "#ffc96b";
    context.font = "700 52px Inter, system-ui, sans-serif";
    context.fillText(`P-${String(pin.pinSequence).padStart(2, "0")}`, 34, 76);
    context.fillStyle = "#eef6ff";
    context.font = "600 42px ui-monospace, SFMono-Regular, Menlo, monospace";
    const point = pin.workspacePositionM;
    context.fillText(
      `X ${formatCoordinate(point.x)}   Y ${formatCoordinate(point.y)}   Z ${formatCoordinate(point.z)} m`,
      34,
      148,
    );
    context.fillStyle = "#9fb5c9";
    context.font = "500 25px Inter, system-ui, sans-serif";
    context.fillText("Workspace world · display rounded only · A/X replace · B/Y clear", 34, 194);
    this.labelTexture.needsUpdate = true;
  }

  private showStatus(message: string, color: string, durationMs: number): void {
    if (this.disposed) return;
    const context = this.statusCanvas.getContext("2d");
    if (context) {
      this.statusMaterial.color.set(0xffffff);
      context.clearRect(0, 0, STATUS_WIDTH, STATUS_HEIGHT);
      context.fillStyle = "rgba(5, 10, 17, .92)";
      context.fillRect(4, 4, STATUS_WIDTH - 8, STATUS_HEIGHT - 8);
      context.strokeStyle = color;
      context.lineWidth = 7;
      context.strokeRect(4, 4, STATUS_WIDTH - 8, STATUS_HEIGHT - 8);
      context.fillStyle = color;
      context.font = "650 38px Inter, system-ui, sans-serif";
      context.textAlign = "center";
      context.textBaseline = "middle";
      context.fillText(message.slice(0, 92), STATUS_WIDTH / 2, STATUS_HEIGHT / 2);
      this.statusTexture.needsUpdate = true;
    } else this.statusMaterial.color.set(color);
    this.statusExpiresAtMs = Date.now() + durationMs;
    this.hudRoot.visible = true;
  }
}

function formatCoordinate(value: number): string {
  const normalized = Math.abs(value) < 0.0005 ? 0 : value;
  return normalized.toFixed(3);
}
