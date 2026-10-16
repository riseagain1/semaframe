import type { CallToolResult } from "@modelcontextprotocol/server";

type HandshakeClaim = Readonly<{
  token: string;
  clientId?: string;
  clientName?: string;
  scopes?: readonly string[];
}>;

const INVALIDATING_ERRORS = new Set([
  "approval_invalid", "approval_denied", "connection_invalid",
  "connection_offer_expired", "pairing_rotated", "agent_mode_disabled", "gateway_closed",
]);

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function scopes(value: unknown): readonly string[] | undefined {
  if (!Array.isArray(value) || !value.every((scope) => typeof scope === "string")) return undefined;
  return [...new Set(value as string[])].sort();
}

function matches(claim: HandshakeClaim, input: Record<string, unknown>): boolean {
  if (input.client_id !== undefined && input.client_id !== claim.clientId) return false;
  if (input.client_name !== undefined && input.client_name !== claim.clientName) return false;
  if (input.requested_scopes !== undefined
    && JSON.stringify(scopes(input.requested_scopes)) !== JSON.stringify(claim.scopes)) return false;
  return true;
}

function token(value: unknown): value is string {
  return typeof value === "string" && value.length >= 32 && value.length <= 256;
}

function approvedClaim(proof: string, value: unknown): HandshakeClaim | undefined {
  const data = record(value);
  if (!data || typeof data.client_id !== "string" || !data.client_id.length || data.client_id.length > 128) return undefined;
  if (data.client_name !== undefined
    && (typeof data.client_name !== "string" || !data.client_name.length || data.client_name.length > 160)) return undefined;
  const requestedScopes = scopes(data.requested_scopes);
  if (!requestedScopes) return undefined;
  return Object.freeze({
    token: proof,
    clientId: data.client_id,
    ...(data.client_name === undefined ? {} : { clientName: data.client_name as string }),
    scopes: requestedScopes,
  });
}

function contextMismatch(claim: HandshakeClaim): CallToolResult {
  const payload = {
    ok: false,
    error: {
      code: "approval_token_required",
      message: "This MCP session retains an approval continuation, but the explicit client identity or requested scopes changed. Retry get_workspace_instructions with the original identity and scopes, or omit those fields to continue this session. Creating another URL is not needed to continue the original request.",
      retryable: true,
      required_action: "get_workspace_instructions",
      details: {
        reason: "approval_context_mismatch",
        continuation_available: true,
        ...(claim.clientId === undefined ? {} : { client_id: claim.clientId }),
        ...(claim.clientName === undefined ? {} : { client_name: claim.clientName }),
        ...(claim.scopes === undefined ? {} : { requested_scopes: [...claim.scopes] }),
      },
    },
  };
  return { content: [{ type: "text", text: JSON.stringify(payload) }], structuredContent: payload, isError: true };
}

/**
 * One downstream protocol session's private handshake continuation, never a
 * separate authorization path. Only an upstream-issued token, either returned
 * by its offer or explicitly supplied and verified by a successful handshake,
 * is retained in memory for that same offer/identity/scope set.
 * The gateway still checks the token and the user's decision on every call.
 * Optional identity fields omitted by that same client inherit its claim;
 * explicitly different identity/scopes or an explicit token are never replaced.
 */
export class AgentMcpHandshakeSession {
  #offerKey: string | undefined;
  #claim: HandshakeClaim | undefined;
  #generation = 0;
  #instructionTail: Promise<unknown> = Promise.resolve();

  clear(): void {
    this.#offerKey = undefined;
    this.#claim = undefined;
    this.#generation += 1;
  }

  async call(
    offerKey: string,
    name: string,
    input: unknown,
    invoke: (arguments_: Record<string, unknown>) => Promise<CallToolResult>,
    signal?: AbortSignal,
  ): Promise<CallToolResult> {
    if (this.#offerKey !== offerKey) {
      this.clear();
      this.#offerKey = offerKey;
    }
    const generation = this.#generation;
    const arguments_ = { ...record(input) };
    const instruction = name === "get_workspace_instructions";
    const run = async (): Promise<CallToolResult> => {
      signal?.throwIfAborted();
      const claim = this.#generation === generation ? this.#claim : undefined;
      if (instruction && arguments_.approval_token === undefined && claim && !matches(claim, arguments_)) {
        // Retain the original continuation, never lend it to a different
        // identity/scope request, and explain the recoverable local mismatch.
        return contextMismatch(claim);
      }
      const forwarded = instruction && arguments_.approval_token === undefined
        && claim && matches(claim, arguments_)
        ? {
          ...(claim.clientId === undefined ? {} : { client_id: claim.clientId }),
          ...(claim.clientName === undefined ? {} : { client_name: claim.clientName }),
          ...(claim.scopes === undefined ? {} : { requested_scopes: [...claim.scopes] }),
          ...arguments_,
          approval_token: claim.token,
        }
        : arguments_;
      const result = await invoke(forwarded);
      if (this.#generation !== generation) return result;
      const payload = record(result.structuredContent);
      const error = payload?.ok === false ? record(payload.error) : undefined;
      if (typeof error?.code === "string" && INVALIDATING_ERRORS.has(error.code)) {
        this.clear();
        return result;
      }
      if (instruction && error?.code === "approval_pending") {
        const details = record(error.details);
        const proof = details?.approval_token;
        if (token(proof)) {
          const clientId = typeof arguments_.client_id === "string" ? arguments_.client_id
            : typeof details?.client_id === "string" && details.client_id.length <= 128 ? details.client_id
              : undefined;
          this.#claim = Object.freeze({
            token: proof,
            ...(clientId === undefined ? {} : { clientId }),
            ...(typeof arguments_.client_name === "string" ? { clientName: arguments_.client_name } : {}),
            scopes: scopes(details?.requested_scopes) ?? scopes(arguments_.requested_scopes),
          });
        }
      }
      if (instruction && result.isError !== true && payload?.ok === true && token(arguments_.approval_token)) {
        // A caller may explicitly resume its own proof after a bridge restart.
        // Only the upstream-approved response supplies canonical provenance;
        // never adopt identity/scopes from retry arguments or a pending/error
        // response that did not return a newly issued continuation token.
        const approved = approvedClaim(arguments_.approval_token, payload.data);
        if (approved) this.#claim = approved;
      }
      return result;
    };
    if (!instruction) return await run();
    // The first pending response is the only response containing its token.
    // Queue concurrent instruction calls so the second can continue the first
    // claim, without auto-retrying any request or replaying a workspace write.
    const pending = this.#instructionTail.then(run, run);
    this.#instructionTail = pending.catch(() => undefined);
    return await pending;
  }
}
