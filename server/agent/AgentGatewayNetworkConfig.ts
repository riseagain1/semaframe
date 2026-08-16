export type AgentGatewayNetworkConfig = Readonly<{
  bindHost: "127.0.0.1" | "localhost" | "::1";
  port: number;
  publicBaseUrl: string;
  allowedHostnames: readonly string[];
}>;

type Environment = Readonly<Record<string, string | undefined>>;

const LOOPBACK_HOSTS = ["127.0.0.1", "localhost", "::1"] as const;

export function normalizeAgentGatewayPublicBaseUrl(value: string): string {
  const parsed = new URL(value);
  const isLoopbackHttp = parsed.protocol === "http:" &&
    ["127.0.0.1", "localhost", "::1", "[::1]"].includes(parsed.hostname);
  if (
    !(parsed.protocol === "https:" || isLoopbackHttp) ||
    parsed.username ||
    parsed.password ||
    parsed.pathname !== "/" ||
    parsed.search ||
    parsed.hash
  ) {
    throw new Error("Agent gateway publicBaseUrl must be an unauthenticated HTTPS origin or loopback HTTP origin.");
  }
  return parsed.origin;
}

/**
 * Resolves advertised and listener addresses independently. A reverse proxy
 * may publish trusted HTTPS while the process remains loopback-only.
 */
export function resolveAgentGatewayNetworkConfig(env: Environment): AgentGatewayNetworkConfig {
  const requestedHost = env.SEMAFRAME_AGENT_GATEWAY_HOST?.trim() || "127.0.0.1";
  if (!(LOOPBACK_HOSTS as readonly string[]).includes(requestedHost)) {
    throw new Error("The SemaFrame Agent Gateway may only bind to a loopback host.");
  }
  const bindHost = requestedHost as AgentGatewayNetworkConfig["bindHost"];
  const rawPort = env.SEMAFRAME_AGENT_GATEWAY_PORT?.trim();
  const port = rawPort ? Number(rawPort) : 8788;
  if (!Number.isSafeInteger(port) || port <= 0 || port > 65_535) {
    throw new Error("SEMAFRAME_AGENT_GATEWAY_PORT must be an integer between 1 and 65535.");
  }
  const publicHost = bindHost === "::1" ? "[::1]" : bindHost;
  const publicBaseUrl = normalizeAgentGatewayPublicBaseUrl(
    env.SEMAFRAME_AGENT_GATEWAY_PUBLIC_URL?.trim() || `http://${publicHost}:${port}`,
  );
  const advertisedHostname = new URL(publicBaseUrl).hostname;
  return Object.freeze({
    bindHost,
    port,
    publicBaseUrl,
    allowedHostnames: Object.freeze([
      ...new Set(["localhost", "127.0.0.1", "[::1]", advertisedHostname]),
    ]),
  });
}
