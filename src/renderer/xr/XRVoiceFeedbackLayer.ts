import * as THREE from "three";

export type ThreeRendererXRPushToTalkEvent = Readonly<{
  phase: "pressed" | "released" | "cancelled" | "confirmed" | "replay";
  input: "controller" | "hand";
  handedness: "left" | "right" | "none";
}>;

export type ThreeRendererXRVoiceFeedback = Readonly<{
  phase:
    | "hidden"
    | "ready"
    | "listening"
    | "processing"
    | "awaiting_confirmation"
    | "sending"
    | "waiting_response"
    | "speaking"
    | "sent"
    | "error";
  message?: string;
  subtitle?: string;
  targetLabel?: string;
  actions?: readonly ("confirm" | "cancel" | "stop" | "replay")[];
}>;

export type ThreeRendererXRVoiceHapticCue =
  | "listen_start"
  | "listen_stop"
  | "draft_ready"
  | "sent"
  | "reply_ready"
  | "error";

const COLORS: Record<Exclude<ThreeRendererXRVoiceFeedback["phase"], "hidden">, string> = {
  ready: "#68d5ff",
  listening: "#ff6f7d",
  processing: "#ffc96b",
  awaiting_confirmation: "#68d5ff",
  sending: "#ffc96b",
  waiting_response: "#ffc96b",
  speaking: "#9e8cff",
  sent: "#72dea1",
  error: "#ff8d83",
};

const LABELS: Record<Exclude<ThreeRendererXRVoiceFeedback["phase"], "hidden">, string> = {
  ready: "Hold grip or pinch to talk",
  listening: "Listening… release to stage",
  processing: "Processing voice…",
  awaiting_confirmation: "Draft ready · Right pinch/Trigger to send · Left pinch/B to cancel",
  sending: "Sending once…",
  waiting_response: "Waiting for Agent reply…",
  speaking: "Reading Agent reply… · B to stop",
  sent: "Voice intent sent",
  error: "Voice unavailable",
};

/** Head-following, renderer-only status card; it never enters Workspace state. */
export class XRVoiceFeedbackLayer {
  readonly root = new THREE.Group();
  private readonly canvas: HTMLCanvasElement;
  private readonly texture: THREE.CanvasTexture;
  private readonly material: THREE.MeshBasicMaterial;
  private feedback: ThreeRendererXRVoiceFeedback = Object.freeze({ phase: "hidden" });

  constructor(documentValue: Document = document) {
    this.root.name = "semaframe-xr-voice-feedback";
    this.root.visible = false;
    this.canvas = documentValue.createElement("canvas");
    this.canvas.width = 768;
    this.canvas.height = 240;
    this.texture = new THREE.CanvasTexture(this.canvas);
    this.texture.colorSpace = THREE.SRGBColorSpace;
    this.texture.minFilter = THREE.LinearFilter;
    this.material = new THREE.MeshBasicMaterial({
      map: this.texture,
      transparent: true,
      depthTest: false,
      depthWrite: false,
      side: THREE.DoubleSide,
    });
    const mesh = new THREE.Mesh(new THREE.PlaneGeometry(0.86, 0.27), this.material);
    mesh.name = "semaframe-xr-voice-feedback-card";
    mesh.renderOrder = 10_000;
    mesh.raycast = () => undefined;
    this.root.add(mesh);
  }

  setFeedback(feedback: ThreeRendererXRVoiceFeedback): void {
    this.feedback = Object.freeze({ ...feedback });
    this.root.userData.phase = feedback.phase;
    this.root.userData.message = feedback.message;
    this.root.userData.subtitle = feedback.subtitle;
    this.root.userData.targetLabel = feedback.targetLabel;
    this.root.userData.actions = feedback.actions ? [...feedback.actions] : undefined;
    this.root.visible = feedback.phase !== "hidden";
    if (feedback.phase === "hidden") return;
    const context = this.canvas.getContext("2d");
    if (!context) {
      this.material.color.set(COLORS[feedback.phase]);
      return;
    }
    this.material.color.set(0xffffff);
    context.clearRect(0, 0, this.canvas.width, this.canvas.height);
    context.fillStyle = "rgba(5, 10, 17, .92)";
    context.beginPath();
    context.roundRect(4, 4, this.canvas.width - 8, this.canvas.height - 8, 28);
    context.fill();
    context.strokeStyle = COLORS[feedback.phase];
    context.lineWidth = 6;
    context.stroke();
    context.fillStyle = COLORS[feedback.phase];
    context.beginPath();
    context.arc(58, 70, 18, 0, Math.PI * 2);
    context.fill();
    context.fillStyle = "#eef6ff";
    context.font = "600 34px Inter, system-ui, sans-serif";
    context.textBaseline = "alphabetic";
    context.fillText((feedback.message ?? LABELS[feedback.phase]).slice(0, 80), 100, 80);
    const subtitle = feedback.subtitle?.trim();
    if (subtitle) {
      context.fillStyle = "#b9cadb";
      context.font = "500 25px Inter, system-ui, sans-serif";
      context.fillText(subtitle.slice(0, 106), 36, 135);
    }
    const target = feedback.targetLabel?.trim();
    const actionLabel = feedback.actions?.length
      ? feedback.actions.map((action) => action === "confirm"
        ? "Right pinch/Trigger: Send"
        : action === "cancel"
          ? "Left pinch/B: Cancel"
          : action === "stop"
            ? "Pinch/B: Stop"
            : "Right pinch/Trigger: Replay").join("  ·  ")
      : undefined;
    const footer = [target ? `Target: ${target}` : undefined, actionLabel].filter(Boolean).join("  ·  ");
    if (footer) {
      context.fillStyle = COLORS[feedback.phase];
      context.font = "600 22px Inter, system-ui, sans-serif";
      context.fillText(footer.slice(0, 118), 36, 195);
    }
    this.texture.needsUpdate = true;
  }

  /** Keep the card one metre ahead of the live HMD pose in render coordinates. */
  updatePose(camera: THREE.Camera): void {
    if (!this.root.visible) return;
    const position = camera.getWorldPosition(new THREE.Vector3());
    const orientation = camera.getWorldQuaternion(new THREE.Quaternion());
    const forward = new THREE.Vector3(0, 0, -1).applyQuaternion(orientation);
    const down = new THREE.Vector3(0, -1, 0).applyQuaternion(orientation);
    this.root.position.copy(position).addScaledVector(forward, 1).addScaledVector(down, 0.24);
    this.root.quaternion.copy(orientation);
    this.root.updateMatrixWorld(true);
  }

  getFeedback(): ThreeRendererXRVoiceFeedback {
    return this.feedback;
  }

  dispose(): void {
    this.root.removeFromParent();
    this.root.traverse((object) => {
      if (object instanceof THREE.Mesh) object.geometry.dispose();
    });
    this.material.dispose();
    this.texture.dispose();
    this.root.clear();
  }
}
