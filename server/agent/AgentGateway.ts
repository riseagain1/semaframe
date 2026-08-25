import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { isAbsolute, join } from "node:path";
import { pathToFileURL } from "node:url";
import { DEFAULT_WORKSPACE_AGENT_SCOPES } from "../../src/workspace/agents/contracts";
import {
  AGENT_GATEWAY_VERSION,
  AGENT_INSTRUCTION_VERSION,
  type AgentCommandName,
  type BrowserAgentCommand,
  type BrowserCommandResult,
  type BrowserPollResponse,
  isMutationCommand,
} from "./contracts";
import { normalizeAgentGatewayPublicBaseUrl } from "./AgentGatewayNetworkConfig";

export type AgentGatewayErrorCode =
  | "agent_mode_disabled"
  | "engine_unavailable"
  | "engine_busy"
  | "engine_timeout"
  | "browser_replaced"
  | "browser_already_connected"
  | "connection_invalid"
  | "command_not_found"
  | "pairing_rotated"
  | "gateway_closed"
  | "invalid_request";

export class AgentGatewayError extends Error {
  constructor(
    readonly code: AgentGatewayErrorCode | string,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = "AgentGatewayError";
  }
}

export type AgentGatewayOptions = Readonly<{
  publicBaseUrl: string;
  workspaceRoot: string;
  commandTimeoutMs?: number;
  pollTimeoutMs?: number;
  browserTtlMs?: number;
  offerTtlMs?: number;
  approvalTtlMs?: number;
  now?: () => number;
}>;

type BrowserConnection = {
  id: string;
  clientInstanceId: string;
  lastSeenAt: number;
};

type PollWaiter = {
  browserConnectionId: string;
  resolve: (value: BrowserPollResponse) => void;
  timer: ReturnType<typeof setTimeout>;
  detachAbort?: () => void;
};

type PendingCommand = {
  command: BrowserAgentCommand;
  mutation: boolean;
  delivered: boolean;
  clientName?: string;
  offerClaimId?: string;
  resolve: (value: unknown) => void;
  reject: (error: AgentGatewayError) => void;
  timer: ReturnType<typeof setTimeout>;
};

export const AGENT_MCP_CONNECTION_PREFIX = "/mcp/connect/";

export type AgentOfferStatus =
  | "waiting"
  | "approval_pending"
  | "approval_granted"
  | "approved"
  | "denied"
  | "expired";

export type AgentPendingApproval = Readonly<{
  claimId: string;
  clientId?: string;
  clientName?: string;
  scopes: readonly string[];
  fingerprint: string;
  requestedAt: string;
  expiresAt: string;
}>;

export type AgentConnectionOffer = Readonly<{
  connectionUrl: string;
  offerExpiresAt: string;
  offerStatus: AgentOfferStatus;
}>;

type ApprovalClaim = {
  id: string;
  tokenHash: Buffer;
  fingerprint: string;
  clientId?: string;
  clientName?: string;
  scopes: readonly string[];
  grantedScopes?: readonly string[];
  requestedAt: number;
  expiresAt: number;
  decision: "pending" | "approved" | "denied";
  instructionsSucceeded: boolean;
};

type ConnectionOffer = {
  id: string;
  path: string;
  createdAt: number;
  expiresAt: number;
  claim?: ApprovalClaim;
};

export type AgentGatewayConfig = Readonly<{
  version: typeof AGENT_GATEWAY_VERSION;
  gatewayInstanceId: string;
  configRevision: number;
  enabled: boolean;
  connected: boolean;
  engineConnected: boolean;
  clientName?: string;
  clientScopes?: readonly string[];
  instructionVersion: typeof AGENT_INSTRUCTION_VERSION;
  csrfToken: string;
  connectionUrl?: string;
  offerExpiresAt?: string;
  offerStatus?: AgentOfferStatus;
  pendingApproval?: AgentPendingApproval;
}>;

export type PairingReveal = Readonly<{
  pairingBearer: string;
  mcpConfig: string;
  restConfig: string;
  restEndpoint: string;
}> & AgentConnectionOffer;

export type ApprovedAgentScopePrincipal = Readonly<{
  authorizationId: string;
  clientId?: string;
  clientName?: string;
  scopes: readonly string[];
}>;

function secret(): string {
  return randomBytes(32).toString("base64url");
}

function tokenDigest(value: string): Buffer {
  return createHash("sha256").update(value, "utf8").digest();
}

function tokenMatches(value: string, expected: Buffer): boolean {
  const actual = tokenDigest(value);
  return actual.byteLength === expected.byteLength && timingSafeEqual(actual, expected);
}

function tokenFingerprint(digest: Buffer): string {
  return `SHA-256 ${digest.toString("hex").slice(0, 16).toUpperCase()}`;
}

function safeClientName(value: string | undefined): string | undefined {
  const normalized = value
    ?.normalize("NFC")
    .replace(/[\u0000-\u001f\u007f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/gu, " ")
    .replace(/\s+/gu, " ")
    .trim()
    .slice(0, 160);
  return normalized || undefined;
}

function safeClientId(value: string | undefined): string | undefined {
  return safeClientName(value)?.slice(0, 128);
}

type AgentInstructionCommand = Extract<
  AgentCommandName,
  "get_workspace_instructions"
>;

function isInstructionCommand(name: AgentCommandName): name is AgentInstructionCommand {
  return name === "get_workspace_instructions";
}

const TRANSIENT_INSTRUCTION_ERROR_CODES = new Set([
  "browser_replaced",
  "engine_busy",
  "engine_timeout",
  "engine_unavailable",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isSuccessfulAgentResult(value: unknown): value is { ok: true; data: unknown } {
  return isRecord(value) && value.ok === true;
}

function grantedAgentScopes(value: unknown): readonly string[] {
  if (!isSuccessfulAgentResult(value) || !isRecord(value.data) || !Array.isArray(value.data.granted_scopes)) {
    return Object.freeze([]);
  }
  return Object.freeze([
    ...new Set(value.data.granted_scopes.filter((scope): scope is string => typeof scope === "string" && scope.length > 0)),
  ].sort());
}

function isRetryableAgentResult(value: unknown): boolean {
  return isRecord(value) && value.ok === false && isRecord(value.error) && value.error.retryable === true;
}

function isTransientInstructionError(error: unknown): boolean {
  return error instanceof AgentGatewayError && TRANSIENT_INSTRUCTION_ERROR_CODES.has(error.code);
}

function safeInstructionInput(name: AgentCommandName, input: unknown): unknown {
  if (!isInstructionCommand(name) || !input || typeof input !== "object" || Array.isArray(input)) {
    return input;
  }
  const body = input as Record<string, unknown>;
  const clientId = safeClientId(typeof body.client_id === "string" ? body.client_id : undefined);
  const clientName = safeClientName(typeof body.client_name === "string" ? body.client_name : undefined);
  const requestedScopes = Array.isArray(body.requested_scopes)
    ? body.requested_scopes.filter((scope): scope is string => typeof scope === "string").slice(0, 20)
    : undefined;
  return {
    ...(clientId ? { client_id: clientId } : {}),
    ...(clientName ? { client_name: clientName } : {}),
    ...(requestedScopes ? { requested_scopes: requestedScopes } : {}),
  };
}

export class AgentGateway {
  readonly #publicBaseUrl: string;
  readonly #workspaceRoot: string;
  readonly #commandTimeoutMs: number;
  readonly #pollTimeoutMs: number;
  readonly #browserTtlMs: number;
  readonly #offerTtlMs: number;
  readonly #approvalTtlMs: number;
  readonly #now: () => number;
  readonly #csrfToken = secret();
  readonly #gatewayInstanceId = randomUUID();
  #pairingBearer = secret();
  #enabled = false;
  #browser?: BrowserConnection;
  #pollWaiter?: PollWaiter;
  #pendingCommand?: PendingCommand;
  #lastClientName?: string;
  #lastClientSeenAt?: number;
  #lastClientSource?: "legacy" | "offer";
  #offer?: ConnectionOffer;
  #configRevision = 0;
  #lastConfigFingerprint?: string;
  #configWakePending = false;
  #closed = false;

  constructor(options: AgentGatewayOptions) {
    this.#publicBaseUrl = normalizeAgentGatewayPublicBaseUrl(options.publicBaseUrl);
    if (!isAbsolute(options.workspaceRoot) || options.workspaceRoot.includes("\u0000")) {
      throw new Error("Agent gateway workspaceRoot must be an absolute filesystem path.");
    }
    this.#workspaceRoot = options.workspaceRoot;
    this.#commandTimeoutMs = options.commandTimeoutMs ?? 45_000;
    this.#pollTimeoutMs = options.pollTimeoutMs ?? 25_000;
    this.#browserTtlMs = options.browserTtlMs ?? 65_000;
    this.#offerTtlMs = options.offerTtlMs ?? 10 * 60_000;
    this.#approvalTtlMs = options.approvalTtlMs ?? 2 * 60_000;
    this.#now = options.now ?? Date.now;
    for (const [name, value] of [
      ["commandTimeoutMs", this.#commandTimeoutMs],
      ["pollTimeoutMs", this.#pollTimeoutMs],
      ["browserTtlMs", this.#browserTtlMs],
      ["offerTtlMs", this.#offerTtlMs],
      ["approvalTtlMs", this.#approvalTtlMs],
    ] as const) {
      if (!Number.isSafeInteger(value) || value <= 0) throw new RangeError(`${name} must be a positive integer.`);
    }
  }

  get csrfToken(): string {
    return this.#csrfToken;
  }

  getConfig(): AgentGatewayConfig {
    const currentOffer = this.#enabled && !this.#closed
      ? this.#ensureFreshOffer()
      : this.#offer;
    const offer = this.#offerView(currentOffer);
    const pendingApproval = this.#pendingApprovalView();
    const approvedScopes = currentOffer?.claim?.instructionsSucceeded
      ? [...(currentOffer.claim.grantedScopes ?? currentOffer.claim.scopes)]
      : undefined;
    const snapshot = {
      version: AGENT_GATEWAY_VERSION,
      gatewayInstanceId: this.#gatewayInstanceId,
      enabled: this.#enabled,
      connected: this.#isExternalClientConnected(),
      engineConnected: this.#isBrowserConnected(),
      ...(this.#lastClientName ? { clientName: this.#lastClientName } : {}),
      ...(approvedScopes ? { clientScopes: approvedScopes } : {}),
      instructionVersion: AGENT_INSTRUCTION_VERSION,
      csrfToken: this.#csrfToken,
      ...(offer ?? {}),
      ...(pendingApproval ? { pendingApproval } : {}),
    } as const;
    const fingerprint = JSON.stringify(snapshot);
    if (fingerprint !== this.#lastConfigFingerprint) {
      this.#lastConfigFingerprint = fingerprint;
      this.#configRevision += 1;
    }
    return Object.freeze({
      ...snapshot,
      configRevision: this.#configRevision,
    });
  }

  bearerMatches(received: string | undefined): boolean {
    if (!received) return false;
    const actual = Buffer.from(received);
    const expected = Buffer.from(this.#pairingBearer);
    return actual.byteLength === expected.byteLength && timingSafeEqual(actual, expected);
  }

  /**
   * Resolves authority from the exact user-approved connection claim. This is
   * deliberately narrower than the legacy pairing bearer: high-bandwidth host
   * capabilities such as asset ingress must be bound to an approved client and
   * scope, not merely to possession of the process-wide pairing credential.
   */
  requireApprovedClientScope(
    scope: string,
    proof?: Readonly<{ approvalToken: string; clientId?: string }>,
  ): ApprovedAgentScopePrincipal {
    this.#assertOpen();
    this.#assertEnabled();
    const claim = this.#offer?.claim;
    if (!claim || claim.decision !== "approved" || !claim.instructionsSucceeded) {
      throw new AgentGatewayError(
        "instructions_required",
        "Complete an approved instruction handshake before using this capability.",
      );
    }
    if (!this.#isBrowserConnected()) {
      throw new AgentGatewayError(
        "engine_unavailable",
        "The browser-authoritative SemaFrame engine is unavailable.",
      );
    }
    if (!claim.scopes.includes(scope) || !claim.grantedScopes?.includes(scope)) {
      throw new AgentGatewayError(
        "authorization_scope_missing",
        `The approved connection does not include the required ${scope} scope.`,
      );
    }
    if (proof) {
      if (!proof.approvalToken || !tokenMatches(proof.approvalToken, claim.tokenHash)) {
        throw new AgentGatewayError(
          "approval_invalid",
          "The approval proof does not match the active Agent connection.",
        );
      }
      if (proof.clientId !== undefined && claim.clientId !== proof.clientId) {
        throw new AgentGatewayError(
          "approval_invalid",
          "The REST Agent identity does not match the approved connection claim.",
        );
      }
    }
    return Object.freeze({
      authorizationId: claim.id,
      ...(claim.clientId ? { clientId: claim.clientId } : {}),
      ...(claim.clientName ? { clientName: claim.clientName } : {}),
      scopes: Object.freeze([...claim.scopes]),
    });
  }

  revealPairing(): PairingReveal {
    this.#assertOpen();
    this.#assertEnabled();
    const offer = this.#ensureFreshOffer();
    const offerView = this.#offerView(offer);
    const restEndpoint = `${this.#publicBaseUrl}/v1`;
    return Object.freeze({
      pairingBearer: this.#pairingBearer,
      restEndpoint,
      ...offerView,
      mcpConfig: JSON.stringify({
        mcpServers: {
          "semaframe": {
            // Launch the bridge itself instead of an npm wrapper. MCP hosts
            // terminate the configured PID directly; on POSIX npm can exit
            // without forwarding that signal to its child, leaving an
            // in-flight upstream request orphaned.
            command: process.execPath,
            args: [
              "--import",
              pathToFileURL(join(this.#workspaceRoot, "node_modules", "tsx", "dist", "loader.mjs")).href,
              join(this.#workspaceRoot, "scripts", "agent-mcp.ts"),
            ],
            env: {
              // The child receives only the non-authorizing offer URL. REST
              // authority is exposed separately and never enters MCP env.
              SEMAFRAME_AGENT_MCP_URL: offerView.connectionUrl,
            },
          },
        },
      }, null, 2),
      restConfig: JSON.stringify({
        semaframeRest: {
          baseUrl: restEndpoint,
          authorization: `Bearer ${this.#pairingBearer}`,
        },
      }, null, 2),
    });
  }

  rotatePairing(): PairingReveal & AgentGatewayConfig {
    this.#assertOpen();
    this.#assertEnabled();
    this.#pairingBearer = secret();
    this.#lastClientSeenAt = undefined;
    this.#lastClientName = undefined;
    this.#lastClientSource = undefined;
    this.#offer = this.#newOffer();
    this.#markConfigChanged();
    this.#rejectPending(new AgentGatewayError(
      "pairing_rotated",
      "The pairing credential changed before the command completed.",
    ));
    return Object.freeze({
      ...this.revealPairing(),
      ...this.getConfig(),
    });
  }

  setEnabled(enabled: boolean): { enabled: boolean } {
    this.#assertOpen();
    if (this.#enabled === enabled) {
      if (enabled && !this.#offer) this.#offer = this.#newOffer();
      return { enabled };
    }
    this.#enabled = enabled;
    if (enabled) {
      this.#offer = this.#newOffer();
    } else {
      this.#pairingBearer = secret();
      this.#lastClientSeenAt = undefined;
      this.#lastClientName = undefined;
      this.#lastClientSource = undefined;
      this.#offer = undefined;
      this.#revokeBrowser(new AgentGatewayError(
        "agent_mode_disabled",
        "Agent control was disabled before the command completed.",
      ));
    }
    return { enabled };
  }

  refreshOffer(): AgentGatewayConfig {
    this.#assertOpen();
    this.#assertEnabled();
    const replacedClaimId = this.#offer?.claim?.id;
    this.#offer = this.#newOffer();
    if (replacedClaimId && this.#pendingCommand?.offerClaimId === replacedClaimId) {
      this.#rejectPending(new AgentGatewayError(
        "connection_invalid",
        "The connection offer was replaced before the command completed.",
      ));
    }
    if (this.#lastClientSource === "offer") {
      this.#lastClientSeenAt = undefined;
      this.#lastClientName = undefined;
      this.#lastClientSource = undefined;
    }
    this.#markConfigChanged();
    return this.getConfig();
  }

  approveClaim(claimId: string): { approved: true } {
    const claim = this.#requireClaim(claimId);
    if (claim.decision === "denied") {
      throw new AgentGatewayError("approval_denied", "This connection request was already denied.");
    }
    claim.decision = "approved";
    this.#markConfigChanged();
    return { approved: true };
  }

  denyClaim(claimId: string): { denied: true } {
    const claim = this.#requireClaim(claimId);
    if (claim.decision === "approved" && claim.instructionsSucceeded) {
      throw new AgentGatewayError("approval_already_used", "This agent already completed the approved instruction handshake. Revoke the connection instead.");
    }
    claim.decision = "denied";
    this.#markConfigChanged();
    return { denied: true };
  }

  isConnectionPath(pathname: string): boolean {
    return pathname.startsWith(AGENT_MCP_CONNECTION_PREFIX);
  }

  connectionOffer(pathname: string): AgentConnectionOffer {
    this.#requireOfferPath(pathname);
    return this.#offerView(this.#offer as ConnectionOffer);
  }

  async dispatchOffer(
    pathname: string,
    name: AgentCommandName,
    input: unknown,
    client: { clientId?: string; clientName?: string },
  ): Promise<{ responseOk: boolean; status: number; payload: unknown }> {
    let offer: ConnectionOffer;
    try {
      offer = this.#requireOfferPath(pathname);
    } catch (error) {
      return this.#backendError(error);
    }

    if (isInstructionCommand(name)) {
      const body = input && typeof input === "object" && !Array.isArray(input)
        ? input as Record<string, unknown>
        : {};
      const approvalToken = typeof body.approval_token === "string" ? body.approval_token : undefined;
      const authorization = this.#authorizeInstructionClaim(offer, approvalToken, {
        clientId: client.clientId ?? (typeof body.client_id === "string" ? body.client_id : undefined),
        clientName: client.clientName ?? (typeof body.client_name === "string" ? body.client_name : undefined),
        requestedScopes: Array.isArray(body.requested_scopes)
          ? body.requested_scopes.filter((scope): scope is string => typeof scope === "string").slice(0, 20)
          : DEFAULT_WORKSPACE_AGENT_SCOPES,
      });
      if (authorization) return authorization;

      // Identity shown to the approving user is the identity the core sees.
      // Retry arguments cannot silently replace the approved provenance.
      const approvedInput = {
        ...(offer.claim?.clientId ? { client_id: offer.claim.clientId } : {}),
        ...(offer.claim?.clientName ? { client_name: offer.claim.clientName } : {}),
        ...(offer.claim ? { requested_scopes: [...offer.claim.scopes] } : {}),
      };
      try {
        const payload = await this.dispatch(name, approvedInput, {
          clientName: offer.claim?.clientName ?? client.clientName,
          ...(offer.claim ? { offerClaimId: offer.claim.id } : {}),
        });
        if (!isSuccessfulAgentResult(payload) && !isRetryableAgentResult(payload)) {
          this.#replaceFailedInstructionOffer(offer);
        }
        return { responseOk: true, status: 200, payload };
      } catch (error) {
        if (!isTransientInstructionError(error)) this.#replaceFailedInstructionOffer(offer);
        return this.#backendError(error);
      }
    }

    const claim = offer.claim;
    if (!claim || claim.decision !== "approved" || !claim.instructionsSucceeded) {
      return this.#agentError(
        403,
        "instructions_required",
        "Complete an approved instruction handshake before calling workspace tools.",
        false,
        "get_workspace_instructions",
      );
    }
    try {
      const payload = await this.dispatch(name, input, {
        clientName: claim.clientName ?? client.clientName,
        offerClaimId: claim.id,
      });
      return { responseOk: true, status: 200, payload };
    } catch (error) {
      return this.#backendError(error);
    }
  }

  registerBrowser(clientInstanceId: string): { browserConnectionId: string } {
    this.#assertOpen();
    this.#assertEnabled();
    this.#validateClientInstanceId(clientInstanceId);
    if (
      this.#browser &&
      this.#now() - this.#browser.lastSeenAt <= this.#browserTtlMs
    ) {
      throw new AgentGatewayError(
        "browser_already_connected",
        "Another active SemaFrame tab already owns the agent engine. Return to it, retry after it closes, or explicitly take control.",
      );
    }
    this.#revokeBrowser(new AgentGatewayError(
      "browser_replaced",
      "A newer SemaFrame browser connection replaced this one.",
    ));
    const id = secret();
    this.#browser = { id, clientInstanceId, lastSeenAt: this.#now() };
    return { browserConnectionId: id };
  }

  takeoverBrowser(clientInstanceId: string): { browserConnectionId: string } {
    this.#assertOpen();
    this.#assertEnabled();
    this.#validateClientInstanceId(clientInstanceId);
    this.#revokeBrowser(new AgentGatewayError(
      "browser_replaced",
      "The user moved Agent control to another SemaFrame tab.",
    ));
    const id = secret();
    this.#browser = { id, clientInstanceId, lastSeenAt: this.#now() };
    return { browserConnectionId: id };
  }

  unregisterBrowser(browserConnectionId: string): { unregistered: boolean } {
    this.#assertOpen();
    if (!this.#browser || this.#browser.id !== browserConnectionId) {
      return { unregistered: false };
    }
    this.#revokeBrowser(new AgentGatewayError(
      "engine_unavailable",
      "The SemaFrame browser tab released the agent engine.",
    ));
    return { unregistered: true };
  }

  async pollBrowser(browserConnectionId: string, signal?: AbortSignal): Promise<BrowserPollResponse> {
    this.#assertOpen();
    this.#assertEnabled();
    const browser = this.#requireBrowser(browserConnectionId);
    browser.lastSeenAt = this.#now();

    if (this.#pendingCommand && !this.#pendingCommand.delivered) {
      this.#pendingCommand.delivered = true;
      return { kind: "command", command: structuredClone(this.#pendingCommand.command) };
    }

    if (this.#configWakePending) {
      this.#configWakePending = false;
      return { kind: "idle" };
    }

    this.#resolvePoll({ kind: "idle" });
    return new Promise<BrowserPollResponse>((resolve) => {
      const waiter: PollWaiter = {
        browserConnectionId,
        resolve,
        timer: setTimeout(() => {
          if (this.#pollWaiter !== waiter) return;
          this.#pollWaiter = undefined;
          waiter.detachAbort?.();
          resolve({ kind: "idle" });
        }, this.#pollTimeoutMs),
      };
      this.#pollWaiter = waiter;
      if (signal) {
        const abort = () => {
          if (this.#pollWaiter !== waiter) return;
          // A long-poll request is the browser engine's live lease. Closing or
          // reloading a tab aborts that request; retaining its registration for
          // the full TTL would falsely block the next tab. Revocation is scoped
          // to this exact waiter/connection, so a late abort can never evict a
          // replacement bridge.
          this.#revokeBrowser(new AgentGatewayError(
            "engine_unavailable",
            "The SemaFrame browser tab disconnected from the agent engine.",
          ));
        };
        signal.addEventListener("abort", abort, { once: true });
        waiter.detachAbort = () => signal.removeEventListener("abort", abort);
        // AbortSignal does not replay an abort event to listeners added after
        // it has fired, so cover the registration race explicitly.
        if (signal.aborted) abort();
      }
    });
  }

  submitBrowserResult(result: BrowserCommandResult): { accepted: true } {
    this.#assertOpen();
    this.#assertEnabled();
    const browser = this.#requireBrowser(result.browserConnectionId);
    browser.lastSeenAt = this.#now();
    const pending = this.#pendingCommand;
    if (!pending || pending.command.id !== result.commandId || !pending.delivered) {
      throw new AgentGatewayError("command_not_found", "This command is no longer awaiting a result.");
    }
    clearTimeout(pending.timer);
    this.#pendingCommand = undefined;
    if (result.ok) {
      const coreSucceeded = Boolean(
        result.result && typeof result.result === "object" && !Array.isArray(result.result) &&
        (result.result as Record<string, unknown>).ok === true,
      );
      if (coreSucceeded && isInstructionCommand(pending.command.name)) {
        this.#lastClientName = pending.clientName ?? this.#lastClientName;
        this.#lastClientSeenAt = this.#now();
        this.#lastClientSource = pending.offerClaimId ? "offer" : "legacy";
        if (
          pending.offerClaimId &&
          this.#offer?.claim?.id === pending.offerClaimId &&
          this.#offer.claim.decision === "approved"
        ) {
          this.#offer.claim.instructionsSucceeded = true;
          this.#offer.claim.grantedScopes = grantedAgentScopes(result.result);
        }
      } else if (coreSucceeded && this.#lastClientSeenAt !== undefined) {
        this.#lastClientSeenAt = this.#now();
      }
      pending.resolve(structuredClone(result.result));
    } else {
      pending.reject(new AgentGatewayError(
        result.error.code,
        result.error.message,
        structuredClone(result.error.details),
      ));
    }
    return { accepted: true };
  }

  dispatch(
    name: AgentCommandName,
    input: unknown,
    options: { clientName?: string; offerClaimId?: string } = {},
  ): Promise<unknown> {
    this.#assertOpen();
    this.#assertEnabled();
    if (!this.#isBrowserConnected()) {
      this.#revokeBrowser(new AgentGatewayError("engine_unavailable", "The SemaFrame browser engine is not connected."));
      throw new AgentGatewayError("engine_unavailable", "Open SemaFrame before calling Workspace tools.");
    }
    if (this.#pendingCommand) {
      throw new AgentGatewayError(
        "engine_busy",
        this.#pendingCommand.mutation || isMutationCommand(name)
          ? "Another Workspace command is already in flight."
          : "The browser engine is answering another request.",
      );
    }
    return new Promise<unknown>((resolve, reject) => {
      const pending: PendingCommand = {
        command: { id: randomUUID(), name, input: structuredClone(safeInstructionInput(name, input)) },
        mutation: isMutationCommand(name),
        delivered: false,
        ...(safeClientName(options.clientName) ? { clientName: safeClientName(options.clientName) } : {}),
        ...(options.offerClaimId ? { offerClaimId: options.offerClaimId } : {}),
        resolve,
        reject,
        timer: setTimeout(() => {
          if (this.#pendingCommand !== pending) return;
          this.#pendingCommand = undefined;
          reject(new AgentGatewayError(
            "engine_timeout",
            "The browser engine did not finish the command in time. Retry the same Workspace transaction if one was prepared.",
          ));
        }, this.#commandTimeoutMs),
      };
      this.#pendingCommand = pending;
      this.#deliverPendingToPoll();
    });
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#offer = undefined;
    this.#revokeBrowser(new AgentGatewayError("gateway_closed", "The agent gateway stopped."));
  }

  #assertOpen(): void {
    if (this.#closed) throw new AgentGatewayError("gateway_closed", "The agent gateway is closed.");
  }

  #assertEnabled(): void {
    if (!this.#enabled) throw new AgentGatewayError("agent_mode_disabled", "Agent control is disabled in SemaFrame.");
  }

  #validateClientInstanceId(clientInstanceId: string): void {
    if (!/^[A-Za-z0-9._~-]{8,128}$/u.test(clientInstanceId)) {
      throw new AgentGatewayError(
        "invalid_request",
        "clientInstanceId must be 8-128 URL-safe characters.",
      );
    }
  }

  #newOffer(): ConnectionOffer {
    const id = randomBytes(24).toString("base64url");
    const createdAt = this.#now();
    return {
      id,
      path: `${AGENT_MCP_CONNECTION_PREFIX}${id}`,
      createdAt,
      expiresAt: createdAt + this.#offerTtlMs,
    };
  }

  #ensureFreshOffer(): ConnectionOffer {
    const current = this.#offer;
    if (!current) {
      this.#offer = this.#newOffer();
    } else if (this.#offerNeedsRefresh(current)) {
      this.#replaceIncompleteOffer(current, "The incomplete connection offer expired before the instruction handshake completed.");
    }
    return this.#offer as ConnectionOffer;
  }

  #offerHandshakeCompleted(offer: ConnectionOffer): boolean {
    return offer.claim?.decision === "approved" && offer.claim.instructionsSucceeded;
  }

  #offerNeedsRefresh(offer: ConnectionOffer): boolean {
    if (this.#offerHandshakeCompleted(offer)) return false;
    if (offer.claim && this.#pendingCommand?.offerClaimId === offer.claim.id) {
      // The deadline gates starting the approved handshake. Once its browser
      // command is in flight, let that bounded command finish or time out.
      return false;
    }
    const now = this.#now();
    return now >= offer.expiresAt || Boolean(offer.claim && now >= offer.claim.expiresAt);
  }

  #replaceIncompleteOffer(offer: ConnectionOffer, message: string): boolean {
    if (this.#offer !== offer || this.#offerHandshakeCompleted(offer)) return false;
    const replacedClaimId = offer.claim?.id;
    this.#offer = this.#newOffer();
    if (replacedClaimId && this.#pendingCommand?.offerClaimId === replacedClaimId) {
      this.#rejectPending(new AgentGatewayError("connection_invalid", message));
    }
    this.#markConfigChanged();
    return true;
  }

  #replaceFailedInstructionOffer(offer: ConnectionOffer): void {
    this.#replaceIncompleteOffer(
      offer,
      "The incomplete connection claim failed before the instruction handshake completed.",
    );
  }

  #offerView(offer: ConnectionOffer): AgentConnectionOffer;
  #offerView(offer?: ConnectionOffer): AgentConnectionOffer | undefined;
  #offerView(offer = this.#offer): AgentConnectionOffer | undefined {
    if (!offer) return undefined;
    return Object.freeze({
      connectionUrl: `${this.#publicBaseUrl}${offer.path}`,
      offerExpiresAt: new Date(offer.expiresAt).toISOString(),
      offerStatus: this.#offerStatus(offer),
    });
  }

  #offerStatus(offer: ConnectionOffer): AgentOfferStatus {
    const claim = offer.claim;
    if (this.#offerHandshakeCompleted(offer)) return "approved";
    if (this.#offerNeedsRefresh(offer)) return "expired";
    if (!claim) return "waiting";
    if (claim.decision === "pending") return "approval_pending";
    if (claim.decision === "approved") return "approval_granted";
    return "denied";
  }

  #pendingApprovalView(): AgentPendingApproval | undefined {
    const offer = this.#offer;
    if (!offer || this.#offerStatus(offer) !== "approval_pending" || !offer.claim) return undefined;
    const claim = offer.claim;
    return Object.freeze({
      claimId: claim.id,
      ...(claim.clientId ? { clientId: claim.clientId } : {}),
      ...(claim.clientName ? { clientName: claim.clientName } : {}),
      scopes: [...claim.scopes],
      fingerprint: claim.fingerprint,
      requestedAt: new Date(claim.requestedAt).toISOString(),
      expiresAt: new Date(claim.expiresAt).toISOString(),
    });
  }

  #requireOfferPath(pathname: string): ConnectionOffer {
    this.#assertOpen();
    this.#assertEnabled();
    const offer = this.#offer;
    if (!offer || pathname !== offer.path) {
      throw new AgentGatewayError("connection_invalid", "This connection offer is invalid or was replaced.");
    }
    if (this.#offerNeedsRefresh(offer)) {
      this.#replaceIncompleteOffer(
        offer,
        "The incomplete connection offer expired before the instruction handshake completed.",
      );
      throw new AgentGatewayError("connection_offer_expired", "This connection offer expired. Create a fresh link in SemaFrame.");
    }
    return offer;
  }

  #requireClaim(claimId: string): ApprovalClaim {
    this.#assertOpen();
    this.#assertEnabled();
    if (!/^[0-9a-f-]{36}$/iu.test(claimId)) {
      throw new AgentGatewayError("invalid_request", "claimId is invalid.");
    }
    const offer = this.#offer;
    if (offer && this.#offerNeedsRefresh(offer)) {
      this.#replaceIncompleteOffer(
        offer,
        "The incomplete connection offer expired before the instruction handshake completed.",
      );
    }
    if (!this.#offer || !this.#offer.claim || this.#offer.claim.id !== claimId) {
      throw new AgentGatewayError("approval_invalid", "This approval request is invalid or expired.");
    }
    return this.#offer.claim;
  }

  #authorizeInstructionClaim(
    offer: ConnectionOffer,
    approvalToken: string | undefined,
    client: {
      clientId?: string;
      clientName?: string;
      requestedScopes: readonly string[];
    },
  ): { responseOk: boolean; status: number; payload: unknown } | undefined {
    let claim = offer.claim;
    if (!claim) {
      if (approvalToken) {
        return this.#agentError(403, "approval_invalid", "The approval token does not match this connection offer.", false);
      }
      const token = secret();
      const digest = tokenDigest(token);
      const requestedAt = this.#now();
      claim = {
        id: randomUUID(),
        tokenHash: digest,
        fingerprint: tokenFingerprint(digest),
        ...(safeClientId(client.clientId) ? { clientId: safeClientId(client.clientId) } : {}),
        ...(safeClientName(client.clientName) ? { clientName: safeClientName(client.clientName) } : {}),
        scopes: Object.freeze([...new Set(client.requestedScopes)].sort()),
        requestedAt,
        expiresAt: Math.min(offer.expiresAt, requestedAt + this.#approvalTtlMs),
        decision: "pending",
        instructionsSucceeded: false,
      };
      offer.claim = claim;
      // Wake the browser bridge immediately so it fetches config and can show
      // the approval card instead of waiting for the long-poll timeout.
      this.#markConfigChanged();
      return this.#agentError(
        428,
        "approval_pending",
        "SemaFrame is waiting for the user to approve this client. Ask the user to compare approval_fingerprint with the code shown in SemaFrame. Keep approval_token private, then retry the same instruction tool with it after approval.",
        true,
        "request_user_approval",
        {
          approval_token: token,
          approval_fingerprint: claim.fingerprint,
          claim_id: claim.id,
          approval_expires_at: new Date(claim.expiresAt).toISOString(),
          requested_scopes: [...claim.scopes],
        },
      );
    }
    if (!approvalToken) {
      return this.#agentError(
        428,
        "approval_token_required",
        "A request already claimed this link. Retry with its private approval_token, or create a fresh link in SemaFrame.",
        false,
        "request_user_approval",
      );
    }
    if (!tokenMatches(approvalToken, claim.tokenHash)) {
      return this.#agentError(403, "approval_invalid", "The approval token is invalid for this request.", false);
    }
    if (claim.decision === "denied") {
      return this.#agentError(403, "approval_denied", "The SemaFrame user denied this connection request.", false);
    }
    if (claim.decision === "pending") {
      return this.#agentError(
        428,
        "approval_pending",
        "SemaFrame is still waiting for the user to approve this agent.",
        true,
        "request_user_approval",
        {
          approval_fingerprint: claim.fingerprint,
          claim_id: claim.id,
          approval_expires_at: new Date(claim.expiresAt).toISOString(),
        },
      );
    }
    return undefined;
  }

  #agentError(
    status: number,
    code: string,
    message: string,
    retryable: boolean,
    requiredAction?: AgentCommandName | "request_user_approval",
    details?: Record<string, unknown>,
  ): { responseOk: false; status: number; payload: unknown } {
    return {
      responseOk: false,
      status,
      payload: {
        ok: false,
        error: {
          code,
          message,
          retryable,
          ...(requiredAction ? { required_action: requiredAction } : {}),
          ...(details ? { details } : {}),
        },
      },
    };
  }

  #backendError(error: unknown): { responseOk: false; status: number; payload: unknown } {
    if (error instanceof AgentGatewayError) {
      const status = error.code === "engine_timeout" ? 504
        : error.code === "agent_mode_disabled" || error.code === "engine_unavailable" || error.code === "gateway_closed" ? 503
          : error.code === "invalid_request" ? 400
            : 409;
      return this.#agentError(status, error.code, error.message, isTransientInstructionError(error), undefined,
        error.details && typeof error.details === "object" && !Array.isArray(error.details)
          ? error.details as Record<string, unknown>
          : undefined);
    }
    return this.#agentError(500, "gateway_error", "The SemaFrame agent gateway could not complete the request.", false);
  }

  #isBrowserConnected(): boolean {
    return Boolean(
      this.#enabled && this.#browser && this.#now() - this.#browser.lastSeenAt <= this.#browserTtlMs,
    );
  }

  #isExternalClientConnected(): boolean {
    if (
      this.#lastClientSource === "offer" &&
      this.#offer?.claim?.decision === "approved" &&
      this.#offer.claim.instructionsSucceeded
    ) {
      return this.#isBrowserConnected();
    }
    return Boolean(
      this.#enabled && this.#lastClientSeenAt !== undefined &&
      this.#now() - this.#lastClientSeenAt <= this.#browserTtlMs,
    );
  }

  #requireBrowser(id: string): BrowserConnection {
    if (!this.#browser || this.#browser.id !== id) {
      throw new AgentGatewayError("connection_invalid", "The browser connection is invalid or expired.");
    }
    if (this.#now() - this.#browser.lastSeenAt > this.#browserTtlMs) {
      const error = new AgentGatewayError(
        "connection_invalid",
        "The browser connection expired. Register the SemaFrame engine again.",
      );
      this.#revokeBrowser(error);
      throw error;
    }
    return this.#browser;
  }

  #deliverPendingToPoll(): void {
    const pending = this.#pendingCommand;
    const waiter = this.#pollWaiter;
    if (!pending || pending.delivered || !waiter || waiter.browserConnectionId !== this.#browser?.id) return;
    pending.delivered = true;
    this.#resolvePoll({ kind: "command", command: structuredClone(pending.command) });
  }

  #resolvePoll(value: BrowserPollResponse): void {
    const waiter = this.#pollWaiter;
    if (!waiter) return;
    this.#pollWaiter = undefined;
    clearTimeout(waiter.timer);
    waiter.detachAbort?.();
    waiter.resolve(value);
  }

  #markConfigChanged(): void {
    if (this.#pollWaiter) {
      this.#resolvePoll({ kind: "idle" });
    } else {
      this.#configWakePending = true;
    }
  }

  #rejectPending(error: AgentGatewayError): void {
    const pending = this.#pendingCommand;
    if (!pending) return;
    this.#pendingCommand = undefined;
    clearTimeout(pending.timer);
    pending.reject(error);
  }

  #revokeBrowser(error: AgentGatewayError): void {
    this.#resolvePoll({ kind: "idle" });
    this.#rejectPending(error);
    this.#browser = undefined;
  }
}
