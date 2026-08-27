import {
  ProtocolError,
  SdkError,
  SdkErrorCode,
} from "@modelcontextprotocol/client";

export type AgentMcpUpstreamFailureKind = "cancelled" | "request" | "connection";

const CONNECTION_SDK_ERRORS = new Set<SdkErrorCode>([
  SdkErrorCode.NotConnected,
  SdkErrorCode.NotInitialized,
  SdkErrorCode.RequestTimeout,
  SdkErrorCode.ConnectionClosed,
  SdkErrorCode.SendFailed,
  SdkErrorCode.EraNegotiationFailed,
  SdkErrorCode.ClientHttpAuthentication,
  SdkErrorCode.ClientHttpForbidden,
  SdkErrorCode.ClientHttpNotImplemented,
  SdkErrorCode.ClientHttpUnexpectedContent,
  SdkErrorCode.ClientHttpFailedToOpenStream,
]);

function abortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

/**
 * Separates a cancelled request and deterministic MCP/SDK rejections from a
 * broken transport. Only the latter is allowed to tear down the shared
 * upstream client: one invalid tool call must never abort unrelated calls.
 */
export function classifyAgentMcpUpstreamFailure(
  error: unknown,
  signal?: AbortSignal,
): AgentMcpUpstreamFailureKind {
  if (signal?.aborted || abortError(error)) return "cancelled";
  if (ProtocolError.isInstance(error)) {
    // Every ProtocolError is a JSON-RPC error response received for this
    // request. Even InternalError and ParseError prove that the shared
    // transport exchanged a response; closing it would abort unrelated calls.
    return "request";
  }
  if (SdkError.isInstance(error)) {
    return CONNECTION_SDK_ERRORS.has(error.code) ? "connection" : "request";
  }
  return "connection";
}

export type ExecuteAgentMcpUpstreamCallOptions<Result> = Readonly<{
  signal?: AbortSignal;
  invoke(): Promise<Result>;
  onRequestError(error: unknown): Result | Promise<Result>;
  onConnectionError(error: unknown): Result | Promise<Result>;
}>;

/**
 * Applies the shared-client failure policy around one upstream MCP request.
 * Cancellation remains an AbortError for the downstream request, deterministic
 * request failures become local error results, and only connection failures
 * enter the caller's reconnect path.
 */
export async function executeAgentMcpUpstreamCall<Result>(
  options: ExecuteAgentMcpUpstreamCallOptions<Result>,
): Promise<Result> {
  try {
    return await options.invoke();
  } catch (error) {
    const kind = classifyAgentMcpUpstreamFailure(error, options.signal);
    if (kind === "cancelled") throw error;
    if (kind === "request") return await options.onRequestError(error);
    return await options.onConnectionError(error);
  }
}

export type AgentMcpToolCatalogRefreshResult = "applied" | "superseded";

/**
 * Gives every client's catalog refresh a monotonic generation. Notification
 * and discovery polling may overlap, but only the newest request for a client
 * can mutate the mirrored catalog (or surface its failure). Older completions
 * are deliberately ignored.
 */
export class AgentMcpToolCatalogRefreshCoordinator<ClientKey extends object> {
  readonly #latestGeneration = new WeakMap<ClientKey, number>();

  async refresh<Catalog>(
    client: ClientKey,
    load: () => Promise<Catalog>,
    apply: (catalog: Catalog) => void,
  ): Promise<AgentMcpToolCatalogRefreshResult> {
    const generation = (this.#latestGeneration.get(client) ?? 0) + 1;
    this.#latestGeneration.set(client, generation);
    let catalog: Catalog;
    try {
      catalog = await load();
    } catch (error) {
      if (this.#latestGeneration.get(client) !== generation) return "superseded";
      throw error;
    }
    if (this.#latestGeneration.get(client) !== generation) return "superseded";
    apply(catalog);
    return "applied";
  }

  invalidate(client: ClientKey): void {
    this.#latestGeneration.set(client, (this.#latestGeneration.get(client) ?? 0) + 1);
  }
}
