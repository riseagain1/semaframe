import { randomBytes } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { isAbsolute } from "node:path";
import type {
  VoiceRelayTargetCandidate,
} from "../../src/voice-relay/contracts";
import {
  parseVoiceRelayIdentifier,
  parseVoiceRelayLabel,
  parseVoiceRelayReply,
} from "../../src/voice-relay/contracts";
import {
  VOICE_RELAY_NATIVE_PROTOCOL_VERSION,
  nativeTargetCapabilities,
  type VoiceRelayNativeAbortResult,
  type VoiceRelayNativeCancelResult,
  type VoiceRelayNativeConfirmResult,
  type VoiceRelayNativeConfiguredTarget,
  type VoiceRelayNativeDraftProbeResult,
  type VoiceRelayNativeHealth,
  type VoiceRelayNativePort,
  type VoiceRelayNativeReplyResult,
  type VoiceRelayNativeStageResult,
} from "./VoiceRelayNativePort";
import {
  encodeVoiceRelayFrame,
  VoiceRelayFrameDecoder,
  type VoiceRelayRpcRequest,
} from "./VoiceRelayNativeProtocol";

type HelperProcess = ChildProcess & Readonly<{
  stdin: NonNullable<ChildProcess["stdin"]>;
  stdout: NonNullable<ChildProcess["stdout"]>;
}>;

export type VoiceRelayNativeClientOptions = Readonly<{
  command: string;
  args?: readonly string[];
  cwd?: string;
  requestTimeoutMs?: number;
  spawnProcess?: (command: string, args: readonly string[]) => ChildProcess;
}>;

type PendingRequest = {
  resolve(value: unknown): void;
  reject(error: Error): void;
  timer: ReturnType<typeof setTimeout>;
  cleanupAbort(): void;
};

const SHUTDOWN_REQUEST_TIMEOUT_MS = 750;
const NATURAL_EXIT_GRACE_MS = 1_000;

export class VoiceRelayNativeClientError extends Error {
  constructor(
    readonly code:
      | "helper_unavailable"
      | "helper_protocol_error"
      | "helper_timeout"
      | "helper_closed"
      | "helper_cleanup_unresolved"
      | "helper_request_failed"
      | "helper_request_aborted",
    message: string,
  ) {
    super(message);
    this.name = "VoiceRelayNativeClientError";
  }
}

function exactObject(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new VoiceRelayNativeClientError("helper_protocol_error", `${label} is invalid.`);
  }
  return value as Record<string, unknown>;
}

function safeSequence(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new VoiceRelayNativeClientError("helper_protocol_error", "Voice Relay reply sequence is invalid.");
  }
  return value;
}

function optionalEnum<T extends string>(
  value: unknown,
  allowed: readonly T[],
  label: string,
): T | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !allowed.includes(value as T)) {
    throw new VoiceRelayNativeClientError("helper_protocol_error", `${label} is invalid.`);
  }
  return value as T;
}

function parseTarget(value: unknown): VoiceRelayNativeConfiguredTarget {
  const body = exactObject(value, "Voice Relay native target");
  return Object.freeze({
    targetId: parseVoiceRelayIdentifier(body.targetId, "targetId"),
    targetGeneration: parseVoiceRelayIdentifier(body.targetGeneration, "targetGeneration"),
    label: parseVoiceRelayLabel(body.label, "target label"),
    capabilities: nativeTargetCapabilities(body.capabilities),
  });
}

function parseCandidate(value: unknown): VoiceRelayTargetCandidate {
  const body = exactObject(value, "Voice Relay native target candidate");
  if (typeof body.compatible !== "boolean") {
    throw new VoiceRelayNativeClientError("helper_protocol_error", "Voice Relay target compatibility is invalid.");
  }
  const candidate: VoiceRelayTargetCandidate = {
    candidateId: parseVoiceRelayIdentifier(body.candidateId, "candidateId"),
    label: parseVoiceRelayLabel(body.label, "candidate label"),
    applicationLabel: parseVoiceRelayLabel(body.applicationLabel, "application label"),
    compatible: body.compatible,
    ...(body.incompatibilityReason === undefined
      ? {}
      : { incompatibilityReason: parseVoiceRelayLabel(body.incompatibilityReason, "incompatibility reason") }),
  };
  return Object.freeze(candidate);
}

function sanitizeRpcError(value: unknown): VoiceRelayNativeClientError {
  const body = exactObject(value, "Voice Relay helper error");
  const code = typeof body.code === "string" && /^[a-z0-9_]{1,64}$/u.test(body.code)
    ? body.code
    : "native_error";
  const message = typeof body.message === "string"
    ? body.message.replace(/[\u0000-\u001f\u007f]/gu, " ").slice(0, 300)
    : "The Voice Relay helper rejected the request.";
  return new VoiceRelayNativeClientError("helper_request_failed", `${code}: ${message}`);
}

/**
 * Length-framed JSON-RPC over an owned child process. It opens no socket and
 * uses no shell. The random capability scopes every request to this process.
 */
export class VoiceRelayNativeClient implements VoiceRelayNativePort {
  readonly #capability = randomBytes(32).toString("base64url");
  readonly #decoder = new VoiceRelayFrameDecoder();
  readonly #pending = new Map<number, PendingRequest>();
  readonly #requestTimeoutMs: number;
  readonly #child: HelperProcess;
  readonly #ready: Promise<void>;
  readonly #exitPromise: Promise<void>;
  #nextRequestId = 1;
  #closed = false;
  #exited = false;

  constructor(options: VoiceRelayNativeClientOptions) {
    if (!options.command || !isAbsolute(options.command)) {
      throw new VoiceRelayNativeClientError(
        "helper_unavailable",
        "Voice Relay helper command must be an absolute path.",
      );
    }
    this.#requestTimeoutMs = options.requestTimeoutMs ?? 5_000;
    if (!Number.isSafeInteger(this.#requestTimeoutMs)
      || this.#requestTimeoutMs < 100
      || this.#requestTimeoutMs > 30_000) {
      throw new RangeError("Voice Relay helper timeout must be between 100 and 30000ms.");
    }
    const child = options.spawnProcess
      ? options.spawnProcess(options.command, options.args ?? [])
      : spawn(options.command, [...(options.args ?? [])], {
        cwd: options.cwd,
        shell: false,
        windowsHide: true,
        stdio: ["pipe", "pipe", "ignore"],
        env: Object.fromEntries([
          "SYSTEMROOT", "WINDIR", "TEMP", "TMP", "TMPDIR", "LANG", "LC_ALL",
        ].flatMap((name) => process.env[name] === undefined ? [] : [[name, process.env[name]!]])),
      });
    if (!child.stdin || !child.stdout) {
      child.kill();
      throw new VoiceRelayNativeClientError("helper_unavailable", "Voice Relay helper pipes are unavailable.");
    }
    this.#child = child as HelperProcess;
    this.#child.stdout.on("data", (chunk: Buffer | string) => this.#receive(Buffer.from(chunk)));
    this.#child.stdin.on("error", () => {
      // A helper may close its read end immediately after acknowledging
      // shutdown. Writable streams emit EPIPE in addition to invoking the
      // write callback, so always own that event and turn it into the same
      // bounded client failure instead of an uncaught process error.
      this.#closed = true;
      this.#failAll("helper_closed", "Voice Relay helper input pipe closed.");
    });
    this.#child.once("error", () => this.#failAll("helper_unavailable", "Voice Relay helper failed to start."));
    this.#exitPromise = new Promise<void>((resolve) => {
      // `close` waits for both process exit and stdio closure, so all framed
      // shutdown output is consumed before pending requests are failed.
      this.#child.once("close", () => {
        this.#exited = true;
        this.#closed = true;
        this.#failAll("helper_closed", "Voice Relay helper closed.");
        resolve();
      });
    });
    this.#ready = this.#requestRaw("hello", {
      protocolVersion: VOICE_RELAY_NATIVE_PROTOCOL_VERSION,
    }).then((value) => {
      const result = exactObject(value, "Voice Relay helper handshake");
      if (result.protocolVersion !== VOICE_RELAY_NATIVE_PROTOCOL_VERSION
        || result.capability !== this.#capability) {
        throw new VoiceRelayNativeClientError(
          "helper_protocol_error",
          "Voice Relay helper handshake did not match this process.",
        );
      }
    });
  }

  async health(signal?: AbortSignal): Promise<VoiceRelayNativeHealth> {
    return this.#parseHealth(await this.#request("health", {}, signal));
  }

  async prepareAccessibility(signal?: AbortSignal): Promise<VoiceRelayNativeHealth> {
    return this.#parseHealth(await this.#request("prepare_accessibility", {}, signal));
  }

  #parseHealth(value: unknown): VoiceRelayNativeHealth {
    const body = exactObject(value, "Voice Relay helper health");
    if (body.protocolVersion !== VOICE_RELAY_NATIVE_PROTOCOL_VERSION
      || !["macos", "windows", "mock"].includes(String(body.platform))
      || !["authorized", "denied", "not_determined"].includes(String(body.accessibility))) {
      throw new VoiceRelayNativeClientError("helper_protocol_error", "Voice Relay helper health is invalid.");
    }
    return Object.freeze({
      protocolVersion: VOICE_RELAY_NATIVE_PROTOCOL_VERSION,
      platform: body.platform as VoiceRelayNativeHealth["platform"],
      accessibility: body.accessibility as VoiceRelayNativeHealth["accessibility"],
    });
  }

  async discoverTargets(signal?: AbortSignal): Promise<readonly VoiceRelayTargetCandidate[]> {
    const body = exactObject(await this.#request("discover_targets", {}, signal), "Voice Relay discovery response");
    if (!Array.isArray(body.targets) || body.targets.length > 128) {
      throw new VoiceRelayNativeClientError("helper_protocol_error", "Voice Relay target list is invalid.");
    }
    return Object.freeze(body.targets.map(parseCandidate));
  }

  async configureTarget(candidateId: string, signal?: AbortSignal): Promise<VoiceRelayNativeConfiguredTarget> {
    return parseTarget(await this.#request("configure_target", { candidateId }, signal));
  }

  async arm(targetId: string, signal?: AbortSignal): Promise<void> {
    const body = exactObject(await this.#request("arm", { targetId }, signal), "Voice Relay arm response");
    if (body.armed !== true) {
      throw new VoiceRelayNativeClientError("helper_protocol_error", "Voice Relay helper did not arm the target.");
    }
  }

  async disarm(signal?: AbortSignal): Promise<void> {
    const body = exactObject(await this.#request("disarm", {}, signal), "Voice Relay disarm response");
    if (body.armed !== false || typeof body.cleanupResolved !== "boolean") {
      throw new VoiceRelayNativeClientError("helper_protocol_error", "Voice Relay helper did not disarm.");
    }
    if (!body.cleanupResolved) {
      throw new VoiceRelayNativeClientError(
        "helper_cleanup_unresolved",
        "Voice Relay helper could not prove that its owned draft was removed during disarm.",
      );
    }
  }

  async testDraftRoundTrip(input: Readonly<{
    targetId: string;
    probeId: string;
    text: string;
    expectedDraftDigest: string;
    targetGeneration: string;
  }>, signal?: AbortSignal): Promise<VoiceRelayNativeDraftProbeResult> {
    const body = exactObject(
      await this.#request("test_draft_round_trip", { ...input }, signal),
      "Voice Relay draft probe response",
    );
    if (!(["passed", "blocked"] as const).includes(body.outcome as VoiceRelayNativeDraftProbeResult["outcome"])) {
      throw new VoiceRelayNativeClientError("helper_protocol_error", "Voice Relay draft probe result is invalid.");
    }
    const reason = optionalEnum(body.reason, [
      "target_lost", "composer_not_empty", "composer_unavailable", "draft_mismatch", "cleanup_failed",
    ] as const, "Voice Relay draft probe reason");
    return Object.freeze({
      outcome: body.outcome as VoiceRelayNativeDraftProbeResult["outcome"],
      ...(reason === undefined ? {} : { reason }),
    });
  }

  async stageDraft(input: Readonly<{
    targetId: string;
    stageId: string;
    text: string;
    expectedDraftDigest: string;
    targetGeneration: string;
  }>, signal?: AbortSignal): Promise<VoiceRelayNativeStageResult> {
    const body = exactObject(await this.#request("stage_draft", { ...input }, signal), "Voice Relay stage response");
    if (!(["staged", "blocked"] as const).includes(body.outcome as "staged" | "blocked")
      || typeof body.verified !== "boolean") {
      throw new VoiceRelayNativeClientError("helper_protocol_error", "Voice Relay stage result is invalid.");
    }
    const reason = optionalEnum(body.reason, [
      "target_lost", "composer_not_empty", "composer_unavailable", "draft_mismatch",
    ] as const, "Voice Relay stage reason");
    return Object.freeze({
      outcome: body.outcome as VoiceRelayNativeStageResult["outcome"],
      verified: body.verified,
      ...(body.targetGeneration === undefined
        ? {}
        : { targetGeneration: parseVoiceRelayIdentifier(body.targetGeneration, "targetGeneration") }),
      ...(reason === undefined ? {} : { reason }),
    });
  }

  async abortStage(input: Readonly<{
    targetId: string;
    stageId: string;
    expectedDraftDigest: string;
    targetGeneration: string;
  }>, signal?: AbortSignal): Promise<VoiceRelayNativeAbortResult> {
    const body = exactObject(await this.#request("abort_stage", { ...input }, signal), "Voice Relay abort response");
    if (!(["cancelled", "not_found", "draft_changed", "target_lost"] as const)
      .includes(body.outcome as VoiceRelayNativeAbortResult["outcome"])) {
      throw new VoiceRelayNativeClientError("helper_protocol_error", "Voice Relay abort result is invalid.");
    }
    return Object.freeze({ outcome: body.outcome as VoiceRelayNativeAbortResult["outcome"] });
  }

  async confirmDraft(input: Readonly<{
    targetId: string;
    stageId: string;
    expectedDraftDigest: string;
    targetGeneration: string;
  }>, signal?: AbortSignal): Promise<VoiceRelayNativeConfirmResult> {
    const body = exactObject(await this.#request("confirm_draft", { ...input }, signal), "Voice Relay confirm response");
    if (!(["sent", "blocked"] as const).includes(body.outcome as "sent" | "blocked")) {
      throw new VoiceRelayNativeClientError("helper_protocol_error", "Voice Relay confirm result is invalid.");
    }
    const reason = optionalEnum(body.reason, [
      "target_lost", "draft_changed", "send_unavailable",
    ] as const, "Voice Relay confirm reason");
    return Object.freeze({
      outcome: body.outcome as VoiceRelayNativeConfirmResult["outcome"],
      ...(body.observationId === undefined
        ? {}
        : { observationId: parseVoiceRelayIdentifier(body.observationId, "observationId") }),
      ...(reason === undefined ? {} : { reason }),
    });
  }

  async cancelDraft(input: Readonly<{
    targetId: string;
    stageId: string;
    expectedDraftDigest: string;
    targetGeneration: string;
  }>, signal?: AbortSignal): Promise<VoiceRelayNativeCancelResult> {
    const body = exactObject(await this.#request("cancel_draft", { ...input }, signal), "Voice Relay cancel response");
    if (!(["cancelled", "draft_changed", "target_lost"] as const)
      .includes(body.outcome as VoiceRelayNativeCancelResult["outcome"])) {
      throw new VoiceRelayNativeClientError("helper_protocol_error", "Voice Relay cancel result is invalid.");
    }
    return Object.freeze({ outcome: body.outcome as VoiceRelayNativeCancelResult["outcome"] });
  }

  async readReply(input: Readonly<{
    targetId: string;
    observationId: string;
    afterSequence: number;
  }>, signal?: AbortSignal): Promise<VoiceRelayNativeReplyResult> {
    const body = exactObject(await this.#request("read_reply", { ...input }, signal), "Voice Relay reply response");
    if (!(["waiting", "streaming", "complete", "unavailable"] as const)
      .includes(body.phase as VoiceRelayNativeReplyResult["phase"])) {
      throw new VoiceRelayNativeClientError("helper_protocol_error", "Voice Relay reply phase is invalid.");
    }
    const text = body.text === undefined ? undefined : parseVoiceRelayReply(body.text);
    return Object.freeze({
      phase: body.phase as VoiceRelayNativeReplyResult["phase"],
      sequence: safeSequence(body.sequence),
      ...(text === undefined ? {} : { text }),
    });
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    let cleanupResolved = false;
    let shutdownAcknowledged = false;
    try {
      const body = exactObject(
        await this.#request("shutdown", {}, undefined, SHUTDOWN_REQUEST_TIMEOUT_MS),
        "Voice Relay shutdown response",
      );
      if (body.closed !== true || typeof body.cleanupResolved !== "boolean") {
        throw new VoiceRelayNativeClientError(
          "helper_protocol_error",
          "Voice Relay helper returned an invalid shutdown result.",
        );
      }
      shutdownAcknowledged = true;
      cleanupResolved = body.cleanupResolved;
    } catch {
      // Closing stdin below gives the helper's EOF/finally cleanup a bounded
      // natural-exit opportunity even when the shutdown reply was lost.
    }
    try { this.#child.stdin.end(); } catch { /* natural exit may already have closed the pipe */ }
    const exitedNaturally = await this.#awaitExit(NATURAL_EXIT_GRACE_MS);
    if (!exitedNaturally) {
      this.#closed = true;
      this.#failAll("helper_closed", "Voice Relay helper close grace expired.");
      this.#child.kill();
    }
    if (!shutdownAcknowledged || !cleanupResolved || !exitedNaturally) {
      throw new VoiceRelayNativeClientError(
        "helper_cleanup_unresolved",
        "Voice Relay helper cleanup could not be proven before close.",
      );
    }
  }

  #awaitExit(timeoutMs: number): Promise<boolean> {
    if (this.#exited) return Promise.resolve(true);
    return new Promise<boolean>((resolve) => {
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        resolve(false);
      }, timeoutMs);
      timer.unref?.();
      void this.#exitPromise.then(() => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(true);
      });
    });
  }

  async #request(method: string, params: Record<string, unknown>, signal?: AbortSignal, timeoutMs?: number): Promise<unknown> {
    await this.#ready;
    return this.#requestRaw(method, params, signal, timeoutMs);
  }

  #requestRaw(
    method: string,
    params: Record<string, unknown>,
    signal?: AbortSignal,
    timeoutMs = this.#requestTimeoutMs,
  ): Promise<unknown> {
    if (this.#closed) {
      return Promise.reject(new VoiceRelayNativeClientError("helper_closed", "Voice Relay helper is closed."));
    }
    if (signal?.aborted) {
      return Promise.reject(new VoiceRelayNativeClientError("helper_request_aborted", "Voice Relay helper request was aborted."));
    }
    const id = this.#nextRequestId++;
    if (!Number.isSafeInteger(id)) {
      return Promise.reject(new VoiceRelayNativeClientError("helper_protocol_error", "Voice Relay request sequence is exhausted."));
    }
    const request: VoiceRelayRpcRequest = {
      jsonrpc: "2.0",
      id,
      capability: this.#capability,
      method,
      params,
    };
    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        const pending = this.#pending.get(id);
        this.#pending.delete(id);
        pending?.cleanupAbort();
        reject(new VoiceRelayNativeClientError("helper_timeout", "Voice Relay helper did not respond in time."));
      }, timeoutMs);
      const onAbort = () => {
        const pending = this.#pending.get(id);
        if (!pending) return;
        this.#pending.delete(id);
        clearTimeout(pending.timer);
        pending.cleanupAbort();
        reject(new VoiceRelayNativeClientError("helper_request_aborted", "Voice Relay helper request was aborted."));
      };
      signal?.addEventListener("abort", onAbort, { once: true });
      this.#pending.set(id, {
        resolve,
        reject,
        timer,
        cleanupAbort: () => signal?.removeEventListener("abort", onAbort),
      });
      this.#child.stdin.write(encodeVoiceRelayFrame(request), (error) => {
        if (!error) return;
        const pending = this.#pending.get(id);
        if (!pending) return;
        this.#pending.delete(id);
        clearTimeout(pending.timer);
        pending.cleanupAbort();
        reject(new VoiceRelayNativeClientError("helper_closed", "Voice Relay helper input pipe closed."));
      });
    });
  }

  #receive(chunk: Uint8Array): void {
    try {
      for (const value of this.#decoder.push(chunk)) this.#receiveMessage(value);
    } catch {
      this.#failAll("helper_protocol_error", "Voice Relay helper returned an invalid frame.");
      this.#child.kill();
    }
  }

  #receiveMessage(value: unknown): void {
    const body = exactObject(value, "Voice Relay helper response");
    if (body.jsonrpc !== "2.0" || typeof body.id !== "number" || !Number.isSafeInteger(body.id)) {
      throw new VoiceRelayNativeClientError("helper_protocol_error", "Voice Relay helper response envelope is invalid.");
    }
    const pending = this.#pending.get(body.id);
    if (!pending) return;
    this.#pending.delete(body.id);
    clearTimeout(pending.timer);
    pending.cleanupAbort();
    const hasResult = Object.hasOwn(body, "result");
    const hasError = Object.hasOwn(body, "error");
    if (hasResult === hasError) {
      pending.reject(new VoiceRelayNativeClientError("helper_protocol_error", "Voice Relay helper response is ambiguous."));
      return;
    }
    if (hasError) pending.reject(sanitizeRpcError(body.error));
    else pending.resolve(body.result);
  }

  #failAll(code: VoiceRelayNativeClientError["code"], message: string): void {
    this.#closed = true;
    for (const pending of this.#pending.values()) {
      clearTimeout(pending.timer);
      pending.cleanupAbort();
      pending.reject(new VoiceRelayNativeClientError(code, message));
    }
    this.#pending.clear();
  }
}
