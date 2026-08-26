import { evaluateXRCapabilities } from "./capabilities";
import type {
  XRCapabilityDecision,
  XRCapabilityRequirement,
  XRRuntimePort,
  XRSessionPort,
  XRSessionRequest,
} from "./contracts";

export type XRSessionLifecyclePhase =
  | "idle"
  | "probing"
  | "ready"
  | "unsupported"
  | "requesting"
  | "active"
  | "ending"
  | "ended"
  | "failed";

export type XRSessionLifecycleSnapshot = Readonly<{
  phase: XRSessionLifecyclePhase;
  capability?: XRCapabilityDecision;
  sessionId?: string;
  error?: Readonly<{ code: string; message: string }>;
  endReason?: string;
}>;

export class XRSessionLifecycleError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "XRSessionLifecycleError";
  }
}

function messageOf(cause: unknown): string {
  return cause instanceof Error ? cause.message : "XR runtime operation failed";
}

/**
 * Deterministic lifecycle around an injected runtime port. The WebXR adapter is
 * responsible for user activation and browser APIs; this class owns only state.
 */
export class XRSessionLifecycle {
  private current: XRSessionLifecycleSnapshot = Object.freeze({ phase: "idle" });
  private session?: XRSessionPort;
  private removeEndedListener?: () => void;
  private readonly listeners = new Set<(snapshot: XRSessionLifecycleSnapshot) => void>();

  constructor(
    private readonly runtime: XRRuntimePort,
    private readonly requirement: XRCapabilityRequirement,
  ) {}

  get snapshot(): XRSessionLifecycleSnapshot {
    return this.current;
  }

  subscribe(listener: (snapshot: XRSessionLifecycleSnapshot) => void): () => void {
    this.listeners.add(listener);
    listener(this.current);
    return () => this.listeners.delete(listener);
  }

  async probe(): Promise<XRSessionLifecycleSnapshot> {
    this.ensureNotBusy("probe");
    if (this.session) throw new XRSessionLifecycleError("session_active", "End the active XR session before probing");
    this.publish({ phase: "probing" });
    try {
      const capability = evaluateXRCapabilities(await this.runtime.probe(), this.requirement);
      this.publish({ phase: capability.supported ? "ready" : "unsupported", capability });
    } catch (cause) {
      this.publish({
        phase: "failed",
        error: Object.freeze({ code: "probe_failed", message: messageOf(cause) }),
      });
    }
    return this.current;
  }

  async start(request: XRSessionRequest): Promise<XRSessionLifecycleSnapshot> {
    this.ensureNotBusy("start");
    if (this.session || this.current.phase === "active") {
      throw new XRSessionLifecycleError("session_active", "An XR session is already active");
    }
    if (this.current.phase === "idle" || this.current.phase === "failed") await this.probe();
    const capability = this.current.capability;
    if (!capability?.supported) {
      throw new XRSessionLifecycleError("unsupported", "XR requirements are not supported by this runtime");
    }
    if (request.mode !== this.requirement.mode) {
      throw new XRSessionLifecycleError("mode_mismatch", "Session request does not match the probed XR mode");
    }
    for (const feature of this.requirement.requiredFeatures ?? []) {
      if (!request.requiredFeatures.includes(feature)) {
        throw new XRSessionLifecycleError(
          "required_feature_omitted",
          `Session request omitted baseline XR feature ${feature}`,
        );
      }
    }
    for (const feature of request.requiredFeatures) {
      if (!capability.capabilities.features.includes(feature)) {
        throw new XRSessionLifecycleError("feature_missing", `Required XR feature ${feature} is unavailable`);
      }
    }
    this.publish({ phase: "requesting", capability });
    try {
      const session = await this.runtime.requestSession(request);
      if (session.mode !== request.mode) {
        await session.end().catch(() => undefined);
        throw new XRSessionLifecycleError("runtime_contract", "XR runtime returned a session with the wrong mode");
      }
      const acceptedReferenceSpaces = this.requirement.acceptedReferenceSpaces ?? [];
      if (acceptedReferenceSpaces.length > 0 && !acceptedReferenceSpaces.includes(session.referenceSpace)) {
        await session.end().catch(() => undefined);
        throw new XRSessionLifecycleError(
          "runtime_contract",
          `XR runtime returned unsupported reference space ${session.referenceSpace}`,
        );
      }
      this.session = session;
      this.removeEndedListener = session.onEnded((reason) => this.handleRuntimeEnd(session, reason));
      this.publish({ phase: "active", capability, sessionId: session.id });
    } catch (cause) {
      this.clearSession();
      this.publish({
        phase: "failed",
        capability,
        error: Object.freeze({ code: cause instanceof XRSessionLifecycleError ? cause.code : "request_failed", message: messageOf(cause) }),
      });
    }
    return this.current;
  }

  async end(reason = "user_ended"): Promise<XRSessionLifecycleSnapshot> {
    this.ensureNotBusy("end");
    const session = this.session;
    if (!session) {
      if (this.current.phase !== "ended") this.publish({ ...this.current, phase: "ended", endReason: reason });
      return this.current;
    }
    const capability = this.current.capability;
    this.publish({ phase: "ending", capability, sessionId: session.id });
    try {
      await session.end();
      if (this.session === session) {
        this.clearSession();
        this.publish({ phase: "ended", capability, endReason: reason });
      }
    } catch (cause) {
      this.clearSession();
      this.publish({
        phase: "failed",
        capability,
        error: Object.freeze({ code: "end_failed", message: messageOf(cause) }),
      });
    }
    return this.current;
  }

  private ensureNotBusy(operation: string): void {
    if (["probing", "requesting", "ending"].includes(this.current.phase)) {
      throw new XRSessionLifecycleError("lifecycle_busy", `Cannot ${operation} while XR lifecycle is ${this.current.phase}`);
    }
  }

  private handleRuntimeEnd(session: XRSessionPort, reason: string): void {
    if (this.session !== session) return;
    const capability = this.current.capability;
    this.clearSession();
    this.publish({ phase: "ended", capability, endReason: reason || "runtime_ended" });
  }

  private clearSession(): void {
    this.removeEndedListener?.();
    this.removeEndedListener = undefined;
    this.session = undefined;
  }

  private publish(snapshot: XRSessionLifecycleSnapshot): void {
    this.current = Object.freeze({ ...snapshot });
    for (const listener of this.listeners) listener(this.current);
  }
}
