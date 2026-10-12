// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  createServer: vi.fn(),
  validateHost: vi.fn(() => true),
  loadEnvironment: vi.fn(),
  native: vi.fn(),
  handler: Object.assign(vi.fn(), { close: vi.fn() }),
  createHandler: vi.fn(),
  createGateway: vi.fn(),
  installations: vi.fn(),
  shutdown: vi.fn(),
  ultra: vi.fn(),
  network: vi.fn(),
  server: { on: vi.fn(), listen: vi.fn() },
}));

vi.mock("node:http", () => ({ createServer: state.createServer }));
vi.mock("@modelcontextprotocol/node", () => ({ hostHeaderValidation: () => state.validateHost }));
vi.mock("../../../scripts/lib/root-env.mjs", () => ({ loadRootEnvironment: state.loadEnvironment }));
vi.mock("../../../scripts/lib/agent-installation.mjs", () => ({ createAgentInstallationService: state.installations }));
vi.mock("../../../server/agent/AgentClientInstallationService", () => ({ AgentClientInstallationService: class {} }));
vi.mock("../../../server/agent/AgentGateway", () => ({
  AgentGateway: class { constructor(options: unknown) { state.createGateway(options); } },
}));
vi.mock("../../../server/agent/AgentGatewayHttpHandler", () => ({ createNodeAgentGatewayHttpHandler: state.createHandler }));
vi.mock("../../../server/agent/AgentGatewayNetworkConfig", () => ({ resolveAgentGatewayNetworkConfig: state.network }));
vi.mock("../../../server/agent/shutdown", () => ({
  closeAgentGatewayStack: state.shutdown,
  resolveAgentGatewayShutdownTimeout: () => 1234,
}));
vi.mock("../../../server/xr", () => ({ createWindowsUltraEvidenceProvider: state.ultra }));
vi.mock("../../../server/voice-relay", () => ({
  createVoiceRelayNativeClient: state.native,
  VoiceRelayService: class { constructor(readonly native: unknown) {} },
}));

const signalListeners = new Map<string, () => void>();
const envNames = [
  "SEMAFRAME_AGENT_ALLOWED_ORIGINS", "SEMAFRAME_XR_ALLOWED_ORIGINS", "SEMAFRAME_AGENT_BODY_LIMIT_BYTES",
  "SEMAFRAME_AGENT_BROWSER_TOKEN", "SEMAFRAME_VOICE_RELAY_HELPER_PATH", "SEMAFRAME_VOICE_RELAY_HELPER_SHA256",
  "SEMAFRAME_VOICE_RELAY_ALLOW_UNSIGNED_HELPER", "SEMAFRAME_VOICE_RELAY_REQUEST_TIMEOUT_MS",
  "SEMAFRAME_AGENT_COMMAND_TIMEOUT_MS", "SEMAFRAME_AGENT_POLL_TIMEOUT_MS", "SEMAFRAME_AGENT_BROWSER_TTL_MS",
  "SEMAFRAME_AGENT_OFFER_TTL_MS", "SEMAFRAME_AGENT_APPROVAL_TTL_MS",
];
beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  signalListeners.clear();
  for (const name of envNames) vi.stubEnv(name, undefined);
  state.createServer.mockReturnValue(state.server);
  state.createHandler.mockReturnValue(state.handler);
  state.network.mockReturnValue({ bindHost: "127.0.0.1", port: 8788, publicBaseUrl: "https://agent.example", allowedHostnames: ["agent.example"] });
  state.native.mockResolvedValue(undefined);
  state.ultra.mockReturnValue(undefined);
  state.shutdown.mockResolvedValue(undefined);
  state.validateHost.mockReturnValue(true);
  vi.spyOn(process, "on").mockImplementation(((name: string, callback: () => void) => {
    signalListeners.set(name, callback);
    return process;
  }) as typeof process.on);
  vi.spyOn(process, "exit").mockImplementation((() => undefined) as typeof process.exit);
  vi.spyOn(console, "log").mockImplementation(() => undefined);
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });

const start = () => import("../../../server/agent/start");

describe("gateway startup security and lifecycle", () => {
  it("uses a loopback bootstrap even when advertising a proxy, validates hosts, and closes only once", async () => {
    await start();
    expect(state.loadEnvironment).toHaveBeenCalledOnce();
    expect(state.installations).toHaveBeenCalledWith(expect.objectContaining({ gatewayUrl: "http://127.0.0.1:8788" }));
    const options = state.createHandler.mock.calls[0]![1];
    expect(options.allowedOrigins).toEqual(["http://127.0.0.1:4173", "http://localhost:4173", "https://agent.example"]);
    expect(options.browserBootstrapToken).toMatch(/^[A-Za-z0-9_-]{43}$/u);
    expect(options.bodyLimitBytes).toBe(512 * 1024);
    const request = {}, response = {};
    const dispatch = state.createServer.mock.calls[0]![0];
    state.validateHost.mockReturnValue(false);
    dispatch(request, response);
    expect(state.handler).not.toHaveBeenCalled();
    state.validateHost.mockReturnValue(true);
    dispatch(request, response);
    expect(state.handler).toHaveBeenCalledWith(request, response);
    const socket = { end: vi.fn() };
    state.server.on.mock.calls.find(([name]) => name === "clientError")![1](new Error("private"), socket);
    expect(socket.end).toHaveBeenCalledWith("HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n");
    state.server.listen.mock.calls[0]![2]();
    expect(console.log).toHaveBeenCalledWith("SemaFrame Agent Gateway listening on https://agent.example");
    expect(JSON.stringify(vi.mocked(console.log).mock.calls)).not.toContain(options.browserBootstrapToken);
    signalListeners.get("SIGINT")!();
    signalListeners.get("SIGTERM")!();
    await Promise.resolve();
    expect(state.shutdown).toHaveBeenCalledOnce();
    expect(state.shutdown).toHaveBeenCalledWith(expect.objectContaining({ server: state.server, handler: state.handler, timeoutMs: 1234 }));
    expect(process.exit).toHaveBeenCalledWith(0);
  });

  it("configures optional helpers and exact deduplicated origins while retaining IPv6 loopback", async () => {
    state.network.mockReturnValue({ bindHost: "::1", port: 8788, publicBaseUrl: "http://[::1]:8788", allowedHostnames: ["[::1]"] });
    state.native.mockResolvedValue({ native: true });
    state.ultra.mockReturnValue({ evidence: true });
    vi.stubEnv("SEMAFRAME_AGENT_ALLOWED_ORIGINS", " http://localhost:4173, ,http://localhost:4173 ");
    vi.stubEnv("SEMAFRAME_XR_ALLOWED_ORIGINS", "https://xr.example");
    vi.stubEnv("SEMAFRAME_AGENT_BODY_LIMIT_BYTES", "1024");
    vi.stubEnv("SEMAFRAME_AGENT_BROWSER_TOKEN", "x".repeat(43));
    vi.stubEnv("SEMAFRAME_VOICE_RELAY_HELPER_PATH", " /safe/helper ");
    vi.stubEnv("SEMAFRAME_VOICE_RELAY_HELPER_SHA256", " AB12 ");
    vi.stubEnv("SEMAFRAME_VOICE_RELAY_ALLOW_UNSIGNED_HELPER", "1");
    vi.stubEnv("SEMAFRAME_VOICE_RELAY_REQUEST_TIMEOUT_MS", "2000");
    await start();
    expect(state.native).toHaveBeenCalledWith(expect.objectContaining({ helperPath: "/safe/helper", expectedSha256: "ab12", allowUnsignedDevelopmentHelper: true, requestTimeoutMs: 2000 }));
    expect(state.installations).toHaveBeenCalledWith(expect.objectContaining({ gatewayUrl: "http://[::1]:8788" }));
    expect(state.createHandler.mock.calls[0]![1]).toMatchObject({ bodyLimitBytes: 1024, browserBootstrapToken: "x".repeat(43), xrUltraEvidence: { evidence: true }, voiceRelayService: { native: { native: true } }, xrRendererOrigins: ["https://xr.example"] });
  });

  it("fails closed on cleanup failure without logging private diagnostics; missing native helper stays optional", async () => {
    state.native.mockRejectedValue(new Error("/private/helper"));
    state.shutdown.mockRejectedValue(new Error("secret-cleanup-capability"));
    await start();
    expect(state.createHandler.mock.calls[0]![1]).not.toHaveProperty("voiceRelayService");
    signalListeners.get("SIGTERM")!();
    await Promise.resolve();
    expect(process.exit).toHaveBeenCalledWith(1);
    expect(console.error).toHaveBeenCalledWith("SemaFrame Agent Gateway shutdown could not complete all cleanup work.");
    expect(JSON.stringify(vi.mocked(console.error).mock.calls)).not.toContain("secret");
  });

  it.each(["0", "-1", "1.5", "NaN", "9007199254740992"])("rejects invalid bounded integer configuration %s before listening", async (value) => {
    vi.stubEnv("SEMAFRAME_AGENT_BODY_LIMIT_BYTES", value);
    await expect(start()).rejects.toThrow("must be a positive integer");
    expect(state.createServer).not.toHaveBeenCalled();
  });
  it.each(["", " , ", "https://user:pass@example.com", "https://example.com/path", "https://example.com/", "https://example.com?x=1"])("rejects non-exact browser origin %s", async (value) => {
    vi.stubEnv("SEMAFRAME_AGENT_ALLOWED_ORIGINS", value);
    await expect(start()).rejects.toThrow();
    expect(state.createServer).not.toHaveBeenCalled();
  });
  it("rejects a weak bootstrap capability", async () => {
    vi.stubEnv("SEMAFRAME_AGENT_BROWSER_TOKEN", "short");
    await expect(start()).rejects.toThrow("256-bit base64url");
    expect(state.createServer).not.toHaveBeenCalled();
  });
});
