import type { WorkspaceRenderSnapshot } from "../../workspace/renderer/contracts";
import type { WorkspaceOperation } from "../../workspace/protocol/workspaceTypes";
import type { RenderPresentationContext } from "../../renderer/materialization";
import type { ThreeRendererXRSpatialPinEvent } from "../../renderer/ThreeRenderer";
import type {
  ThreeRendererXRPanelAction,
  ThreeRendererXRPanelWarning,
  ThreeRendererXRPushToTalkEvent,
  ThreeRendererXRVoiceFeedback,
  ThreeRendererXRVoiceHapticCue,
} from "../../renderer/xr";
import type { XrWorkspaceProjection } from "../authority";
import type { XrAssetDigest, XrAssetFormat } from "../assets";
import type {
  XRContextEnvelope,
  XRRuntimeCapabilities,
  XRSessionRequest,
  XRSpatialContextSnapshot,
} from "../client";
import type { XrRenderProfile } from "../ultra";
import type { UltraLocalEvidencePort } from "../ultra";
import type { XRPanelModel, XRPanelPresentation } from "../panels";
import type {
  XrDeltaMessage,
  XrEphemeralMessage,
  XrErrorMessage,
  XrInputMessage,
  XrReconnectCursor,
  XrSnapshotMessage,
  XrViewerPresencePhase,
} from "../protocol";
import type { XrSpeechOutputPort, XrVoiceCuePort } from "../speech";
import type { VoiceRelayRuntimePort } from "../../voice-relay";

/** Messages the renderer role is allowed to consume from the authority. */
export type XrViewerIncomingMessage =
  | XrSnapshotMessage
  | XrDeltaMessage
  | XrEphemeralMessage
  | XrErrorMessage;

export type XrViewerSessionIdentity = Readonly<{
  sessionId: string;
  authorityEpoch: string;
  workspaceId: string;
}>;

export type XrViewerDisconnect = Readonly<{
  reason: string;
  retryable: boolean;
}>;

/**
 * A reconnect response is one atomic replica transaction. In particular, a
 * full snapshot may deliberately replace a locally newer but divergent
 * replica, while a failed snapshot/delta chain must leave the prior replica
 * untouched.
 */
export type XrViewerReconnectDelivery = Readonly<{
  kind: "current" | "deltas" | "full_snapshot";
  messages: readonly XrViewerIncomingMessage[];
}>;

export type XrViewerReconnectOptions = Readonly<{
  signal?: AbortSignal;
  applyDelivery?(delivery: XrViewerReconnectDelivery): void | Promise<void>;
}>;

export interface XrViewerTransportSession {
  readonly identity: XrViewerSessionIdentity;
  /** Present only on a supported Windows browser; credentials remain inside the transport. */
  readonly ultraEvidence?: UltraLocalEvidencePort;
  /** Optional paired-session Voice Relay port. Its renderer credential remains inside the transport. */
  readonly voiceRelay?: VoiceRelayRuntimePort;
  send(message: XrInputMessage, options?: Readonly<{ signal?: AbortSignal }>): Promise<void>;
  /** Publishes only the reserved lifecycle channel; transport credentials and provenance remain private. */
  publishPresence?(
    phase: XrViewerPresencePhase,
    revision: number,
    options?: Readonly<{ signal?: AbortSignal }>,
  ): Promise<void>;
  /** Reuses opaque credentials retained by the transport; the pairing token is never reused. */
  reconnect(
    cursor: XrReconnectCursor | undefined,
    options?: XrViewerReconnectOptions,
  ): Promise<void>;
  /**
   * Reads an immutable, content-addressed asset with credentials retained
   * privately by the transport. No bearer/session secret crosses this port.
   */
  openAsset?(
    digest: XrAssetDigest,
    format: XrAssetFormat,
    byteLength: number,
    signal?: AbortSignal,
  ): Promise<Blob>;
  close(reason?: string): void | Promise<void>;
}

type XrViewerPairCredential =
  | Readonly<{
    /** Opaque single-use secret supplied only by a scrubbed deep link. */
    pairingToken: string;
    pairingCode?: never;
  }>
  | Readonly<{
    /** Human-enterable single-use alias containing exactly six decimal digits. */
    pairingCode: string;
    pairingToken?: never;
  }>;

export type XrViewerPairRequest = XrViewerPairCredential & Readonly<{
  /** Implementations must not retain either pairing credential after pair() settles. */
  signal: AbortSignal;
  /** Transports call message/disconnect callbacks only after pair() resolves. */
  onMessage(message: XrViewerIncomingMessage): unknown | Promise<unknown>;
  /** Optional atomic path for initial/reconnect snapshot and delta batches. */
  onReconnectDelivery?(delivery: XrViewerReconnectDelivery): unknown | Promise<unknown>;
  onDisconnected(event: XrViewerDisconnect): void;
}>;

/** Network-neutral port. HTTP, WebSocket, and native relays can implement the same boundary. */
export interface XrViewerTransportPort {
  pair(request: XrViewerPairRequest): Promise<XrViewerTransportSession>;
}

export type XrViewerRendererCallbacks = Readonly<{
  onSelect(componentId: string | null): void;
  onActivate(componentId: string): void;
  onPanelAction(event: ThreeRendererXRPanelAction): void;
  onPanelWarning(warning: ThreeRendererXRPanelWarning): void;
  onPushToTalk(event: ThreeRendererXRPushToTalkEvent): void;
  onSpatialPinChange(event: ThreeRendererXRSpatialPinEvent): void;
  onError(error: unknown): void;
}>;

export type XrViewerRendererServices = Readonly<{
  openRealityAsset(
    assetId: string,
    digest: string,
    signal?: AbortSignal,
  ): Promise<Blob | undefined>;
}>;

/** Renderer boundary used by the standalone React surface and its simulator tests. */
export interface XrViewerRendererPort {
  initialize(container: HTMLElement): Promise<void>;
  render(
    snapshot: WorkspaceRenderSnapshot,
    operations?: readonly WorkspaceOperation[],
    presentation?: RenderPresentationContext,
  ): Promise<void>;
  enterXR(session: XRSession, config?: Readonly<{
    referenceSpaceType?: "local" | "local-floor" | "bounded-floor";
    framebufferScaleFactor?: number;
    foveation?: number;
    targetFrameRateHz?: number;
    teleport?: boolean;
  }>): Promise<void>;
  exitXR(): Promise<void>;
  isXRPresenting(): boolean;
  /** Optional so injected simulator/test renderers remain source-compatible. */
  setXRWorldPanels?(
    panels: readonly XrWorldPanelPresentation[],
    workspaceRevision: number,
  ): void;
  /** Captures live head/controller/capsule facts for a final voice intent. */
  captureXRSpatialContext?(): XRSpatialContextSnapshot | undefined;
  setXRVoiceFeedback?(feedback: ThreeRendererXRVoiceFeedback): void;
  pulseXRVoiceHaptics?(cue: ThreeRendererXRVoiceHapticCue): void;
  dispose(): void;
}

export type XrViewerRendererFactory = (
  callbacks: XrViewerRendererCallbacks,
  renderProfile: XrRenderProfile,
  services: XrViewerRendererServices,
) => XrViewerRendererPort;

export interface XrViewerWebXRSessionPort {
  readonly id: string;
  readonly mode: "immersive-vr" | "immersive-ar";
  readonly referenceSpace: "local" | "local-floor" | "bounded-floor" | "unbounded";
  readonly rawSession: XRSession;
  end(): Promise<void>;
  onEnded(listener: (reason: string) => void): () => void;
}

/** WebXRRuntimeAdapter conforms to this narrower, injectable viewer port. */
export interface XrViewerWebXRRuntimePort {
  probe(): Promise<XRRuntimeCapabilities>;
  requestSession(request: XRSessionRequest): Promise<XrViewerWebXRSessionPort>;
}

export type XrViewerSpeechPartial = Readonly<{ text: string; sequence: number }>;
export type XrViewerSpeechFinal = Readonly<{ text: string; sequence: number }>;

export interface XrViewerSpeechCapturePort {
  finish(): Promise<XrViewerSpeechFinal>;
  cancel(reason?: string): void | Promise<void>;
}

/** Provider-neutral speech-to-text capture. Audio never enters Workspace state. */
export interface XrViewerSpeechPort {
  begin(request: Readonly<{
    utteranceId: string;
    signal: AbortSignal;
    onPartial(partial: XrViewerSpeechPartial): void;
  }>): Promise<XrViewerSpeechCapturePort>;
}

export type XrViewerSpeechOutputPort = XrSpeechOutputPort;
export type XrViewerVoiceCuePort = XrVoiceCuePort;
export type XrViewerVoiceRelayPort = VoiceRelayRuntimePort;

export type XrViewerContextFactory = (input: Readonly<{
  projection: XrWorkspaceProjection;
  selectedComponentId?: string;
  immersive: boolean;
}>) => XRContextEnvelope;

export type XrWorldPanelTransform = Readonly<{
  position: Readonly<{ x: number; y: number; z: number }>;
  rotation: Readonly<{ x: number; y: number; z: number }>;
  scale: Readonly<{ x: number; y: number; z: number }>;
}>;

/** A renderer-neutral DTO for a future mesh/canvas/layer implementation in immersive space. */
export type XrWorldPanelPresentation = Readonly<{
  format: "semaframe-xr-world-panel";
  version: "1.0";
  rendererNeutral: true;
  workspaceRevision: number;
  sourcePlacementSpace: string;
  transform: XrWorldPanelTransform;
  panel: XRPanelPresentation;
}>;

export type XrViewerPanelModelFactory = (
  projection: XrWorkspaceProjection,
) => readonly XRPanelModel[];
