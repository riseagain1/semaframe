import { Headset, Mic2, ShieldCheck, X } from "lucide-react";
import { createPortal } from "react-dom";
import type { RequiredUserActionKind } from "../../agent/hostControlContracts";

export type HostActionPromptRequest = Readonly<{
  id: string;
  kind: RequiredUserActionKind;
  title: string;
  message: string;
  targetLabel?: string;
  confirmLabel: string;
  busy?: boolean;
}>;

export type HostActionPromptProps = Readonly<{
  request?: HostActionPromptRequest;
  onConfirm(): void;
  onCancel(): void;
}>;

function PromptIcon({ kind }: { kind: RequiredUserActionKind }) {
  if (kind === "enter_immersive_xr" || kind === "exit_immersive_xr" || kind === "open_headset_link") {
    return <Headset size={22} aria-hidden="true" />;
  }
  if (kind === "arm_voice_relay") {
    return <Mic2 size={22} aria-hidden="true" />;
  }
  return <ShieldCheck size={22} aria-hidden="true" />;
}

/** A visible, non-bypassable user-action boundary for Agent host requests. */
export function HostActionPrompt({ request, onConfirm, onCancel }: HostActionPromptProps) {
  if (!request) return null;
  return createPortal(<div className="host-action-backdrop" role="presentation">
    <section
      className="host-action-prompt"
      role="dialog"
      aria-modal="true"
      aria-labelledby="host-action-title"
      aria-describedby="host-action-description"
      data-host-action-kind={request.kind}
    >
      <header>
        <span className="host-action-icon"><PromptIcon kind={request.kind} /></span>
        <div>
          <small>Agent requested · Your confirmation is required</small>
          <h2 id="host-action-title">{request.title}</h2>
        </div>
        <button type="button" onClick={onCancel} disabled={request.busy} aria-label="Decline Agent request">
          <X size={18} />
        </button>
      </header>
      <p id="host-action-description">{request.message}</p>
      {request.targetLabel && <div className="host-action-target">
        <span>Exact target</span>
        <strong>{request.targetLabel}</strong>
      </div>}
      <div className="host-action-buttons">
        <button type="button" onClick={onCancel} disabled={request.busy}>Not now</button>
        <button type="button" className="primary" onClick={onConfirm} disabled={request.busy}>
          {request.confirmLabel}
        </button>
      </div>
    </section>
  </div>, document.body);
}
