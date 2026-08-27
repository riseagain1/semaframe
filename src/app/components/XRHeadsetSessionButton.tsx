import { Copy, Headset, Link2, LoaderCircle, RefreshCw, Square, X } from "lucide-react";
import { forwardRef, useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { WorkspaceRenderSnapshot } from "../../workspace/renderer/contracts";
import { stableStringify } from "../../workspace/components/manifestDigest";
import {
  XrAuthorityController,
  XrHostInputRouter,
  XR_INPUT_RESULT_CHANNEL,
  createXrInputResultPayload,
  type XrAuthorityPairingGrant,
  type XrAuthorityTransport,
  type XrAuthenticatedRendererSource,
  type XrPanelAuthorizationRequest,
  type XrPanelConfirmationChallenge,
  type XrVoiceIntent,
} from "../../xr/authority";
import { XrAuthorityHttpTransport } from "../../xr/network/XrAuthorityHttpTransport";
import type { XrAssetFormat } from "../../xr/assets";
import type { XRPanelTypedAction } from "../../xr/panels";
import { parseXRContextEnvelope, type XRContextEnvelope } from "../../xr/client";
import {
  XR_SESSION_CONTROL_CHANNEL,
  XR_SESSION_PRESENCE_CHANNEL,
  parseXrRoutedSessionPresence,
  type XrRoutedPresencePhase,
} from "../../xr/protocol";

export type XRHeadsetSessionPhase =
  | "idle"
  | "starting"
  | "pairing"
  | "replica_ready"
  | "immersive_entering"
  | "active"
  | "exiting"
  | "ended"
  | "disconnected"
  | "expired"
  | "stopping"
  | "error";

export type XRHeadsetSessionButtonProps = Readonly<{
  snapshot: WorkspaceRenderSnapshot;
  registryIdentity: string;
  disabled?: boolean;
  /** Hides only the trusted desktop controls; the XR authority remains live. */
  desktopControlsVisible?: boolean;
  viewerUrl?: string;
  transportFactory?: () => XrAuthorityTransport;
  openRealityAsset?: (assetId: string, digest: string, signal?: AbortSignal) => Promise<Blob | undefined>;
  pollIntervalMs?: number;
  onSelect(componentId: string | null): void | Promise<void>;
  onActivate(componentId: string): void | Promise<void>;
  onPanelAction(action: XRPanelTypedAction): void | Promise<void>;
  authorizePanelAction?(action: XRPanelTypedAction): boolean | Promise<boolean>;
  onVoiceIntent?(intent: XrVoiceIntent): void | Promise<void>;
  onSpatialContext?(
    context: XRContextEnvelope,
    source: XrAuthenticatedRendererSource,
  ): void | Promise<void>;
  onPhaseChange?(phase: XRHeadsetSessionPhase, message: string): void;
  voiceRelayEnabled?: boolean;
  challengeIdFactory?: () => string;
  now?: () => number;
}>;

export type XRHeadsetSessionButtonHandle = Readonly<{
  inspect(): Readonly<{
    phase: XRHeadsetSessionPhase;
    message: string;
    pairingReady: boolean;
    lifecycleSequence: number;
    lastLifecyclePhase?: XrRoutedPresencePhase;
  }>;
  prepare(): Promise<Readonly<{
    phase: XRHeadsetSessionPhase;
    message: string;
    pairingReady: boolean;
    lifecycleSequence: number;
    lastLifecyclePhase?: XrRoutedPresencePhase;
  }>>;
  readLifecycleTransition(afterSequence: number): XRHeadsetLifecycleTransition | undefined;
  showPairing(): void;
  setVoiceRelayEnabled(enabled: boolean): Promise<void>;
  requestExit(): Promise<boolean>;
  stop(): Promise<XRHeadsetStopOutcome>;
}>;

export type XRHeadsetStopOutcome = Readonly<{
  locallyReleased: boolean;
  teardownConfirmed: boolean;
  error?: string;
}>;

export type XRHeadsetLifecycleTransition = Readonly<{
  sequence: number;
  phase: XrRoutedPresencePhase;
  serverReceivedAtMs: number;
  sourceSessionId: string;
}>;

export const DEFAULT_XR_VIEWER_URL = "http://127.0.0.1:4174/xr.html";
const XR_ASSET_TTL_MS = 24 * 60 * 60_000;
const XR_PANEL_CONFIRMATION_TTL_MS = 15_000;
const MAXIMUM_PANEL_CONFIRMATION_CHALLENGES = 64;

type PendingPanelConfirmation = Readonly<{
  rendererSessionId: string;
  pairingId: string;
  workspaceRevision: number;
  panelId: string;
  actionDigest: string;
  expiresAtMs: number;
}>;

/** Non-secret identity retained after a renderer consumes its one-time grant. */
type ActivePairingReference = Readonly<Pick<XrAuthorityPairingGrant, "pairingId">>;

type XrAssetPublishingTransport = XrAuthorityTransport & Readonly<{
  hasAsset(
    digest: `sha256:${string}`,
    format: XrAssetFormat,
    byteLength: number,
    signal?: AbortSignal,
  ): Promise<boolean>;
  putAsset(
    blob: Blob,
    digest: `sha256:${string}`,
    format: XrAssetFormat,
    ttlMs: number,
    signal?: AbortSignal,
  ): Promise<unknown>;
}>;

function assetFormat(format: "spz-v4" | "ply" | "sog-v2"): XrAssetFormat {
  if (format === "spz-v4") return "gaussian-spz-v4";
  if (format === "ply") return "gaussian-ply";
  return "gaussian-sog-v2";
}

function supportsAssetPublishing(transport: XrAuthorityTransport): transport is XrAssetPublishingTransport {
  const candidate = transport as Partial<XrAssetPublishingTransport>;
  return typeof candidate.hasAsset === "function" && typeof candidate.putAsset === "function";
}

export function isLoopbackXrViewerHost(hostname: string): boolean {
  const normalized = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  return normalized === "localhost"
    || normalized === "::1"
    || normalized === "0:0:0:0:0:0:0:1"
    || /^127(?:\.\d{1,3}){3}$/u.test(normalized);
}

export function canonicalXrViewerUrl(value: string): URL {
  const result = new URL(value, globalThis.location?.href ?? "http://127.0.0.1/");
  if ((result.protocol !== "http:" && result.protocol !== "https:")
    || result.username || result.password || result.search || result.hash) {
    throw new Error("The XR viewer URL must be an HTTP(S) page without credentials, query parameters, or a fragment.");
  }
  if (result.protocol === "http:" && !isLoopbackXrViewerHost(result.hostname)) {
    throw new Error(
      "A remote XR viewer must use HTTPS. Plain HTTP is allowed only for a localhost or loopback simulator. Configure VITE_XR_PUBLIC_URL with a reachable HTTPS xr.html address.",
    );
  }
  return result;
}

function pairingUrl(viewerUrl: string, pairingToken: string): string {
  const result = canonicalXrViewerUrl(viewerUrl);
  result.hash = new URLSearchParams({ pair: pairingToken }).toString();
  return result.toString();
}

function delay(milliseconds: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const handle = globalThis.setTimeout(resolve, milliseconds);
    signal.addEventListener("abort", () => {
      globalThis.clearTimeout(handle);
      resolve();
    }, { once: true });
  });
}

function friendly(cause: unknown): string {
  return (cause instanceof Error ? cause.message : "The XR headset session failed.").slice(0, 500);
}

/**
 * Host-authority control for a separate headset browser. The opaque pairing
 * secret lives only in the URL fragment; its six-digit alias is short-lived
 * and single-use. Durable edits are re-authorized in the App, and the headset
 * never owns a second Workspace store.
 */
export const XRHeadsetSessionButton = forwardRef<XRHeadsetSessionButtonHandle, XRHeadsetSessionButtonProps>(function XRHeadsetSessionButton(props, ref) {
  const {
    snapshot,
    registryIdentity,
    disabled = false,
    desktopControlsVisible = true,
    onPhaseChange,
  } = props;
  const viewerUrl = props.viewerUrl
    ?? (import.meta.env.VITE_XR_PUBLIC_URL?.trim() || DEFAULT_XR_VIEWER_URL);
  const pollIntervalMs = props.pollIntervalMs ?? 80;
  const [open, setOpen] = useState(false);
  const [phase, setPhase] = useState<XRHeadsetSessionPhase>("idle");
  const [message, setMessage] = useState("Start a renderer-only headset session.");
  const [grant, setGrant] = useState<XrAuthorityPairingGrant>();
  const [copied, setCopied] = useState(false);
  const controllerRef = useRef<XrAuthorityController | undefined>(undefined);
  const transportRef = useRef<XrAuthorityTransport | undefined>(undefined);
  const pollingRef = useRef<AbortController | undefined>(undefined);
  const operationAbortRef = useRef<AbortController | undefined>(undefined);
  const rendererActiveTimeoutRef = useRef<ReturnType<typeof globalThis.setTimeout> | undefined>(undefined);
  const rendererActiveRef = useRef(false);
  const rendererSessionIdRef = useRef<string | undefined>(undefined);
  const pairingRef = useRef<ActivePairingReference | undefined>(undefined);
  const pairingRotationRef = useRef<Promise<void>>(Promise.resolve());
  const voiceRelayEnabledRef = useRef(props.voiceRelayEnabled === true);
  const publishedPhaseRef = useRef<Readonly<{ phase: XRHeadsetSessionPhase; message: string }> | undefined>(undefined);
  const aliveRef = useRef(true);
  const snapshotRef = useRef(snapshot);
  const callbacksRef = useRef(props);
  const processedInputResultsRef = useRef(new Map<string, ReturnType<typeof createXrInputResultPayload>>());
  const panelConfirmationChallengesRef = useRef(new Map<string, PendingPanelConfirmation>());
  const lifecycleSequenceRef = useRef(0);
  const lifecycleTransitionsRef = useRef<XRHeadsetLifecycleTransition[]>([]);
  snapshotRef.current = snapshot;
  callbacksRef.current = props;
  if (!controllerRef.current) voiceRelayEnabledRef.current = props.voiceRelayEnabled === true;

  const publish = useCallback((next: XRHeadsetSessionPhase, nextMessage: string) => {
    if (!aliveRef.current) return;
    const previous = publishedPhaseRef.current;
    if (previous?.phase === next && previous.message === nextMessage) return;
    publishedPhaseRef.current = Object.freeze({ phase: next, message: nextMessage });
    setPhase(next);
    setMessage(nextMessage);
    onPhaseChange?.(next, nextMessage);
  }, [onPhaseChange]);

  const clearRendererActivity = useCallback(() => {
    rendererActiveRef.current = false;
    rendererSessionIdRef.current = undefined;
    panelConfirmationChallengesRef.current.clear();
    if (rendererActiveTimeoutRef.current !== undefined) {
      globalThis.clearTimeout(rendererActiveTimeoutRef.current);
      rendererActiveTimeoutRef.current = undefined;
    }
  }, []);

  const observeRendererPresence = useCallback((payload: unknown, authenticatedSourceSessionId: string) => {
    const presence = parseXrRoutedSessionPresence(payload);
    if (presence.sourceSessionId !== authenticatedSourceSessionId) return;
    const ageMs = Date.now() - presence.serverReceivedAtMs;
    // Reliable polling may retain an old presence while the host is stalled.
    // Never resurrect immersive state from a heartbeat whose server receipt is
    // already older than the lease it is supposed to establish.
    if (ageMs > 10_000 || ageMs < -5_000) return;
    const currentGrant = pairingRef.current;
    if (!controllerRef.current || !currentGrant
      || presence.sourcePairingId !== currentGrant.pairingId) return;
    const pinned = rendererSessionIdRef.current;
    if (pinned && pinned !== presence.sourceSessionId) return;
    rendererSessionIdRef.current = presence.sourceSessionId;
    // Renderer presence is authenticated by both relay provenance and the
    // pairing id. Once observed, remove the consumed code/token from React
    // state and the DOM while retaining only the non-secret pairing id needed
    // to validate later presence and high-risk confirmations.
    setGrant(undefined);
    setCopied(false);
    const previousTransition = lifecycleTransitionsRef.current.at(-1);
    if (previousTransition?.phase !== presence.phase
      || previousTransition.sourceSessionId !== presence.sourceSessionId) {
      const transition = Object.freeze({
        sequence: lifecycleSequenceRef.current + 1,
        phase: presence.phase,
        serverReceivedAtMs: presence.serverReceivedAtMs,
        sourceSessionId: presence.sourceSessionId,
      });
      lifecycleSequenceRef.current = transition.sequence;
      lifecycleTransitionsRef.current = [...lifecycleTransitionsRef.current, transition].slice(-64);
    }
    if (rendererActiveTimeoutRef.current !== undefined) {
      globalThis.clearTimeout(rendererActiveTimeoutRef.current);
      rendererActiveTimeoutRef.current = undefined;
    }
    if (presence.phase !== "active") {
      rendererActiveRef.current = false;
      if (presence.phase === "disconnected" || presence.phase === "expired") {
        rendererSessionIdRef.current = undefined;
        pairingRef.current = undefined;
        setGrant(undefined);
      }
      publish(presence.phase, presence.phase === "immersive_entering"
        ? "Headset paired · WebXR is entering immersive mode."
        : presence.phase === "exiting"
          ? "Headset paired · immersive XR is exiting."
          : presence.phase === "ended"
            ? "Headset paired · immersive XR ended and the live replica remains ready."
          : presence.phase === "expired"
            ? "Headset connection expired; create a fresh one-time pairing."
            : presence.phase === "disconnected"
              ? "Headset disconnected; create a fresh one-time pairing."
              : "Headset projection is ready; enter XR in the paired viewer.");
      return;
    }
    rendererActiveRef.current = true;
    publish("active", "Headset paired · immersive XR is active.");
    rendererActiveTimeoutRef.current = globalThis.setTimeout(() => {
      rendererActiveTimeoutRef.current = undefined;
      if (!rendererActiveRef.current || !controllerRef.current) return;
      rendererActiveRef.current = false;
      rendererSessionIdRef.current = undefined;
      pairingRef.current = undefined;
      setGrant(undefined);
      publish("expired", "Headset presence expired; create a fresh one-time pairing.");
    }, 9_000);
  }, [publish]);

  const router = useMemo(() => new XrHostInputRouter({
    onSelect: (componentId) => callbacksRef.current.onSelect(componentId),
    onActivate: (componentId) => callbacksRef.current.onActivate(componentId),
    onPanelAction: (action) => callbacksRef.current.onPanelAction(action),
    authorizePanelAction: async (action, request: XrPanelAuthorizationRequest) => {
      const currentGrant = pairingRef.current;
      const pinnedRenderer = rendererSessionIdRef.current;
      const now = callbacksRef.current.now?.() ?? Date.now();
      for (const [challengeId, challenge] of panelConfirmationChallengesRef.current) {
        if (challenge.expiresAtMs <= now) panelConfirmationChallengesRef.current.delete(challengeId);
      }
      if (!currentGrant || !pinnedRenderer || pinnedRenderer !== request.rendererSessionId) return false;
      const actionDigest = stableStringify(action);
      if (!request.confirmation) {
        while (panelConfirmationChallengesRef.current.size >= MAXIMUM_PANEL_CONFIRMATION_CHALLENGES) {
          const oldest = panelConfirmationChallengesRef.current.keys().next().value as string | undefined;
          if (!oldest) break;
          panelConfirmationChallengesRef.current.delete(oldest);
        }
        const challengeId = callbacksRef.current.challengeIdFactory?.()
          ?? globalThis.crypto.randomUUID();
        const challenge: XrPanelConfirmationChallenge = Object.freeze({
          challengeId,
          expiresInMs: XR_PANEL_CONFIRMATION_TTL_MS,
          panelId: request.panelId,
          actionLabel: action.actionName,
          targetComponentId: action.targetComponentId,
          workspaceRevision: action.expectedWorkspaceRevision,
        });
        panelConfirmationChallengesRef.current.set(challengeId, Object.freeze({
          rendererSessionId: request.rendererSessionId,
          pairingId: currentGrant.pairingId,
          workspaceRevision: action.expectedWorkspaceRevision,
          panelId: request.panelId,
          actionDigest,
          expiresAtMs: now + XR_PANEL_CONFIRMATION_TTL_MS,
        }));
        return challenge;
      }
      const pending = panelConfirmationChallengesRef.current.get(request.confirmation.challengeId);
      panelConfirmationChallengesRef.current.delete(request.confirmation.challengeId);
      if (!pending
        || pending.expiresAtMs <= now
        || pending.rendererSessionId !== request.rendererSessionId
        || pending.pairingId !== currentGrant.pairingId
        || pending.workspaceRevision !== action.expectedWorkspaceRevision
        || pending.panelId !== request.panelId
        || pending.actionDigest !== actionDigest
        || request.confirmation.decision !== "confirmed") return false;
      return await (callbacksRef.current.authorizePanelAction?.(action) ?? true);
    },
    onVoiceIntent: props.onVoiceIntent
      ? (intent, source: XrAuthenticatedRendererSource) => {
          if (rendererSessionIdRef.current !== source.rendererSessionId) {
            throw new Error("The XR voice request did not come from the pinned renderer.");
          }
          return callbacksRef.current.onVoiceIntent?.(intent);
        }
      : undefined,
    onSpatialInput: props.onSpatialContext
      ? async (message, source: XrAuthenticatedRendererSource) => {
        if (message.inputType !== "pose") return;
        const context = parseXRContextEnvelope(message.payload.context);
        if (context.source !== "immersive-xr") {
          throw new Error("A remote immersive renderer cannot publish simulated XR context.");
        }
        const current = snapshotRef.current;
        if (context.workspaceId !== current.workspaceId || context.workspaceRevision !== current.revision) {
          throw new Error("The remote XR context is stale.");
        }
        const componentIds = new Set(current.components.map((component) => component.id));
        if ((context.selectedComponentId && !componentIds.has(context.selectedComponentId))
          || (context.rayHit?.kind === "component"
            && context.rayHit.targetId !== undefined
            && !componentIds.has(context.rayHit.targetId))
          || context.trackedInputs.some((input) => input.rayHit?.kind === "component"
            && input.rayHit.targetId !== undefined
            && !componentIds.has(input.rayHit.targetId))
          || (context.spatialPin?.targetComponentId !== undefined
            && !componentIds.has(context.spatialPin.targetComponentId))) {
          throw new Error("The remote XR context references an unavailable component.");
        }
        if (!rendererActiveRef.current
          || !rendererSessionIdRef.current
          || rendererSessionIdRef.current !== source.rendererSessionId) {
          throw new Error("The paired renderer has not authenticated an active immersive session.");
        }
        await callbacksRef.current.onSpatialContext?.(context, source);
      }
      : undefined,
  }), [Boolean(props.onSpatialContext), Boolean(props.onVoiceIntent)]);

  const stop = useCallback(async (nextMessage = "Headset session stopped."): Promise<XRHeadsetStopOutcome> => {
    clearRendererActivity();
    pollingRef.current?.abort("session_stopped");
    pollingRef.current = undefined;
    operationAbortRef.current?.abort("session_stopped");
    operationAbortRef.current = undefined;
    const controller = controllerRef.current;
    controllerRef.current = undefined;
    transportRef.current = undefined;
    processedInputResultsRef.current.clear();
    if (!controller) {
      pairingRef.current = undefined;
      setGrant(undefined);
      publish("idle", nextMessage);
      return Object.freeze({ locallyReleased: true, teardownConfirmed: true });
    }
    publish("stopping", "Stopping the headset session…");
    let remotelyConfirmed = false;
    let error: string | undefined;
    try {
      await pairingRotationRef.current.catch(() => undefined);
      const currentGrant = pairingRef.current;
      pairingRef.current = undefined;
      if (currentGrant) await controller.revokePairing(currentGrant.pairingId).catch(() => false);
      remotelyConfirmed = await controller.disconnect();
    } catch (cause) {
      error = friendly(cause);
    } finally {
      if (aliveRef.current) {
        setGrant(undefined);
        setCopied(false);
        publish(
          remotelyConfirmed ? "idle" : "error",
          remotelyConfirmed
            ? nextMessage
            : error ?? "Headset projection was released locally, but relay teardown could not be confirmed.",
        );
      }
    }
    return Object.freeze({
      locallyReleased: true,
      teardownConfirmed: remotelyConfirmed,
      ...(error ? { error } : {}),
    });
  }, [clearRendererActivity, publish]);

  const failSession = useCallback(async (cause: unknown, expected?: XrAuthorityController) => {
    if (expected && controllerRef.current !== expected) return;
    clearRendererActivity();
    pollingRef.current?.abort("session_failed");
    pollingRef.current = undefined;
    operationAbortRef.current?.abort("session_failed");
    operationAbortRef.current = undefined;
    const controller = controllerRef.current;
    controllerRef.current = undefined;
    transportRef.current = undefined;
    processedInputResultsRef.current.clear();
    pairingRef.current = undefined;
    setGrant(undefined);
    setCopied(false);
    await controller?.disconnect().catch(() => undefined);
    publish("error", friendly(cause));
  }, [clearRendererActivity, publish]);

  const publishRealityAssets = useCallback(async (
    currentSnapshot: WorkspaceRenderSnapshot,
    transport: XrAuthorityTransport,
    signal: AbortSignal,
  ) => {
    const descriptors = currentSnapshot.realityAssets ?? [];
    if (descriptors.length === 0) return;
    if (!supportsAssetPublishing(transport)) {
      throw new Error("This XR transport cannot verify and publish the Workspace's Reality Asset bytes.");
    }
    for (const [index, descriptor] of descriptors.entries()) {
      if (signal.aborted) throw new DOMException("XR asset publishing cancelled", "AbortError");
      const format = assetFormat(descriptor.format);
      if (await transport.hasAsset(descriptor.digest, format, descriptor.byteLength, signal)) continue;
      const openRealityAsset = callbacksRef.current.openRealityAsset;
      if (!openRealityAsset) {
        throw new Error(`Reality Asset ${descriptor.assetId} was evicted and its host bytes are unavailable.`);
      }
      if (aliveRef.current) {
        setMessage(`Publishing Reality Asset ${index + 1} of ${descriptors.length}…`);
      }
      const blob = await openRealityAsset(descriptor.assetId, descriptor.digest, signal);
      if (!blob || blob.size !== descriptor.byteLength) {
        throw new Error(`Reality Asset ${descriptor.assetId} is unavailable or does not match its descriptor.`);
      }
      await transport.putAsset(
        blob,
        descriptor.digest,
        format,
        XR_ASSET_TTL_MS,
        signal,
      );
    }
    // A bounded final pass catches LRU churn caused by the uploads themselves.
    // If the current working set cannot remain resident together, fail before
    // publishing a snapshot that would contain a dangling asset reference.
    for (const descriptor of descriptors) {
      if (signal.aborted) throw new DOMException("XR asset publishing cancelled", "AbortError");
      const resident = await transport.hasAsset(
        descriptor.digest,
        assetFormat(descriptor.format),
        descriptor.byteLength,
        signal,
      );
      if (!resident) {
        throw new Error("The XR relay cannot keep the current Reality Asset set resident within its bounded cache.");
      }
    }
  }, []);

  const beginPolling = useCallback((controller: XrAuthorityController) => {
    pollingRef.current?.abort("replaced");
    const abort = new AbortController();
    pollingRef.current = abort;
    void (async () => {
      let consecutiveFailures = 0;
      while (!abort.signal.aborted && controllerRef.current === controller) {
        try {
          const incoming = await controller.pollInputs();
          consecutiveFailures = 0;
          for (const delivery of incoming) {
            if (delivery.message.messageType === "input") {
              let resultPayload = processedInputResultsRef.current.get(delivery.message.requestId);
              if (!resultPayload) {
                const result = await router.route(
                  delivery.message,
                  snapshotRef.current,
                  Object.freeze({
                    rendererSessionId: delivery.sourceSessionId,
                    serverReceivedAtMs: delivery.serverReceivedAtMs,
                    serverQueueAgeMs: delivery.serverQueueAgeMs,
                  }),
                );
                resultPayload = createXrInputResultPayload(delivery.message, result);
                processedInputResultsRef.current.set(delivery.message.requestId, resultPayload);
                if (processedInputResultsRef.current.size > 512) {
                  const oldest = processedInputResultsRef.current.keys().next().value as string | undefined;
                  if (oldest) processedInputResultsRef.current.delete(oldest);
                }
              }
              // Publish the host-handled result before acknowledging the input.
              // If the poll response is lost, the bounded request cache prevents
              // the durable action from running twice while the result is retried.
              // High-rate renderer pose telemetry is explicitly fire-and-forget.
              // The relay marks it complete on acceptance, so sending a reliable
              // result for every sample would only consume the action-result queue.
              if (delivery.message.inputType !== "pose") {
                await controller.publishEphemeral(XR_INPUT_RESULT_CHANNEL, resultPayload);
              }
            } else if (delivery.message.channel === XR_SESSION_PRESENCE_CHANNEL) {
              observeRendererPresence(delivery.message.payload, delivery.sourceSessionId);
            }
            controller.acknowledgeInput(delivery.deliveryId);
          }
        } catch (cause) {
          consecutiveFailures += 1;
          if (consecutiveFailures >= 3) {
            abort.abort("poll_failed");
            await failSession(cause, controller);
            return;
          }
        }
        await delay(pollIntervalMs, abort.signal);
      }
    })();
  }, [failSession, observeRendererPresence, pollIntervalMs, router]);

  const mintPairing = useCallback((
    controller: XrAuthorityController,
    voiceRelay: boolean = voiceRelayEnabledRef.current,
  ): Promise<void> => {
    const operation = pairingRotationRef.current.then(async () => {
      if (controllerRef.current !== controller) return;
      // Validate the renderer origin before revoking an existing grant or
      // minting a new capability. An insecure LAN URL must never receive a
      // fragment secret, even transiently.
      canonicalXrViewerUrl(viewerUrl);
      clearRendererActivity();
      const previous = pairingRef.current;
      pairingRef.current = undefined;
      setGrant(undefined);
      if (previous) {
        try {
          await controller.revokePairing(previous.pairingId);
        } catch (cause) {
          // A capability-policy rotation cannot mint its replacement until the
          // old renderer is proven revoked. Tear down the entire authority
          // epoch on an unresolved result so the UI never presents a false
          // downgrade while an older voiceRelay:true renderer may survive.
          pollingRef.current?.abort("pairing_revocation_unresolved");
          pollingRef.current = undefined;
          operationAbortRef.current?.abort("pairing_revocation_unresolved");
          operationAbortRef.current = undefined;
          if (controllerRef.current === controller) controllerRef.current = undefined;
          transportRef.current = undefined;
          await controller.disconnect().catch(() => undefined);
          publish("error", "The previous headset capability could not be proven revoked. Start a fresh XR authority session before pairing again.");
          throw cause;
        }
      }
      if (controllerRef.current !== controller) return;
      const next = await controller.createPairing(5 * 60_000, { voiceRelay });
      // Validate configuration before retaining the one-time secret in React state.
      pairingUrl(viewerUrl, next.pairingToken);
      if (controllerRef.current !== controller) {
        await controller.revokePairing(next.pairingId).catch(() => false);
        return;
      }
      pairingRef.current = Object.freeze({ pairingId: next.pairingId });
      setGrant(next);
      setCopied(false);
      publish("pairing", "Projection ready. Enter the six-digit code or open the secure link, then enter XR.");
    });
    pairingRotationRef.current = operation.catch(() => undefined);
    return operation;
  }, [clearRendererActivity, publish, viewerUrl]);

  const start = useCallback(async () => {
    if (controllerRef.current || phase === "starting") return;
    publish("starting", "Starting the authoritative XR projection…");
    let attemptedController: XrAuthorityController | undefined;
    try {
      // Fail closed before authority connect/createPairing. Loopback HTTP is
      // intentionally retained for the same-machine simulator only.
      canonicalXrViewerUrl(viewerUrl);
      const transport = props.transportFactory?.()
        ?? new XrAuthorityHttpTransport({ baseUrl: globalThis.location.origin });
      const operationAbort = new AbortController();
      operationAbortRef.current = operationAbort;
      transportRef.current = transport;
      const controller = new XrAuthorityController(transport, {
        prepareSnapshot: (candidate) => publishRealityAssets(candidate, transport, operationAbort.signal),
      });
      attemptedController = controller;
      controllerRef.current = controller;
      await controller.connect(snapshotRef.current, registryIdentity);
      if (!aliveRef.current || controllerRef.current !== controller) {
        await controller.disconnect();
        return;
      }
      await mintPairing(controller, voiceRelayEnabledRef.current);
      beginPolling(controller);
    } catch (cause) {
      await failSession(cause, attemptedController);
    }
  }, [beginPolling, failSession, mintPairing, phase, props.transportFactory, publish, publishRealityAssets, registryIdentity, viewerUrl]);

  useEffect(() => {
    const controller = controllerRef.current;
    const transport = transportRef.current;
    const operationAbort = operationAbortRef.current;
    if (!controller || !transport || !operationAbort || ![
      "pairing",
      "replica_ready",
      "immersive_entering",
      "active",
      "exiting",
      "ended",
    ].includes(phase)) return;
    void controller.sync(snapshot, registryIdentity).catch((cause) => {
      void failSession(cause, controller);
    });
  }, [failSession, phase, registryIdentity, snapshot]);

  useEffect(() => {
    // React StrictMode intentionally runs setup -> cleanup -> setup in
    // development. Restore the mounted sentinel during every setup pass so a
    // subsequent user-initiated session is not mistaken for stale work.
    aliveRef.current = true;
    return () => {
      aliveRef.current = false;
      clearRendererActivity();
      pollingRef.current?.abort("unmounted");
      operationAbortRef.current?.abort("unmounted");
      void controllerRef.current?.disconnect();
      controllerRef.current = undefined;
      transportRef.current = undefined;
    };
  }, [clearRendererActivity]);

  useEffect(() => {
    if (desktopControlsVisible) return;
    setOpen(false);
    setCopied(false);
  }, [desktopControlsVisible]);

  const link = grant ? pairingUrl(viewerUrl, grant.pairingToken) : undefined;
  const copy = async () => {
    if (!link) return;
    try {
      await globalThis.navigator.clipboard.writeText(link);
      setCopied(true);
      setMessage("One-time pairing link copied. It expires in five minutes and can be used once.");
    } catch {
      setMessage("Clipboard access was denied. Open the link directly or copy it from the field.");
    }
  };
  const copyPairingCode = async () => {
    if (!grant) return;
    try {
      await globalThis.navigator.clipboard.writeText(grant.pairingCode);
      setMessage("Six-digit pairing code copied. It expires in five minutes and can be used once.");
    } catch {
      setMessage("Clipboard access was denied. Type the six-digit code shown here into the headset.");
    }
  };

  const busy = phase === "starting" || phase === "stopping";
  useImperativeHandle(ref, () => ({
    inspect: () => ({
      phase,
      message,
      pairingReady: Boolean(grant),
      lifecycleSequence: lifecycleSequenceRef.current,
      ...(lifecycleTransitionsRef.current.at(-1)
        ? { lastLifecyclePhase: lifecycleTransitionsRef.current.at(-1)!.phase }
        : {}),
    }),
    prepare: async () => {
      setOpen(true);
      if (!controllerRef.current) await start();
      else if (!pairingRef.current) await mintPairing(controllerRef.current);
      return {
        phase: controllerRef.current ? (rendererActiveRef.current ? "active" : "pairing") : phase,
        message: controllerRef.current
          ? "Headset projection is prepared. Enter the six-digit code or open the secure link in the headset."
          : message,
        pairingReady: Boolean(controllerRef.current),
        lifecycleSequence: lifecycleSequenceRef.current,
        ...(lifecycleTransitionsRef.current.at(-1)
          ? { lastLifecyclePhase: lifecycleTransitionsRef.current.at(-1)!.phase }
          : {}),
      };
    },
    readLifecycleTransition: (afterSequence) => lifecycleTransitionsRef.current.find(
      (transition) => transition.sequence > afterSequence,
    ),
    showPairing: () => setOpen(true),
    setVoiceRelayEnabled: async (enabled) => {
      if (voiceRelayEnabledRef.current === enabled) return;
      voiceRelayEnabledRef.current = enabled;
      const controller = controllerRef.current;
      if (controller) await mintPairing(controller, enabled);
    },
    requestExit: async () => {
      const controller = controllerRef.current;
      const targetSessionId = rendererSessionIdRef.current;
      if (!controller || !rendererActiveRef.current || !targetSessionId) return false;
      await controller.publishEphemeral(XR_SESSION_CONTROL_CHANNEL, {
        action: "request_exit",
        targetSessionId,
      });
      return true;
    },
    stop: () => stop(),
  }), [grant, message, mintPairing, phase, start, stop]);
  const sessionPrepared = [
    "pairing",
    "replica_ready",
    "immersive_entering",
    "active",
    "exiting",
    "ended",
    "disconnected",
    "expired",
  ].includes(phase);
  return <>
    {desktopControlsVisible && <button
      type="button"
      className={`viewport-xr-toggle${sessionPrepared ? " is-active" : ""}`}
      onClick={() => setOpen(true)}
      disabled={disabled}
      aria-label={sessionPrepared ? "Manage XR headset session" : "Connect XR headset"}
      title={sessionPrepared ? "Manage XR headset session" : "Connect a separate XR headset"}
      aria-pressed={sessionPrepared}
    >
      {busy ? <LoaderCircle className="spin-slow" size={17} aria-hidden="true" /> : <Headset size={17} aria-hidden="true" />}
    </button>}
    {desktopControlsVisible && open && createPortal(<div className="xr-headset-modal-backdrop" role="presentation" onMouseDown={(event) => {
      if (event.target === event.currentTarget) setOpen(false);
    }}>
      <section className="xr-headset-modal" role="dialog" aria-modal="true" aria-labelledby="xr-headset-title">
        <header>
          <div><span>Remote renderer</span><h2 id="xr-headset-title">XR headset session</h2></div>
          <button type="button" onClick={() => setOpen(false)} aria-label="Close XR headset session"><X size={18} /></button>
        </header>
        <p className="xr-headset-status" role="status" data-phase={phase}>{message}</p>
        {phase === "idle" || phase === "error" ? <>
          <p>The desktop remains the only Workspace authority. The headset receives a revisioned projection and sends typed, revalidated actions back.</p>
          <button type="button" className="xr-headset-primary" onClick={() => void start()} disabled={busy}>
            <Link2 size={16} /> Start headset session
          </button>
        </> : null}
        {sessionPrepared && link && grant ? <div className="xr-headset-link-card">
          <label htmlFor="xr-headset-pairing-code"><strong>6-digit pairing code</strong></label>
          <input
            id="xr-headset-pairing-code"
            aria-label="XR six-digit pairing code"
            readOnly
            value={grant.pairingCode}
            onFocus={(event) => event.currentTarget.select()}
            style={{
              fontSize: "clamp(2rem, 7vw, 3rem)",
              fontVariantNumeric: "tabular-nums",
              fontWeight: 760,
              letterSpacing: ".18em",
              textAlign: "center",
            }}
          />
          <div>
            <button type="button" onClick={() => void copyPairingCode()}><Copy size={15} /> Copy code</button>
          </div>
          <strong>Secure one-time link</strong>
          <input aria-label="XR one-time pairing link" readOnly value={link} onFocus={(event) => event.currentTarget.select()} />
          <div>
            <button type="button" onClick={() => void copy()}><Copy size={15} /> {copied ? "Copied" : "Copy link"}</button>
            <a href={link} target="_blank" rel="noreferrer"><Headset size={15} /> Open viewer</a>
            <button type="button" onClick={() => void mintPairing(controllerRef.current!)}><RefreshCw size={15} /> New code</button>
          </div>
          <small>Type the six digits on another device, or open the secure link directly. Both are single-use and expire together after five minutes; the link secret is scrubbed before pairing.</small>
        </div> : null}
        {(phase === "disconnected" || phase === "expired") && controllerRef.current ? <button
          type="button"
          className="xr-headset-primary"
          onClick={() => void mintPairing(controllerRef.current!)}
        ><RefreshCw size={16} /> Create fresh pairing code</button> : null}
        {sessionPrepared || phase === "starting" ? <button
          type="button"
          className="xr-headset-stop"
          onClick={() => void stop()}
          disabled={phase === "starting"}
        ><Square size={14} /> Stop session</button> : null}
      </section>
    </div>, document.body)}
  </>;
});

export const __xrHeadsetSessionTest = Object.freeze({
  pairingUrl,
  canonicalViewerUrl: canonicalXrViewerUrl,
});
