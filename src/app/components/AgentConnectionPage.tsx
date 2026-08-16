import {
  ArrowLeft,
  Bot,
  Check,
  CircleOff,
  Clipboard,
  Clock3,
  KeyRound,
  LoaderCircle,
  MonitorUp,
  PlugZap,
  RefreshCw,
  RotateCcw,
  ShieldCheck,
  Unplug,
  UserCheck,
  WifiOff,
} from "lucide-react";
import { useEffect, useId, useRef, useState } from "react";
import { AgentGatewayError } from "../../agent/AgentGatewayClient";

export type AgentConnectionStatus = "disabled" | "waiting" | "approval" | "connected" | "disconnected" | "occupied";

export type AgentConnectionClient = Readonly<{
  name: string;
  clientId?: string;
  scopes: readonly string[];
  connected?: boolean;
}>;

export type AgentConnectionSetup = string | Readonly<{ mcpConfig: string }>;

export type AgentConnectionPageProps = {
  id?: string;
  status: AgentConnectionStatus;
  busy?: boolean;
  error?: string;
  pairedClient?: AgentConnectionClient | null;
  allowDeleteAndClear?: boolean;
  /** A display-safe address. Do not include bearer credentials in this value. */
  connectionUrl?: string;
  expiresAt?: string;
  onEnable: (allowDeleteAndClear: boolean) => unknown | Promise<unknown>;
  onCopySetup?: () => AgentConnectionSetup | Promise<AgentConnectionSetup>;
  onPermissionChange: (allowDeleteAndClear: boolean) => unknown | Promise<unknown>;
  onRetry?: () => unknown | Promise<unknown>;
  /** Replaces the current offer URL without changing the browser-engine lease. */
  onRefreshOffer?: () => unknown | Promise<unknown>;
  /** Explicitly moves the browser engine lease from another tab to this one. */
  onTakeover?: () => unknown | Promise<unknown>;
  onApprove?: () => unknown | Promise<unknown>;
  onReject?: () => unknown | Promise<unknown>;
  onRevoke: () => unknown | Promise<unknown>;
  /** Disables Agent control and returns to the connection gate. */
  onDisableAgentControl: () => unknown | Promise<unknown>;
  /** Present only when this page is temporarily covering an active workspace. */
  onClose?: () => void;
};

type PendingAction = "enable" | "copy" | "permission" | "retry" | "refresh" | "takeover" | "approve" | "reject" | "revoke" | "disable";

const GENERIC_ACTION_ERROR = "The local Agent Gateway could not complete that action. Try again.";
const GATEWAY_UNAVAILABLE_ERROR = "Couldn’t reach the local Agent Gateway. Make sure it is running, then try again.";
const GATEWAY_RESTARTED_ERROR = "The local Agent Gateway restarted and this browser session expired. Refresh SemaFrame, then try again.";
const GATEWAY_VERSION_ERROR = "SemaFrame received incompatible connection data from the local Agent Gateway. Refresh the page, and restart the gateway if the problem continues.";
const SENSITIVE_ERROR_PATTERN = /(?:authorization|bearer|password|api[_ -]?key|secret|(?:approval|session|csrf)[_ -]?token|token\s*=|https?:\/\/|\/mcp\/connect\/)/iu;
const NETWORK_ERROR_PATTERN = /(?:failed to fetch|network(?:error| request)?|load failed|connection (?:refused|reset)|econnrefused|gateway unavailable)/iu;
const DESTRUCTIVE_SCOPES = new Set(["component:delete", "connector:delete", "workspace:clear"]);

function displayableLocalError(message: string): string | undefined {
  const trimmed = message.trim();
  return trimmed && trimmed.length <= 240 &&
    !/[\r\n\u0000-\u001f]/u.test(trimmed) &&
    !SENSITIVE_ERROR_PATTERN.test(trimmed)
    ? trimmed
    : undefined;
}

function safeActionErrorMessage(error: unknown): string {
  if (error instanceof AgentGatewayError) {
    if (error.gatewayCode === "csrf_invalid") return GATEWAY_RESTARTED_ERROR;
    if (error.code === "invalid_response") return GATEWAY_VERSION_ERROR;
    if (
      error.code === "request_failed" &&
      (error.status === undefined || error.status === 502 || error.status === 503 || error.status === 504)
    ) return GATEWAY_UNAVAILABLE_ERROR;
    // AgentGatewayError messages are authored locally and never copy response
    // bodies or nested causes. Keep a final content check as defense in depth
    // in case a future caller constructs one with request-specific details.
    return displayableLocalError(error.message) ?? GENERIC_ACTION_ERROR;
  }
  if (error instanceof Error) {
    const message = error.message.trim();
    if (NETWORK_ERROR_PATTERN.test(message)) return GATEWAY_UNAVAILABLE_ERROR;
    return displayableLocalError(message) ?? GENERIC_ACTION_ERROR;
  }
  return GENERIC_ACTION_ERROR;
}

const STATUS_COPY: Record<AgentConnectionStatus, { eyebrow: string; title: string; detail: string }> = {
  disabled: {
    eyebrow: "Agent control is off",
    title: "Let an agent build through this workspace.",
    detail: "The client supplies intent. This browser remains the engine of record for validation, rendering, history, undo, and redo.",
  },
  waiting: {
    eyebrow: "Ready to connect",
    title: "Give this connection to your client.",
    detail: "Paste this address into the agent client you want to use, then keep this project open for workspace updates. Realtime and voice agents use the same connection.",
  },
  approval: {
    eyebrow: "Approval required",
    title: "A client is asking to control this workspace.",
    detail: "Check the client and requested access before allowing it to inspect or change the project.",
  },
  connected: {
    eyebrow: "Agent control is active",
    title: "This workspace is under external control.",
    detail: "Review the connected client, rotate its pairing, or change permissions without leaving the shared project history.",
  },
  disconnected: {
    eyebrow: "Connection interrupted",
    title: "Your workspace is safe.",
    detail: "Reconnect the last client, create a fresh pairing, or disable Agent control. No uncommitted agent change is applied.",
  },
  occupied: {
    eyebrow: "Agent control is active in another tab",
    title: "Another tab owns Agent control.",
    detail: "This tab remains on the same Workspace. Return to the active tab, try again after it closes, or explicitly move Agent control here.",
  },
};

function ConnectionStatusIcon({ status }: { status: AgentConnectionStatus }) {
  if (status === "waiting") return <Bot size={21} aria-hidden="true" />;
  if (status === "approval") return <UserCheck size={21} aria-hidden="true" />;
  if (status === "connected") return <PlugZap size={21} aria-hidden="true" />;
  if (status === "occupied") return <MonitorUp size={21} aria-hidden="true" />;
  if (status === "disconnected") return <WifiOff size={21} aria-hidden="true" />;
  return <CircleOff size={21} aria-hidden="true" />;
}

function setupText(payload: AgentConnectionSetup): string {
  return typeof payload === "string" ? payload : payload.mcpConfig;
}

function expiryLabel(expiresAt: string): string {
  const date = new Date(expiresAt);
  return Number.isNaN(date.valueOf()) ? expiresAt : date.toLocaleString();
}

function connectionUrlExpired(expiresAt: string | undefined, now = Date.now()): boolean {
  if (!expiresAt) return false;
  const expiry = Date.parse(expiresAt);
  return Number.isFinite(expiry) && expiry <= now;
}

export function AgentConnectionPage({
  id,
  status,
  busy = false,
  error,
  pairedClient,
  allowDeleteAndClear = false,
  connectionUrl,
  expiresAt,
  onEnable,
  onCopySetup,
  onPermissionChange,
  onRetry,
  onRefreshOffer,
  onTakeover,
  onApprove,
  onReject,
  onRevoke,
  onDisableAgentControl,
  onClose,
}: AgentConnectionPageProps) {
  const titleId = useId();
  const detailId = useId();
  const permissionHintId = useId();
  const copyTimerRef = useRef<number | undefined>(undefined);
  const revokeTriggerRef = useRef<HTMLButtonElement>(null);
  const revokeCancelRef = useRef<HTMLButtonElement>(null);
  const takeoverTriggerRef = useRef<HTMLButtonElement>(null);
  const takeoverCancelRef = useRef<HTMLButtonElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  const [permission, setPermission] = useState(status === "disabled" ? false : allowDeleteAndClear);
  const [pending, setPending] = useState<PendingAction | null>(null);
  const [copied, setCopied] = useState<"connection" | "setup" | null>(null);
  const [confirmRevoke, setConfirmRevoke] = useState(false);
  const [confirmTakeover, setConfirmTakeover] = useState(false);
  const [localError, setLocalError] = useState<string>();
  const [urlExpired, setUrlExpired] = useState(() => connectionUrlExpired(expiresAt));
  const blocked = busy || pending !== null;
  const copy = STATUS_COPY[status];

  useEffect(() => {
    setPermission(status === "disabled" ? false : allowDeleteAndClear);
  }, [allowDeleteAndClear, status]);

  useEffect(() => {
    setCopied(null);
    const expiry = expiresAt ? Date.parse(expiresAt) : Number.NaN;
    if (!Number.isFinite(expiry)) {
      setUrlExpired(false);
      return;
    }
    let timer: number | undefined;
    const updateExpiry = () => {
      const remaining = expiry - Date.now();
      if (remaining <= 0) {
        setUrlExpired(true);
        return;
      }
      setUrlExpired(false);
      timer = window.setTimeout(updateExpiry, Math.min(remaining + 1, 2_147_483_647));
    };
    updateExpiry();
    return () => {
      if (timer !== undefined) window.clearTimeout(timer);
    };
  }, [connectionUrl, expiresAt]);

  useEffect(() => () => {
    if (copyTimerRef.current !== undefined) window.clearTimeout(copyTimerRef.current);
  }, []);

  useEffect(() => {
    if (!confirmRevoke) return;
    const frame = requestAnimationFrame(() => revokeCancelRef.current?.focus());
    return () => cancelAnimationFrame(frame);
  }, [confirmRevoke]);

  useEffect(() => {
    if (!confirmTakeover) return;
    const frame = requestAnimationFrame(() => takeoverCancelRef.current?.focus());
    return () => cancelAnimationFrame(frame);
  }, [confirmTakeover]);

  useEffect(() => {
    if (!onCloseRef.current) return;
    const previouslyFocused = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const frame = requestAnimationFrame(() => closeRef.current?.focus());
    const handleEscape = (event: globalThis.KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      onCloseRef.current?.();
    };
    document.addEventListener("keydown", handleEscape);
    return () => {
      cancelAnimationFrame(frame);
      document.removeEventListener("keydown", handleEscape);
      requestAnimationFrame(() => previouslyFocused?.focus({ preventScroll: true }));
    };
  }, [Boolean(onClose)]);

  const runAction = async (kind: PendingAction, action: () => unknown | Promise<unknown>): Promise<boolean> => {
    setPending(kind);
    setLocalError(undefined);
    try {
      await action();
      return true;
    } catch (error) {
      setLocalError(safeActionErrorMessage(error));
      return false;
    } finally {
      setPending(null);
    }
  };

  const copyConnection = async () => {
    setPending("copy");
    setLocalError(undefined);
    if (connectionUrl && connectionUrlExpired(expiresAt)) {
      setCopied(null);
      setLocalError("This connection URL has expired. Create a fresh URL and try again.");
      setPending(null);
      return;
    }
    try {
      const text = connectionUrl ?? (onCopySetup ? setupText(await onCopySetup()) : "");
      if (!text || !navigator.clipboard?.writeText) throw new Error("Clipboard unavailable");
      await navigator.clipboard.writeText(text);
      setCopied(connectionUrl ? "connection" : "setup");
      if (copyTimerRef.current !== undefined) window.clearTimeout(copyTimerRef.current);
      copyTimerRef.current = window.setTimeout(() => setCopied(null), 2_400);
    } catch {
      setCopied(null);
      setLocalError("The connection could not be copied. Check browser clipboard permission and try again.");
    } finally {
      setPending(null);
    }
  };

  const copyLocalSetup = async () => {
    if (!onCopySetup) return;
    setPending("copy");
    setLocalError(undefined);
    try {
      const text = setupText(await onCopySetup());
      if (!text || !navigator.clipboard?.writeText) throw new Error("Clipboard unavailable");
      await navigator.clipboard.writeText(text);
      setCopied("setup");
      if (copyTimerRef.current !== undefined) window.clearTimeout(copyTimerRef.current);
      copyTimerRef.current = window.setTimeout(() => setCopied(null), 2_400);
    } catch {
      setCopied(null);
      setLocalError("The local setup could not be copied. Check browser clipboard permission and try again.");
    } finally {
      setPending(null);
    }
  };

  const changePermission = (next: boolean) => {
    const previous = permission;
    setPermission(next);
    setLocalError(undefined);
    if (status !== "disabled") {
      void runAction("permission", () => onPermissionChange(next)).then((changed) => {
        if (!changed) setPermission(previous);
      });
    }
  };

  const canCopy = Boolean((connectionUrl && !urlExpired) || (!connectionUrl && onCopySetup));
  const clientRequestedDestructiveAccess = pairedClient?.scopes.some((scope) => DESTRUCTIVE_SCOPES.has(scope)) ?? false;
  const showDestructivePolicy = status === "disabled" ||
    ((status === "waiting" || status === "disconnected") && !pairedClient) ||
    clientRequestedDestructiveAccess;
  const dismissRevoke = () => {
    setConfirmRevoke(false);
    requestAnimationFrame(() => revokeTriggerRef.current?.focus());
  };
  const dismissTakeover = () => {
    setConfirmTakeover(false);
    requestAnimationFrame(() => takeoverTriggerRef.current?.focus());
  };

  return (
    <section
      id={id}
      className={`agent-connection-page status-${status}`}
      role="region"
      aria-labelledby={titleId}
      aria-describedby={detailId}
      aria-busy={blocked || undefined}
    >
      {onClose && <button ref={closeRef} type="button" className="agent-page-close" onClick={onClose} disabled={blocked}>
        <ArrowLeft size={16} aria-hidden="true" />Back to workspace
      </button>}
      <div className="agent-connection-content">
        <div className="agent-connection-intro">
          <div className="agent-connection-mark" aria-hidden="true"><ConnectionStatusIcon status={status} /></div>
          <p className="eyebrow">{copy.eyebrow}</p>
          <h1 id={titleId}>{copy.title}</h1>
          <p id={detailId}>{copy.detail}</p>
          <div className="agent-engine-contract">
            <ShieldCheck size={17} aria-hidden="true" />
            <p><strong>SemaFrame stays in charge of the workspace.</strong> Every client request uses the same deterministic transaction, validation, and revision rules as direct Workspace editing.</p>
          </div>
        </div>

        <div className="agent-connection-actions">
          {status === "occupied" ? (
            <section className="agent-occupied-card" aria-labelledby={`${titleId}-occupied`} role="status">
              <div className="agent-occupied-heading">
                <MonitorUp size={18} aria-hidden="true" />
                <div>
                  <p className="eyebrow">Browser engine in use</p>
                  <h2 id={`${titleId}-occupied`}>Choose which tab owns Agent control</h2>
                </div>
              </div>
              <p>No workspace change was made here. Trying again is safe and will connect only if the other tab has released control.</p>
              {!confirmTakeover && <div className="agent-occupied-actions">
                {onRetry && <button type="button" onClick={() => void runAction("retry", onRetry)} disabled={blocked}>
                  <RefreshCw className={pending === "retry" ? "spin-slow" : undefined} size={15} aria-hidden="true" />
                  {pending === "retry" ? "Trying again…" : "Try this tab again"}
                </button>}
                {onTakeover && <button ref={takeoverTriggerRef} type="button" className="agent-primary-action" onClick={() => setConfirmTakeover(true)} disabled={blocked}>
                  <MonitorUp size={15} aria-hidden="true" />Move control to this tab
                </button>}
              </div>}
              {confirmTakeover && <div className="agent-page-confirmation agent-takeover-confirmation" role="alert" aria-live="assertive">
                <MonitorUp size={18} aria-hidden="true" />
                <div>
                  <strong>Move Agent control to this tab?</strong>
                  <p>The other tab will stop receiving client commands. Control will continue with the project currently loaded here; unsaved workspace state is not copied between tabs. The pairing stays valid.</p>
                </div>
                <div>
                  <button ref={takeoverCancelRef} type="button" onClick={dismissTakeover} disabled={blocked}>Cancel</button>
                  <button type="button" className="danger" onClick={() => void runAction("takeover", () => onTakeover!()).then((done) => { if (done) dismissTakeover(); })} disabled={blocked}>
                    {pending === "takeover" ? "Moving control…" : "Move control here"}
                  </button>
                </div>
              </div>}
            </section>
          ) : status === "disabled" ? (
            <section className="agent-connect-step" aria-labelledby={`${titleId}-enable`}>
              <span className="agent-step-number" aria-hidden="true">01</span>
              <div>
                <h2 id={`${titleId}-enable`}>Create a local connection</h2>
                <p>Connection details live only for this gateway session and can be revoked at any time.</p>
                <button
                  type="button"
                  className="agent-primary-action"
                  onClick={() => void runAction("enable", () => onEnable(permission))}
                  disabled={blocked}
                >
                  {pending === "enable" ? <LoaderCircle className="spin-slow" size={16} aria-hidden="true" /> : <KeyRound size={16} aria-hidden="true" />}
                  {pending === "enable" ? "Creating connection…" : "Enable agent control"}
                </button>
              </div>
            </section>
          ) : status === "approval" ? (
            <section className="agent-approval-card" aria-labelledby={`${titleId}-approval`}>
              <div className="agent-approval-heading">
                <UserCheck size={18} aria-hidden="true" />
                <div><p className="eyebrow">Pending client</p><h2 id={`${titleId}-approval`}>{pairedClient?.name ?? "Unnamed agent"}</h2></div>
              </div>
              {pairedClient?.clientId && <code>{pairedClient.clientId}</code>}
              <p className="agent-approval-caution">Client names are self-reported. Approve only if you just asked this agent to connect.</p>
              {pairedClient?.scopes.length ? <ul aria-label="Requested access">
                {pairedClient.scopes.map((scope) => <li key={scope}>{scope}</li>)}
              </ul> : null}
              <div className="agent-approval-actions">
                {onReject && <button type="button" onClick={() => void runAction("reject", onReject)} disabled={blocked}>Reject</button>}
                {onApprove && <button type="button" className="agent-primary-action" onClick={() => void runAction("approve", onApprove)} disabled={blocked}>
                  {pending === "approve" ? "Approving…" : "Approve client"}
                </button>}
              </div>
            </section>
          ) : (
            <>
              <section className="agent-connect-step" aria-labelledby={`${titleId}-connect`}>
                <span className="agent-step-number" aria-hidden="true">{status === "waiting" ? "01" : status === "connected" ? "✓" : "!"}</span>
                <div>
                  <h2 id={`${titleId}-connect`}>{status === "waiting" ? "Paste this into your client" : status === "connected" ? "Manage this connection" : "Reconnect or create a new pairing"}</h2>
                  <p>{status === "waiting"
                    ? "Use this exact address in the agent client you want to control the workspace. Realtime and voice agents use the same connection. Do not close this browser tab."
                    : status === "connected"
                      ? "The connected client can inspect and change this open workspace through validated engine transactions."
                      : "The previous workspace remains preserved while the external client is offline. Reconnect to unlock editing."}</p>
                  {connectionUrl && <div className="agent-connection-url-wrap">
                    <label htmlFor={`${titleId}-url`}>Connection URL</label>
                    <input
                      id={`${titleId}-url`}
                      type="text"
                      readOnly
                      value={connectionUrl}
                      spellCheck={false}
                      onFocus={(event) => event.currentTarget.select()}
                    />
                    {expiresAt && status !== "connected" && <span className="agent-expiry"><Clock3 size={13} aria-hidden="true" />{urlExpired ? "Expired" : <>Expires <time dateTime={expiresAt}>{expiryLabel(expiresAt)}</time></>}</span>}
                  </div>}
                  <button
                    type="button"
                    className="agent-primary-action"
                    onClick={() => void copyConnection()}
                    disabled={!canCopy || blocked}
                  >
                    {pending === "copy" ? <LoaderCircle className="spin-slow" size={16} aria-hidden="true" /> : copied === "connection" ? <Check size={16} aria-hidden="true" /> : <Clipboard size={16} aria-hidden="true" />}
                    {urlExpired && connectionUrl ? "Connection URL expired" : copied === "connection" ? "Connection URL copied" : copied === "setup" && !connectionUrl ? "Connection setup copied" : connectionUrl ? "Copy connection URL" : "Copy connection setup"}
                  </button>
                  <p className="agent-copy-guidance" role="note">{status === "connected"
                    ? "Keep this address for reconnecting the approved client. Revoke the pairing before giving control to a different agent."
                    : "After copying, paste it into your agent client and ask it to connect. Access is still controlled from this page."}</p>
                  {onCopySetup && <details className="agent-local-setup">
                    <summary>Advanced local setup</summary>
                    <p>This setup contains an ephemeral bearer credential. Copy it only into a trusted local stdio or REST client, and never paste it into chat, a URL, project data, or logs.</p>
                    <button type="button" onClick={() => void copyLocalSetup()} disabled={blocked}>
                      {pending === "copy" ? <LoaderCircle className="spin-slow" size={15} aria-hidden="true" /> : copied === "setup" ? <Check size={15} aria-hidden="true" /> : <Clipboard size={15} aria-hidden="true" />}
                      {copied === "setup" ? "Local setup copied" : "Copy local stdio/REST setup"}
                    </button>
                  </details>}
                </div>
              </section>

              {pairedClient && <section className="agent-last-client" aria-label={status === "disconnected" ? "Last connected client" : "Connected client"}>
                <span className={`agent-client-dot${status === "disconnected" ? " is-offline" : ""}`} aria-hidden="true" />
                <div><span>{status === "disconnected" ? "Last client" : "Client"}</span><strong>{pairedClient.name}</strong>{pairedClient.clientId && <code>{pairedClient.clientId}</code>}</div>
              </section>}

              {(status === "waiting" || status === "disconnected") && !confirmRevoke && <div className="agent-recovery-actions">
                {status === "disconnected" && onRetry && <button type="button" onClick={() => void runAction("retry", onRetry)} disabled={blocked}><RefreshCw className={pending === "retry" ? "spin-slow" : undefined} size={15} aria-hidden="true" />Retry connection</button>}
                {onRefreshOffer && <button type="button" onClick={() => void runAction("refresh", onRefreshOffer)} disabled={blocked}><RefreshCw className={pending === "refresh" ? "spin-slow" : undefined} size={15} aria-hidden="true" />{pending === "refresh" ? "Creating fresh URL…" : "Create fresh URL"}</button>}
                {status === "disconnected" && <button ref={revokeTriggerRef} type="button" onClick={() => setConfirmRevoke(true)} disabled={blocked}><RotateCcw size={15} aria-hidden="true" />Revoke pairing</button>}
              </div>}
              {status === "connected" && !confirmRevoke && <div className="agent-recovery-actions">
                {onRetry && <button type="button" onClick={() => void runAction("retry", onRetry)} disabled={blocked}><RefreshCw className={pending === "retry" ? "spin-slow" : undefined} size={15} aria-hidden="true" />Refresh status</button>}
                <button ref={revokeTriggerRef} type="button" onClick={() => setConfirmRevoke(true)} disabled={blocked}><RotateCcw size={15} aria-hidden="true" />Revoke pairing</button>
              </div>}
            </>
          )}

          {status !== "occupied" && showDestructivePolicy && <label className="agent-connection-permission">
            <input
              type="checkbox"
              checked={permission}
              onChange={(event) => changePermission(event.target.checked)}
              disabled={blocked}
              aria-describedby={permissionHintId}
            />
            <span>
              <strong>{status === "approval" ? "Allow requested delete and clear commands" : "Allow delete and clear commands"}</strong>
              <small id={permissionHintId}>{status === "connected"
                ? "Changing this policy ends the current instruction session. The client must read the engine instructions again."
                : "Off by default. Ordinary reversible changes remain available without this permission."}</small>
            </span>
          </label>}

          {(localError || error) && <p className="agent-connection-error" role="alert">{localError ?? error}</p>}

          {confirmRevoke && <div className="agent-page-confirmation" role="alert" aria-live="assertive">
            <Unplug size={18} aria-hidden="true" />
            <div><strong>Revoke the current pairing?</strong><p>The copied connection will stop working. A fresh pairing can be copied afterward.</p></div>
            <div>
              <button ref={revokeCancelRef} type="button" onClick={dismissRevoke} disabled={blocked}>Cancel</button>
              <button type="button" className="danger" onClick={() => void runAction("revoke", onRevoke).then((done) => { if (done) dismissRevoke(); })} disabled={blocked}>{pending === "revoke" ? "Revoking…" : "Revoke pairing"}</button>
            </div>
          </div>}

          <div className="agent-page-footer">
            {status !== "disabled" && <button type="button" onClick={() => void runAction("disable", onDisableAgentControl)} disabled={blocked}>
              {pending === "disable" ? <LoaderCircle className="spin-slow" size={15} aria-hidden="true" /> : null}
              {status === "occupied" ? "Release this tab" : "Disable agent control"}
            </button>}
            {status === "waiting" && onRetry && <button type="button" onClick={() => void runAction("retry", onRetry)} disabled={blocked} aria-label="Refresh agent connection status"><RefreshCw className={pending === "retry" ? "spin-slow" : undefined} size={15} aria-hidden="true" />Check status</button>}
          </div>
        </div>
      </div>
    </section>
  );
}
