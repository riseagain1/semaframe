import { Glasses, LoaderCircle } from "lucide-react";
import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from "react";
import type { HybridWorkspaceCanvasHandle } from "./workspace/HybridWorkspaceCanvas";
import {
  WebXRRuntimeAdapter,
  type WebXRSessionAdapter,
} from "../../xr/webxr";
import {
  UltraLocalActivationController,
  ultraLocalEvidencePortFromHost,
  type UltraLocalActivationSnapshot,
  type UltraLocalEvidencePort,
} from "../../xr/ultra";

export type XRWorkspaceButtonPhase =
  | "probing"
  | "ready"
  | "unsupported"
  | "requesting"
  | "active"
  | "ending"
  | "error";

export type XRWorkspaceRuntime = Pick<WebXRRuntimeAdapter, "probe" | "requestSession">;

export type XRWorkspaceButtonProps = Readonly<{
  getCanvas: () => HybridWorkspaceCanvasHandle | null;
  disabled?: boolean;
  runtime?: XRWorkspaceRuntime;
  ultraEvidence?: UltraLocalEvidencePort;
  confirmUltraActivation?: () => boolean;
  onPhaseChange?: (phase: XRWorkspaceButtonPhase, message: string) => void;
}>;

export type XRWorkspaceButtonHandle = Readonly<{
  inspect(): Readonly<{
    phase: XRWorkspaceButtonPhase;
    message: string;
    renderProfile: string;
  }>;
  /** Must be called synchronously from the user's click/select handler. */
  enterFromUserGesture(): Promise<void>;
  exitFromUserGesture(): Promise<void>;
}>;

const READY_MESSAGE = "Enter immersive XR";

/**
 * User-gesture boundary for same-device WebXR. The renderer stays a projection
 * of the existing browser-authoritative Workspace; this control never creates
 * or mutates Workspace state by itself.
 */
export const XRWorkspaceButton = forwardRef<XRWorkspaceButtonHandle, XRWorkspaceButtonProps>(function XRWorkspaceButton({
  getCanvas,
  disabled = false,
  runtime,
  ultraEvidence,
  confirmUltraActivation,
  onPhaseChange,
}: XRWorkspaceButtonProps, ref) {
  const runtimeRef = useRef<XRWorkspaceRuntime>(runtime ?? new WebXRRuntimeAdapter());
  const ultraEvidenceRef = useRef(ultraEvidence ?? ultraLocalEvidencePortFromHost());
  const ultraControllerRef = useRef(new UltraLocalActivationController(ultraEvidenceRef.current));
  const ultraAbortRef = useRef<AbortController | undefined>(undefined);
  const sessionRef = useRef<WebXRSessionAdapter | null>(null);
  const intentionalEndRef = useRef<WebXRSessionAdapter | null>(null);
  const lifecycleGenerationRef = useRef(0);
  const mountedRef = useRef(true);
  const [phase, setPhaseState] = useState<XRWorkspaceButtonPhase>("probing");
  const [message, setMessageState] = useState("Checking this browser for WebXR…");
  const [ultra, setUltra] = useState<UltraLocalActivationSnapshot>(ultraControllerRef.current.snapshot);

  const publish = (next: XRWorkspaceButtonPhase, nextMessage: string) => {
    if (!mountedRef.current) return;
    setPhaseState(next);
    setMessageState(nextMessage);
    onPhaseChange?.(next, nextMessage);
  };

  useEffect(() => {
    mountedRef.current = true;
    let cancelled = false;
    void runtimeRef.current.probe().then((capability) => {
      if (cancelled) return;
      if (capability.available && capability.sessionModes.includes("immersive-vr")) {
        publish("ready", READY_MESSAGE);
      } else {
        publish("unsupported", "Immersive WebXR is unavailable in this browser");
      }
    }).catch(() => {
      if (!cancelled) publish("error", "WebXR capability detection failed");
    });
    return () => {
      cancelled = true;
      mountedRef.current = false;
      lifecycleGenerationRef.current += 1;
      ultraAbortRef.current?.abort("workspace_xr_unmounted");
      const canvas = getCanvas();
      intentionalEndRef.current = sessionRef.current;
      if (sessionRef.current || canvas?.isXRPresenting()) void canvas?.exitXR().catch(() => undefined);
      sessionRef.current = null;
    };
    // The canvas accessor is a stable App boundary; changing it must not tear
    // down a user-activated session during an ordinary React render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const enter = async () => {
    const canvas = getCanvas();
    if (!canvas) {
      publish("error", "The 3D renderer is not ready yet");
      return;
    }
    const generation = lifecycleGenerationRef.current + 1;
    lifecycleGenerationRef.current = generation;
    const isCurrent = () => mountedRef.current && lifecycleGenerationRef.current === generation;
    publish("requesting", "Waiting for XR permission…");
    let session: WebXRSessionAdapter | undefined;
    try {
      session = await runtimeRef.current.requestSession({
        mode: "immersive-vr",
        requiredFeatures: ["local-floor"],
        optionalFeatures: ["bounded-floor", "hand-tracking", "layers"],
      });
      if (!isCurrent()) {
        intentionalEndRef.current = session;
        await session.end().catch(() => undefined);
        if (intentionalEndRef.current === session) intentionalEndRef.current = null;
        return;
      }
      const profile = await ultraControllerRef.current.profileForEntry();
      if (!isCurrent()) {
        intentionalEndRef.current = session;
        await session.end().catch(() => undefined);
        if (intentionalEndRef.current === session) intentionalEndRef.current = null;
        return;
      }
      setUltra(ultraControllerRef.current.snapshot);
      sessionRef.current = session;
      session.onEnded(() => {
        if (sessionRef.current !== session) return;
        // A user exit or failed renderer attachment already owns teardown. Do
        // not enqueue a second canvas exit from the synchronous WebXR end event.
        if (intentionalEndRef.current === session) return;
        publish("ending", "Cleaning up the ended XR session…");
        void getCanvas()?.exitXR().then(() => {
          if (sessionRef.current !== session) return;
          sessionRef.current = null;
          publish("ready", READY_MESSAGE);
        }).catch((cause) => {
          if (sessionRef.current !== session) return;
          sessionRef.current = null;
          publish("error", cause instanceof Error ? cause.message : "XR teardown failed");
        });
      });
      await canvas.enterXR(session.rawSession, {
        referenceSpaceType: session.referenceSpace === "bounded-floor" ? "bounded-floor" : "local-floor",
        framebufferScaleFactor: profile.framebufferScaleFactor,
        foveation: profile.foveation,
        targetFrameRateHz: profile.targetFrameRateHz,
        teleport: true,
      });
      publish("active", "Exit immersive XR");
    } catch (cause) {
      const current = isCurrent();
      if (session && current) {
        intentionalEndRef.current = session;
        await session.end().catch(() => undefined);
        if (intentionalEndRef.current === session) intentionalEndRef.current = null;
      }
      if (sessionRef.current === session) sessionRef.current = null;
      if (current) publish("error", cause instanceof Error ? cause.message : "XR could not start");
    }
  };

  const verifyUltra = async () => {
    if (!ultraEvidenceRef.current || ultra.phase === "benchmarking" || ultra.phase === "confirming") return;
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
        // The explicit second-stage button is the user confirmation. Avoid a
        // modal that can consume the transient activation required by WebXR.
        confirm: confirmUltraActivation ?? (() => true),
      });
      if (!abort.signal.aborted) setUltra(snapshot);
    } catch (cause) {
      if (abort.signal.aborted) return;
      setUltra({
        phase: "locked",
        message: cause instanceof Error ? cause.message : "Windows PCVR Ultra verification failed.",
        profile: ultraControllerRef.current.snapshot.profile,
      });
    }
  };

  const exit = async () => {
    publish("ending", "Ending XR session…");
    const session = sessionRef.current;
    intentionalEndRef.current = session;
    try {
      await getCanvas()?.exitXR();
      sessionRef.current = null;
      publish("ready", READY_MESSAGE);
    } catch (cause) {
      publish("error", cause instanceof Error ? cause.message : "XR could not end cleanly");
    } finally {
      if (intentionalEndRef.current === session) intentionalEndRef.current = null;
    }
  };

  useImperativeHandle(ref, () => ({
    inspect: () => ({ phase, message, renderProfile: ultra.profile.mode }),
    enterFromUserGesture: enter,
    exitFromUserGesture: exit,
  }), [message, phase, ultra.profile.mode]);

  const busy = phase === "probing" || phase === "requesting" || phase === "ending";
  const unavailable = phase === "unsupported";
  const ultraBusy = ultra.phase === "probing" || ultra.phase === "confirming" || ultra.phase === "benchmarking";
  return <span className="viewport-xr-controls">
    <button
      type="button"
      className={`viewport-xr-toggle${phase === "active" ? " is-active" : ""}`}
      data-xr-phase={phase}
      data-xr-render-profile={ultra.profile.mode}
      onClick={() => { if (phase === "active") void exit(); else void enter(); }}
      disabled={disabled || busy || unavailable || ultraBusy}
      title={`${message} · ${ultra.profile.label}`}
      aria-label={message}
      aria-pressed={phase === "active"}
    >
      {busy ? <LoaderCircle className="spin-slow" size={17} aria-hidden="true" /> : <Glasses size={17} aria-hidden="true" />}
    </button>
    {ultraEvidenceRef.current && <button
      type="button"
      className={`viewport-xr-ultra${ultra.phase === "eligible" ? " is-active" : ""}`}
      data-xr-ultra-phase={ultra.phase}
      onClick={() => void verifyUltra()}
      disabled={disabled || phase === "active" || ultraBusy || ultra.phase === "eligible"}
      title={ultra.message}
      aria-label={ultra.phase === "eligible"
        ? "Windows PCVR Ultra enabled"
        : ultra.phase === "unprobed" || ultra.phase === "probing"
          ? "Check Windows PCVR Ultra compatibility"
          : "Start Windows PCVR Ultra benchmark"}
    >{ultraBusy ? <LoaderCircle className="spin-slow" size={14} aria-hidden="true" /> : "Ultra"}</button>}
  </span>;
});
