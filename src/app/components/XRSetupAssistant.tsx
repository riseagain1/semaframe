import {
  CheckCircle2,
  CircleHelp,
  Copy,
  Headset,
  Laptop,
  LoaderCircle,
  Mic2,
  RefreshCw,
  ShieldCheck,
  Square,
  TriangleAlert,
  X,
} from "lucide-react";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type Ref,
} from "react";
import { createPortal } from "react-dom";
import {
  XRHeadsetSessionButton,
  DEFAULT_XR_VIEWER_URL,
  isLoopbackXrViewerHost,
  type XRHeadsetSessionButtonHandle,
  type XRHeadsetSessionButtonProps,
  type XRHeadsetSessionPhase,
} from "./XRHeadsetSessionButton";
import {
  XRWorkspaceButton,
  type XRWorkspaceButtonHandle,
  type XRWorkspaceButtonPhase,
  type XRWorkspaceButtonProps,
} from "./XRWorkspaceButton";
import "./XRSetupAssistant.css";

export type XRSetupMode = "same_device" | "remote_headset" | "windows_ultra";

export type XRViewerReadiness = Readonly<{
  address: string;
  valid: boolean;
  usesHttps: boolean;
  remotelyAddressable: boolean;
  configuredForRemoteHeadset: boolean;
  message: string;
}>;

export type XRSetupAssistantProps = Readonly<{
  disabled?: boolean;
  sameDeviceRef?: Ref<XRWorkspaceButtonHandle>;
  headsetRef?: Ref<XRHeadsetSessionButtonHandle>;
  sameDevice: XRWorkspaceButtonProps;
  headset: XRHeadsetSessionButtonProps;
  voiceRelayArmed: boolean;
  voiceRelayTargetLabel?: string;
  onConfigureVoiceRelay(): void;
}>;

type SameDeviceInspection = ReturnType<XRWorkspaceButtonHandle["inspect"]>;
type HeadsetInspection = Readonly<{
  phase: XRHeadsetSessionPhase;
  message: string;
}>;

const INITIAL_SAME_DEVICE: SameDeviceInspection = Object.freeze({
  phase: "probing",
  message: "Checking this browser for WebXR…",
  renderProfile: "balanced",
  ultraAvailable: false,
  ultraPhase: "unavailable",
  ultraMessage: "Windows PCVR Ultra requires a trusted local evidence bridge.",
});

const INITIAL_HEADSET: HeadsetInspection = Object.freeze({
  phase: "idle" as XRHeadsetSessionPhase,
  message: "Start a renderer-only headset session.",
});

/**
 * Configuration-only check. It deliberately does not claim that a router,
 * firewall, browser, or headset has been reached or hardware-certified.
 */
export function assessXrViewerReadiness(
  value: string,
  baseHref = "http://127.0.0.1/",
): XRViewerReadiness {
  try {
    const url = new URL(value, baseHref);
    const valid = (url.protocol === "http:" || url.protocol === "https:")
      && !url.username
      && !url.password
      && !url.search
      && !url.hash;
    const usesHttps = valid && url.protocol === "https:";
    const remotelyAddressable = valid
      && !isLoopbackXrViewerHost(url.hostname)
      && url.hostname !== "0.0.0.0"
      && url.hostname !== "::";
    const configuredForRemoteHeadset = valid && usesHttps && remotelyAddressable;
    const message = !valid
      ? "Use an HTTP(S) viewer page without credentials, query parameters, or a fragment."
      : !remotelyAddressable
        ? "This address points back to the device that opens it. For Quest, set VITE_XR_PUBLIC_URL to a reachable HTTPS xr.html address. For a local simulator, use the separate headset control on this computer."
        : !usesHttps
          ? "Remote XR is blocked on plain HTTP. Set VITE_XR_PUBLIC_URL to the reachable HTTPS xr.html address, then restart SemaFrame."
          : "The address is configured for a separate headset. Physical headset and network reachability remain unverified until the viewer connects.";
    return Object.freeze({
      address: valid ? url.toString() : value,
      valid,
      usesHttps,
      remotelyAddressable,
      configuredForRemoteHeadset,
      message,
    });
  } catch {
    return Object.freeze({
      address: value,
      valid: false,
      usesHttps: false,
      remotelyAddressable: false,
      configuredForRemoteHeadset: false,
      message: "Enter a valid HTTP(S) XR viewer address.",
    });
  }
}

function assignRef<T>(ref: Ref<T> | undefined, value: T | null): void {
  if (typeof ref === "function") ref(value);
  else if (ref) (ref as { current: T | null }).current = value;
}

function readinessLabel(phase: XRWorkspaceButtonPhase): string {
  if (phase === "active") return "Active";
  if (phase === "ready") return "Ready";
  if (phase === "unsupported") return "Unavailable";
  if (phase === "error") return "Needs attention";
  return "Checking";
}

function headsetLabel(phase: XRHeadsetSessionPhase): string {
  if (phase === "active") return "Active";
  if (["pairing", "replica_ready", "immersive_entering", "exiting", "ended"].includes(phase)) return "Prepared";
  if (phase === "idle") return "Not started";
  if (phase === "starting" || phase === "stopping") return "Working";
  return "Needs attention";
}

export function XRSetupAssistant(props: XRSetupAssistantProps) {
  const sameDeviceControlRef = useRef<XRWorkspaceButtonHandle | null>(null);
  const headsetControlRef = useRef<XRHeadsetSessionButtonHandle | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const closeRef = useRef<HTMLButtonElement | null>(null);
  const [open, setOpen] = useState(false);
  const [mode, setMode] = useState<XRSetupMode>("same_device");
  const [sameDevice, setSameDevice] = useState<SameDeviceInspection>(INITIAL_SAME_DEVICE);
  const [headset, setHeadset] = useState(INITIAL_HEADSET);
  const [feedback, setFeedback] = useState("");
  const [operation, setOperation] = useState<"copy" | "probe" | "enter" | "ultra" | "stop" | null>(null);

  const configuredViewerUrl = props.headset.viewerUrl
    ?? (import.meta.env.VITE_XR_PUBLIC_URL?.trim() || DEFAULT_XR_VIEWER_URL);
  const viewerReadiness = useMemo(() => assessXrViewerReadiness(
    configuredViewerUrl,
    globalThis.location?.href ?? "http://127.0.0.1/",
  ), [configuredViewerUrl]);

  const captureSameDeviceRef = useCallback((value: XRWorkspaceButtonHandle | null) => {
    sameDeviceControlRef.current = value;
    assignRef(props.sameDeviceRef, value);
  }, [props.sameDeviceRef]);

  const captureHeadsetRef = useCallback((value: XRHeadsetSessionButtonHandle | null) => {
    headsetControlRef.current = value;
    assignRef(props.headsetRef, value);
  }, [props.headsetRef]);

  const openAssistant = () => {
    const sameInspection = sameDeviceControlRef.current?.inspect();
    if (sameInspection) setSameDevice(sameInspection);
    const headsetInspection = headsetControlRef.current?.inspect();
    if (headsetInspection) setHeadset({ phase: headsetInspection.phase, message: headsetInspection.message });
    setFeedback("");
    setOpen(true);
  };

  const closeAssistant = useCallback(() => {
    setOpen(false);
    globalThis.setTimeout(() => triggerRef.current?.focus(), 0);
  }, []);

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      closeAssistant();
    };
    globalThis.addEventListener("keydown", onKeyDown);
    globalThis.setTimeout(() => closeRef.current?.focus(), 0);
    return () => globalThis.removeEventListener("keydown", onKeyDown);
  }, [closeAssistant, open]);

  const refreshSameDevice = () => {
    const control = sameDeviceControlRef.current;
    if (!control) return;
    setOperation("probe");
    setFeedback("Rechecking this browser for immersive WebXR…");
    const pending = control.refreshReadiness();
    void pending.finally(() => {
      setOperation(null);
    });
  };

  const enterSameDevice = () => {
    const control = sameDeviceControlRef.current;
    if (!control) return;
    // Keep this call in the click stack: WebXR session requests require a
    // transient user gesture and cannot be started by an Agent in the background.
    const pending = control.enterFromUserGesture();
    setOperation("enter");
    setFeedback("Complete the browser's XR permission prompt on this device.");
    void pending.finally(() => {
      setOperation(null);
    });
  };

  const exitSameDevice = () => {
    const control = sameDeviceControlRef.current;
    if (!control) return;
    setOperation("enter");
    setFeedback("Ending the same-device XR session…");
    void control.exitFromUserGesture().then((outcome) => {
      setFeedback(outcome.teardownConfirmed
        ? "Same-device XR ended."
        : outcome.error ?? "XR was released locally, but teardown was not confirmed.");
    }).finally(() => {
      setOperation(null);
    });
  };

  const verifyUltra = () => {
    const control = sameDeviceControlRef.current;
    if (!control) return;
    // The existing control owns the trusted probe, explicit confirmation, and
    // physical benchmark. This assistant never substitutes a claimed result.
    const pending = control.verifyUltraFromUserGesture();
    setOperation("ultra");
    setFeedback("Running the next explicit Windows Ultra eligibility step…");
    void pending.finally(() => {
      const inspection = sameDeviceControlRef.current?.inspect() ?? control.inspect();
      setSameDevice(inspection);
      setFeedback(inspection.ultraMessage);
      setOperation(null);
    });
  };

  const prepareRemoteHeadset = () => {
    const control = headsetControlRef.current;
    if (!control) return;
    // The detailed pairing dialog is the only place that renders the one-time
    // code/link. Closing this guide avoids overlapping modals and secrets.
    setOpen(false);
    const pending = control.prepare();
    void pending.catch(() => undefined);
  };

  const showRemotePairing = () => {
    setOpen(false);
    headsetControlRef.current?.showPairing();
  };

  const configureVoiceRelayFromAssistant = () => {
    // Avoid stacking two modal focus scopes. The dedicated settings dialog
    // owns focus and all sensitive target/arm confirmations from here.
    setOpen(false);
    props.onConfigureVoiceRelay();
  };

  const stopRemoteHeadset = () => {
    const control = headsetControlRef.current;
    if (!control) return;
    setOperation("stop");
    setFeedback("Stopping the remote projection and revoking its pairing…");
    void control.stop().then((outcome) => {
      setFeedback(outcome.teardownConfirmed
        ? "Remote headset session stopped and pairing revoked."
        : outcome.error ?? "Released locally, but relay teardown was not confirmed.");
    }).finally(() => {
      const inspection = headsetControlRef.current?.inspect() ?? control.inspect();
      setHeadset({ phase: inspection.phase, message: inspection.message });
      setOperation(null);
    });
  };

  const copyViewerAddress = () => {
    const clipboard = globalThis.navigator.clipboard;
    if (!clipboard) {
      setFeedback("Clipboard access is unavailable. Select the address and copy it manually.");
      return;
    }
    setOperation("copy");
    void clipboard.writeText(viewerReadiness.address).then(() => {
      setFeedback("Viewer address copied. Open it in the Quest or remote headset browser.");
    }).catch(() => {
      setFeedback("Clipboard access was denied. Select the address and copy it manually.");
    }).finally(() => setOperation(null));
  };

  const samePhaseChanged = (phase: XRWorkspaceButtonPhase, message: string) => {
    setSameDevice((current) => ({ ...current, phase, message }));
    props.sameDevice.onPhaseChange?.(phase, message);
  };

  const headsetPhaseChanged = (phase: XRHeadsetSessionPhase, message: string) => {
    setHeadset({ phase, message });
    props.headset.onPhaseChange?.(phase, message);
  };

  const remotePrepared = [
    "pairing",
    "replica_ready",
    "immersive_entering",
    "active",
    "exiting",
    "ended",
  ].includes(headset.phase);
  const remoteRunning = headset.phase !== "idle" && headset.phase !== "error";

  return <span className="viewport-xr-controls">
    <button
      type="button"
      className={`viewport-xr-toggle${props.voiceRelayArmed ? " is-active" : ""}`}
      disabled={props.disabled}
      aria-label="Configure optional Voice Relay"
      title="Optional relay for a text-only Agent; not needed for a voice Agent using the computer microphone"
      aria-pressed={props.voiceRelayArmed}
      onClick={props.onConfigureVoiceRelay}
    >
      <Mic2 size={17} aria-hidden="true" />
    </button>
    <XRWorkspaceButton
      {...props.sameDevice}
      ref={captureSameDeviceRef}
      disabled={props.disabled || props.sameDevice.disabled}
      onPhaseChange={samePhaseChanged}
    />
    <XRHeadsetSessionButton
      {...props.headset}
      ref={captureHeadsetRef}
      disabled={props.disabled || props.headset.disabled}
      onPhaseChange={headsetPhaseChanged}
    />
    <button
      ref={triggerRef}
      type="button"
      className="viewport-xr-setup"
      disabled={props.disabled}
      aria-label="Open XR setup assistant"
      title="Choose and set up an XR mode"
      onClick={openAssistant}
    >
      <CircleHelp size={17} aria-hidden="true" />
      <span>XR setup</span>
    </button>
    {open && createPortal(<div className="xr-setup-backdrop" role="presentation" onMouseDown={(event) => {
      if (event.target === event.currentTarget && !operation) closeAssistant();
    }}>
      <section
        className="xr-setup-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="xr-setup-title"
        aria-describedby="xr-setup-description"
      >
        <header className="xr-setup-header">
          <div>
            <span className="xr-setup-eyebrow">Human-controlled launch</span>
            <h2 id="xr-setup-title">Set up XR</h2>
            <p id="xr-setup-description">Choose where the immersive browser runs. The desktop keeps Workspace authority in every mode.</p>
          </div>
          <button ref={closeRef} type="button" onClick={closeAssistant} disabled={Boolean(operation)} aria-label="Close XR setup assistant"><X size={18} /></button>
        </header>

        <div className="xr-setup-modes" role="tablist" aria-label="XR setup mode">
          <button type="button" role="tab" aria-selected={mode === "same_device"} aria-controls="xr-setup-same-device" onClick={() => { setMode("same_device"); setFeedback(""); }}>
            <Laptop size={18} aria-hidden="true" /><span><strong>This device</strong><small>Headset browser or PCVR here</small></span>
          </button>
          <button type="button" role="tab" aria-selected={mode === "remote_headset"} aria-controls="xr-setup-remote" onClick={() => { setMode("remote_headset"); setFeedback(""); }}>
            <Headset size={18} aria-hidden="true" /><span><strong>Quest / remote</strong><small>Desktop host + headset viewer</small></span>
          </button>
          <button type="button" role="tab" aria-selected={mode === "windows_ultra"} aria-controls="xr-setup-ultra" onClick={() => { setMode("windows_ultra"); setSameDevice(sameDeviceControlRef.current?.inspect() ?? sameDevice); setFeedback(""); }}>
            <ShieldCheck size={18} aria-hidden="true" /><span><strong>Windows Ultra</strong><small>Verified PCVR performance gate</small></span>
          </button>
        </div>

        {mode === "same_device" && <div id="xr-setup-same-device" className="xr-setup-panel" role="tabpanel">
          <div className="xr-setup-panel-heading">
            <div><span>Run on</span><strong>This browser and its connected headset</strong></div>
            <span className="xr-setup-state" data-tone={sameDevice.phase === "ready" || sameDevice.phase === "active" ? "pass" : sameDevice.phase === "unsupported" || sameDevice.phase === "error" ? "warn" : "working"}>{readinessLabel(sameDevice.phase)}</span>
          </div>
          <p className="xr-setup-current" role="status">{sameDevice.message}</p>
          <ol className="xr-setup-steps">
            <li><span>1</span><div><strong>Open SemaFrame here</strong><p>Use the browser that has access to the locally connected XR runtime.</p></div></li>
            <li><span>2</span><div><strong>Select Enter XR below</strong><p>This must be your click; an Agent cannot accept WebXR permission for you.</p></div></li>
            <li><span>3</span><div><strong>Put on the headset</strong><p>The view follows the headset camera after the browser grants the session.</p></div></li>
          </ol>
          <div className="xr-setup-actions">
            {sameDevice.phase === "active"
              ? <button type="button" className="danger" onClick={exitSameDevice} disabled={Boolean(operation)}><Square size={15} /> Exit XR</button>
              : <button type="button" className="primary" onClick={enterSameDevice} disabled={Boolean(operation) || sameDevice.phase !== "ready"}><Headset size={15} /> Enter XR on this device</button>}
            <button type="button" onClick={refreshSameDevice} disabled={Boolean(operation) || sameDevice.phase === "active" || sameDevice.phase === "requesting" || sameDevice.phase === "ending"}>{operation === "probe" ? <LoaderCircle className="spin-slow" size={15} /> : <RefreshCw size={15} />} Retry WebXR check</button>
          </div>
          {sameDevice.phase === "unsupported" && <p className="xr-setup-callout"><TriangleAlert size={16} /> This browser did not report immersive VR. Try the Quest / remote path or a compatible PCVR browser.</p>}
        </div>}

        {mode === "remote_headset" && <div id="xr-setup-remote" className="xr-setup-panel" role="tabpanel">
          <div className="xr-setup-panel-heading">
            <div><span>Run on</span><strong>Mac/PC authority + Quest or remote browser</strong></div>
            <span className="xr-setup-state" data-tone={headset.phase === "active" ? "pass" : headset.phase === "error" || headset.phase === "expired" || headset.phase === "disconnected" ? "warn" : "working"}>{headsetLabel(headset.phase)}</span>
          </div>
          <p className="xr-setup-current" role="status">{headset.message}</p>
          <ol className="xr-setup-steps">
            <li><span>1</span><div><strong>On this computer: prepare pairing</strong><p>SemaFrame starts a renderer-only projection and creates a single-use six-digit code.</p></div></li>
            <li><span>2</span><div><strong>In the headset browser: open the viewer</strong><p>Enter the six digits there. Do not type the long one-time link by hand.</p></div></li>
            <li><span>3</span><div><strong>In the headset: select Enter XR</strong><p>The headset owns its WebXR permission prompt; the computer remains Workspace authority.</p></div></li>
          </ol>
          <div className="xr-setup-address">
            <label htmlFor="xr-setup-viewer-address">Headset viewer address</label>
            <div><input id="xr-setup-viewer-address" readOnly value={viewerReadiness.address} onFocus={(event) => event.currentTarget.select()} /><button type="button" onClick={copyViewerAddress} disabled={operation === "copy"}><Copy size={15} /> Copy</button></div>
            <ul>
              <li data-pass={viewerReadiness.valid}><span>{viewerReadiness.valid ? <CheckCircle2 /> : <TriangleAlert />}</span>Valid viewer URL</li>
              <li data-pass={viewerReadiness.remotelyAddressable}><span>{viewerReadiness.remotelyAddressable ? <CheckCircle2 /> : <TriangleAlert />}</span>Names another device, not loopback</li>
              <li data-pass={viewerReadiness.usesHttps}><span>{viewerReadiness.usesHttps ? <CheckCircle2 /> : <TriangleAlert />}</span>HTTPS for immersive WebXR</li>
            </ul>
            <small>{viewerReadiness.message} These checks validate configuration only; they do not certify router or firewall reachability.</small>
          </div>
          <div className="xr-setup-actions">
            {remotePrepared
              ? <button type="button" className="primary" onClick={showRemotePairing}><Headset size={15} /> Show pairing and 6-digit code</button>
              : <button type="button" className="primary" onClick={prepareRemoteHeadset} disabled={!viewerReadiness.configuredForRemoteHeadset || operation === "stop"}><RefreshCw size={15} /> {headset.phase === "idle" ? "Prepare headset pairing" : "Retry headset pairing"}</button>}
            {remoteRunning && <button type="button" className="danger" onClick={stopRemoteHeadset} disabled={operation === "stop"}>{operation === "stop" ? <LoaderCircle className="spin-slow" size={15} /> : <Square size={15} />} Stop and revoke</button>}
          </div>
          {!viewerReadiness.configuredForRemoteHeadset && <p className="xr-setup-callout"><TriangleAlert size={16} /> {viewerReadiness.message}</p>}
          <div className="xr-setup-voice" data-armed={props.voiceRelayArmed}>
            <Mic2 size={18} aria-hidden="true" />
            <div><strong>Voice Relay: {props.voiceRelayArmed ? `armed${props.voiceRelayTargetLabel ? ` for ${props.voiceRelayTargetLabel}` : ""}` : "off (default)"}</strong><p>If a voice-capable Agent already hears the computer microphone, you do not need Voice Relay. Configure it only for headset push-to-talk into a text-only Agent.</p></div>
            <button type="button" onClick={configureVoiceRelayFromAssistant}>Configure</button>
          </div>
        </div>}

        {mode === "windows_ultra" && <div id="xr-setup-ultra" className="xr-setup-panel" role="tabpanel">
          <div className="xr-setup-panel-heading">
            <div><span>Run on</span><strong>Eligible Windows x64 PCVR only</strong></div>
            <span className="xr-setup-state" data-tone={sameDevice.ultraPhase === "eligible" ? "pass" : sameDevice.ultraAvailable ? "working" : "warn"}>{sameDevice.ultraPhase === "eligible" ? "Enabled" : sameDevice.ultraAvailable ? "Locked" : "Unavailable"}</span>
          </div>
          <p className="xr-setup-current" role="status">{sameDevice.ultraMessage}</p>
          <ol className="xr-setup-steps">
            <li><span>1</span><div><strong>Use the Windows PCVR machine</strong><p>Ultra is not offered on Mac, Quest standalone, or an unknown remote configuration.</p></div></li>
            <li><span>2</span><div><strong>Run the local compatibility probe</strong><p>The trusted bridge checks observed OS, runtime, memory, GPU, and WebXR evidence.</p></div></li>
            <li><span>3</span><div><strong>Confirm the physical benchmark</strong><p>A current 90 Hz workload must pass before the higher render profile can be used.</p></div></li>
          </ol>
          <p className="xr-setup-callout"><ShieldCheck size={16} /> This is a local eligibility and performance gate, not a hardware certification or a promise about every scene.</p>
          <div className="xr-setup-actions">
            <button type="button" className="primary" onClick={verifyUltra} disabled={!sameDevice.ultraAvailable || sameDevice.ultraPhase === "eligible" || operation === "ultra" || sameDevice.phase === "active" || sameDevice.phase === "requesting" || sameDevice.phase === "ending"}>
              {operation === "ultra" ? <LoaderCircle className="spin-slow" size={15} /> : <ShieldCheck size={15} />}
              {sameDevice.ultraPhase === "eligible" ? "Ultra enabled" : sameDevice.ultraPhase === "unprobed" ? "Check Ultra eligibility" : "Continue Ultra verification"}
            </button>
          </div>
        </div>}

        {feedback && <p className="xr-setup-feedback" role="status" aria-live="polite">{feedback}</p>}
        <footer><p>Agent host-control may prepare or describe XR, but entering immersive mode and accepting sensitive permissions always stay with you.</p></footer>
      </section>
    </div>, document.body)}
  </span>;
}
