import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  AgentConnectionPage,
  type AgentConnectionPageProps,
  type AgentConnectionSetup,
  type AgentConnectionStatus,
} from "../../app/components/AgentConnectionPage";

const MCP_CONFIG = JSON.stringify({
  mcpServers: {
    semaframe: {
      command: "/usr/local/bin/node",
      args: [
        "--import",
        "file:///Applications/SemaFrame/node_modules/tsx/dist/loader.mjs",
        "/Applications/SemaFrame/scripts/agent-mcp.ts",
      ],
      env: { SEMAFRAME_AGENT_GATEWAY_URL: "http://127.0.0.1:4317" },
    },
  },
});
const EXPECTED_PATCH = JSON.stringify([{
  insert: [{
    id: "semaframe-mcp",
    name: "@deepseek-ai/dsh-mcp-client",
    config: {
      serverName: "semaframe",
      transport: "stdio",
      command: "/usr/local/bin/node",
      args: [
        "--import",
        "file:///Applications/SemaFrame/node_modules/tsx/dist/loader.mjs",
        "/Applications/SemaFrame/scripts/agent-mcp.ts",
      ],
      env: {
        SEMAFRAME_AGENT_GATEWAY_URL: "http://127.0.0.1:4317",
        SEMAFRAME_AGENT_NAME: "DeepSeek Harness",
      },
      toolCallTimeoutMs: 60000,
    },
  }],
}], null, 2);

const originalClipboard = Object.getOwnPropertyDescriptor(navigator, "clipboard");
const writeText = vi.fn<(_: string) => Promise<void>>();

beforeEach(() => {
  writeText.mockReset().mockResolvedValue(undefined);
  Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  if (originalClipboard) Object.defineProperty(navigator, "clipboard", originalClipboard);
  else Reflect.deleteProperty(navigator, "clipboard");
});

function props(overrides: Partial<AgentConnectionPageProps> = {}): AgentConnectionPageProps {
  return {
    status: "waiting",
    connectionUrl: "http://127.0.0.1:4317/mcp/connect/non-authorizing-offer",
    onEnable: vi.fn(),
    onCopySetup: vi.fn(async () => ({ mcpConfig: MCP_CONFIG })),
    onCopyRestSetup: vi.fn(async () => ({ restConfig: "Bearer private-rest-credential" })),
    onPermissionChange: vi.fn(),
    onRevoke: vi.fn(),
    onDisableAgentControl: vi.fn(),
    onApprove: vi.fn(),
    onManageAgentInstallation: vi.fn(),
    ...overrides,
  };
}

function renderDsh(callbacks: AgentConnectionPageProps) {
  const result = render(<AgentConnectionPage {...callbacks} />);
  const summary = screen.queryByText("DeepSeek Harness (dsh)")?.closest("summary");
  if (summary) fireEvent.click(summary);
  return result;
}

describe("DeepSeek Harness Agent setup", () => {
  it("provides client-specific launch and overlay instructions without auto-installing or starting anything", () => {
    const callbacks = props();
    renderDsh(callbacks);
    const card = screen.getByRole("region", { name: "DeepSeek Harness (dsh) setup" });

    expect(within(card).getByText("semaframe agent launch --client dsh")).toBeVisible();
    expect(within(card).getByText("dsh web --patch ./semaframe.dsh.json")).toBeVisible();
    expect(within(card).getByText("semaframe.dsh.json")).toBeVisible();
    expect(screen.getByText(/Install your chosen Agent client and configure its model there/u)).toBeVisible();
    expect(screen.getByText(/For any client, review its fingerprint and requested permissions/u)).toBeVisible();
    expect(within(card).getByRole("button", { name: "Copy DSH configuration" })).toBeEnabled();
    expect(within(card).queryByRole("button", { name: /install|launch|approve/iu })).not.toBeInTheDocument();
    expect(screen.queryByText("Install once")).not.toBeInTheDocument();
    expect(callbacks.onCopySetup).not.toHaveBeenCalled();
    expect(callbacks.onCopyRestSetup).not.toHaveBeenCalled();
    expect(callbacks.onManageAgentInstallation).not.toHaveBeenCalled();
    expect(callbacks.onEnable).not.toHaveBeenCalled();
    expect(callbacks.onApprove).not.toHaveBeenCalled();
  });

  it.each(["object", "string"])("copies the exact credential-free DSH overlay from the %s MCP callback without other actions", async (shape) => {
    const callbacks = props({
      onCopySetup: vi.fn(async () => shape === "object" ? { mcpConfig: MCP_CONFIG } : MCP_CONFIG),
    });
    const { container } = renderDsh(callbacks);

    fireEvent.click(screen.getByRole("button", { name: "Copy DSH configuration" }));

    await waitFor(() => expect(writeText).toHaveBeenCalledExactlyOnceWith(EXPECTED_PATCH));
    expect(screen.getByRole("button", { name: "DSH configuration copied" })).toBeEnabled();
    expect(screen.getByRole("status")).toHaveTextContent("your existing DSH configuration stays unchanged");
    expect(writeText.mock.calls[0]?.[0]).not.toMatch(/Bearer|private-rest-credential|non-authorizing-offer/u);
    expect(container).not.toHaveTextContent("private-rest-credential");
    expect(callbacks.onCopySetup).toHaveBeenCalledOnce();
    expect(callbacks.onCopyRestSetup).not.toHaveBeenCalled();
    expect(callbacks.onManageAgentInstallation).not.toHaveBeenCalled();
    expect(callbacks.onApprove).not.toHaveBeenCalled();
    expect(callbacks.onPermissionChange).not.toHaveBeenCalled();
    expect(callbacks.onRevoke).not.toHaveBeenCalled();
  });

  it("disables copy when the setup callback is absent", () => {
    renderDsh(props({ onCopySetup: undefined }));
    const button = screen.getByRole("button", { name: "Copy DSH configuration" });
    expect(button).toBeDisabled();
    fireEvent.click(button);
    expect(writeText).not.toHaveBeenCalled();
  });

  it.each<AgentConnectionStatus>(["disabled", "invalid", "unavailable"])("does not copy while the gateway is %s", (status) => {
    const callbacks = props({ status });
    renderDsh(callbacks);
    const button = screen.getByRole("button", { name: "Copy DSH configuration" });
    expect(button).toBeDisabled();
    fireEvent.click(button);
    expect(callbacks.onCopySetup).not.toHaveBeenCalled();
    expect(writeText).not.toHaveBeenCalled();
  });

  it.each<AgentConnectionStatus>(["booting", "approval", "approved", "occupied"])("does not distract from the %s connection state", (status) => {
    render(<AgentConnectionPage {...props({ status })} />);
    expect(screen.queryByRole("region", { name: "Connect your Agent" })).not.toBeInTheDocument();
    expect(screen.queryByText("DeepSeek Harness (dsh)")).not.toBeInTheDocument();
  });

  it.each([
    ["invalid JSON", "{ broken"],
    ["empty setup", ""],
    ["wrong schema", JSON.stringify({ mcpServers: {} })],
    ["bearer authority", JSON.stringify({ mcpServers: { semaframe: { headers: { Authorization: "Bearer private-rest-credential" } } } })],
    ["invalid callback result", null as unknown as AgentConnectionSetup],
  ])("safely rejects %s without copying or displaying credentials", async (_label, payload) => {
    renderDsh(props({ onCopySetup: vi.fn(async () => payload) }));
    fireEvent.click(screen.getByRole("button", { name: "Copy DSH configuration" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("The DSH configuration could not be copied");
    expect(screen.getByRole("alert")).not.toHaveTextContent("private-rest-credential");
    expect(screen.getByRole("button", { name: "Copy DSH configuration" })).toBeEnabled();
    expect(writeText).not.toHaveBeenCalled();
  });

  it("keeps the busy copy action disabled until the callback and clipboard finish", async () => {
    let resolveSetup!: (value: AgentConnectionSetup) => void;
    let resolveClipboard!: () => void;
    const onCopySetup = vi.fn(() => new Promise<AgentConnectionSetup>((resolve) => { resolveSetup = resolve; }));
    writeText.mockImplementation(() => new Promise<void>((resolve) => { resolveClipboard = resolve; }));
    const callbacks = props({ onCopySetup });
    renderDsh(callbacks);
    const button = screen.getByRole("button", { name: "Copy DSH configuration" });

    fireEvent.click(button);
    expect(button).toBeDisabled();
    fireEvent.click(button);
    expect(onCopySetup).toHaveBeenCalledOnce();
    expect(writeText).not.toHaveBeenCalled();
    await act(async () => resolveSetup({ mcpConfig: MCP_CONFIG }));
    expect(button).toBeDisabled();
    await act(async () => resolveClipboard());
    expect(screen.getByRole("button", { name: "DSH configuration copied" })).toBeEnabled();
    expect(writeText).toHaveBeenCalledExactlyOnceWith(EXPECTED_PATCH);
  });

  it("does not call setup while an external action is busy", () => {
    const callbacks = props({ busy: true });
    renderDsh(callbacks);
    const button = screen.getByRole("button", { name: "Copy DSH configuration" });
    expect(button).toBeDisabled();
    fireEvent.click(button);
    expect(callbacks.onCopySetup).not.toHaveBeenCalled();
  });

  it("recovers after a rejected callback without leaking its error details", async () => {
    const onCopySetup = vi.fn()
      .mockRejectedValueOnce(new Error("Bearer private-rest-credential"))
      .mockResolvedValueOnce({ mcpConfig: MCP_CONFIG });
    renderDsh(props({ onCopySetup }));
    const button = screen.getByRole("button", { name: "Copy DSH configuration" });

    fireEvent.click(button);
    expect(await screen.findByRole("alert")).not.toHaveTextContent("private-rest-credential");
    expect(writeText).not.toHaveBeenCalled();
    fireEvent.click(button);
    await waitFor(() => expect(writeText).toHaveBeenCalledExactlyOnceWith(EXPECTED_PATCH));
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it.each(["unavailable", "denied"])("reports a %s clipboard without claiming success", async (kind) => {
    if (kind === "unavailable") Object.defineProperty(navigator, "clipboard", { configurable: true, value: undefined });
    else writeText.mockRejectedValueOnce(new Error("clipboard denied"));
    renderDsh(props());
    fireEvent.click(screen.getByRole("button", { name: "Copy DSH configuration" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("browser clipboard access");
    expect(screen.queryByRole("button", { name: "DSH configuration copied" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Copy DSH configuration" })).toBeEnabled();
  });
});
