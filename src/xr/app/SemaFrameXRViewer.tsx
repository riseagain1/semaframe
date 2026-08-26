import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type FormEvent,
} from "react";
import { ThreeComponentRenderer } from "../../workspace/renderer/ThreeComponentRenderer";
import type { RenderPresentationContext } from "../../renderer/materialization";
import {
  parseXrInputResult,
  type XrPanelConfirmationChallenge,
  type XrWorkspaceProjection,
} from "../authority";
import { BrowserXrAssetCache } from "../assets";
import {
  createXRContextEnvelope,
  type XRContextEnvelope,
} from "../client";
import {
  VoiceRelayStateMachine,
  type VoiceRelayStageReceipt,
  type VoiceRelayStatus,
  type VoiceRelayUiEvent,
  type VoiceRelayUiState,
} from "../../voice-relay";
import {
  BrowserSpeechSynthesisAdapter,
  BrowserVoiceCueAdapter,
  XrBrowserSpeechSynthesisError,
  type XrVoiceCue,
} from "../speech";
import type { XRPanelModel, XRPanelTypedAction } from "../panels";
import {
  XR_SESSION_CONTROL_CHANNEL,
  type XrEphemeralMessage,
  type XrInputType,
  type XrJsonObject,
  type XrViewerPresencePhase,
} from "../protocol";
import { WebXRRuntimeAdapter } from "../webxr";
import {
  UltraLocalActivationController,
  ultraLocalEvidencePortFromHost,
  type UltraLocalActivationSnapshot,
  type UltraLocalEvidencePort,
  type XrRenderProfile,
} from "../ultra";
import type {
  XrViewerContextFactory,
  XrViewerRendererCallbacks,
  XrViewerRendererFactory,
  XrViewerRendererPort,
  XrViewerReconnectDelivery,
  XrViewerSpeechCapturePort,
  XrViewerSpeechOutputPort,
  XrViewerSpeechPort,
  XrViewerVoiceCuePort,
  XrViewerVoiceRelayPort,
  XrViewerTransportPort,
  XrViewerTransportSession,
  XrViewerWebXRRuntimePort,
  XrWorldPanelPresentation,
} from "./contracts";

import { deriveXrViewerPanelModels, presentXrWorldPanels } from "./panels";
import { createXrViewerInputMessage, XrViewerProjectionReplica } from "./projectionReplica";
import { XrViewerRealityAssetRuntime } from "./realityAssets";
import { XrPanelFallback } from "./XrPanelFallback";

/**
 * Agent-facing pose snapshots are intentionally lower-frequency than render
 * frames, but fast enough to describe deliberate head/hand motion. Slow
 * transports coalesce to one latest follow-up instead of building a backlog.
 */
export const XR_USER_STATE_PUBLISH_INTERVAL_MS = 250;

export type XrViewerConnectionPhase =
  | "unpaired"
  | "pairing"
  | "connected"
  | "disconnected"
  | "reconnecting"
  | "error";

export type XrViewerImmersivePhase = "probing" | "unavailable" | "ready" | "entering" | "active" | "exiting" | "failed";
export type XrViewerVoicePhase =
  | "off"
  | "checking"
  | "idle"
  | "starting"
  | "listening"
  | "transcribing"
  | "staging"
  | "awaiting_confirmation"
  | "finalizing"
  | "sending"
  | "waiting_response"
  | "reply_ready"
  | "speaking"
  | "send_outcome_unknown"
  | "sent"
  | "failed";

export type SemaFrameXRViewerProps = Readonly<{
  transport: XrViewerTransportPort;
  /** Optional token parsed by an entrypoint from a pairing URL. It is never rendered or copied into state. */
  initialPairingToken?: string;
  /** Must synchronously remove the token from history/address state before network pairing begins. */
  scrubPairingToken(): void;
  rendererFactory?: XrViewerRendererFactory;
  webXRRuntime?: XrViewerWebXRRuntimePort;
  speech?: XrViewerSpeechPort;
  /** Optional fallback for text-only Agents. Runtime status remains off by default. */
  voiceRelay?: XrViewerVoiceRelayPort;
  speechOutput?: XrViewerSpeechOutputPort;
  voiceCues?: XrViewerVoiceCuePort;
  readVoiceRelayRepliesAloud?: boolean;
  getXRContext?: XrViewerContextFactory;
  getPanelModels?: (projection: XrWorkspaceProjection) => readonly XRPanelModel[];
  onWorldPanelsChanged?: (panels: readonly XrWorldPanelPresentation[]) => void;
  requestIdFactory?: () => string;
  /** Function-valued local/native evidence bridge. Raw receipts are never accepted. */
  ultraEvidence?: UltraLocalEvidencePort;
  confirmUltraActivation?: () => boolean;
  /** Optional bounded cache injection for embedded runtimes and deterministic tests. */
  assetCache?: BrowserXrAssetCache;
}>;

const buttonStyle: CSSProperties = {
  border: "1px solid rgba(137, 177, 215, .38)",
  borderRadius: 10,
  padding: "9px 13px",
  background: "#132338",
  color: "#eef6ff",
  fontWeight: 650,
};

function defaultId(): string {
  return globalThis.crypto?.randomUUID?.()
    ?? `viewer-${Date.now().toString(36)}-${(++defaultId.counter).toString(36)}`;
}
defaultId.counter = 0;

function pairingCredentialIsValid(
  kind: "pairingToken" | "pairingCode",
  value: string,
): boolean {
  return kind === "pairingToken"
    ? /^[A-Za-z0-9_-]{43}$/u.test(value)
    : /^[0-9]{6}$/u.test(value);
}

function safeMessage(cause: unknown, secret?: string): string {
  let message = cause instanceof Error ? cause.message : "The XR operation failed.";
  if (secret) message = message.replaceAll(secret, "[pairing secret]");
  return message.slice(0, 500) || "The XR operation failed.";
}

function waitWithAbort(durationMs: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise((resolve, reject) => {
    const timer = globalThis.setTimeout(() => {
      signal.removeEventListener("abort", abort);
      resolve();
    }, durationMs);
    const abort = () => {
      globalThis.clearTimeout(timer);
      signal.removeEventListener("abort", abort);
      reject(signal.reason);
    };
    signal.addEventListener("abort", abort, { once: true });
  });
}

function relayError(cause: unknown): Readonly<{ code: string; message: string; recoverable: boolean }> {
  const value = cause as Readonly<{ code?: unknown; message?: unknown; recoverable?: unknown }> | null;
  return Object.freeze({
    code: typeof value?.code === "string" ? value.code.slice(0, 120) : "voice_relay_failed",
    message: safeMessage(cause),
    recoverable: typeof value?.recoverable === "boolean" ? value.recoverable : true,
  });
}

function defaultRendererFactory(
  callbacks: Parameters<XrViewerRendererFactory>[0],
  openRealityAsset: (
    assetId: string,
    digest: string,
    signal?: AbortSignal,
  ) => Promise<Blob | undefined>,
  renderProfile: XrRenderProfile,
): XrViewerRendererPort {
  return new ThreeComponentRenderer({
    onSelect: callbacks.onSelect,
    onActivate: callbacks.onActivate,
    onXRPanelAction: callbacks.onPanelAction,
    onXRPanelWarning: callbacks.onPanelWarning,
    onXRPushToTalk: callbacks.onPushToTalk,
    onXRSpatialPinChange: callbacks.onSpatialPinChange,
    openRealityAsset,
    shadows: renderProfile.shadows,
    expensiveLighting: renderProfile.expensiveLighting,
    pixelRatioCap: renderProfile.mode === "ultra" ? 2 : 1.25,
    onStatus: (status) => {
      if (status.kind === "error") callbacks.onError(new Error(status.message));
    },
  });
}

function defaultDesktopContext(
  projection: XrWorkspaceProjection,
  selectedComponentId: string | undefined,
): XRContextEnvelope {
  return createXRContextEnvelope({
    source: "desktop-simulator",
    workspaceId: projection.workspaceId,
    workspaceRevision: projection.revision,
    capturedAtMs: Math.max(0, Date.now()),
    referenceSpace: "local-floor",
    headPose: {
      position: { x: 0, y: 1.6, z: 0 },
      orientation: { x: 0, y: 0, z: 0, w: 1 },
    },
    trackedInputs: [],
    ...(selectedComponentId ? { selectedComponentId } : {}),
    playerCapsule: { feet: { x: 0, y: 0, z: 0 }, radius: 0.3, height: 1.8 },
  });
}

type ActiveSpeech = {
  abort: AbortController;
  utteranceId: string;
  capture?: XrViewerSpeechCapturePort;
};

type PendingInput = Readonly<{
  inputType: XrInputType;
  utteranceId?: string;
  panelId?: string;
  panelAction?: XRPanelTypedAction;
  panelConfirmationDecision?: "confirmed" | "declined";
}>;

type PendingPanelConfirmation = Readonly<{
  challenge: XrPanelConfirmationChallenge;
  panelId: string;
  action: XRPanelTypedAction;
  localExpiresAtMs: number;
  busy?: boolean;
}>;

type ViewerXRSession = Awaited<ReturnType<XrViewerWebXRRuntimePort["requestSession"]>>;

type ViewerXROwnership = Readonly<{
  session: ViewerXRSession;
  renderer: XrViewerRendererPort;
}>;

export function SemaFrameXRViewer(props: SemaFrameXRViewerProps) {
  const {
    transport,
    initialPairingToken,
    scrubPairingToken,
    speech,
    getXRContext,
    getPanelModels = deriveXrViewerPanelModels,
    onWorldPanelsChanged,
  } = props;
  const defaultSpeechOutput = useMemo(() => new BrowserSpeechSynthesisAdapter(), []);
  const speechOutput = props.speechOutput
    ?? (defaultSpeechOutput.probe().available ? defaultSpeechOutput : undefined);
  const defaultVoiceCues = useMemo(() => new BrowserVoiceCueAdapter(), []);
  const voiceCues = props.voiceCues ?? defaultVoiceCues;
  const requestIdFactory = props.requestIdFactory ?? defaultId;
  const [initialUltraEvidence] = useState<UltraLocalEvidencePort | undefined>(
    () => props.ultraEvidence ?? ultraLocalEvidencePortFromHost(),
  );
  const ultraEvidenceRef = useRef(initialUltraEvidence);
  const externallyConfiguredUltraEvidenceRef = useRef(initialUltraEvidence !== undefined);
  const ultraControllerRef = useRef(new UltraLocalActivationController(initialUltraEvidence));
  const ultraAbortRef = useRef<AbortController | undefined>(undefined);
  const [ultra, setUltra] = useState<UltraLocalActivationSnapshot>(ultraControllerRef.current.snapshot);
  const renderProfile = ultra.profile;
  const assetRuntime = useMemo(
    () => new XrViewerRealityAssetRuntime(props.assetCache),
    [props.assetCache],
  );
  const [pairingCodeInput, setPairingCodeInput] = useState("");
  const [connectionPhase, setConnectionPhase] = useState<XrViewerConnectionPhase>("unpaired");
  const [projection, setProjection] = useState<XrWorkspaceProjection>();
  const [selectedComponentId, setSelectedComponentId] = useState<string>();
  const [statusMessage, setStatusMessage] = useState("Enter the six-digit pairing code to begin.");
  const [errorMessage, setErrorMessage] = useState<string>();
  const [rendererReady, setRendererReady] = useState(false);
  const [immersivePhase, setImmersivePhase] = useState<XrViewerImmersivePhase>("probing");
  const [immersiveError, setImmersiveError] = useState<string>();
  const [voicePhase, setVoicePhase] = useState<XrViewerVoicePhase>("off");
  const [voiceText, setVoiceText] = useState("");
  const [voiceReply, setVoiceReply] = useState("");
  const [voiceRelayStatus, setVoiceRelayStatus] = useState<VoiceRelayStatus>();
  const [remoteExitRequested, setRemoteExitRequested] = useState(false);
  const [pendingPanelConfirmation, setPendingPanelConfirmation] = useState<PendingPanelConfirmation>();
  const [voiceRelayUi, setVoiceRelayUi] = useState<VoiceRelayUiState>(() => Object.freeze({
    phase: "off",
    enabled: false,
  }));
  const [sessionVoiceRelay, setSessionVoiceRelay] = useState<XrViewerVoiceRelayPort | undefined>(undefined);
  const voiceRelay = props.voiceRelay ?? sessionVoiceRelay;
  const [readRepliesAloud, setReadRepliesAloud] = useState(props.readVoiceRelayRepliesAloud ?? false);
  const [audibleVoiceCues, setAudibleVoiceCues] = useState(true);
  const pairingVisible = connectionPhase === "unpaired" || connectionPhase === "error";

  const inputRef = useRef<HTMLInputElement>(null);
  const rendererHostRef = useRef<HTMLDivElement>(null);
  const sessionRef = useRef<XrViewerTransportSession | undefined>(undefined);
  const replicaRef = useRef<XrViewerProjectionReplica | undefined>(undefined);
  const projectionRef = useRef<XrWorkspaceProjection | undefined>(undefined);
  const renderPresentationRef = useRef<RenderPresentationContext>({ delivery: "initial" });
  const connectionPhaseRef = useRef<XrViewerConnectionPhase>(connectionPhase);
  const rendererRef = useRef<XrViewerRendererPort | undefined>(undefined);
  const webXRSessionRef = useRef<ViewerXRSession | undefined>(undefined);
  const xrRendererOwnershipRef = useRef<ViewerXROwnership | undefined>(undefined);
  const xrLifecycleQueueRef = useRef<Promise<void>>(Promise.resolve());
  const xrTeardownRef = useRef<Readonly<{ session: ViewerXRSession; promise: Promise<void> }> | undefined>(undefined);
  const pendingEndedPresenceRef = useRef(false);
  const endedPresenceFlushRef = useRef<Promise<void> | undefined>(undefined);
  const immersiveVrAvailableRef = useRef(false);
  const removeXREndedRef = useRef<(() => void) | undefined>(undefined);
  const pairingAbortRef = useRef<AbortController | undefined>(undefined);
  const reconnectAbortRef = useRef<AbortController | undefined>(undefined);
  const activeSpeechRef = useRef<ActiveSpeech | undefined>(undefined);
  const voiceRelayStatusRef = useRef<VoiceRelayStatus | undefined>(undefined);
  const voiceRelayMachineRef = useRef(new VoiceRelayStateMachine());
  const voiceRelayStageRef = useRef<VoiceRelayStageReceipt | undefined>(undefined);
  const voiceRelayReplyAbortRef = useRef<AbortController | undefined>(undefined);
  const speechOutputAbortRef = useRef<AbortController | undefined>(undefined);
  const voiceRelayRef = useRef(voiceRelay);
  const speechOutputRef = useRef(speechOutput);
  const voiceCuesRef = useRef(voiceCues);
  const assetRuntimeRef = useRef(assetRuntime);
  const teardownXRSessionRef = useRef<((
    session: ViewerXRSession,
    rendererHint?: XrViewerRendererPort,
  ) => Promise<void>) | undefined>(undefined);
  const lastVoiceReplyRef = useRef("");
  const immersivePTTQueueRef = useRef<Promise<void>>(Promise.resolve());
  const consumedInitialRef = useRef(false);
  const aliveRef = useRef(true);
  const sessionGenerationRef = useRef(0);
  const messageQueueRef = useRef<Promise<void>>(Promise.resolve());
  const pendingInputsRef = useRef(new Map<string, PendingInput>());
  const handledInputResultsRef = useRef(new Set<string>());

  projectionRef.current = projection;
  connectionPhaseRef.current = connectionPhase;
  voiceRelayRef.current = voiceRelay;
  speechOutputRef.current = speechOutput;
  voiceCuesRef.current = voiceCues;
  assetRuntimeRef.current = assetRuntime;

  const publishSessionPresence = useCallback(async (phase: XrViewerPresencePhase): Promise<void> => {
    const currentSession = sessionRef.current;
    const currentProjection = projectionRef.current;
    if (!currentSession?.publishPresence || !currentProjection
      || connectionPhaseRef.current !== "connected") return;
    await currentSession.publishPresence(phase, currentProjection.revision);
  }, []);

  const flushPendingEndedPresence = useCallback((): Promise<void> => {
    if (!pendingEndedPresenceRef.current
      || webXRSessionRef.current
      || connectionPhaseRef.current !== "connected") return Promise.resolve();
    const existing = endedPresenceFlushRef.current;
    if (existing) return existing;
    const generation = sessionGenerationRef.current;
    const operation = publishSessionPresence("ended").then(() => {
      if (!aliveRef.current
        || generation !== sessionGenerationRef.current
        || connectionPhaseRef.current !== "connected"
        || webXRSessionRef.current) return;
      pendingEndedPresenceRef.current = false;
      setImmersivePhase("ready");
    }).finally(() => {
      if (endedPresenceFlushRef.current === operation) endedPresenceFlushRef.current = undefined;
    });
    endedPresenceFlushRef.current = operation;
    return operation;
  }, [publishSessionPresence]);

  useEffect(() => {
    setReadRepliesAloud(props.readVoiceRelayRepliesAloud ?? false);
  }, [props.readVoiceRelayRepliesAloud]);

  const enqueueXRLifecycle = useCallback((operation: () => Promise<void>): Promise<void> => {
    const result = xrLifecycleQueueRef.current.then(operation, operation);
    xrLifecycleQueueRef.current = result.catch(() => undefined);
    return result;
  }, []);

  /**
   * The only viewer-level XR teardown path. Renderer-owned sessions exit via
   * the renderer so ThreeRenderer can detach its WebXR manager first; sessions
   * which never reached the renderer are ended directly. Repeated runtime,
   * authority, UI, and unmount requests share one in-flight teardown.
   */
  const teardownXRSession = useCallback((
    session: ViewerXRSession,
    rendererHint?: XrViewerRendererPort,
  ): Promise<void> => {
    const existing = xrTeardownRef.current;
    if (existing?.session === session) return existing.promise;

    const teardown = enqueueXRLifecycle(async () => {
      const ownership = xrRendererOwnershipRef.current;
      const renderer = ownership?.session === session ? ownership.renderer : rendererHint;
      const rendererOwnsSession = ownership?.session === session;
      if (webXRSessionRef.current === session) {
        removeXREndedRef.current?.();
        removeXREndedRef.current = undefined;
      }
      try {
        if (rendererOwnsSession && renderer) await renderer.exitXR();
        else await session.end();
      } finally {
        if (xrRendererOwnershipRef.current?.session === session) {
          xrRendererOwnershipRef.current = undefined;
        }
        if (webXRSessionRef.current === session) webXRSessionRef.current = undefined;
      }
    });
    xrTeardownRef.current = Object.freeze({ session, promise: teardown });
    void teardown.then(() => {
      if (xrTeardownRef.current?.promise === teardown) xrTeardownRef.current = undefined;
    }, () => {
      if (xrTeardownRef.current?.promise === teardown) xrTeardownRef.current = undefined;
    });
    return teardown;
  }, [enqueueXRLifecycle]);
  teardownXRSessionRef.current = teardownXRSession;

  const installSessionUltraEvidence = useCallback((evidence: UltraLocalEvidencePort | undefined) => {
    if (!evidence || externallyConfiguredUltraEvidenceRef.current || ultraEvidenceRef.current === evidence) return;
    ultraAbortRef.current?.abort("ultra_evidence_replaced");
    ultraEvidenceRef.current = evidence;
    const controller = new UltraLocalActivationController(evidence);
    ultraControllerRef.current = controller;
    setUltra(controller.snapshot);
  }, []);

  const setSafeError = useCallback((cause: unknown, secret?: string) => {
    if (!aliveRef.current) return;
    setErrorMessage(safeMessage(cause, secret));
  }, []);

  useEffect(() => {
    if (connectionPhase !== "connected" || !pendingEndedPresenceRef.current) return;
    void flushPendingEndedPresence().catch(setSafeError);
  }, [connectionPhase, flushPendingEndedPresence, setSafeError]);

  const sendInput = useCallback(async (
    inputType: XrInputType,
    payload: XrJsonObject,
    expectApplicationResult = true,
  ): Promise<void> => {
    const session = sessionRef.current;
    const current = projectionRef.current;
    if (!session || !current || connectionPhaseRef.current !== "connected") {
      throw new Error("The XR viewer is not connected to a Workspace revision.");
    }
    const requestId = requestIdFactory();
    const pending: PendingInput = Object.freeze({
      inputType,
      ...(inputType === "voice_final" && typeof payload.utteranceId === "string"
        ? { utteranceId: payload.utteranceId }
        : {}),
      ...(inputType === "panel_action"
        && typeof payload.panelId === "string"
        && payload.action && typeof payload.action === "object" && !Array.isArray(payload.action)
        ? {
          panelId: payload.panelId,
          panelAction: payload.action as unknown as XRPanelTypedAction,
          ...(payload.confirmation && typeof payload.confirmation === "object"
            && !Array.isArray(payload.confirmation)
            && ((payload.confirmation as Readonly<Record<string, unknown>>).decision === "confirmed"
              || (payload.confirmation as Readonly<Record<string, unknown>>).decision === "declined")
            ? {
              panelConfirmationDecision: (
                payload.confirmation as Readonly<Record<string, unknown>>
              ).decision as "confirmed" | "declined",
            }
            : {}),
        }
        : {}),
    });
    const message = createXrViewerInputMessage({
      identity: session.identity,
      revision: current.revision,
      requestId,
      inputType,
      payload,
    });
    if (expectApplicationResult) {
      pendingInputsRef.current.set(requestId, pending);
      if (pendingInputsRef.current.size > 512) {
        const oldest = pendingInputsRef.current.keys().next().value as string | undefined;
        if (oldest) pendingInputsRef.current.delete(oldest);
      }
    }
    try {
      await session.send(message);
    } catch (cause) {
      // A retryable transport failure is ambiguous: the relay may have
      // committed the exact request before both bounded HTTP ACK attempts were
      // lost. Retain the pending identity so a reliable input.result replay can
      // still close the action after reconnect. Definitive/local rejection did
      // not commit and can be forgotten immediately.
      const mayHaveCommitted = typeof cause === "object"
        && cause !== null
        && "retryable" in cause
        && (cause as { retryable?: unknown }).retryable === true;
      if (expectApplicationResult && !mayHaveCommitted && pendingInputsRef.current.get(requestId) === pending) {
        pendingInputsRef.current.delete(requestId);
      }
      throw cause;
    }
  }, [requestIdFactory]);

  const handleInputResult = useCallback((message: XrEphemeralMessage) => {
    const result = parseXrInputResult(message);
    if (!result || handledInputResultsRef.current.has(result.inputRequestId)) return;
    const pending = pendingInputsRef.current.get(result.inputRequestId);
    if (!pending || pending.inputType !== result.inputType
      || (pending.utteranceId !== undefined && pending.utteranceId !== result.utteranceId)) return;

    pendingInputsRef.current.delete(result.inputRequestId);
    handledInputResultsRef.current.add(result.inputRequestId);
    if (handledInputResultsRef.current.size > 512) {
      const oldest = handledInputResultsRef.current.values().next().value as string | undefined;
      if (oldest) handledInputResultsRef.current.delete(oldest);
    }

    if (result.inputType === "panel_action"
      && result.code === "confirmation_required"
      && result.confirmationChallenge
      && pending.panelId
      && pending.panelAction
      && result.confirmationChallenge.panelId === pending.panelId
      && result.confirmationChallenge.workspaceRevision === pending.panelAction.expectedWorkspaceRevision
      && result.confirmationChallenge.targetComponentId === pending.panelAction.targetComponentId) {
      setPendingPanelConfirmation(Object.freeze({
        challenge: result.confirmationChallenge,
        panelId: pending.panelId,
        action: pending.panelAction,
        localExpiresAtMs: Date.now() + result.confirmationChallenge.expiresInMs,
      }));
      setErrorMessage(undefined);
      setStatusMessage("Confirm or decline this action inside the headset.");
      return;
    }

    if (result.inputType === "panel_action"
      && pending.panelConfirmationDecision === "declined"
      && result.code === "confirmation_denied") {
      setErrorMessage(undefined);
      setStatusMessage("The XR panel action was declined in the headset.");
      return;
    }

    const succeeded = result.status === "handled";
    const detail = result.message ?? (succeeded
      ? result.inputType === "voice_final"
        ? "XR voice command completed."
        : `XR action completed · ${result.code}`
      : `XR action was ${result.status} · ${result.code}`);
    if (result.inputType === "voice_final") {
      setVoicePhase(succeeded ? "sent" : "failed");
      setVoiceText(detail);
    }
    if (succeeded) {
      setErrorMessage(undefined);
      setStatusMessage(detail);
    } else {
      setErrorMessage(detail);
    }
  }, []);

  const openRealityAsset = useCallback(async (
    assetId: string,
    digest: string,
    signal?: AbortSignal,
  ): Promise<Blob | undefined> => {
    const session = sessionRef.current;
    const current = projectionRef.current;
    if (!session || !current) return undefined;
    return assetRuntime.open({
      session,
      projection: current,
      assetId,
      digest,
      budget: renderProfile.assetBudget,
      ...(signal ? { signal } : {}),
    });
  }, [assetRuntime, renderProfile.assetBudget]);

  const handleSelectRef = useRef<(componentId: string | null) => void>(() => undefined);
  const handleActivateRef = useRef<(componentId: string) => void>(() => undefined);
  const handlePanelActionRef = useRef<XrViewerRendererCallbacks["onPanelAction"]>(() => undefined);
  const handlePanelWarningRef = useRef<XrViewerRendererCallbacks["onPanelWarning"]>(() => undefined);
  const handlePushToTalkRef = useRef<XrViewerRendererCallbacks["onPushToTalk"]>(() => undefined);
  const publishSpatialContextRef = useRef<() => void>(() => undefined);
  const spatialContextPublishingRef = useRef(false);
  const spatialContextPublishPendingRef = useRef(false);
  handleSelectRef.current = (componentId) => {
    setSelectedComponentId(componentId ?? undefined);
    void sendInput("select", { componentId, source: "xr_viewer" }).catch(setSafeError);
  };
  handleActivateRef.current = (componentId) => {
    void sendInput("activate", { componentId, source: "xr_viewer" }).catch(setSafeError);
  };

  useEffect(() => {
    if (pairingVisible) return;
    aliveRef.current = true;
    const callbacks: XrViewerRendererCallbacks = {
      onSelect: (id) => handleSelectRef.current(id),
      onActivate: (id) => handleActivateRef.current(id),
      onPanelAction: (event) => handlePanelActionRef.current(event),
      onPanelWarning: (warning) => handlePanelWarningRef.current(warning),
      onPushToTalk: (event) => handlePushToTalkRef.current(event),
      onSpatialPinChange: () => publishSpatialContextRef.current(),
      onError: (error) => setSafeError(error),
    };
    const renderer = props.rendererFactory
      ? props.rendererFactory(callbacks, renderProfile, { openRealityAsset })
      : defaultRendererFactory(callbacks, openRealityAsset, renderProfile);
    rendererRef.current = renderer;
    const host = rendererHostRef.current;
    if (host) {
      void renderer.initialize(host).then(() => {
        if (aliveRef.current && rendererRef.current === renderer) setRendererReady(true);
      }).catch(setSafeError);
    }
    return () => {
      if (rendererRef.current === renderer) rendererRef.current = undefined;
      setRendererReady(false);
      const session = webXRSessionRef.current;
      const ownership = xrRendererOwnershipRef.current;
      const rendererOwnsSession = Boolean(ownership
        && ownership.session === session
        && ownership.renderer === renderer);
      if (session && rendererOwnsSession) {
        const teardown = teardownXRSession(session, renderer);
        void teardown.then(() => renderer.dispose(), () => renderer.dispose());
      } else {
        renderer.dispose();
      }
    };
  }, [openRealityAsset, pairingVisible, props.rendererFactory, renderProfile, setSafeError, teardownXRSession]);

  useEffect(() => {
    if (!rendererReady || !projection) return;
    let current = true;
    void rendererRef.current?.render(projection, [], renderPresentationRef.current).catch((cause) => {
      if (current) setSafeError(cause);
    });
    return () => { current = false; };
  }, [projection, rendererReady, setSafeError]);

  useEffect(() => {
    if (!rendererReady || !projection || connectionPhase !== "connected") return;
    if (immersivePhase === "exiting" && pendingEndedPresenceRef.current) return;
    const presence: XrViewerPresencePhase = immersivePhase === "active"
      ? "active"
      : immersivePhase === "entering"
        ? "immersive_entering"
        : immersivePhase === "exiting"
          ? "exiting"
          : "replica_ready";
    let stopped = false;
    const publish = () => {
      void publishSessionPresence(presence).catch((cause) => {
        if (!stopped) setSafeError(cause);
      });
    };
    publish();
    // Active is a server-authenticated lease, not a fact inferred from pose.
    // Heartbeats keep that lease fresh while WebXR owns the renderer.
    const interval = presence === "active"
      ? globalThis.setInterval(publish, 2_000)
      : undefined;
    return () => {
      stopped = true;
      if (interval !== undefined) globalThis.clearInterval(interval);
    };
  }, [connectionPhase, immersivePhase, projection, publishSessionPresence, rendererReady, setSafeError]);

  const applyIncoming = useCallback((input: unknown, generation: number): Promise<void> => {
    const application = messageQueueRef.current.then(async () => {
      if (generation !== sessionGenerationRef.current) return;
      const message = input as { messageType?: unknown; message?: unknown };
      if (message.messageType === "error") {
        throw new Error(typeof message.message === "string" ? message.message : "The XR relay reported an error.");
      }
      if (message.messageType === "ephemeral") {
        const ephemeral = input as XrEphemeralMessage;
        if (ephemeral.channel === XR_SESSION_CONTROL_CHANNEL) {
          const payload = ephemeral.payload as Readonly<Record<string, unknown>>;
          if (Object.keys(payload).length !== 1 || payload.action !== "request_exit") {
            throw new Error("The XR session-control request is invalid.");
          }
          setRemoteExitRequested(true);
          setStatusMessage("The desktop Agent requested XR exit. Use the visible Exit XR control when ready.");
          rendererRef.current?.setXRVoiceFeedback?.({
            phase: "ready",
            message: "Exit XR requested",
            subtitle: "Use the headset Exit XR control when ready. The Workspace will remain open.",
          });
          return;
        }
        handleInputResult(input as XrEphemeralMessage);
        return;
      }
      const result = await replicaRef.current?.apply(input);
      if (!result || !aliveRef.current || generation !== sessionGenerationRef.current) return;
      renderPresentationRef.current = message.messageType === "delta" && result.status === "applied"
        ? Object.freeze({
          delivery: "live_commit",
          batchKey: `${String((input as { authorityEpoch?: unknown }).authorityEpoch ?? "xr")}:${String((input as { requestId?: unknown }).requestId ?? "delta")}:${result.projection.revision}`,
        })
        : Object.freeze({ delivery: message.messageType === "snapshot" ? "initial" : "context_restore" });
      setProjection(result.projection);
      setStatusMessage(`Live Workspace · revision ${result.projection.revision}`);
    });
    // Keep the serializer usable after a rejected application, while returning
    // the actual rejection to the transport so it retains the unacknowledged
    // delivery and moves the viewer to a reconnectable checkpoint.
    messageQueueRef.current = application.catch(() => undefined);
    return application.catch((cause) => {
      setSafeError(cause);
      throw cause;
    });
  }, [handleInputResult, setSafeError]);

  const applyReconnectDelivery = useCallback((
    delivery: XrViewerReconnectDelivery,
    generation: number,
  ): Promise<void> => {
    const application = messageQueueRef.current.then(async () => {
      if (generation !== sessionGenerationRef.current) return;
      const replica = replicaRef.current;
      if (!replica) throw new Error("The XR replica is unavailable during reconnect.");
      const result = await replica.applyReconnect(delivery);
      if (!aliveRef.current || generation !== sessionGenerationRef.current) return;
      renderPresentationRef.current = Object.freeze({ delivery: "reconnect" });
      projectionRef.current = result.projection;
      setProjection(result.projection);
      setStatusMessage(`Live Workspace · revision ${result.projection.revision}`);
    });
    messageQueueRef.current = application.catch(() => undefined);
    return application.catch((cause) => {
      setSafeError(cause);
      throw cause;
    });
  }, [setSafeError]);

  const teardownVoiceSession = useCallback((reason: string, updateUi = true): Promise<void> => {
    const activeSpeech = activeSpeechRef.current;
    activeSpeechRef.current = undefined;
    activeSpeech?.abort.abort(reason);

    voiceRelayReplyAbortRef.current?.abort(reason);
    voiceRelayReplyAbortRef.current = undefined;
    speechOutputAbortRef.current?.abort(reason);
    speechOutputAbortRef.current = undefined;
    speechOutputRef.current?.stop(reason);
    voiceCuesRef.current?.stop?.();

    const staged = voiceRelayStageRef.current;
    const relay = voiceRelayRef.current;
    voiceRelayStageRef.current = undefined;
    lastVoiceReplyRef.current = "";
    voiceRelayStatusRef.current = undefined;
    voiceRelayMachineRef.current = new VoiceRelayStateMachine();

    if (updateUi && aliveRef.current) {
      setVoiceRelayStatus(undefined);
      setVoiceRelayUi(voiceRelayMachineRef.current.snapshot);
      setVoiceText("");
      setVoiceReply("");
      setVoicePhase("off");
    }

    const pending: Promise<unknown>[] = [];
    if (activeSpeech?.capture) {
      try {
        pending.push(Promise.resolve(activeSpeech.capture.cancel(reason)));
      } catch {
        // The abort signal is already revoked; capture teardown is best effort.
      }
    }
    if (staged && relay) pending.push(relay.cancel(staged.stageId).catch(() => undefined));
    return Promise.allSettled(pending).then(() => undefined);
  }, []);

  const returnToPairing = useCallback((reason: string, generation: number) => {
    if (!aliveRef.current || generation !== sessionGenerationRef.current) return;
    sessionGenerationRef.current += 1;
    const nextGeneration = sessionGenerationRef.current;
    pendingEndedPresenceRef.current = false;
    pairingAbortRef.current?.abort("session_expired");
    pairingAbortRef.current = undefined;
    reconnectAbortRef.current?.abort("session_expired");
    reconnectAbortRef.current = undefined;
    assetRuntime.clear();
    pendingInputsRef.current.clear();
    handledInputResultsRef.current.clear();
    const expiredSession = sessionRef.current;
    sessionRef.current = undefined;
    setSessionVoiceRelay(undefined);
    replicaRef.current = undefined;
    projectionRef.current = undefined;
    setProjection(undefined);
    setSelectedComponentId(undefined);
    setPendingPanelConfirmation(undefined);
    const voiceCleanup = teardownVoiceSession("session_expired");
    const activeXRSession = webXRSessionRef.current;
    const teardown = activeXRSession
      ? teardownXRSession(activeXRSession, rendererRef.current)
      : Promise.resolve();
    void (async () => {
      let timeout: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          voiceCleanup,
          new Promise<void>((resolve) => { timeout = setTimeout(resolve, 1_500); }),
        ]);
      } finally {
        if (timeout !== undefined) clearTimeout(timeout);
        await expiredSession?.close("fresh_pairing_required");
      }
    })().catch(() => undefined);
    connectionPhaseRef.current = "unpaired";
    if (activeXRSession) {
      setImmersivePhase("exiting");
      setStatusMessage("Ending the expired immersive session…");
    }
    setErrorMessage(safeMessage(new Error(reason)));
    void teardown.catch(() => undefined).then(() => {
      if (!aliveRef.current || sessionGenerationRef.current !== nextGeneration) return;
      setConnectionPhase("unpaired");
      setImmersivePhase(immersiveVrAvailableRef.current ? "ready" : "unavailable");
      setStatusMessage("The XR session ended. Enter a new six-digit pairing code.");
    });
  }, [assetRuntime, teardownVoiceSession, teardownXRSession]);

  const pairWithSecret = useCallback(async (
    rawSecret: string,
    credentialKind: "pairingToken" | "pairingCode",
  ) => {
    const generation = sessionGenerationRef.current + 1;
    sessionGenerationRef.current = generation;
    pendingEndedPresenceRef.current = false;
    let secret = rawSecret.trim();
    setPairingCodeInput("");
    if (inputRef.current) inputRef.current.value = "";
    if (credentialKind === "pairingToken") {
      try {
        scrubPairingToken();
      } catch {
        secret = "";
        setConnectionPhase("error");
        setStatusMessage("Pairing stopped.");
        setErrorMessage("The pairing link could not be cleared securely.");
        return;
      }
    }
    if (!pairingCredentialIsValid(credentialKind, secret)) {
      secret = "";
      setConnectionPhase("error");
      setStatusMessage("Pairing stopped.");
      setErrorMessage(credentialKind === "pairingCode"
        ? "Enter the complete six-digit pairing code."
        : "The one-time pairing link is invalid or expired.");
      return;
    }
    assetRuntime.clear();
    setPendingPanelConfirmation(undefined);
    pairingAbortRef.current?.abort("superseded");
    const abort = new AbortController();
    pairingAbortRef.current = abort;
    setConnectionPhase("pairing");
    setStatusMessage("Pairing securely…");
    setErrorMessage(undefined);
    try {
      const credential = credentialKind === "pairingToken"
        ? { pairingToken: secret } as const
        : { pairingCode: secret } as const;
      const session = await transport.pair({
        ...credential,
        signal: abort.signal,
        onMessage: (message) => applyIncoming(message, generation),
        onReconnectDelivery: (delivery) => applyReconnectDelivery(delivery, generation),
        onDisconnected: ({ reason, retryable }) => {
          if (!aliveRef.current || abort.signal.aborted || generation !== sessionGenerationRef.current) return;
          if (!retryable) {
            returnToPairing(reason || "A fresh pairing code is required.", generation);
            return;
          }
          connectionPhaseRef.current = "disconnected";
          setConnectionPhase("disconnected");
          setStatusMessage("Connection lost. Reconnect is available.");
          if (reason) setErrorMessage(safeMessage(new Error(reason), secret));
        },
      });
      secret = "";
      if (abort.signal.aborted || !aliveRef.current) {
        await session.close("pairing_cancelled");
        return;
      }
      const previousSession = sessionRef.current;
      sessionRef.current = session;
      setSessionVoiceRelay(session.voiceRelay);
      installSessionUltraEvidence(session.ultraEvidence);
      replicaRef.current = new XrViewerProjectionReplica(session.identity);
      connectionPhaseRef.current = "connected";
      setConnectionPhase("connected");
      setStatusMessage("Connected. Waiting for the authoritative snapshot…");
      if (previousSession && previousSession !== session) await previousSession.close("replaced");
    } catch (cause) {
      const redacted = safeMessage(cause, secret);
      secret = "";
      if (abort.signal.aborted || !aliveRef.current) return;
      connectionPhaseRef.current = "error";
      setConnectionPhase("error");
      setStatusMessage("Pairing failed.");
      setErrorMessage(redacted);
    }
  }, [
    applyIncoming,
    applyReconnectDelivery,
    assetRuntime,
    installSessionUltraEvidence,
    returnToPairing,
    scrubPairingToken,
    transport,
  ]);

  useLayoutEffect(() => {
    if (consumedInitialRef.current || !initialPairingToken) return;
    consumedInitialRef.current = true;
    void pairWithSecret(initialPairingToken, "pairingToken");
  }, [initialPairingToken, pairWithSecret]);

  const submitPairing = (event: FormEvent) => {
    event.preventDefault();
    void pairWithSecret(pairingCodeInput, "pairingCode");
  };

  const reconnect = useCallback(async () => {
    const session = sessionRef.current;
    if (!session) return;
    const generation = sessionGenerationRef.current;
    reconnectAbortRef.current?.abort("superseded");
    const abort = new AbortController();
    reconnectAbortRef.current = abort;
    connectionPhaseRef.current = "reconnecting";
    setConnectionPhase("reconnecting");
    setStatusMessage("Reconnecting to the authoritative Workspace…");
    setErrorMessage(undefined);
    try {
      await session.reconnect(replicaRef.current?.reconnectCursor(requestIdFactory()), {
        signal: abort.signal,
        applyDelivery: (delivery) => applyReconnectDelivery(delivery, generation),
      });
      if (abort.signal.aborted || !aliveRef.current || generation !== sessionGenerationRef.current) return;
      connectionPhaseRef.current = "connected";
      setConnectionPhase("connected");
      setStatusMessage(projectionRef.current
        ? `Live Workspace · revision ${projectionRef.current.revision}`
        : "Reconnected. Waiting for a snapshot…");
    } catch (cause) {
      if (abort.signal.aborted || !aliveRef.current || generation !== sessionGenerationRef.current) return;
      connectionPhaseRef.current = "disconnected";
      setConnectionPhase("disconnected");
      setStatusMessage("Reconnect failed.");
      setSafeError(cause);
    }
  }, [applyReconnectDelivery, requestIdFactory, setSafeError]);

  const webXRRuntime = useMemo<XrViewerWebXRRuntimePort>(
    () => props.webXRRuntime ?? new WebXRRuntimeAdapter(),
    [props.webXRRuntime],
  );

  const probeWebXR = useCallback(async () => {
    setImmersivePhase("probing");
    setImmersiveError(undefined);
    try {
      const capabilities = await webXRRuntime.probe();
      if (!aliveRef.current) return;
      immersiveVrAvailableRef.current = capabilities.available
        && capabilities.sessionModes.includes("immersive-vr");
      setImmersivePhase(immersiveVrAvailableRef.current ? "ready" : "unavailable");
    } catch (cause) {
      if (!aliveRef.current) return;
      immersiveVrAvailableRef.current = false;
      setImmersivePhase("failed");
      setImmersiveError(safeMessage(cause));
    }
  }, [webXRRuntime]);

  useEffect(() => {
    void probeWebXR();
  }, [webXRRuntime]);

  const enterXR = useCallback(async () => {
    if (!rendererReady || immersivePhase !== "ready") return;
    pendingEndedPresenceRef.current = false;
    const entryGeneration = sessionGenerationRef.current;
    setImmersivePhase("entering");
    setImmersiveError(undefined);
    let acquired: ViewerXRSession | undefined;
    try {
      // This is intentionally reachable only through this user-activated button handler.
      const session = await webXRRuntime.requestSession({
        mode: "immersive-vr",
        requiredFeatures: ["local-floor"],
        optionalFeatures: ["bounded-floor", "hand-tracking"],
      });
      acquired = session;
      let entered = false;
      await enqueueXRLifecycle(async () => {
        if (!aliveRef.current
          || entryGeneration !== sessionGenerationRef.current
          || connectionPhaseRef.current !== "connected") {
          await session.end().catch(() => undefined);
          acquired = undefined;
          return;
        }
        const verifiedProfile = await ultraControllerRef.current.profileForEntry();
        const nextUltra = ultraControllerRef.current.snapshot;
        if (nextUltra !== ultra) setUltra(nextUltra);
        if (verifiedProfile.mode !== renderProfile.mode) {
          await session.end().catch(() => undefined);
          acquired = undefined;
          throw new Error("The XR render profile changed during revalidation. Enter XR again with the safe profile.");
        }
        if (session.referenceSpace === "unbounded") {
          await session.end().catch(() => undefined);
          acquired = undefined;
          throw new Error("The runtime returned an unsupported unbounded reference space.");
        }
        const renderer = rendererRef.current;
        if (!renderer) throw new Error("The spatial renderer is not ready.");

        let runtimeEnded = false;
        webXRSessionRef.current = session;
        removeXREndedRef.current?.();
        removeXREndedRef.current = session.onEnded(() => {
          if (webXRSessionRef.current !== session) return;
          runtimeEnded = true;
          const endedGeneration = sessionGenerationRef.current;
          setImmersivePhase("exiting");
          void publishSessionPresence("exiting").catch(setSafeError);
          void teardownXRSession(session, renderer).then(async () => {
            if (!aliveRef.current || sessionGenerationRef.current !== endedGeneration) return;
            pendingEndedPresenceRef.current = true;
            await flushPendingEndedPresence().catch(setSafeError);
          }).catch((cause) => {
            if (!aliveRef.current || sessionGenerationRef.current !== endedGeneration) return;
            setImmersivePhase("failed");
            setImmersiveError(safeMessage(cause));
          });
        });
        await renderer.enterXR(session.rawSession, {
          referenceSpaceType: session.referenceSpace,
          framebufferScaleFactor: renderProfile.framebufferScaleFactor,
          foveation: renderProfile.foveation,
          targetFrameRateHz: renderProfile.targetFrameRateHz,
          teleport: true,
        });
        xrRendererOwnershipRef.current = Object.freeze({ session, renderer });
        if (runtimeEnded
          || !aliveRef.current
          || entryGeneration !== sessionGenerationRef.current
          || connectionPhaseRef.current !== "connected") return;
        entered = true;
      });
      if (!entered) {
        if (acquired && (webXRSessionRef.current === session
          || xrRendererOwnershipRef.current?.session === session)) {
          await teardownXRSession(session, rendererRef.current).catch(() => undefined);
        }
        return;
      }
      setImmersivePhase("active");
    } catch (cause) {
      if (acquired) await teardownXRSession(acquired, rendererRef.current).catch(() => undefined);
      if (!aliveRef.current
        || entryGeneration !== sessionGenerationRef.current
        || connectionPhaseRef.current !== "connected") return;
      setImmersivePhase("failed");
      setImmersiveError(safeMessage(cause));
    }
  }, [
    enqueueXRLifecycle,
    flushPendingEndedPresence,
    immersivePhase,
    publishSessionPresence,
    renderProfile,
    rendererReady,
    setSafeError,
    teardownXRSession,
    ultra,
    webXRRuntime,
  ]);

  const verifyUltra = useCallback(async () => {
    if (!ultraEvidenceRef.current
      || immersivePhase === "active"
      || immersivePhase === "entering"
      || immersivePhase === "exiting") return;
    ultraAbortRef.current?.abort("superseded");
    const abort = new AbortController();
    ultraAbortRef.current = abort;
    const needsProbe = ultraControllerRef.current.snapshot.phase === "unprobed";
    setUltra({
      ...ultraControllerRef.current.snapshot,
      phase: needsProbe ? "probing" : "benchmarking",
      message: needsProbe
        ? "Checking local Windows PCVR compatibility…"
        : "Preparing the confirmed physical Ultra benchmark…",
    });
    try {
      const snapshot = await ultraControllerRef.current.activate({
        signal: abort.signal,
        // The explicit second-stage "Start Ultra benchmark" button is the
        // confirmation. A modal here could consume WebXR transient activation.
        confirm: props.confirmUltraActivation ?? (() => true),
      });
      if (aliveRef.current && !abort.signal.aborted) setUltra(snapshot);
    } catch (cause) {
      if (aliveRef.current && !abort.signal.aborted) setUltra({
        phase: "locked",
        message: safeMessage(cause),
        profile: ultraControllerRef.current.snapshot.profile,
      });
    }
  }, [immersivePhase, props.confirmUltraActivation]);

  const exitXR = useCallback(async () => {
    const session = webXRSessionRef.current;
    if (!session) {
      setImmersivePhase("ready");
      return;
    }
    setImmersivePhase("exiting");
    setRemoteExitRequested(false);
    try {
      void publishSessionPresence("exiting").catch(setSafeError);
      await teardownXRSession(session, rendererRef.current);
      pendingEndedPresenceRef.current = true;
      await flushPendingEndedPresence().catch(setSafeError);
    } catch (cause) {
      if (!aliveRef.current) return;
      setImmersivePhase("failed");
      setImmersiveError(safeMessage(cause));
    }
  }, [flushPendingEndedPresence, publishSessionPresence, setSafeError, teardownXRSession]);

  const respondPanelConfirmation = useCallback(async (decision: "confirmed" | "declined") => {
    const pending = pendingPanelConfirmation;
    const current = projectionRef.current;
    if (!pending || pending.busy || !current
      || pending.localExpiresAtMs <= Date.now()
      || pending.challenge.workspaceRevision !== current.revision) {
      setPendingPanelConfirmation(undefined);
      setErrorMessage("This XR confirmation expired. Activate the original panel action again.");
      return;
    }
    setPendingPanelConfirmation(Object.freeze({ ...pending, busy: true }));
    try {
      await sendInput("panel_action", {
        panelId: pending.panelId,
        action: pending.action as unknown as XrJsonObject,
        confirmation: Object.freeze({
          challengeId: pending.challenge.challengeId,
          decision,
        }),
      });
      setPendingPanelConfirmation(undefined);
      setStatusMessage(decision === "confirmed"
        ? "XR confirmation sent to the authoritative Workspace."
        : "XR panel action declined.");
    } catch (cause) {
      setPendingPanelConfirmation(Object.freeze({ ...pending, busy: false }));
      setSafeError(cause);
    }
  }, [pendingPanelConfirmation, sendInput, setSafeError]);

  useEffect(() => {
    const pending = pendingPanelConfirmation;
    if (!pending) return;
    const delayMs = pending.localExpiresAtMs - Date.now();
    if (delayMs <= 0) {
      setPendingPanelConfirmation(undefined);
      return;
    }
    const timeout = globalThis.setTimeout(() => {
      setPendingPanelConfirmation((current) => current?.challenge.challengeId === pending.challenge.challengeId
        ? undefined
        : current);
    }, delayMs);
    return () => globalThis.clearTimeout(timeout);
  }, [pendingPanelConfirmation]);

  useEffect(() => {
    setPendingPanelConfirmation((pending) => pending
      && pending.challenge.workspaceRevision === projection?.revision
      ? pending
      : undefined);
  }, [projection?.revision]);

  const panelResult = useMemo(() => {
    if (!projection) return { panels: [] as readonly XrWorldPanelPresentation[] };
    try {
      const baseModels = getPanelModels(projection).slice(0, pendingPanelConfirmation ? 61 : 64);
      const basePanels = presentXrWorldPanels(projection, baseModels);
      if (!pendingPanelConfirmation) return { panels: basePanels };
      const prefix = `xr-confirmation:${pendingPanelConfirmation.challenge.challengeId}`;
      const action = pendingPanelConfirmation.action;
      const confirmationModels: readonly XRPanelModel[] = Object.freeze([
        Object.freeze({
          kind: "text" as const,
          panelId: `${prefix}:summary`,
          componentId: action.targetComponentId,
          title: "Confirm Workspace action",
          text: `Run “${action.actionName}” on “${action.targetComponentId}”? This one-use request expires shortly.`,
          tone: "warning" as const,
          dimensions: { widthM: 0.84, heightM: 0.28 },
        }),
        Object.freeze({
          kind: "button" as const,
          panelId: `${prefix}:confirm`,
          componentId: action.targetComponentId,
          title: "One-use confirmation",
          label: pendingPanelConfirmation.busy ? "Confirming…" : "Confirm once",
          state: pendingPanelConfirmation.busy ? "busy" as const : "enabled" as const,
          action,
          dimensions: { widthM: 0.38, heightM: 0.16 },
        }),
        Object.freeze({
          kind: "button" as const,
          panelId: `${prefix}:decline`,
          componentId: action.targetComponentId,
          title: "Decline action",
          label: "Not now",
          state: pendingPanelConfirmation.busy ? "disabled" as const : "enabled" as const,
          action,
          dimensions: { widthM: 0.38, heightM: 0.16 },
        }),
      ]);
      const positions = [
        { x: 0, y: 1.78, z: -1.45 },
        { x: -0.23, y: 1.43, z: -1.45 },
        { x: 0.23, y: 1.43, z: -1.45 },
      ] as const;
      const confirmationPanels = presentXrWorldPanels(projection, confirmationModels).map((panel, index) => Object.freeze({
        ...panel,
        sourcePlacementSpace: "viewer-confirmation",
        transform: Object.freeze({
          position: Object.freeze(positions[index]!),
          rotation: Object.freeze({ x: 0, y: 0, z: 0 }),
          scale: Object.freeze({ x: 1, y: 1, z: 1 }),
        }),
      }));
      return { panels: Object.freeze([...basePanels, ...confirmationPanels]) };
    } catch (cause) {
      return { panels: [] as readonly XrWorldPanelPresentation[], error: safeMessage(cause) };
    }
  }, [getPanelModels, pendingPanelConfirmation, projection]);

  useEffect(() => {
    onWorldPanelsChanged?.(panelResult.panels);
    const renderer = rendererRef.current;
    if (!rendererReady || !projection || !renderer?.setXRWorldPanels) return;
    try {
      renderer.setXRWorldPanels(panelResult.panels, projection.revision);
    } catch (cause) {
      setSafeError(cause);
    }
  }, [onWorldPanelsChanged, panelResult.panels, projection, rendererReady, setSafeError]);

  const invokePanelAction = useCallback(async (action: XRPanelTypedAction, panelId: string) => {
    const current = projectionRef.current;
    if (!current || action.expectedWorkspaceRevision !== current.revision) {
      setErrorMessage("This panel action belongs to an older Workspace revision. Wait for the panel to refresh.");
      return;
    }
    const pendingPrefix = pendingPanelConfirmation
      ? `xr-confirmation:${pendingPanelConfirmation.challenge.challengeId}`
      : undefined;
    if (pendingPrefix && panelId === `${pendingPrefix}:confirm`) {
      await respondPanelConfirmation("confirmed");
      return;
    }
    if (pendingPrefix && panelId === `${pendingPrefix}:decline`) {
      await respondPanelConfirmation("declined");
      return;
    }
    if (pendingPanelConfirmation && action.confirmation === "required") {
      setErrorMessage("Respond to the visible one-use confirmation before requesting another protected action.");
      return;
    }
    try {
      await sendInput("panel_action", {
        panelId,
        action: action as unknown as XrJsonObject,
      });
    } catch (cause) {
      setSafeError(cause);
    }
  }, [pendingPanelConfirmation, respondPanelConfirmation, sendInput, setSafeError]);

  handlePanelActionRef.current = (event) => {
    const current = projectionRef.current;
    if (!current || event.workspaceRevision !== current.revision) {
      setErrorMessage("This immersive panel belongs to an older Workspace revision. Wait for the panel to refresh.");
      return;
    }
    void invokePanelAction(event.action, event.panelId);
  };
  handlePanelWarningRef.current = (warning) => {
    setStatusMessage(`XR panel warning · ${warning.message}`);
  };

  const resolveVoiceContext = useCallback((current: XrWorkspaceProjection): XRContextEnvelope => {
    if (getXRContext) {
      return getXRContext({
        projection: current,
        ...(selectedComponentId ? { selectedComponentId } : {}),
        immersive: immersivePhase === "active",
      });
    }
    if (immersivePhase !== "active") return defaultDesktopContext(current, selectedComponentId);
    const spatial = rendererRef.current?.captureXRSpatialContext?.();
    if (!spatial) throw new Error("The immersive renderer could not capture a live spatial voice context.");
    return createXRContextEnvelope({
      source: "immersive-xr",
      workspaceId: current.workspaceId,
      workspaceRevision: current.revision,
      capturedAtMs: Math.max(0, Date.now()),
      ...spatial,
      ...(selectedComponentId ? { selectedComponentId } : {}),
    });
  }, [getXRContext, immersivePhase, selectedComponentId]);

  const publishSpatialContext = useCallback(async () => {
    if (spatialContextPublishingRef.current) {
      spatialContextPublishPendingRef.current = true;
      return;
    }
    if (immersivePhase !== "active"
      || connectionPhase !== "connected") return;
    const current = projectionRef.current;
    if (!current) return;
    spatialContextPublishingRef.current = true;
    try {
      const context = resolveVoiceContext(current);
      await sendInput("pose", { context: context as unknown as XrJsonObject }, false);
    } catch (cause) {
      setSafeError(cause);
    } finally {
      spatialContextPublishingRef.current = false;
      if (spatialContextPublishPendingRef.current) {
        spatialContextPublishPendingRef.current = false;
        globalThis.queueMicrotask(() => publishSpatialContextRef.current());
      }
    }
  }, [connectionPhase, immersivePhase, resolveVoiceContext, sendInput, setSafeError]);

  publishSpatialContextRef.current = () => { void publishSpatialContext(); };

  useEffect(() => {
    if (immersivePhase !== "active" || connectionPhase !== "connected" || !projection) return;
    let stopped = false;
    const publish = async () => {
      if (stopped) return;
      await publishSpatialContext();
    };
    void publish();
    const interval = globalThis.setInterval(() => { void publish(); }, XR_USER_STATE_PUBLISH_INTERVAL_MS);
    return () => {
      stopped = true;
      globalThis.clearInterval(interval);
    };
  }, [connectionPhase, immersivePhase, projection, publishSpatialContext]);

  const publishRelayEvent = useCallback((event: VoiceRelayUiEvent): VoiceRelayUiState => {
    const next = voiceRelayMachineRef.current.dispatch(event);
    setVoiceRelayUi(next);
    return next;
  }, []);

  const refreshVoiceRelay = useCallback(async (): Promise<VoiceRelayStatus | undefined> => {
    if (!voiceRelay) {
      voiceRelayStatusRef.current = undefined;
      setVoiceRelayStatus(undefined);
      voiceRelayMachineRef.current = new VoiceRelayStateMachine();
      setVoiceRelayUi(voiceRelayMachineRef.current.snapshot);
      setVoicePhase("off");
      return undefined;
    }
    setVoicePhase("checking");
    try {
      const status = await voiceRelay.inspect();
      voiceRelayStatusRef.current = status;
      setVoiceRelayStatus(status);
      const machine = new VoiceRelayStateMachine();
      if (status.enabled) {
        machine.dispatch({ type: "enable" });
        if (status.target) machine.dispatch({ type: "configured", target: status.target });
      }
      voiceRelayMachineRef.current = machine;
      setVoiceRelayUi(machine.snapshot);
      if (status.activeStage) {
        setVoicePhase("failed");
        setVoiceText("A Voice Relay draft already exists. Inspect or cancel it from the desktop Agent window.");
      } else {
        setVoicePhase(status.enabled && status.armed && status.target ? "idle" : "off");
      }
      return status;
    } catch (cause) {
      const error = relayError(cause);
      setVoicePhase("failed");
      setVoiceText(error.message);
      setVoiceRelayStatus(undefined);
      voiceRelayStatusRef.current = undefined;
      return undefined;
    }
  }, [voiceRelay]);

  useEffect(() => {
    let active = true;
    void refreshVoiceRelay().catch((cause) => {
      if (active) setSafeError(cause);
    });
    return () => { active = false; };
  }, [refreshVoiceRelay, setSafeError]);

  const relayReady = Boolean(voiceRelay
    && voiceRelayStatus?.enabled
    && voiceRelayStatus.armed
    && voiceRelayStatus.target?.capabilities.draftInsertion
    && voiceRelayStatus.target.capabilities.explicitSend);
  const voiceMode: "relay" | undefined = relayReady ? "relay" : undefined;

  // A normal headset pairing is a renderer/input client. Voice-capable Agents
  // keep using the computer microphone and need no speech provider in XR.
  // `voiceRelay` exists only when the desktop explicitly grants the optional
  // standalone relay capability for this one-time renderer pairing.
  const voiceUnavailableReason = !voiceRelay
    ? undefined
    : !voiceRelayStatus
      ? "Checking Voice Relay…"
      : !voiceRelayStatus.enabled
        ? "Voice Relay is off. Ask the Agent to configure and arm it on the desktop."
        : !voiceRelayStatus.target
          ? "Voice Relay needs a configured Agent target."
          : !voiceRelayStatus.armed
            ? "Voice Relay is not armed for this session. Confirm it on the desktop."
            : !speech
              ? "Voice provider not configured"
              : !projection || connectionPhase !== "connected"
                ? "Voice is available after a Workspace snapshot connects"
                : !relayReady
                  ? "The configured Agent target cannot safely insert and explicitly send drafts."
                  : undefined;

  const signalVoiceCue = useCallback((cue: XrVoiceCue) => {
    if (audibleVoiceCues) void Promise.resolve(voiceCues.play(cue)).catch(() => undefined);
    rendererRef.current?.pulseXRVoiceHaptics?.(cue);
  }, [audibleVoiceCues, voiceCues]);

  const stopSpeechOutput = useCallback((reason = "stopped") => {
    speechOutputAbortRef.current?.abort(reason);
    speechOutputAbortRef.current = undefined;
    speechOutput?.stop(reason);
  }, [speechOutput]);

  const speakReply = useCallback(async (textValue?: string) => {
    const text = (textValue ?? lastVoiceReplyRef.current).trim();
    if (!text || !speechOutput) return;
    stopSpeechOutput("replaced");
    const abort = new AbortController();
    speechOutputAbortRef.current = abort;
    try {
      if (voiceRelayMachineRef.current.snapshot.phase === "reply_ready") {
        publishRelayEvent({ type: "speak" });
      }
      setVoicePhase("speaking");
      await speechOutput.speak({
        utteranceId: voiceRelayStageRef.current?.stageId ?? requestIdFactory(),
        text,
        signal: abort.signal,
      });
      if (abort.signal.aborted || speechOutputAbortRef.current !== abort) return;
      speechOutputAbortRef.current = undefined;
      if (voiceRelayMachineRef.current.snapshot.phase === "speaking") {
        publishRelayEvent({ type: "complete" });
      }
      setVoicePhase("sent");
    } catch (cause) {
      if (speechOutputAbortRef.current === abort) speechOutputAbortRef.current = undefined;
      if (abort.signal.aborted || cause instanceof XrBrowserSpeechSynthesisError && cause.code === "aborted") {
        if (voiceRelayMachineRef.current.snapshot.phase === "speaking") {
          publishRelayEvent({ type: "cancel" });
        }
        setVoicePhase("reply_ready");
        return;
      }
      const error = relayError(cause);
      publishRelayEvent({ type: "fail", error });
      setVoicePhase("failed");
      setVoiceText(error.message);
      signalVoiceCue("error");
    }
  }, [publishRelayEvent, requestIdFactory, signalVoiceCue, speechOutput, stopSpeechOutput]);

  const pollRelayReply = useCallback((stageId: string) => {
    if (!voiceRelay) return;
    voiceRelayReplyAbortRef.current?.abort("superseded");
    const abort = new AbortController();
    voiceRelayReplyAbortRef.current = abort;
    const deadline = Date.now() + 120_000;
    void (async () => {
      let lastSequence = -1;
      try {
        while (!abort.signal.aborted && Date.now() < deadline) {
          const reply = await voiceRelay.readReply(stageId);
          if (abort.signal.aborted || voiceRelayStageRef.current?.stageId !== stageId) return;
          if (reply.sequence > lastSequence) {
            lastSequence = reply.sequence;
            if (typeof reply.text === "string") {
              lastVoiceReplyRef.current = reply.text;
              setVoiceReply(reply.text);
            }
            if (voiceRelayMachineRef.current.snapshot.phase === "waiting_response"
              || voiceRelayMachineRef.current.snapshot.phase === "reply_ready") {
              publishRelayEvent({
                type: "reply",
                sequence: reply.sequence,
                complete: reply.phase === "complete",
              });
            }
          }
          if (reply.phase === "complete") {
            if (voiceRelayMachineRef.current.snapshot.phase === "waiting_response") {
              publishRelayEvent({
                type: "reply",
                sequence: reply.sequence,
                complete: true,
              });
            }
            signalVoiceCue("reply_ready");
            setVoicePhase("reply_ready");
            if (readRepliesAloud && lastVoiceReplyRef.current) {
              await speakReply(lastVoiceReplyRef.current);
            }
            return;
          }
          if (reply.phase === "unavailable") {
            if (voiceRelayMachineRef.current.snapshot.phase === "waiting_response") {
              publishRelayEvent({ type: "complete" });
            }
            setVoicePhase("sent");
            setVoiceText("Sent. Reply observation is unavailable for this Agent target.");
            return;
          }
          await waitWithAbort(350, abort.signal);
        }
        if (!abort.signal.aborted) {
          if (voiceRelayMachineRef.current.snapshot.phase === "waiting_response") {
            publishRelayEvent({ type: "complete" });
          }
          setVoicePhase("sent");
          setVoiceText("Sent. Reply observation timed out; inspect the Agent window.");
        }
      } catch (cause) {
        if (abort.signal.aborted) return;
        const error = relayError(cause);
        publishRelayEvent({ type: "fail", error });
        setVoicePhase("failed");
        setVoiceText(error.message);
        signalVoiceCue("error");
      }
    })();
  }, [voiceRelay, publishRelayEvent, readRepliesAloud, signalVoiceCue, speakReply]);

  const confirmRelayDraft = useCallback(async () => {
    const receipt = voiceRelayStageRef.current;
    if (!voiceRelay || !receipt || voicePhase !== "awaiting_confirmation") return;
    if (Date.now() >= receipt.expiresAtMs) {
      setVoicePhase("failed");
      setVoiceText("This Voice Relay draft expired. Hold grip to record it again.");
      signalVoiceCue("error");
      return;
    }
    try {
      publishRelayEvent({ type: "confirm" });
      setVoicePhase("sending");
      const result = await voiceRelay.confirm(receipt.stageId);
      if (result.status === "send_outcome_unknown") {
        publishRelayEvent({ type: "send_outcome_unknown" });
        setVoicePhase("send_outcome_unknown");
        setVoiceText("Send outcome unknown — inspect the Agent window before trying again.");
        signalVoiceCue("error");
        return;
      }
      publishRelayEvent({ type: "sent" });
      setVoicePhase(result.observationAvailable ? "waiting_response" : "sent");
      setVoiceText(result.observationAvailable
        ? "Sent once. Waiting for the Agent reply…"
        : "Sent once. Reply observation is unavailable for this Agent target.");
      signalVoiceCue("sent");
      if (result.observationAvailable) pollRelayReply(receipt.stageId);
      else publishRelayEvent({ type: "complete" });
    } catch (cause) {
      const error = relayError(cause);
      publishRelayEvent({ type: "fail", error });
      setVoicePhase("failed");
      setVoiceText(error.message);
      signalVoiceCue("error");
    }
  }, [pollRelayReply, voiceRelay, publishRelayEvent, signalVoiceCue, voicePhase]);

  const cancelRelayDraft = useCallback(async (): Promise<boolean> => {
    const receipt = voiceRelayStageRef.current;
    if (!receipt || !voiceRelay) return true;
    try {
      const result = await voiceRelay.cancel(receipt.stageId);
      if (result.status === "draft_changed" || result.status === "already_sent") {
        setVoicePhase("failed");
        setVoiceText(result.status === "draft_changed"
          ? "The Agent draft changed after staging. It was not cleared. Inspect the Agent window."
          : "This draft was already sent and cannot be cancelled.");
        signalVoiceCue("error");
        return false;
      }
      voiceRelayStageRef.current = undefined;
      voiceRelayReplyAbortRef.current?.abort("draft_cancelled");
      if (["listening", "transcribing", "staging", "awaiting_confirmation", "waiting_response", "reply_ready", "speaking"]
        .includes(voiceRelayMachineRef.current.snapshot.phase)) {
        publishRelayEvent({ type: "cancel" });
      }
      setVoiceText("");
      setVoiceReply("");
      lastVoiceReplyRef.current = "";
      setVoicePhase("idle");
      return true;
    } catch (cause) {
      const error = relayError(cause);
      publishRelayEvent({ type: "fail", error });
      setVoicePhase("failed");
      setVoiceText(error.message);
      signalVoiceCue("error");
      return false;
    }
  }, [voiceRelay, publishRelayEvent, signalVoiceCue]);

  const beginVoice = useCallback(async () => {
    const current = projectionRef.current;
    if (!speech || !current || !voiceMode || connectionPhaseRef.current !== "connected") return;
    if (activeSpeechRef.current) return;
    stopSpeechOutput("ptt_barge_in");
    const relayPhase = voiceRelayMachineRef.current.snapshot.phase;
    // A draft which has not been sent must be removed through the exact
    // native stage identity. Once it has been sent, starting another PTT
    // turn only stops local reply observation; calling cancel on that stage
    // would correctly return already_sent and would otherwise dead-end PTT.
    if (relayPhase === "awaiting_confirmation"
      && voiceRelayStageRef.current
      && !(await cancelRelayDraft())) return;
    if (["waiting_response", "reply_ready", "speaking"].includes(relayPhase)) {
      voiceRelayReplyAbortRef.current?.abort("ptt_barge_in");
      publishRelayEvent({ type: "cancel" });
    }
    if (relayPhase === "ready"
      || relayPhase === "waiting_response"
      || relayPhase === "reply_ready"
      || relayPhase === "speaking") {
      voiceRelayStageRef.current = undefined;
    }
    const utteranceId = requestIdFactory();
    const abort = new AbortController();
    publishRelayEvent({ type: "listen" });
    const active: ActiveSpeech = { abort, utteranceId };
    activeSpeechRef.current = active;
    setVoiceText("");
    setVoiceReply("");
    setVoicePhase("starting");
    signalVoiceCue("listen_start");
    if (immersivePhase === "active") {
      rendererRef.current?.setXRVoiceFeedback?.({
        phase: "listening",
        ...(voiceRelayStatusRef.current?.target?.label
          ? { targetLabel: voiceRelayStatusRef.current.target.label }
          : {}),
      });
    }
    try {
      const capture = await speech.begin({
        utteranceId,
        signal: abort.signal,
        onPartial: (partial) => {
          setVoiceText(partial.text);
          setVoicePhase("listening");
        },
      });
      if (abort.signal.aborted || activeSpeechRef.current !== active) {
        await capture.cancel("viewer_cancelled");
        return;
      }
      active.capture = capture;
      setVoicePhase("listening");
    } catch (cause) {
      if (activeSpeechRef.current === active) activeSpeechRef.current = undefined;
      const error = relayError(cause);
      publishRelayEvent({ type: "fail", error });
      setVoicePhase("failed");
      setVoiceText(safeMessage(cause));
      signalVoiceCue("error");
    }
  }, [cancelRelayDraft, immersivePhase, publishRelayEvent, requestIdFactory, signalVoiceCue, speech, stopSpeechOutput, voiceMode]);

  const finishVoice = useCallback(async () => {
    const active = activeSpeechRef.current;
    const current = projectionRef.current;
    if (!active?.capture || !current) return;
    setVoicePhase("transcribing");
    publishRelayEvent({ type: "transcribe" });
    signalVoiceCue("listen_stop");
    try {
      const final = await active.capture.finish();
      if (!voiceRelay) throw new Error("Voice Relay disconnected before staging the draft.");
      publishRelayEvent({ type: "stage" });
      setVoicePhase("staging");
      const receipt = await voiceRelay.stage({
        utteranceId: active.utteranceId,
        text: final.text,
      });
      voiceRelayStageRef.current = receipt;
      publishRelayEvent({ type: "staged", stageId: receipt.stageId, expiresAtMs: receipt.expiresAtMs });
      if (activeSpeechRef.current === active) activeSpeechRef.current = undefined;
      setVoiceText(final.text);
      setVoicePhase("awaiting_confirmation");
      signalVoiceCue("draft_ready");
    } catch (cause) {
      if (activeSpeechRef.current === active) activeSpeechRef.current = undefined;
      const error = relayError(cause);
      publishRelayEvent({ type: "fail", error });
      setVoicePhase("failed");
      setVoiceText(safeMessage(cause));
      signalVoiceCue("error");
    }
  }, [voiceRelay, publishRelayEvent, signalVoiceCue]);

  const cancelVoice = useCallback(async () => {
    const active = activeSpeechRef.current;
    if (active) {
      active.abort.abort("user_cancelled");
      activeSpeechRef.current = undefined;
      await active.capture?.cancel("user_cancelled");
      if (["listening", "transcribing", "staging"].includes(voiceRelayMachineRef.current.snapshot.phase)) {
        publishRelayEvent({ type: "cancel" });
      }
      setVoiceText("");
      setVoicePhase("idle");
      return;
    }
    if (voicePhase === "speaking") {
      stopSpeechOutput("user_cancelled");
      return;
    }
    await cancelRelayDraft();
  }, [cancelRelayDraft, publishRelayEvent, stopSpeechOutput, voicePhase]);

  const rerecordVoice = useCallback(async () => {
    if (await cancelRelayDraft()) await beginVoice();
  }, [beginVoice, cancelRelayDraft]);

  handlePushToTalkRef.current = (event) => {
    const operation = event.phase === "pressed"
      ? beginVoice
      : event.phase === "released"
        ? finishVoice
        : event.phase === "confirmed"
          ? confirmRelayDraft
          : event.phase === "replay"
            ? () => speakReply()
            : cancelVoice;
    const queued = immersivePTTQueueRef.current.then(operation);
    immersivePTTQueueRef.current = queued.catch((cause) => {
      if (aliveRef.current) {
        setVoicePhase("failed");
        setVoiceText(safeMessage(cause));
        signalVoiceCue("error");
      }
    });
  };

  useEffect(() => {
    const renderer = rendererRef.current;
    if (!rendererReady || !renderer?.setXRVoiceFeedback) return;
    if (immersivePhase !== "active") {
      renderer.setXRVoiceFeedback({ phase: "hidden" });
      return;
    }
    // A granted-but-off Relay is still renderer-only. Do not turn its setup
    // state into a persistent headset warning; desktop setup/arming owns that
    // transition and only an armed Relay may surface provider feedback in XR.
    if (!voiceRelay || !voiceRelayStatus?.enabled || !voiceRelayStatus.armed) {
      renderer.setXRVoiceFeedback({ phase: "hidden" });
      return;
    }
    const targetLabel = voiceRelayStatus?.target?.label;
    if (voiceUnavailableReason) {
      renderer.setXRVoiceFeedback({ phase: "error", message: voiceUnavailableReason });
      return;
    }
    if (voicePhase === "starting" || voicePhase === "listening") {
      renderer.setXRVoiceFeedback({
        phase: "listening",
        ...(voiceText ? { subtitle: voiceText } : {}),
        ...(targetLabel ? { targetLabel } : {}),
      });
      return;
    }
    if (voicePhase === "transcribing" || voicePhase === "staging" || voicePhase === "finalizing") {
      renderer.setXRVoiceFeedback({ phase: "processing", ...(targetLabel ? { targetLabel } : {}) });
      return;
    }
    if (voicePhase === "awaiting_confirmation") {
      renderer.setXRVoiceFeedback({
        phase: "awaiting_confirmation",
        subtitle: voiceText,
        ...(targetLabel ? { targetLabel } : {}),
        actions: ["confirm", "cancel"],
      });
      return;
    }
    if (voicePhase === "sending") {
      renderer.setXRVoiceFeedback({ phase: "sending", ...(targetLabel ? { targetLabel } : {}) });
      return;
    }
    if (voicePhase === "waiting_response") {
      renderer.setXRVoiceFeedback({
        phase: "waiting_response",
        ...(voiceReply ? { subtitle: voiceReply } : {}),
        ...(targetLabel ? { targetLabel } : {}),
      });
      return;
    }
    if (voicePhase === "speaking") {
      renderer.setXRVoiceFeedback({
        phase: "speaking",
        subtitle: voiceReply,
        ...(targetLabel ? { targetLabel } : {}),
        actions: ["stop"],
      });
      return;
    }
    if (voicePhase === "reply_ready" || voicePhase === "sent") {
      renderer.setXRVoiceFeedback({
        phase: "sent",
        ...(voiceReply ? { subtitle: voiceReply, actions: ["replay"] } : {}),
        ...(targetLabel ? { targetLabel } : {}),
      });
      return;
    }
    if (voicePhase === "send_outcome_unknown" || voicePhase === "failed") {
      renderer.setXRVoiceFeedback({ phase: "error", ...(voiceText ? { message: voiceText } : {}) });
      return;
    }
    renderer.setXRVoiceFeedback({ phase: "ready", ...(targetLabel ? { targetLabel } : {}) });
  }, [immersivePhase, rendererReady, voicePhase, voiceRelay, voiceReply, voiceText, voiceRelayStatus?.target?.label, voiceUnavailableReason]);

  useEffect(() => {
    // React Strict Mode replays mount effects in development, so explicitly
    // restore the liveness gate when the setup half runs again.
    aliveRef.current = true;
    return () => {
      aliveRef.current = false;
      sessionGenerationRef.current += 1;
      pairingAbortRef.current?.abort("viewer_unmounted");
      reconnectAbortRef.current?.abort("viewer_unmounted");
      ultraAbortRef.current?.abort("viewer_unmounted");
      void teardownVoiceSession("viewer_unmounted", false);
      const activeXRSession = webXRSessionRef.current;
      if (activeXRSession) {
        void teardownXRSessionRef.current?.(
          activeXRSession,
          xrRendererOwnershipRef.current?.renderer,
        ).catch(() => undefined);
      }
      void sessionRef.current?.close("viewer_unmounted");
      pendingInputsRef.current.clear();
      handledInputResultsRef.current.clear();
      assetRuntimeRef.current.clear();
    };
  }, [teardownVoiceSession]);

  const simulatorVisible = immersivePhase !== "active" && immersivePhase !== "exiting";

  return <main className="xr-viewer-shell" aria-label="SemaFrame XR renderer">
    <header className="xr-viewer-header">
      <strong className="xr-viewer-brand">SemaFrame XR</strong>
      <span role="status" aria-live="polite" className="xr-viewer-status">{statusMessage}</span>
      <span className="xr-viewer-badge xr-viewer-connection-badge">
        {connectionPhase}
      </span>
      <span
        data-xr-render-profile={renderProfile.mode}
        title={ultra.message}
        className="xr-viewer-badge xr-viewer-profile-badge"
      >{renderProfile.label}</span>
      {ultraEvidenceRef.current && <button
        type="button"
        style={buttonStyle}
        data-xr-ultra-phase={ultra.phase}
        disabled={immersivePhase === "active"
          || immersivePhase === "entering"
          || immersivePhase === "exiting"
          || ultra.phase === "probing"
          || ultra.phase === "confirming"
          || ultra.phase === "benchmarking"
          || ultra.phase === "eligible"}
        title={ultra.message}
        onClick={() => void verifyUltra()}
      >{ultra.phase === "eligible"
        ? "Ultra verified"
        : ultra.phase === "benchmarking"
          ? "Benchmarking Ultra…"
          : ultra.phase === "unprobed" || ultra.phase === "probing"
            ? "Check Ultra"
            : "Start Ultra benchmark"}</button>}
      {connectionPhase === "disconnected" && <button type="button" style={buttonStyle} onClick={() => void reconnect()}>
        Reconnect
      </button>}
      {immersivePhase === "ready" && <button type="button" style={buttonStyle} disabled={!rendererReady} onClick={() => void enterXR()}>
        Enter XR
      </button>}
      {immersivePhase === "entering" && <button type="button" style={buttonStyle} disabled>Entering XR…</button>}
      {immersivePhase === "active" && <button
        type="button"
        style={buttonStyle}
        data-xr-exit-requested={remoteExitRequested ? "true" : "false"}
        onClick={() => void exitXR()}
      >{remoteExitRequested ? "Exit XR · requested" : "Exit XR"}</button>}
      {immersivePhase === "exiting" && <button type="button" style={buttonStyle} disabled>Exiting XR…</button>}
      {immersivePhase === "failed" && <button type="button" style={buttonStyle} onClick={() => void probeWebXR()}>Retry XR</button>}
      {simulatorVisible && <span
        data-xr-simulator="non-immersive"
        className="xr-viewer-simulator-badge"
      >Desktop simulator · Non-immersive</span>}
    </header>

    {pairingVisible && <section aria-labelledby="xr-pairing-title" className="xr-viewer-pairing" data-xr-layout="pairing">
      <h1 id="xr-pairing-title">Connect this renderer</h1>
      <p className="xr-viewer-muted">Type the six digits shown by the authoritative SemaFrame Workspace.</p>
      <form onSubmit={submitPairing}>
        <label htmlFor="xr-pairing-code" className="xr-viewer-pairing-label">One-time pairing code</label>
        <div className="xr-viewer-pairing-row">
          <input
            ref={inputRef}
            id="xr-pairing-code"
            type="text"
            inputMode="numeric"
            autoComplete="one-time-code"
            pattern="[0-9]{6}"
            maxLength={6}
            placeholder="123456"
            spellCheck={false}
            required
            value={pairingCodeInput}
            onChange={(event) => setPairingCodeInput(
              event.currentTarget.value.replace(/[^0-9]/gu, "").slice(0, 6),
            )}
            className="xr-viewer-pairing-input"
            style={{
              fontSize: "clamp(1.25rem, 7vw, 2rem)",
              fontVariantNumeric: "tabular-nums",
              letterSpacing: ".16em",
              textAlign: "center",
            }}
          />
          <button type="submit" style={buttonStyle} className="xr-viewer-pairing-submit">Pair once</button>
        </div>
      </form>
    </section>}

    {!pairingVisible && <div className="xr-viewer-connected" data-xr-layout="connected">
      <section aria-label="Workspace spatial renderer" className="xr-viewer-renderer">
        <div ref={rendererHostRef} className="xr-viewer-renderer-host" />
        {!projection && <div role="status" className="xr-viewer-loading">
          Loading authoritative Workspace snapshot…
        </div>}
      </section>
      <aside aria-label="XR control panels" className="xr-viewer-panels">
        <h2 style={{ fontSize: 15, margin: "0 0 4px" }}>World panels</h2>
        <p style={{ fontSize: 12, color: "#91a6ba", margin: "0 0 12px" }}>Desktop HTML fallback for renderer-neutral immersive panel DTOs.</p>
        {panelResult.error && <p role="alert" style={{ color: "#ffb4ad" }}>{panelResult.error}</p>}
        <XrPanelFallback panels={panelResult.panels} onAction={(action, panelId) => void invokePanelAction(action, panelId)} />
        {voiceRelay && <>
        <hr style={{ border: 0, borderTop: "1px solid rgba(137, 177, 215, .2)", margin: "18px 0" }} />
        <h2 style={{ fontSize: 15, margin: "0 0 8px" }}>Voice Relay</h2>
        <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap", marginBottom: 8 }}>
          <span
            data-voice-relay-phase={voiceRelayUi.phase}
            style={{
              border: "1px solid rgba(137, 177, 215, .28)",
              borderRadius: 999,
              padding: "4px 8px",
              color: relayReady ? "#72dea1" : "#a9bbce",
              fontSize: 12,
            }}
          >{voiceRelay ? `Relay · ${voiceRelayStatus?.phase ?? "checking"}` : "Relay · off"}</span>
          {voiceRelayStatus?.target && <span style={{ color: "#a9bbce", fontSize: 12 }}>
            Target: {voiceRelayStatus.target.label}
          </span>}
          {voiceRelay && <button
            type="button"
            style={{ ...buttonStyle, padding: "5px 9px", fontSize: 12 }}
            disabled={voicePhase === "listening" || voicePhase === "sending" || voicePhase === "staging"}
            onClick={() => void refreshVoiceRelay()}
          >Refresh Relay</button>}
        </div>
        {voiceUnavailableReason && <p role="note" style={{ color: "#ffd89a", fontSize: 13 }}>{voiceUnavailableReason}</p>}
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          {(voicePhase === "off" || voicePhase === "checking" || voicePhase === "failed" || voicePhase === "send_outcome_unknown") && <button
            type="button"
            style={buttonStyle}
            disabled
          >Start push to talk</button>}
          {(voicePhase === "idle" || voicePhase === "sent" || voicePhase === "reply_ready") && <button
            type="button"
            style={buttonStyle}
            disabled={Boolean(voiceUnavailableReason)}
            onClick={() => void beginVoice()}
          >Start push to talk</button>}
          {(voicePhase === "starting" || voicePhase === "listening") && <button
            type="button"
            style={buttonStyle}
            disabled={voicePhase === "starting"}
            onClick={() => void finishVoice()}
          >Finish and stage draft</button>}
          {(voicePhase === "starting" || voicePhase === "listening" || voicePhase === "transcribing" || voicePhase === "staging" || voicePhase === "finalizing") && <button
            type="button"
            style={buttonStyle}
            onClick={() => void cancelVoice()}
          >Cancel</button>}
          {voicePhase === "awaiting_confirmation" && <>
            <button type="button" style={buttonStyle} onClick={() => void confirmRelayDraft()}>
              Confirm send once
            </button>
            <button type="button" style={buttonStyle} onClick={() => void cancelRelayDraft()}>
              Cancel draft
            </button>
            <button type="button" style={buttonStyle} onClick={() => void rerecordVoice()}>
              Re-record
            </button>
          </>}
          {voicePhase === "reply_ready" && speechOutput && <button
            type="button"
            style={buttonStyle}
            onClick={() => void speakReply()}
          >Read reply aloud</button>}
          {voicePhase === "speaking" && <button
            type="button"
            style={buttonStyle}
            onClick={() => stopSpeechOutput("user_cancelled")}
          >Stop reading</button>}
          {voicePhase === "sent" && voiceReply && speechOutput && <button
            type="button"
            style={buttonStyle}
            onClick={() => void speakReply()}
          >Replay reply</button>}
        </div>
        {voiceRelay && <label style={{ display: "flex", alignItems: "center", gap: 7, color: "#a9bbce", fontSize: 12, marginTop: 10 }}>
          <input
            type="checkbox"
            checked={readRepliesAloud}
            onChange={(event) => setReadRepliesAloud(event.currentTarget.checked)}
          />
          Read complete Agent replies aloud
        </label>}
        {voiceRelay && <label style={{ display: "flex", alignItems: "center", gap: 7, color: "#a9bbce", fontSize: 12, marginTop: 7 }}>
          <input
            type="checkbox"
            checked={audibleVoiceCues}
            onChange={(event) => setAudibleVoiceCues(event.currentTarget.checked)}
          />
          Play short voice feedback sounds
        </label>}
        <p aria-live="polite" style={{ color: voicePhase === "failed" ? "#ffb4ad" : "#a9bbce", fontSize: 13 }}>
          {voiceText || `Voice: ${voicePhase}`}
        </p>
        {voiceReply && <p aria-live="polite" data-voice-relay-subtitle style={{
          color: "#eef6ff",
          fontSize: 13,
          lineHeight: 1.5,
          whiteSpace: "pre-wrap",
          maxHeight: 180,
          overflow: "auto",
          borderLeft: "2px solid #68d5ff",
          paddingLeft: 10,
        }}>{voiceReply}</p>}
        </>}
      </aside>
    </div>}

    {(errorMessage || immersiveError) && <div role="alert" style={{
      position: "fixed", left: 16, bottom: 16, right: 16, maxWidth: 700, padding: 12,
      border: "1px solid #8e3d3d", borderRadius: 10, background: "#2c1216", color: "#ffd8d3",
    }}>{errorMessage ?? immersiveError}</div>}
  </main>;
}
