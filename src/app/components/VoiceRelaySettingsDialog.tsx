import { LoaderCircle, Mic2, RefreshCw, ShieldCheck, X } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type {
  VoiceRelayDiagnosticReport,
  VoiceRelaySetupPreparation,
  VoiceRelayStatus,
} from "../../voice-relay";

export type VoiceRelaySettingsDialogProps = Readonly<{
  open: boolean;
  status?: VoiceRelayStatus;
  preparation?: VoiceRelaySetupPreparation;
  diagnostics?: VoiceRelayDiagnosticReport;
  error?: string;
  onClose(): void;
  onPrepare(): void | Promise<void>;
  onConfigureTarget(candidateId: string): void | Promise<void>;
  onRunDiagnostics(): void | Promise<void>;
  onArm(targetId?: string): void | Promise<void>;
  onDisarm(): void | Promise<void>;
}>;

function safeError(cause: unknown): string {
  return (cause instanceof Error ? cause.message : "Voice Relay setup failed.").slice(0, 500);
}

function capabilityLabel(value: boolean, label: string): string {
  return `${value ? "✓" : "—"} ${label}`;
}

/**
 * Trusted desktop-only setup surface. It displays sanitized candidate labels,
 * never native locators, window contents, transcripts, or helper capabilities.
 */
export function VoiceRelaySettingsDialog(props: VoiceRelaySettingsDialogProps) {
  const [pending, setPending] = useState<string>();
  const [localError, setLocalError] = useState<string>();
  const closeRef = useRef<HTMLButtonElement>(null);
  const configuredTarget = props.status?.target ?? props.preparation?.configuredTarget;

  useEffect(() => {
    if (!props.open) return;
    closeRef.current?.focus();
    const keydown = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || pending) return;
      event.preventDefault();
      props.onClose();
    };
    globalThis.addEventListener("keydown", keydown);
    return () => globalThis.removeEventListener("keydown", keydown);
  }, [pending, props.open, props.onClose]);

  const run = useCallback(async (label: string, operation: () => void | Promise<void>) => {
    if (pending) return;
    setPending(label);
    setLocalError(undefined);
    try {
      await operation();
    } catch (cause) {
      setLocalError(safeError(cause));
    } finally {
      setPending(undefined);
    }
  }, [pending]);

  if (!props.open) return null;
  const permission = props.preparation?.accessibility ?? "not_determined";
  const candidates = props.preparation?.candidates ?? [];
  const readyToArm = Boolean(configuredTarget && props.diagnostics?.ready);

  return createPortal(<div
    className="voice-relay-modal-backdrop"
    role="presentation"
    onMouseDown={(event) => {
      if (event.target === event.currentTarget && !pending) props.onClose();
    }}
  >
    <section
      className="voice-relay-modal"
      role="dialog"
      aria-modal="true"
      aria-labelledby="voice-relay-settings-title"
      aria-describedby="voice-relay-settings-description"
    >
      <header className="voice-relay-modal-header">
        <div>
          <p className="voice-relay-eyebrow"><Mic2 size={14} /> Optional fallback voice</p>
          <h2 id="voice-relay-settings-title">Voice Relay</h2>
          <p id="voice-relay-settings-description">
            Route VR dictation to one explicitly confirmed text-only Agent window. GPT Live does not need this.
          </p>
        </div>
        <button ref={closeRef} type="button" className="voice-relay-icon-button" onClick={props.onClose} disabled={Boolean(pending)} aria-label="Close Voice Relay settings">
          <X size={18} />
        </button>
      </header>

      <div className="voice-relay-summary" data-relay-armed={props.status?.armed ? "true" : "false"}>
        <span className="voice-relay-summary-icon"><ShieldCheck size={18} /></span>
        <div>
          <strong>{props.status?.armed ? "Armed for this session" : configuredTarget ? "Target configured" : "Setup required"}</strong>
          <span>{configuredTarget?.label ?? "No Agent target selected"}</span>
        </div>
        <span className="voice-relay-phase">{props.status?.phase ?? "off"}</span>
      </div>

      <section className="voice-relay-section" aria-labelledby="voice-relay-permission-title">
        <div className="voice-relay-section-heading">
          <div>
            <h3 id="voice-relay-permission-title">1. Desktop access</h3>
            <p>Agent-guided setup can find candidates, but only you can grant system Accessibility permission.</p>
          </div>
          <button type="button" className="voice-relay-secondary-button" disabled={Boolean(pending)} onClick={() => void run("prepare", props.onPrepare)}>
            {pending === "prepare" ? <LoaderCircle size={15} className="voice-relay-spin" /> : <RefreshCw size={15} />}
            {props.preparation ? "Refresh" : "Prepare setup"}
          </button>
        </div>
        <p className={`voice-relay-permission voice-relay-permission-${permission}`}>
          Accessibility: {permission.replace("_", " ")}
          {permission !== "authorized" && " · SemaFrame cannot authorize itself."}
        </p>
      </section>

      <section className="voice-relay-section" aria-labelledby="voice-relay-target-title">
        <div className="voice-relay-section-heading">
          <div>
            <h3 id="voice-relay-target-title">2. Agent target</h3>
            <p>Only sanitized application and window labels are shown. Window contents never appear here.</p>
          </div>
        </div>
        {candidates.length === 0 ? <p className="voice-relay-empty">Prepare setup to discover compatible Agent windows.</p> : <ul className="voice-relay-candidates">
          {candidates.map((candidate) => <li key={candidate.candidateId} data-compatible={candidate.compatible ? "true" : "false"}>
            <div>
              <strong>{candidate.label}</strong>
              <span>{candidate.applicationLabel}</span>
              {!candidate.compatible && <small>{candidate.incompatibilityReason ?? "This window does not expose safe controls."}</small>}
            </div>
            <button
              type="button"
              className="voice-relay-secondary-button"
              disabled={Boolean(pending) || !candidate.compatible}
              onClick={() => void run(`target:${candidate.candidateId}`, () => props.onConfigureTarget(candidate.candidateId))}
            >{pending === `target:${candidate.candidateId}` ? <LoaderCircle size={15} className="voice-relay-spin" /> : null}
              Use target
            </button>
          </li>)}
        </ul>}
        {configuredTarget && <div className="voice-relay-capabilities" aria-label="Configured target capabilities">
          <span>{capabilityLabel(configuredTarget.capabilities.draftInsertion, "Draft insertion")}</span>
          <span>{capabilityLabel(configuredTarget.capabilities.explicitSend, "Explicit send")}</span>
          <span>{capabilityLabel(configuredTarget.capabilities.replyObservation, "Reply observation")}</span>
        </div>}
      </section>

      <section className="voice-relay-section" aria-labelledby="voice-relay-diagnostics-title">
        <div className="voice-relay-section-heading">
          <div>
            <h3 id="voice-relay-diagnostics-title">3. Safe round-trip</h3>
            <p>Tests empty-field insertion, exact read-back, cleanup, Send control identity, and optional reply output.</p>
          </div>
          <button type="button" className="voice-relay-secondary-button" disabled={Boolean(pending) || !configuredTarget} onClick={() => void run("diagnostics", props.onRunDiagnostics)}>
            {pending === "diagnostics" ? <LoaderCircle size={15} className="voice-relay-spin" /> : <ShieldCheck size={15} />}
            Run diagnostics
          </button>
        </div>
        {props.diagnostics && <ul className="voice-relay-checks">
          {props.diagnostics.checks.map((check) => <li key={check.id} data-status={check.status}>
            <span>{check.status === "pass" ? "✓" : check.status === "fail" ? "!" : "—"}</span>
            <div><strong>{check.id.replaceAll("_", " ")}</strong><small>{check.message}</small></div>
          </li>)}
        </ul>}
      </section>

      <p className="voice-relay-headset-note">
        Subtitles are always available in XR. Optional text-to-speech is controlled in the headset, where push-to-talk can interrupt it.
      </p>

      {(localError || props.error) && <p role="alert" className="voice-relay-error">{localError ?? props.error}</p>}

      <footer className="voice-relay-modal-footer">
        <p>Relay is session-scoped. XR cannot silently select a target or arm desktop control.</p>
        {props.status?.armed ? <button
          type="button"
          className="voice-relay-danger-button"
          disabled={Boolean(pending)}
          onClick={() => void run("disarm", props.onDisarm)}
        >{pending === "disarm" && <LoaderCircle size={15} className="voice-relay-spin" />} Disarm</button> : <button
          type="button"
          className="voice-relay-primary-button"
          disabled={Boolean(pending) || !readyToArm}
          title={!readyToArm ? "Configure a target and pass diagnostics first." : undefined}
          onClick={() => void run("arm", () => props.onArm(configuredTarget?.targetId))}
        >{pending === "arm" && <LoaderCircle size={15} className="voice-relay-spin" />} Arm for this session</button>}
      </footer>
    </section>
  </div>, document.body);
}
